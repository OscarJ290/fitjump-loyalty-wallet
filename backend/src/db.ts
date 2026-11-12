/**
 * db.ts: todo el SQL del proyecto vive aqui.
 *
 * Dos reglas de forma:
 *
 * 1. **Cada consulta lleva `negocio_id`.** No hay un solo `where id = ...` sin el
 *    negocio al lado, aunque el id sea un UUID y parezca imposible de adivinar. El
 *    aislamiento no depende de que nadie adivine.
 * 2. **`BaseDeDatos` es una interfaz.** La implementacion real habla con Neon por
 *    HTTP; los tests usan una falsa en memoria. Asi la API se prueba completa sin red
 *    y sin ensuciar la base, que importa porque `movimientos` no se puede borrar.
 */
import { neon } from '@neondatabase/serverless';
import type { ConfiguracionPlan, Movimiento, Premio } from './mecanica.ts';

export interface UsuarioPanel {
  id: string;
  negocioId: string;
  nombre: string;
}

/**
 * Una activacion pendiente del panel, desde la migracion 010. **No trae el codigo:**
 * la base solo guarda su SHA-256, igual que con el token de dispositivo.
 */
export interface AltaPendiente extends UsuarioPanel {
  /** Cuando el codigo deja de servir. Quien lo valida es `api.ts`, con su reloj. */
  altaExpira: string;
}

/** Como va el pase de una socia contra Google. El panel lo muestra, nunca lo espera. */
export interface EstadoDeSync {
  estado: 'pendiente' | 'ok' | 'error';
  intentos: number;
  ultimoError: string | null;
  actualizadoEn: string;
}

export interface FilaPlan extends ConfiguracionPlan {
  id: string;
}

/**
 * UNA FILA DE LA LISTA DEL PANEL, y es a proposito mucho mas chica que `FilaSocia`.
 *
 * ⚠️ NO LLEVA WHATSAPP NI NADA QUE NO SE PINTE. La lista puede traer hasta 100 filas y
 * viaja entera al telefono de recepcion: cada campo de mas son 100 campos de mas en el
 * JSON y 100 mas que serializar dentro del presupuesto de 10 ms de CPU del Worker. Lo
 * que la pantalla pinta es nombre, plan y "N de M", y eso es lo que hay aqui.
 *
 * ⚠️ `sellos` y `sellosTotales` SON LOS VALORES GUARDADOS, no reconstruidos del libro.
 * La lista no pasa por `estadoDeSocia` ni por la maquina de estados: para 100 socias eso
 * serian 100 reconstrucciones por cada vez que recepcion abre la pantalla. La ficha, que
 * es una sola socia, si pasa por ahi.
 */
export interface FilaDeLista {
  id: string;
  nombre: string;
  plan: string | null;
  sellos: number;
  sellosTotales: number | null;
  esPrueba: boolean;
}

export interface FilaSocia {
  id: string;
  negocioId: string;
  nombre: string;
  whatsapp: string;
  planId: string | null;
  sellos: number;
  premioPendiente: Premio;
  premioChicoUsadoEnCiclo: boolean;
  /**
   * Columna desde la migracion 007. Antes `api.ts` la fabricaba en false al leer la
   * fila, que era un hueco latente: con `reinicia_al_canjear_grande` en false el premio
   * grande se habria vuelto a otorgar solo.
   */
  premioGrandeUsadoEnCiclo: boolean;
  /** Derivado del libro, no es una columna: evita una migracion y no puede desfasarse. */
  recibioSelloDeBienvenida: boolean;
  objetoWalletId: string | null;
  esPrueba: boolean;
  activa: boolean;
}

export interface FilaMovimiento {
  id: string;
  sociaId: string;
  tipo: Movimiento['tipo'];
  sellosDelta: number;
  monto: number | null;
  creadoEn: string;
  reversado: boolean;
  /**
   * El plan con el que ESTA fila se evalua, desde la migracion 008. No es el plan
   * actual de la socia: si cambio de plan, su historia vieja se evalua con los
   * umbrales de entonces.
   */
  planId: string;
}

export interface EstadoParaGuardar {
  sellos: number;
  premioPendiente: Premio;
  premioChicoUsadoEnCiclo: boolean;
  premioGrandeUsadoEnCiclo: boolean;
}

export interface MovimientoParaGuardar extends Movimiento {
  claveIdempotencia?: string | null;
  movimientoReversadoId?: string | null;
  /** Obligatorio desde la migracion 008: la columna es `not null`. */
  planId: string;
}

