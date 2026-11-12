-- 004_recalcular_simulado.sql
-- Parte la funcion de recalculo en dos, sin cambiar la mecanica:
--
--   recalcular_simulado(configuracion, tipos[], deltas[])  <- el replay puro
--   recalcular_estado(socia)                               <- lee el plan y el libro
--                                                             y llama al replay puro
--
-- Hay dos razones.
--
-- 1. El replay puro se puede probar sin escribir ni una fila. El test cruzado de H4
--    compara mecanica.ts contra esta funcion sobre secuencias aleatorias de fast-check:
--    con la version anterior habria que insertar movimientos de prueba, y movimientos
--    tiene triggers que impiden borrarlos.
-- 2. Una sola implementacion de la mecanica en SQL, con dos puertas de entrada.
--
-- ⚠️ REGLA DURA, decidida el 13 de octubre de 2026: backend\src\mecanica.ts ES LA
-- AUTORIDAD. Esto es herramienta de auditoria y reparacion, y NUNCA se llama en la ruta
-- viva de la API.
--
-- REGLA CONFIRMADA el 13 de octubre de 2026: ajuste_manual NUNCA otorga premio, igual
-- que cambio_plan. Ya no es un supuesto.

begin;

create or replace function recalcular_simulado(
  p_sellos_totales      integer,
  p_sellos_premio_chico integer,
  p_reinicia_grande     boolean,
  p_reinicia_chico      boolean,
  p_borra_sellos        boolean,
  p_suma_con_pendiente  boolean,
  p_tope                integer,
  p_tipos               text[],
  p_deltas              integer[]
)
returns table (
  sellos_actuales             integer,
  premio_pendiente            text,
  premio_chico_usado_en_ciclo boolean
)
language plpgsql
immutable
as $$
declare
  i              integer;
  v_tipo         text;
  v_delta        integer;
  v_sellos       integer := 0;
  v_premio       text    := 'ninguno';
  v_chico_usado  boolean := false;
  -- Solo importa cuando reinicia_al_canjear_grande es false. Hoy es true, asi que
  -- canjear el grande reinicia el ciclo y esta bandera se limpia sola. Sin ella, con
  -- reinicio apagado el premio grande se volveria a otorgar solo, porque la plantilla
  -- seguiria llena.
  v_grande_usado boolean := false;
begin
  if array_length(p_tipos, 1) is distinct from array_length(p_deltas, 1) then
    raise exception 'tipos y deltas deben tener la misma longitud';
  end if;

  for i in 1 .. coalesce(array_length(p_tipos, 1), 0) loop
    v_tipo  := p_tipos[i];
    v_delta := p_deltas[i];

    if v_tipo in ('pago', 'sello_bienvenida') then
      -- Regla 5: con premio pendiente, el sello se suma solo si el plan lo permite.
      if v_premio = 'ninguno' or p_suma_con_pendiente then
        v_sellos := least(v_sellos + v_delta, p_sellos_totales);
      end if;

      if v_sellos >= p_sellos_totales then
        if v_chico_usado then
          -- Regla 4: ya uso el premio chico en este ciclo, asi que al llenar la
          -- plantilla reinicia SIN premio y empieza un ciclo nuevo. Dejarla congelada
          -- en lleno mata el pase visualmente.
          v_sellos       := 0;
          v_premio       := 'ninguno';
          v_chico_usado  := false;
          v_grande_usado := false;
        elsif not v_grande_usado then
          -- Llenar la plantilla sin haber canjeado el chico otorga el grande, y
          -- reemplaza al chico si estaba pendiente: no son acumulables, y nunca hay
          -- dos premios pendientes a la vez (regla 3).
          v_premio := 'grande';
        end if;
      elsif v_premio = 'ninguno'
            and v_sellos >= p_sellos_premio_chico
            and not v_chico_usado then
        v_premio := 'chico';
      end if;

    elsif v_tipo = 'canje_chico' then
      v_premio      := 'ninguno';
      v_chico_usado := true;
      if p_reinicia_chico then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      elsif p_borra_sellos then
        v_sellos := greatest(v_sellos - p_sellos_premio_chico, 0);
      end if;

    elsif v_tipo = 'canje_grande' then
      v_premio       := 'ninguno';
      v_grande_usado := true;
      if p_reinicia_grande then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      end if;

    elsif v_tipo in ('cambio_plan', 'ajuste_manual') then
      -- Regla 7: el ajuste nunca completa plantilla ni otorga premio. El tope sale de
      -- la configuracion del plan. ajuste_manual se trata igual que cambio_plan:
      -- confirmado el 13 de octubre de 2026.
      v_sellos := greatest(least(v_sellos + v_delta, p_tope), 0);
      -- Si el ajuste la deja por debajo de lo que ya tenia ganado, el premio pendiente
      -- se revoca, pero nunca se otorga uno nuevo.
      if v_premio = 'grande' and v_sellos < p_sellos_totales then
        v_premio := 'ninguno';
      end if;
      if v_premio = 'chico' and v_sellos < p_sellos_premio_chico then
        v_premio := 'ninguno';
      end if;

    elsif v_tipo = 'reverso' then
      v_sellos := greatest(least(v_sellos + v_delta, p_sellos_totales), 0);
      -- Deshacer solo puede quitar premios, nunca otorgarlos. Si cae por debajo del
      -- umbral del grande pero sigue arriba del chico, y no habia canjeado el chico,
      -- el estado correcto es el chico pendiente.
      if v_premio = 'grande' and v_sellos < p_sellos_totales then
        if v_sellos >= p_sellos_premio_chico and not v_chico_usado then
          v_premio := 'chico';
        else
          v_premio := 'ninguno';
        end if;
      elsif v_premio = 'chico' and v_sellos < p_sellos_premio_chico then
        v_premio := 'ninguno';
      end if;

    else
      raise exception 'tipo de movimiento desconocido: %', v_tipo;
    end if;
  end loop;

  return query select v_sellos, v_premio, v_chico_usado;
