/**
 * acceso_panel.mjs: da, repone y revoca los accesos del panel de recepcion.
 *
 * Se corre en la maquina de Oscar o dentro de la GitHub Action `enlace_panel.yml`,
 * nunca en el Worker. Tres verbos:
 *
 *   node backend/herramientas/acceso_panel.mjs estado
 *   node backend/herramientas/acceso_panel.mjs enlace Recepcion [--minutos 30] [--base https://...]
 *   node backend/herramientas/acceso_panel.mjs revocar Recepcion
 *
 * POR QUE EXISTE ESTE ARCHIVO Y NO UN `update` A MANO, decidido con Oscar el 16 de
 * octubre de 2026: reponer un enlace caducado y revocar un acceso perdido son las dos
 * cosas que de verdad van a pasar en el mostrador, y "existe la posibilidad teorica en
 * el esquema" no es lo mismo que "existe la via". Un `update` escrito a mano a las
 * nueve de la noche es como se revoca al usuario equivocado.
 *
 * LO QUE ESTE ARCHIVO NUNCA HACE:
 *   1. No imprime la cadena de conexion ni ningun secreto de `.dev.vars`.
 *   2. No guarda el codigo de activacion en ningun lado: en la base va solo su
 *      SHA-256, igual que el token de dispositivo. Se imprime una vez, aqui, y quien
 *      lo pierda pide otro.
 *   3. No aplica DDL. Las columnas las creo la migracion 010.
 *
 * ⚠️ EL CODIGO VIAJA EN EL FRAGMENTO DE LA URL, despues del `#`, y eso es a proposito:
 * **el navegador no manda el fragmento al servidor**, asi que el codigo no aparece en
 * los registros de Cloudflare ni en los del Worker. El panel lo lee de
 * `location.hash`, lo manda por POST una sola vez y limpia la barra de direcciones.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = join(AQUI, '..', '.dev.vars');
const MINUTOS_POR_OMISION = 30;
const BASE_POR_OMISION = 'http://localhost:8787';

/**
 * Lee una variable del entorno y, si ahi no viene, de `backend\.dev.vars`, sin cargar el
 * resto en memoria mas de lo necesario y sin imprimir nada. El archivo esta en
 * `.gitignore`.
 *
 * ⚠️ EL ENTORNO GANA, Y ESE ORDEN ES LO QUE PERMITE LAS DOS MAQUINAS A LA VEZ: en la
 * maquina de Oscar no existe `process.env.DATABASE_URL`, asi que cae a `.dev.vars` y se
 * comporta igual que siempre. Dentro de la GitHub Action `.dev.vars` NO EXISTE, porque
 * esta en `.gitignore` y nunca se versiono, y el valor llega por el secreto del
 * repositorio. Ninguno de los dos caminos imprime el valor.
 */
function variable(nombre) {
  const delEntorno = process.env[nombre];
  if (delEntorno !== undefined && delEntorno.trim() !== '') return delEntorno.trim();

  let texto;
  try {
    texto = readFileSync(DEV_VARS, 'utf8');
  } catch {
    salir(`${nombre} no viene del entorno y no encontre ${DEV_VARS}, que es el otro lugar donde se busca.`);
  }
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.startsWith(nombre + '=')) continue;
    return linea.slice(nombre.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  salir(`${nombre} no viene del entorno y ${DEV_VARS} tampoco lo tiene.`);
}

function salir(mensaje) {
  console.error('PARA: ' + mensaje);
  process.exit(1);
}

const sha256 = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex');

/** 32 bytes aleatorios en base64url: 43 caracteres, sin nada que escapar en una URL. */
const codigoNuevo = () => randomBytes(32).toString('base64url');

const fecha = (valor) =>
  valor ? new Date(valor).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';