export interface BaseDeDatos {
  usuarioPorTokenHash(hash: string): Promise<UsuarioPanel | null>;
  tocarAcceso(usuarioId: string): Promise<void>;

  /**
   * Busca una activacion pendiente por el SHA-256 de su codigo. **No comprueba la
   * caducidad:** eso lo hace `api.ts`, que es quien tiene el reloj inyectado y por lo
   * tanto quien se puede probar con el tiempo congelado.
   */
  usuarioPorAltaHash(hash: string): Promise<AltaPendiente | null>;
  /**
   * Revoca un acceso: borra su token, lo deja inactivo y tira cualquier activacion
   * pendiente. La fila NO se borra, porque el libro contable apunta a ella y no se
   * puede borrar nada que lo firme.
   *
   * **Surte efecto en la siguiente peticion de ese telefono**, porque la busqueda de
   * la cookie exige `activo = true`. Y no toca a los otros dos accesos, que es el
   * motivo de que existan tres y no uno compartido.
   */
  revocarAcceso(usuarioId: string): Promise<void>;
  /**
   * Consume la activacion: guarda el hash del token nuevo, deja la fila activa y borra
   * el codigo. **En una sola sentencia**, para que dos peticiones con el mismo codigo
   * no puedan activar dos veces: la segunda no encuentra `alta_hash` y no afecta
   * ninguna fila.
   *
   * Devuelve false cuando no afecto a nadie, que es justo el caso del codigo ya usado.
   */
  consumirAlta(altaHash: string, tokenHash: string): Promise<boolean>;

  planes(negocioId: string): Promise<FilaPlan[]>;
  planPorId(negocioId: string, planId: string): Promise<FilaPlan | null>;
  planPorNombre(negocioId: string, nombre: string): Promise<FilaPlan | null>;

  sociaPorId(negocioId: string, sociaId: string): Promise<FilaSocia | null>;
  sociaPorWhatsapp(negocioId: string, whatsapp: string): Promise<FilaSocia | null>;
  buscarSocias(negocioId: string, texto: string, limite: number): Promise<FilaSocia[]>;
  /**
   * La lista de socias activas para la pantalla de inicio del panel, en orden
   * alfabetico. Devuelve como mucho `limite` filas y, aparte, **cuantas hay en total**,
   * para que el panel pueda decir cuantas se quedaron fuera.
   *
   * **Es UNA SOLA CONSULTA.** El total sale de `count(*) over ()`, una funcion de
   * ventana que viaja en cada fila del mismo `select`, no de un segundo viaje a la base.
   * Con Neon por HTTP cada consulta es una peticion de red, asi que dos consultas serian
   * dos viajes para pintar una pantalla.
   */
  listaDeSocias(negocioId: string, limite: number): Promise<{ filas: FilaDeLista[]; total: number }>;
  crearSocia(datos: {
    negocioId: string;
    nombre: string;
    whatsapp: string;
    planId: string | null;
  }): Promise<FilaSocia>;
  guardarObjetoWallet(negocioId: string, sociaId: string, objetoId: string): Promise<void>;

  libro(negocioId: string, sociaId: string): Promise<FilaMovimiento[]>;
  movimientoPorId(negocioId: string, movimientoId: string): Promise<FilaMovimiento | null>;
  movimientoPorClave(negocioId: string, clave: string): Promise<FilaMovimiento | null>;

  /**
   * El unico camino de escritura: inserta los movimientos, deja el estado nuevo en
   * `socias` y marca el pase como pendiente de sincronizar, **todo en una
   * transaccion.** Si algo falla, no queda ni medio movimiento.
   */
  registrar(datos: {
    negocioId: string;
    sociaId: string;
    usuarioPanelId: string | null;
    movimientos: MovimientoParaGuardar[];
    estado: EstadoParaGuardar;
    planId?: string;
  }): Promise<void>;

  marcarPendienteDeSync(negocioId: string, sociaId: string): Promise<void>;
  pendientesDeSync(limite: number): Promise<Array<{ negocioId: string; sociaId: string }>>;
  /** Para la ficha del panel: como va el pase de ESTA socia. Nulo si nunca se encolo. */
  syncDeSocia(negocioId: string, sociaId: string): Promise<EstadoDeSync | null>;
  marcarSyncOk(sociaId: string): Promise<void>;
  marcarSyncError(sociaId: string, error: string): Promise<void>;
}

/** Error que la API traduce a un 409, para no duplicar un movimiento repetido. */
export class ClaveRepetida extends Error {
  constructor() {
    super('la clave de idempotencia ya existe');
  }
}

