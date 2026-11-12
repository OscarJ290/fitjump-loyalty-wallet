/**
 * Tests de la API. Usan una base falsa en memoria que implementa la misma interfaz
 * que la de Neon, y un cliente de Wallet falso.
 *
 * Por que falsa y no la real: `movimientos` tiene triggers que impiden borrar, asi que
 * cada corrida contra Neon dejaria basura imborrable. El aislamiento multi tenant, que
 * es la aceptacion automatica de H6, si se prueba contra la base real, en
 * `aislamiento.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  crearApp,
  dependenciasDeEntorno,
  normalizarWhatsapp,
  reintentarPendientes,
  sha256Hex,
  tokenDeDispositivo,
  type ClienteWallet,
  type Dependencias,
} from '../src/api.ts';
import type {
  BaseDeDatos,
  EstadoParaGuardar,
  FilaMovimiento,
  FilaPlan,
  FilaSocia,
  MovimientoParaGuardar,
  UsuarioPanel,
} from '../src/db.ts';
import { ClaveRepetida } from '../src/db.ts';

/** Lee el JSON de una respuesta. `Response.json()` no acepta parametro de tipo. */
const leer = async (r: Response): Promise<any> => r.json();


const NEGOCIO = 'negocio-1';
const OTRO_NEGOCIO = 'negocio-2';
const TOKEN = 'token-de-prueba-de-32-bytes-aaaa';
const TOKEN_OTRO = 'token-de-otro-negocio-bbbbbbbbbb';
/** El codigo de activacion de un solo uso que lleva el enlace. No es el token. */
const CODIGO = 'codigo-de-activacion-de-prueba-1';

