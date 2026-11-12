import { createApp } from 'vue';
import App from './App.vue';
import './estilos.css';

createApp(App).mount('#panel');

/*
  El trabajador de servicio solo existe para que Chrome ofrezca instalar el panel como
  aplicacion. No cachea nada, a proposito: ver `public/sw.js`. Si el registro falla, el
  panel funciona igual, solo que abierto en una pestaña normal.
*/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/panel/sw.js', { scope: '/panel/' }).catch(() => {});
  });
}
