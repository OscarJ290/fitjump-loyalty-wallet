/**
 * clase_wallet.mjs: lee y parchea LA CLASE de Google Wallet.
 *
 * Se corre en la maquina de Oscar, nunca en el Worker. Dos verbos:
 *
 *   node backend/herramientas/clase_wallet.mjs estado
 *   node backend/herramientas/clase_wallet.mjs parchear [--si]
 *
 * POR QUE EXISTE ESTE ARCHIVO, escrito el 27 de octubre de 2026:
 *
 * **Nada del codigo vivo podia editar la clase.** `backend\src\wallet.ts` no menciona
 * `linksModuleData` ni una sola vez, porque la clase se creo con un script de Python que
 * hoy esta congelado y que ademas escribia en la clase VIEJA, la del segmento
 * `<segmento-viejo>`. `pases_wallet.mjs` solo lista y expira OBJETOS. Asi que los cuatro
 * enlaces y los dos logos de la clase llevaban un mes en produccion sin ninguna via para
 * cambiarlos: para arreglar un enlace roto habia que escribir una herramienta primero.
 * Esta es esa herramienta.
 *
 * ⚠️ UN PATCH A UNA CLASE APROBADA LA MANDA A `UNDER_REVIEW`, y eso no se puede deshacer
 * por cuenta propia: volver a `approved` lo decide Google. Por eso el verbo `parchear`
 * **no escribe nada sin `--si`** y por eso todo lo que haya que cambiar se manda en UNA
 * sola peticion. Dos parches son dos revisiones.
 *
 * ⚠️ `PATCH` NO ES UNA FUSION PROFUNDA. Google reemplaza el objeto anidado entero por el
 * que se le manda: si `programLogo` viaja con `sourceUri` y sin `contentDescription`, la
 * descripcion se pierde. Por eso esta herramienta **lee la clase primero** y reconstruye
 * cada objeto completo a partir de lo que ya tiene, cambiando solo la URL. Ni un campo
 * se escribe de memoria.
 *
 * ⚠️ NO TOCA NI UN OBJETO. Los pases de las socias viven en `loyaltyObject` y esta
 * herramienta solo habla de `loyaltyClass`. Un pase ya emitido no se entera de esto mas
 * que por los campos que hereda de su clase.
 *
 * LO QUE ESTE ARCHIVO NUNCA HACE:
 *   1. No imprime credenciales ni la cadena de conexion de `.dev.vars`.
 *   2. No crea ni borra clases. Una clase no se puede borrar: no existe el metodo.
 *   3. No toca la base de datos. La clase no vive ahi.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(AQUI, '..', '.dev.vars');
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';

/** La firma del JWT y el token viven en `wallet.ts`, que es la autoridad de Google. */
const { obtenerToken } = await import(pathToFileURL(join(AQUI, '..', 'src', 'wallet.ts')).href);

function salir(mensaje) {
  console.error('PARA: ' + mensaje);
  process.exit(1);
}

/** Lee una variable de `backend\.dev.vars` sin imprimir nada. Esta en `.gitignore`. */
function variable(nombre) {
  let texto;
  try {
    texto = readFileSync(DEV_VARS, 'utf8');
  } catch {
    salir(`no encontre ${DEV_VARS}. Es el archivo que tiene las credenciales.`);
  }
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.startsWith(nombre + '=')) continue;
    return linea
      .slice(nombre.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  salir(`${DEV_VARS} no tiene ${nombre}.`);
}

const entorno = {
  GOOGLE_CLIENT_EMAIL: variable('GOOGLE_CLIENT_EMAIL'),
  GOOGLE_PRIVATE_KEY: variable('GOOGLE_PRIVATE_KEY'),
  WALLET_ISSUER_ID: variable('WALLET_ISSUER_ID'),
  WALLET_CLASE_ID: variable('WALLET_CLASE_ID'),
};

/**
 * ⚠️ LA CANONICA Y NADA MAS. El emisor tiene cuatro clases y tres estan muertas, y la
 * unica forma de escribir en la equivocada es que `WALLET_CLASE_ID` cambie sin que nadie
 * se de cuenta. Se compara, no se confia.
 */
