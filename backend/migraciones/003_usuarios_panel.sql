-- 003_usuarios_panel.sql
-- Los tres accesos del panel: uno por persona, nunca uno compartido, para que cada
-- movimiento quede firmado con quien lo hizo y se pueda revocar uno sin tocar los otros.
--
-- AQUI VAN SOLO NOMBRES DE PILA, a proposito. Este archivo es versionado y el repo se
-- vuelve publico en H18. El panel solo necesita mostrar quien hizo cada movimiento.
-- Los nombres completos viven unicamente en credenciales\datos.md, que esta en
-- .gitignore.
--
-- LAS FILAS NACEN SIN TOKEN. El token de dispositivo se genera al dar el acceso, en H8.
-- Un token creado hoy pasaria dias escrito en un archivo sin usarse. Mientras no haya
-- token, la fila queda con activo en false y no puede iniciar sesion.

begin;

-- 001 creo token_hash como not null, pensando en filas que nacen con su token. Las
-- filas nacen antes del token, asi que la columna se vuelve opcional y el invariante
-- se mueve a donde de verdad importa: sin token no se puede estar activo.
alter table usuarios_panel alter column token_hash drop not null;

alter table usuarios_panel drop constraint if exists usuarios_panel_activo_exige_token;
alter table usuarios_panel add constraint usuarios_panel_activo_exige_token
  check (activo = false or token_hash is not null);

-- El check del formato sigue aplicando cuando el token exista: en PostgreSQL un check
-- sobre un valor nulo no falla, se considera satisfecho.

insert into usuarios_panel (id, negocio_id, nombre, token_hash, activo)
values
  ('44444444-4444-4444-8444-444444444441',
   '11111111-1111-4111-8111-111111111111', 'Oscar', null, false),
  ('44444444-4444-4444-8444-444444444442',
   '11111111-1111-4111-8111-111111111111', 'Recepcion A', null, false),
  ('44444444-4444-4444-8444-444444444443',
   '11111111-1111-4111-8111-111111111111', 'Recepcion B', null, false)
on conflict (id) do nothing;

commit;
