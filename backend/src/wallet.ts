/**
 * wallet.ts: la capa de Google Wallet. Tomada de lo que funciono en H2, que midio
 * 2.98 ms de CPU en produccion.
 *
 * TRES REQUISITOS QUE NO SE NEGOCIAN, escritos el 13 de octubre de 2026:
 *
 * 1. El balance y la imagen del hero van en la MISMA peticion, nunca en dos. Dos
 *    peticiones gastan dos notificaciones del cupo de 3 por pase en 24 horas, y abren
 *    una ventana en la que la socia ve el contador y el dibujo contradiciendose.
 * 2. El par texto mas archivo sale de `progresoDelPase` en `mecanica.ts`, nunca se
 *    arma aqui. Este archivo no sabe contar sellos.
 * 3. El codigo de barras lleva el UUID de la socia, y el texto legible es su nombre,
 *    nunca el identificador.
 *
 * Y dos cosas aprendidas a golpes:
 * - PATCH, nunca PUT. PUT reemplaza el recurso completo y borra los campos que no
 *   vayan en la peticion.
 * - `notifyPreference` es transitorio: va en CADA peticion que deba notificar, o no
 *   notifica.
 */
import { importPKCS8, SignJWT } from 'jose';
import { progresoDelPase, type ConfiguracionPlan, type Estado } from './mecanica.ts';

const AMBITO = 'https://www.googleapis.com/auth/wallet_object.issuer';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const GUARDAR = 'https://pay.google.com/gp/v/save/';

/** Lo que `wallet.ts` necesita del entorno. Nada de esto se escribe en el codigo. */
export interface EntornoWallet {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  /** `3388000000023195590`. Sale de credenciales\datos.md. */
  WALLET_ISSUER_ID: string;
  /** `3388000000023195590.fitjump_lealtad_v1`, la clase canonica. No se reconstruye. */
  WALLET_CLASE_ID: string;
  /** Donde el Worker sirve `imagenes\`, sin diagonal final. */
  WALLET_BASE_IMAGENES: string;
}

export interface SociaParaWallet {
  /** UUID. Es el id del objeto y el valor del codigo de barras. */
  id: string;
  nombre: string;
  objetoWalletId?: string | null;
}

export interface ResultadoWallet {
  ok: boolean;
  estadoHttp: number;
  /** El cuerpo solo se lee cuando algo falla: parsearlo siempre gastaria CPU. */
  detalle?: string;
}

// Cache en variables de modulo. Vive mientras el aislado siga en pie. Nada de KV.
let llaveImportada: CryptoKey | null = null;
let tokenEnCache: string | null = null;
let tokenExpiraEn = 0;

/**
 * En `.dev.vars` y en los secretos de wrangler la llave viaja en una linea con los
 * `\n` escapados. Si ya trae saltos reales, esto no hace nada.
 */
const aPem = (valor: string) => valor.replace(/\\n/g, '\n');

/** Solo para los tests: olvida el token y la llave cacheados. */
export function limpiarCache(): void {
  llaveImportada = null;
  tokenEnCache = null;
  tokenExpiraEn = 0;
}

async function firmar(
  entorno: EntornoWallet,
  cuerpo: Record<string, unknown>,
  audiencia: string,
  segundosDeVida: number,
): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  llaveImportada ??= await importPKCS8(aPem(entorno.GOOGLE_PRIVATE_KEY), 'RS256');
  return new SignJWT(cuerpo)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(entorno.GOOGLE_CLIENT_EMAIL)
    .setAudience(audiencia)
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + segundosDeVida)
    .sign(llaveImportada);
}

export async function obtenerToken(entorno: EntornoWallet): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  // Un minuto de colchon para no usar un token que expira en el camino.
  if (tokenEnCache && tokenExpiraEn > ahora + 60) return tokenEnCache;

  const assertion = await firmar(entorno, { scope: AMBITO }, TOKEN_URL, 3600);
  const respuesta = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!respuesta.ok) {
    throw new Error(`no se pudo obtener el token: ${respuesta.status} ${await respuesta.text()}`);
  }
  const datos = (await respuesta.json()) as { access_token: string; expires_in: number };
  tokenEnCache = datos.access_token;
  tokenExpiraEn = ahora + datos.expires_in;
  return tokenEnCache;
}

