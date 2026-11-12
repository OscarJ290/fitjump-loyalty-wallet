/**
 * mecanica.ts: LA AUTORIDAD de la mecanica del programa de sellos.
 *
 * Funcion pura. Sin base de datos, sin red, sin Hono, sin Google, sin imports de
 * nada. Corre sin internet. Recibe estado, configuracion del plan y evento, y
 * devuelve estado nuevo mas la lista de movimientos que hay que escribir en el libro
 * y la lista de efectos.
 *
 * REGLA DURA (13 de octubre de 2026): `recalcular_estado` y `recalcular_simulado` en
 * plpgsql son solo herramienta de auditoria y reparacion, y nunca se llaman en la
 * ruta viva de la API. Si una regla cambia de forma, se cambia en los dos lenguajes o
 * se borra la de plpgsql. El test cruzado de `test/cruce-plpgsql.test.ts` es lo unico
 * que avisa cuando las dos se separan.
 *
 * NINGUN MONTO NI NUMERO DE SELLOS ESTA ESCRITO AQUI. Todo sale de
 * `ConfiguracionPlan`, que es un reflejo de una fila de la tabla `planes`.
 */

export type Premio = 'ninguno' | 'chico' | 'grande';

export type TipoMovimiento =
  | 'pago'
  | 'sello_bienvenida'
  | 'canje_chico'
  | 'canje_grande'
  | 'cambio_plan'
  | 'ajuste_manual'
  | 'reverso';

/** Reflejo de una fila de `planes`. Los nombres siguen a las columnas. */
export interface ConfiguracionPlan {
  nombre: string;
  sellosTotales: number;
  sellosPremioChico: number;
  montoPremioChico: number;
  montoPremioGrande: number;
  precio: number;
  reiniciaAlCanjearGrande: boolean;
  reiniciaAlCanjearChico: boolean;
  premioChicoBorraSellos: boolean;
  sumaSelloConPremioPendiente: boolean;
  /**
   * `false`, el default desde el 14 de octubre de 2026: al cambiar de plan la
   * plantilla se va a cero y el premio pendiente **se canja** al monto del plan de
   * origen. `true`: la regla del 2 de octubre, los sellos se conservan acotados por
   * `topeSellosAjusteManual` y no hay canje forzado.
   *
   * ⚠️ La columna no se borro a proposito: de las reglas del 14 de octubre es la unica
   * que reversa algo que la dueña ya habia aprobado, asi que es la que mas
   * probabilidad tiene de volver atras en la junta. Si vuelve atras, es un `UPDATE` de
   * una linea y no una migracion mas codigo en dos lenguajes.
   */
  conservaSellosAlCambiarPlan: boolean;
  /**
   * Techo del ajuste manual de recepcion: `sellosTotales` menos uno, para que no pueda
   * dejar una plantilla llena sin premio que canjear. Cuando
   * `conservaSellosAlCambiarPlan` esta en `true`, el cambio de plan tambien se acota
   * con este valor, por compatibilidad con la regla vieja.
   */
  topeSellosAjusteManual: number;
  /**
   * `true`: el premio grande pendiente se aplica solo en el siguiente pago, antes de
   * sumar el sello de ese pago. **El premio chico nunca se canja solo:** eso es
   * decision de la socia en el mostrador, con el boton del panel.
   */
  canjeAutomaticoDelPremioGrande: boolean;
  selloDeBienvenida: boolean;
}

/** Una fila del libro contable, sin los campos que pone la base. */
export interface Movimiento {
  tipo: TipoMovimiento;
  sellosDelta: number;
  monto?: number | null;
  nota?: string;
}

export interface Estado {
  sellos: number;
  premioPendiente: Premio;
  premioChicoUsadoEnCiclo: boolean;
  /**
   * Solo importa cuando `reiniciaAlCanjearGrande` es false. Con el reinicio
   * encendido, canjear el grande limpia el ciclo y esta bandera se apaga sola. Sin
   * ella, con el reinicio apagado el premio grande se volveria a otorgar solo,
   * porque la plantilla seguiria llena.
   */
  premioGrandeUsadoEnCiclo: boolean;
  /** Regla 8: el sello de bienvenida se da una sola vez. */
  recibioSelloDeBienvenida: boolean;
}

