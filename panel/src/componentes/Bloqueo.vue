<!--
  El PIN de cuatro digitos.

  ⚠️ QUE PROTEGE Y QUE NO, porque la diferencia importa: el PIN **solo bloquea la
  interfaz**. La credencial de verdad es la cookie del dispositivo, que es HttpOnly y
  ningun script puede leer. El PIN existe para que el telefono de la dueña, que se queda
  en el mostrador con el panel abierto, no registre un pago porque alguien lo rozo.

  ⚠️ POR ESO EL PIN SE GUARDA TAL CUAL EN `localStorage`, sin hash, y es a proposito:
  son cuatro digitos, o sea diez mil combinaciones, asi que cualquier hash se revierte
  en un instante. Guardarlo con hash no lo protegeria de nada y daria la impresion de
  que es un secreto. Lo que si es secreto vive en la cookie.
-->
<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  modo: { type: String, required: true }, // 'crear' o 'abrir'
  nombre: { type: String, default: '' },
});
const emitir = defineEmits(['listo', 'olvide']);

const tecleado = ref('');
const repeticion = ref('');
const confirmando = ref(false);
const error = ref('');

const actual = computed(() => (confirmando.value ? repeticion.value : tecleado.value));

const titulo = computed(() => {
  if (props.modo === 'abrir') return 'Escribe tu PIN';
  return confirmando.value ? 'Escribelo otra vez' : 'Elige un PIN de cuatro digitos';
});

function teclear(digito) {
  if (actual.value.length >= 4) return;
  error.value = '';
  if (confirmando.value) repeticion.value += digito;
  else tecleado.value += digito;
  if (actual.value.length === 4) setTimeout(revisar, 120);
}

function borrar() {
  error.value = '';
  if (confirmando.value) repeticion.value = repeticion.value.slice(0, -1);
  else tecleado.value = tecleado.value.slice(0, -1);
}

function revisar() {
  if (props.modo === 'abrir') {
    emitir('listo', tecleado.value);
    tecleado.value = '';
    return;
  }
  if (!confirmando.value) {
    confirmando.value = true;
    return;
  }
  if (repeticion.value !== tecleado.value) {
    error.value = 'Los dos no coinciden. Empieza otra vez.';
    tecleado.value = '';
    repeticion.value = '';
    confirmando.value = false;
    return;
  }
  emitir('listo', tecleado.value);
}

/** Lo llama el padre cuando el PIN no era el correcto. */
function rechazar(mensaje) {
  error.value = mensaje;
  tecleado.value = '';
  repeticion.value = '';
}

defineExpose({ rechazar });
</script>

<template>
  <div class="centrado">
    <h2>{{ titulo }}</h2>
    <p class="suave" v-if="modo === 'abrir'">Panel de {{ nombre }}</p>
    <p class="suave" v-else>
      Es para que nadie registre un pago si el telefono se queda abierto en el mostrador.
    </p>

    <div class="puntos">
      <span v-for="i in 4" :key="i" class="punto" :class="{ puesto: actual.length >= i }"></span>
    </div>

    <p v-if="error" class="recado mal">{{ error }}</p>

    <div class="teclado">
      <button v-for="d in [1, 2, 3, 4, 5, 6, 7, 8, 9]" :key="d" @click="teclear(String(d))">
        {{ d }}
      </button>
      <button class="vacio" disabled></button>
      <button @click="teclear('0')">0</button>
      <button @click="borrar" aria-label="Borrar">&lt;</button>
    </div>

    <p v-if="modo === 'abrir'" style="margin-top: 22px">
      <button @click="emitir('olvide')">Olvide mi PIN</button>
    </p>
  </div>
</template>
