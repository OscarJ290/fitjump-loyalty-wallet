/**
 * index.ts: el punto de entrada del Worker, y nada mas.
 *
 * Aqui SOLO puede vivir el export default con los handlers. El runtime de Workers
 * rechaza cualquier otra exportacion en el modulo de entrada: el 13 de octubre de 2026
 * `wrangler dev` no arranco con el mensaje
 * "Incorrect type for map entry 'MINUTOS_PARA_DESHACER'", porque este archivo exportaba
 * tambien constantes y funciones. La app vive en `api.ts`.
 */
import { crearApp, dependenciasDeEntorno, reintentarPendientes, type Entorno } from './api.ts';

/**
 * Lo unico que este archivo usa del contexto del Worker es `waitUntil`, asi que se
 * describe aqui en vez de arrastrar los tipos globales de Workers al proyecto: mezclar
 * esos tipos con los de Node rompe `node:fs` en los tests.
 */
interface ContextoDeEjecucion {
  waitUntil(tarea: Promise<unknown>): void;
}

export default {
  fetch(peticion: Request, entorno: Entorno, ctx: ContextoDeEjecucion) {
    const deps = dependenciasDeEntorno(entorno, (tarea) => ctx.waitUntil(tarea));
    return crearApp(deps).fetch(peticion);
  },

  async scheduled(_evento: unknown, entorno: Entorno, _ctx: ContextoDeEjecucion) {
    const logrados = await reintentarPendientes(dependenciasDeEntorno(entorno));
    console.log(`cron: ${logrados} pases sincronizados`);
  },
};
