/**
 * pases_wallet.mjs: el inventario de lo que hay en el emisor de Google Wallet, y la
 * unica via para retirar un pase de circulacion.
 *
 * Se corre en la maquina de Oscar, nunca en el Worker. Dos verbos:
 *
 *   node backend/herramientas/pases_wallet.mjs estado
 *   node backend/herramientas/pases_wallet.mjs expirar <id del objeto> --si
 *
 * POR QUE EXISTE ESTE ARCHIVO, escrito el 23 de octubre de 2026 al abrir H11:
 *
 * H11 pedia "desactivar en la consola las clases de prueba del emisor". **Eso no se
 * puede hacer, ni en la consola ni por API, y no es un limite de permisos sino de la
 * API.** Comprobado el 23 de octubre contra la referencia de `loyaltyclass` y contra
 * la respuesta real del emisor: una clase tiene `reviewStatus` con tres valores
 * (`draft`, `underReview`, `approved`), **no tiene ningun campo de estado, de baja ni
 * de archivado**, `approved` no puede volver a `draft`, y **no existe metodo delete**.
 * Las cuatro clases del emisor son permanentes y las tres muertas se van a quedar ahi
 * para siempre.
 *
 * **Lo que si se puede, y es lo que de verdad importaba:** el ESTADO vive en el
 * OBJETO, que es el pase que la socia tiene en el telefono. Un objeto en `expired` se
 * va a la seccion "Pases caducados" del Wallet, y una clase sin objetos vivos no le
 * aparece a nadie. Asi que retirar los pases viejos se hace objeto por objeto, aqui.
 *
 * ⚠️ EXPIRAR NO NOTIFICA. `notifyPreference` solo aplica sobre
 * `loyaltyPoints.balance`, asi que este PATCH no gasta ninguna de las 3
 * notificaciones por pase en 24 horas y la socia no recibe aviso. **El pase cambia en
 * silencio**, asi que a quien tenga el pase viejo hay que decirselo por WhatsApp.
 *
 * ⚠️ NO HAY VUELTA ATRAS POR ESTE ARCHIVO. `expirar` solo expira. Revivir un pase es
 * un PATCH a `state: ACTIVE` que no esta escrito aqui a proposito: el dia que haga
 * falta, que sea una decision y no un flag.
 *
 * LO QUE ESTE ARCHIVO NUNCA HACE:
 *   1. No imprime credenciales ni la cadena de conexion de `.dev.vars`.
 *   2. No crea objetos ni clases. Los pases nacen por la pagina de alta, que es la que
 *      los deja atados a una fila de `socias`.
 *   3. No toca la base. Lee `socias` para poder decir de quien es cada pase, y nada mas.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

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
  WALLET_BASE_IMAGENES: variable('WALLET_BASE_IMAGENES'),
};

async function pedir(ruta, opciones = {}) {
  const token = await obtenerToken(entorno);
  const respuesta = await fetch(`${API}/${ruta}`, {
    ...opciones,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(opciones.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  return { estado: respuesta.status, cuerpo };
}

/** Las socias de la base, indexadas por el id de objeto que cada una tiene guardado. */
async function sociasPorObjeto() {
  const sql = neon(variable('DATABASE_URL'));
  const filas = await sql`
    select s.id, s.nombre, s.objeto_wallet_id, s.es_prueba, s.activa, p.nombre as plan
      from socias s left join planes p on p.id = s.plan_id
  `;
  const mapa = new Map();
  for (const f of filas) {
    // El id guardado puede ser el completo o solo el UUID, segun por donde nacio.
    const claves = [f.objeto_wallet_id, `${entorno.WALLET_ISSUER_ID}.${f.id}`].filter(Boolean);
    for (const clave of claves) mapa.set(clave, f);
  }
  return mapa;
}

function etiquetaDeSocia(objeto, mapa) {
  const fila = mapa.get(objeto.id);
  if (!fila) return 'HUERFANO: no corresponde a ninguna fila de socias';
  const marcas = [fila.plan ?? 'sin plan'];
  if (fila.es_prueba) marcas.push('es_prueba');
  if (!fila.activa) marcas.push('ficha inactiva');
  return `socia "${fila.nombre}" (${marcas.join(', ')})`;
}

