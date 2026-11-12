/**
 * El trabajador de servicio del panel. NO CACHEA NADA, Y ESO ES LA DECISION.
 *
 * Existe por una sola razon: Chrome en Android solo ofrece instalar una pagina como
 * aplicacion si hay un trabajador de servicio con manejador de `fetch`. Instalada, el
 * panel abre a pantalla completa, sin barra de direcciones, que es lo que un mostrador
 * necesita.
 *
 * ⚠️ POR QUE NO CACHEA, aunque parezca lo natural:
 *
 *   1. La cola offline esta FUERA DEL ALCANCE de la v1 por decision del plan. Un cache
 *      daria la impresion contraria: el panel abriria sin señal, recepcion picaria el
 *      boton de pago y no se registraria nada.
 *   2. Un cache del armazon sirve una version vieja del panel despues de desplegar una
 *      nueva, y el mostrador se queda con un panel viejo sin que nadie lo note. Esa es
 *      exactamente la clase de error que este proyecto ya pago dos veces con las
 *      imagenes.
 *
 * Asi que pasa todo a la red tal cual. Si no hay señal, el panel dice que no hay señal,
 * que es la verdad.
 */
self.addEventListener('install', () => {
  // Un panel nuevo manda desde el primer momento: nada de esperar a que se cierren
  // todas las pestañas, que en un telefono no pasa nunca.
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (evento) => {
  evento.respondWith(fetch(evento.request));
});