const planMensual: FilaPlan = {
  id: 'plan-mensual',
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

const planSemanal: FilaPlan = {
  ...planMensual,
  id: 'plan-semanal',
  nombre: 'Semanal',
  sellosTotales: 8,
  sellosPremioChico: 4,
  montoPremioChico: 40,
  montoPremioGrande: 80,
  precio: 160,
  topeSellosAjusteManual: 7,
};

interface FilaLibro extends FilaMovimiento {
  negocioId: string;
  clave: string | null;
  reversaA: string | null;
}

/** Una socia recien creada, con las banderas del ciclo apagadas. */
const sociaVacia = (
  id: string,
  datos: { negocioId: string; nombre: string; whatsapp: string; planId: string | null },
): FilaSocia => ({
  id,
  negocioId: datos.negocioId,
  nombre: datos.nombre,
  whatsapp: datos.whatsapp,
  planId: datos.planId,
  sellos: 0,
  premioPendiente: 'ninguno',
  premioChicoUsadoEnCiclo: false,
  premioGrandeUsadoEnCiclo: false,
  recibioSelloDeBienvenida: false,
  objetoWalletId: null,
  esPrueba: false,
  activa: true,
});

/**
 * Una fila de `usuarios_panel` como quedo desde la migracion 010: el token puede ser
 * nulo (la fila nace sin el), y puede haber una activacion pendiente.
 */
interface FilaUsuario extends UsuarioPanel {
  hash: string | null;
  activo: boolean;
  altaHash: string | null;
  altaExpira: string | null;
}

class BaseFalsa implements BaseDeDatos {
  usuarios: FilaUsuario[] = [];
  planesPorNegocio: Record<string, FilaPlan[]> = {};
  socias: FilaSocia[] = [];
  movimientos: FilaLibro[] = [];
  sync: Record<string, { negocioId: string; estado: string; intentos: number; error?: string }> = {};
  secuencia = 0;
  reloj = new Date('2026-10-13T18:00:00.000Z');

  /** La real exige `activo = true`, asi que la falsa tambien, o no probaria nada. */
  async usuarioPorTokenHash(hash: string) {
    const u = this.usuarios.find((x) => x.hash !== null && x.hash === hash && x.activo);
    return u ? { id: u.id, negocioId: u.negocioId, nombre: u.nombre } : null;
  }
  accesosAnotados = 0;
  async tocarAcceso() {
    this.accesosAnotados += 1;
  }
  async usuarioPorAltaHash(hash: string) {
    const u = this.usuarios.find((x) => x.altaHash !== null && x.altaHash === hash);
    if (!u || !u.altaExpira) return null;
    return { id: u.id, negocioId: u.negocioId, nombre: u.nombre, altaExpira: u.altaExpira };
  }
  /** Imita el `update ... where alta_hash = ...` de la base: de un solo uso. */
  async consumirAlta(altaHash: string, tokenHash: string) {
    const u = this.usuarios.find((x) => x.altaHash !== null && x.altaHash === altaHash);
    if (!u) return false;
    u.hash = tokenHash;
    u.activo = true;
    u.altaHash = null;
    u.altaExpira = null;
    return true;
  }
  async revocarAcceso(usuarioId: string) {
    const u = this.usuarios.find((x) => x.id === usuarioId);
    if (u) {
      u.hash = null;
      u.activo = false;
      u.altaHash = null;
      u.altaExpira = null;
    }
  }
  async planes(negocioId: string) {
    return this.planesPorNegocio[negocioId] ?? [];
  }
  async planPorId(negocioId: string, planId: string) {
    return (this.planesPorNegocio[negocioId] ?? []).find((p) => p.id === planId) ?? null;
  }
  async planPorNombre(negocioId: string, nombre: string) {
    return (this.planesPorNegocio[negocioId] ?? []).find((p) => p.nombre === nombre) ?? null;
  }
  /** Aqui vive el aislamiento: ninguna lectura encuentra nada de otro negocio. */
  async sociaPorId(negocioId: string, sociaId: string) {
    const s = this.socias.find((x) => x.id === sociaId && x.negocioId === negocioId);
    return s ? { ...s, recibioSelloDeBienvenida: this.tuvoBienvenida(s.id) } : null;
  }
  async sociaPorWhatsapp(negocioId: string, whatsapp: string) {
    const s = this.socias.find((x) => x.whatsapp === whatsapp && x.negocioId === negocioId);
    return s ? { ...s } : null;
  }
  async buscarSocias(negocioId: string, texto: string) {
    return this.socias.filter(
      (x) => x.negocioId === negocioId && x.nombre.toLowerCase().includes(texto.toLowerCase()),
    );
  }
  /**
   * Imita a `listaDeSocias`: solo las activas del negocio, en orden alfabetico sin
   * distinguir mayusculas, acotada por el limite, y el total SIN acotar.
   */
  async listaDeSocias(negocioId: string, limite: number) {
    const todas = this.socias
      .filter((x) => x.negocioId === negocioId && x.activa !== false)
      .sort((a, b) => a.nombre.toLowerCase().localeCompare(b.nombre.toLowerCase()));
    const planes = this.planesPorNegocio[negocioId] ?? [];
    return {
      filas: todas.slice(0, limite).map((s) => {
        const plan = planes.find((p) => p.id === s.planId) ?? null;
        return {
          id: s.id,
          nombre: s.nombre,
          plan: plan ? plan.nombre : null,
          sellos: s.sellos,
          sellosTotales: plan ? plan.sellosTotales : null,
          esPrueba: Boolean(s.esPrueba),
        };
      }),
      total: todas.length,
    };
  }
  async crearSocia(datos: { negocioId: string; nombre: string; whatsapp: string; planId: string | null }) {
    const socia = sociaVacia('socia-' + (this.socias.length + 1), datos);
    this.socias.push(socia);
    return { ...socia };
  }
  async guardarObjetoWallet(negocioId: string, sociaId: string, objetoId: string) {
    const s = this.socias.find((x) => x.id === sociaId && x.negocioId === negocioId);
    if (s) s.objetoWalletId = objetoId;
  }
  tuvoBienvenida(sociaId: string) {
    return this.movimientos.some((m) => m.sociaId === sociaId && m.tipo === 'sello_bienvenida');
  }
  async libro(negocioId: string, sociaId: string) {
    return this.movimientos
      .filter((m) => m.negocioId === negocioId && m.sociaId === sociaId)
      .map((m) => ({ ...m, reversado: this.movimientos.some((r) => r.reversaA === m.id) }));
  }
  async movimientoPorId(negocioId: string, id: string) {
    const m = this.movimientos.find((x) => x.id === id && x.negocioId === negocioId);
    return m ? { ...m, reversado: this.movimientos.some((r) => r.reversaA === m.id) } : null;
  }
  async movimientoPorClave(negocioId: string, clave: string) {
    const m = this.movimientos.find((x) => x.negocioId === negocioId && x.clave === clave);
    return m ? { ...m } : null;
  }
  async registrar(datos: {
    negocioId: string;
    sociaId: string;
    usuarioPanelId: string | null;
    movimientos: MovimientoParaGuardar[];
    estado: EstadoParaGuardar;
    planId?: string;
  }) {
    // La restriccion unica de la base, imitada: dos peticiones con la misma clave no
    // pueden insertar las dos.
    for (const m of datos.movimientos) {
      if (m.claveIdempotencia && this.movimientos.some((x) => x.clave === m.claveIdempotencia)) {
        throw new ClaveRepetida();
      }
    }
    for (const m of datos.movimientos) {
      this.secuencia += 1;
      this.movimientos.push({
        id: 'mov-' + this.secuencia,
        negocioId: datos.negocioId,
        sociaId: datos.sociaId,
        tipo: m.tipo,
        sellosDelta: m.sellosDelta,
        monto: m.monto ?? null,
        creadoEn: this.reloj.toISOString(),
        reversado: false,
        // La columna es `not null` en la base desde la migracion 008: cada fila dice
        // con que plan se evalua.
        planId: m.planId,
        clave: m.claveIdempotencia ?? null,
        reversaA: m.movimientoReversadoId ?? null,
      });
    }
    const s = this.socias.find((x) => x.id === datos.sociaId && x.negocioId === datos.negocioId);
    if (s) {
      s.sellos = datos.estado.sellos;
      s.premioPendiente = datos.estado.premioPendiente;
      s.premioChicoUsadoEnCiclo = datos.estado.premioChicoUsadoEnCiclo;
      s.premioGrandeUsadoEnCiclo = datos.estado.premioGrandeUsadoEnCiclo;
      if (datos.planId) s.planId = datos.planId;
    }
    this.sync[datos.sociaId] = { negocioId: datos.negocioId, estado: 'pendiente', intentos: 0 };
  }
  async marcarPendienteDeSync(negocioId: string, sociaId: string) {
    this.sync[sociaId] = { negocioId, estado: 'pendiente', intentos: 0 };
  }
  async pendientesDeSync(limite: number) {
    return Object.entries(this.sync)
      .filter(([, v]) => v.estado !== 'ok')
      .slice(0, limite)
      .map(([sociaId, v]) => ({ negocioId: v.negocioId, sociaId }));
  }
  async syncDeSocia(negocioId: string, sociaId: string) {
    const fila = this.sync[sociaId];
    if (!fila || fila.negocioId !== negocioId) return null;
    return {
      estado: fila.estado as 'pendiente' | 'ok' | 'error',
      intentos: fila.intentos,
      ultimoError: fila.error ?? null,
      actualizadoEn: this.reloj.toISOString(),
    };
  }
  async marcarSyncOk(sociaId: string) {
    const fila = this.sync[sociaId];
    if (fila) fila.estado = 'ok';
  }
  async marcarSyncError(sociaId: string, error: string) {
    const fila = this.sync[sociaId];
    if (fila) {
      fila.estado = 'error';
      fila.intentos += 1;
      fila.error = error;
    }
  }
}

class WalletFalso implements ClienteWallet {
  creados: string[] = [];
  actualizaciones: Array<{ socia: string; sellos: number; notificar: boolean }> = [];
  fallar = false;
  /** Cuando esta puesta, Google "tarda" hasta que el test la suelte. */
  tranca: Promise<void> | null = null;
  soltarTranca: (() => void) | null = null;

  trancar() {
    this.tranca = new Promise((listo) => {
      this.soltarTranca = listo as () => void;
    });
  }

  async crear(socia: FilaSocia) {
    if (this.tranca) await this.tranca;
    if (this.fallar) return { ok: false, detalle: 'google caido' };
    this.creados.push(socia.id);
    return { ok: true };
  }
  async actualizar(socia: FilaSocia, _plan: any, estado: any, notificar: boolean) {
    if (this.tranca) await this.tranca;
    if (this.fallar) return { ok: false, detalle: 'google caido' };
    this.actualizaciones.push({ socia: socia.id, sellos: estado.sellos, notificar });
    return { ok: true };
  }
  async link(socia: FilaSocia) {
    return 'https://pay.google.com/gp/v/save/jwt-falso-' + socia.id;
  }
  idObjeto(socia: FilaSocia) {
    return '3388000000023195590.' + socia.id;
  }
}

let db: BaseFalsa;
let wallet: WalletFalso;
let app: ReturnType<typeof crearApp>;
let deps: Dependencias;
const enEspera: Array<Promise<unknown>> = [];

async function montar() {
  db = new BaseFalsa();
  wallet = new WalletFalso();
  db.planesPorNegocio[NEGOCIO] = [planMensual, planSemanal];
  db.planesPorNegocio[OTRO_NEGOCIO] = [{ ...planMensual, id: 'plan-otro' }];
  db.usuarios.push({
    id: 'usuario-1',
    negocioId: NEGOCIO,
    nombre: 'Oscar',
    hash: await sha256Hex(TOKEN),
    activo: true,
    altaHash: null,
    altaExpira: null,
  });
  db.usuarios.push({
    id: 'usuario-2',
    negocioId: OTRO_NEGOCIO,
    nombre: 'Ajeno',
    hash: await sha256Hex(TOKEN_OTRO),
    activo: true,
    altaHash: null,
    altaExpira: null,
  });
  // La tercera nace como nacieron las tres de la migracion 003: sin token, inactiva y
  // con una activacion pendiente que caduca en treinta minutos.
  db.usuarios.push({
    id: 'usuario-3',
    negocioId: NEGOCIO,
    nombre: 'Recepcion B',
    hash: null,
    activo: false,
    altaHash: await sha256Hex(CODIGO),
    altaExpira: new Date(db.reloj.getTime() + 30 * 60_000).toISOString(),
  });
  enEspera.length = 0;
  deps = {
    db,
    wallet,
    negocioPublico: NEGOCIO,
    ahora: () => db.reloj,
    enSegundoPlano: (tarea) => {
      enEspera.push(tarea);
    },
  };
  app = crearApp(deps);
}

/** Espera las tareas que en produccion irian en ctx.waitUntil. */
const terminarSegundoPlano = () => Promise.all(enEspera.splice(0));

const conSesion = (token = TOKEN) => ({ cookie: 'sesion=' + token });

const pedir = (ruta: string, opciones: RequestInit = {}) =>
  app.request('http://local' + ruta, opciones);

async function altaDeSocia(nombre = 'Maria Lopez', whatsapp = '5512345678', plan = 'Mensual') {
  const r = await pedir('/alta', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre, whatsapp, plan }),
  });
  return { respuesta: r, cuerpo: await leer(r) };
}

