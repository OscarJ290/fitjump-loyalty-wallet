-- 005_acotar_sellos_en_pago.sql
-- Cierra un hueco que fast-check encontro el 13 de octubre de 2026 en las DOS
-- implementaciones de la mecanica a la vez: una fila de tipo pago con sellos_delta
-- negativo dejaba los sellos en menos uno, porque la rama de pago solo acotaba por
-- arriba. La API nunca escribe una fila asi, pero el libro contable es un dato y una
-- fila mala no debe poder romper el invariante de que los sellos nunca son negativos.
--
-- El mismo arreglo quedo en backend\src\mecanica.ts, como exige la regla dura: si una
-- regla cambia de forma, se cambia en los dos lenguajes.
--
-- Solo se vuelve a crear recalcular_simulado. El envoltorio recalcular_estado de 004
-- no cambia, porque delega en esta.

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
        -- Acotado por los dos lados. El limite de abajo no es decorativo: lo
        -- encontro fast-check el 13 de octubre de 2026 con una fila de tipo pago y
        -- delta negativo, que dejaba los sellos en menos uno. La API nunca escribe
        -- una fila asi, pero el libro es un dato y una fila mala no debe poder
        -- romper el invariante.
        v_sellos := greatest(least(v_sellos + v_delta, p_sellos_totales), 0);
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

commit;