const aPlan = (f: Record<string, any>): FilaPlan => ({
  id: f.id,
  nombre: f.nombre,
  sellosTotales: Number(f.sellos_totales),
  sellosPremioChico: Number(f.sellos_premio_chico),
  montoPremioChico: Number(f.monto_premio_chico),
  montoPremioGrande: Number(f.monto_premio_grande),
  precio: Number(f.precio),
  reiniciaAlCanjearGrande: f.reinicia_al_canjear_grande,
  reiniciaAlCanjearChico: f.reinicia_al_canjear_chico,
  premioChicoBorraSellos: f.premio_chico_borra_sellos,
  sumaSelloConPremioPendiente: f.suma_sello_con_premio_pendiente,
  conservaSellosAlCambiarPlan: f.conserva_sellos_al_cambiar_plan,
  topeSellosAjusteManual: Number(f.tope_sellos_ajuste_manual),
  canjeAutomaticoDelPremioGrande: f.canje_automatico_del_premio_grande,
  selloDeBienvenida: f.sello_de_bienvenida,
});

const aSocia = (f: Record<string, any>): FilaSocia => ({
  id: f.id,
  negocioId: f.negocio_id,
  nombre: f.nombre,
  whatsapp: f.whatsapp,
  planId: f.plan_id,
  sellos: Number(f.sellos_actuales),
  premioPendiente: f.premio_pendiente,
  premioChicoUsadoEnCiclo: f.premio_chico_usado_en_ciclo,
  premioGrandeUsadoEnCiclo: f.premio_grande_usado_en_ciclo,
  recibioSelloDeBienvenida: Boolean(f.recibio_bienvenida),
  objetoWalletId: f.objeto_wallet_id,
  esPrueba: f.es_prueba,
  activa: f.activa,
});

const aMovimiento = (f: Record<string, any>): FilaMovimiento => ({
  id: f.id,
  sociaId: f.socia_id,
  tipo: f.tipo,
  sellosDelta: Number(f.sellos_delta),
  monto: f.monto === null ? null : Number(f.monto),
  creadoEn: typeof f.creado_en === 'string' ? f.creado_en : new Date(f.creado_en).toISOString(),
  reversado: Boolean(f.reversado),
  planId: f.plan_id,
});