beforeEach(montar);

describe('normalizarWhatsapp', () => {
  it('acepta lo que la gente escribe de verdad', () => {
    expect(normalizarWhatsapp('5512345678')).toBe('+525512345678');
    expect(normalizarWhatsapp('55 1234 5678')).toBe('+525512345678');
    expect(normalizarWhatsapp('(55) 1234-5678')).toBe('+525512345678');
    expect(normalizarWhatsapp('+52 55 1234 5678')).toBe('+525512345678');
    expect(normalizarWhatsapp('521 55 1234 5678')).toBe('+525512345678');
  });

  it('rechaza lo que no es un celular mexicano de diez digitos', () => {
    expect(normalizarWhatsapp('12345')).toBeNull();
    expect(normalizarWhatsapp('')).toBeNull();
    expect(normalizarWhatsapp('123456789012345')).toBeNull();
  });
});

describe('POST /alta, la ruta publica', () => {
  it('da de alta, crea el pase y devuelve el link', async () => {
    const { respuesta, cuerpo } = await altaDeSocia();
    expect(respuesta.status).toBe(200);
    expect(cuerpo.link.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    expect(db.socias).toHaveLength(1);
    expect(db.socias[0]!.whatsapp).toBe('+525512345678');
    expect(wallet.creados).toEqual([db.socias[0]!.id]);
    expect(db.socias[0]!.objetoWalletId).toContain('3388000000023195590.');
  });

  it('el mismo whatsapp otra vez devuelve SU MISMO pase, ni otra socia ni un error', async () => {
    // Cambio de telefono, borro el pase, o simplemente escaneo el QR dos veces. Hasta
    // el 14 de octubre de 2026 esto daba 409 y la dejaba sin salida.
    const primera = await altaDeSocia('Maria Lopez', '5512345678');
    const segunda = await altaDeSocia('Maria L', '+52 55 1234 5678');

    expect(segunda.respuesta.status).toBe(200);
    expect(segunda.cuerpo.yaRegistrada).toBe(true);
    expect(segunda.cuerpo.link).toBe(primera.cuerpo.link);
    expect(db.socias).toHaveLength(1);
    // No se creo un segundo objeto en Google: el emisor no acumula basura.
    expect(wallet.creados).toEqual([db.socias[0]!.id]);
  });

  it('volver a darse de alta NO reescribe el nombre ni el plan de la ficha', async () => {
    // Recepcion es la dueña de la ficha. Un formulario publico no la puede corregir,
    // o cualquiera que conozca el numero le cambia el plan a una socia.
    await altaDeSocia('Maria Lopez', '5512345678', 'Mensual');
    const { cuerpo } = await altaDeSocia('Otro Nombre', '5512345678', 'Semanal');

    expect(cuerpo.nombre).toBe('Maria Lopez');
    expect(db.socias[0]!.nombre).toBe('Maria Lopez');
    expect(db.socias[0]!.planId).toBe(planMensual.id);
  });

  it('si existe pero su pase nunca se creo, el reintento se lo entrega', async () => {
    // Google fallo en su alta y el cron todavia no la alcanza. Volver a mandar el
    // formulario es justo lo que la socia hace, y tiene que funcionar.
    wallet.fallar = true;
    expect((await altaDeSocia()).respuesta.status).toBe(502);
    expect(db.socias[0]!.objetoWalletId).toBeFalsy();

    wallet.fallar = false;
    const { respuesta, cuerpo } = await altaDeSocia();
    expect(respuesta.status).toBe(200);
    expect(cuerpo.yaRegistrada).toBe(true);
    expect(cuerpo.link.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);
    expect(db.socias).toHaveLength(1);
    expect(db.socias[0]!.objetoWalletId).toContain('3388000000023195590.');
  });

  it('pide nombre y numero validos', async () => {
    expect((await altaDeSocia('', '5512345678')).respuesta.status).toBe(400);
    expect((await altaDeSocia('Maria', '123')).respuesta.status).toBe(400);
  });

  it('EL PLAN LO MANDA LA PAGINA: sin plan o con uno inventado, no nace nadie', async () => {
    // Cada plan tiene su propia pagina con su propio QR. No hay plan por omision:
    // un camino silencioso que elija por ella contradice la decision.
    const sinPlan = await pedir('/alta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'Maria Lopez', whatsapp: '5512345678' }),
    });
    expect(sinPlan.status).toBe(400);
    expect((await altaDeSocia('Maria', '5512345678', 'Trimestral')).respuesta.status).toBe(400);
    expect(db.socias).toHaveLength(0);
  });

  it('la socia nace DENTRO del plan que mando su pagina, no en Mensual', async () => {
    await altaDeSocia('Ana Ruiz', '5511112222', 'Semanal');
    expect(db.socias[0]!.planId).toBe(planSemanal.id);
  });

  it('si Google falla, la socia YA existe, queda pendiente y el mensaje lo dice', async () => {
    wallet.fallar = true;
    const { respuesta, cuerpo } = await altaDeSocia();
    expect(respuesta.status).toBe(502);
    // Primero la base, despues Google: la fila no se pierde.
    expect(db.socias).toHaveLength(1);
    expect(db.sync[db.socias[0]!.id]!.estado).toBe('pendiente');
    // El mensaje tiene que decirle que su registro SI quedo. Si dice solo "intenta de
    // nuevo", la socia cree que se perdio y vuelve a llenar el formulario.
    expect(cuerpo.pendiente).toBe(true);
    expect(cuerpo.error).toContain('guardado');
  });
});

