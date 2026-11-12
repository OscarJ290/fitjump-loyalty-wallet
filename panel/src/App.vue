<!--
  El armazon del panel: quien esta dentro, el candado y que pantalla toca.

  COMO SE ENTRA, decidido con Oscar el 16 de octubre de 2026: por un enlace de
  activacion de un solo uso que el trae en el fragmento de la URL, despues del `#`.

  ⚠️ EL FRAGMENTO NO VIAJA AL SERVIDOR, y por eso el codigo va ahi y no en la ruta ni
  en la consulta: no queda escrito en los registros de Cloudflare ni del Worker. El
  panel lo lee, lo manda una sola vez por POST, y **limpia la barra de direcciones**
  para que no quede ni en el historial del navegador.

  Lo que el servidor devuelve es una cookie HttpOnly con el token del dispositivo, que
  ningun script puede leer, ni este. Asi que el token no existe en ningun lugar que una
  persona pueda copiar.
-->
<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { api, SinRed, SinSesion } from './api.js';
import Bloqueo from './componentes/Bloqueo.vue';
import Buscador from './componentes/Buscador.vue';
import Ficha from './componentes/Ficha.vue';

const PIN_GUARDADO = 'fitjump.pin';
/** Se bloquea solo a los tres minutos sin tocar nada. Una visita dura unos diez segundos. */
const MINUTOS_PARA_BLOQUEAR = 3;

const estado = ref('cargando'); // cargando, activando, sinAcceso, panel
const problema = ref('');
const usuario = ref(null);
const planes = ref([]);
const sociaAbierta = ref(null);
const bloqueado = ref(true);
const pin = ref(leerPin());
const bloqueo = ref(null);
let reloj = null;

function leerPin() {
  try {
    return localStorage.getItem(PIN_GUARDADO) || '';
  } catch {
    return '';
  }
}

function guardarPin(valor) {
  try {
    if (valor) localStorage.setItem(PIN_GUARDADO, valor);
    else localStorage.removeItem(PIN_GUARDADO);
  } catch {
    // Sin almacenamiento el PIN dura lo que la pestaña. No es la credencial, asi que
    // no se pierde nada que importe.
  }
  pin.value = valor;
}

function reiniciarReloj() {
  clearTimeout(reloj);
  if (bloqueado.value) return;
  reloj = setTimeout(() => {
    bloqueado.value = true;
  }, MINUTOS_PARA_BLOQUEAR * 60_000);
}

function alAbrirPin(valor) {
  if (pin.value && valor !== pin.value) {
    bloqueo.value?.rechazar('Ese no es. Intenta otra vez.');
    return;
  }
  if (!pin.value) guardarPin(valor);
  bloqueado.value = false;
  reiniciarReloj();
}

/** Olvido el PIN: no hay vuelta atras desde el telefono, y el panel lo dice claro. */
async function olvideElPin() {
  try {
    await api.salir();
  } catch {
    // Si no hay señal, igual se borra lo de este telefono: el acceso se repone con un
    // enlace nuevo de todas formas.
  }
  guardarPin('');
  usuario.value = null;
  estado.value = 'sinAcceso';
  problema.value =
    'Este dispositivo ya no tiene acceso. Pidele a Oscar un enlace nuevo para volver a entrar.';
}

/**
 * Salir pide confirmacion con una hoja propia y no con el aviso del navegador: un
 * `confirm` del sistema bloquea la pagina entera y no se puede escribir, y aqui lo que
 * hay que escribir es que volver a entrar cuesta un enlace nuevo.
 */
const confirmandoSalida = ref(false);

async function entrar() {
  try {
    const datos = await api.yo();
    usuario.value = datos.usuario;
    planes.value = (await api.planes()).planes;
    estado.value = 'panel';
    bloqueado.value = true;
  } catch (e) {
    if (e instanceof SinSesion) {
      estado.value = 'sinAcceso';
      problema.value = 'Este dispositivo no tiene acceso al panel.';
      return;
    }
    estado.value = 'sinAcceso';
    problema.value =
      e instanceof SinRed
        ? 'No pudimos conectar. Revisa la señal y vuelve a abrir el panel.'
        : 'No pudimos abrir el panel. Vuelve a intentar.';
  }
}

