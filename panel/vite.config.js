/**
 * El build del panel sale DENTRO de `web\`, no al lado.
 *
 * ⚠️ LA RAZON, y es la restriccion que H7 descubrio: `assets.directory` de wrangler
 * acepta UNA sola carpeta, y hoy es `web\`. Si el panel compilara a `panel\dist\`, el
 * Worker no lo serviria. Compilando a `web\panel\`:
 *
 *   1. Sigue habiendo una sola carpeta de assets y `wrangler.jsonc` no se toca.
 *   2. `emptyOutDir` solo puede vaciar `web\panel\`, asi que el build **no puede**
 *      pisar `web\index.html` (la landing), `web\mensual\` (la pagina de alta) ni
 *      `web\imagenes\v1\`, que son las 16 imagenes que los
 *      pases ya emitidos apuntan por URL.
 *   3. El panel queda servido en `/panel/` por el mismo Worker, gratis y sin CPU,
 *      porque `run_worker_first` esta en false y un archivo que existe se sirve
 *      directo.
 *
 * ⚠️ `web\panel\` SE VERSIONA, aunque sea un build. H9 lo despliega Oscar a mano con
 * `npx wrangler deploy`, que sube `web\` tal como este en disco: si el build no esta en
 * el repo, un deploy desde otro clon subiria un panel que no existe. El costo es que
 * hay que correr `npm run build` antes de cada commit que toque el panel.
 *
 * NO HAY ROUTER a proposito. El panel es una pantalla con estados, asi que no necesita
 * `history` ni reescrituras, y `not_found_handling` nunca entra en juego.
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: '/panel/',
  build: {
    outDir: '../web/panel',
    emptyOutDir: true,
    // Un solo archivo de js y uno de css, sin trozos aparte: el panel abre en el
    // telefono de la dueña, con la señal del mostrador, y dos peticiones menos valen
    // mas que el cache granular de un archivo que cambia entero cada vez.
    assetsInlineLimit: 4096,
  },
  server: {
    // `npm run dev` del panel contra el Worker de `wrangler dev`, para no tener que
    // compilar en cada cambio durante la construccion.
    proxy: {
      '/socias': 'http://localhost:8787',
      '/movimientos': 'http://localhost:8787',
      '/planes': 'http://localhost:8787',
      '/yo': 'http://localhost:8787',
      '/activar': 'http://localhost:8787',
      '/salir': 'http://localhost:8787',
    },
  },
});
