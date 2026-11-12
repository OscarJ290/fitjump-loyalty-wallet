-- 001_inicial.sql
-- Fit Jump Wallet: esquema inicial, multi tenant desde el primer commit.
-- Se corre con psql. No existe alembic aqui: las migraciones son archivos numerados.
--
-- REGLA DURA DEL PROYECTO: ningun monto de premio ni numero de sellos vive en el
-- codigo. Todo sale de la tabla planes. Este archivo crea las columnas; los valores
-- entran en 002_semillas.sql.
--
-- Multi tenant: cada tabla lleva negocio_id, y las llaves foraneas son compuestas
-- (id, negocio_id), de modo que la base misma impide que una fila de un negocio
-- apunte a una fila de otro.

begin;

-- gen_random_uuid() es nativa desde PostgreSQL 13. Neon corre 17.
-- No hace falta la extension pgcrypto.

-- ---------------------------------------------------------------------------
-- negocios
-- ---------------------------------------------------------------------------
create table if not exists negocios (
  id          uuid        primary key default gen_random_uuid(),
  nombre      text        not null,
  creado_en   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- planes: aqui viven TODAS las reglas de la mecanica, como columnas.
-- ---------------------------------------------------------------------------
create table if not exists planes (
  id                              uuid          primary key default gen_random_uuid(),
  negocio_id                      uuid          not null,
  nombre                          text          not null,

  sellos_totales                  integer       not null,
  sellos_premio_chico             integer       not null,
  monto_premio_chico              numeric(10,2) not null,
  monto_premio_grande             numeric(10,2) not null,
  precio                          numeric(10,2) not null,

  -- Las siete reglas de la seccion 7 del claude.md, mas la octava que quedo abierta.
  -- true: la plantilla reinicia a cero al canjear el premio grande, no al llenarse.
  reinicia_al_canjear_grande      boolean       not null,
  -- DECISION ABIERTA, pendiente de la junta con la duena. Default false, que es lo
  -- que la duena aprobo el 9 de septiembre de 2026. El codigo debe soportar los dos
  -- valores sin tocarse: se cambia con un UPDATE de una linea.
  reinicia_al_canjear_chico       boolean       not null,
  -- false: canjear el premio chico no borra sellos.
  premio_chico_borra_sellos       boolean       not null,
  -- true: si tiene premio pendiente y paga sin canjear, el sello se suma.
  suma_sello_con_premio_pendiente boolean       not null,
  -- true: al cambiar de plan los sellos se conservan, ajustados a mano por recepcion.
  conserva_sellos_al_cambiar_plan boolean       not null,
  -- Tope del ajuste manual al cambiar de plan. Se siembra en sellos_totales - 1:
  -- el ajuste nunca completa plantilla ni otorga premio. Razon: los terminos ya
  -- publicados prohiben cambiar de plan para canjear un descuento mayor.
  tope_sellos_al_cambiar_plan     integer       not null,
  -- true: un sello de regalo, una sola vez, en el primer pago.
  sello_de_bienvenida             boolean       not null,

  activo                          boolean       not null default true,
  creado_en                       timestamptz   not null default now(),

  constraint planes_sellos_totales_positivo
    check (sellos_totales > 0),
  constraint planes_premio_chico_antes_del_grande
    check (sellos_premio_chico > 0 and sellos_premio_chico < sellos_totales),
  constraint planes_montos_no_negativos
    check (monto_premio_chico >= 0 and monto_premio_grande >= 0 and precio >= 0),
  -- El premio grande nunca vale menos que el chico: si pasa, el programa empuja a
  -- canjear temprano y el premio grande deja de existir en la practica.
  constraint planes_grande_al_menos_como_chico
    check (monto_premio_grande >= monto_premio_chico),
  constraint planes_tope_dentro_de_la_plantilla
    check (tope_sellos_al_cambiar_plan >= 0 and tope_sellos_al_cambiar_plan < sellos_totales),

  constraint planes_nombre_unico_por_negocio unique (negocio_id, nombre),
  -- Necesaria para que otras tablas puedan apuntar con llave foranea compuesta.
  constraint planes_id_negocio_unico unique (id, negocio_id),
  constraint planes_negocio_fk foreign key (negocio_id) references negocios (id)
);

-- ---------------------------------------------------------------------------
-- usuarios_panel: tres accesos separados, no uno compartido, para que cada
-- movimiento quede firmado y se pueda revocar uno sin tocar los otros.
-- En la base se guarda SOLO el SHA-256 del token de dispositivo. Nada de argon2
-- ni PBKDF2: no caben en 10 ms de CPU.
-- ---------------------------------------------------------------------------
create table if not exists usuarios_panel (
  id              uuid        primary key default gen_random_uuid(),
  negocio_id      uuid        not null,
  nombre          text        not null,
  token_hash      text        not null,
  activo          boolean     not null default true,
  creado_en       timestamptz not null default now(),
  ultimo_acceso   timestamptz,

  -- 32 bytes en hexadecimal son 64 caracteres.
  constraint usuarios_panel_token_hash_sha256 check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint usuarios_panel_token_unico unique (token_hash),
  constraint usuarios_panel_nombre_unico_por_negocio unique (negocio_id, nombre),
  constraint usuarios_panel_id_negocio_unico unique (id, negocio_id),
  constraint usuarios_panel_negocio_fk foreign key (negocio_id) references negocios (id)
);

-- ---------------------------------------------------------------------------
-- socias
-- ---------------------------------------------------------------------------
create table if not exists socias (
  id                          uuid        primary key default gen_random_uuid(),
  negocio_id                  uuid        not null,
  nombre                      text        not null,
  whatsapp                    text        not null,
  plan_id                     uuid,
  sellos_actuales             integer     not null default 0,
  -- Un solo campo para el premio: la estructura misma impide que haya dos premios
  -- pendientes a la vez, que es la regla 3 de la mecanica.
  premio_pendiente            text        not null default 'ninguno',
  premio_chico_usado_en_ciclo boolean     not null default false,
  objeto_wallet_id            text,
  es_prueba                   boolean     not null default false,
  alta_en                     timestamptz not null default now(),
  activa                      boolean     not null default true,

  constraint socias_sellos_no_negativos check (sellos_actuales >= 0),
  constraint socias_premio_pendiente_valido
    check (premio_pendiente in ('ninguno', 'chico', 'grande')),
  -- +52 y diez digitos, normalizado antes de insertar.
  constraint socias_whatsapp_normalizado check (whatsapp ~ '^\+52[0-9]{10}$'),

  constraint socias_whatsapp_unico_por_negocio unique (negocio_id, whatsapp),
  constraint socias_objeto_wallet_unico unique (objeto_wallet_id),
  constraint socias_id_negocio_unico unique (id, negocio_id),
  constraint socias_negocio_fk foreign key (negocio_id) references negocios (id),
  -- Llave foranea compuesta: una socia no puede quedar en el plan de otro negocio.
  constraint socias_plan_fk foreign key (plan_id, negocio_id)
    references planes (id, negocio_id)
);

create index if not exists socias_busqueda_por_nombre
  on socias (negocio_id, lower(nombre));

-- ---------------------------------------------------------------------------
-- movimientos: ES UN LIBRO CONTABLE. Nunca se borra ni se edita una fila.
-- Deshacer inserta un reverso que apunta al movimiento original.
-- ---------------------------------------------------------------------------
create table if not exists movimientos (
  id                      uuid          primary key default gen_random_uuid(),
  -- ORDEN DEL LIBRO. No se usa creado_en para ordenar: dentro de una transaccion
  -- now() es constante, asi que varios movimientos insertados juntos quedan con la
  -- misma marca de tiempo y el orden se vuelve indefinido. Esta secuencia es el
  -- orden real de insercion y no depende del reloj.
  secuencia               bigint        generated always as identity,
  negocio_id              uuid          not null,
  socia_id                uuid          not null,
  tipo                    text          not null,
  sellos_delta            integer       not null default 0,
  monto                   numeric(10,2),
  usuario_panel_id        uuid,
  -- uuid generado en el navegador y mandado en el header Idempotency-Key.
  clave_idempotencia      text,
  movimiento_reversado_id uuid,
  creado_en               timestamptz   not null default now(),
  nota                    text,

  constraint movimientos_tipo_valido check (tipo in (
    'pago',
    'sello_bienvenida',
    'canje_chico',
    'canje_grande',
    'cambio_plan',
    'ajuste_manual',
    'reverso'
  )),
  -- Un reverso siempre apunta a lo que reversa; nada mas lo hace.
  constraint movimientos_reverso_apunta_a_su_original check (
    (tipo = 'reverso' and movimiento_reversado_id is not null)
    or (tipo <> 'reverso' and movimiento_reversado_id is null)
  ),
  constraint movimientos_clave_idempotencia_unica unique (clave_idempotencia),
  -- Un movimiento no se puede reversar dos veces.
  constraint movimientos_un_solo_reverso_por_movimiento unique (movimiento_reversado_id),
  constraint movimientos_id_negocio_unico unique (id, negocio_id),
  constraint movimientos_socia_fk foreign key (socia_id, negocio_id)
    references socias (id, negocio_id),
  constraint movimientos_usuario_fk foreign key (usuario_panel_id, negocio_id)
    references usuarios_panel (id, negocio_id),
  constraint movimientos_reversado_fk foreign key (movimiento_reversado_id, negocio_id)
    references movimientos (id, negocio_id)
);

create unique index if not exists movimientos_secuencia_unica
  on movimientos (secuencia);

create index if not exists movimientos_por_socia
  on movimientos (socia_id, secuencia);

-- El libro contable se defiende en la base, no solo en el codigo de la API.
create or replace function movimientos_solo_se_agregan()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'movimientos es un libro contable: no se edita ni se borra. Para corregir, inserta un reverso.';
end;
$$;

drop trigger if exists movimientos_sin_update on movimientos;
create trigger movimientos_sin_update
  before update on movimientos
  for each row execute function movimientos_solo_se_agregan();

drop trigger if exists movimientos_sin_delete on movimientos;
create trigger movimientos_sin_delete
  before delete on movimientos
  for each row execute function movimientos_solo_se_agregan();

-- ---------------------------------------------------------------------------
-- sync_wallet: patron outbox. Primero la base, despues Google.
-- Una fila por socia, no una por cambio: lo que se sincroniza es el ESTADO
-- actual del pase, asi que varios cambios seguidos colapsan en un solo
-- pendiente y el reintento es idempotente.
-- ---------------------------------------------------------------------------
create table if not exists sync_wallet (
  id              uuid        primary key default gen_random_uuid(),
  negocio_id      uuid        not null,
  socia_id        uuid        not null,
  estado          text        not null default 'pendiente',
  intentos        integer     not null default 0,
  ultimo_error    text,
  actualizado_en  timestamptz not null default now(),

  constraint sync_wallet_estado_valido check (estado in ('pendiente', 'ok', 'error')),
  constraint sync_wallet_intentos_no_negativos check (intentos >= 0),
  constraint sync_wallet_una_fila_por_socia unique (socia_id),
  constraint sync_wallet_socia_fk foreign key (socia_id, negocio_id)
    references socias (id, negocio_id)
);

create index if not exists sync_wallet_pendientes
  on sync_wallet (estado, actualizado_en)
  where estado <> 'ok';

-- ---------------------------------------------------------------------------
-- recalcular_estado(socia): RED DE SEGURIDAD.
-- Reconstruye sellos_actuales, premio_pendiente y premio_chico_usado_en_ciclo
-- releyendo movimientos desde cero, con las reglas leidas de planes.
--
-- ATENCION, COSTO OCULTO ANOTADO: esta funcion y backend\src\mecanica.ts (hito H4)
-- implementan la misma mecanica en dos lenguajes. La autoridad es mecanica.ts.
-- H4 debe incluir un test que compare las dos sobre secuencias aleatorias de
-- fast-check: si divergen, la que esta mal es esta.
-- ---------------------------------------------------------------------------
create or replace function recalcular_estado(p_socia_id uuid)
returns table (
  sellos_actuales             integer,
  premio_pendiente            text,
  premio_chico_usado_en_ciclo boolean
)
language plpgsql
as $$
declare
  r_plan         record;
  r_mov          record;
  v_sellos       integer := 0;
  v_premio       text    := 'ninguno';
  v_chico_usado  boolean := false;
  -- Solo importa cuando reinicia_al_canjear_grande es false. Hoy es true, asi que
  -- canjear el grande reinicia el ciclo y esta bandera se limpia sola. Si algun dia
  -- se pone en false, sin esta bandera el premio grande se volveria a otorgar solo,
  -- porque la plantilla seguiria llena. No se guarda en socias: H4 decide si hace
  -- falta persistirla.
  v_grande_usado boolean := false;
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

  for r_mov in
    -- El orden es la secuencia de insercion, nunca creado_en.
    select m.tipo, m.sellos_delta
      from movimientos m
     where m.socia_id = p_socia_id
     order by m.secuencia
  loop
    if r_mov.tipo in ('pago', 'sello_bienvenida') then
      -- Regla 5: con premio pendiente, el sello se suma solo si el plan lo permite.
      if v_premio = 'ninguno' or r_plan.suma_sello_con_premio_pendiente then
        v_sellos := least(v_sellos + r_mov.sellos_delta, r_plan.sellos_totales);
      end if;

      if v_sellos >= r_plan.sellos_totales then
        if v_chico_usado then
          -- Regla 4: ya uso el premio chico en este ciclo, asi que al llenar la
          -- plantilla reinicia SIN premio y empieza un ciclo nuevo. Dejarla
          -- congelada en lleno mata el pase visualmente.
          v_sellos       := 0;
          v_premio       := 'ninguno';
          v_chico_usado  := false;
          v_grande_usado := false;
        elsif not v_grande_usado then
          -- Llenar la plantilla sin haber canjeado el chico otorga el grande, y
          -- reemplaza al chico si estaba pendiente: no son acumulables, y nunca
          -- hay dos premios pendientes a la vez (regla 3).
          v_premio := 'grande';
        end if;
      elsif v_premio = 'ninguno'
            and v_sellos >= r_plan.sellos_premio_chico
            and not v_chico_usado then
        v_premio := 'chico';
      end if;

    elsif r_mov.tipo = 'canje_chico' then
      v_premio      := 'ninguno';
      v_chico_usado := true;
      if r_plan.reinicia_al_canjear_chico then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      elsif r_plan.premio_chico_borra_sellos then
        v_sellos := greatest(v_sellos - r_plan.sellos_premio_chico, 0);
      end if;

    elsif r_mov.tipo = 'canje_grande' then
      v_premio       := 'ninguno';
      v_grande_usado := true;
      if r_plan.reinicia_al_canjear_grande then
        v_sellos       := 0;
        v_chico_usado  := false;
        v_grande_usado := false;
      end if;

    elsif r_mov.tipo in ('cambio_plan', 'ajuste_manual') then
      -- Regla 7: el ajuste nunca completa plantilla ni otorga premio. En el cambio
      -- de plan el tope sale de la configuracion del plan nuevo.
      -- SUPUESTO QUE H4 DEBE CONFIRMAR CON OSCAR: el ajuste_manual se trata igual
      -- que el cambio_plan, es decir tampoco otorga premio. La mecanica escrita solo
      -- define el tope para el cambio de plan.
      v_sellos := greatest(least(v_sellos + r_mov.sellos_delta,
                                 r_plan.tope_sellos_al_cambiar_plan), 0);
      -- Si el ajuste la deja por debajo de lo que ya tenia ganado, el premio
      -- pendiente se revoca, pero nunca se otorga uno nuevo.
      if v_premio = 'grande' and v_sellos < r_plan.sellos_totales then
        v_premio := 'ninguno';
      end if;
      if v_premio = 'chico' and v_sellos < r_plan.sellos_premio_chico then
        v_premio := 'ninguno';
      end if;

    elsif r_mov.tipo = 'reverso' then
      v_sellos := greatest(least(v_sellos + r_mov.sellos_delta,
                                 r_plan.sellos_totales), 0);
      -- Deshacer solo puede quitar premios, nunca otorgarlos. Si cae por debajo del
      -- umbral del grande pero sigue arriba del chico, y no habia canjeado el chico,
      -- el estado correcto es el chico pendiente.
      if v_premio = 'grande' and v_sellos < r_plan.sellos_totales then
        if v_sellos >= r_plan.sellos_premio_chico and not v_chico_usado then
          v_premio := 'chico';
        else
          v_premio := 'ninguno';
        end if;
      elsif v_premio = 'chico' and v_sellos < r_plan.sellos_premio_chico then
        v_premio := 'ninguno';
      end if;
    end if;
  end loop;

  return query select v_sellos, v_premio, v_chico_usado;
end;
$$;

comment on function recalcular_estado(uuid) is
  'Red de seguridad: reconstruye el estado de una socia releyendo movimientos desde cero. La autoridad de la mecanica es backend/src/mecanica.ts.';

commit;