/** Espera de 10 segundos y 3 intentos por llamada. */
async function conReintentos(
  llamada: () => Promise<Response>,
  intentos = 3,
): Promise<ResultadoWallet> {
  let ultimoError = '';
  for (let intento = 1; intento <= intentos; intento += 1) {
    try {
      const respuesta = await llamada();
      if (respuesta.ok) return { ok: true, estadoHttp: respuesta.status };

      const detalle = await respuesta.text();
      // Un 4xx no se reintenta: la peticion esta mal y volver a mandarla la deja
      // igual de mal. El 429 si, porque es "ahora no" y no "nunca".
      const vale = respuesta.status === 429 || respuesta.status >= 500;
      if (!vale || intento === intentos) {
        return { ok: false, estadoHttp: respuesta.status, detalle };
      }
      ultimoError = `${respuesta.status} ${detalle}`;
    } catch (error) {
      // Timeout o red caida.
      ultimoError = error instanceof Error ? error.message : String(error);
      if (intento === intentos) return { ok: false, estadoHttp: 0, detalle: ultimoError };
    }
    // Espera creciente: 1 s y 2 s.
    await new Promise((listo) => setTimeout(listo, intento * 1000));
  }
  return { ok: false, estadoHttp: 0, detalle: ultimoError };
}

export const idDelObjeto = (entorno: EntornoWallet, socia: SociaParaWallet) =>
  `${entorno.WALLET_ISSUER_ID}.${socia.id}`;

/**
 * El descuento como porcentaje del precio, redondeado al entero mas cercano.
 *
 * NO SE ESCRIBE A MANO. Sale de dividir el monto entre el precio, que son dos columnas
 * de `planes`. Con los valores del 13 de octubre de 2026 da 25 y 50 en los dos planes,
 * verificado contra la base: semanal 40/160 y 80/160 dan exactos, y mensual 140/550 da
 * 25.45 que redondea a 25, y 275/550 da 50.
 *
 * Si la junta cambia un monto o un precio, el texto del pase cambia solo.
 */
export function porcentajeDelPremio(monto: number, precio: number): number | null {
  if (!Number.isFinite(precio) || precio <= 0) return null;
  return Math.round((monto / precio) * 100);
}

/**
 * Los modulos de texto del OBJETO, nunca de la clase: lo que cambia por socia va en el
 * objeto, y desde el 14 de octubre de 2026 el modulo de premios cambia por socia y por
 * pago.
 *
 * **El modulo de premios tiene tres estados:** en blanco (la explicacion del
 * programa), premio chico disponible y premio grande disponible. Viaja en el MISMO
 * PATCH que el contador y el hero, nunca en una peticion aparte, porque dos peticiones
 * gastan dos notificaciones del cupo de tres por pase en 24 horas.
 *
 * Los numeros de sellos salen del plan y los porcentajes se calculan. Ni un literal
 * aqui, y **ninguno de los tres textos menciona el plan**: la misma funcion sirve a los
 * dos y una palabra escrita a mano es el defecto que este proyecto ya pago dos veces.
 *
 * ⚠️ Lo que el sistema descuenta es el MONTO en pesos, no el porcentaje. Ver el costo
 * oculto anotado en H5 del plan.
 */
