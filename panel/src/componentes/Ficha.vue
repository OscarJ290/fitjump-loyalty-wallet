<!--
  La ficha de la socia: lo que recepcion mira mientras cobra.

  CUATRO COSAS QUE ESTA PANTALLA NO PUEDE PROMETER NI ESCONDER, y que son requisito del
  hito, no decoracion:

  1. **La notificacion tarda de uno a dos minutos.** Esta medido. El panel confirma al
     instante contra la base, pero el pase de la socia no. Si recepcion no lo sabe, va a
     volver a picar el boton, y eso mete otro movimiento en un libro que no se puede
     borrar. Por eso la frase vive fija debajo del contador, no en una ayuda escondida.
  2. **El ajuste manual no puede devolver a una socia a plantilla llena.** El tope es
     `sellos_totales` menos uno. La pantalla lo dice ANTES, con el numero, y el boton
     de mas se apaga al llegar: recepcion no descubre el tope picandole.
  3. **El cambio de plan le borra todos los sellos** y, si tiene premio, se lo canja al
     monto del plan de origen. Se confirma con los dos numeros en pantalla.
  4. **El panel nunca espera a Wallet.** La operacion siguiente se puede hacer de
     inmediato. El estado del pase se muestra, no se espera.
-->
<script setup>
import { computed, onServerPrefetch, ref, watch } from 'vue';
import { api, ErrorDeApi, olvidarIntento, pesos, SinRed, SinSesion } from '../api.js';

const props = defineProps({
  sociaId: { type: String, required: true },
  planes: { type: Array, default: () => [] },
});
const emitir = defineEmits(['volver', 'sinSesion']);

const socia = ref(null);
const sincronizacion = ref(null);
const movimientos = ref([]);
const cargando = ref(true);
const ocupado = ref(false);
const recado = ref(null);
const hoja = ref(null);
const ajusteDestino = ref(0);

const plan = computed(() => props.planes.find((p) => p.id === socia.value?.plan?.id) ?? null);
const otrosPlanes = computed(() => props.planes.filter((p) => p.id !== socia.value?.plan?.id));
const tope = computed(() => plan.value?.topeSellosAjusteManual ?? 0);

/** Un circulo por casilla. Es lo que la socia ve en su pase, con los mismos numeros. */
const plantilla = computed(() => {
  if (!socia.value) return [];
  return Array.from({ length: socia.value.sellosTotales ?? 0 }, (_, i) => i < socia.value.sellos);
});

/**
 * Las tres frases dicen lo mismo en distinto momento: lo de aqui ya quedo guardado. Lo
 * unico que cambia es si el pase de la socia ya lo refleja.
 */
const textoDeSync = computed(() => {
  const estado = sincronizacion.value?.estado;
  if (estado === 'ok') return 'El pase de la socia esta al dia.';
  if (estado === 'pendiente') return 'Mandando el cambio al pase de la socia.';
  if (estado === 'error') return 'El pase no se ha podido actualizar. Se reintenta solo.';
  return '';
});

const claseDeSync = computed(() => {
  const estado = sincronizacion.value?.estado;
  if (estado === 'ok') return 'ok';
  if (estado === 'pendiente') return 'esperando';
  if (estado === 'error') return 'falla';
  return '';
});

const TIPOS = {
  pago: 'Pago',
  sello_bienvenida: 'Sello de bienvenida',
  canje_chico: 'Canje de descuento',
  canje_grande: 'Canje de descuento',
  cambio_plan: 'Cambio de plan',
  ajuste_manual: 'Ajuste de sellos',
  reverso: 'Movimiento deshecho',
};

/**
 * Solo se ofrece deshacer lo que el reverso sabe deshacer completo. Un canje no
 * devuelve el descuento y un cambio de plan no devuelve el plan, asi que esos dos no
 * llevan boton: el servidor tambien los rechaza, y aqui se explica por que.
 */
const DESHACIBLES = new Set(['pago', 'sello_bienvenida', 'ajuste_manual']);

const hora = (iso) =>
  new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

