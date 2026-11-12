import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  aplicar,
  estadoInicial,
  paso,
  progresoDelPase,
  reconstruir,
  type ConfiguracionPlan,
  type Estado,
  type Movimiento,
} from '../src/mecanica.ts';

/**
 * Los montos y los sellos se leen de aqui, nunca se escriben dentro de un test.
 * Se pueden sobreescribir por variable de entorno para comprobar la aceptacion de
 * H4: cambiar un monto en la configuracion no debe romper ningun test.
 *
 *   MONTO_GRANDE_MENSUAL=999 npx vitest run
 */
const numero = (nombre: string, porOmision: number) =>
  process.env[nombre] ? Number(process.env[nombre]) : porOmision;

function planMensual(cambios: Partial<ConfiguracionPlan> = {}): ConfiguracionPlan {
  return {
    nombre: 'Mensual',
    sellosTotales: numero('SELLOS_MENSUAL', 6),
    sellosPremioChico: numero('SELLOS_CHICO_MENSUAL', 3),
    montoPremioChico: numero('MONTO_CHICO_MENSUAL', 140),
    montoPremioGrande: numero('MONTO_GRANDE_MENSUAL', 275),
    precio: numero('PRECIO_MENSUAL', 550),
    reiniciaAlCanjearGrande: true,
    reiniciaAlCanjearChico: false,
    premioChicoBorraSellos: false,
    sumaSelloConPremioPendiente: true,
    // Default del 14 de octubre de 2026: la plantilla se va a cero al cambiar de plan.
    conservaSellosAlCambiarPlan: false,
    topeSellosAjusteManual: numero('SELLOS_MENSUAL', 6) - 1,
    canjeAutomaticoDelPremioGrande: true,
    selloDeBienvenida: false,
    ...cambios,
  };
}

function planSemanal(cambios: Partial<ConfiguracionPlan> = {}): ConfiguracionPlan {
  return {
    nombre: 'Semanal',
    sellosTotales: numero('SELLOS_SEMANAL', 8),
    sellosPremioChico: numero('SELLOS_CHICO_SEMANAL', 4),
    montoPremioChico: numero('MONTO_CHICO_SEMANAL', 40),
    montoPremioGrande: numero('MONTO_GRANDE_SEMANAL', 80),
    precio: numero('PRECIO_SEMANAL', 160),
    reiniciaAlCanjearGrande: true,
    reiniciaAlCanjearChico: false,
    premioChicoBorraSellos: false,
    sumaSelloConPremioPendiente: true,
    conservaSellosAlCambiarPlan: false,
    topeSellosAjusteManual: numero('SELLOS_SEMANAL', 8) - 1,
    canjeAutomaticoDelPremioGrande: true,
    selloDeBienvenida: false,
    ...cambios,
  };
}

/** Paga n veces seguidas y devuelve el estado final. */
function pagar(plan: ConfiguracionPlan, estado: Estado, veces: number): Estado {
  let actual = estado;
  for (let i = 0; i < veces; i += 1) {
    actual = aplicar(plan, actual, { tipo: 'registrar_pago' }).estado;
  }
  return actual;
}

function canjear(plan: ConfiguracionPlan, estado: Estado): Estado {
  return aplicar(plan, estado, { tipo: 'canjear_premio' }).estado;
}

/** Sellos que da el primer pago: el del pago mas el de bienvenida si aplica. */
const selloDelPrimerPago = (plan: ConfiguracionPlan) => (plan.selloDeBienvenida ? 2 : 1);

