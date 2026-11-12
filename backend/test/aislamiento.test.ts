/**
 * EL TEST DE AISLAMIENTO MULTI TENANT. Es la aceptacion automatica de H6, y corre
 * contra la base REAL de Neon, no contra la falsa: lo que se quiere comprobar es que el
 * SQL de verdad filtra por negocio, no que mi doble en memoria lo haga.
 *
 * Crea dos negocios de prueba con nombres aleatorios, hace las preguntas cruzadas y
 * borra todo al final. **No inserta ni un movimiento:** si alguna escritura cruzada
 * pasara, dejaria una fila imborrable y la limpieza fallaria a gritos, que es
 * exactamente lo que uno quiere de este test.
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp, sha256Hex, type ClienteWallet } from '../src/api.ts';
import { crearBaseDeDatos, type FilaSocia } from '../src/db.ts';

/** Lee el JSON de una respuesta. `Response.json()` no acepta parametro de tipo. */
const leer = async (r: Response): Promise<any> => r.json();


function cadenaDeConexion(): string | null {
  try {
    for (const linea of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
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

const walletQueNoDebeUsarse: ClienteWallet = {
  async crear() {
    throw new Error('ninguna peticion cruzada deberia llegar a Wallet');
  },
  async actualizar() {
    throw new Error('ninguna peticion cruzada deberia llegar a Wallet');
  },
  async link() {
    return 'no se usa';
  },
  idObjeto(socia: FilaSocia) {
    return 'no-se-usa.' + socia.id;
  },
};

describe.skipIf(!hayBase)('aislamiento multi tenant contra la base real', () => {
  const sufijo = Math.random().toString(36).slice(2, 8);
  const negocioA = crypto.randomUUID();
  const negocioB = crypto.randomUUID();
  const planA = crypto.randomUUID();
  const planB = crypto.randomUUID();
  const usuarioA = crypto.randomUUID();
  const usuarioB = crypto.randomUUID();
  const tokenA = 'token-prueba-aislamiento-a-' + sufijo;
  const tokenB = 'token-prueba-aislamiento-b-' + sufijo;
  let sociaA = '';
  let app: ReturnType<typeof crearApp>;
  let sql: ReturnType<typeof neon>;

  beforeAll(async () => {
    sql = neon(cadena as string);
    const hashA = await sha256Hex(tokenA);
    const hashB = await sha256Hex(tokenB);

    await sql.transaction([
      sql`insert into negocios (id, nombre) values (${negocioA}, ${'Prueba A ' + sufijo})`,
      sql`insert into negocios (id, nombre) values (${negocioB}, ${'Prueba B ' + sufijo})`,
      sql`insert into planes (id, negocio_id, nombre, sellos_totales, sellos_premio_chico,
            monto_premio_chico, monto_premio_grande, precio, reinicia_al_canjear_grande,
            reinicia_al_canjear_chico, premio_chico_borra_sellos, suma_sello_con_premio_pendiente,
            conserva_sellos_al_cambiar_plan, tope_sellos_ajuste_manual, sello_de_bienvenida)
          values (${planA}, ${negocioA}, 'Mensual', 6, 3, 140, 275, 550,
                  true, false, false, true, false, 5, false)`,
      sql`insert into planes (id, negocio_id, nombre, sellos_totales, sellos_premio_chico,
            monto_premio_chico, monto_premio_grande, precio, reinicia_al_canjear_grande,
            reinicia_al_canjear_chico, premio_chico_borra_sellos, suma_sello_con_premio_pendiente,
            conserva_sellos_al_cambiar_plan, tope_sellos_ajuste_manual, sello_de_bienvenida)
          values (${planB}, ${negocioB}, 'Mensual', 6, 3, 140, 275, 550,
                  true, false, false, true, false, 5, false)`,
      sql`insert into usuarios_panel (id, negocio_id, nombre, token_hash, activo)
          values (${usuarioA}, ${negocioA}, ${'Panel A ' + sufijo}, ${hashA}, true)`,
      sql`insert into usuarios_panel (id, negocio_id, nombre, token_hash, activo)
          values (${usuarioB}, ${negocioB}, ${'Panel B ' + sufijo}, ${hashB}, true)`,
    ]);

    const filas = (await sql`
      insert into socias (negocio_id, nombre, whatsapp, plan_id)
      values (${negocioA}, ${'Socia A ' + sufijo}, '+525599000001', ${planA})
      returning id
    `) as Array<{ id: string }>;
    sociaA = filas[0]!.id;

    app = crearApp({
      db: crearBaseDeDatos(cadena as string),
      wallet: walletQueNoDebeUsarse,
      negocioPublico: negocioA,
        enSegundoPlano: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    // Si alguna escritura cruzada hubiera pasado, aqui quedaria una fila imborrable.
    const movimientos = (await sql`
      select count(*)::int as n from movimientos
       where negocio_id in (${negocioA}, ${negocioB})
    `) as Array<{ n: number }>;
    expect(movimientos[0]!.n).toBe(0);

    await sql.transaction([
      sql`delete from sync_wallet where negocio_id in (${negocioA}, ${negocioB})`,
      sql`delete from socias where negocio_id in (${negocioA}, ${negocioB})`,
      sql`delete from usuarios_panel where negocio_id in (${negocioA}, ${negocioB})`,
      sql`delete from planes where negocio_id in (${negocioA}, ${negocioB})`,
      sql`delete from negocios where id in (${negocioA}, ${negocioB})`,
    ]);

    const quedan = (await sql`
      select count(*)::int as n from negocios where id in (${negocioA}, ${negocioB})
    `) as Array<{ n: number }>;
    expect(quedan[0]!.n).toBe(0);
  }, 60_000);

  const pedir = (ruta: string, token: string, opciones: RequestInit = {}) =>
    app.request('http://local' + ruta, {
      ...opciones,
      headers: { ...(opciones.headers ?? {}), cookie: 'sesion=' + token },
    });

  it('el negocio dueño si ve a su socia', async () => {
    const r = await pedir(`/socias/${sociaA}`, tokenA);
    expect(r.status).toBe(200);
    const datos = await leer(r);
    expect(datos.socia.id).toBe(sociaA);
  });

  it('EL OTRO NEGOCIO NO LA VE, ni con el id exacto en la mano', async () => {
    const r = await pedir(`/socias/${sociaA}`, tokenB);
    // 404 y no 403: no se filtra ni que exista.
    expect(r.status).toBe(404);
  });

  it('el otro negocio no le puede registrar un pago', async () => {
    const r = await pedir(`/socias/${sociaA}/pago`, tokenB, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('el otro negocio no le puede canjear un premio', async () => {
    const r = await pedir(`/socias/${sociaA}/canje`, tokenB, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('el otro negocio no la encuentra buscando por nombre', async () => {
    const r = await pedir(`/socias?q=${encodeURIComponent('Socia A ' + sufijo)}`, tokenB);
    expect((await leer(r)).socias).toEqual([]);
  });

  it('el negocio dueño si la encuentra buscando por nombre', async () => {
    const r = await pedir(`/socias?q=${encodeURIComponent('Socia A ' + sufijo)}`, tokenA);
    const datos = await leer(r);
    expect(datos.socias).toHaveLength(1);
    expect(datos.socias[0].id).toBe(sociaA);
  });

  it('cada sesion solo ve los planes de su negocio', async () => {
    const deA = await leer(await pedir('/planes', tokenA));
    const deB = await leer(await pedir('/planes', tokenB));
    expect(deA.planes.map((p: any) => p.id)).toEqual([planA]);
    expect(deB.planes.map((p: any) => p.id)).toEqual([planB]);
  });

  it('el otro negocio no puede mover a la socia a un plan suyo', async () => {
    const r = await pedir(`/socias/${sociaA}/cambiar-plan`, tokenB, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planB, sellosDestino: 5 }),
    });
    expect(r.status).toBe(404);
  });

  it('ni el negocio dueño puede mover a su socia a un plan ajeno', async () => {
    const r = await pedir(`/socias/${sociaA}/cambiar-plan`, tokenA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: planB, sellosDestino: 5 }),
    });
    // El plan existe, pero no para este negocio.
    expect(r.status).toBe(404);
  });

  it('un token inventado no abre ninguna puerta', async () => {
    const r = await pedir(`/socias/${sociaA}`, 'token-que-no-existe');
    expect(r.status).toBe(401);
  });
});