function decir(tipo, titulo, texto) {
  recado.value = { tipo, titulo, texto };
}

/** Traduce los efectos de la mecanica a lo que recepcion le tiene que DECIR a la socia. */
function loQueHayQueDecirle(efectos) {
  const frases = [];
  for (const efecto of efectos ?? []) {
    if (efecto.tipo === 'premio_otorgado' && efecto.premio === 'chico') {
      frases.push(`Ya tiene ${pesos(efecto.monto)} de descuento. Lo pide cuando quiera.`);
    }
    if (efecto.tipo === 'premio_otorgado' && efecto.premio === 'grande') {
      frases.push(
        `Lleno la plantilla: tiene ${pesos(efecto.monto)} de descuento y se le aplica solo en su siguiente pago. Los sellos vuelven a empezar.`,
      );
    }
    if (efecto.tipo === 'premio_canjeado') {
      frases.push(`Se aplico el descuento de ${pesos(efecto.monto)}.`);
    }
    if (efecto.tipo === 'premio_revocado') {
      frases.push('Con estos sellos el descuento que tenia ya no aplica.');
    }
  }
  return frases.join(' ');
}

async function cargar(silencioso = false) {
  if (!silencioso) cargando.value = true;
  try {
    const datos = await api.ficha(props.sociaId);
    socia.value = datos.socia;
    sincronizacion.value = datos.sincronizacion;
    movimientos.value = datos.movimientos;
    ajusteDestino.value = datos.socia.sellos;
  } catch (e) {
    if (e instanceof SinSesion) return emitir('sinSesion');
    decir('mal', 'No pudimos abrir la ficha', 'Revisa la señal y vuelve a intentar.');
  } finally {
    cargando.value = false;
  }
}

watch(() => props.sociaId, () => cargar(), { immediate: true });

/**
 * En el navegador esto no hace nada: el panel no se renderiza en ningun servidor.
 *
 * Existe para que `humo.js` pueda pedir esta pantalla YA CARGADA y comprobar lo que de
 * verdad se lee en ella, empezando por la frase de la espera de uno a dos minutos. Sin
 * esto, la prueba solo alcanzaba a ver el "Abriendo la ficha" y la pantalla que importa
 * se quedaba sin ninguna comprobacion automatica.
 */
onServerPrefetch(() => cargar());

/**
 * El camino de toda operacion que escribe.
 *
 * La clave de idempotencia la pone `api.js` y **se conserva hasta que el servidor
 * confirme**, asi que el reintento tras una caida de red no puede duplicar nada. Si
 * vuelve `repetida`, no es un error: es que la primera si habia llegado.
 */
async function operar(nombreDelIntento, accion, exito) {
  if (ocupado.value) return;
  ocupado.value = true;
  recado.value = null;
  hoja.value = null;
  try {
    const datos = await accion();
    socia.value = datos.socia;
    olvidarIntento(nombreDelIntento);
    if (datos.repetida) {
      decir('ojo', 'Eso ya estaba registrado', 'No se duplico nada. Asi quedo la ficha.');
    } else {
      exito(datos);
    }
    // La ficha completa (libro y estado del pase) se refresca despues de contestar: a
    // recepcion ya se le dijo lo importante.
    cargar(true);
  } catch (e) {
    if (e instanceof SinSesion) return emitir('sinSesion');
    if (e instanceof SinRed) {
      decir(
        'ojo',
        'No pudimos confirmar si se guardo',
        'Toca el boton otra vez: si ya se habia registrado, no se duplica.',
      );
    } else if (e instanceof ErrorDeApi) {
      decir('mal', e.message, e.datos.comoSeArregla ?? '');
    } else {
      decir('mal', 'Algo salio mal', 'Vuelve a intentar.');
    }
  } finally {
    ocupado.value = false;
  }
}

function registrarPago() {
  const intento = 'pago:' + props.sociaId;
  operar(intento, () => api.pago(props.sociaId), (datos) => {
    decir(
      'bien',
      `Listo. Lleva ${datos.socia.sellos} de ${datos.socia.sellosTotales} sellos.`,
      `${loQueHayQueDecirle(datos.efectos)} ${datos.avisoDeEspera}`.trim(),
    );
  });
}

