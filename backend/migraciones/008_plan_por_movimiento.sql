-- 008_plan_por_movimiento.sql
-- Arregla un defecto encontrado el 14 de octubre de 2026 auditando `mecanica.ts`.
--
-- EL DEFECTO: `reconstruir` recibia UN plan y lo aplicaba a todo el libro, y
-- `recalcular_simulado` recibia `sellos_totales` y `sellos_premio_chico` como
-- escalares. Si una socia cambio de plan, los movimientos anteriores al cambio se
-- reevaluaban con los umbrales del plan nuevo.
--
-- ⚠️ **LAS DOS IMPLEMENTACIONES ESTABAN EQUIVOCADAS DE LA MISMA FORMA, ASI QUE EL TEST
-- CRUZADO PASABA EN VERDE.** Es la leccion del 13 de octubre otra vez: comparar dos
-- implementaciones solo detecta divergencias, nunca errores compartidos. Por eso el
-- arreglo entra con una propiedad nueva de fast-check que reconstruye libros que
-- CRUZAN planes, no con un caso de ejemplo.
--
-- Y caia justo sobre la funcion a la que uno le va a creer el dia que haya que
-- reparar a una socia a mano.
--
-- EL ARREGLO: el plan vigente viaja por movimiento, no por libro.

begin;

-- ---------------------------------------------------------------------------
-- 1. Cada fila del libro dice con que plan se evalua
-- ---------------------------------------------------------------------------
-- SEMANTICA: `plan_id` es el plan con el que ESA fila se evalua, no el plan "actual"
-- de la socia. Para el canje forzado de un cambio de plan es el plan de ORIGEN; para
-- la fila de `cambio_plan` es el plan NUEVO. Asi el replay no necesita saber ninguna
-- regla: usa la configuracion que cada fila trae.
--
-- Se puede exigir `not null` sin dolor porque la tabla esta vacia: cero filas
-- verificadas el 14 de octubre de 2026. Y conviene que lo sea, porque obliga a que
-- toda escritura diga con que plan se evalua.
alter table movimientos add column plan_id uuid not null;

-- Llave foranea compuesta, igual que el resto del esquema: un movimiento no puede
-- apuntar al plan de otro negocio.
alter table movimientos add constraint movimientos_plan_fk
  foreign key (plan_id, negocio_id) references planes (id, negocio_id);

comment on column movimientos.plan_id is
  'El plan con el que ESTA fila se evalua. En el canje forzado de un cambio de plan es el plan de origen; en la fila de cambio_plan es el plan nuevo.';

-- ⚠️ LIMITACION CONOCIDA, ANOTADA A PROPOSITO Y NO RESUELTA HOY:
-- `plan_id` apunta a una fila de `planes` que es EDITABLE. Si manana cambia
-- `sellos_totales` o un monto de ese plan, `recalcular_estado` relee el libro viejo
-- con la configuracion nueva y **la historia cambia retroactivamente.** El libro es
-- inmutable; el plan al que apunta no lo es.
-- Congelar la configuracion dentro de cada fila (guardar el snapshot del plan en el
-- movimiento, en vez de una referencia) es v2 y no se hace ahora.

-- ---------------------------------------------------------------------------
-- 2. El replay puro recibe el plan por elemento
-- ---------------------------------------------------------------------------
-- Antes: recalcular_simulado(7 escalares, tipos[], deltas[]).
-- Ahora: recalcular_simulado(jsonb), donde cada elemento es
--   {"tipo": "...", "delta": 1, "plan": { ...las reglas de ese plan... }}
--
-- Espejo exacto de la funcion `paso` de backend\src\mecanica.ts. Si una de las dos
-- cambia, la otra tambien, o el test cruzado falla. La autoridad es mecanica.ts.
drop function if exists recalcular_simulado(
  integer, integer, boolean, boolean, boolean, boolean, integer, text[], integer[]
);