export function modulosDeTexto(
  plan: ConfiguracionPlan,
  estado: Estado,
): Array<Record<string, string>> {
  const modulos: Array<Record<string, string>> = [];

  const chico = porcentajeDelPremio(plan.montoPremioChico, plan.precio);
  const grande = porcentajeDelPremio(plan.montoPremioGrande, plan.precio);
  if (chico !== null && grande !== null) {
    let cuerpo: string;
    if (estado.premioPendiente === 'chico') {
      // Avisa del reinicio: si no se dice, la socia cree que perdio sus sellos y
      // reclama en el mostrador.
      cuerpo =
        `Tienes ${chico}% de descuento disponible. Pídelo en recepción al hacer tu ` +
        'siguiente pago. Al canjearlo tus sellos vuelven a cero y empiezas una ' +
        'plantilla nueva.';
    } else if (estado.premioPendiente === 'grande') {
      // "No hace falta pedirlo" es literal: con el canje automatico la socia no tiene
      // que pedirlo, y si el texto dijera "pidelo" lo pediria dos veces.
      cuerpo =
        `Tienes ${grande}% de descuento disponible. Se aplica solo en tu siguiente ` +
        'pago y no hace falta pedirlo. Tu plantilla ya empezó de nuevo.';
    } else {
      // El texto descriptivo de siempre: como funciona el programa. Este si usa el
      // nombre del plan, interpolado de la configuracion, no escrito a mano.
      cuerpo =
        `Junta ${plan.sellosPremioChico} sellos y recibe ${chico}% de descuento en tu ` +
        `siguiente pago ${plan.nombre.toLowerCase()}. Si llenas los ` +
        `${plan.sellosTotales} sin canjear, recibes ${grande}%.`;
    }
    modulos.push({ id: 'premios', header: 'Premios', body: cuerpo });
  }

  // Texto de la mecanica del 14 de octubre de 2026. Se copia tal cual y no se
  // reescribe aqui. El test `la clausula de terminos y condiciones` lo fija caracter
  // por caracter, para que no vuelva a derivar en silencio como la version anterior.
  //
  // ✅ APROBADO POR LA DUEÑA EL 14 DE OCTUBRE DE 2026. Entro ese mismo dia, antes de la
  // aprobacion, porque la clausula vieja habia quedado falsa: prometia que el descuento se
  // aplicaba sobre el siguiente pago del mismo plan, y el canje forzado al cambiar de plan
  // lo cobra en ese momento. Ya no es un texto provisional.
  //
  // ⚠️ COSTO OCULTO: este parrafo es texto fijo que describe TRES columnas de `planes`
  // (`reinicia_al_canjear_chico`, `conserva_sellos_al_cambiar_plan` y
  // `canje_automatico_del_premio_grande`). Si la junta cambia cualquiera de las tres con
  // un `UPDATE`, el texto queda falso y hay que reemitir los pases. Un `UPDATE` de una
  // linea deja de ser gratis en cuanto hay pases vivos.
  modulos.push({
    id: 'terminos',
    header: 'Términos y condiciones',
    body:
      'Los descuentos se obtienen y se aplican dentro del plan en el que se juntaron ' +
      'los sellos. Al llenar la plantilla, el descuento mayor queda disponible y los ' +
      'sellos vuelven a cero para empezar una plantilla nueva. Ese descuento se aplica ' +
      'automáticamente en el siguiente pago, sin necesidad de pedirlo. El descuento de ' +
      'la mitad de la plantilla se pide en recepción y, al canjearlo, los sellos ' +
      'vuelven a cero. Si la socia cambia de plan, los sellos vuelven a cero y ' +
      'cualquier descuento que ya tenga disponible se aplica en ese momento, por el ' +
      'valor que tenía en el plan donde lo obtuvo.',
  });

  return modulos;
}

/**
 * El cuerpo de la actualizacion. **Balance y hero juntos, siempre.** Es una funcion
 * aparte para poder probarla sin red, que es justo lo que no se pudo hacer en H2.
 */