function confirmarCanje() {
  hoja.value = {
    titulo: `Canjear ${pesos(socia.value.montoDelPremio)} de descuento`,
    lineas: [
      `Se le descuentan ${pesos(socia.value.montoDelPremio)} de su proximo pago del plan ${socia.value.plan.nombre}.`,
      'Al canjearlo, sus sellos vuelven a cero y empieza una plantilla nueva.',
      'Un canje no se deshace con el boton.',
    ],
    boton: 'Si, canjear',
    accion: () =>
      operar('canje:' + props.sociaId, () => api.canje(props.sociaId), (datos) => {
        decir('bien', 'Descuento aplicado', `${loQueHayQueDecirle(datos.efectos)} ${datos.avisoDeEspera}`.trim());
      }),
  };
}

function confirmarCambioDePlan(destino) {
  const lineas = [];
  if (socia.value.sellos > 0) {
    lineas.push(
      `Pierde los ${socia.value.sellos} sellos que lleva en el plan ${socia.value.plan.nombre}. La plantilla empieza de cero.`,
    );
  }
  if (socia.value.premioPendiente !== 'ninguno') {
    lineas.push(
      `Tiene ${pesos(socia.value.montoDelPremio)} de descuento disponible: se le aplica AHORA, al monto del plan ${socia.value.plan.nombre}, que es donde lo gano.`,
    );
  }
  lineas.push(`De aqui en adelante junta ${destino.sellosTotales} sellos, uno por cada pago de ${pesos(destino.precio)}.`);
  lineas.push('Esto no se deshace con el boton.');

  hoja.value = {
    titulo: `Cambiar al plan ${destino.nombre}`,
    lineas,
    boton: `Si, cambiar a ${destino.nombre}`,
    peligro: true,
    accion: () =>
      operar('plan:' + props.sociaId, () => api.cambiarPlan(props.sociaId, destino.id), (datos) => {
        decir(
          'bien',
          `Ahora esta en el plan ${destino.nombre}`,
          `${loQueHayQueDecirle(datos.efectos)} ${datos.avisoDeEspera}`.trim(),
        );
      }),
  };
}

function abrirAjuste() {
  ajusteDestino.value = socia.value.sellos;
  hoja.value = { ajuste: true };
}

function confirmarAjuste() {
  const destino = ajusteDestino.value;
  operar('ajuste:' + props.sociaId, () => api.ajuste(props.sociaId, destino), (datos) => {
    decir(
      'bien',
      `Queda en ${datos.socia.sellos} de ${datos.socia.sellosTotales} sellos`,
      'La socia no recibe notificacion por una correccion. Su pase se pone al dia en uno a dos minutos.',
    );
  });
}

async function deshacer(movimiento) {
  if (ocupado.value) return;
  ocupado.value = true;
  recado.value = null;
  try {
    const datos = await api.deshacer(movimiento.id);
    socia.value = datos.socia;
    decir(
      'bien',
      `Deshecho. Queda en ${datos.socia.sellos} de ${datos.socia.sellosTotales} sellos.`,
      'A la socia no le llega notificacion por una correccion.',
    );
    cargar(true);
  } catch (e) {
    if (e instanceof SinSesion) return emitir('sinSesion');
    if (e instanceof SinRed) decir('ojo', 'No pudimos confirmar', 'Vuelve a intentar en un momento.');
    else if (e instanceof ErrorDeApi) decir('mal', e.message, e.datos.comoSeArregla ?? '');
    else decir('mal', 'Algo salio mal', 'Vuelve a intentar.');
  } finally {
    ocupado.value = false;
  }
}
</script>