const CLASE_CANONICA = '3388000000023195590.fitjump_lealtad_v1';
if (entorno.WALLET_CLASE_ID !== CLASE_CANONICA) {
  salir(
    `WALLET_CLASE_ID vale "${entorno.WALLET_CLASE_ID}" y esta herramienta solo opera sobre ` +
      `"${CLASE_CANONICA}". Si de verdad hay que tocar otra clase, se cambia aqui a mano.`,
  );
}

/* Las URLs nuevas, el unico dato que esta herramienta aporta de su cosecha. */
const BASE_CLASE = 'https://fitjump.com.mx/imagenes/clase/v1';
const URL_LOGO = `${BASE_CLASE}/logo-icono-wallet.png`;
const URL_MARCA = `${BASE_CLASE}/marca-denominativa-wallet.png`;
const URL_INICIO = 'https://fitjump.com.mx';
const URL_EVENTOS = 'https://fitjump.com.mx/eventos/';

/** El id del enlace cuya URL cambia. Los otros dos quedan intactos. */
const ID_QUE_CAMBIA = 'clases_especiales';

async function pedir(ruta, opciones = {}) {
  const token = await obtenerToken(entorno);
  const respuesta = await fetch(`${API}/${ruta}`, {
    ...opciones,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(opciones.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  return { estado: respuesta.status, cuerpo };
}

async function leerClase() {
  const r = await pedir(`loyaltyClass/${encodeURIComponent(CLASE_CANONICA)}`);
  if (r.estado !== 200) {
    salir(`Google respondio ${r.estado} al leer la clase: ${JSON.stringify(r.cuerpo).slice(0, 600)}`);
  }
  return r.cuerpo;
}

const url = (imagen) => imagen?.sourceUri?.uri ?? null;

function imprimirClase(clase) {
  console.log('');
  console.log(`CLASE ${clase.id}`);
  console.log(`  reviewStatus:     ${clase.reviewStatus}`);
  console.log(`  issuerName:       ${JSON.stringify(clase.issuerName ?? null)}`);
  console.log(`  programLogo:      ${url(clase.programLogo)}`);
  console.log(`  wideProgramLogo:  ${url(clase.wideProgramLogo)}`);
  console.log(`  homepageUri:      ${JSON.stringify(clase.homepageUri ?? null)}`);
  console.log('  linksModuleData:');
  const enlaces = clase.linksModuleData?.uris ?? [];
  if (enlaces.length === 0) console.log('    (ninguno)');
  for (const e of enlaces) {
    console.log(`    [${e.id}] ${JSON.stringify(e.description)}`);
    console.log(`        ${e.uri}`);
  }
  console.log('');
}

/**
 * Arma el cuerpo del PATCH **a partir de la clase que Google tiene hoy**, no de memoria.
 * Cada objeto anidado viaja completo, porque `PATCH` lo reemplaza entero.
 */
function cuerpoDelParche(clase) {
  const enlaces = clase.linksModuleData?.uris ?? [];

  // Se comprueba la forma ANTES de escribir. Si la clase no es la que se reviso, el
  // parche se construiria sobre una suposicion.
  if (enlaces.length !== 3) {
    salir(`la clase tiene ${enlaces.length} enlaces y se esperaban 3. Revisa \`estado\` antes de parchear.`);
  }
  if (!enlaces.some((e) => e.id === ID_QUE_CAMBIA)) {
    salir(`la clase no tiene ningun enlace con id "${ID_QUE_CAMBIA}". No hay nada que cambiar.`);
  }
  if (!clase.programLogo || !clase.wideProgramLogo) {
    salir('la clase no trae programLogo o wideProgramLogo. Revisa `estado`.');
  }

  return {
    // El id viaja en el cuerpo ademas de en la URL: Google lo exige y ademas es una
    // segunda red contra parchear la clase equivocada.
    id: clase.id,

    // Los dos logos: se conserva TODO lo que ya tenian y solo se cambia la URL. El
    // `contentDescription` es lo que lee un lector de pantalla, y perderlo por no
    // mandarlo seria un retroceso de accesibilidad invisible.
    programLogo: { ...clase.programLogo, sourceUri: { uri: URL_LOGO } },
    wideProgramLogo: { ...clase.wideProgramLogo, sourceUri: { uri: URL_MARCA } },

    // La descripcion se conserva tal cual, que hoy dice "Fit Jump".
    homepageUri: { ...clase.homepageUri, uri: URL_INICIO },

    // El arreglo COMPLETO y en el mismo orden. Solo cambia la uri de un elemento; los
    // otros dos se copian enteros, con su id y su descripcion.
    linksModuleData: {
      uris: enlaces.map((e) => (e.id === ID_QUE_CAMBIA ? { ...e, uri: URL_EVENTOS } : { ...e })),
    },

    // Lo que Google pide al actualizar una clase aprobada. No es opcional y no se puede
    // volver a `approved` por cuenta propia.
    reviewStatus: 'underReview',
  };
}

async function main() {
  const [verbo, ...resto] = process.argv.slice(2);
  const confirmado = resto.includes('--si');

  if (verbo === 'estado') {
    imprimirClase(await leerClase());
    console.log('Para ver el parche sin escribir: node backend/herramientas/clase_wallet.mjs parchear');
    console.log('');
    return;
  }

  if (verbo === 'parchear') {
    const clase = await leerClase();
    const cuerpo = cuerpoDelParche(clase);

    console.log('');
    console.log('LO QUE CAMBIA, campo por campo:');
    console.log('');
    const filas = [
      ['programLogo', url(clase.programLogo), URL_LOGO],
      ['wideProgramLogo', url(clase.wideProgramLogo), URL_MARCA],
      ['homepageUri', clase.homepageUri?.uri ?? null, URL_INICIO],
      [
        `linksModuleData[${ID_QUE_CAMBIA}]`,
        (clase.linksModuleData?.uris ?? []).find((e) => e.id === ID_QUE_CAMBIA)?.uri ?? null,
        URL_EVENTOS,
      ],
      ['reviewStatus', clase.reviewStatus, 'underReview'],
    ];
    for (const [campo, antes, despues] of filas) {
      console.log(`  ${campo}`);
      console.log(`      antes:   ${antes}`);
      console.log(`      despues: ${despues}`);
    }
    const intactos = (clase.linksModuleData?.uris ?? []).filter((e) => e.id !== ID_QUE_CAMBIA);
    console.log('');
    console.log(`  Enlaces que NO cambian: ${intactos.map((e) => e.id).join(', ')}`);
    console.log('');
    console.log('EL CUERPO COMPLETO DEL PATCH:');
    console.log(JSON.stringify(cuerpo, null, 2));
    console.log('');

    if (!confirmado) {
      console.log('No escribi nada. Para hacerlo de verdad, repite el comando con --si.');
      console.log('⚠️  Ese PATCH manda la clase a UNDER_REVIEW y volver a APPROVED lo decide Google.');
      console.log('');
      return;
    }

    const r = await pedir(`loyaltyClass/${encodeURIComponent(CLASE_CANONICA)}`, {
      method: 'PATCH',
      body: JSON.stringify(cuerpo),
    });
    if (r.estado !== 200) {
      salir(`Google respondio ${r.estado}: ${JSON.stringify(r.cuerpo).slice(0, 900)}`);
    }
    console.log('PATCH aplicado. Como quedo la clase, segun la respuesta de Google:');
    imprimirClase(r.cuerpo);
    console.log('⚠️  La clase quedo en ' + r.cuerpo.reviewStatus + '. Volver a APPROVED lo decide Google.');
    console.log('    Los objetos ya emitidos siguen vivos: esto no toca ningun loyaltyObject.');
    console.log('');
    return;
  }

  console.log('\nUso:');
  console.log('  node backend/herramientas/clase_wallet.mjs estado');
  console.log('  node backend/herramientas/clase_wallet.mjs parchear [--si]');
  console.log('\nSin `--si`, `parchear` imprime el cuerpo y no escribe nada.\n');
  process.exit(verbo ? 1 : 0);
}

await main();