export function cuerpoDeActualizacion(
  entorno: EntornoWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
  notificar: boolean,
): Record<string, unknown> {
  const progreso = progresoDelPase(plan, estado);
  const cuerpo: Record<string, unknown> = {
    loyaltyPoints: {
      label: 'Sellos',
      balance: { string: progreso.texto },
    },
    heroImage: {
      sourceUri: { uri: `${entorno.WALLET_BASE_IMAGENES}/${progreso.archivoHero}` },
      contentDescription: {
        defaultValue: { language: 'es-419', value: progreso.texto + ' sellos' },
      },
    },
    // Van en cada peticion, no solo al crear, para que un cambio de plan o un cambio
    // de monto en la base se refleje en el pase sin tener que acordarse de nada.
    textModulesData: modulosDeTexto(plan, estado),
  };
  // Transitorio: si no va en esta peticion, esta peticion no notifica.
  if (notificar) cuerpo.notifyPreference = 'NOTIFY_ON_UPDATE';
  return cuerpo;
}

/** El objeto completo que se manda al crear un pase nuevo. */
export function cuerpoDeCreacion(
  entorno: EntornoWallet,
  socia: SociaParaWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
): Record<string, unknown> {
  return {
    id: idDelObjeto(entorno, socia),
    classId: entorno.WALLET_CLASE_ID,
    state: 'ACTIVE',
    accountName: socia.nombre,
    accountId: plan.nombre,
    // El valor es el UUID, sin datos personales. El texto legible es el nombre de la
    // socia: los tres pases viejos llevaban el mismo identificador en los dos lugares,
    // y asi un escaner no puede distinguir a nadie.
    barcode: {
      type: 'QR_CODE',
      value: socia.id,
      alternateText: socia.nombre,
    },
    ...cuerpoDeActualizacion(entorno, plan, estado, false),
  };
}

export async function crearObjeto(
  entorno: EntornoWallet,
  socia: SociaParaWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
): Promise<ResultadoWallet> {
  const token = await obtenerToken(entorno);
  const resultado = await conReintentos(() =>
    fetch(`${API}/loyaltyObject`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpoDeCreacion(entorno, socia, plan, estado)),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  // Crear dos veces el mismo objeto no es un error: el pase ya existe y el estado
  // deseado es el mismo. Importa para el patron outbox, que reintenta.
  if (!resultado.ok && resultado.estadoHttp === 409) {
    return { ok: true, estadoHttp: 409, detalle: 'el objeto ya existia' };
  }
  return resultado;
}

async function parchear(
  entorno: EntornoWallet,
  socia: SociaParaWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
  notificar: boolean,
): Promise<ResultadoWallet> {
  const token = await obtenerToken(entorno);
  const id = socia.objetoWalletId ?? idDelObjeto(entorno, socia);
  return conReintentos(() =>
    // PATCH, nunca PUT.
    fetch(`${API}/loyaltyObject/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpoDeActualizacion(entorno, plan, estado, notificar)),
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

/** Actualiza el pase y notifica. Para pagos, canjes y cambios de plan. */
export const actualizarObjeto = (
  entorno: EntornoWallet,
  socia: SociaParaWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
) => parchear(entorno, socia, plan, estado, true);

/**
 * Actualiza el pase SIN notificar. Para deshacer: una correccion no debe gastar una
 * de las 3 notificaciones por pase en 24 horas, ni avisarle a la socia de un error
 * del mostrador.
 */
export const actualizarSinNotificar = (
  entorno: EntornoWallet,
  socia: SociaParaWallet,
  plan: ConfiguracionPlan,
  estado: Estado,
) => parchear(entorno, socia, plan, estado, false);

/**
 * El link que la socia abre para guardar el pase. El JWT referencia al objeto, que
 * ya debe existir.
 */
export async function linkDeGuardado(
  entorno: EntornoWallet,
  socia: SociaParaWallet,
): Promise<string> {
  const jwt = await firmar(
    entorno,
    {
      typ: 'savetowallet',
      origins: [],
      payload: {
        loyaltyObjects: [
          { id: idDelObjeto(entorno, socia), classId: entorno.WALLET_CLASE_ID },
        ],
      },
    },
    'google',
    3600,
  );
  return GUARDAR + jwt;
}