<template>
  <p v-if="cargando" class="suave">Abriendo la ficha...</p>

  <template v-else-if="socia">
    <button @click="emitir('volver')" style="margin-bottom: 14px">Buscar otra socia</button>

    <div v-if="recado" class="recado" :class="recado.tipo">
      <b>{{ recado.titulo }}</b>
      <span v-if="recado.texto">{{ recado.texto }}</span>
    </div>

    <!-- Contador y plantilla -->
    <div class="tarjeta">
      <h2>{{ socia.nombre }}</h2>
      <p class="suave">
        Plan {{ socia.plan ? socia.plan.nombre : 'sin asignar' }}
        <template v-if="socia.plan"> &middot; {{ pesos(socia.plan.precio) }}</template>
        <template v-if="socia.esPrueba"> &middot; cuenta de prueba</template>
      </p>

      <p class="cuenta" style="margin: 14px 0 0">
        {{ socia.sellos }} <small>de {{ socia.sellosTotales }} sellos</small>
      </p>

      <div class="plantilla">
        <span v-for="(lleno, i) in plantilla" :key="i" class="sello" :class="{ lleno }"></span>
      </div>

      <p class="suave" style="margin-top: 12px">
        Esto es lo que quedo registrado. El pase en el telefono de la socia tarda de uno a
        dos minutos en ponerse al dia.
      </p>

      <!--
        Como va el pase contra Google. Se muestra SIEMPRE, no solo cuando falla.

        ⚠️ Hasta el 18 de octubre de 2026 solo aparecia en el caso de error, y Oscar no
        lo vio en la prueba del telefono, con razon: el pase estaba al dia. El Paso 3
        de H8 pide mostrar el estado de la sincronizacion, no solo las malas noticias,
        asi que ahora hay una linea discreta siempre y el aviso grande cuando de verdad
        lleva intentos fallidos. Ninguno de los dos bloquea la operacion siguiente.
      -->
      <p v-if="sincronizacion" class="sincro" :class="claseDeSync">
        <span class="bolita"></span>
        <span>{{ textoDeSync }}</span>
      </p>

      <p v-if="sincronizacion && sincronizacion.estado === 'error'" class="recado ojo" style="margin-top: 12px">
        <b>El pase todavia no se actualiza</b>
        Lleva {{ sincronizacion.intentos }} intentos. Se reintenta solo cada media hora, y los
        sellos ya estan registrados aqui.
      </p>
    </div>

    <!-- Premio -->
    <div v-if="socia.premioPendiente !== 'ninguno'" class="tarjeta">
      <h3>Descuento disponible</h3>
      <p class="cuenta">{{ pesos(socia.montoDelPremio) }}</p>
      <template v-if="socia.premioPendiente === 'grande'">
        <p class="suave" style="margin-top: 10px">
          Se le aplica solo en su siguiente pago. No hay que tocar nada: al registrar el
          pago, el descuento se aplica y queda con un sello nuevo.
        </p>
      </template>
      <template v-else>
        <p class="suave" style="margin-top: 10px">
          Lo pide ella en el mostrador. Al canjearlo, la plantilla vuelve a empezar.
        </p>
        <button class="premio" :disabled="ocupado" @click="confirmarCanje" style="margin-top: 14px">
          Canjear {{ pesos(socia.montoDelPremio) }}
        </button>
      </template>
    </div>

    <!-- El boton del noventa por ciento de las visitas -->
    <div class="tarjeta">
      <button class="principal" :disabled="ocupado || !socia.plan" @click="registrarPago">
        {{ ocupado ? 'Registrando...' : 'Registrar pago de ' + (socia.plan ? pesos(socia.plan.precio) : '') }}
      </button>
      <div class="fila" style="margin-top: 10px">
        <button :disabled="ocupado" @click="abrirAjuste">Ajustar sellos</button>
        <button :disabled="ocupado || !otrosPlanes.length" @click="hoja = { planes: true }">
          Cambiar plan
        </button>
      </div>
    </div>

    <!-- El libro -->
    <div class="tarjeta">
      <h3>Movimientos</h3>
      <p v-if="!movimientos.length" class="suave">Todavia no tiene movimientos.</p>
      <ul class="lista">
        <li v-for="m in movimientos" :key="m.id">
          <div class="movimiento">
            <span style="flex: 1">
              {{ TIPOS[m.tipo] ?? m.tipo }}
              <template v-if="m.monto"> &middot; {{ pesos(Math.abs(m.monto)) }}</template>
              <br />
              <span class="cuando">
                {{ hora(m.creadoEn) }}
                <template v-if="m.sellosDelta">
                  &middot; {{ m.sellosDelta > 0 ? '+' : '' }}{{ m.sellosDelta }}
                  {{ Math.abs(m.sellosDelta) === 1 ? 'sello' : 'sellos' }}
                </template>
              </span>
            </span>
            <button
              v-if="m.sePuedeDeshacer && DESHACIBLES.has(m.tipo)"
              :disabled="ocupado"
              @click="deshacer(m)"
            >
              Deshacer
            </button>
          </div>
        </li>
      </ul>
      <p class="suave" style="margin-top: 10px">
        Nada se borra: deshacer agrega un movimiento que revierte al anterior, y solo
        durante diez minutos. Un canje y un cambio de plan no se deshacen con el boton.
      </p>
    </div>
  </template>

  <!-- ------------------------------------------------------------------ -->
  <!-- Hojas de confirmacion                                              -->
  <!-- ------------------------------------------------------------------ -->
  <div v-if="hoja" class="fondo" @click.self="hoja = null">
    <div class="hoja">
      <!-- Elegir plan destino -->
      <template v-if="hoja.planes">
        <h2>Cambiar de plan</h2>
        <p class="suave">
          Hazlo frente a la socia: le borra los sellos que lleva y eso hay que decirselo.
        </p>
        <button
          v-for="p in otrosPlanes"
          :key="p.id"
          style="margin-top: 10px"
          @click="confirmarCambioDePlan(p)"
        >
          Pasar a {{ p.nombre }}, {{ p.sellosTotales }} sellos de {{ pesos(p.precio) }}
        </button>
        <button style="margin-top: 16px" @click="hoja = null">Mejor no</button>
      </template>

      <!-- Ajuste de sellos -->
      <template v-else-if="hoja.ajuste">
        <h2>Ajustar sellos</h2>
        <p class="suave">
          Es para corregir un error, no para premiar. El ajuste llega hasta {{ tope }} sellos:
          nunca completa la plantilla ni entrega descuento.
        </p>
        <div class="fila" style="align-items: center; margin: 18px 0">
          <button :disabled="ajusteDestino <= 0" @click="ajusteDestino -= 1" aria-label="Menos">
            &minus;
          </button>
          <p class="cuenta" style="flex: 1; text-align: center; margin: 0">{{ ajusteDestino }}</p>
          <button :disabled="ajusteDestino >= tope" @click="ajusteDestino += 1" aria-label="Mas">
            +
          </button>
        </div>
        <p v-if="ajusteDestino >= tope" class="recado ojo">
          <b>Hasta aqui llega el ajuste</b>
          Si deberia tener {{ socia.sellosTotales }} sellos, lo correcto es deshacer los
          movimientos equivocados, no escribir el numero a mano.
        </p>
        <button
          class="principal"
          :disabled="ocupado || ajusteDestino === socia.sellos"
          @click="confirmarAjuste"
        >
          Dejarla en {{ ajusteDestino }} sellos
        </button>
        <button style="margin-top: 10px" @click="hoja = null">Mejor no</button>
      </template>

      <!-- Confirmacion con consecuencias -->
      <template v-else>
        <h2>{{ hoja.titulo }}</h2>
        <p v-for="(linea, i) in hoja.lineas" :key="i">{{ linea }}</p>
        <!-- Lo que borra sellos no se pinta con el color de marca: se pinta de aviso. -->
        <button
          :class="hoja.peligro ? 'peligro' : 'principal'"
          :disabled="ocupado"
          @click="hoja.accion()"
        >
          {{ hoja.boton }}
        </button>
        <button style="margin-top: 10px" @click="hoja = null">Mejor no</button>
      </template>
    </div>
  </div>
</template>
