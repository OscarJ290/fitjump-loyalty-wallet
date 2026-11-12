/**
 * index.ts: la API. Hono sobre Cloudflare Workers.
 *
 * TRES REGLAS DE ORDEN QUE NO SE NEGOCIAN:
 *
 * 1. **Primero la base, despues Google.** La API responde cuando la fila ya esta
 *    escrita. Si Google falla, el movimiento existe igual y queda pendiente en
 *    `sync_wallet`, que el cron reintenta cada 30 minutos.
 * 2. **El panel nunca espera a Google.** La verdad esta en la base, no en el pase. La
 *    notificacion tarda de 1 a 2 minutos (medido el 13 de octubre de 2026) y recepcion
 *    no puede quedarse mirando la pantalla ese rato.
 * 3. **Toda consulta lleva el `negocio_id` de la sesion.** Nunca el que venga en la
 *    peticion.
 *
 * La mecanica no vive aqui: vive en `mecanica.ts`. Este archivo lee el estado, se lo
 * pasa, y guarda lo que le devuelve.
 */
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  aplicar,
  progresoDelPase,
  type ConfiguracionPlan,
  type Estado,
  type MovimientoConPlan,
} from './mecanica.ts';
import {
  ClaveRepetida,
  crearBaseDeDatos,
  type BaseDeDatos,
  type FilaMovimiento,
  type FilaPlan,
  type FilaSocia,
} from './db.ts';
import {
  actualizarObjeto,
  actualizarSinNotificar,
  crearObjeto,
  idDelObjeto,
  linkDeGuardado,
  type EntornoWallet,
} from './wallet.ts';

export interface Entorno extends EntornoWallet {
  DATABASE_URL: string;
  /** El negocio al que pertenece la pagina publica de alta. */
  NEGOCIO_ID: string;
  /**
   * Turnstile, el captcha de Cloudflare, que defiende `/alta` de que cualquiera con
   * la URL cree socias. **El secreto es secreto; la llave de sitio es publica y va
   * incrustada en el HTML, que es como Turnstile funciona.**
   */
  TURNSTILE_SECRET?: string;
  /**
   * La unica forma de correr `/alta` SIN captcha, y tiene que escribirse a mano.
   *
   * ⚠️ **HASTA EL 19 DE OCTUBRE DE 2026 NO HACIA FALTA, Y ESE ERA EL DEFECTO:** si
   * `TURNSTILE_SECRET` faltaba, la verificacion se saltaba sola y solo lo decia un
   * `console.warn`. O sea que subir el secreto con el nombre mal escrito dejaba la
   * pagina publica SIN CAPTCHA en produccion, escribiendo en la base, sin que nada se
   * notara. Es el mismo camino silencioso que `PLAN_POR_OMISION`, que se quito el 14
   * de octubre por la misma razon: **una decision que se toma sola y en silencio.**
   *
   * Ahora la ausencia del secreto CIERRA la ruta, y abrirla exige poner esto en
   * `backend\.dev.vars` con el valor `si`. **Nunca va en `wrangler.jsonc`:** ese
   * archivo si viaja con el deploy, y entonces el permiso de saltarse el captcha
   * viajaria con el.
   */
  CAPTCHA_OPCIONAL?: string;
  /**
   * El limitador de peticiones de Cloudflare, declarado en `wrangler.jsonc`. Es la
   * segunda capa: Turnstile frena al bot, esto frena al que ya paso una vez y
   * reintenta en bucle. No existe en los tests ni siempre en `wrangler dev`, asi que
   * es opcional y el codigo funciona sin el.
   */
  LIMITE_ALTA?: { limit(opciones: { key: string }): Promise<{ success: boolean }> };
}

/** Lo que la API necesita de Wallet. Los tests pasan una version falsa. */
export interface ClienteWallet {
  crear(socia: FilaSocia, plan: ConfiguracionPlan, estado: Estado): Promise<{ ok: boolean; detalle?: string }>;
  actualizar(socia: FilaSocia, plan: ConfiguracionPlan, estado: Estado, notificar: boolean): Promise<{ ok: boolean; detalle?: string }>;
  link(socia: FilaSocia): Promise<string>;
  idObjeto(socia: FilaSocia): string;
}

export interface Dependencias {
  db: BaseDeDatos;
  wallet: ClienteWallet;
  negocioPublico: string;
  /**
   * Verifica el captcha. Devuelve true si la peticion viene de una persona, o si no
   * hay secreto configurado y por lo tanto no hay nada que verificar.
   */
  verificarCaptcha?: (respuesta: string, ip: string | null) => Promise<boolean>;
  /**
   * Si el captcha quedo bien configurado. **En false, `/alta` no abre.**
   *
   * Es una bandera aparte de `verificarCaptcha` porque significa otra cosa: "la
   * verificacion dijo que no" es una peticion rechazada, y "no hay con que verificar"
   * es una ruta que no deberia estar atendiendo. La primera se le explica a la socia;
   * la segunda es un error de despliegue y se grita en el log.
   *
   * El default es `true` para que los tests y las dependencias armadas a mano no
   * tengan que saber de esto: quien decide de verdad es `dependenciasDeEntorno`.
   */
  captchaConfigurado?: boolean;
  /** Devuelve false cuando esa IP ya gasto su cupo. Sin limitador, siempre true. */
  dentroDelLimite?: (clave: string) => Promise<boolean>;
  /** Para los tests: congelar el reloj. */
  ahora?: () => Date;
  /** `ctx.waitUntil` en produccion; en los tests, correr y esperar. */
  enSegundoPlano?: (tarea: Promise<unknown>) => void;
}

/** Deshacer solo esta disponible diez minutos. */
export const MINUTOS_PARA_DESHACER = 10;

const SIN_SESION = { error: 'sin sesion' } as const;

/**
 * El cuerpo de la peticion, o un objeto vacio si viene roto o no viene. Asi una
 * peticion sin JSON cae en la validacion de campos, que da un 400 claro, en vez de
 * reventar con un 500.
 */
async function cuerpoJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