async function estado() {
  const clases = await pedir(`loyaltyClass?issuerId=${entorno.WALLET_ISSUER_ID}`);
  if (clases.estado !== 200) {
    salir(`Google respondio ${clases.estado} al listar las clases.`);
  }
  const mapa = await sociasPorObjeto();
  const lista = clases.cuerpo.resources ?? [];

  console.log(`\nEMISOR ${entorno.WALLET_ISSUER_ID}: ${lista.length} clases\n`);
  let vivos = 0;
  for (const clase of lista) {
    const canonica = clase.id === entorno.WALLET_CLASE_ID;
    console.log(`  ${clase.id}`);
    console.log(
      `    ${canonica ? '⭐ LA CANONICA, la de WALLET_CLASE_ID' : 'muerta, no nace nada aqui'}` +
        ` | reviewStatus: ${clase.reviewStatus}`,
    );
    const objetos = await pedir(`loyaltyObject?classId=${encodeURIComponent(clase.id)}`);
    const suyos = objetos.cuerpo.resources ?? [];
    if (objetos.estado !== 200) {
      console.log(`    objetos: Google respondio ${objetos.estado}`);
    } else if (suyos.length === 0) {
      console.log('    objetos: ninguno');
    } else {
      console.log(`    objetos: ${suyos.length}`);
      for (const objeto of suyos) {
        const activo = String(objeto.state ?? '').toLowerCase() === 'active';
        if (activo) vivos += 1;
        console.log(`      ${activo ? '●' : '○'} ${objeto.id}`);
        console.log(
          `          state: ${objeto.state} | en el pase: "${objeto.accountName}" ` +
            `${JSON.stringify(objeto.loyaltyPoints?.balance?.string ?? null)}`,
        );
        console.log(`          ${etiquetaDeSocia(objeto, mapa)}`);
      }
    }
    console.log('');
  }
  console.log(`Pases vivos en total: ${vivos}. Los marcados ● son los que se ven en un telefono.`);
  console.log('Una clase no se puede desactivar ni borrar: lo que se retira es el objeto.');
  console.log('Retirar un pase: node backend/herramientas/pases_wallet.mjs expirar <id> --si\n');
}

async function expirar(id, confirmado) {
  if (!id) salir('falta el id del objeto. Sacalo de `estado`, completo y con el issuer adelante.');

  const antes = await pedir(`loyaltyObject/${encodeURIComponent(id)}`);
  if (antes.estado === 404) salir(`no existe el objeto ${id}. Revisa el id contra \`estado\`.`);
  if (antes.estado !== 200) salir(`Google respondio ${antes.estado} al leer ${id}.`);

  const mapa = await sociasPorObjeto();
  const fila = mapa.get(id);
  if (fila && fila.activa && !fila.es_prueba) {
    salir(
      `ese pase es de "${fila.nombre}", que esta VIVA en la base y no esta marcada como ` +
        'prueba. Expirarlo la deja sin tarjeta y sin aviso. Si de verdad se va, primero ' +
        'da de baja su ficha; si es una socia de prueba, marcala con es_prueba.',
    );
  }

  console.log(`\nobjeto:     ${id}`);
  console.log(`en el pase: "${antes.cuerpo.accountName}"`);
  console.log(`state hoy:  ${antes.cuerpo.state}`);
  console.log(`la base:    ${etiquetaDeSocia({ id }, mapa)}`);

  if (!confirmado) {
    console.log('\nNo escribi nada. Para hacerlo de verdad, repite el comando con --si.\n');
    return;
  }

  const patch = await pedir(`loyaltyObject/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'EXPIRED' }),
  });
  if (patch.estado !== 200) {
    salir(`Google respondio ${patch.estado}: ${JSON.stringify(patch.cuerpo).slice(0, 600)}`);
  }

  const despues = await pedir(`loyaltyObject/${encodeURIComponent(id)}`);
  console.log(`\nstate ahora: ${despues.cuerpo.state}`);
  console.log('El pase se fue a "Pases caducados" en el telefono de quien lo tenga.');
  console.log('No se mando notificacion: expirar no notifica. Avisale por WhatsApp.\n');
}

const [verbo, ...resto] = process.argv.slice(2);
if (verbo === 'estado') {
  await estado();
} else if (verbo === 'expirar') {
  await expirar(
    resto.find((a) => !a.startsWith('--')),
    resto.includes('--si'),
  );
} else {
  console.log('\nUso:');
  console.log('  node backend/herramientas/pases_wallet.mjs estado');
  console.log('  node backend/herramientas/pases_wallet.mjs expirar <id del objeto> --si\n');
  console.log('Sin --si, `expirar` solo te dice de quien es el pase y no escribe nada.\n');
  process.exit(verbo ? 1 : 0);
}
