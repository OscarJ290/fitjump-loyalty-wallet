/**
 * api.js: todo lo que el panel le pide al Worker, y la idempotencia.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN AQUI:
 *
 * 1. **El panel nunca espera a Google.** La API contesta cuando la fila ya esta en la
 *    base; la sincronizacion con Wallet va despues. Asi que todo lo que esta capa
 *    devuelve es la verdad, aunque el telefono de la socia tarde de uno a dos minutos.
 * 2. **La clave de idempotencia se crea ANTES de mandar y sobrevive al reintento.** Es
 *    lo unico que impide que un dedo impaciente con mala señal meta dos pagos en un
 *    libro que no se puede borrar.
 */

/** El servidor dijo que esta sesion ya no vale. El panel vuelve a la pantalla de alta. */
export class SinSesion extends Error {}

/** No hubo respuesta: puede que si se haya guardado y puede que no. */
export class SinRed extends Error {}

/** El servidor contesto y dijo que no. `datos` trae `error` y a veces `comoSeArregla`. */
export class ErrorDeApi extends Error {
  constructor(datos, estado) {
    super(datos.error || 'Algo salio mal');
    this.datos = datos;
    this.estado = estado;
  }
}

async function pedir(ruta, opciones = {}) {
  let r;
  try {
    r = await fetch(ruta, { credentials: 'same-origin', ...opciones });
  } catch {
    // Aqui no se sabe si el servidor recibio la peticion. Quien llama decide que
    // decirle a recepcion, y gracias a la clave puede reintentar sin duplicar.
    throw new SinRed();
  }
  if (r.status === 401) throw new SinSesion();
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErrorDeApi(datos, r.status);
  return datos;
}

const JSON_ENCABEZADOS = { 'content-type': 'application/json' };

/**
 * Un identificador unico para este intento.
 *
 * `crypto.randomUUID` solo existe en contexto seguro (https o localhost). En el
 * telefono de la dueña siempre lo va a haber, pero durante las pruebas contra una IP
 * de la red local no, y quedarse sin clave es justo quedarse sin la defensa contra el
 * doble toque. Por eso hay respaldo.
 */
function identificador() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CLAVES = 'fitjump.intentos';

function intentos() {
  try {
    return JSON.parse(sessionStorage.getItem(CLAVES) || '{}');
  } catch {
    return {};
  }
}

function guardarIntentos(valor) {
  try {
    sessionStorage.setItem(CLAVES, JSON.stringify(valor));
  } catch {
    // Modo privado o almacenamiento lleno. Sin esto la clave vive en memoria y
    // sobrevive al reintento igual, solo que no a una recarga.
  }
}

/**
 * La clave de un intento. **La misma mientras el servidor no confirme**, asi que el
 * reintento manual, el reintento por mala señal y el segundo toque del boton son la
 * misma operacion y nunca dos.
 *
 * ⚠️ COSTO ACEPTADO: vive en `sessionStorage`, que se vacia al cerrar la pestaña. Si
 * recepcion cierra el panel justo entre el toque y la respuesta, el reintento seria un
 * movimiento nuevo. La ventana es de un segundo y la salida es deshacer, que esta
 * diez minutos disponible. Llevarlo a `localStorage` obligaria a decidir cuando se
 * limpia, y eso es basura permanente a cambio de un segundo.
 */
export function claveDeIntento(nombre) {
  const guardadas = intentos();
  if (!guardadas[nombre]) {
    guardadas[nombre] = identificador();
    guardarIntentos(guardadas);
  }
  return guardadas[nombre];
}

/** Se llama al confirmarse la operacion: el intento siguiente nace con clave nueva. */
export function olvidarIntento(nombre) {
  const guardadas = intentos();
  delete guardadas[nombre];
  guardarIntentos(guardadas);
}

const conClave = (nombre, cuerpo) => ({
  method: 'POST',
  headers: {
    'Idempotency-Key': claveDeIntento(nombre),
    ...(cuerpo ? JSON_ENCABEZADOS : {}),
  },
  ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
});

export const api = {
  activar: (codigo) =>
    pedir('/activar', {
      method: 'POST',
      headers: JSON_ENCABEZADOS,
      body: JSON.stringify({ codigo }),
    }),

  yo: () => pedir('/yo'),
  salir: () => pedir('/salir', { method: 'POST' }),
  planes: () => pedir('/planes'),

  /**
   * La lista de socias activas de la pantalla de inicio. Ruta propia, no `/socias` sin
   * texto: esa sigue devolviendo vacio sin tocar la base, que es lo que impide una
   * consulta por cada letra antes de la segunda.
   */
  lista: () => pedir('/socias-activas'),
  buscar: (texto) => pedir('/socias?q=' + encodeURIComponent(texto)),
  ficha: (sociaId) => pedir('/socias/' + sociaId),

  pago: (sociaId) => pedir('/socias/' + sociaId + '/pago', conClave('pago:' + sociaId)),
  canje: (sociaId) => pedir('/socias/' + sociaId + '/canje', conClave('canje:' + sociaId)),
  cambiarPlan: (sociaId, planId) =>
    pedir('/socias/' + sociaId + '/cambiar-plan', conClave('plan:' + sociaId, { planId })),
  ajuste: (sociaId, sellosDestino) =>
    pedir('/socias/' + sociaId + '/ajuste', conClave('ajuste:' + sociaId, { sellosDestino })),

  // Deshacer no lleva clave: un reverso repetido lo frena el propio servidor, que
  // responde 409 cuando el movimiento ya esta reversado.
  deshacer: (movimientoId) =>
    pedir('/movimientos/' + movimientoId + '/deshacer', { method: 'POST' }),
};

/** $550, $1,100. Sin centavos: ningun monto del programa los tiene. */
export const pesos = (monto) => '$' + Math.round(Number(monto) || 0).toLocaleString('es-MX');
