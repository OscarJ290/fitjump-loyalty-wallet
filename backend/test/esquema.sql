-- backend\test\esquema.sql
-- Verificacion del esquema de H3. Se corre con psql contra la base de Neon:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/test/esquema.sql
-- Todo ocurre dentro de una transaccion que termina en rollback, asi que no deja
-- ninguna fila: se puede correr contra la base real sin ensuciarla.
-- Los mensajes OK llegan como NOTICE de psql. Cualquier linea FALLO es un defecto.
-- la base queda igual que antes de correr esto.
\set ON_ERROR_STOP on
begin;

\echo '--- preparacion: un negocio ajeno, una socia mensual y una semanal ---'
insert into negocios (id, nombre)
values ('99999999-9999-4999-8999-999999999999', 'Negocio Ajeno');

insert into socias (id, negocio_id, nombre, whatsapp, plan_id)
values ('aaaaaaaa-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111',
        'Socia Mensual', '+525512345678',
        '33333333-3333-4333-8333-333333333333');

insert into socias (id, negocio_id, nombre, whatsapp, plan_id)
values ('aaaaaaaa-0000-4000-8000-000000000002',
        '11111111-1111-4111-8111-111111111111',
        'Socia Semanal', '+525598765432',
        '22222222-2222-4222-8222-222222222222');

\echo
\echo '--- 1. aislamiento multi tenant: socia de un negocio con plan de otro ---'
do $$
begin
  insert into socias (negocio_id, nombre, whatsapp, plan_id)
  values ('99999999-9999-4999-8999-999999999999', 'Intrusa', '+525500000000',
          '33333333-3333-4333-8333-333333333333');
  raise exception 'FALLO: la base acepto una socia con el plan de otro negocio';
exception
  when foreign_key_violation then
    raise notice 'OK: la llave foranea compuesta lo rechaza';
end;
$$;

\echo
\echo '--- 2. whatsapp mal formado ---'
do $$
begin
  insert into socias (negocio_id, nombre, whatsapp, plan_id)
  values ('11111111-1111-4111-8111-111111111111', 'Mal Numero', '5512345678',
          '33333333-3333-4333-8333-333333333333');
  raise exception 'FALLO: acepto un whatsapp sin +52';
exception
  when check_violation then
    raise notice 'OK: exige +52 y diez digitos';
end;
$$;

\echo
\echo '--- 3. whatsapp repetido en el mismo negocio ---'
do $$
begin
  insert into socias (negocio_id, nombre, whatsapp, plan_id)
  values ('11111111-1111-4111-8111-111111111111', 'Repetida', '+525512345678',
          '33333333-3333-4333-8333-333333333333');
  raise exception 'FALLO: acepto un whatsapp duplicado';
exception
  when unique_violation then
    raise notice 'OK: unica por negocio y whatsapp';
end;
$$;

\echo
\echo '--- 4. el libro contable no se edita ni se borra ---'
insert into movimientos (id, negocio_id, socia_id, plan_id, tipo, sellos_delta, monto)
values ('bbbbbbbb-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'pago', 1, 550.00);

do $$
begin
  update movimientos set nota = 'editado'
   where id = 'bbbbbbbb-0000-4000-8000-000000000001';
  raise exception 'FALLO: se pudo editar un movimiento';
exception
  when raise_exception then
    raise notice 'OK: el trigger bloquea el update';
end;
$$;

do $$
begin
  delete from movimientos where id = 'bbbbbbbb-0000-4000-8000-000000000001';
  raise exception 'FALLO: se pudo borrar un movimiento';
exception
  when raise_exception then
    raise notice 'OK: el trigger bloquea el delete';
end;
$$;

\echo
\echo '--- 5. idempotencia: la misma clave dos veces ---'
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, clave_idempotencia)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'pago', 1, 'clave-de-prueba-001');
do $$
begin
  insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, clave_idempotencia)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'pago', 1, 'clave-de-prueba-001');
  raise exception 'FALLO: acepto la misma clave de idempotencia dos veces';
exception
  when unique_violation then
    raise notice 'OK: la clave de idempotencia es unica';
end;
$$;

\echo
\echo '--- 6. mensual: 1 pago mas 1 idempotente mas bienvenida = 3 sellos, premio chico ---'
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'sello_bienvenida', 1);
select * from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000001');