create or replace function recalcular_simulado(p_movimientos jsonb)
returns table (
  sellos_actuales             integer,
  premio_pendiente            text,
  premio_chico_usado_en_ciclo boolean,
  premio_grande_usado_en_ciclo boolean
)
language plpgsql
immutable
as $$
declare
  r              jsonb;
  v_tipo         text;
  v_delta        integer;
  -- Las reglas del plan de ESTE movimiento.
  n_totales      integer;
  n_chico        integer;
  b_rei_grande   boolean;
  b_rei_chico    boolean;
  b_borra        boolean;
  b_suma         boolean;
  n_tope         integer;
  -- El estado que se va acumulando.
  v_sellos       integer := 0;
  v_premio       text    := 'ninguno';
  v_chico_usado  boolean := false;
  v_grande_usado boolean := false;
begin
  if p_movimientos is null or jsonb_typeof(p_movimientos) <> 'array' then
    raise exception 'recalcular_simulado espera un arreglo jsonb de movimientos';
  end if;

  for r in select * from jsonb_array_elements(p_movimientos) loop
    v_tipo  := r ->> 'tipo';
    v_delta := coalesce((r ->> 'delta')::integer, 0);

    n_totales    := (r -> 'plan' ->> 'sellos_totales')::integer;
    n_chico      := (r -> 'plan' ->> 'sellos_premio_chico')::integer;
    b_rei_grande := (r -> 'plan' ->> 'reinicia_al_canjear_grande')::boolean;
    b_rei_chico  := (r -> 'plan' ->> 'reinicia_al_canjear_chico')::boolean;
    b_borra      := (r -> 'plan' ->> 'premio_chico_borra_sellos')::boolean;
    b_suma       := (r -> 'plan' ->> 'suma_sello_con_premio_pendiente')::boolean;
    n_tope       := (r -> 'plan' ->> 'tope_sellos_ajuste_manual')::integer;

    if n_totales is null or n_chico is null then
      raise exception 'al movimiento % le falta la configuracion del plan', v_tipo;
    end if;

    if v_tipo in ('pago', 'sello_bienvenida') then
      -- Regla 5: con premio pendiente, el sello se suma solo si el plan lo permite.
      if v_premio = 'ninguno' or b_suma then
        -- Acotado por los dos lados: el limite de abajo lo encontro fast-check el 13
        -- de octubre con una fila de tipo pago y delta negativo.
        v_sellos := greatest(least(v_sellos + v_delta, n_totales), 0);
      end if;

      if v_sellos >= n_totales then
        if v_chico_usado then
          -- Regla 4: ya uso el premio chico en este ciclo, asi que al llenar la
          -- plantilla reinicia SIN premio y empieza un ciclo nuevo.
          v_sellos       := 0;
          v_premio       := 'ninguno';
          v_chico_usado  := false;
          v_grande_usado := false;
        elsif not v_grande_usado then
          -- REGLA DEL 14 DE OCTUBRE: se otorga el premio grande, los sellos se van a
          -- cero en el MISMO movimiento, y el premio queda PENDIENTE. La socia ve la
          -- plantilla vacia y la seccion de premios mostrando el grande.
          v_premio       := 'grande';
          v_sellos       := 0;
          v_chico_usado  := false;
          v_grande_usado := false;
        end if;
      elsif v_premio = 'ninguno'
            and v_sellos >= n_chico
            and not v_chico_usado then
        v_premio := 'chico';
      end if;

    elsif v_tipo = 'canje_chico' then
      v_premio      := 'ninguno';
      v_chico_usado := true;
      if b_rei_chico then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      elsif b_borra then
        -- Inalcanzable el dia que reinicia_al_canjear_chico se ponga en true, porque
        -- esto es un else if. Hoy se evalua, y no hace nada porque la bandera esta en
        -- false. Ver la nota de 007.
        v_sellos := greatest(v_sellos - n_chico, 0);
      end if;

    elsif v_tipo = 'canje_grande' then
      v_premio       := 'ninguno';
      v_grande_usado := true;
      if b_rei_grande then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      end if;

    elsif v_tipo in ('cambio_plan', 'ajuste_manual') then
      -- El ajuste nunca completa plantilla ni otorga premio. El tope sale de la
      -- configuracion. Con la regla del 14 de octubre, el cambio de plan llega aqui
      -- con un delta que lleva los sellos a cero.
      v_sellos := greatest(least(v_sellos + v_delta, n_tope), 0);
      if v_premio = 'grande' and v_sellos < n_totales then
        v_premio := 'ninguno';
      end if;
      if v_premio = 'chico' and v_sellos < n_chico then
        v_premio := 'ninguno';
      end if;
      -- Un cambio de plan que deja la plantilla en cero ABRE UN CICLO NUEVO, asi que
      -- las banderas del ciclo se limpian. Sin esto, una socia que canja su premio
      -- chico forzado al cambiar de plan arrancaria con chico_usado en true y al
      -- llenar su plantilla nueva caeria en la regla 4: reinicia SIN premio, o sea
      -- pagaria una plantilla completa para no recibir nada.
      -- Espejo de la misma decision en mecanica.ts. Solo el cambio de plan, no el
      -- ajuste manual.
      if v_tipo = 'cambio_plan' and v_sellos = 0 then
        v_chico_usado  := false;
        v_grande_usado := false;
      end if;

    elsif v_tipo = 'reverso' then
      v_sellos := greatest(least(v_sellos + v_delta, n_totales), 0);
      -- Deshacer solo puede quitar premios, nunca otorgarlos.
      if v_premio = 'grande' and v_sellos < n_totales then
        if v_sellos >= n_chico and not v_chico_usado then
          v_premio := 'chico';
        else
          v_premio := 'ninguno';
        end if;
      elsif v_premio = 'chico' and v_sellos < n_chico then
        v_premio := 'ninguno';
      end if;

    else
      raise exception 'tipo de movimiento desconocido: %', v_tipo;
    end if;
  end loop;

  return query select v_sellos, v_premio, v_chico_usado, v_grande_usado;