export type Evento =
  | { tipo: 'registrar_pago' }
  | { tipo: 'canjear_premio' }
  /** Deshacer necesita el libro completo porque su resultado depende de la historia. */
  | { tipo: 'deshacer'; libro: MovimientoConPlan[]; indice: number }
  | { tipo: 'cambiar_plan'; planNuevo: ConfiguracionPlan; sellosDestino: number }
  | { tipo: 'ajuste_manual'; sellosDestino: number };

export type Efecto =
  | { tipo: 'sellos_cambiaron'; de: number; a: number }
  | { tipo: 'premio_otorgado'; premio: Exclude<Premio, 'ninguno'>; monto: number }
  | { tipo: 'premio_canjeado'; premio: Exclude<Premio, 'ninguno'>; monto: number }
  | { tipo: 'premio_revocado'; premio: Exclude<Premio, 'ninguno'> }
  | {
      tipo: 'plantilla_reiniciada';
      razon:
        | 'canje_grande'
        | 'canje_chico'
        | 'regla_cuatro'
        /**
         * Regla del 14 de octubre de 2026: al llenar la plantilla sin haber canjeado
         * el premio chico, los sellos se van a cero en el mismo movimiento y el premio
         * grande queda PENDIENTE. Es el unico reinicio que conserva el premio.
         */
        | 'premio_grande_otorgado';
    }
  | { tipo: 'actualizar_wallet'; notificar: boolean };

/**
 * Un movimiento con el plan con el que hay que evaluarlo.
 *
 * El plan viaja POR MOVIMIENTO y no por libro. Antes del 14 de octubre de 2026,
 * `reconstruir` recibia un solo plan y lo aplicaba a todo el libro, asi que los
 * movimientos anteriores a un cambio de plan se reevaluaban con los umbrales del plan
 * nuevo. El plpgsql tenia el mismo modelo, asi que **el test cruzado pasaba en verde
 * con las dos implementaciones equivocadas de la misma forma.**
 */
export interface MovimientoConPlan {
  movimiento: Movimiento;
  plan: ConfiguracionPlan;
}

export interface Resultado {
  estado: Estado;
  /** Lo que hay que insertar en `movimientos`, en orden, cada uno con su plan. */
  movimientos: MovimientoConPlan[];
  efectos: Efecto[];
  /** El plan que queda vigente. Solo cambia con `cambiar_plan`. */
  planVigente: ConfiguracionPlan;
}

export function estadoInicial(): Estado {
  return {
    sellos: 0,
    premioPendiente: 'ninguno',
    premioChicoUsadoEnCiclo: false,
    premioGrandeUsadoEnCiclo: false,
    recibioSelloDeBienvenida: false,
  };
}

function montoDelPremio(plan: ConfiguracionPlan, premio: Premio): number {
  if (premio === 'chico') return plan.montoPremioChico;
  if (premio === 'grande') return plan.montoPremioGrande;
  return 0;
}

const acotar = (valor: number, minimo: number, maximo: number) =>
  Math.max(minimo, Math.min(valor, maximo));

/**
 * Un solo paso del libro contable: aplica un movimiento a un estado.
 *
 * Esta funcion es el espejo exacto de `recalcular_simulado` en plpgsql. Si una de
 * las dos cambia, la otra tambien, o el test cruzado falla.
 */
