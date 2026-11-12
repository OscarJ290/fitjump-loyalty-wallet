/**
 * Prueba de humo del panel, fuera del navegador.
 *
 * POR QUE EXISTE: `vite build` solo demuestra que las plantillas COMPILAN. Un `ref` mal
 * escrito, una propiedad que no llega o un `v-for` sobre algo que no es lista revientan
 * al RENDERIZAR, y sin esto la primera vez que el panel se renderiza en la vida seria
 * en el telefono de la dueña.
 *
 * Esto monta los tres componentes de verdad y pide su HTML. No reemplaza la prueba
 * humana (nadie ve si un boton queda debajo del pulgar), pero si evita entregar una
 * pantalla en blanco.
 *
 * Se corre con:  npm run humo
 */
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import App from './src/App.vue';
import Bloqueo from './src/componentes/Bloqueo.vue';
import Buscador from './src/componentes/Buscador.vue';
import Ficha from './src/componentes/Ficha.vue';

const planMensual = {
  id: 'plan-mensual',
  nombre: 'Mensual',
  sellosTotales: 6,
  sellosPremioChico: 3,
  montoPremioChico: 140,
  montoPremioGrande: 275,
  precio: 550,
  topeSellosAjusteManual: 5,
};
const planSemanal = { ...planMensual, id: 'plan-semanal', nombre: 'Semanal', sellosTotales: 8, precio: 160, topeSellosAjusteManual: 7 };

const ficha = {
  socia: {
    id: 'socia-1',
    nombre: 'Maria Lopez',
    whatsapp: '+525512345678',
    plan: { id: 'plan-mensual', nombre: 'Mensual', precio: 550 },
    sellos: 3,
    sellosTotales: 6,
    premioPendiente: 'chico',
    montoDelPremio: 140,
    progreso: { texto: '3 de 6', archivoHero: 'hero-mensual-3.png' },
    esPrueba: false,
  },
  sincronizacion: { estado: 'error', intentos: 2, ultimoError: 'google caido', actualizadoEn: new Date().toISOString() },
  movimientos: [
    { id: 'mov-3', tipo: 'pago', sellosDelta: 1, monto: 550, creadoEn: new Date().toISOString(), sePuedeDeshacer: true },
    { id: 'mov-2', tipo: 'canje_chico', sellosDelta: 0, monto: 140, creadoEn: new Date().toISOString(), sePuedeDeshacer: true },
    { id: 'mov-1', tipo: 'cambio_plan', sellosDelta: -2, monto: null, creadoEn: new Date().toISOString(), sePuedeDeshacer: true },
  ],
};

/** La red no existe aqui: cada componente recibe lo que la API le daria. */
globalThis.fetch = async (ruta) => {
  const cuerpo =
    ruta === '/yo'
      ? { usuario: { id: 'usuario-1', nombre: 'Recepcion B' } }
      : ruta === '/planes'
        ? { planes: [planMensual, planSemanal] }
        : ruta.startsWith('/socias/')
          ? ficha
          : ruta.startsWith('/socias')
            ? { socias: [ficha.socia] }
            : {};
  return new Response(JSON.stringify(cuerpo), { headers: { 'content-type': 'application/json' } });
};

const casos = [
  ['App, antes de saber si hay sesion', App, {}],
  ['Bloqueo, creando el PIN', Bloqueo, { modo: 'crear', nombre: 'Recepcion B' }],
  ['Bloqueo, pidiendo el PIN', Bloqueo, { modo: 'abrir', nombre: 'Recepcion B' }],
  ['Buscador', Buscador, {}],
  ['Ficha, con premio chico y el pase en error', Ficha, { sociaId: 'socia-1', planes: [planMensual, planSemanal] }],
];

let fallos = 0;
for (const [nombre, componente, propiedades] of casos) {
  try {
    const html = await renderToString(createSSRApp(componente, propiedades));
    if (!html || html.length < 20) throw new Error('renderizo vacio');
    console.log(`  ok   ${nombre}  (${html.length} caracteres)`);
  } catch (error) {
    fallos += 1;
    console.log(`  FALLA ${nombre}: ${error.message}`);
  }
}

// Que las frases que el hito exige esten de verdad en la pantalla, no solo en el codigo.
const html = await renderToString(
  createSSRApp(Ficha, { sociaId: 'socia-1', planes: [planMensual, planSemanal] }),
);
const exigidas = [
  ['la espera de uno a dos minutos', /uno a dos minutos/],
  ['el monto del premio en pesos', /\$140/],
  ['el contador contra la meta', /de 6 sellos/],
  // Requisito del Paso 3 de H8. Se quedo a medias hasta el 18 de octubre de 2026: la
  // linea solo salia cuando el pase fallaba, asi que en la prueba del telefono, con
  // todo al dia, no habia nada que ver. Ahora se comprueba que la linea exista.
  [
    'el estado del pase contra Google',
    /El pase de la socia esta al dia|Mandando el cambio al pase|El pase no se ha podido actualizar/,
  ],
  ['sin guiones en el texto visible', null],
];
for (const [que, patron] of exigidas) {
  if (patron === null) continue;
  if (patron.test(html)) console.log(`  ok   ${que}`);
  else {
    fallos += 1;
    console.log(`  FALLA ${que}: no aparece en la ficha renderizada`);
  }
}

// La regla de redaccion, medida sobre el texto que se ve, no sobre el codigo: se quitan
// las etiquetas y se busca un guion entre palabras.
const soloTexto = html.replace(/<[^>]*>/g, ' ');
const guion = /[a-zA-ZáéíóúñÁÉÍÓÚÑ]\s?-\s?[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.exec(soloTexto);
if (guion) {
  fallos += 1;
  console.log(`  FALLA el texto visible lleva un guion: "${guion[0]}"`);
} else {
  console.log('  ok   sin guiones en el texto visible');
}

// Con `--texto` imprime lo que recepcion lee de verdad en la ficha. Sirve para revisar
// la redaccion sin tener que abrir el telefono.
if (process.argv.includes('--texto')) {
  console.log('\nTEXTO QUE SE LEE EN LA FICHA:\n');
  console.log(
    soloTexto
      .replace(/&middot;/g, '.')
      .replace(/&[a-z]+;/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n'),
  );
}

if (fallos) {
  console.log(`\n${fallos} fallos.`);
  process.exit(1);
}
console.log('\nel panel renderiza.');