/** +52 y diez digitos. Acepta lo que la gente escribe y lo normaliza. */
export function normalizarWhatsapp(entrada: string): string | null {
  const digitos = (entrada ?? '').replace(/\D/g, '');
  // 10 digitos: numero nacional. 12: ya viene con 52. 13: viene con 521, de WhatsApp.
  let diez: string | null = null;
  if (digitos.length === 10) diez = digitos;
  else if (digitos.length === 12 && digitos.startsWith('52')) diez = digitos.slice(2);
  else if (digitos.length === 13 && digitos.startsWith('521')) diez = digitos.slice(3);
  return diez ? '+52' + diez : null;
}

export async function sha256Hex(texto: string): Promise<string> {
  const datos = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', datos);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * El token de dispositivo del panel: 32 bytes aleatorios en base64url.
 *
 * **Nada de hash lento sobre esto.** Ni argon2, ni bcrypt, ni PBKDF2: el limite es 10
 * ms de CPU por peticion. Un hash lento existe para defender una contraseña que una
 * persona eligio y que por lo tanto es adivinable. Esto no lo eligio nadie: son 256
 * bits de `crypto.getRandomValues`, asi que el SHA-256 que se guarda en la base basta
 * y cuesta microsegundos.
 */
export function tokenDeDispositivo(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * El estado de la socia sale completo de su fila. **Ningun campo se fabrica aqui:**
 * hasta el 14 de octubre de 2026 `premioGrandeUsadoEnCiclo` se ponia en false a mano,
 * que era un hueco latente para el dia que `reinicia_al_canjear_grande` se apagara.
 */
const estadoDeSocia = (socia: FilaSocia): Estado => ({
  sellos: socia.sellos,
  premioPendiente: socia.premioPendiente,
  premioChicoUsadoEnCiclo: socia.premioChicoUsadoEnCiclo,
  premioGrandeUsadoEnCiclo: socia.premioGrandeUsadoEnCiclo,
  recibioSelloDeBienvenida: socia.recibioSelloDeBienvenida,
});

/**
 * Arma el libro para la maquina de estados, **con el plan de cada fila**. Si una socia
 * cambio de plan, sus movimientos viejos se evaluan con los umbrales de entonces, no
 * con los del plan actual.
 */
function alLibro(filas: FilaMovimiento[], planes: FilaPlan[]): MovimientoConPlan[] {
  const porId = new Map(planes.map((p) => [p.id, p]));
  return filas.map((f) => {
    const plan = porId.get(f.planId);
    if (!plan) {
      // La llave foranea compuesta de la base lo impide, asi que esto solo pasaria con
      // una fila corrupta.
      throw new Error(`el movimiento ${f.id} apunta a un plan que no existe`);
    }
    return {
      movimiento: { tipo: f.tipo, sellosDelta: f.sellosDelta, monto: f.monto },
      plan,
    };
  });
}

/**
 * La configuracion que la mecanica devuelve es la misma instancia de `FilaPlan` que se
 * le paso, asi que trae su id. Se valida en vez de confiar.
 */
function idDelPlan(plan: ConfiguracionPlan): string {
  const id = (plan as FilaPlan).id;
  if (!id) throw new Error('la mecanica devolvio un plan sin id');
  return id;
}

/**
 * Cuantas socias trae la lista de inicio del panel como mucho.
 *
 * ⚠️ 100 NO ES UN NUMERO BONITO, ES UN TECHO DE CPU. La lista entera se serializa en
 * cada peticion dentro del presupuesto de 10 ms por peticion del plan gratuito de
 * Workers. Con 100 filas de seis campos sobra; con la tabla entera de un gimnasio
 * crecido, no. Cuando Fit Jump pase de 100 socias activas, lo que sigue NO es subir este
 * numero: es paginar o buscar, que es justo para lo que ya existe el campo de busqueda.
 */
const LIMITE_DE_LA_LISTA = 100;

function fichaDeSocia(socia: FilaSocia, plan: FilaPlan | null, estado: Estado) {
  return {
    id: socia.id,
    nombre: socia.nombre,
    whatsapp: socia.whatsapp,
    plan: plan ? { id: plan.id, nombre: plan.nombre, precio: plan.precio } : null,
    sellos: estado.sellos,
    sellosTotales: plan?.sellosTotales ?? null,
    premioPendiente: estado.premioPendiente,
    montoDelPremio:
      plan && estado.premioPendiente === 'chico'
        ? plan.montoPremioChico
        : plan && estado.premioPendiente === 'grande'
          ? plan.montoPremioGrande
          : 0,
    // El panel muestra esto; el pase de la socia tarda de 1 a 2 minutos en reflejarlo.
    progreso: plan ? progresoDelPase(plan, estado) : null,
    esPrueba: socia.esPrueba,
  };
}

/** Lo que la sesion deja en el contexto de Hono. */
type VariablesPanel = { usuarioId: string; usuarioNombre: string; negocioId: string };
type ContextoPanel = Context<{ Variables: VariablesPanel }>;

export function crearApp(deps: Dependencias) {
  const { db, wallet } = deps;
  const ahora = deps.ahora ?? (() => new Date());
  const verificarCaptcha = deps.verificarCaptcha ?? (async () => true);
  const dentroDelLimite = deps.dentroDelLimite ?? (async () => true);
  const enSegundoPlano = deps.enSegundoPlano ?? ((tarea: Promise<unknown>) => void tarea.catch(() => {}));

  /** Sincroniza el pase despues de responder. Si falla, queda pendiente. */
  const sincronizar = async (
    socia: FilaSocia,
    plan: ConfiguracionPlan,
    estado: Estado,
    notificar: boolean,
  ) => {
    try {
      const resultado = await wallet.actualizar(socia, plan, estado, notificar);
      if (resultado.ok) await db.marcarSyncOk(socia.id);
      else await db.marcarSyncError(socia.id, resultado.detalle ?? 'sin detalle');
    } catch (error) {
      await db.marcarSyncError(socia.id, error instanceof Error ? error.message : String(error));
    }
  };

  /** Relee la socia para contestar un repetido con el estado que de verdad quedo. */
  async function fichaFresca(
    negocioId: string,
    sociaId: string,
    deRespaldo: FilaSocia,
    planDeRespaldo: FilaPlan,
  ) {
    const actual = await db.sociaPorId(negocioId, sociaId);
    if (!actual) return fichaDeSocia(deRespaldo, planDeRespaldo, estadoDeSocia(deRespaldo));
    const plan = actual.planId ? await db.planPorId(negocioId, actual.planId) : null;
    return fichaDeSocia(actual, plan, estadoDeSocia(actual));
  }

  const app = new Hono();

  // -----------------------------------------------------------------------
  // Publico: alta de socias
  // -----------------------------------------------------------------------
  app.post('/alta', async (c) => {
    // ⚠️ VA ANTES QUE TODO, incluso que el cupo por IP: si no hay con que verificar,
    // esta ruta no deberia estar abierta y no tiene sentido gastar cupo en decirlo.
    // Cerrada es la postura segura: `/alta` es publica y escribe en la base.
    if (deps.captchaConfigurado === false) {
      console.error(
        'alta: CERRADA. No hay TURNSTILE_SECRET y CAPTCHA_OPCIONAL no esta puesto. ' +
          'Sube el secreto con `wrangler secret put TURNSTILE_SECRET`.',
      );
      return c.json(
        { error: 'El registro no esta disponible en este momento. Avisale a recepcion.' },
        503,
      );
    }

    const negocioId = deps.negocioPublico;
    // `cf-connecting-ip` lo pone Cloudflare y el cliente no lo puede falsificar.
    const ip = c.req.header('cf-connecting-ip') ?? null;

    // Primera capa: el cupo por IP. Va antes del captcha para que un bucle no
    // gaste una llamada a Turnstile por intento.
    if (!(await dentroDelLimite('alta:' + (ip ?? 'sin-ip')))) {
      return c.json({ error: 'demasiados intentos, espera un minuto' }, 429);
    }

    const cuerpo = await cuerpoJson<{
      nombre: string;
      whatsapp: string;
      plan: string;
      captcha: string;
    }>(c);

    // Segunda capa: el captcha. Se verifica ANTES de tocar la base, porque el
    // punto es que una peticion de bot no llegue nunca a escribir.
    if (!(await verificarCaptcha(cuerpo.captcha ?? '', ip))) {
      return c.json({ error: 'no pudimos confirmar que eres una persona' }, 403);
    }

    const nombre = (cuerpo.nombre ?? '').trim();
    const whatsapp = normalizarWhatsapp(cuerpo.whatsapp ?? '');

    if (nombre.length < 2) return c.json({ error: 'falta el nombre' }, 400);
    if (!whatsapp) return c.json({ error: 'el whatsapp debe tener diez digitos' }, 400);

    // **EL PLAN LO DECIDE LA PAGINA, NO ESTE ENDPOINT.** Cada plan tiene su propia
    // pagina con su propio QR impreso en recepcion, asi que la socia nace dentro de
    // su plan. Hasta el 14 de octubre de 2026 esto usaba `PLAN_POR_OMISION` y toda
    // socia nacia Mensual; esa variable se quito para que no quede un camino
    // silencioso que contradiga la decision.
    const nombrePlan = (cuerpo.plan ?? '').trim();
    if (!nombrePlan) return c.json({ error: 'falta el plan' }, 400);
    const plan = await db.planPorNombre(negocioId, nombrePlan);
    if (!plan) return c.json({ error: 'ese plan no existe' }, 400);

    // ------------------------------------------------------------------
    // YA REGISTRADA: se le devuelve SU MISMO PASE, ni otra socia ni un error.
    // ------------------------------------------------------------------
    // Que una socia vuelva a escanear el QR es lo normal: cambio de telefono,
    // borro el pase, o simplemente lo escaneo dos veces. Antes esto daba 409 y la
    // dejaba sin salida.
    //
    // **No se le toca nada:** ni el nombre ni el plan. Si escribe su nombre
    // distinto, manda el que ya esta en la base, porque recepcion es la dueña de
    // esa ficha y un formulario publico no la puede reescribir.
    const existente = await db.sociaPorWhatsapp(negocioId, whatsapp);
    if (existente) {
      if (existente.objetoWalletId) {
        return c.json({
          link: await wallet.link(existente),
          nombre: existente.nombre,
          yaRegistrada: true,
        });
      }
      // Existe en la base pero su pase nunca se creo: Google fallo en su alta y el
      // cron todavia no lo alcanza. Se intenta aqui mismo, que es justo lo que la
      // socia vino a pedir.
      const planDeElla = existente.planId ? await db.planPorId(negocioId, existente.planId) : plan;
      const recuperado = await wallet.crear(existente, planDeElla ?? plan, estadoDeSocia(existente));
      if (!recuperado.ok) {
        await db.marcarPendienteDeSync(negocioId, existente.id);
        return c.json(
          { error: 'tu registro esta guardado, tu pase se esta creando', pendiente: true },
          502,
        );
      }
      await db.guardarObjetoWallet(negocioId, existente.id, wallet.idObjeto(existente));
      return c.json({
        link: await wallet.link(existente),
        nombre: existente.nombre,
        yaRegistrada: true,
      });
    }

    const socia = await db.crearSocia({ negocioId, nombre, whatsapp, planId: plan.id });
    const estado = estadoDeSocia(socia);

    // Primero la base, despues Google. Si esto falla, la socia existe y el pase se
    // crea en el reintento. **El mensaje no dice "intenta de nuevo" a secas:** la
    // socia tiene que saber que su registro ya quedo, o va a pensar que se perdio y
    // va a llenar el formulario otra vez. Volver a mandarlo ahora cae en la rama de
    // arriba y le entrega el pase en cuanto el cron lo haya creado.
    const creado = await wallet.crear(socia, plan, estado);
    if (!creado.ok) {
      await db.marcarPendienteDeSync(negocioId, socia.id);
      return c.json(
        { error: 'tu registro esta guardado, tu pase se esta creando', pendiente: true },
        502,
      );
    }
    await db.guardarObjetoWallet(negocioId, socia.id, wallet.idObjeto(socia));

    return c.json({ link: await wallet.link(socia), nombre: socia.nombre });
  });

  // -----------------------------------------------------------------------
  // Activacion del panel: la unica puerta de entrada
  // -----------------------------------------------------------------------
  /**
   * Consume un codigo de activacion de un solo uso y devuelve la cookie de sesion.
   *
   * **Lo que viaja por WhatsApp es el codigo, nunca el token.** El token de
   * dispositivo lo genera este endpoint, se guarda en la base solo como SHA-256 y sale
   * de aqui una sola vez, dentro de una cookie HttpOnly que ningun script puede leer.
   * Nadie lo ve nunca, asi que no puede quedar escrito en el historial de un telefono.
   *
   * ⚠️ **Hasta el 16 de octubre de 2026 aqui vivia `POST /sesion`, que cambiaba un
   * token conocido por una cookie. Se quito a proposito:** sin nadie que conozca un
   * token, esa ruta no tenia quien la llamara y lo unico que aportaba era una puerta
   * donde probar un token filtrado. La entrada es esta y no hay otra.
   */
  app.post('/activar', async (c) => {
    const cuerpo = await cuerpoJson<{ codigo: string }>(c);
    const codigo = (cuerpo.codigo ?? '').trim();
    if (!codigo) return c.json({ error: 'falta el codigo' }, 400);

    const altaHash = await sha256Hex(codigo);
    const pendiente = await db.usuarioPorAltaHash(altaHash);
    // Mismo 401 para un codigo inventado y para uno ya gastado: desde fuera no se
    // distingue, y para la persona el siguiente paso es el mismo, pedir otro enlace.
    if (!pendiente) {
      return c.json({ error: 'ese enlace ya se uso o no existe. Pide uno nuevo' }, 401);
    }
    if (new Date(pendiente.altaExpira).getTime() <= ahora().getTime()) {
      return c.json({ error: 'ese enlace ya caduco. Pide uno nuevo' }, 401);
    }

    const token = tokenDeDispositivo();
    // De un solo uso de verdad: el `update ... where alta_hash = ...` de la base es
    // quien decide, asi que dos peticiones con el mismo codigo no pueden activar las
    // dos, por mas juntas que lleguen.
    if (!(await db.consumirAlta(altaHash, await sha256Hex(token)))) {
      return c.json({ error: 'ese enlace ya se uso. Pide uno nuevo' }, 401);
    }

    // `secure` en true tambien sirve en `wrangler dev`: los navegadores tratan
    // localhost como contexto seguro y aceptan la cookie sobre http ahi.
    setCookie(c, 'sesion', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    return c.json({ usuario: { id: pendiente.id, nombre: pendiente.nombre } });
  });

  // -----------------------------------------------------------------------
  // De aqui para abajo, todo exige sesion
  // -----------------------------------------------------------------------
  const panel = new Hono<{ Variables: VariablesPanel }>();

  panel.use('*', async (c, next) => {
    const token = getCookie(c, 'sesion');
    if (!token) return c.json(SIN_SESION, 401);
    const usuario = await db.usuarioPorTokenHash(await sha256Hex(token));
    if (!usuario) return c.json(SIN_SESION, 401);
    c.set('usuarioId', usuario.id);
    c.set('usuarioNombre', usuario.nombre);
    // El negocio sale de la sesion. Nunca de la peticion.
    c.set('negocioId', usuario.negocioId);
    await next();
  });

  /**
   * Quien soy. El panel la llama al abrir, asi que es el lugar donde se anota el
   * acceso: hacerlo en el middleware agregaria una escritura a cada pago y a cada
   * canje para registrar lo mismo.
   */
  panel.get('/yo', async (c) => {
    await db.tocarAcceso(c.get('usuarioId'));
    return c.json({ usuario: { id: c.get('usuarioId'), nombre: c.get('usuarioNombre') } });
  });

  /**
   * Salir de este dispositivo. **Revoca de verdad, no solo borra la cookie.**
   *
   * El token vive en un solo lugar, esa cookie, asi que borrarla ya dejaria el acceso
   * inalcanzable. Si ademas no se revocara la fila, la base diria que esa persona
   * tiene un dispositivo activo que en realidad no existe, y nadie sabria que hay que
   * mandarle un enlace nuevo. **Volver a entrar exige un enlace de activacion nuevo**,
   * y el panel lo advierte antes de ejecutarlo.
   */
  panel.post('/salir', async (c) => {
    await db.revocarAcceso(c.get('usuarioId'));
    deleteCookie(c, 'sesion', { path: '/' });
    return c.json({ ok: true });
  });

  panel.get('/planes', async (c) => c.json({ planes: await db.planes(c.get('negocioId')) }));

  /**
   * LA LISTA DE SOCIAS ACTIVAS, para la pantalla de inicio del panel.
   *
   * ⚠️ ES UNA RUTA PROPIA Y NO UN CASO DE `GET /socias`, a proposito. `/socias` sin
   * texto devuelve un arreglo vacio sin tocar la base, y eso **no cambia**: es lo que
   * impide que un dedo en el campo de busqueda dispare una consulta por cada letra antes
   * de la segunda. Meter la lista ahi habria convertido "todavia no escribio nada" y
   * "quiere ver todo" en la misma peticion.
   *
   * ⚠️ `/socias-activas` NO CHOCA CON NADA, comprobado antes de elegir el nombre:
   *   1. `GET /socias/:id` es un patron de DOS segmentos; este es de uno solo y con otro
   *      literal, asi que ningun id puede caer aqui ni al reves.
   *   2. En `web\` no hay ningun archivo ni carpeta que se llame asi. Importa porque
   *      `run_worker_first` esta en `false`: un archivo estatico que exista se sirve
   *      directo y el Worker ni se entera, asi que una ruta con el nombre de una carpeta
   *      de `web\` seria una ruta muerta.
   *
   * ⚠️ NO PASA POR `fichaDeSocia` NI POR `estadoDeSocia`. Devuelve los valores
   * guardados tal como vienen de la base. Para 100 filas, reconstruir el estado de cada
   * una desde el libro serian 100 reconstrucciones por cada vez que recepcion abre la
   * pantalla, dentro de 10 ms de CPU. La ficha de UNA socia si pasa por la maquina.
   */
  panel.get('/socias-activas', async (c) => {
    const { filas, total } = await db.listaDeSocias(c.get('negocioId'), LIMITE_DE_LA_LISTA);
    return c.json({
      socias: filas,
      total,
      // Lo que el panel pinta al pie cuando la lista no cabe entera. Se manda calculado
      // y no se deja al navegador: es una resta, pero es la clase de resta que termina
      // escrita distinto en dos lugares.
      faltan: Math.max(total - filas.length, 0),
    });
  });

  panel.get('/socias', async (c) => {
    const texto = (c.req.query('q') ?? '').trim();
    if (texto.length < 2) return c.json({ socias: [] });
    const negocioId = c.get('negocioId');
    const socias = await db.buscarSocias(negocioId, texto, 20);
    const planes = await db.planes(negocioId);
    return c.json({
      socias: socias.map((s) =>
        fichaDeSocia(s, planes.find((p) => p.id === s.planId) ?? null, estadoDeSocia(s)),
      ),
    });
  });

  /**
   * Carga socia y plan, o deja listo el error. Devuelve una union discriminada para que
   * el compilador sepa que despues de `if (!cargado.ok) return cargado.respuesta` la
   * socia existe de verdad.
   */
  type Cargado =
    | { ok: true; negocioId: string; socia: FilaSocia; plan: FilaPlan }
    | { ok: false; respuesta: Response };

  async function cargar(c: ContextoPanel): Promise<Cargado> {
    const negocioId = c.get('negocioId');
    const socia = await db.sociaPorId(negocioId, c.req.param('id') ?? '');
    // Mismo 404 para "no existe" y para "es de otro negocio": no se filtra ni la
    // existencia de una socia ajena.
    if (!socia) return { ok: false, respuesta: c.json({ error: 'no encontrada' }, 404) };
    const plan = socia.planId ? await db.planPorId(negocioId, socia.planId) : null;
    if (!plan) {
      return { ok: false, respuesta: c.json({ error: 'la socia no tiene plan asignado' }, 409) };
    }
    return { ok: true, negocioId, socia, plan };
  }

  panel.get('/socias/:id', async (c) => {
    const cargado = await cargar(c);
    if (!cargado.ok) return cargado.respuesta;
    const { negocioId, socia, plan } = cargado;
    const libro = await db.libro(negocioId, socia.id);
    const limite = ahora().getTime() - MINUTOS_PARA_DESHACER * 60_000;
    return c.json({
      socia: fichaDeSocia(socia, plan, estadoDeSocia(socia)),
      // Como va el pase contra Google. **Es informativo y nunca bloquea nada:** la
      // verdad esta en la base, y el panel no espera a Wallet para dejar registrar el
      // movimiento siguiente. Sirve para que recepcion distinga "todavia no llega" de
      // "llevo cinco intentos fallidos".
      sincronizacion: await db.syncDeSocia(negocioId, socia.id),
      movimientos: libro
        .slice()
        .reverse()
        .map((m) => ({
          id: m.id,
          tipo: m.tipo,
          sellosDelta: m.sellosDelta,
          monto: m.monto,
          creadoEn: m.creadoEn,
          // El panel muestra el boton de deshacer solo si esto es true.
          sePuedeDeshacer:
            m.tipo !== 'reverso' && !m.reversado && new Date(m.creadoEn).getTime() >= limite,
        })),
    });
  });

  /**
   * El segundo toque del mismo boton, resuelto ANTES de cualquier validacion.
   *
   * ⚠️ **ESTE ORDEN ES UN DEFECTO QUE H8 DESTAPO, el 16 de octubre de 2026.** La
   * idempotencia vivia solo dentro de `escribir`, o sea despues de las validaciones de
   * cada ruta, y las validaciones mienten en cuanto la primera peticion ya corrio: el
   * premio ya se canjo, asi que el segundo toque de canjear caia en "esta socia no
   * tiene premio pendiente"; la socia ya esta en el plan nuevo, asi que el segundo
   * toque de cambiar plan caia en "ya esta en ese plan"; y el contador ya vale lo
   * pedido, asi que el segundo ajuste caia en "ya tiene ese numero de sellos".
   *
   * Ninguno de los tres duplicaba nada, asi que el libro estaba a salvo. **Lo que
   * estaba mal es lo que leia recepcion:** un error rojo despues de una operacion que
   * si funciono, justo en el caso que mas se va a dar en un mostrador con mala señal.
   * Con la clave por delante, el reintento devuelve la ficha y `repetida`, que es la
   * verdad.
   */
  async function repetidaPorClave(
    c: ContextoPanel,
    negocioId: string,
    socia: FilaSocia,
    plan: FilaPlan,
  ) {
    const clave = c.req.header('Idempotency-Key');
    if (!clave) return null;
    const previo = await db.movimientoPorClave(negocioId, clave);
    if (!previo) return null;
    return c.json({ socia: await fichaFresca(negocioId, socia.id, socia, plan), repetida: true });
  }

  /**
   * El camino de escritura, uno solo para pago, canje, cambio de plan y ajuste. La
   * idempotencia se resuelve aqui y no en cada ruta.
   */
  async function escribir(
    c: ContextoPanel,
    opciones: {
      socia: FilaSocia;
      plan: FilaPlan;
      negocioId: string;
      evento: Parameters<typeof aplicar>[2];
      planNuevo?: FilaPlan;
      notificar: boolean;
      /** Lo que lee recepcion al confirmarse. Siempre menciona la espera del pase. */
      aviso?: string;
    },
  ) {
    const { socia, plan, negocioId, evento, planNuevo, notificar } = opciones;
    const clave = c.req.header('Idempotency-Key') ?? null;

    // El segundo toque del mismo boton devuelve el estado actual, no un error, y sobre
    // todo no inserta otro movimiento. Las rutas que validan algo antes de escribir lo
    // consultan ellas mismas, antes de validar.
    const repetida = await repetidaPorClave(c, negocioId, socia, plan);
    if (repetida) return repetida;

    const resultado = aplicar(plan, estadoDeSocia(socia), evento);
    const movimientos = resultado.movimientos.map((m, i) => ({
      ...m.movimiento,
      // Cada fila guarda el plan con el que se evalua. En un cambio de plan, el canje
      // forzado lleva el plan de origen y la fila del cambio el nuevo.
      planId: idDelPlan(m.plan),
      // La clave va en el primero: la restriccion unica de la base es la que de verdad
      // impide el duplicado si dos peticiones llegan juntas.
      claveIdempotencia: i === 0 ? clave : null,
      movimientoReversadoId: null as string | null,
    }));

    try {
      await db.registrar({
        negocioId,
        sociaId: socia.id,
        usuarioPanelId: c.get('usuarioId'),
        movimientos,
        estado: {
          sellos: resultado.estado.sellos,
          premioPendiente: resultado.estado.premioPendiente,
          premioChicoUsadoEnCiclo: resultado.estado.premioChicoUsadoEnCiclo,
          premioGrandeUsadoEnCiclo: resultado.estado.premioGrandeUsadoEnCiclo,
        },
        planId: planNuevo?.id,
      });
    } catch (error) {
      if (error instanceof ClaveRepetida) {
        // Dos toques simultaneos: la restriccion unica de la base decidio por nosotros.
        return c.json({ socia: await fichaFresca(negocioId, socia.id, socia, plan), repetida: true });
      }
      throw error;
    }

    const planVigente = planNuevo ?? plan;
    const sociaActualizada: FilaSocia = {
      ...socia,
      planId: planVigente.id,
      sellos: resultado.estado.sellos,
      premioPendiente: resultado.estado.premioPendiente,
      premioChicoUsadoEnCiclo: resultado.estado.premioChicoUsadoEnCiclo,
      premioGrandeUsadoEnCiclo: resultado.estado.premioGrandeUsadoEnCiclo,
      recibioSelloDeBienvenida: resultado.estado.recibioSelloDeBienvenida,
    };

    // Aqui ya se le puede contestar a recepcion: la fila existe. Google va despues.
    enSegundoPlano(sincronizar(sociaActualizada, planVigente, resultado.estado, notificar));

    return c.json({
      socia: fichaDeSocia(sociaActualizada, planVigente, resultado.estado),
      efectos: resultado.efectos,
      avisoDeEspera:
        opciones.aviso ??
        'Ya quedo registrado. El telefono de la socia tarda de uno a dos minutos en mostrarlo.',
    });
  }

  panel.post('/socias/:id/pago', async (c) => {
    const cargado = await cargar(c);
    if (!cargado.ok) return cargado.respuesta;
    const { negocioId, socia, plan } = cargado;
    return escribir(c, {
      socia,
      plan,
      negocioId,
      evento: { tipo: 'registrar_pago' },
      notificar: true,
      // La frase de la capacitacion, palabra por palabra. Lo primero que recepcion va
      // a malinterpretar es la espera, y volver a picar el boton ensucia un libro que
      // no se puede borrar.
      aviso:
        'El sello ya quedo registrado. El telefono de la socia tarda de uno a dos minutos en mostrarlo.',
    });
  });

  panel.post('/socias/:id/canje', async (c) => {
    const cargado = await cargar(c);
    if (!cargado.ok) return cargado.respuesta;
    const { negocioId, socia, plan } = cargado;
    // La clave va antes de la validacion: si esta es la repeticion de un canje que ya
    // corrio, el premio ya no esta pendiente y validar primero mentiria.
    const repetida = await repetidaPorClave(c, negocioId, socia, plan);
    if (repetida) return repetida;
    if (socia.premioPendiente === 'ninguno') {
      return c.json({ error: 'esta socia no tiene premio pendiente' }, 409);
    }
    return escribir(c, {
      socia,
      plan,
      negocioId,
      evento: { tipo: 'canjear_premio' },
      notificar: true,
    });
  });

  panel.post('/socias/:id/cambiar-plan', async (c) => {
    const cargado = await cargar(c);
    if (!cargado.ok) return cargado.respuesta;
    const { negocioId, socia, plan } = cargado;
    // Igual que en el canje: si esta es la repeticion de un cambio que ya corrio, la
    // socia ya esta en el plan nuevo y "ya esta en ese plan" seria una mentira.
    const repetida = await repetidaPorClave(c, negocioId, socia, plan);
    if (repetida) return repetida;

    const cuerpo = await cuerpoJson<{ planId: string; sellosDestino: number }>(c);
    if (!cuerpo.planId) return c.json({ error: 'falta planId' }, 400);
    if (cuerpo.planId === plan.id) return c.json({ error: 'ya esta en ese plan' }, 409);

    const planNuevo = await db.planPorId(negocioId, cuerpo.planId);
    if (!planNuevo) return c.json({ error: 'ese plan no existe' }, 404);

    // `sellosDestino` solo lo usa la regla vieja, cuando `conservaSellosAlCambiarPlan`
    // esta en true. Con el default del 14 de octubre la plantilla se va a cero siempre,
    // y lo que llegue aqui se ignora.
    const destino =
      typeof cuerpo.sellosDestino === 'number' && Number.isInteger(cuerpo.sellosDestino)
        ? cuerpo.sellosDestino
        : socia.sellos;
    if (destino < 0) return c.json({ error: 'los sellos no pueden ser negativos' }, 400);

    return escribir(c, {
      socia,
      plan,
      negocioId,
      planNuevo,
      evento: { tipo: 'cambiar_plan', planNuevo, sellosDestino: destino },
      notificar: true,
    });
  });

  /**
   * Ajuste manual de recepcion.
   *
   * ⚠️ **EL TOPE SE RECHAZA, NO SE ACOTA EN SILENCIO.** `mecanica.ts` acota, porque es
   * la autoridad y tiene que sostener el invariante aunque le llegue cualquier numero.
   * Pero si la API dejara pasar un destino arriba del tope, recepcion pediria 6 y
   * veria 5 sin explicacion, y aprenderia el tope picandole. Asi que aqui se rechaza
   * con el numero y con la salida correcta escrita en la respuesta: deshacer los
   * movimientos equivocados.
   *
   * **No notifica.** Es una correccion del mostrador, igual que deshacer: el cupo es de
   * 3 notificaciones por pase en 24 horas y las necesita un pago de verdad, y a la
   * socia no se le avisa de un error administrativo que no pidio. Si algun dia se
   * quiere al contrario, es `notificar: true` en esta sola linea.
   */
  panel.post('/socias/:id/ajuste', async (c) => {
    const cargado = await cargar(c);
    if (!cargado.ok) return cargado.respuesta;
    const { negocioId, socia, plan } = cargado;
    // Y lo mismo aqui: tras el primer ajuste el contador ya vale lo pedido, asi que
    // "ya tiene ese numero de sellos" seria la respuesta equivocada a un reintento.
    const repetida = await repetidaPorClave(c, negocioId, socia, plan);
    if (repetida) return repetida;

    const cuerpo = await cuerpoJson<{ sellosDestino: number }>(c);
    const destino = cuerpo.sellosDestino;

    if (typeof destino !== 'number' || !Number.isInteger(destino)) {
      return c.json({ error: 'falta sellosDestino' }, 400);
    }
    if (destino < 0) return c.json({ error: 'los sellos no pueden ser negativos' }, 400);
    if (destino === socia.sellos) {
      return c.json({ error: 'esa socia ya tiene ese numero de sellos' }, 409);
    }
    if (destino > plan.topeSellosAjusteManual) {
      return c.json(
        {
          error: `el ajuste manual llega hasta ${plan.topeSellosAjusteManual} sellos, no hasta ${plan.sellosTotales}`,
          tope: plan.topeSellosAjusteManual,
          comoSeArregla:
            'El ajuste nunca completa plantilla ni entrega premio. Para devolverle una plantilla llena hay que deshacer los movimientos equivocados, no escribir el numero a mano.',
        },
        409,
      );
    }

    return escribir(c, {
      socia,
      plan,
      negocioId,
      evento: { tipo: 'ajuste_manual', sellosDestino: destino },
      notificar: false,
    });
  });

  panel.post('/movimientos/:id/deshacer', async (c) => {
    const negocioId = c.get('negocioId');
    const movimiento = await db.movimientoPorId(negocioId, c.req.param('id') ?? '');
    if (!movimiento) return c.json({ error: 'no encontrado' }, 404);
    if (movimiento.tipo === 'reverso') {
      return c.json({ error: 'un reverso no se deshace' }, 409);
    }
    /**
     * ⚠️ TRES TIPOS QUE NO SE DESHACEN, cerrado el 16 de octubre de 2026 al construir
     * el panel. **Hasta hoy la ruta los aceptaba, y eso era una trampa:**
     *
     * - Un canje. El reverso de `mecanica.ts` solo REVOCA premios, nunca los otorga,
     *   asi que deshacer un canje no le devuelve el descuento a la socia: escribe una
     *   fila que no hace nada en un libro que no se puede borrar, mientras recepcion
     *   cree que lo devolvio.
     * - Un cambio de plan. El reverso devuelve los sellos, pero **el plan de la socia
     *   no vuelve atras**, porque eso no es un sello y no viaja en el libro. Quedaria a
     *   medias, que es peor que no poder.
     *
     * Lo que si se deshace es lo que el reverso sabe deshacer completo: un pago, un
     * ajuste y el sello de bienvenida.
     */
    if (movimiento.tipo === 'canje_chico' || movimiento.tipo === 'canje_grande') {
      return c.json(
        {
          error: 'un canje no se deshace',
          comoSeArregla:
            'El descuento ya se aplico en el mostrador y el boton no lo devuelve. Si fue un error, corrige los sellos con el ajuste y avisale a Oscar para que lo revise en el libro.',
        },
        409,
      );
    }
    if (movimiento.tipo === 'cambio_plan') {
      return c.json(
        {
          error: 'un cambio de plan no se deshace',
          comoSeArregla:
            'Los sellos volverian, pero el plan no. Si fue un error, cambia el plan otra vez al anterior y confirma el numero de sellos con el ajuste.',
        },
        409,
      );
    }
    if (movimiento.reversado) {
      return c.json({ error: 'ese movimiento ya se deshizo' }, 409);
    }
    const limite = ahora().getTime() - MINUTOS_PARA_DESHACER * 60_000;
    if (new Date(movimiento.creadoEn).getTime() < limite) {
      return c.json(
        { error: `deshacer solo esta disponible ${MINUTOS_PARA_DESHACER} minutos` },
        409,
      );
    }

    const socia = await db.sociaPorId(negocioId, movimiento.sociaId);
    if (!socia) return c.json({ error: 'no encontrada' }, 404);
    const plan = socia.planId ? await db.planPorId(negocioId, socia.planId) : null;
    if (!plan) return c.json({ error: 'la socia no tiene plan asignado' }, 409);

    const filas = await db.libro(negocioId, socia.id);
    const libro = alLibro(filas, await db.planes(negocioId));
    const indice = filas.findIndex((f) => f.id === movimiento.id);
    const resultado = aplicar(plan, estadoDeSocia(socia), { tipo: 'deshacer', libro, indice });

    await db.registrar({
      negocioId,
      sociaId: socia.id,
      usuarioPanelId: c.get('usuarioId'),
      movimientos: resultado.movimientos.map((m) => ({
        ...m.movimiento,
        planId: idDelPlan(m.plan),
        claveIdempotencia: null,
        movimientoReversadoId: movimiento.id,
      })),
      estado: {
        sellos: resultado.estado.sellos,
        premioPendiente: resultado.estado.premioPendiente,
        premioChicoUsadoEnCiclo: resultado.estado.premioChicoUsadoEnCiclo,
        premioGrandeUsadoEnCiclo: resultado.estado.premioGrandeUsadoEnCiclo,
      },
    });

    const sociaActualizada: FilaSocia = {
      ...socia,
      sellos: resultado.estado.sellos,
      premioPendiente: resultado.estado.premioPendiente,
      premioChicoUsadoEnCiclo: resultado.estado.premioChicoUsadoEnCiclo,
      premioGrandeUsadoEnCiclo: resultado.estado.premioGrandeUsadoEnCiclo,
    };

    // Deshacer actualiza el pase SIN notificar: una correccion del mostrador no le
    // avisa a la socia ni gasta una de las 3 notificaciones por pase en 24 horas.
    enSegundoPlano(sincronizar(sociaActualizada, plan, resultado.estado, false));

    return c.json({
      socia: fichaDeSocia(sociaActualizada, plan, resultado.estado),
      deshecho: movimiento.id,
    });
  });

  app.route('/', panel);
  app.onError((error, c) => {
    console.log('error no previsto:', error instanceof Error ? error.message : String(error));
    return c.json({ error: 'algo salio mal' }, 500);
  });

  return app;
}

/**
 * Pregunta a Cloudflare si el captcha que mando el navegador es bueno.
 *
 * **Esto es espera de red, no CPU**, asi que no toca el limite de 10 ms del plan
 * gratuito: lo que cuenta ahi es firmar, parsear y serializar, no esperar.
 *
 * Si falla la llamada se devuelve `false`, nunca `true`. Un captcha que no se pudo
 * verificar no es un captcha aprobado.
 */
export async function verificarTurnstile(
  secreto: string,
  respuesta: string,
  ip: string | null,
): Promise<boolean> {
  if (!respuesta) return false;
  const campos = new FormData();
  campos.append('secret', secreto);
  campos.append('response', respuesta);
  if (ip) campos.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: campos,
    });
    const datos = (await r.json()) as { success?: boolean };
    return datos.success === true;
  } catch {
    return false;
  }
}

