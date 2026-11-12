-- 010_activacion_del_panel.sql
-- H8. Como entra una persona al panel la primera vez, decidido por Oscar el 16 de
-- octubre de 2026.
--
-- EL PROBLEMA QUE RESUELVE: el token de dispositivo es la llave permanente del panel.
-- Mandarlo por WhatsApp lo deja escrito para siempre en el historial de un telefono
-- que nadie controla, y un acceso indebido con ese token no deja rastro de ninguna
-- clase.
--
-- LA DECISION, con la razon de Oscar textual: "en un sistema donde el libro no se
-- puede borrar, que un acceso indebido sea visible vale mas que hacerlo improbable".
-- Por eso lo que viaja es un CODIGO DE ACTIVACION de un solo uso y con caducidad, y
-- no el token:
--
--   1. El token de dispositivo lo genera el Worker y nunca sale de la cookie
--      HttpOnly. Ninguna persona lo ve, asi que no puede quedar escrito en ningun
--      historial.
--   2. El codigo de activacion muere al primer uso o al caducar, lo que pase primero.
--      Lo que queda en el historial de WhatsApp es un enlace muerto.
--   3. Si alguien se adelanta y lo usa, la persona a la que iba dirigido lo nota de
--      inmediato, porque el suyo ya no abre. El robo es DETECTABLE, que es la razon
--      de fondo de la decision.
--
-- LAS DOS COSAS QUE OSCAR EXIGIO Y QUE EL ESQUEMA TIENE QUE SOSTENER:
--
--   REPOSICION. El codigo vive en UNA sola columna, asi que generar uno nuevo
--   sobrescribe el anterior y el viejo muere en ese momento, caducado o no. Reponer es
--   correr otra vez `acceso_panel.mjs enlace <nombre>`, sin tocar la base a mano.
--
--   REVOCACION. `token_hash` a nulo y `activo` en false, por persona. El invariante de
--   la migracion 003 (`activo = false or token_hash is not null`) acepta ese par, asi
--   que la fila sigue siendo valida y la persona sigue existiendo en el libro
--   contable, que no se puede borrar. **No hace falta una tabla de sesiones:** la
--   busqueda de la cookie es `where token_hash = ... and activo = true`, asi que en la
--   siguiente peticion ese telefono recibe un 401. Y no toca a los otros dos accesos.

begin;

-- ---------------------------------------------------------------------------
-- Las tres columnas de la activacion
-- ---------------------------------------------------------------------------
alter table usuarios_panel add column if not exists alta_hash      text;
alter table usuarios_panel add column if not exists alta_expira    timestamptz;
alter table usuarios_panel add column if not exists alta_creada_en timestamptz;

comment on column usuarios_panel.alta_hash is
  'SHA-256 del codigo de activacion de un solo uso, en hexadecimal. Nulo cuando no hay activacion pendiente. Nunca guarda el codigo, igual que token_hash nunca guarda el token.';
comment on column usuarios_panel.alta_expira is
  'Cuando deja de servir el codigo de activacion. Lo pone quien genera el enlace, no la base, porque la ventana es una decision de operacion y no del esquema.';
comment on column usuarios_panel.alta_creada_en is
  'Cuando se genero el codigo. Sirve para contar en el panel de estado cuantos enlaces se repusieron, que es la señal de que algo no esta llegando.';

-- Mismo formato que token_hash: 32 bytes en hexadecimal son 64 caracteres. Un check
-- sobre un valor nulo se considera satisfecho en PostgreSQL, asi que esto solo aplica
-- cuando hay activacion pendiente.
alter table usuarios_panel drop constraint if exists usuarios_panel_alta_hash_sha256;
alter table usuarios_panel add constraint usuarios_panel_alta_hash_sha256
  check (alta_hash is null or alta_hash ~ '^[0-9a-f]{64}$');

-- Dos personas no pueden compartir codigo. Es la misma defensa que token_unico, y
-- ademas vuelve imposible que un error de script le pegue el codigo de una a la fila
-- de otra.
alter table usuarios_panel drop constraint if exists usuarios_panel_alta_hash_unico;
alter table usuarios_panel add constraint usuarios_panel_alta_hash_unico
  unique (alta_hash);

-- Un codigo sin caducidad seria un token permanente con otro nombre, que es justo lo
-- que esta migracion existe para evitar. Los dos campos van juntos o no van.
alter table usuarios_panel drop constraint if exists usuarios_panel_alta_completa;
alter table usuarios_panel add constraint usuarios_panel_alta_completa
  check ((alta_hash is null) = (alta_expira is null));

commit;

-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACION NO HACE, A PROPOSITO
-- ---------------------------------------------------------------------------
-- 1. NO genera ningun codigo. Las tres filas siguen sin token y con activo en false,
--    como nacieron en la 003. El codigo se genera cuando Oscar va a entregar el
--    acceso, con `node backend/herramientas/acceso_panel.mjs enlace <nombre>`, y no
--    antes: un codigo creado hoy pasaria dias escrito en una pantalla sin usarse, que
--    es el mismo error que la 003 evito con el token.
--
-- 2. NO permite varios dispositivos por persona. Al consumirse una activacion, el
--    token nuevo REEMPLAZA al de esa fila, asi que el telefono anterior queda fuera en
--    su siguiente peticion. Una persona, un dispositivo activo. Varios dispositivos
--    pediria una tabla de sesiones y romperia la revocacion de una linea, que es lo
--    que Oscar pidio que existiera de verdad.
--
-- 3. NO cuenta intentos fallidos de activacion. El codigo es de 32 bytes aleatorios:
--    adivinarlo no es una amenaza que valga una columna. Lo que si importa, y por eso
--    existe `alta_creada_en`, es notar que a alguien hubo que reponerle el enlace
--    varias veces.
