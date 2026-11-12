/**
 * EL TEST CRUZADO. Es lo unico que avisa cuando las dos implementaciones de la
 * mecanica se separan.
 *
 * `backend\src\mecanica.ts` es la autoridad. `recalcular_simulado` en plpgsql es
 * herramienta de auditoria y reparacion, y nunca se llama en la ruta viva de la API.
 * Pero mientras exista tiene que decir exactamente lo mismo, porque es la funcion a
 * la que uno le va a creer el dia que haya que reparar una socia a mano.
 *
 * No escribe ni una fila: compara contra la funcion pura de SQL, que recibe la
 * configuracion y el libro como argumentos. Eso importa porque `movimientos` tiene
 * triggers que impiden borrar lo que se inserte para probar.
 *
 * Si una regla cambia de forma, se cambia en los dos lenguajes o se borra la version
 * de plpgsql. No hay tercera opcion.
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { porcentajeDelPremio } from '../src/wallet.ts';
import {
  reconstruir,
  type ConfiguracionPlan,
  type Movimiento,
  type MovimientoConPlan,
} from '../src/mecanica.ts';

function cadenaDeConexion(): string | null {
  try {
    const texto = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const linea of texto.split(/\r?\n/)) {
      if (!linea.startsWith('DATABASE_URL=')) continue;
      let valor = linea.slice('DATABASE_URL='.length).trim();
      if (valor.startsWith('"') || valor.startsWith("'")) valor = valor.slice(1, -1);
      return valor;
    }
  } catch {
    return null;
  }
  return null;
}

const cadena = cadenaDeConexion();
const hayBase = Boolean(cadena);

const movimientoArbitrario = fc.record({
  tipo: fc.constantFrom(
    'pago',
    'sello_bienvenida',
    'canje_chico',
    'canje_grande',
    'cambio_plan',
    'ajuste_manual',
    'reverso',
  ),
  sellosDelta: fc.integer({ min: -4, max: 4 }),
}) as fc.Arbitrary<Movimiento>;

/** Planes arbitrarios, no solo los dos de Fit Jump: la mecanica es configuracion. */
const planArbitrario = fc
  .record({
    sellosTotales: fc.integer({ min: 2, max: 12 }),
    corrimiento: fc.integer({ min: 1, max: 11 }),
    reiniciaAlCanjearGrande: fc.boolean(),
    reiniciaAlCanjearChico: fc.boolean(),
    premioChicoBorraSellos: fc.boolean(),
    sumaSelloConPremioPendiente: fc.boolean(),
  })
  .map(({ sellosTotales, corrimiento, ...banderas }): ConfiguracionPlan => {
    // El premio chico siempre cae antes de la plantilla llena, como exige el check de
    // la tabla `planes`.
    const sellosPremioChico = 1 + (corrimiento % (sellosTotales - 1));
    return {
      nombre: 'Arbitrario',
      sellosTotales,
      sellosPremioChico,
      montoPremioChico: 0,
      montoPremioGrande: 0,
      precio: 0,
      conservaSellosAlCambiarPlan: false,
      topeSellosAjusteManual: sellosTotales - 1,
      canjeAutomaticoDelPremioGrande: true,
      selloDeBienvenida: false,
      ...banderas,
    };
  });

/** La forma exacta que `recalcular_simulado` espera en cada elemento del jsonb. */
const aJson = (libro: MovimientoConPlan[]) =>
  libro.map(({ movimiento, plan }) => ({
    tipo: movimiento.tipo,
    delta: movimiento.sellosDelta,
    plan: {
      sellos_totales: plan.sellosTotales,
      sellos_premio_chico: plan.sellosPremioChico,
      reinicia_al_canjear_grande: plan.reiniciaAlCanjearGrande,
      reinicia_al_canjear_chico: plan.reiniciaAlCanjearChico,
      premio_chico_borra_sellos: plan.premioChicoBorraSellos,
      suma_sello_con_premio_pendiente: plan.sumaSelloConPremioPendiente,
      tope_sellos_ajuste_manual: plan.topeSellosAjusteManual,
    },
  }));