/** Arma las dependencias reales a partir del entorno del Worker. */
export function dependenciasDeEntorno(
  entorno: Entorno,
  enSegundoPlano?: (tarea: Promise<unknown>) => void,
): Dependencias {
  const db = crearBaseDeDatos(entorno.DATABASE_URL);
  const secreto = entorno.TURNSTILE_SECRET;
  const limitador = entorno.LIMITE_ALTA;
  // Se compara contra el texto exacto: una variable puesta en `no`, en `false` o
  // vacia no autoriza nada. Lo que no esta escrito tal cual, no cuenta.
  const permiteSaltarCaptcha = entorno.CAPTCHA_OPCIONAL === 'si';
  return {
    db,
    negocioPublico: entorno.NEGOCIO_ID,
    enSegundoPlano,
    /**
     * Tres caminos, y el tercero es el que antes no existia:
     *
     * 1. Hay secreto: se verifica contra Cloudflare. Es produccion.
     * 2. No hay secreto pero alguien escribio `CAPTCHA_OPCIONAL=si` en `.dev.vars`:
     *    se salta, con aviso en el log. Es `wrangler dev`, y es una decision escrita
     *    a mano, no un default.
     * 3. No hay secreto y nadie lo autorizo: **`/alta` queda cerrada.** Antes este
     *    caso caia en el 2 sin que nadie lo hubiera pedido.
     */
    captchaConfigurado: Boolean(secreto) || permiteSaltarCaptcha,
    verificarCaptcha: secreto
      ? (respuesta, ip) => verificarTurnstile(secreto, respuesta, ip)
      : async () => {
          console.warn(
            'alta: corriendo SIN captcha porque CAPTCHA_OPCIONAL esta puesto. ' +
              'Esto nunca debe pasar en produccion.',
          );
          return true;
        },
    // El binding del limitador no existe en los tests. Sin el, no hay cupo que gastar.
    dentroDelLimite: limitador
      ? async (clave) => (await limitador.limit({ key: clave })).success
      : undefined,
    wallet: {
      crear: (socia, plan, estado) =>
        crearObjeto(entorno, { id: socia.id, nombre: socia.nombre }, plan, estado),
      actualizar: (socia, plan, estado, notificar) =>
        notificar
          ? actualizarObjeto(
              entorno,
              { id: socia.id, nombre: socia.nombre, objetoWalletId: socia.objetoWalletId },
              plan,
              estado,
            )
          : actualizarSinNotificar(
              entorno,
              { id: socia.id, nombre: socia.nombre, objetoWalletId: socia.objetoWalletId },
              plan,
              estado,
            ),
      link: (socia) => linkDeGuardado(entorno, { id: socia.id, nombre: socia.nombre }),
      idObjeto: (socia) => idDelObjeto(entorno, { id: socia.id, nombre: socia.nombre }),
    },
  };
}