\echo
\echo '--- 7. semanal: 8 pagos sin canjear el chico = premio GRANDE y plantilla YA EN CERO (regla del 14 oct) ---'
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta)
select '11111111-1111-4111-8111-111111111111',
       'aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'pago', 1
  from generate_series(1, 8);
select * from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000002');

\echo
\echo '--- 8. mensual: canjear el chico REINICIA la plantilla y abre ciclo nuevo (migracion 009) ---'
-- ⚠️ ESTA COMPROBACION CAMBIO DE SIGNIFICADO EL 14 DE OCTUBRE DE 2026, y es el motivo
-- por el que corre contra las filas VIVAS de `planes` y no contra constantes.
--
-- Antes de la migracion 009, con `reinicia_al_canjear_chico` en false, media la regla 4:
-- la socia canjeaba el chico, seguia pagando, llenaba la plantilla y reiniciaba SIN
-- premio. Terminaba en 1 sello y sin premio.
--
-- Con 009 la regla 4 ya no puede ocurrir, porque el canje del chico limpia la bandera.
-- Ahora mide el reinicio al canjear: la plantilla vuelve a cero, el ciclo queda limpio y
-- la socia puede volver a ganar el premio chico. Termina en 3 sellos con el chico otra
-- vez disponible.
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'pago', 1);
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, monto)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'canje_chico', 0, 140.00);
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta)
select '11111111-1111-4111-8111-111111111111',
       'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'pago', 1
  from generate_series(1, 3);
select * from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000001');

-- Y ahora se asevera, en vez de solo imprimir: si la mecanica cambia sin que nadie
-- actualice esto, el test falla en vez de pasar mostrando otro numero.
do $$
declare
  r record;
  b_reinicia boolean;
begin
  select reinicia_al_canjear_chico into b_reinicia
    from planes where id = '33333333-3333-4333-8333-333333333333';
  select * into r from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000001');

  if b_reinicia then
    -- Con el reinicio encendido, el canje abrio ciclo nuevo y los tres pagos siguientes
    -- la dejan otra vez en el umbral del premio chico.
    if r.sellos_actuales <> 3 or r.premio_pendiente <> 'chico'
       or r.premio_chico_usado_en_ciclo then
      raise exception 'FALLO: con el reinicio encendido se esperaba 3, chico, false, y llego %, %, %',
        r.sellos_actuales, r.premio_pendiente, r.premio_chico_usado_en_ciclo;
    end if;
    raise notice 'OK: el canje del chico reinicio la plantilla y volvio a ganar el premio chico';
  else
    -- El comportamiento anterior a 009, que vuelve si la junta apaga la bandera.
    if r.sellos_actuales <> 1 or r.premio_pendiente <> 'ninguno' then
      raise exception 'FALLO: con el reinicio apagado se esperaba 1, ninguno, y llego %, %',
        r.sellos_actuales, r.premio_pendiente;
    end if;
    raise notice 'OK: regla 4, llenar la plantilla con el chico ya usado reinicia sin premio';
  end if;
end;
$$;

\echo
\echo '--- 9. el tope del ajuste manual nunca completa plantilla: pide 99, debe dar 7 y sin premio ---'
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, nota)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'ajuste_manual', 99,
        'ajuste exagerado a proposito');
select sellos_actuales as sellos_tras_pedir_99,
       premio_pendiente
  from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000002');

\echo
\echo '--- 10. un reverso no deja premio pendiente colgado ---'
insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, movimiento_reversado_id)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'reverso', -1,
        'bbbbbbbb-0000-4000-8000-000000000001');
select * from recalcular_estado('aaaaaaaa-0000-4000-8000-000000000001');

\echo
\echo '--- 11. un movimiento no se puede reversar dos veces ---'
do $$
begin
  insert into movimientos (negocio_id, socia_id, plan_id, tipo, sellos_delta, movimiento_reversado_id)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'reverso', -1,
          'bbbbbbbb-0000-4000-8000-000000000001');
  raise exception 'FALLO: reverso doble aceptado';
exception
  when unique_violation then
    raise notice 'OK: un movimiento solo se reversa una vez';
end;
$$;

rollback;

\echo
\echo '--- la base quedo como estaba: filas reales por tabla ---'
select 'negocios' as tabla, count(*) from negocios
union all select 'planes', count(*) from planes
union all select 'socias', count(*) from socias
union all select 'movimientos', count(*) from movimientos
union all select 'usuarios_panel', count(*) from usuarios_panel
union all select 'sync_wallet', count(*) from sync_wallet;