end;
$$;

comment on function recalcular_simulado(
  integer, integer, boolean, boolean, boolean, boolean, integer, text[], integer[]
) is
  'Replay puro de la mecanica, sin tocar tablas. Herramienta de auditoria: la autoridad es backend/src/mecanica.ts.';

-- El recalculo de una socia real pasa a ser un envoltorio del replay puro.
create or replace function recalcular_estado(p_socia_id uuid)
returns table (
  sellos_actuales             integer,
  premio_pendiente            text,
  premio_chico_usado_en_ciclo boolean
)
language plpgsql
as $$
declare
  r_plan  record;
  v_tipos text[];
  v_deltas integer[];
begin
  select p.sellos_totales,
         p.sellos_premio_chico,
         p.reinicia_al_canjear_grande,
         p.reinicia_al_canjear_chico,
         p.premio_chico_borra_sellos,
         p.suma_sello_con_premio_pendiente,
         p.tope_sellos_al_cambiar_plan
    into r_plan
    from socias s
    join planes p on p.id = s.plan_id and p.negocio_id = s.negocio_id
   where s.id = p_socia_id;

  if not found then
    raise exception 'la socia % no existe o no tiene plan asignado', p_socia_id;
  end if;

  -- El orden es la secuencia de insercion, nunca creado_en: dentro de una transaccion
  -- now() es constante y el orden quedaria indefinido.
  select coalesce(array_agg(m.tipo order by m.secuencia), '{}'::text[]),
         coalesce(array_agg(m.sellos_delta order by m.secuencia), '{}'::integer[])
    into v_tipos, v_deltas
    from movimientos m
   where m.socia_id = p_socia_id;

  return query
    select *
      from recalcular_simulado(
        r_plan.sellos_totales,
        r_plan.sellos_premio_chico,
        r_plan.reinicia_al_canjear_grande,
        r_plan.reinicia_al_canjear_chico,
        r_plan.premio_chico_borra_sellos,
        r_plan.suma_sello_con_premio_pendiente,
        r_plan.tope_sellos_al_cambiar_plan,
        v_tipos,
        v_deltas
      );
end;
$$;

comment on function recalcular_estado(uuid) is
  'Red de seguridad: reconstruye el estado de una socia releyendo movimientos desde cero. NUNCA se llama en la ruta viva de la API. La autoridad de la mecanica es backend/src/mecanica.ts.';

commit;