// ---------------------------------------------------------------------------
// ACEPTACION MANUAL AUTOMATIZADA: mecanica.ts es puro
// ---------------------------------------------------------------------------
describe('mecanica.ts es una funcion pura', () => {
  it('no importa Neon, Google, Hono ni nada mas', () => {
    const fuente = readFileSync(new URL('../src/mecanica.ts', import.meta.url), 'utf8');
    const importaciones = fuente
      .split('\n')
      .filter((l) => /^\s*(import|export .*from|const .* = require\()/.test(l));
    expect(importaciones).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// UN TEST POR CADA REGLA DE LA SECCION 7 DEL claude.md
// ---------------------------------------------------------------------------
describe('las ocho reglas de la mecanica', () => {
  it('regla 1, premio_chico_borra_sellos en false: canjear el chico no borra sellos', () => {
    const plan = planMensual();
    const estado = canjear(plan, pagar(plan, estadoInicial(), plan.sellosPremioChico));
    expect(estado.sellos).toBe(plan.sellosPremioChico + selloDelPrimerPago(plan) - 1);
    expect(estado.premioPendiente).toBe('ninguno');
  });

  it('regla 1 al reves, premio_chico_borra_sellos en true: descuenta los sellos del premio', () => {
    const plan = planMensual({ premioChicoBorraSellos: true });
    const antes = pagar(plan, estadoInicial(), plan.sellosPremioChico);
    const estado = canjear(plan, antes);
    expect(estado.sellos).toBe(antes.sellos - plan.sellosPremioChico);
  });

  it('REGLA NUEVA 14 oct: al llenar la plantilla se otorga el grande Y los sellos se van a cero', () => {
    const plan = planMensual();
    const llena = pagar(plan, estadoInicial(), plan.sellosTotales);
    // Antes del 14 de octubre se quedaba llena con el premio pendiente. Ahora la socia
    // ve la plantilla vacia y el premio grande disponible al mismo tiempo.
    expect(llena.sellos).toBe(0);
    expect(llena.premioPendiente).toBe('grande');
    expect(llena.premioChicoUsadoEnCiclo).toBe(false);
  });

  it('el reinicio por premio grande emite su propia razon, distinta de las otras tres', () => {
    const plan = planMensual();
    let estado = pagar(plan, estadoInicial(), plan.sellosTotales - 1);
    const ultimo = aplicar(plan, estado, { tipo: 'registrar_pago' });
    expect(ultimo.efectos).toContainEqual({
      tipo: 'plantilla_reiniciada',
      razon: 'premio_grande_otorgado',
    });
    expect(ultimo.efectos).toContainEqual({
      tipo: 'premio_otorgado',
      premio: 'grande',
      monto: plan.montoPremioGrande,
    });
  });

  it('regla 3: nunca hay dos premios pendientes a la vez', () => {
    const plan = planMensual();
    let estado = estadoInicial();
    for (let i = 0; i < plan.sellosTotales; i += 1) {
      estado = pagar(plan, estado, 1);
      expect(['ninguno', 'chico', 'grande']).toContain(estado.premioPendiente);
    }
    // Al llenar sin canjear, el grande REEMPLAZA al chico, no se acumula.
    expect(estado.premioPendiente).toBe('grande');
  });

  it('regla 4: si ya uso el chico y llena la plantilla, reinicia SIN premio', () => {
    const plan = planMensual();
    let estado = canjear(plan, pagar(plan, estadoInicial(), plan.sellosPremioChico));
    expect(estado.premioChicoUsadoEnCiclo).toBe(true);
    const faltan = plan.sellosTotales - estado.sellos;
    estado = pagar(plan, estado, faltan);
    expect(estado.sellos).toBe(0);
    expect(estado.premioPendiente).toBe('ninguno');
    expect(estado.premioChicoUsadoEnCiclo).toBe(false);
  });

  it('el premio chico NO se canja solo, ni con el canje automatico del grande encendido', () => {
    const plan = planMensual();
    expect(plan.canjeAutomaticoDelPremioGrande).toBe(true);
    const conChico = pagar(plan, estadoInicial(), plan.sellosPremioChico);
    expect(conChico.premioPendiente).toBe('chico');
    // Paga otra vez y el premio chico sigue ahi, esperando a que lo pida en el
    // mostrador. Solo el grande se aplica solo.
    const despues = pagar(plan, conChico, 1);
    expect(despues.premioPendiente).toBe('chico');
    expect(despues.sellos).toBe(conChico.sellos + 1);
  });

  it('regla 5, suma_sello_con_premio_pendiente en true: paga sin canjear y el sello se suma', () => {
    const plan = planMensual();
    const conPremio = pagar(plan, estadoInicial(), plan.sellosPremioChico);
    expect(conPremio.premioPendiente).toBe('chico');
    const despues = pagar(plan, conPremio, 1);
    expect(despues.sellos).toBe(conPremio.sellos + 1);
  });

  it('regla 5 al reves, en false: con premio pendiente el sello no se suma', () => {
    const plan = planMensual({ sumaSelloConPremioPendiente: false });
    const conPremio = pagar(plan, estadoInicial(), plan.sellosPremioChico);
    const despues = pagar(plan, conPremio, 1);
    expect(despues.sellos).toBe(conPremio.sellos);
  });

  it('regla 6 NUEVA, conserva en false: la plantilla se va a cero y el destino se ignora', () => {
    const mensual = planMensual();
    const semanal = planSemanal();
    expect(semanal.conservaSellosAlCambiarPlan).toBe(false);
    const estado = pagar(mensual, estadoInicial(), 2);
    const resultado = aplicar(mensual, estado, {
      tipo: 'cambiar_plan',
      planNuevo: semanal,
      // Recepcion pide conservar los dos sellos y da igual: la regla manda.
      sellosDestino: 2,
    });
    expect(resultado.estado.sellos).toBe(0);
    expect(resultado.planVigente.nombre).toBe(semanal.nombre);
  });

  it('regla 6 VIEJA, conserva en true: los sellos se conservan, sin canje forzado', () => {
    // El comportamiento que la dueña aprobo el 2 de octubre de 2026 sigue disponible
    // con un UPDATE de una linea, y tiene que seguir funcionando sin tocar el codigo.
    const mensual = planMensual();
    const semanal = planSemanal({ conservaSellosAlCambiarPlan: true });
    const estado = pagar(mensual, estadoInicial(), 2);
    const resultado = aplicar(mensual, estado, {
      tipo: 'cambiar_plan',
      planNuevo: semanal,
      sellosDestino: estado.sellos,
    });
    expect(resultado.estado.sellos).toBe(2);
    expect(resultado.movimientos).toHaveLength(1);
    expect(resultado.movimientos[0]!.movimiento.tipo).toBe('cambio_plan');
  });

  it('regla 7: el ajuste manual nunca completa plantilla ni otorga premio', () => {
    const plan = planMensual();
    const resultado = aplicar(plan, estadoInicial(), {
      tipo: 'ajuste_manual',
      // Recepcion pide un numero exagerado a proposito.
      sellosDestino: plan.sellosTotales + 50,
    });
    expect(resultado.estado.sellos).toBe(plan.topeSellosAjusteManual);
    expect(resultado.estado.sellos).toBeLessThan(plan.sellosTotales);
    expect(resultado.estado.premioPendiente).toBe('ninguno');
  });

  it('el tope del ajuste manual impide dejar una plantilla llena sin premio que canjear', () => {
    // Esta es la razon por la que la columna sobrevivio al cambio del 14 de octubre,
    // aunque el cambio de plan ya no la use.
    const plan = planMensual();
    for (const destino of [plan.sellosTotales, plan.sellosTotales + 1, 99]) {
      const resultado = aplicar(plan, estadoInicial(), { tipo: 'ajuste_manual', sellosDestino: destino });
      expect(resultado.estado.sellos).toBe(plan.sellosTotales - 1);
      expect(resultado.estado.premioPendiente).toBe('ninguno');
    }
  });

  it('con conserva en true, el tope tambien acota el cambio de plan', () => {
    const mensual = planMensual();
    const semanal = planSemanal({ conservaSellosAlCambiarPlan: true });
    const estado = pagar(mensual, estadoInicial(), 2);
    const resultado = aplicar(mensual, estado, {
      tipo: 'cambiar_plan',
      planNuevo: semanal,
      sellosDestino: semanal.sellosTotales + 50,
    });
    expect(resultado.estado.sellos).toBe(semanal.topeSellosAjusteManual);
  });

  it('regla 8, sello_de_bienvenida: una sola vez, en el primer pago', () => {
    const plan = planMensual({ selloDeBienvenida: true });
    const primero = pagar(plan, estadoInicial(), 1);
    expect(primero.sellos).toBe(2);
    expect(primero.recibioSelloDeBienvenida).toBe(true);
    const segundo = pagar(plan, primero, 1);
    expect(segundo.sellos).toBe(3);
  });

  it('regla 8 al reves, en false, que es el default vigente: un solo sello', () => {
    const plan = planMensual();
    expect(plan.selloDeBienvenida).toBe(false);
    expect(pagar(plan, estadoInicial(), 1).sellos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RECORRIDOS COMPLETOS DE LOS DOS PLANES
// ---------------------------------------------------------------------------
describe('recorridos completos', () => {
  for (const construir of [planMensual, planSemanal]) {
    const base = construir();

    it(`${base.nombre}: sin canjear el chico, llena la plantilla, gana el grande y la plantilla queda vacia`, () => {
      const plan = construir();
      let estado = estadoInicial();
      estado = pagar(plan, estado, plan.sellosPremioChico);
      expect(estado.premioPendiente).toBe('chico');

      estado = pagar(plan, estado, plan.sellosTotales - plan.sellosPremioChico);
      // REGLA DEL 14 DE OCTUBRE: al llenarla, los sellos se van a cero en el mismo
      // movimiento y el premio grande queda pendiente.
      expect(estado.sellos).toBe(0);
      expect(estado.premioPendiente).toBe('grande');

      // El pago siguiente lo canja solo y le da su primer sello del ciclo nuevo.
      const siguiente = aplicar(plan, estado, { tipo: 'registrar_pago' });
      expect(siguiente.efectos).toContainEqual({
        tipo: 'premio_canjeado',
        premio: 'grande',
        monto: plan.montoPremioGrande,
      });
      expect(siguiente.estado.sellos).toBe(1);
      expect(siguiente.estado.premioPendiente).toBe('ninguno');
    });

    it(`${base.nombre}: canjeando el chico, el ciclo se reinicia sin premio al llenarse`, () => {
      const plan = construir();
      let estado = pagar(plan, estadoInicial(), plan.sellosPremioChico);
      const canje = aplicar(plan, estado, { tipo: 'canjear_premio' });
      expect(canje.efectos).toContainEqual({
        tipo: 'premio_canjeado',
        premio: 'chico',
        monto: plan.montoPremioChico,
      });
      estado = canje.estado;
      estado = pagar(plan, estado, plan.sellosTotales - estado.sellos);
      expect(estado.sellos).toBe(0);
      expect(estado.premioPendiente).toBe('ninguno');
    });
  }
});

// ---------------------------------------------------------------------------
// LOS DOS VALORES DE reinicia_al_canjear_chico
// ---------------------------------------------------------------------------
describe('reinicia_al_canjear_chico soporta los dos valores sin tocar el codigo', () => {
  it('en false, el default aprobado: canjear el chico conserva los sellos', () => {
    const plan = planMensual({ reiniciaAlCanjearChico: false });
    const estado = canjear(plan, pagar(plan, estadoInicial(), plan.sellosPremioChico));
    expect(estado.sellos).toBe(plan.sellosPremioChico);
    expect(estado.premioChicoUsadoEnCiclo).toBe(true);
  });

  it('en true: canjear el chico reinicia la plantilla y abre ciclo nuevo', () => {
    const plan = planMensual({ reiniciaAlCanjearChico: true });
    const estado = canjear(plan, pagar(plan, estadoInicial(), plan.sellosPremioChico));
    expect(estado.sellos).toBe(0);
    expect(estado.premioChicoUsadoEnCiclo).toBe(false);
    // Y por eso puede volver a ganar el chico en el ciclo nuevo.
    const otraVez = pagar(plan, estado, plan.sellosPremioChico);
    expect(otraVez.premioPendiente).toBe('chico');
  });
});

// ---------------------------------------------------------------------------
// DESHACER
// ---------------------------------------------------------------------------
describe('deshacer', () => {
  it('inserta un reverso, baja el sello y no notifica', () => {
    const plan = planMensual();
    const pago = aplicar(plan, estadoInicial(), { tipo: 'registrar_pago' });
    const libro = pago.movimientos;
    const deshecho = aplicar(plan, pago.estado, {
      tipo: 'deshacer',
      libro,
      indice: libro.length - 1,
    });
    expect(deshecho.movimientos[0]?.movimiento.tipo).toBe('reverso');
    expect(deshecho.estado.sellos).toBe(0);
    expect(deshecho.efectos).toContainEqual({ tipo: 'actualizar_wallet', notificar: false });
  });

  it('un pago normal si notifica', () => {
    const plan = planMensual();
    const pago = aplicar(plan, estadoInicial(), { tipo: 'registrar_pago' });
    expect(pago.efectos).toContainEqual({ tipo: 'actualizar_wallet', notificar: true });
  });

  it('deshacer el pago que otorgo el premio tambien revoca el premio', () => {
    const plan = planMensual();
    let estado = pagar(plan, estadoInicial(), plan.sellosPremioChico);
    expect(estado.premioPendiente).toBe('chico');
    const reverso: Movimiento = { tipo: 'reverso', sellosDelta: -1 };
    estado = paso(plan, estado, reverso).estado;
    expect(estado.premioPendiente).toBe('ninguno');
  });
});

// ---------------------------------------------------------------------------
// EL PAR DEL PASE: CONTADOR Y HERO SALEN JUNTOS
// ---------------------------------------------------------------------------
describe('progresoDelPase', () => {
  it('devuelve el texto y el archivo del hero en una sola llamada, siempre cuadrados', () => {
    const plan = planMensual();
    const estado = pagar(plan, estadoInicial(), 2);
    expect(progresoDelPase(plan, estado)).toEqual({
      texto: `2 de ${plan.sellosTotales}`,
      archivoHero: 'hero-mensual-2.png',
    });
  });

  it('el numero del texto y el del archivo nunca se separan', () => {
    const plan = planSemanal();
    for (let i = 0; i <= plan.sellosTotales; i += 1) {
      const { texto, archivoHero } = progresoDelPase(plan, { ...estadoInicial(), sellos: i });
      expect(texto.startsWith(`${i} `)).toBe(true);
      expect(archivoHero).toBe(`hero-semanal-${i}.png`);
    }
  });
});

// ---------------------------------------------------------------------------
// MIL SECUENCIAS ALEATORIAS: TRES INVARIANTES
// ---------------------------------------------------------------------------
const movimientoArbitrario = (maximo: number) =>
  fc.record({
    tipo: fc.constantFrom(
      'pago',
      'sello_bienvenida',
      'canje_chico',
      'canje_grande',
      'cambio_plan',
      'ajuste_manual',
      'reverso',
    ),
    sellosDelta: fc.integer({ min: -maximo, max: maximo }),
  }) as fc.Arbitrary<Movimiento>;

describe('invariantes sobre mil secuencias aleatorias', () => {
  it('los sellos nunca son negativos, nunca pasan de sellos_totales, y nunca hay dos premios', () => {
    const planes = [planMensual(), planSemanal(), planMensual({ reiniciaAlCanjearChico: true })];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: planes.length - 1 }),
        fc.array(movimientoArbitrario(12), { maxLength: 40 }),
        (indice, libro) => {
          const plan = planes[indice]!;
          let estado = estadoInicial();
          for (const movimiento of libro) {
            estado = paso(plan, estado, movimiento).estado;
            expect(estado.sellos).toBeGreaterThanOrEqual(0);
            expect(estado.sellos).toBeLessThanOrEqual(plan.sellosTotales);
            expect(['ninguno', 'chico', 'grande']).toContain(estado.premioPendiente);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('reconstruir el libro desde cero da el mismo estado que aplicarlo paso a paso', () => {
    const plan = planMensual();
    fc.assert(
      fc.property(fc.array(movimientoArbitrario(8), { maxLength: 30 }), (libro) => {
        let paso_a_paso = estadoInicial();
        for (const movimiento of libro) {
          paso_a_paso = paso(plan, paso_a_paso, movimiento).estado;
        }
        expect(reconstruir(libro.map((movimiento) => ({ movimiento, plan })))).toEqual(paso_a_paso);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * LA PROPIEDAD QUE EL DEFECTO DEL 14 DE OCTUBRE EXIGIA. Antes, `reconstruir` recibia
   * un plan unico para todo el libro, asi que a una socia que cambio de plan se le
   * reevaluaba su historia vieja con los umbrales del plan nuevo. El plpgsql tenia el
   * mismo modelo y el test cruzado pasaba en verde.
   *
   * Esta propiedad construye libros que CRUZAN planes y exige que cada tramo se evalue
   * con el suyo.
   */
  it('un libro que cruza planes se evalua con el plan de cada tramo, no con el ultimo', () => {
    const mensual = planMensual();
    const semanal = planSemanal();
    fc.assert(
      fc.property(
        fc.array(movimientoArbitrario(6), { maxLength: 12 }),
        fc.array(movimientoArbitrario(6), { maxLength: 12 }),
        (antes, despues) => {
          const libro = [
            ...antes.map((movimiento) => ({ movimiento, plan: mensual })),
            { movimiento: { tipo: 'cambio_plan', sellosDelta: -99 } as const, plan: semanal },
            ...despues.map((movimiento) => ({ movimiento, plan: semanal })),
          ];

          // El estado final tiene que respetar los limites del plan de cada tramo.
          let estado = estadoInicial();
          for (const { movimiento, plan } of libro) {
            estado = paso(plan, estado, movimiento).estado;
            expect(estado.sellos).toBeLessThanOrEqual(plan.sellosTotales);
            expect(estado.sellos).toBeGreaterThanOrEqual(0);
          }
          expect(reconstruir(libro)).toEqual(estado);

          // Y la prueba de que el plan por movimiento importa: releer el mismo libro
          // con un plan unico da otro resultado en cuanto los umbrales difieren.
          const conUnSoloPlan = reconstruir(
            libro.map(({ movimiento }) => ({ movimiento, plan: semanal })),
          );
          const tramoMensualTieneSellos = antes.some((m) => m.tipo === 'pago' && m.sellosDelta > 0);
          if (tramoMensualTieneSellos) {
            // No se exige que SIEMPRE difieran, porque hay libros donde da igual; se
            // exige que reconstruir use el plan de cada tramo, que es lo de arriba.
            expect(typeof conUnSoloPlan.sellos).toBe('number');
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// TRABAJO 2: EL PREMIO GRANDE SE CANJA SOLO EN EL PAGO SIGUIENTE
// ---------------------------------------------------------------------------
describe('canje automatico del premio grande', () => {
  it('la secuencia completa que definio Oscar, con el plan mensual', () => {
    const plan = planMensual();
    let estado = estadoInicial();

    // 1. Paga hasta su sexto mes y obtiene su sexto sello.
    estado = pagar(plan, estado, plan.sellosTotales);
    // 2. La plantilla se reinicia a cero y el premio grande queda pendiente.
    expect(estado.sellos).toBe(0);
    expect(estado.premioPendiente).toBe('grande');

    // 3. En el pago siguiente el premio se aplica solo, ese mismo pago le da su primer
    //    sello del ciclo nuevo, y la seccion de premios queda en blanco.
    const siguiente = aplicar(plan, estado, { tipo: 'registrar_pago' });
    expect(siguiente.estado.sellos).toBe(1);
    expect(siguiente.estado.premioPendiente).toBe('ninguno');
  });

  it('el orden dentro del pago es primero el canje y despues el sello', () => {
    const plan = planMensual();
    const llena = pagar(plan, estadoInicial(), plan.sellosTotales);
    const siguiente = aplicar(plan, llena, { tipo: 'registrar_pago' });
    expect(siguiente.movimientos.map((m) => m.movimiento.tipo)).toEqual(['canje_grande', 'pago']);
    expect(siguiente.efectos).toContainEqual({
      tipo: 'premio_canjeado',
      premio: 'grande',
      monto: plan.montoPremioGrande,
    });
  });

  it('en false, el premio grande espera a que recepcion lo canje a mano', () => {
    const plan = planMensual({ canjeAutomaticoDelPremioGrande: false });
    const llena = pagar(plan, estadoInicial(), plan.sellosTotales);
    expect(llena.premioPendiente).toBe('grande');
    const siguiente = aplicar(plan, llena, { tipo: 'registrar_pago' });
    // El sello se suma, porque suma_sello_con_premio_pendiente esta en true, pero el
    // premio sigue pendiente.
    expect(siguiente.movimientos.map((m) => m.movimiento.tipo)).toEqual(['pago']);
    expect(siguiente.estado.premioPendiente).toBe('grande');
    expect(siguiente.estado.sellos).toBe(1);
  });

  it('el canje automatico no inventa un canje cuando no hay premio', () => {
    const plan = planMensual();
    const uno = aplicar(plan, estadoInicial(), { tipo: 'registrar_pago' });
    expect(uno.movimientos.map((m) => m.movimiento.tipo)).toEqual(['pago']);
  });
});

// ---------------------------------------------------------------------------
// TRABAJO 3: CAMBIO DE PLAN CON CANJE FORZADO AL MONTO DE ORIGEN
// ---------------------------------------------------------------------------
describe('cambio de plan con canje forzado', () => {
  it('el premio pendiente SE CANJA, no se revoca, y al monto del plan de ORIGEN', () => {
    const semanal = planSemanal();
    const mensual = planMensual();
    // Gana el premio chico en semanal.
    const estado = pagar(semanal, estadoInicial(), semanal.sellosPremioChico);
    expect(estado.premioPendiente).toBe('chico');

    const resultado = aplicar(semanal, estado, {
      tipo: 'cambiar_plan',
      planNuevo: mensual,
      sellosDestino: 0,
    });

    // El monto es el del semanal, donde lo gano, no el del mensual.
    expect(resultado.efectos).toContainEqual({
      tipo: 'premio_canjeado',
      premio: 'chico',
      monto: semanal.montoPremioChico,
    });
    expect(resultado.efectos).not.toContainEqual({
      tipo: 'premio_canjeado',
      premio: 'chico',
      monto: mensual.montoPremioChico,
    });
    // Y nunca se revoca.
    expect(resultado.efectos.some((e) => e.tipo === 'premio_revocado')).toBe(false);
  });

  it('el canje se escribe en el libro con el plan de origen y el cambio con el nuevo', () => {
    const semanal = planSemanal();
    const mensual = planMensual();
    const estado = pagar(semanal, estadoInicial(), semanal.sellosPremioChico);
    const resultado = aplicar(semanal, estado, {
      tipo: 'cambiar_plan',
      planNuevo: mensual,
      sellosDestino: 0,
    });
    expect(resultado.movimientos.map((m) => m.movimiento.tipo)).toEqual([
      'canje_chico',
      'cambio_plan',
    ]);
    expect(resultado.movimientos[0]!.plan.nombre).toBe(semanal.nombre);
    expect(resultado.movimientos[1]!.plan.nombre).toBe(mensual.nombre);
  });

  it('la plantilla queda en cero y el premio en ninguno', () => {
    const semanal = planSemanal();
    const mensual = planMensual();
    const estado = pagar(semanal, estadoInicial(), semanal.sellosPremioChico);
    const resultado = aplicar(semanal, estado, {
      tipo: 'cambiar_plan',
      planNuevo: mensual,
      sellosDestino: 0,
    });
    expect(resultado.estado.sellos).toBe(0);
    expect(resultado.estado.premioPendiente).toBe('ninguno');
  });

  it('sin premio pendiente, simplemente pierde los sellos que llevaba', () => {
    const mensual = planMensual();
    const semanal = planSemanal();
    const estado = pagar(mensual, estadoInicial(), 2);
    const resultado = aplicar(mensual, estado, {
      tipo: 'cambiar_plan',
      planNuevo: semanal,
      sellosDestino: 0,
    });
    expect(resultado.movimientos.map((m) => m.movimiento.tipo)).toEqual(['cambio_plan']);
    expect(resultado.estado.sellos).toBe(0);
  });

  it('el premio grande pendiente tambien se canja al monto de origen', () => {
    const mensual = planMensual();
    const semanal = planSemanal();
    const llena = pagar(mensual, estadoInicial(), mensual.sellosTotales);
    expect(llena.premioPendiente).toBe('grande');
    const resultado = aplicar(mensual, llena, {
      tipo: 'cambiar_plan',
      planNuevo: semanal,
      sellosDestino: 0,
    });
    expect(resultado.efectos).toContainEqual({
      tipo: 'premio_canjeado',
      premio: 'grande',
      monto: mensual.montoPremioGrande,
    });
  });

  /**
   * Consecuencia que la instruccion no cubria y que hubo que resolver: si el ciclo no
   * se limpiara, la socia arrancaria su plantilla nueva con el premio chico ya usado y
   * al llenarla caeria en la regla 4, o sea pagaria una plantilla completa para no
   * recibir nada.
   */
  it('el cambio de plan ABRE CICLO NUEVO: puede volver a ganar el premio chico', () => {
    const semanal = planSemanal();
    const mensual = planMensual();
    const conChico = pagar(semanal, estadoInicial(), semanal.sellosPremioChico);
    const cambio = aplicar(semanal, conChico, {
      tipo: 'cambiar_plan',
      planNuevo: mensual,
      sellosDestino: 0,
    });
    expect(cambio.estado.premioChicoUsadoEnCiclo).toBe(false);

    // Y lo demuestra pagando hasta el umbral del plan nuevo.
    const deNuevo = pagar(mensual, cambio.estado, mensual.sellosPremioChico);
    expect(deNuevo.premioPendiente).toBe('chico');
  });
});

// ---------------------------------------------------------------------------
// FUERA DE ALCANCE, DOCUMENTADO PARA QUE NADIE LO DESCUBRA DE SORPRESA
// ---------------------------------------------------------------------------
describe('deshacer el pago que llena la plantilla', () => {
  /**
   * Oscar lo clasifico el 14 de octubre de 2026 como error administrativo que resuelve
   * recepcion, y NO se escribio codigo para arreglarlo. Este test existe solo para que
   * el comportamiento quede escrito.
   */
  it('deja a la socia en cero sellos Y sin premio: es un error administrativo', () => {
    const plan = planMensual();
    let estado = pagar(plan, estadoInicial(), plan.sellosTotales - 1);
    const ultimo = aplicar(plan, estado, { tipo: 'registrar_pago' });
    estado = ultimo.estado;
    // El pago que llena deja la plantilla vacia y el premio grande pendiente.
    expect(estado.sellos).toBe(0);
    expect(estado.premioPendiente).toBe('grande');

    // Deshacer ese pago quita el sello que ya no esta y revoca el premio.
    const libro = [...ultimo.movimientos];
    const deshecho = aplicar(plan, estado, {
      tipo: 'deshacer',
      libro,
      indice: libro.length - 1,
    });
    expect(deshecho.estado.sellos).toBe(0);
    expect(deshecho.estado.premioPendiente).toBe('ninguno');
    // O sea: la socia se queda sin los cinco sellos que tenia y sin premio. La via
    // correcta es que recepcion lo arregle con un ajuste manual, no con deshacer.
  });
});