export function paso(
  plan: ConfiguracionPlan,
  estado: Estado,
  movimiento: Movimiento,
): { estado: Estado; efectos: Efecto[] } {
  const efectos: Efecto[] = [];
  let sellos = estado.sellos;
  let premio = estado.premioPendiente;
  let chicoUsado = estado.premioChicoUsadoEnCiclo;
  let grandeUsado = estado.premioGrandeUsadoEnCiclo;
  let bienvenida = estado.recibioSelloDeBienvenida;

  /**
   * Borra los sellos y abre un ciclo nuevo, CONSERVANDO el premio pendiente.
   *
   * Las dos operaciones estaban soldadas hasta el 14 de octubre de 2026. La mecanica
   * nueva necesita un reinicio que deje el premio en pie, para que la socia vea la
   * plantilla vacia y el premio grande disponible al mismo tiempo.
   */
  const reiniciarSellos = (razon: Extract<Efecto, { tipo: 'plantilla_reiniciada' }>['razon']) => {
    sellos = 0;
    chicoUsado = false;
    grandeUsado = false;
    efectos.push({ tipo: 'plantilla_reiniciada', razon });
  };

  /** Reinicio completo: borra los sellos y apaga el premio. */
  const reiniciarCiclo = (razon: Extract<Efecto, { tipo: 'plantilla_reiniciada' }>['razon']) => {
    reiniciarSellos(razon);
    premio = 'ninguno';
  };

  switch (movimiento.tipo) {
    case 'pago':
    case 'sello_bienvenida': {
      if (movimiento.tipo === 'sello_bienvenida') bienvenida = true;

      // Regla 5: con premio pendiente, el sello se suma solo si el plan lo permite.
      if (premio === 'ninguno' || plan.sumaSelloConPremioPendiente) {
        // Se acota por los dos lados. El limite de abajo no es decorativo: lo
        // encontro `fast-check` el 13 de octubre de 2026 con una fila de tipo `pago`
        // y delta negativo, que dejaba los sellos en menos uno. La API nunca escribe
        // una fila asi, pero el libro es un dato y una fila mala no debe poder
        // romper el invariante.
        sellos = acotar(sellos + movimiento.sellosDelta, 0, plan.sellosTotales);
      }

      if (sellos >= plan.sellosTotales) {
        if (chicoUsado) {
          // Regla 4: ya uso el premio chico en este ciclo, asi que al llenar la
          // plantilla reinicia SIN premio y empieza un ciclo nuevo. Dejarla
          // congelada en lleno mata el pase visualmente.
          reiniciarCiclo('regla_cuatro');
        } else if (!grandeUsado) {
          // Llenar la plantilla sin haber canjeado el chico otorga el grande, y
          // reemplaza al chico si estaba pendiente: no son acumulables, y nunca hay
          // dos premios pendientes a la vez (regla 3).
          premio = 'grande';
          efectos.push({
            tipo: 'premio_otorgado',
            premio: 'grande',
            monto: plan.montoPremioGrande,
          });
          // REGLA DEL 14 DE OCTUBRE DE 2026: los sellos se van a cero en el MISMO
          // movimiento y el premio queda pendiente. El pase pasa de mostrar el premio
          // chico a mostrar el grande, con la plantilla vacia.
          reiniciarSellos('premio_grande_otorgado');
        }
      } else if (
        premio === 'ninguno' &&
        sellos >= plan.sellosPremioChico &&
        !chicoUsado
      ) {
        premio = 'chico';
        efectos.push({
          tipo: 'premio_otorgado',
          premio: 'chico',
          monto: plan.montoPremioChico,
        });
      }
      break;
    }

    case 'canje_chico': {
      premio = 'ninguno';
      chicoUsado = true;
      efectos.push({
        tipo: 'premio_canjeado',
        premio: 'chico',
        monto: plan.montoPremioChico,
      });
      if (plan.reiniciaAlCanjearChico) {
        reiniciarCiclo('canje_chico');
      } else if (plan.premioChicoBorraSellos) {
        // ⚠️ NOTA PARA QUIEN LEA ESTO EL AÑO QUE VIENE: esta rama queda INALCANZABLE el
        // dia que `reiniciaAlCanjearChico` se ponga en true, porque es un `else if`.
        // Hoy no es el caso: `reiniciaAlCanjearChico` esta en false, asi que la rama se
        // evalua, y lo que pasa es que `premioChicoBorraSellos` tambien esta en false y
        // por eso no hace nada. Las dos banderas estan aprobadas por la dueña y las dos
        // se quedan, con sus tests.
        sellos = Math.max(sellos - plan.sellosPremioChico, 0);
      }
      break;
    }

    case 'canje_grande': {
      premio = 'ninguno';
      grandeUsado = true;
      efectos.push({
        tipo: 'premio_canjeado',
        premio: 'grande',
        monto: plan.montoPremioGrande,
      });
      if (plan.reiniciaAlCanjearGrande) {
        reiniciarCiclo('canje_grande');
      }
      break;
    }

    case 'cambio_plan':
    case 'ajuste_manual': {
      // Regla 7: el ajuste nunca completa plantilla ni otorga premio. El tope sale de
      // la configuracion del plan. `ajuste_manual` se trata igual que `cambio_plan`:
      // confirmado el 13 de octubre de 2026.
      //
      // Con la regla del 14 de octubre, la fila de `cambio_plan` llega aqui con un
      // delta que lleva los sellos a cero, asi que el tope no la afecta. El tope sigue
      // gobernando el ajuste manual de recepcion, y el cambio de plan solo cuando
      // `conservaSellosAlCambiarPlan` esta en true.
      sellos = acotar(sellos + movimiento.sellosDelta, 0, plan.topeSellosAjusteManual);
      // Si el ajuste la deja por debajo de lo que ya tenia ganado, el premio
      // pendiente se revoca, pero nunca se otorga uno nuevo.
      if (premio === 'grande' && sellos < plan.sellosTotales) {
        efectos.push({ tipo: 'premio_revocado', premio: 'grande' });
        premio = 'ninguno';
      }
      if (premio === 'chico' && sellos < plan.sellosPremioChico) {
        efectos.push({ tipo: 'premio_revocado', premio: 'chico' });
        premio = 'ninguno';
      }
      // ⚠️ CONSECUENCIA QUE LA INSTRUCCION DEL 14 DE OCTUBRE NO CUBRIA, resuelta aqui:
      // un cambio de plan que deja la plantilla en cero ABRE UN CICLO NUEVO, asi que
      // las banderas del ciclo se limpian.
      //
      // Sin esto, una socia que canja su premio chico forzado al cambiar de plan
      // arrancaria su plantilla nueva con `chicoUsado` en true, y al llenarla caeria en
      // la regla 4: reinicia SIN premio. O sea pagaria una plantilla completa, ocho
      // semanas, para no recibir nada. Es la misma clase de problema que la regla 4
      // existe para evitar.
      //
      // Solo aplica al cambio de plan, no al ajuste manual de recepcion, y solo cuando
      // la plantilla queda vacia.
      if (movimiento.tipo === 'cambio_plan' && sellos === 0) {
        chicoUsado = false;
        grandeUsado = false;
      }
      break;
    }

    case 'reverso': {
      sellos = acotar(sellos + movimiento.sellosDelta, 0, plan.sellosTotales);
      // Deshacer solo puede quitar premios, nunca otorgarlos. Si cae por debajo del
      // umbral del grande pero sigue arriba del chico, y no habia canjeado el chico,
      // el estado correcto es el chico pendiente.
      if (premio === 'grande' && sellos < plan.sellosTotales) {
        efectos.push({ tipo: 'premio_revocado', premio: 'grande' });
        premio = sellos >= plan.sellosPremioChico && !chicoUsado ? 'chico' : 'ninguno';
      } else if (premio === 'chico' && sellos < plan.sellosPremioChico) {
        efectos.push({ tipo: 'premio_revocado', premio: 'chico' });
        premio = 'ninguno';
      }
      break;
    }
  }

  if (sellos !== estado.sellos) {
    efectos.unshift({ tipo: 'sellos_cambiaron', de: estado.sellos, a: sellos });
  }

  return {
    estado: {
      sellos,
      premioPendiente: premio,
      premioChicoUsadoEnCiclo: chicoUsado,
      premioGrandeUsadoEnCiclo: grandeUsado,
      recibioSelloDeBienvenida: bienvenida,
    },
    efectos,
  };
}