describe('las dos defensas de /alta', () => {
  const altaCon = (extra: Record<string, unknown> = {}, cabeceras: Record<string, string> = {}) =>
    pedir('/alta', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cabeceras },
      body: JSON.stringify({
        nombre: 'Maria Lopez',
        whatsapp: '5512345678',
        plan: 'Mensual',
        ...extra,
      }),
    });

  it('un captcha que no pasa NO llega a escribir en la base', async () => {
    deps.verificarCaptcha = async () => false;
    app = crearApp(deps);
    const r = await altaCon({ captcha: 'malo' });
    expect(r.status).toBe(403);
    expect(db.socias).toHaveLength(0);
    expect(wallet.creados).toHaveLength(0);
  });

  it('el captcha recibe el token y la IP que puso Cloudflare', async () => {
    const vistos: Array<[string, string | null]> = [];
    deps.verificarCaptcha = async (respuesta, ip) => {
      vistos.push([respuesta, ip]);
      return true;
    };
    app = crearApp(deps);
    await altaCon({ captcha: 'token-bueno' }, { 'cf-connecting-ip': '203.0.113.7' });
    expect(vistos).toEqual([['token-bueno', '203.0.113.7']]);
  });

  it('pasado el cupo por IP da 429 y no gasta una llamada al captcha', async () => {
    let captchasPedidos = 0;
    deps.verificarCaptcha = async () => {
      captchasPedidos++;
      return true;
    };
    deps.dentroDelLimite = async () => false;
    app = crearApp(deps);
    const r = await altaCon({ captcha: 'token-bueno' });
    expect(r.status).toBe(429);
    expect(captchasPedidos).toBe(0);
    expect(db.socias).toHaveLength(0);
  });

  it('el cupo se cuenta por IP, no para todo el mundo junto', async () => {
    const claves: string[] = [];
    deps.dentroDelLimite = async (clave) => {
      claves.push(clave);
      return true;
    };
    app = crearApp(deps);
    await altaCon({}, { 'cf-connecting-ip': '203.0.113.7' });
    expect(claves).toEqual(['alta:203.0.113.7']);
  });

  it('con el captcha dado por configurado la ruta funciona', async () => {
    // El default de `crearApp` es "esta configurado", porque quien arma las
    // dependencias a mano (los tests) ya sabe lo que hace. **Quien decide de verdad es
    // `dependenciasDeEntorno`**, y eso se prueba abajo, en su propio bloque.
    const { respuesta } = await altaDeSocia();
    expect(respuesta.status).toBe(200);
  });

  it('SIN CAPTCHA CONFIGURADO LA RUTA NO ABRE, y no escribe nada', async () => {
    deps.captchaConfigurado = false;
    app = crearApp(deps);
    const r = await altaCon({ captcha: 'lo que sea' });
    expect(r.status).toBe(503);
    expect(db.socias).toHaveLength(0);
    expect(wallet.creados).toHaveLength(0);
  });

  it('cerrada por falta de captcha, ni siquiera gasta cupo del limitador', async () => {
    let cuposPedidos = 0;
    deps.captchaConfigurado = false;
    deps.dentroDelLimite = async () => {
      cuposPedidos++;
      return true;
    };
    app = crearApp(deps);
    expect((await altaCon()).status).toBe(503);
    expect(cuposPedidos).toBe(0);
  });

  it('lo que lee la socia no la manda a reintentar en vano', async () => {
    deps.captchaConfigurado = false;
    app = crearApp(deps);
    const cuerpo = await leer(await altaCon());
    expect(cuerpo.error).toContain('no esta disponible');
    expect(cuerpo.error).not.toMatch(/-/);
  });
});

/**
 * El cableado real del Worker. Aqui vive la decision que el 19 de octubre de 2026 dejo
 * de ser un default silencioso: **sin `TURNSTILE_SECRET`, `/alta` no abre**, y para
 * abrirla sin captcha hay que escribir `CAPTCHA_OPCIONAL=si` a mano en `.dev.vars`.
 *
 * Antes, un secreto subido con el nombre mal escrito dejaba la pagina publica sin
 * captcha en produccion y solo lo decia un `console.warn` que nadie lee.
 */
describe('dependenciasDeEntorno: como se decide si el captcha esta configurado', () => {
  // No conecta con nadie: `neon()` solo parsea la cadena, y ninguna consulta corre.
  const base = {
    DATABASE_URL: 'postgresql://usuario:clave@ejemplo.neon.tech/basededatos',
    NEGOCIO_ID: 'negocio-1',
    GOOGLE_CLIENT_EMAIL: 'cuenta@ejemplo.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: 'no-se-usa-en-este-test',
    WALLET_ISSUER_ID: '3388000000023195590',
    WALLET_CLASE_ID: '3388000000023195590.fitjump_lealtad_v1',
    WALLET_BASE_IMAGENES: 'https://ejemplo.com/imagenes/v1',
  };

  it('con secreto: configurado', () => {
    expect(dependenciasDeEntorno({ ...base, TURNSTILE_SECRET: 'un-secreto' }).captchaConfigurado).toBe(true);
  });

  it('SIN secreto y sin permiso explicito: NO configurado, que cierra la ruta', () => {
    expect(dependenciasDeEntorno({ ...base }).captchaConfigurado).toBe(false);
  });

  it('sin secreto pero con CAPTCHA_OPCIONAL en si: configurado, que es wrangler dev', () => {
    expect(dependenciasDeEntorno({ ...base, CAPTCHA_OPCIONAL: 'si' }).captchaConfigurado).toBe(true);
  });

  it('el permiso se compara con el texto exacto: nada mas abre la puerta', () => {
    for (const valor of ['no', 'false', '', 'SI', 'true', '1']) {
      expect(dependenciasDeEntorno({ ...base, CAPTCHA_OPCIONAL: valor }).captchaConfigurado).toBe(false);
    }
  });
});