describe.skipIf(!hayBase)('mecanica.ts contra recalcular_simulado en plpgsql', () => {
  let sql: ReturnType<typeof neon>;

  beforeAll(() => {
    sql = neon(cadena as string);
  });

  const preguntarAlPlpgsql = async (libro: MovimientoConPlan[]) => {
    const filas = (await sql`
      select * from recalcular_simulado(${JSON.stringify(aJson(libro))}::jsonb)
    `) as Array<{
      sellos_actuales: number;
      premio_pendiente: string;
      premio_chico_usado_en_ciclo: boolean;
      premio_grande_usado_en_ciclo: boolean;
    }>;
    const fila = filas[0]!;
    return {
      sellos: fila.sellos_actuales,
      premioPendiente: fila.premio_pendiente,
      premioChicoUsadoEnCiclo: fila.premio_chico_usado_en_ciclo,
      premioGrandeUsadoEnCiclo: fila.premio_grande_usado_en_ciclo,
    };
  };

  const comoLoVeTypeScript = (libro: MovimientoConPlan[]) => {
    const estado = reconstruir(libro);
    return {
      sellos: estado.sellos,
      premioPendiente: estado.premioPendiente,
      premioChicoUsadoEnCiclo: estado.premioChicoUsadoEnCiclo,
      premioGrandeUsadoEnCiclo: estado.premioGrandeUsadoEnCiclo,
    };
  };

  it('la base responde y la funcion existe con la firma nueva', async () => {
    const plan: ConfiguracionPlan = {
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
    const libro: MovimientoConPlan[] = [1, 1, 1].map((d) => ({
      movimiento: { tipo: 'pago', sellosDelta: d },
      plan,
    }));
    expect(await preguntarAlPlpgsql(libro)).toEqual({
      sellos: 3,
      premioPendiente: 'chico',
      premioChicoUsadoEnCiclo: false,
      premioGrandeUsadoEnCiclo: false,
    });
  });

  it('las dos implementaciones coinciden sobre secuencias aleatorias', async () => {
    await fc.assert(
      fc.asyncProperty(planArbitrario, fc.array(movimientoArbitrario, { maxLength: 14 }),
        async (plan, movimientos) => {
          const libro = movimientos.map((movimiento) => ({ movimiento, plan }));
          expect(await preguntarAlPlpgsql(libro)).toEqual(comoLoVeTypeScript(libro));
        },
      ),
      // Cada corrida es un viaje a Neon por HTTP, asi que son decenas y no miles. Las
      // mil secuencias puras viven en mecanica.test.ts, que no toca la red.
      { numRuns: 50 },
    );
  }, 120_000);

  /**
   * LA PROPIEDAD QUE EL DEFECTO DEL 14 DE OCTUBRE DE 2026 EXIGIA.
   *
   * Antes, `reconstruir` recibia un plan unico para todo el libro y
   * `recalcular_simulado` recibia escalares, asi que los movimientos anteriores a un
   * cambio de plan se reevaluaban con los umbrales del plan nuevo. **Las dos
   * implementaciones estaban equivocadas de la misma forma y este test pasaba en
   * verde.** Con el plan por movimiento, un libro que cruza planes las separa en cuanto
   * una de las dos se desvie.
   */
  it('coinciden tambien cuando el libro CRUZA planes', async () => {
    await fc.assert(
      fc.asyncProperty(
        planArbitrario,
        planArbitrario,
        fc.array(movimientoArbitrario, { maxLength: 8 }),
        fc.array(movimientoArbitrario, { maxLength: 8 }),
        async (primero, segundo, antes, despues) => {
          const libro: MovimientoConPlan[] = [
            ...antes.map((movimiento) => ({ movimiento, plan: primero })),
            { movimiento: { tipo: 'cambio_plan', sellosDelta: -99 }, plan: segundo },
            ...despues.map((movimiento) => ({ movimiento, plan: segundo })),
          ];
          expect(await preguntarAlPlpgsql(libro)).toEqual(comoLoVeTypeScript(libro));
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});

describe.skipIf(!hayBase)('los porcentajes del pase salen de la base', () => {
  it('los cuatro dan 25 y 50 con los valores de hoy', async () => {
    const sql = neon(cadena as string);
    const filas = (await sql`
      select nombre, monto_premio_chico, monto_premio_grande, precio
        from planes
       where negocio_id = '11111111-1111-4111-8111-111111111111'
       order by sellos_totales desc
    `) as Array<{
      nombre: string;
      monto_premio_chico: string;
      monto_premio_grande: string;
      precio: string;
    }>;

    expect(filas.map((f) => f.nombre)).toEqual(['Semanal', 'Mensual']);
    for (const fila of filas) {
      const precio = Number(fila.precio);
      expect(porcentajeDelPremio(Number(fila.monto_premio_chico), precio)).toBe(25);
      expect(porcentajeDelPremio(Number(fila.monto_premio_grande), precio)).toBe(50);
    }
  });
});

/**
 * Guardia contra la peor forma de pasar un test: no haberlo corrido. Si falta
 * `backend\.dev.vars`, todo lo de arriba se salta y esto avisa a gritos en vez de
 * dejar la suite en verde.
 */
describe.skipIf(hayBase)('aviso', () => {
  it('sin backend\.dev.vars el test cruzado no corre', () => {
    console.warn(
      'ATENCION: no hay DATABASE_URL en backend\.dev.vars, asi que el test cruzado contra plpgsql quedo sin correr.',
    );
    expect(hayBase).toBe(false);
  });
});
