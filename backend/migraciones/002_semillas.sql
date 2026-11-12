-- 002_semillas.sql
-- El negocio Fit Jump y sus dos planes, con los montos y las reglas de la
-- seccion 7 del claude.md.
--
-- Los identificadores son fijos a proposito, para que correr este archivo dos
-- veces no duplique nada.
--
-- PRECIOS FIJOS TODO EL ANO, no modificables desde la app: semanal 160, mensual 550.
-- PREMIOS EN MONTOS FIJOS EN PESOS, no en porcentaje, para cerrar el arbitraje
-- entre planes. Semanal 40 y 80. Mensual 140 y 275.
--
-- Los tres usuarios del panel no van aqui: viven en 003_usuarios_panel.sql, porque
-- sus filas nacen sin token y el token se genera al dar el acceso, en H8.

-- ⚠️ sello_de_bienvenida NACE EN false PARA LOS DOS PLANES, y el nombre es enganoso.
--
-- La bandera en false NO significa que la socia no reciba sello al inscribirse: su
-- primer pago le da un sello, como cualquier otro pago. Lo que la bandera en true
-- agrega es un sello ADICIONAL al del primer pago, dejando la tarjeta en 2 con un solo
-- pago. El nombre por si solo hace pensar lo contrario y ya causo una confusion el 13
-- de octubre de 2026.
--
-- Va en false porque es una regla que NUNCA se acordo con la duena: el contexto dice
-- "un sello por semana pagada" y "un sello por mes pagado", y no menciona ningun sello
-- de bienvenida ni el 9 de septiembre ni el 2 de octubre. Encenderla sube el costo del
-- programa alrededor de 50 por ciento en el premio chico mensual. Va a la junta final.
--
-- El codigo de mecanica.ts soporta los dos valores sin tocarse.

begin;

insert into negocios (id, nombre)
values ('11111111-1111-4111-8111-111111111111', 'Fit Jump')
on conflict (id) do nothing;

insert into planes (
  id,
  negocio_id,
  nombre,
  sellos_totales,
  sellos_premio_chico,
  monto_premio_chico,
  monto_premio_grande,
  precio,
  reinicia_al_canjear_grande,
  reinicia_al_canjear_chico,
  premio_chico_borra_sellos,
  suma_sello_con_premio_pendiente,
  conserva_sellos_al_cambiar_plan,
  tope_sellos_al_cambiar_plan,
  sello_de_bienvenida
)
values
  (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'Semanal',
    8,      -- sellos_totales: un sello por semana pagada
    4,      -- sellos_premio_chico: mitad de plantilla
    40.00,  -- monto_premio_chico
    80.00,  -- monto_premio_grande
    160.00, -- precio
    true,   -- reinicia_al_canjear_grande
    false,  -- reinicia_al_canjear_chico: DECISION ABIERTA, default aprobado el 9 sep
    false,  -- premio_chico_borra_sellos
    true,   -- suma_sello_con_premio_pendiente
    true,   -- conserva_sellos_al_cambiar_plan
    7,      -- tope_sellos_al_cambiar_plan: sellos_totales menos uno
    false   -- sello_de_bienvenida: ver la nota de arriba. NUNCA se acordo con la duena
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    'Mensual',
    6,      -- sellos_totales: un sello por mes pagado
    3,      -- sellos_premio_chico
    140.00, -- monto_premio_chico
    275.00, -- monto_premio_grande
    550.00, -- precio
    true,   -- reinicia_al_canjear_grande
    false,  -- reinicia_al_canjear_chico
    false,  -- premio_chico_borra_sellos
    true,   -- suma_sello_con_premio_pendiente
    true,   -- conserva_sellos_al_cambiar_plan
    5,      -- tope_sellos_al_cambiar_plan
    false   -- sello_de_bienvenida: ver la nota de arriba. NUNCA se acordo con la duena
  )
on conflict (id) do nothing;

commit;
