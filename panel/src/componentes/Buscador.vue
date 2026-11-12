<!--
  Buscar a la socia por nombre o por telefono, y la lista de socias activas.

  OBJETIVO MEDIDO EN H12: encontrar por nombre, de 5 a 10 segundos. Por eso el campo
  nace enfocado, busca a los dos caracteres (que es lo que la API acepta) y no hay
  boton de buscar: un boton de buscar son dos toques mas por visita.

  ⭐ DESDE EL 27 DE OCTUBRE DE 2026 LA PANTALLA ABRE CON LA LISTA DE SOCIAS ACTIVAS, sin
  escribir nada. Antes abria vacia y decia "escribe dos letras del nombre y aparece la
  lista", lo que obligaba a saber el nombre antes de buscarlo. Con la lista a la vista,
  recepcion puede trabajar con el dedo y no con la memoria.

  ⚠️ SON DOS FUENTES Y UNA SOLA LISTA EN PANTALLA. Con menos de dos caracteres se ve la
  lista completa; a partir de dos, los resultados de la busqueda la reemplazan. Nunca se
  ven las dos a la vez, porque dos listas con el mismo aspecto, una debajo de otra, es
  justo como se toca el renglon equivocado.

  ⚠️ LA LISTA SE PIDE UNA SOLA VEZ, al montar. No se refresca al volver de una ficha a
  proposito: recepcion registra un pago y vuelve, y una lista que se recarga sola mueve
  los renglones bajo el dedo. El contador de sellos de la lista puede quedar un pago
  viejo; el numero que manda es el de la ficha, que si se lee fresco.

  Sin escaner: es H19 y va al final, y cuando llegue sera una capa encima de esta misma
  pantalla, que abre la ficha y nunca suma un sello.
-->
<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api, SinSesion } from '../api.js';

const emitir = defineEmits(['abrir', 'sinSesion']);

const texto = ref('');
const socias = ref([]);
const buscando = ref(false);
const error = ref('');
const campo = ref(null);
let ultima = 0;

/* La lista de socias activas, independiente de los resultados de busqueda. */
const lista = ref([]);
const faltan = ref(0);
const cargandoLista = ref(true);
const errorLista = ref('');

/** Lo que se pinta: los resultados si hay busqueda, la lista si no. */
const buscandoAlgo = computed(() => texto.value.trim().length >= 2);

/*
 * ⚠️ LAS DOS FUENTES NO TIENEN LA MISMA FORMA, y normalizarlas aqui es mas barato que
 * un `v-if` dentro del renglon. La busqueda pasa por `fichaDeSocia` y manda
 * `plan: { id, nombre, precio }`; la lista viene de una consulta plana y manda
 * `plan: "Mensual"`. **El precio de la busqueda se tira aqui a proposito:** este
 * renglon no muestra dinero y el panel interno lo muestra en la ficha, que es donde se
 * cobra.
 */
const visibles = computed(() =>
  (buscandoAlgo.value ? socias.value : lista.value).map((s) => ({
    id: s.id,
    nombre: s.nombre,
    esPrueba: s.esPrueba,
    sellos: s.sellos,
    sellosTotales: s.sellosTotales,
    plan: typeof s.plan === 'string' ? s.plan : (s.plan?.nombre ?? null),
  })),
);

onMounted(async () => {
  campo.value?.focus();
  try {
    const datos = await api.lista();
    lista.value = datos.socias;
    faltan.value = datos.faltan ?? 0;
  } catch (e) {
    if (e instanceof SinSesion) return emitir('sinSesion');
    // La lista es una comodidad, no el camino: si falla, el buscador sigue sirviendo y
    // el recado lo dice en vez de dejar la pantalla en blanco.
    errorLista.value = 'No pudimos cargar la lista. Busca por nombre mientras tanto.';
  } finally {
    cargandoLista.value = false;
  }
});

watch(texto, (valor) => {
  const limpio = valor.trim();
  error.value = '';
  if (limpio.length < 2) {
    socias.value = [];
    return;
  }
  // Se deja un respiro al dedo antes de salir a la red, pero corto: en el mostrador
  // medio segundo se siente.
  const mio = ++ultima;
  buscando.value = true;
  setTimeout(async () => {
    if (mio !== ultima) return;
    try {
      const datos = await api.buscar(limpio);
      // Si llego tarde, no pisa un resultado mas nuevo.
      if (mio !== ultima) return;
      socias.value = datos.socias;
    } catch (e) {
      if (e instanceof SinSesion) return emitir('sinSesion');
      error.value = 'No pudimos buscar. Revisa la señal y escribe otra letra.';
    } finally {
      if (mio === ultima) buscando.value = false;
    }
  }, 220);
});
</script>

<template>
  <input
    ref="campo"
    v-model="texto"
    type="search"
    inputmode="search"
    enterkeyhint="search"
    autocomplete="off"
    autocorrect="off"
    spellcheck="false"
    placeholder="Nombre o telefono de la socia"
    aria-label="Buscar socia"
  />

  <p v-if="error" class="recado mal" style="margin-top: 14px">{{ error }}</p>
  <p v-else-if="errorLista && !buscandoAlgo" class="recado mal" style="margin-top: 14px">
    {{ errorLista }}
  </p>

  <p v-if="!buscandoAlgo && cargandoLista" class="suave" style="margin-top: 16px">
    Cargando las socias...
  </p>

  <!--
    Una sola lista, dos fuentes. La `key` lleva de que fuente viene para que Vue no
    reuse un renglon de la lista como renglon de resultado: son el mismo componente y
    el mismo aspecto, y reusarlo deja el nombre viejo un cuadro de animacion.
  -->
  <div
    v-if="visibles.length"
    class="tarjeta"
    style="margin-top: 14px; padding: 4px 14px"
  >
    <ul class="lista">
      <li v-for="s in visibles" :key="(buscandoAlgo ? 'b:' : 'l:') + s.id">
        <button class="renglon" @click="emitir('abrir', s.id)">
          <!--
            La marca de prueba va junto al nombre y no al final del renglon: es lo que
            decide si recepcion debe o no registrarle un pago de verdad, asi que se lee
            antes de tocar, no despues. Mismo idioma que la ficha, que dice
            "cuenta de prueba", y sin CSS nuevo.
          -->
          <span class="nombre">
            {{ s.nombre }}<template v-if="s.esPrueba"> &middot; prueba</template>
          </span>
          <span class="dato">
            {{ s.sellos }} de {{ s.sellosTotales }}<br />
            {{ s.plan || 'sin plan' }}
          </span>
        </button>
      </li>
    </ul>
  </div>

  <!--
    Cuantas se quedaron fuera del tope de 100. El numero lo manda la API ya restado.
    Solo aparece con la lista, nunca con los resultados de busqueda, que tienen su
    propio tope de 20 y su propia forma de acotarse: escribir mas letras.
  -->
  <p v-if="!buscandoAlgo && faltan > 0" class="suave" style="margin-top: 12px">
    Se muestran las primeras {{ visibles.length }} en orden alfabetico. Faltan
    {{ faltan }} mas: buscala por su nombre.
  </p>

  <p v-else-if="buscandoAlgo && !visibles.length && !buscando" class="suave" style="margin-top: 16px">
    Ninguna socia con ese nombre. Si es nueva, se da de alta sola escaneando el codigo
    de la pared.
  </p>

  <p
    v-else-if="!buscandoAlgo && !cargandoLista && !visibles.length && !errorLista"
    class="suave"
    style="margin-top: 16px"
  >
    Todavia no hay socias dadas de alta. La primera se da de alta sola escaneando el
    codigo de la pared.
  </p>
</template>
