-- 006_sello_de_bienvenida_en_false.sql
-- Apaga sello_de_bienvenida en los dos planes de Fit Jump.
--
-- 002_semillas.sql los sembro en true el 13 de octubre de 2026 por una lectura mia que
-- nadie habia aprobado. Ese archivo ya quedo corregido para las instalaciones nuevas,
-- pero sus inserciones llevan "on conflict do nothing", asi que no tocan las filas que
-- ya existen. Esta migracion las alinea.
--
-- POR QUE EN false: es una regla que NUNCA se acordo con la duena. El contexto dice "un
-- sello por semana pagada" y "un sello por mes pagado", y no menciona ningun sello de
-- bienvenida ni el 9 de septiembre ni el 2 de octubre. Medido el 13 de octubre: en el
-- plan mensual, encenderla sube el costo del premio chico de 8.5 a 12.7 por ciento
-- efectivo, un aumento de 50 por ciento sobre lo que la duena aprobo. Va a la junta
-- final, con las otras dos reglas sin aprobar.
--
-- EL NOMBRE ES ENGANOSO: en false la socia SI recibe un sello en su primer pago, como
-- en cualquier otro pago. Lo que la bandera en true agrega es un sello ADICIONAL.

begin;

update planes
   set sello_de_bienvenida = false
 where negocio_id = '11111111-1111-4111-8111-111111111111';

commit;