end;
$$;

comment on function recalcular_simulado(jsonb) is
  'Replay puro de la mecanica, con el plan por movimiento y sin tocar tablas. Herramienta de auditoria: la autoridad es backend/src/mecanica.ts.';

-- ---------------------------------------------------------------------------
-- 3. El envoltorio arma el jsonb uniendo el libro con el plan de cada fila
-- ---------------------------------------------------------------------------
-- `create or replace` no sirve aqui: la funcion ya existe con tres columnas de
-- salida y ahora devuelve cuatro, y PostgreSQL no deja cambiar el tipo de fila de
-- una funcion existente. Hay que tirarla primero.
drop function if exists recalcular_estado(uuid);

create function recalcular_estado(p_socia_id uuid)
returns table (
  sellos_actuales             integer,
  premio_pendiente            text,
  premio_chico_usado_en_ciclo boolean,
  premio_grande_usado_en_ciclo boolean
)
language plpgsql
as $$
declare
  v_movimientos jsonb;
begin
  if not exists (select 1 from socias s where s.id = p_socia_id) then
    raise exception 'la socia % no existe', p_socia_id;
  end if;

  -- El orden es la secuencia de insercion, nunca creado_en: dentro de una transaccion
  -- now() es constante y el orden quedaria indefinido.
  select coalesce(jsonb_agg(elemento order by secuencia), '[]'::jsonb)
    into v_movimientos
    from (
      select m.secuencia,
             jsonb_build_object(
               'tipo', m.tipo,
               'delta', m.sellos_delta,
               'plan', jsonb_build_object(
                 'sellos_totales', p.sellos_totales,
                 'sellos_premio_chico', p.sellos_premio_chico,
                 'reinicia_al_canjear_grande', p.reinicia_al_canjear_grande,
                 'reinicia_al_canjear_chico', p.reinicia_al_canjear_chico,
                 'premio_chico_borra_sellos', p.premio_chico_borra_sellos,
                 'suma_sello_con_premio_pendiente', p.suma_sello_con_premio_pendiente,
                 'tope_sellos_ajuste_manual', p.tope_sellos_ajuste_manual
               )
             ) as elemento
        from movimientos m
        join planes p on p.id = m.plan_id and p.negocio_id = m.negocio_id
       where m.socia_id = p_socia_id
    ) as filas;

  return query select * from recalcular_simulado(v_movimientos);
end;
$$;

comment on function recalcular_estado(uuid) is
  'Red de seguridad: reconstruye el estado de una socia releyendo su libro desde cero, con el plan de cada fila. NUNCA se llama en la ruta viva de la API. La autoridad es backend/src/mecanica.ts.';

commit;
