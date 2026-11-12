/**
 * Tests de `wallet.ts` que NO tocan la red. Usan una llave RSA generada en el momento,
 * asi que no leen ninguna credencial del proyecto.
 *
 * Lo que se prueba aqui es exactamente lo que fallo en H2: que el contador y el hero
 * salgan juntos, que el codigo de barras no lleve datos personales en el valor, y que
 * `notifyPreference` aparezca solo cuando debe.
 *
 * Lo que NO se puede probar aqui es que Google acepte la peticion ni que el telefono
 * reciba la notificacion. Eso es la aceptacion humana de H5.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import {
  cuerpoDeActualizacion,
  modulosDeTexto,
  porcentajeDelPremio,
  cuerpoDeCreacion,
  idDelObjeto,
  limpiarCache,
  linkDeGuardado,
  type EntornoWallet,
} from '../src/wallet.ts';
import { estadoInicial, type ConfiguracionPlan, type Estado } from '../src/mecanica.ts';

const plan: ConfiguracionPlan = {
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

const socia = {
  id: '30f4059d-e8f7-40e6-b5ac-5c047eb245ff',
  nombre: 'Maria Lopez',
};

async function entornoDePrueba(): Promise<EntornoWallet> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    GOOGLE_CLIENT_EMAIL: 'prueba@ejemplo.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: await exportPKCS8(privateKey),
    WALLET_ISSUER_ID: '3388000000023195590',
    WALLET_CLASE_ID: '3388000000023195590.fitjump_lealtad_v1',
    WALLET_BASE_IMAGENES: 'https://ejemplo.mx/imagenes',
  };
}

const conSellos = (sellos: number): Estado => ({ ...estadoInicial(), sellos });

describe('el contador y el hero van juntos en la misma peticion', () => {
  it('un solo cuerpo lleva el balance y la imagen, y los dos dicen el mismo numero', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeActualizacion(entorno, plan, conSellos(3), true) as any;
    expect(cuerpo.loyaltyPoints.balance.string).toBe('3 de 6');
    expect(cuerpo.heroImage.sourceUri.uri).toBe('https://ejemplo.mx/imagenes/hero-mensual-3.png');
  });

  it('el numero del contador y el del archivo nunca se separan, en ningun estado', async () => {
    const entorno = await entornoDePrueba();
    for (let sellos = 0; sellos <= plan.sellosTotales; sellos += 1) {
      const cuerpo = cuerpoDeActualizacion(entorno, plan, conSellos(sellos), false) as any;
      const texto: string = cuerpo.loyaltyPoints.balance.string;
      const uri: string = cuerpo.heroImage.sourceUri.uri;
      expect(texto).toBe(`${sellos} de ${plan.sellosTotales}`);
      expect(uri.endsWith(`hero-mensual-${sellos}.png`)).toBe(true);
    }
  });

  it('el balance es string, nunca int: mezclar los dos tipos rompe la actualizacion', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeActualizacion(entorno, plan, conSellos(2), true) as any;
    expect(typeof cuerpo.loyaltyPoints.balance.string).toBe('string');
    expect(cuerpo.loyaltyPoints.balance.int).toBeUndefined();
  });

  it('el plan semanal pide sus propios archivos, no los del mensual', async () => {
    const entorno = await entornoDePrueba();
    const semanal: ConfiguracionPlan = { ...plan, nombre: 'Semanal', sellosTotales: 8 };
    const cuerpo = cuerpoDeActualizacion(entorno, semanal, conSellos(7), false) as any;
    expect(cuerpo.loyaltyPoints.balance.string).toBe('7 de 8');
    expect(cuerpo.heroImage.sourceUri.uri).toContain('hero-semanal-7.png');
  });
});

describe('notifyPreference', () => {
  it('va en la peticion cuando hay que notificar', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeActualizacion(entorno, plan, conSellos(1), true);
    expect(cuerpo.notifyPreference).toBe('NOTIFY_ON_UPDATE');
  });

  it('no va cuando se deshace, para no gastar el cupo ni avisar de un error', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeActualizacion(entorno, plan, conSellos(1), false);
    expect(cuerpo.notifyPreference).toBeUndefined();
  });
});

describe('el objeto nuevo', () => {
  it('su id es el issuer mas el UUID de la socia, nunca el whatsapp ni el nombre', async () => {
    const entorno = await entornoDePrueba();
    expect(idDelObjeto(entorno, socia)).toBe(`3388000000023195590.${socia.id}`);
  });

  it('el codigo de barras lleva el UUID en el valor y el nombre en el texto legible', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeCreacion(entorno, socia, plan, estadoInicial()) as any;
    expect(cuerpo.barcode.value).toBe(socia.id);
    expect(cuerpo.barcode.alternateText).toBe(socia.nombre);
    // El valor del codigo no debe contener el nombre ni nada legible de la persona.
    expect(cuerpo.barcode.value).not.toContain(socia.nombre);
  });

  it('nace en la clase canonica, activo, y sin notificar', async () => {
    const entorno = await entornoDePrueba();
    const cuerpo = cuerpoDeCreacion(entorno, socia, plan, estadoInicial()) as any;
    expect(cuerpo.classId).toBe(entorno.WALLET_CLASE_ID);
    expect(cuerpo.state).toBe('ACTIVE');
    expect(cuerpo.accountId).toBe(plan.nombre);
    expect(cuerpo.notifyPreference).toBeUndefined();
    expect(cuerpo.loyaltyPoints.balance.string).toBe('0 de 6');
    expect(cuerpo.heroImage.sourceUri.uri).toContain('hero-mensual-0.png');
  });
});

describe('linkDeGuardado', () => {
  it('es un JWT savetowallet con audiencia google que referencia al objeto', async () => {
    limpiarCache();
    const entorno = await entornoDePrueba();
    const link = await linkDeGuardado(entorno, socia);
    expect(link.startsWith('https://pay.google.com/gp/v/save/')).toBe(true);

    const jwt = link.slice('https://pay.google.com/gp/v/save/'.length);
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');

    const cuerpo = decodeJwt(jwt) as any;
    expect(cuerpo.typ).toBe('savetowallet');
    expect(cuerpo.aud).toBe('google');
    expect(cuerpo.iss).toBe(entorno.GOOGLE_CLIENT_EMAIL);
    expect(cuerpo.payload.loyaltyObjects).toEqual([
      { id: `3388000000023195590.${socia.id}`, classId: entorno.WALLET_CLASE_ID },
    ]);
    // El limite practico del link son alrededor de 1800 caracteres.
    expect(link.length).toBeLessThan(1800);
    limpiarCache();
  });
});

describe('wallet.ts no sabe contar sellos', () => {
  it('no arma el texto del contador ni el nombre del hero por su cuenta', () => {
    const fuente = new URL('../src/wallet.ts', import.meta.url);
    const texto = readFileSync(fuente, 'utf8');
    // El unico lugar donde se arma el par es progresoDelPase, en mecanica.ts.
    expect(texto).toContain('progresoDelPase');
    expect(texto).not.toMatch(/`hero-\$\{/);
    expect(texto).not.toMatch(/\$\{.*\} de \$\{/);
  });
});

describe('los textos del premio', () => {
  it('el porcentaje se calcula del monto y el precio, nunca se escribe a mano', () => {
    expect(porcentajeDelPremio(40, 160)).toBe(25);
    expect(porcentajeDelPremio(80, 160)).toBe(50);
    // 140/550 es 25.4545, que redondea a 25.
    expect(porcentajeDelPremio(140, 550)).toBe(25);
    expect(porcentajeDelPremio(275, 550)).toBe(50);
  });

  it('un precio invalido no produce un texto con un porcentaje absurdo', () => {
    expect(porcentajeDelPremio(140, 0)).toBeNull();
    expect(porcentajeDelPremio(140, Number.NaN)).toBeNull();
    const sinPrecio = modulosDeTexto({ ...plan, precio: 0 }, conSellos(0));
    expect(sinPrecio.find((m) => m.id === 'premios')).toBeUndefined();
    // Los terminos siguen yendo: no dependen de ningun numero.
    expect(sinPrecio.find((m) => m.id === 'terminos')).toBeDefined();
  });

  it('la clausula de terminos y condiciones es la del 14 de octubre de 2026', () => {
    // ✅ APROBADO POR LA DUEÑA EL 14 DE OCTUBRE DE 2026. Queda fijado aqui porque ahora es
    // texto cerrado: lo que la socia tiene escrito en el telefono no debe poder cambiar por
    // un descuido, y menos ahora que ya nadie lo va a revisar.
    //
    // La version anterior prometia que el descuento se aplicaba "sobre el siguiente pago
    // del mismo plan en el que se lleno la plantilla". Eso quedo FALSO con la mecanica
    // del 14 de octubre: al cambiar de plan el premio pendiente se CANJEA en ese momento,
    // al monto del plan de origen, en vez de esperar un pago del plan viejo que ya no va
    // a ocurrir. Los tres pases emitidos siguen mostrando el texto viejo hasta H11.
    //
    // Se compara caracter por caracter a proposito: un cambio de una coma aqui cambia lo
    // que la socia tiene escrito en el telefono.
    const terminos = modulosDeTexto(plan, conSellos(0)).find((m) => m.id === 'terminos');
    expect(terminos?.body).toBe(
      'Los descuentos se obtienen y se aplican dentro del plan en el que se juntaron ' +
        'los sellos. Al llenar la plantilla, el descuento mayor queda disponible y los ' +
        'sellos vuelven a cero para empezar una plantilla nueva. Ese descuento se aplica ' +
        'automáticamente en el siguiente pago, sin necesidad de pedirlo. El descuento de ' +
        'la mitad de la plantilla se pide en recepción y, al canjearlo, los sellos ' +
        'vuelven a cero. Si la socia cambia de plan, los sellos vuelven a cero y ' +
        'cualquier descuento que ya tenga disponible se aplica en ese momento, por el ' +
        'valor que tenía en el plan donde lo obtuvo.',
    );
  });

  it('la clausula no depende del plan ni del numero de sellos', () => {
    // Es la MISMA frase para las dos modalidades y en cualquier punto de la plantilla:
    // describe el programa, no el estado de la socia. Si alguna vez interpola un numero,
    // deja de poder vivir en la clase y hay que moverla al objeto.
    const semanal: ConfiguracionPlan = {
      ...plan,
      nombre: 'Semanal',
      precio: 160,
      sellosTotales: 8,
      sellosPremioChico: 4,
      montoPremioChico: 40,
      montoPremioGrande: 80,
    };
    const base = modulosDeTexto(plan, conSellos(0)).find((m) => m.id === 'terminos')?.body;
    for (const [config, sellos] of [
      [plan, 3],
      [plan, 6],
      [semanal, 0],
      [semanal, 8],
    ] as const) {
      const otro = modulosDeTexto(config, conSellos(sellos)).find((m) => m.id === 'terminos');
      expect(otro?.body).toBe(base);
    }
  });

  it('el texto mensual es el aprobado el 13 de octubre de 2026', () => {
    const premios = modulosDeTexto(plan, conSellos(0)).find((m) => m.id === 'premios');
    expect(premios?.body).toBe(
      'Junta 3 sellos y recibe 25% de descuento en tu siguiente pago mensual. ' +
        'Si llenas los 6 sin canjear, recibes 50%.',
    );
  });

  it('el texto semanal es el aprobado el 13 de octubre de 2026', () => {
    const semanal: ConfiguracionPlan = {
      ...plan,
      nombre: 'Semanal',
      sellosTotales: 8,
      sellosPremioChico: 4,
      montoPremioChico: 40,
      montoPremioGrande: 80,
      precio: 160,
    };
    const premios = modulosDeTexto(semanal, conSellos(0)).find((m) => m.id === 'premios');
    expect(premios?.body).toBe(
      'Junta 4 sellos y recibe 25% de descuento en tu siguiente pago semanal. ' +
        'Si llenas los 8 sin canjear, recibes 50%.',
    );
  });

  it('si la junta cambia un monto, el texto del pase cambia solo', () => {
    const otro: ConfiguracionPlan = { ...plan, montoPremioChico: 110, montoPremioGrande: 330 };
    const premios = modulosDeTexto(otro, conSellos(0)).find((m) => m.id === 'premios');
    expect(premios?.body).toContain('recibe 20% de descuento');
    expect(premios?.body).toContain('recibes 60%');
  });

  it('el texto que ve la socia no lleva guiones', () => {
    for (const modulo of modulosDeTexto(plan, conSellos(0))) {
      expect(modulo.body).not.toContain('-');
      expect(modulo.header).not.toContain('-');
    }
  });

  it('los modulos viajan en cada actualizacion, no solo al crear', async () => {
    const entorno = await entornoDePrueba();
    const actualizacion = cuerpoDeActualizacion(entorno, plan, conSellos(4), true) as any;
    const creacion = cuerpoDeCreacion(entorno, socia, plan, estadoInicial()) as any;
    expect(actualizacion.textModulesData).toEqual(modulosDeTexto(plan, conSellos(4)));
    expect(creacion.textModulesData).toEqual(modulosDeTexto(plan, estadoInicial()));
  });

  it('wallet.ts no tiene ningun porcentaje escrito a mano', () => {
    const texto = readFileSync(new URL('../src/wallet.ts', import.meta.url), 'utf8');
    expect(texto).not.toMatch(/\d+\s*%/);
  });
});

describe('el modulo de premios tiene tres estados, y cambia por socia y por pago', () => {
  const conPremio = (premio: 'ninguno' | 'chico' | 'grande', sellos = 0): Estado => ({
    ...estadoInicial(),
    sellos,
    premioPendiente: premio,
  });

  const premios = (estado: Estado, configuracion = plan) =>
    modulosDeTexto(configuracion, estado).find((m) => m.id === 'premios')!.body;

  it('sin premio pendiente explica el programa, como siempre', () => {
    expect(premios(conPremio('ninguno', 2))).toBe(
      'Junta 3 sellos y recibe 25% de descuento en tu siguiente pago mensual. ' +
        'Si llenas los 6 sin canjear, recibes 50%.',
    );
  });

  it('con premio chico avisa que hay que pedirlo Y que al canjearlo la plantilla reinicia', () => {
    expect(premios(conPremio('chico', 3))).toBe(
      'Tienes 25% de descuento disponible. Pídelo en recepción al hacer tu siguiente pago. ' +
        'Al canjearlo tus sellos vuelven a cero y empiezas una plantilla nueva.',
    );
  });

  it('con premio grande avisa que NO hay que pedirlo y que la plantilla ya empezo de nuevo', () => {
    expect(premios(conPremio('grande', 0))).toBe(
      'Tienes 50% de descuento disponible. Se aplica solo en tu siguiente pago y no hace ' +
        'falta pedirlo. Tu plantilla ya empezó de nuevo.',
    );
  });

  it('los textos de los dos premios NO mencionan el plan', () => {
    const semanal: ConfiguracionPlan = {
      ...plan,
      nombre: 'Semanal',
      sellosTotales: 8,
      sellosPremioChico: 4,
      montoPremioChico: 40,
      montoPremioGrande: 80,
      precio: 160,
    };
    for (const estado of [conPremio('chico', 4), conPremio('grande', 0)]) {
      for (const configuracion of [plan, semanal]) {
        const cuerpo = premios(estado, configuracion) ?? '';
        expect(cuerpo.toLowerCase()).not.toContain('mensual');
        expect(cuerpo.toLowerCase()).not.toContain('semanal');
      }
    }
  });

  it('los porcentajes de los tres estados siguen saliendo de la base', () => {
    const otro: ConfiguracionPlan = { ...plan, montoPremioChico: 110, montoPremioGrande: 330 };
    expect(premios(conPremio('chico', 3), otro)).toContain('Tienes 20% de descuento');
    expect(premios(conPremio('grande', 0), otro)).toContain('Tienes 60% de descuento');
  });

  it('ninguno de los tres lleva guiones, porque los ve la socia', () => {
    for (const estado of [conPremio('ninguno'), conPremio('chico', 3), conPremio('grande')]) {
      expect(premios(estado)).not.toContain('-');
    }
  });

  it('el modulo viaja en el MISMO cuerpo que el contador y el hero, nunca aparte', () => {
    const entorno = {
      GOOGLE_CLIENT_EMAIL: 'x@y.z',
      GOOGLE_PRIVATE_KEY: 'no-se-usa',
      WALLET_ISSUER_ID: '3388000000023195590',
      WALLET_CLASE_ID: '3388000000023195590.fitjump_lealtad_v1',
      WALLET_BASE_IMAGENES: 'https://ejemplo.mx/imagenes',
    };
    const cuerpo = cuerpoDeActualizacion(entorno, plan, conPremio('grande', 0), true) as any;
    // Las tres cosas que cambian por socia, en una sola peticion: dos peticiones
    // gastarian dos notificaciones del cupo de tres por pase en 24 horas.
    expect(cuerpo.loyaltyPoints.balance.string).toBe('0 de 6');
    expect(cuerpo.heroImage.sourceUri.uri).toContain('hero-mensual-0.png');
    expect(cuerpo.textModulesData.find((m: any) => m.id === 'premios').body).toContain(
      'Se aplica solo en tu siguiente pago',
    );
    expect(cuerpo.notifyPreference).toBe('NOTIFY_ON_UPDATE');
  });
});