async function main() {
  const [verbo, ...resto] = process.argv.slice(2);
  const opciones = {};
  const sueltos = [];
  for (let i = 0; i < resto.length; i += 1) {
    if (resto[i] === '--minutos' || resto[i] === '--base') {
      opciones[resto[i].slice(2)] = resto[i + 1];
      i += 1;
    } else {
      sueltos.push(resto[i]);
    }
  }

  const sql = neon(variable('DATABASE_URL'));
  const filas = await sql`
    select id, nombre, activo, token_hash is not null as con_token,
           alta_hash is not null as con_enlace, alta_expira, alta_creada_en, ultimo_acceso
      from usuarios_panel order by nombre
  `;
  if (filas.length === 0) salir('no hay usuarios de panel. Corre la migracion 003.');

  const buscar = (nombre) => {
    if (!nombre) {
      salir(`falta el nombre. Son: ${filas.map((f) => f.nombre).join(', ')}.`);
    }
    const fila = filas.find((f) => f.nombre.toLowerCase() === nombre.toLowerCase());
    if (!fila) {
      salir(`no existe "${nombre}". Son: ${filas.map((f) => f.nombre).join(', ')}.`);
    }
    return fila;
  };

  if (verbo === 'estado') {
    const ahora = Date.now();
    console.log('\nACCESOS DEL PANEL\n');
    for (const f of filas) {
      const caducado = f.alta_expira && new Date(f.alta_expira).getTime() <= ahora;
      const enlace = !f.con_enlace
        ? 'ninguno'
        : caducado
          ? `CADUCADO el ${fecha(f.alta_expira)}, hay que reponerlo`
          : `pendiente, caduca el ${fecha(f.alta_expira)}`;
      console.log(`  ${f.nombre}`);
      console.log(`    puede entrar:   ${f.activo && f.con_token ? 'si' : 'NO'}`);
      console.log(`    enlace:         ${enlace}`);
      console.log(`    ultimo acceso:  ${fecha(f.ultimo_acceso)}`);
      if (f.alta_creada_en) console.log(`    ultimo enlace generado: ${fecha(f.alta_creada_en)}`);
      console.log('');
    }
    console.log('Dar o reponer un acceso: node backend/herramientas/acceso_panel.mjs enlace <nombre>');
    console.log('Revocar un acceso:       node backend/herramientas/acceso_panel.mjs revocar <nombre>\n');
    return;
  }

  if (verbo === 'enlace') {
    const fila = buscar(sueltos[0]);
    const minutos = Number(opciones.minutos ?? MINUTOS_POR_OMISION);
    if (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) {
      salir('--minutos tiene que ser un entero entre 1 y 1440.');
    }
    const base = (opciones.base ?? BASE_POR_OMISION).replace(/\/+$/, '');

    const codigo = codigoNuevo();
    // Una sola columna, asi que esto SOBRESCRIBE cualquier enlace anterior de esa
    // persona: reponer es correr este mismo comando otra vez, y el viejo muere aqui,
    // caducado o no.
    await sql`
      update usuarios_panel
         set alta_hash = ${sha256(codigo)},
             alta_expira = now() + (${minutos} || ' minutes')::interval,
             alta_creada_en = now()
       where id = ${fila.id}
    `;

    const tenia = fila.activo && fila.con_token;
    console.log(`\nENLACE PARA ${fila.nombre.toUpperCase()}, de un solo uso, caduca en ${minutos} minutos:\n`);
    console.log(`  ${base}/panel/#c=${codigo}\n`);
    console.log('  Se abre UNA vez. Al abrirse, el telefono se queda con la sesion y el');
    console.log('  enlace deja de servir, asi que lo que quede en WhatsApp es un enlace muerto.');
    if (tenia) {
      console.log('');
      console.log(`  ⚠️  ${fila.nombre} ya tenia un dispositivo con sesion. En cuanto abra este`);
      console.log('      enlace, el dispositivo anterior queda fuera: una persona, un dispositivo.');
    }
    console.log('');
    console.log('  Si no lo abre antes de que caduque, corre este mismo comando otra vez.');
    console.log('');
    return;
  }

  if (verbo === 'revocar') {
    const fila = buscar(sueltos[0]);
    await sql`
      update usuarios_panel
         set token_hash = null, activo = false, alta_hash = null, alta_expira = null
       where id = ${fila.id}
    `;
    console.log(`\n${fila.nombre} ya no puede entrar al panel. Surte efecto en su siguiente toque.`);
    console.log('La fila NO se borro: el libro contable apunta a ella y nada que lo firme se borra.');
    console.log('Los otros dos accesos siguen intactos.');
    console.log(`Para devolverle el acceso: node backend/herramientas/acceso_panel.mjs enlace ${fila.nombre}\n`);
    return;
  }

  console.log('\nUso:');
  console.log('  node backend/herramientas/acceso_panel.mjs estado');
  console.log('  node backend/herramientas/acceso_panel.mjs enlace <nombre> [--minutos 30] [--base https://...]');
  console.log('  node backend/herramientas/acceso_panel.mjs revocar <nombre>\n');
  console.log(`Sin --base el enlace sale contra ${BASE_POR_OMISION}, que es wrangler dev.`);
  console.log('Para el telefono de la dueña hay que pasar --base con el dominio desplegado.\n');
  process.exit(verbo ? 1 : 0);
}

await main();