/**
 * Red de seguridad en TypeScript: reconstruye el estado releyendo el libro desde
 * cero. Es lo que el test cruzado compara contra `recalcular_simulado`.
 *
 * **Cada movimiento trae su propio plan.** Antes del 14 de octubre de 2026 esta
 * funcion recibia un plan unico y lo aplicaba a todo el libro, asi que a una socia que
 * cambio de plan se le reevaluaba su historia vieja con los umbrales del plan nuevo.
 * El plpgsql tenia el mismo modelo y por eso el test cruzado no lo veia.
 */
export function reconstruir(libro: MovimientoConPlan[]): Estado {
  let estado = estadoInicial();
  for (const { movimiento, plan } of libro) {
    estado = paso(plan, estado, movimiento).estado;
  }
  return estado;
}

/**
 * La puerta que usa la API. Traduce un evento del mostrador a movimientos del libro
 * y devuelve el estado nuevo.
 */
export function aplicar(
  plan: ConfiguracionPlan,
  estado: Estado,
  evento: Evento,
): Resultado {
  let planVigente = plan;
  // Cada movimiento se guarda con el plan con el que hay que evaluarlo. En un cambio
  // de plan, el canje forzado se evalua con el plan de ORIGEN y la fila del cambio con
  // el plan NUEVO, asi que no se puede aplicar un solo plan a todo el lote.
  const movimientos: MovimientoConPlan[] = [];
  const agregar = (movimiento: Movimiento, conPlan: ConfiguracionPlan = plan) =>
    movimientos.push({ movimiento, plan: conPlan });

  switch (evento.tipo) {
    case 'registrar_pago': {
      // Regla 8: el sello de bienvenida se da una sola vez, en el primer pago, y es
      // un sello ADICIONAL al del pago.
      if (plan.selloDeBienvenida && !estado.recibioSelloDeBienvenida) {
        agregar({
          tipo: 'sello_bienvenida',
          sellosDelta: 1,
          monto: null,
          nota: 'sello de bienvenida, una sola vez',
        });
      }

      // TRABAJO 2 del 14 de octubre de 2026: el premio grande pendiente se canja solo,
      // ANTES de sumar el sello de este pago. El estado resultante es un sello y
      // ningun premio pendiente. El premio chico NO se canja solo: eso sigue siendo
      // decision de la socia en el mostrador.
      if (plan.canjeAutomaticoDelPremioGrande && estado.premioPendiente === 'grande') {
        agregar({
          tipo: 'canje_grande',
          sellosDelta: 0,
          monto: plan.montoPremioGrande,
          nota: 'canje automatico del premio grande en el pago siguiente',
        });
      }

      agregar({ tipo: 'pago', sellosDelta: 1, monto: plan.precio });
      break;
    }

    case 'canjear_premio': {
      if (estado.premioPendiente === 'ninguno') {
        throw new Error('no hay premio pendiente que canjear');
      }
      agregar({
        tipo: estado.premioPendiente === 'chico' ? 'canje_chico' : 'canje_grande',
        sellosDelta: 0,
        monto: montoDelPremio(plan, estado.premioPendiente),
      });
      break;
    }

    case 'deshacer': {
      const original = evento.libro[evento.indice];
      if (!original) {
        throw new Error('el movimiento que se quiere deshacer no existe en el libro');
      }
      if (original.movimiento.tipo === 'reverso') {
        throw new Error('un reverso no se deshace: se deshace el movimiento original');
      }
      // El reverso se evalua con el plan del movimiento que reversa, no con el plan
      // actual de la socia: si entre medias cambio de plan, los umbrales que aplican
      // son los de entonces.
      agregar(
        {
          tipo: 'reverso',
          sellosDelta: -original.movimiento.sellosDelta,
          monto: original.movimiento.monto == null ? null : -original.movimiento.monto,
          nota: 'reverso de ' + original.movimiento.tipo,
        },
        original.plan,
      );
      break;
    }

    case 'cambiar_plan': {
      planVigente = evento.planNuevo;

      if (planVigente.conservaSellosAlCambiarPlan) {
        // REGLA VIEJA, la que aprobo la dueña el 2 de octubre de 2026 y que sigue
        // disponible con un `UPDATE` de una linea: los sellos se conservan, ajustados
        // a mano por recepcion y acotados por el tope. Sin canje forzado.
        agregar(
          {
            tipo: 'cambio_plan',
            sellosDelta: evento.sellosDestino - estado.sellos,
            monto: null,
            nota: 'cambio al plan ' + planVigente.nombre,
          },
          planVigente,
        );
        break;
      }

      // TRABAJO 3, REGLA DEL 14 DE OCTUBRE DE 2026: la plantilla SIEMPRE se va a cero.
      // Si hay un premio pendiente, se CANJA, no se revoca, y el monto es el del plan
      // de ORIGEN. Por eso el canje se emite primero y se evalua con `plan`, el
      // anterior, mientras la fila del cambio se evalua con `planVigente`, el nuevo.
      if (estado.premioPendiente !== 'ninguno') {
        agregar(
          {
            tipo: estado.premioPendiente === 'chico' ? 'canje_chico' : 'canje_grande',
            sellosDelta: 0,
            monto: montoDelPremio(plan, estado.premioPendiente),
            nota: 'canje forzado al cambiar de plan, al monto del plan ' + plan.nombre,
          },
          plan,
        );
      }

      // El delta se calcula contra los sellos que queden DESPUES del canje: si el canje
      // reinicio la plantilla, ya no hay nada que llevar a cero. Se aplica el canje
      // sobre el estado actual, no desde cero: `reconstruir` empieza en el estado
      // inicial y aqui la socia ya tiene historia.
      const sellosTrasElCanje = movimientos.reduce(
        (parcial, { movimiento, plan: planDelMovimiento }) =>
          paso(planDelMovimiento, parcial, movimiento).estado,
        estado,
      ).sellos;

      agregar(
        {
          tipo: 'cambio_plan',
          sellosDelta: -sellosTrasElCanje,
          monto: null,
          nota: 'cambio al plan ' + planVigente.nombre + ', plantilla a cero',
        },
        planVigente,
      );
      break;
    }

    case 'ajuste_manual': {
      agregar({
        tipo: 'ajuste_manual',
        sellosDelta: evento.sellosDestino - estado.sellos,
        monto: null,
      });
      break;
    }
  }

  let estadoNuevo = estado;
  const efectos: Efecto[] = [];
  // Cada movimiento se aplica CON SU PROPIO PLAN, no con el vigente al final.
  for (const { movimiento, plan: planDelMovimiento } of movimientos) {
    const resultado = paso(planDelMovimiento, estadoNuevo, movimiento);
    estadoNuevo = resultado.estado;
    efectos.push(...resultado.efectos);
  }

  // Deshacer actualiza el pase SIN notificar, para no gastar el cupo de 3
  // notificaciones por pase en 24 horas con una correccion.
  efectos.push({ tipo: 'actualizar_wallet', notificar: evento.tipo !== 'deshacer' });

  return { estado: estadoNuevo, movimientos, efectos, planVigente };
}

/**
 * El numero de sellos vive en dos lugares del pase: el texto del contador y el
 * nombre del archivo del hero. LOS DOS SALEN DE AQUI, juntos, nunca por separado.
 *
 * El 13 de octubre de 2026 el pase de prueba quedo mostrando "2 de 6" sobre
 * `hero-mensual-0.png`, porque el Worker de H2 parcheaba solo el contador. Esta
 * funcion existe para que eso no pueda volver a pasar: quien actualiza el pase pide
 * el par completo.
 */
export function progresoDelPase(
  plan: ConfiguracionPlan,
  estado: Estado,
): { texto: string; archivoHero: string } {
  return {
    texto: `${estado.sellos} de ${plan.sellosTotales}`,
    archivoHero: `hero-${plan.nombre.toLowerCase()}-${estado.sellos}.png`,
  };
}