onMounted(async () => {
  const codigo = /[#&]c=([^&]+)/.exec(location.hash)?.[1];
  if (codigo) {
    // Fuera de la barra de direcciones antes de nada, y sin dejarlo en el historial.
    history.replaceState(null, '', location.pathname + location.search);
    estado.value = 'activando';
    try {
      const datos = await api.activar(decodeURIComponent(codigo));
      usuario.value = datos.usuario;
      planes.value = (await api.planes()).planes;
      // Un enlace nuevo es un dispositivo nuevo: el PIN del anterior no vale.
      guardarPin('');
      estado.value = 'panel';
      bloqueado.value = true;
      return;
    } catch (e) {
      estado.value = 'sinAcceso';
      problema.value =
        e instanceof SinRed
          ? 'No pudimos conectar. Revisa la señal y abre el enlace otra vez.'
          : e.message;
      return;
    }
  }
  await entrar();
});

onUnmounted(() => clearTimeout(reloj));

function alPerderSesion() {
  usuario.value = null;
  sociaAbierta.value = null;
  estado.value = 'sinAcceso';
  problema.value =
    'Este dispositivo dejo de tener acceso. Pidele a Oscar un enlace nuevo para volver a entrar.';
}
</script>

<template>
  <header v-if="estado === 'panel' && !bloqueado" class="cabecera">
    <h1>
      Panel Fit Jump
      <span class="quien">{{ usuario?.nombre }}</span>
    </h1>
    <button @click="bloqueado = true" aria-label="Bloquear">Bloquear</button>
  </header>

  <main @pointerdown="reiniciarReloj" @keydown="reiniciarReloj">
    <p v-if="estado === 'cargando'" class="suave">Abriendo el panel...</p>

    <p v-else-if="estado === 'activando'" class="suave">Activando este telefono...</p>

    <div v-else-if="estado === 'sinAcceso'" class="centrado">
      <h2>Sin acceso</h2>
      <p class="suave">{{ problema }}</p>
      <p class="suave">
        Los accesos son personales: cada movimiento queda firmado con quien lo hizo.
      </p>
    </div>

    <template v-else-if="estado === 'panel'">
      <Bloqueo
        v-if="bloqueado"
        ref="bloqueo"
        :modo="pin ? 'abrir' : 'crear'"
        :nombre="usuario?.nombre ?? ''"
        @listo="alAbrirPin"
        @olvide="olvideElPin"
      />

      <template v-else>
        <Ficha
          v-if="sociaAbierta"
          :socia-id="sociaAbierta"
          :planes="planes"
          @volver="sociaAbierta = null"
          @sin-sesion="alPerderSesion"
        />
        <template v-else>
          <Buscador @abrir="(id) => (sociaAbierta = id)" @sin-sesion="alPerderSesion" />
          <p class="suave" style="margin-top: 28px; text-align: center">
            <button @click="confirmandoSalida = true">Salir de este telefono</button>
          </p>
        </template>
      </template>
    </template>
  </main>

  <div v-if="confirmandoSalida" class="fondo" @click.self="confirmandoSalida = false">
    <div class="hoja">
      <h2>Salir de este telefono</h2>
      <p>
        Este telefono deja de tener acceso al panel en cuanto salgas, y para volver a
        entrar hace falta que Oscar mande un enlace nuevo.
      </p>
      <p class="suave">
        Si lo que quieres es solo dejarlo bloqueado un rato, usa el boton de bloquear:
        con tu PIN vuelves a entrar.
      </p>
      <button class="peligro" @click="confirmandoSalida = false; olvideElPin()">
        Si, salir de este telefono
      </button>
      <button style="margin-top: 10px" @click="confirmandoSalida = false">Mejor no</button>
    </div>
  </div>
</template>
