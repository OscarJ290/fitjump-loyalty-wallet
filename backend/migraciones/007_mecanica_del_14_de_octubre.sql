-- 007_mecanica_del_14_de_octubre.sql
-- Los cambios de mecanica que Oscar cerro el 14 de octubre de 2026. Son columnas,
-- porque toda regla de mecanica es columna de `planes` y nunca constante en el codigo.
--
-- Lo que entra aqui:
--   1. `tope_sellos_al_cambiar_plan` se renombra a `tope_sellos_ajuste_manual`.
--   2. `canje_automatico_del_premio_grande`, columna nueva de `planes`.
--   3. `conserva_sellos_al_cambiar_plan` cambia de significado y pasa a false.
--   4. `premio_grande_usado_en_ciclo`, columna nueva de `socias`.

begin;

-- ---------------------------------------------------------------------------
-- 1. El tope ya no gobierna el cambio de plan, solo el ajuste manual
-- ---------------------------------------------------------------------------
-- Con la regla nueva, al cambiar de plan la plantilla siempre se va a cero, asi que
-- el tope deja de tener que ver con el cambio de plan. **Sigue siendo necesario para
-- el ajuste manual:** sin un techo de sellos_totales menos uno, recepcion podria
-- dejar a una socia en plantilla llena sin premio que canjear, que es el callejon
-- visual que la regla 4 existe para evitar.
--
-- El nombre viejo mentiria a partir de hoy, asi que se renombra.
alter table planes rename column tope_sellos_al_cambiar_plan to tope_sellos_ajuste_manual;

alter table planes rename constraint planes_tope_dentro_de_la_plantilla
  to planes_tope_ajuste_dentro_de_la_plantilla;

comment on column planes.tope_sellos_ajuste_manual is
  'Techo del ajuste manual de recepcion: sellos_totales menos uno. El ajuste nunca completa plantilla ni otorga premio. Cuando conserva_sellos_al_cambiar_plan esta en true, el cambio de plan tambien se acota con este valor, por compatibilidad con la regla vieja.';

-- ---------------------------------------------------------------------------
-- 2. El premio grande se canja solo en el pago siguiente
-- ---------------------------------------------------------------------------
-- Secuencia que define Oscar: la socia llena la plantilla y obtiene el premio grande;
-- los sellos se van a cero en el mismo movimiento y el premio queda PENDIENTE; en el
-- pago siguiente el premio se aplica solo, ese mismo pago le da su primer sello del
-- ciclo nuevo y la seccion de premios queda en blanco.
--
-- El premio CHICO no se canja solo: eso sigue siendo decision de la socia en el
-- mostrador, con el boton del panel.
alter table planes add column if not exists canje_automatico_del_premio_grande
  boolean not null default true;

comment on column planes.canje_automatico_del_premio_grande is
  'true: el premio grande pendiente se aplica solo en el siguiente pago, antes de sumar el sello de ese pago. El premio chico nunca se canja solo.';

-- ---------------------------------------------------------------------------
-- 3. conserva_sellos_al_cambiar_plan cambia de significado y pasa a false
-- ---------------------------------------------------------------------------
-- REGLA NUEVA (false, el default de hoy): al cambiar de plan la plantilla SIEMPRE se
-- va a cero. Si la socia tiene un premio pendiente, el premio SE CANJA, no se revoca,
-- y el monto es el del plan de ORIGEN, no el del plan al que se cambia. Si no tiene
-- premio, pierde los sellos que llevaba.
--
-- REGLA VIEJA (true): el comportamiento aprobado el 2 de octubre de 2026, sellos
-- conservados con el tope y sin canje forzado.
--
-- ⚠️ LA COLUMNA NO SE BORRA, Y ES UNA DECISION DELIBERADA DE OSCAR. De las reglas que
-- entraron el 14 de octubre, esta es la unica que REVERSA algo que la dueña ya habia
-- aprobado: el 2 de octubre aprobo que al cambiar de plan los sellos se conservan y
-- recepcion los ajusta a mano. Es la que mas probabilidad tiene de volver atras en la
-- junta final, y si vuelve atras tiene que ser un UPDATE de una linea y no una
-- migracion mas codigo en dos lenguajes.
--
-- ⚠️ HAY QUE DECIRSELO A LA DUEÑA. La regla nueva es menos favorable para la socia,
-- que pierde los sellos que llevaba. El canje forzado acota el daño, porque al menos
-- no pierde el premio ya ganado, pero sigue siendo un cambio sobre lo aprobado.
update planes
   set conserva_sellos_al_cambiar_plan = false
 where negocio_id = '11111111-1111-4111-8111-111111111111';

alter table planes alter column conserva_sellos_al_cambiar_plan set default false;

comment on column planes.conserva_sellos_al_cambiar_plan is
  'false (regla del 14 oct 2026): al cambiar de plan la plantilla se va a cero y el premio pendiente se canja al monto del plan de origen. true: regla del 2 oct 2026, los sellos se conservan acotados por tope_sellos_ajuste_manual y no hay canje forzado. Va a la junta final.';

-- ---------------------------------------------------------------------------
-- 4. La bandera del premio grande se persiste, ya no se fabrica en el codigo
-- ---------------------------------------------------------------------------
-- `api.ts` armaba este campo del estado en false a mano al leer la fila de la socia.
-- Hoy no importaba porque con reinicia_al_canjear_grande en true el canje limpia el
-- ciclo, pero el dia que esa bandera se ponga en false el premio grande se volveria a
-- otorgar solo, porque la plantilla seguiria llena. Se guarda, como las demas.
alter table socias add column if not exists premio_grande_usado_en_ciclo
  boolean not null default false;

comment on column socias.premio_grande_usado_en_ciclo is
  'Impide volver a otorgar el premio grande en el mismo ciclo. Solo importa cuando planes.reinicia_al_canjear_grande esta en false, porque con true el canje reinicia el ciclo y la bandera se limpia sola.';

-- ---------------------------------------------------------------------------
-- NOTA SOBRE premio_chico_borra_sellos, PARA QUIEN LEA ESTO EL AÑO QUE VIENE
-- ---------------------------------------------------------------------------
-- `premio_chico_borra_sellos` y `reinicia_al_canjear_chico` estan las dos aprobadas
-- por la dueña, y en `mecanica.ts` viven en la misma rama como un `if` y un `else if`:
--
--   si reinicia_al_canjear_chico  -> reinicia el ciclo
--   si no, si premio_chico_borra_sellos -> descuenta los sellos del premio
--
-- Consecuencia: **el dia que `reinicia_al_canjear_chico` se ponga en true,
-- `premio_chico_borra_sellos` queda inalcanzable.** No es el caso hoy: hoy
-- `reinicia_al_canjear_chico` esta en false, asi que la rama si se evalua, y lo que
-- pasa es que `premio_chico_borra_sellos` tambien esta en false y por eso no hace
-- nada. Las dos columnas se quedan y sus dos tests se quedan.

commit;
