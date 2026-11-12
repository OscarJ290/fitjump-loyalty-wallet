/**
 * h5-manual.ts: el script de la ACEPTACION HUMANA de H5. Lo corre Oscar, porque toca
 * pases reales de Google.
 *
 *   node backend/test/h5-manual.ts crear "Nombre de la socia"
 *   node backend/test/h5-manual.ts link
 *   node backend/test/h5-manual.ts sellos 1
 *   node backend/test/h5-manual.ts sellos 2 --sin-notificar
 *   node backend/test/h5-manual.ts leer
 *
 * Lee las credenciales de backend/.dev.vars, que esta en .gitignore. No imprime
 * ninguna: solo el id del objeto, el link y la respuesta de Google.
 *
 * ⚠️ CUPO: 3 notificaciones por pase en 24 horas. Cada `sellos` sin
 * `--sin-notificar` gasta una. `--sin-notificar` es lo que hace `deshacer`.
 */
import { readFileSync } from 'node:fs';
import {
  actualizarObjeto,
  actualizarSinNotificar,
  crearObjeto,
  idDelObjeto,
  linkDeGuardado,
  type EntornoWallet,
  type SociaParaWallet,
} from '../src/wallet.ts';
import { estadoInicial, type ConfiguracionPlan, type Estado } from '../src/mecanica.ts';

function leerDevVars(): Record<string, string> {
  const texto = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const salida: Record<string, string> = {};
  for (const linea of texto.split(/\r?\n/)) {
    const corte = linea.indexOf('=');
    if (!linea.trim() || linea.trimStart().startsWith('#') || corte < 0) continue;
    let valor = linea.slice(corte + 1).trim();
    if (valor.startsWith('"') || valor.startsWith("'")) valor = valor.slice(1, -1);
    salida[linea.slice(0, corte).trim()] = valor;
  }
  return salida;
}

const vars = leerDevVars();
const faltantes = [
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'WALLET_ISSUER_ID',
  'WALLET_CLASE_ID',
  'WALLET_BASE_IMAGENES',
].filter((n) => !vars[n]);
if (faltantes.length) {
  console.error('faltan variables en backend/.dev.vars: ' + faltantes.join(', '));
  process.exit(1);
}

const entorno: EntornoWallet = {
  GOOGLE_CLIENT_EMAIL: vars.GOOGLE_CLIENT_EMAIL!,
  GOOGLE_PRIVATE_KEY: vars.GOOGLE_PRIVATE_KEY!,
  WALLET_ISSUER_ID: vars.WALLET_ISSUER_ID!,
  WALLET_CLASE_ID: vars.WALLET_CLASE_ID!,
  WALLET_BASE_IMAGENES: vars.WALLET_BASE_IMAGENES!,
};

/**
 * El plan de la prueba. Son los mismos valores que la fila `Mensual` de `planes`,
 * escritos aqui solo porque este script no se conecta a la base: la API de H6 los
 * leera de la tabla.
 */
const planMensual: ConfiguracionPlan = {
  nombre: 'Mensual',
  sellosTotales: 6,
  sellosPremioChico: 3,
  montoPremioChico: 140,
  montoPremioGrande: 275,
  precio: 550,
  reiniciaAlCanjearGrande: true,
  reiniciaAlCanjearChico: false,
  premioChicoBorraSellos: false,
  sumaSelloConPremioPendiente: true,
  conservaSellosAlCambiarPlan: false,
  topeSellosAjusteManual: 5,
  canjeAutomaticoDelPremioGrande: true,
  selloDeBienvenida: false,
};

/** El UUID se fija por archivo para poder volver a parchear el mismo pase. */
const ARCHIVO_SOCIA = new URL('../../credenciales/socia-prueba-h5.json', import.meta.url);

function cargarSocia(): SociaParaWallet {
  try {
    return JSON.parse(readFileSync(ARCHIVO_SOCIA, 'utf8')) as SociaParaWallet;
  } catch {
    console.error(
      'no existe credenciales/socia-prueba-h5.json todavia: corre primero el comando crear',
    );
    process.exit(1);
  }
}

const estadoCon = (sellos: number): Estado => ({ ...estadoInicial(), sellos });

const [comando, argumento, bandera] = process.argv.slice(2);

if (comando === 'crear') {
  const { writeFileSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const socia: SociaParaWallet = {
    id: randomUUID(),
    nombre: argumento ?? 'Socia de prueba H5',
  };
  const resultado = await crearObjeto(entorno, socia, planMensual, estadoInicial());
  console.log('crearObjeto:', resultado.ok ? 'OK' : 'FALLO', resultado.estadoHttp);
  if (resultado.detalle) console.log(resultado.detalle.slice(0, 1500));
  if (!resultado.ok) process.exit(1);
  writeFileSync(ARCHIVO_SOCIA, JSON.stringify(socia, null, 2), 'utf8');
  console.log('objeto:', idDelObjeto(entorno, socia));
  console.log('nombre en el pase:', socia.nombre);
  console.log('guardado en credenciales/socia-prueba-h5.json');
  console.log('\nahora corre: node backend/test/h5-manual.ts link');
} else if (comando === 'link') {
  const socia = cargarSocia();
  const link = await linkDeGuardado(entorno, socia);
  console.log('abre esto en el telefono (largo ' + link.length + '):\n');
  console.log(link);
} else if (comando === 'sellos') {
  const sellos = Number(argumento);
  if (!Number.isInteger(sellos) || sellos < 0 || sellos > planMensual.sellosTotales) {
    console.error('pasa un numero de sellos entre 0 y ' + planMensual.sellosTotales);
    process.exit(1);
  }
  const socia = cargarSocia();
  const notificar = bandera !== '--sin-notificar';
  const resultado = notificar
    ? await actualizarObjeto(entorno, socia, planMensual, estadoCon(sellos))
    : await actualizarSinNotificar(entorno, socia, planMensual, estadoCon(sellos));
  console.log(
    `PATCH a ${sellos} de ${planMensual.sellosTotales}:`,
    resultado.ok ? 'OK' : 'FALLO',
    resultado.estadoHttp,
    notificar ? '| con notifyPreference' : '| SIN notificar',
  );
  if (resultado.detalle) console.log(resultado.detalle.slice(0, 1500));
  if (!resultado.ok) process.exit(1);
  console.log('\nGoogle acepto el cambio. Lo que importa ahora es el telefono:');
  console.log('el pase debe decir "' + sellos + ' de ' + planMensual.sellosTotales + '"');
  if (notificar) console.log('y debe llegar una notificacion sin abrir el Wallet.');
} else if (comando === 'leer') {
  const socia = cargarSocia();
  const { obtenerToken } = await import('../src/wallet.ts');
  const token = await obtenerToken(entorno);
  const id = idDelObjeto(entorno, socia);
  const respuesta = await fetch(
    'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/' +
      encodeURIComponent(id),
    { headers: { authorization: 'Bearer ' + token } },
  );
  const objeto = (await respuesta.json()) as Record<string, any>;
  console.log('GET', respuesta.status);
  console.log('balance:', JSON.stringify(objeto.loyaltyPoints?.balance));
  console.log('hero:', objeto.heroImage?.sourceUri?.uri);
  console.log('barcode:', objeto.barcode?.type, objeto.barcode?.value);
  console.log('texto legible:', objeto.barcode?.alternateText);
  console.log('notifyPreference guardado:', objeto.notifyPreference ?? 'ausente (es transitorio)');
} else {
  console.log('comandos: crear [nombre] | link | sellos <n> [--sin-notificar] | leer');
  process.exit(1);
}