export function crearBaseDeDatos(cadena: string): BaseDeDatos {
  const sql = neon(cadena);

  return {
    async usuarioPorTokenHash(hash) {
      const filas = (await sql`
        select id, negocio_id, nombre from usuarios_panel
         where token_hash = ${hash} and activo = true
      `) as Array<Record<string, any>>;
      const f = filas[0];
      return f ? { id: f.id, negocioId: f.negocio_id, nombre: f.nombre } : null;
    },

    async tocarAcceso(usuarioId) {
      await sql`update usuarios_panel set ultimo_acceso = now() where id = ${usuarioId}`;
    },

    async usuarioPorAltaHash(hash) {
      const filas = (await sql`
        select id, negocio_id, nombre, alta_expira from usuarios_panel
         where alta_hash = ${hash}
      `) as Array<Record<string, any>>;
      const f = filas[0];
      if (!f) return null;
      return {
        id: f.id,
        negocioId: f.negocio_id,
        nombre: f.nombre,
        altaExpira:
          typeof f.alta_expira === 'string'
            ? f.alta_expira
            : new Date(f.alta_expira).toISOString(),
      };
    },

    async revocarAcceso(usuarioId) {
      await sql`
        update usuarios_panel
           set token_hash = null, activo = false, alta_hash = null, alta_expira = null
         where id = ${usuarioId}
      `;
    },

    async consumirAlta(altaHash, tokenHash) {
      // El `where alta_hash = ...` es lo que hace esto de un solo uso: la segunda
      // peticion con el mismo codigo no encuentra fila y devuelve cero.
      const filas = (await sql`
        update usuarios_panel
           set token_hash = ${tokenHash},
               activo = true,
               alta_hash = null,
               alta_expira = null,
               ultimo_acceso = now()
         where alta_hash = ${altaHash}
        returning id
      `) as Array<Record<string, any>>;
      return filas.length > 0;
    },

    async planes(negocioId) {
      const filas = (await sql`
        select * from planes where negocio_id = ${negocioId} and activo = true order by precio
      `) as Array<Record<string, any>>;
      return filas.map(aPlan);
    },

    async planPorId(negocioId, planId) {
      const filas = (await sql`
        select * from planes where negocio_id = ${negocioId} and id = ${planId}
      `) as Array<Record<string, any>>;
      return filas[0] ? aPlan(filas[0]) : null;
    },

    async planPorNombre(negocioId, nombre) {
      const filas = (await sql`
        select * from planes where negocio_id = ${negocioId} and nombre = ${nombre}
      `) as Array<Record<string, any>>;
      return filas[0] ? aPlan(filas[0]) : null;
    },

    async sociaPorId(negocioId, sociaId) {
      const filas = (await sql`
        select s.*, exists(
                 select 1 from movimientos m
                  where m.socia_id = s.id and m.negocio_id = s.negocio_id
                    and m.tipo = 'sello_bienvenida'
               ) as recibio_bienvenida
          from socias s
         where s.negocio_id = ${negocioId} and s.id = ${sociaId}
      `) as Array<Record<string, any>>;
      return filas[0] ? aSocia(filas[0]) : null;
    },

    async sociaPorWhatsapp(negocioId, whatsapp) {
      const filas = (await sql`
        select s.*, exists(
                 select 1 from movimientos m
                  where m.socia_id = s.id and m.negocio_id = s.negocio_id
                    and m.tipo = 'sello_bienvenida'
               ) as recibio_bienvenida
          from socias s
         where s.negocio_id = ${negocioId} and s.whatsapp = ${whatsapp}
      `) as Array<Record<string, any>>;
      return filas[0] ? aSocia(filas[0]) : null;
    },

    async buscarSocias(negocioId, texto, limite) {
      const filas = (await sql`
        select s.*, exists(
                 select 1 from movimientos m
                  where m.socia_id = s.id and m.negocio_id = s.negocio_id
                    and m.tipo = 'sello_bienvenida'
               ) as recibio_bienvenida
          from socias s
         where s.negocio_id = ${negocioId}
           and s.activa = true
           and (lower(s.nombre) like ${'%' + texto.toLowerCase() + '%'} or s.whatsapp like ${'%' + texto + '%'})
         order by s.nombre
         limit ${limite}
      `) as Array<Record<string, any>>;
      return filas.map(aSocia);
    },

    async listaDeSocias(negocioId, limite) {
      // `count(*) over ()` cuenta TODAS las filas que pasan el `where`, sin que el
      // `limit` la afecte, y la repite en cada fila. Asi el total y la pagina salen del
      // mismo viaje.
      //
      // ⚠️ `order by lower(nombre)` Y NO `order by nombre`: en el orden por defecto las
      // mayusculas se ordenan antes que las minusculas, asi que "ana" caeria despues de
      // "Zoe". Recepcion busca con el ojo, en orden alfabetico de verdad.
      const filas = (await sql`
        select s.id, s.nombre, s.sellos_actuales, s.es_prueba,
               p.nombre as plan, p.sellos_totales,
               count(*) over () as total
          from socias s left join planes p on p.id = s.plan_id
         where s.negocio_id = ${negocioId}
           and s.activa = true
         order by lower(s.nombre)
         limit ${limite}
      `) as Array<Record<string, any>>;
      // En una variable y no `filas[0]` dentro del objeto: con
      // `noUncheckedIndexedAccess` el indice puede ser `undefined` y el compilador tiene
      // razon, porque con cero filas no hay ventana de donde leer el total.
      const primera = filas[0];
      return {
        filas: filas.map((f) => ({
          id: f.id,
          nombre: f.nombre,
          plan: f.plan ?? null,
          sellos: Number(f.sellos_actuales),
          sellosTotales: f.sellos_totales === null ? null : Number(f.sellos_totales),
          esPrueba: Boolean(f.es_prueba),
        })),
        // Sin filas no hay ventana de donde sacar el total, y cero es la respuesta
        // correcta.
        total: primera === undefined ? 0 : Number(primera.total),
      };
    },

    async crearSocia({ negocioId, nombre, whatsapp, planId }) {
      const filas = (await sql`
        with nueva as (
          insert into socias (negocio_id, nombre, whatsapp, plan_id)
          values (${negocioId}, ${nombre}, ${whatsapp}, ${planId})
          returning *
        )
        select nueva.*, false as recibio_bienvenida from nueva
      `) as Array<Record<string, any>>;
      return aSocia(filas[0]!);
    },

    async guardarObjetoWallet(negocioId, sociaId, objetoId) {
      await sql`
        update socias set objeto_wallet_id = ${objetoId}
         where id = ${sociaId} and negocio_id = ${negocioId}
      `;
    },

    async libro(negocioId, sociaId) {
      const filas = (await sql`
        select m.*, exists(
                 select 1 from movimientos r where r.movimiento_reversado_id = m.id
               ) as reversado
          from movimientos m
         where m.negocio_id = ${negocioId} and m.socia_id = ${sociaId}
         order by m.secuencia
      `) as Array<Record<string, any>>;
      return filas.map(aMovimiento);
    },

    async movimientoPorId(negocioId, movimientoId) {
      const filas = (await sql`
        select m.*, exists(
                 select 1 from movimientos r where r.movimiento_reversado_id = m.id
               ) as reversado
          from movimientos m
         where m.negocio_id = ${negocioId} and m.id = ${movimientoId}
      `) as Array<Record<string, any>>;
      return filas[0] ? aMovimiento(filas[0]) : null;
    },

    async movimientoPorClave(negocioId, clave) {
      const filas = (await sql`
        select m.*, false as reversado from movimientos m
         where m.negocio_id = ${negocioId} and m.clave_idempotencia = ${clave}
      `) as Array<Record<string, any>>;
      return filas[0] ? aMovimiento(filas[0]) : null;
    },

    async registrar({ negocioId, sociaId, usuarioPanelId, movimientos, estado, planId }) {
      const consultas = movimientos.map(
        (m) => sql`
          insert into movimientos
            (negocio_id, socia_id, plan_id, tipo, sellos_delta, monto, usuario_panel_id,
             clave_idempotencia, movimiento_reversado_id, nota)
          values (${negocioId}, ${sociaId}, ${m.planId}, ${m.tipo}, ${m.sellosDelta},
                  ${m.monto ?? null}, ${usuarioPanelId}, ${m.claveIdempotencia ?? null},
                  ${m.movimientoReversadoId ?? null}, ${m.nota ?? null})
        `,
      );

      consultas.push(sql`
        update socias
           set sellos_actuales = ${estado.sellos},
               premio_pendiente = ${estado.premioPendiente},
               premio_chico_usado_en_ciclo = ${estado.premioChicoUsadoEnCiclo},
               premio_grande_usado_en_ciclo = ${estado.premioGrandeUsadoEnCiclo},
               plan_id = coalesce(${planId ?? null}, plan_id)
         where id = ${sociaId} and negocio_id = ${negocioId}
      `);

      consultas.push(sql`
        insert into sync_wallet (negocio_id, socia_id, estado, intentos, actualizado_en)
        values (${negocioId}, ${sociaId}, 'pendiente', 0, now())
        on conflict (socia_id) do update
          set estado = 'pendiente', intentos = 0, ultimo_error = null, actualizado_en = now()
      `);

      try {
        await sql.transaction(consultas);
      } catch (error) {
        const texto = error instanceof Error ? error.message : String(error);
        // 23505 es unique_violation. La unica clave unica en juego aqui es la de
        // idempotencia, asi que esto es el segundo toque del mismo boton.
        if (texto.includes('clave_idempotencia') || texto.includes('23505')) {
          throw new ClaveRepetida();
        }
        throw error;
      }
    },

    async marcarPendienteDeSync(negocioId, sociaId) {
      await sql`
        insert into sync_wallet (negocio_id, socia_id, estado, intentos, actualizado_en)
        values (${negocioId}, ${sociaId}, 'pendiente', 0, now())
        on conflict (socia_id) do update
          set estado = 'pendiente', intentos = 0, ultimo_error = null, actualizado_en = now()
      `;
    },

    async pendientesDeSync(limite) {
      const filas = (await sql`
        select negocio_id, socia_id from sync_wallet
         where estado <> 'ok'
         order by actualizado_en
         limit ${limite}
      `) as Array<Record<string, any>>;
      return filas.map((f) => ({ negocioId: f.negocio_id, sociaId: f.socia_id }));
    },

    async syncDeSocia(negocioId, sociaId) {
      const filas = (await sql`
        select estado, intentos, ultimo_error, actualizado_en from sync_wallet
         where negocio_id = ${negocioId} and socia_id = ${sociaId}
      `) as Array<Record<string, any>>;
      const f = filas[0];
      if (!f) return null;
      return {
        estado: f.estado,
        intentos: Number(f.intentos),
        ultimoError: f.ultimo_error ?? null,
        actualizadoEn:
          typeof f.actualizado_en === 'string'
            ? f.actualizado_en
            : new Date(f.actualizado_en).toISOString(),
      };
    },

    async marcarSyncOk(sociaId) {
      await sql`
        update sync_wallet
           set estado = 'ok', ultimo_error = null, actualizado_en = now()
         where socia_id = ${sociaId}
      `;
    },

    async marcarSyncError(sociaId, error) {
      await sql`
        update sync_wallet
           set estado = 'error', intentos = intentos + 1,
               ultimo_error = ${error.slice(0, 2000)}, actualizado_en = now()
         where socia_id = ${sociaId}
      `;
    },
  };
}