describe('POST /activar: la unica puerta de entrada al panel', () => {
  const activar = (codigo: string) =>
    pedir('/activar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo }),
    });

  it('con el codigo correcto deja la cookie HttpOnly, Secure y SameSite Lax', async () => {
    const r = await activar(CODIGO);
    expect(r.status).toBe(200);
    expect((await leer(r)).usuario.nombre).toBe('Recepcion B');
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('sesion=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('EL TOKEN NO VIAJA NUNCA: lo genera el servidor y solo sale en la cookie', async () => {
    const r = await activar(CODIGO);
    const cuerpo = await leer(r);
    // El cuerpo de la respuesta no lleva token de ninguna clase.
    expect(JSON.stringify(cuerpo)).not.toContain('token');
    // Y lo que quedo en la base es un SHA-256, no el token que viaja en la cookie.
    const fila = db.usuarios.find((u) => u.id === 'usuario-3')!;
    expect(fila.hash).toMatch(/^[0-9a-f]{64}$/);
    const token = /sesion=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]!;
    expect(fila.hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(db.usuarios)).not.toContain(token);
  });

  it('DE UN SOLO USO: el segundo intento con el mismo codigo da 401 y no deja cookie', async () => {
    expect((await activar(CODIGO)).status).toBe(200);
    const segundo = await activar(CODIGO);
    expect(segundo.status).toBe(401);
    expect(segundo.headers.get('set-cookie')).toBeNull();
  });

  it('un codigo caducado no activa, aunque siga en la base', async () => {
    const fila = db.usuarios.find((u) => u.id === 'usuario-3')!;
    fila.altaExpira = new Date(db.reloj.getTime() - 1000).toISOString();
    const r = await activar(CODIGO);
    expect(r.status).toBe(401);
    expect((await leer(r)).error).toContain('caduco');
    expect(fila.hash).toBeNull();
  });

  it('un codigo inventado no activa a nadie', async () => {
    const r = await activar('codigo-que-nadie-genero');
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('la activacion deja la fila activa y con token, que es lo que la base exige', async () => {
    const antes = db.usuarios.find((u) => u.id === 'usuario-3')!;
    expect(antes.activo).toBe(false);
    expect(antes.hash).toBeNull();
    await activar(CODIGO);
    const despues = db.usuarios.find((u) => u.id === 'usuario-3')!;
    expect(despues.activo).toBe(true);
    expect(despues.hash).not.toBeNull();
    expect(despues.altaHash).toBeNull();
  });

  it('el token nuevo REEMPLAZA al viejo: una persona, un dispositivo', async () => {
    const viejo = 'token-del-telefono-viejo-aaaaaa';
    const fila = db.usuarios.find((u) => u.id === 'usuario-3')!;
    fila.hash = await sha256Hex(viejo);
    fila.activo = true;
    expect((await pedir('/yo', { headers: { cookie: 'sesion=' + viejo } })).status).toBe(200);

    await activar(CODIGO);

    // El telefono viejo queda fuera en su siguiente peticion, sin tocar a nadie mas.
    expect((await pedir('/yo', { headers: { cookie: 'sesion=' + viejo } })).status).toBe(401);
    expect((await pedir('/yo', { headers: conSesion() })).status).toBe(200);
  });

  it('YA NO EXISTE una ruta que cambie un token conocido por una cookie', async () => {
    const r = await pedir('/sesion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    // Responde 401 y no 404 porque el middleware del panel esta montado en la raiz y
    // atiende primero: una ruta que no existe se ve igual que una ruta sin sesion, y
    // de paso no se puede enumerar que rutas hay. Lo que importa es que no entrega
    // cookie ni sesion.
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('sin cookie, las rutas del panel responden 401', async () => {
    for (const ruta of ['/yo', '/socias?q=ma', '/socias/socia-1']) {
      expect((await pedir(ruta)).status).toBe(401);
    }
  });
});

describe('salir del dispositivo', () => {
  it('REVOCA de verdad: la fila queda sin token y la cookie deja de servir', async () => {
    const r = await pedir('/salir', { method: 'POST', headers: conSesion() });
    expect(r.status).toBe(200);
    const fila = db.usuarios.find((u) => u.id === 'usuario-1')!;
    expect(fila.hash).toBeNull();
    expect(fila.activo).toBe(false);
    // La misma cookie ya no abre nada: volver a entrar exige un enlace nuevo.
    expect((await pedir('/yo', { headers: conSesion() })).status).toBe(401);
  });

  it('revocar un acceso no toca los otros dos', async () => {
    await pedir('/salir', { method: 'POST', headers: conSesion() });
    expect(db.usuarios.find((u) => u.id === 'usuario-2')!.activo).toBe(true);
    expect((await pedir('/yo', { headers: conSesion(TOKEN_OTRO) })).status).toBe(200);
  });
});

describe('ajuste manual de recepcion', () => {
  const ajustar = (sellosDestino: number, clave?: string) =>
    pedir('/socias/socia-1/ajuste', {
      method: 'POST',
      headers: {
        ...conSesion(),
        'content-type': 'application/json',
        ...(clave ? { 'Idempotency-Key': clave } : {}),
      },
      body: JSON.stringify({ sellosDestino }),
    });

  it('dentro del tope corrige el contador y NO notifica a la socia', async () => {
    await altaDeSocia();
    const r = await ajustar(4);
    expect(r.status).toBe(200);
    expect((await leer(r)).socia.sellos).toBe(4);
    await terminarSegundoPlano();
    expect(wallet.actualizaciones.at(-1)).toMatchObject({ sellos: 4, notificar: false });
  });

  it('EL TOPE SE RECHAZA, no se acota en silencio, y dice como se arregla', async () => {
    await altaDeSocia();
    const r = await ajustar(6);
    expect(r.status).toBe(409);
    const cuerpo = await leer(r);
    expect(cuerpo.tope).toBe(5);
    expect(cuerpo.comoSeArregla).toContain('deshacer');
    // Y sobre todo: no escribio nada.
    expect(db.movimientos).toHaveLength(0);
    expect(db.socias[0]!.sellos).toBe(0);
  });

  it('el ajuste nunca otorga premio, ni cuando sube los sellos hasta el tope', async () => {
    await altaDeSocia();
    const cuerpo = await leer(await ajustar(5));
    expect(cuerpo.socia.sellos).toBe(5);
    expect(cuerpo.socia.premioPendiente).toBe('ninguno');
  });

  it('pedir el numero que ya tiene no inserta una fila vacia en el libro', async () => {
    await altaDeSocia();
    expect((await ajustar(0)).status).toBe(409);
    expect(db.movimientos).toHaveLength(0);
  });

  it('respeta la idempotencia igual que el pago', async () => {
    await altaDeSocia();
    await ajustar(3, 'ajuste-uno');
    const segundo = await leer(await ajustar(3, 'ajuste-uno'));
    expect(segundo.repetida).toBe(true);
    expect(db.movimientos.filter((m) => m.tipo === 'ajuste_manual')).toHaveLength(1);
  });
});

describe('lo que NO se deshace, y por que', () => {
  const ultimoDeTipo = (tipo: string) => db.movimientos.filter((m) => m.tipo === tipo).at(-1)!;

  it('un canje no se deshace, porque el reverso no devuelve premios', async () => {
    await altaDeSocia();
    for (let i = 0; i < 3; i += 1) {
      await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    }
    await pedir('/socias/socia-1/canje', { method: 'POST', headers: conSesion() });
    const canje = ultimoDeTipo('canje_chico');

    const r = await pedir(`/movimientos/${canje.id}/deshacer`, {
      method: 'POST',
      headers: conSesion(),
    });
    expect(r.status).toBe(409);
    expect((await leer(r)).comoSeArregla).toContain('ajuste');
    // Lo que importa: no escribio una fila que no hace nada.
    expect(db.movimientos.filter((m) => m.tipo === 'reverso')).toHaveLength(0);
  });

  it('un cambio de plan no se deshace, porque el plan no vuelve atras', async () => {
    await altaDeSocia();
    await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    await pedir('/socias/socia-1/cambiar-plan', {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'plan-semanal' }),
    });
    const cambio = ultimoDeTipo('cambio_plan');

    const r = await pedir(`/movimientos/${cambio.id}/deshacer`, {
      method: 'POST',
      headers: conSesion(),
    });
    expect(r.status).toBe(409);
    expect(db.movimientos.filter((m) => m.tipo === 'reverso')).toHaveLength(0);
  });

  it('un pago y un ajuste SI se deshacen, que es lo que el reverso sabe hacer completo', async () => {
    await altaDeSocia();
    await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    const pago = ultimoDeTipo('pago');
    expect((await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() })).status).toBe(200);

    await pedir('/socias/socia-1/ajuste', {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ sellosDestino: 2 }),
    });
    const ajuste = ultimoDeTipo('ajuste_manual');
    const r = await pedir(`/movimientos/${ajuste.id}/deshacer`, {
      method: 'POST',
      headers: conSesion(),
    });
    expect(r.status).toBe(200);
    expect((await leer(r)).socia.sellos).toBe(0);
  });
});

