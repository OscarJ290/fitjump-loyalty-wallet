// H2: prueba de la hora. Mide el CPU real de firmar un JWT RS256, cambiarlo por un
// access_token de Google y parchear un pase de Wallet. Worker desechable: se borra al
// terminar el hito. No es codigo de produccion.
import { importPKCS8, SignJWT } from 'jose';

interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  PRUEBA_CLAVE: string;
}

const AMBITO = 'https://www.googleapis.com/auth/wallet_object.issuer';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OBJETO_URL = 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/';

// Cache en variables de modulo. Vive mientras el aislado siga en pie. Nada de KV.
let llave: CryptoKey | null = null;
let token: string | null = null;
let tokenExpira = 0;

// En .dev.vars y en los secretos la llave viaja en una linea con los \n escapados.
// Si ya trae saltos reales, esto no hace nada.
const aPem = (valor: string) => valor.replace(/\\n/g, '\n');

async function obtenerToken(env: Env, ahora: number): Promise<{ valor: string; firmo: boolean }> {
  if (token && tokenExpira > ahora + 60) return { valor: token, firmo: false };

  llave ??= await importPKCS8(aPem(env.GOOGLE_PRIVATE_KEY), 'RS256');

  const assertion = await new SignJWT({ scope: AMBITO })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.GOOGLE_CLIENT_EMAIL)
    .setAudience(TOKEN_URL)
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + 3600)
    .sign(llave);

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = j.access_token;
  tokenExpira = ahora + j.expires_in;
  return { valor: token, firmo: true };
}

export default {
  async fetch(peticion: Request, env: Env): Promise<Response> {
    const u = new URL(peticion.url);

    if (u.pathname === '/') return new Response('prueba de firma en pie\n');
    if (u.pathname !== '/sellos') return new Response('no encontrado\n', { status: 404 });

    // El Worker queda publico mientras exista, asi que lleva clave para que nadie
    // mas pueda tocar un pase. Comparar dos cadenas no cuesta CPU medible.
    if (u.searchParams.get('clave') !== env.PRUEBA_CLAVE) {
      return new Response('clave invalida\n', { status: 401 });
    }

    const objeto = u.searchParams.get('objeto');
    const sellos = u.searchParams.get('sellos');
    const meta = u.searchParams.get('meta') ?? '6';
    const notificar = u.searchParams.get('notificar') === '1';
    if (!objeto || sellos === null) {
      return new Response('faltan los parametros objeto y sellos\n', { status: 400 });
    }

    const ahora = Math.floor(Date.now() / 1000);
    const { valor, firmo } = await obtenerToken(env, ahora);

    // Solo el balance. PATCH, no PUT, para no borrar los campos que no vienen.
    const cuerpo: Record<string, unknown> = {
      loyaltyPoints: { balance: { string: `${sellos} de ${meta}` } },
    };
    // notifyPreference es transitorio: va en cada peticion o no notifica.
    if (notificar) cuerpo.notifyPreference = 'NOTIFY_ON_UPDATE';

    const r = await fetch(OBJETO_URL + encodeURIComponent(objeto), {
      method: 'PATCH',
      headers: { authorization: `Bearer ${valor}`, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });

    // El cuerpo de Google solo se lee cuando falla: parsear el objeto completo
    // gastaria CPU sin necesidad.
    if (!r.ok) {
      const detalle = await r.text();
      console.log(`PATCH fallo ${r.status} firmo=${firmo} notificar=${notificar}`);
      return new Response(`google ${r.status}\n${detalle}\n`, { status: 502 });
    }

    console.log(`PATCH 200 balance="${sellos} de ${meta}" firmo=${firmo} notificar=${notificar}`);
    return new Response(`ok ${sellos} de ${meta} firmo=${firmo} notificar=${notificar}\n`);
  },
} satisfies ExportedHandler<Env>;