/**
 * El cron reintenta los pases que quedaron pendientes. Corre cada 30 minutos y toma pocos
 * por vez: el limite del plan gratuito son 50 peticiones salientes por invocacion.
 */
export async function reintentarPendientes(deps: Dependencias, limite = 10): Promise<number> {
  const pendientes = await deps.db.pendientesDeSync(limite);
  let logrados = 0;
  for (const { negocioId, sociaId } of pendientes) {
    const socia = await deps.db.sociaPorId(negocioId, sociaId);
    if (!socia || !socia.planId) continue;
    const plan = await deps.db.planPorId(negocioId, socia.planId);
    if (!plan) continue;
    const estado = estadoDeSocia(socia);

    // Si la socia todavia no tiene pase, lo que falta es crearlo, no parchearlo.
    const resultado = socia.objetoWalletId
      ? await deps.wallet.actualizar(socia, plan, estado, false)
      : await deps.wallet.crear(socia, plan, estado);

    if (resultado.ok) {
      if (!socia.objetoWalletId) {
        await deps.db.guardarObjetoWallet(negocioId, socia.id, deps.wallet.idObjeto(socia));
      }
      await deps.db.marcarSyncOk(socia.id);
      logrados += 1;
    } else {
      await deps.db.marcarSyncError(socia.id, resultado.detalle ?? 'sin detalle');
    }
  }
  return logrados;
}