describe('el segundo toque de un boton que ya corrio, con mala señal', () => {
  /**
   * El defecto que H8 destapo: la idempotencia vivia despues de las validaciones de
   * cada ruta, y esas validaciones mienten en cuanto la primera peticion ya corrio.
   * Nada se duplicaba, pero recepcion leia un error rojo sobre una operacion que si
   * habia funcionado.
   */
  it('canjear dos veces con la misma clave devuelve la ficha, no "no tiene premio"', async () => {
    await altaDeSocia();
    for (let i = 0; i < 3; i += 1) {
      await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    }
    const canjear = () =>
      pedir('/socias/socia-1/canje', {
        method: 'POST',
        headers: { ...conSesion(), 'Idempotency-Key': 'canje-uno' },
      });
    expect((await canjear()).status).toBe(200);
    const segundo = await canjear();
    expect(segundo.status).toBe(200);
    expect((await leer(segundo)).repetida).toBe(true);
    expect(db.movimientos.filter((m) => m.tipo === 'canje_chico')).toHaveLength(1);
  });

  it('cambiar de plan dos veces con la misma clave no responde "ya esta en ese plan"', async () => {
    await altaDeSocia();
    const cambiar = () =>
      pedir('/socias/socia-1/cambiar-plan', {
        method: 'POST',
        headers: {
          ...conSesion(),
          'content-type': 'application/json',
          'Idempotency-Key': 'cambio-uno',
        },
        body: JSON.stringify({ planId: 'plan-semanal' }),
      });
    expect((await cambiar()).status).toBe(200);
    const segundo = await cambiar();
    expect(segundo.status).toBe(200);
    expect((await leer(segundo)).repetida).toBe(true);
    expect(db.movimientos.filter((m) => m.tipo === 'cambio_plan')).toHaveLength(1);
  });
});

describe('la ficha dice como va el pase contra Google', () => {
  it('despues de un pago la sincronizacion aparece, sin bloquear nada', async () => {
    await altaDeSocia();
    await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    await terminarSegundoPlano();
    const ficha = await leer(await pedir('/socias/socia-1', { headers: conSesion() }));
    expect(ficha.sincronizacion.estado).toBe('ok');
  });

  it('si Google falla, la ficha lo dice con el intento y el error', async () => {
    await altaDeSocia();
    wallet.fallar = true;
    await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    await terminarSegundoPlano();
    const ficha = await leer(await pedir('/socias/socia-1', { headers: conSesion() }));
    expect(ficha.sincronizacion.estado).toBe('error');
    expect(ficha.sincronizacion.intentos).toBe(1);
    expect(ficha.sincronizacion.ultimoError).toContain('google');
    // El sello SI quedo registrado, que es lo que el panel tiene que mostrar.
    expect(ficha.socia.sellos).toBe(1);
  });
});

describe('el token de dispositivo', () => {
  it('son 32 bytes aleatorios en base64url, y no se repite', () => {
    const uno = tokenDeDispositivo();
    expect(uno).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 50 }, tokenDeDispositivo)).size).toBe(50);
  });
});

describe('registrar pago', () => {
  it('suma un sello, responde sin esperar a Google, y avisa de la espera', async () => {
    const { cuerpo } = await altaDeSocia();
    const id = db.socias[0]!.id;
    const r = await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const datos = await leer(r);
    expect(r.status).toBe(200);
    expect(datos.socia.sellos).toBe(1);
    expect(datos.socia.progreso).toEqual({ texto: '1 de 6', archivoHero: 'hero-mensual-1.png' });
    expect(datos.avisoDeEspera).toContain('uno a dos minutos');
    await terminarSegundoPlano();
    expect(wallet.actualizaciones).toEqual([{ socia: id, sellos: 1, notificar: true }]);
    expect(cuerpo.link).toBeTruthy();
  });

  it('responde aunque Google se quede colgado: el panel nunca espera a Wallet', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    // Google deja de contestar justo antes del pago.
    wallet.trancar();

    const r = await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const datos = await leer(r);

    // La respuesta ya llego, con el numero nuevo, y Wallet sigue sin contestar.
    expect(r.status).toBe(200);
    expect(datos.socia.sellos).toBe(1);
    expect(wallet.actualizaciones).toHaveLength(0);
    // La fila ya existe en el libro: la verdad esta en la base, no en el pase.
    expect(db.movimientos.filter((m) => m.tipo === 'pago')).toHaveLength(1);
    expect(db.sync[id]!.estado).toBe('pendiente');

    // Cuando Google vuelve, la sincronizacion termina sola.
    wallet.soltarTranca!();
    wallet.tranca = null;
    await terminarSegundoPlano();
    expect(wallet.actualizaciones).toEqual([{ socia: id, sellos: 1, notificar: true }]);
    expect(db.sync[id]!.estado).toBe('ok');
  });

  it('el tercer pago otorga el premio chico, con el monto del plan', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    for (let i = 0; i < 3; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    const r = await pedir(`/socias/${id}`, { headers: conSesion() });
    const datos = await leer(r);
    expect(datos.socia.sellos).toBe(3);
    expect(datos.socia.premioPendiente).toBe('chico');
    expect(datos.socia.montoDelPremio).toBe(planMensual.montoPremioChico);
  });

  it('si Google falla, el movimiento ya esta escrito y queda en error para el cron', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    wallet.fallar = true;
    const r = await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    expect(r.status).toBe(200);
    await terminarSegundoPlano();
    expect(db.movimientos.filter((m) => m.tipo === 'pago')).toHaveLength(1);
    expect(db.sync[id]!.estado).toBe('error');

    // El cron lo recupera cuando Google vuelve.
    wallet.fallar = false;
    expect(await reintentarPendientes(deps)).toBe(1);
    expect(db.sync[id]!.estado).toBe('ok');
  });
});

describe('idempotencia: el boton picado dos veces', () => {
  it('con la misma Idempotency-Key solo suma un sello', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    const clave = 'uuid-del-navegador-1';
    const headers = { ...conSesion(), 'Idempotency-Key': clave };

    const primera = await leer(await pedir(`/socias/${id}/pago`, { method: 'POST', headers }));
    const segunda = await leer(await pedir(`/socias/${id}/pago`, { method: 'POST', headers }));

    expect(primera.socia.sellos).toBe(1);
    expect(segunda.socia.sellos).toBe(1);
    expect(segunda.repetida).toBe(true);
    expect(db.movimientos.filter((m) => m.tipo === 'pago')).toHaveLength(1);
  });

  it('dos toques simultaneos tampoco duplican: la restriccion unica decide', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    const headers = { ...conSesion(), 'Idempotency-Key': 'uuid-simultaneo' };
    // Las dos peticiones salen juntas, asi que las dos pasan la consulta previa.
    const [a, b] = await Promise.all([
      pedir(`/socias/${id}/pago`, { method: 'POST', headers }),
      pedir(`/socias/${id}/pago`, { method: 'POST', headers }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(db.movimientos.filter((m) => m.tipo === 'pago')).toHaveLength(1);
    expect(db.socias[0]!.sellos).toBe(1);
  });

  it('claves distintas suman dos sellos, que es lo correcto', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, {
      method: 'POST',
      headers: { ...conSesion(), 'Idempotency-Key': 'uno' },
    });
    await pedir(`/socias/${id}/pago`, {
      method: 'POST',
      headers: { ...conSesion(), 'Idempotency-Key': 'dos' },
    });
    expect(db.socias[0]!.sellos).toBe(2);
  });
});

describe('canje', () => {
  it('sin premio pendiente responde 409 y no escribe nada', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    const r = await pedir(`/socias/${id}/canje`, { method: 'POST', headers: conSesion() });
    expect(r.status).toBe(409);
    expect(db.movimientos).toHaveLength(0);
  });

  it('al llenar la plantilla el premio grande queda pendiente Y la plantilla ya esta vacia', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    for (let i = 0; i < 6; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    expect(db.socias[0]!.premioPendiente).toBe('grande');
    expect(db.socias[0]!.sellos).toBe(0);

    const ficha = await leer(await pedir(`/socias/${id}`, { headers: conSesion() }));
    expect(ficha.socia.progreso).toEqual({ texto: '0 de 6', archivoHero: 'hero-mensual-0.png' });
    expect(ficha.socia.montoDelPremio).toBe(planMensual.montoPremioGrande);
  });

  it('el pago siguiente canja el grande solo y deja un sello, en dos filas del libro', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    for (let i = 0; i < 6; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    const r = await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const datos = await leer(r);
    expect(datos.socia.sellos).toBe(1);
    expect(datos.socia.premioPendiente).toBe('ninguno');
    // El canje automatico queda escrito en el libro contable, porque el descuento se
    // aplico de verdad en la caja.
    const ultimos = db.movimientos.slice(-2).map((m) => m.tipo);
    expect(ultimos).toEqual(['canje_grande', 'pago']);
  });

  it('cada fila del libro guarda el plan con el que se evalua', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    expect(db.movimientos.every((m) => m.planId === planMensual.id)).toBe(true);
  });
});

describe('deshacer', () => {
  it('baja el sello, deja un reverso en el libro y NO notifica', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    await terminarSegundoPlano();
    const pago = db.movimientos.find((m) => m.tipo === 'pago')!;

    const r = await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() });
    const datos = await leer(r);
    expect(r.status).toBe(200);
    expect(datos.socia.sellos).toBe(0);
    expect(db.movimientos.some((m) => m.tipo === 'reverso' && m.reversaA === pago.id)).toBe(true);
    await terminarSegundoPlano();
    // La ultima actualizacion del pase fue sin notificar.
    expect(wallet.actualizaciones.at(-1)).toEqual({ socia: id, sellos: 0, notificar: false });
  });

  it('el libro contable no se edita: deshacer AGREGA una fila, no quita ninguna', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const antes = db.movimientos.length;
    const pago = db.movimientos.find((m) => m.tipo === 'pago')!;
    await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() });
    expect(db.movimientos.length).toBe(antes + 1);
    expect(db.movimientos.some((m) => m.id === pago.id)).toBe(true);
  });

  it('no se puede deshacer dos veces el mismo movimiento', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const pago = db.movimientos.find((m) => m.tipo === 'pago')!;
    await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() });
    const segunda = await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() });
    expect(segunda.status).toBe(409);
  });

  it('pasados los diez minutos ya no se puede deshacer', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const pago = db.movimientos.find((m) => m.tipo === 'pago')!;

    // Nueve minutos despues todavia se puede.
    db.reloj = new Date(db.reloj.getTime() + 9 * 60_000);
    const ficha = await leer(await pedir(`/socias/${id}`, { headers: conSesion() }));
    expect(ficha.movimientos.find((m: any) => m.id === pago.id).sePuedeDeshacer).toBe(true);

    // A los once, ya no.
    db.reloj = new Date(db.reloj.getTime() + 2 * 60_000);
    const r = await pedir(`/movimientos/${pago.id}/deshacer`, { method: 'POST', headers: conSesion() });
    expect(r.status).toBe(409);
    const despues = await leer(await pedir(`/socias/${id}`, { headers: conSesion() }));
    expect(despues.movimientos.find((m: any) => m.id === pago.id).sePuedeDeshacer).toBe(false);
  });
});

describe('cambiar de plan, con la regla del 14 de octubre', () => {
  it('la plantilla se va a cero y el destino que pida recepcion se ignora', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    for (let i = 0; i < 2; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    expect(db.socias[0]!.sellos).toBe(2);

    const r = await pedir(`/socias/${id}/cambiar-plan`, {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planSemanal.id, sellosDestino: 99 }),
    });
    const datos = await leer(r);
    expect(datos.socia.plan.nombre).toBe('Semanal');
    expect(datos.socia.sellos).toBe(0);
    expect(datos.socia.progreso.archivoHero).toBe('hero-semanal-0.png');
  });

  it('un premio pendiente SE CANJA al monto del plan de ORIGEN, no del nuevo', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    // Gana el premio chico en mensual, que vale 140.
    for (let i = 0; i < 3; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    expect(db.socias[0]!.premioPendiente).toBe('chico');

    const r = await pedir(`/socias/${id}/cambiar-plan`, {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planSemanal.id }),
    });
    const datos = await leer(r);

    expect(datos.efectos).toContainEqual({
      tipo: 'premio_canjeado',
      premio: 'chico',
      monto: planMensual.montoPremioChico,
    });
    expect(datos.socia.premioPendiente).toBe('ninguno');
    expect(datos.socia.sellos).toBe(0);

    // El canje se escribio con el plan de origen y el cambio con el nuevo.
    const dosUltimos = db.movimientos.slice(-2);
    expect(dosUltimos.map((m) => m.tipo)).toEqual(['canje_chico', 'cambio_plan']);
    expect(dosUltimos[0]!.planId).toBe(planMensual.id);
    expect(dosUltimos[0]!.monto).toBe(planMensual.montoPremioChico);
    expect(dosUltimos[1]!.planId).toBe(planSemanal.id);
  });

  it('el cambio de plan abre ciclo nuevo: puede volver a ganar el premio chico', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    for (let i = 0; i < 3; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    await pedir(`/socias/${id}/cambiar-plan`, {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planSemanal.id }),
    });
    expect(db.socias[0]!.premioChicoUsadoEnCiclo).toBe(false);

    // Cuatro pagos en semanal y vuelve a tener premio chico, ahora de 40.
    for (let i = 0; i < 4; i += 1) {
      await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    }
    const ficha = await leer(await pedir(`/socias/${id}`, { headers: conSesion() }));
    expect(ficha.socia.premioPendiente).toBe('chico');
    expect(ficha.socia.montoDelPremio).toBe(planSemanal.montoPremioChico);
  });

  it('sin premio pendiente, solo pierde los sellos, en una sola fila', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const antes = db.movimientos.length;
    await pedir(`/socias/${id}/cambiar-plan`, {
      method: 'POST',
      headers: { ...conSesion(), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planSemanal.id }),
    });
    expect(db.movimientos.length).toBe(antes + 1);
    expect(db.movimientos.at(-1)!.tipo).toBe('cambio_plan');
    expect(db.socias[0]!.sellos).toBe(0);
  });
});

describe('la lista de socias activas del panel', () => {
  it('devuelve las socias con su plan y sus sellos, sin pedir texto de busqueda', async () => {
    await altaDeSocia('Maria Lopez', '5512345678', 'Mensual');
    await pedir('/socias/socia-1/pago', { method: 'POST', headers: conSesion() });
    await terminarSegundoPlano();

    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias).toHaveLength(1);
    expect(datos.socias[0]).toMatchObject({
      nombre: 'Maria Lopez',
      plan: 'Mensual',
      sellos: 1,
      sellosTotales: 6,
      esPrueba: false,
    });
    expect(datos.total).toBe(1);
    expect(datos.faltan).toBe(0);
  });

  it('NO manda el whatsapp ni nada que la pantalla no pinte', async () => {
    await altaDeSocia('Maria Lopez', '5512345678');
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    // El renglon pinta nombre, plan y "N de M". Todo lo demas es peso de mas en un
    // JSON que puede traer 100 filas.
    expect(Object.keys(datos.socias[0]).sort()).toEqual(
      ['esPrueba', 'id', 'nombre', 'plan', 'sellos', 'sellosTotales'].sort(),
    );
    expect(JSON.stringify(datos)).not.toContain('5512345678');
  });

  it('marca a las socias de prueba', async () => {
    await altaDeSocia('Prueba H7', '5500000000');
    db.socias[0]!.esPrueba = true;
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias[0].esPrueba).toBe(true);
  });

  it('va en orden alfabetico sin que las mayusculas se cuelen al final', async () => {
    await altaDeSocia('zoe ramirez', '5510000001');
    await altaDeSocia('Ana Ruiz', '5510000002');
    await altaDeSocia('beatriz Diaz', '5510000003');
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias.map((s: any) => s.nombre)).toEqual([
      'Ana Ruiz',
      'beatriz Diaz',
      'zoe ramirez',
    ]);
  });

  it('deja fuera a las socias dadas de baja', async () => {
    await altaDeSocia('Maria Lopez', '5512345678');
    await altaDeSocia('Rosa Diaz', '5512345679');
    db.socias[1]!.activa = false;
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias.map((s: any) => s.nombre)).toEqual(['Maria Lopez']);
    expect(datos.total).toBe(1);
  });

  it('corta en 100 y dice cuantas faltan, sin mentir en el total', async () => {
    // 105 socias: la lista trae 100 y el pie tiene que decir 5.
    for (let i = 0; i < 105; i += 1) {
      db.socias.push(
        sociaVacia('socia-masiva-' + i, {
          negocioId: NEGOCIO,
          nombre: 'Socia ' + String(i).padStart(3, '0'),
          whatsapp: '+521000000' + String(i).padStart(3, '0'),
          planId: planMensual.id,
        }),
      );
    }
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias).toHaveLength(100);
    expect(datos.total).toBe(105);
    expect(datos.faltan).toBe(5);
  });

  it('con cero socias responde vacio y no inventa un total', async () => {
    const datos = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(datos.socias).toEqual([]);
    expect(datos.total).toBe(0);
    expect(datos.faltan).toBe(0);
  });

  it('sin cookie de sesion no abre', async () => {
    await altaDeSocia();
    const r = await pedir('/socias-activas');
    expect(r.status).toBe(401);
  });

  it('NO cambia lo que GET /socias hace sin texto, que es devolver vacio', async () => {
    await altaDeSocia('Maria Lopez');
    // La ruta vieja sigue igual: con menos de dos caracteres, vacio.
    expect((await leer(await pedir('/socias', { headers: conSesion() }))).socias).toEqual([]);
    expect((await leer(await pedir('/socias?q=m', { headers: conSesion() }))).socias).toEqual([]);
    // Y con texto sigue buscando como siempre.
    const conTexto = await leer(await pedir('/socias?q=maria', { headers: conSesion() }));
    expect(conTexto.socias).toHaveLength(1);
    // La ruta vieja sigue mandando la ficha completa, con el plan como objeto.
    expect(conTexto.socias[0].plan.nombre).toBe('Mensual');
    expect(conTexto.socias[0].whatsapp).toBeDefined();
  });

  it('no se la come el patron de /socias/:id', async () => {
    await altaDeSocia();
    // Si `/socias-activas` cayera en `/socias/:id`, esto seria un 404 de socia que no
    // existe en vez de la lista.
    const r = await pedir('/socias-activas', { headers: conSesion() });
    expect(r.status).toBe(200);
    expect(await leer(r)).toHaveProperty('total');
  });
});

describe('aislamiento multi tenant, con la base falsa', () => {
  it('un negocio no puede leer la ficha de una socia de otro', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    // La sesion del otro negocio pide la socia por su id exacto.
    const r = await pedir(`/socias/${id}`, { headers: conSesion(TOKEN_OTRO) });
    // 404 y no 403: no se filtra ni que la socia exista.
    expect(r.status).toBe(404);
  });

  it('un negocio no puede registrarle un pago a una socia de otro', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    const r = await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion(TOKEN_OTRO) });
    expect(r.status).toBe(404);
    expect(db.movimientos).toHaveLength(0);
  });

  it('un negocio no puede deshacer un movimiento de otro', async () => {
    await altaDeSocia();
    const id = db.socias[0]!.id;
    await pedir(`/socias/${id}/pago`, { method: 'POST', headers: conSesion() });
    const pago = db.movimientos.find((m) => m.tipo === 'pago')!;
    const r = await pedir(`/movimientos/${pago.id}/deshacer`, {
      method: 'POST',
      headers: conSesion(TOKEN_OTRO),
    });
    expect(r.status).toBe(404);
    expect(db.movimientos.some((m) => m.tipo === 'reverso')).toBe(false);
  });

  it('la busqueda nunca devuelve socias de otro negocio', async () => {
    await altaDeSocia('Maria Lopez');
    const r = await pedir('/socias?q=maria', { headers: conSesion(TOKEN_OTRO) });
    expect((await leer(r)).socias).toEqual([]);
  });

  it('la lista de socias activas nunca devuelve socias de otro negocio', async () => {
    await altaDeSocia('Maria Lopez', '5512345678');
    await altaDeSocia('Rosa Diaz', '5512345679');
    // La sesion del otro negocio pide la lista: no existe ninguna socia suya.
    const ajena = await leer(await pedir('/socias-activas', { headers: conSesion(TOKEN_OTRO) }));
    expect(ajena.socias).toEqual([]);
    // Y el total tampoco filtra cuantas tiene el vecino, que seria contar sin leer.
    expect(ajena.total).toBe(0);
    expect(ajena.faltan).toBe(0);
    // La sesion propia si las ve, para que el test no pase por estar todo vacio.
    const propia = await leer(await pedir('/socias-activas', { headers: conSesion() }));
    expect(propia.socias).toHaveLength(2);
  });
});
