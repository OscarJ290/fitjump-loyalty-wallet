-- 009_reinicia_al_canjear_chico_en_true.sql
-- Oscar confirma el 14 de octubre de 2026 que `reinicia_al_canjear_chico` esta aprobada
-- por la dueña. La base la tenia en false, que era el default del 9 de septiembre.
--
-- Va como migracion y no como un `UPDATE` suelto porque un cambio de regla de mecanica
-- sin rastro en el repo no se puede auditar despues.
--
-- `premio_chico_borra_sellos` se queda en false.
--
-- ⚠️ EL EFECTO SOBRE EL COSTO DEL PROGRAMA YA ESTABA MEDIDO, Y ES POR LO QUE ESTA
-- REGLA VIVIO DOS SEMANAS EN LA LISTA DE LA JUNTA: con el reinicio encendido, los dos
-- premios quedan empatados en el plan semanal ($10 por semana por los dos caminos) y en
-- el mensual el premio chico queda MEJOR que el grande ($46.67 contra $45.83 por mes) y
-- llega en la mitad del tiempo. En la practica el premio grande deja de ser el objetivo.
-- Queda anotado aqui, no como objecion (la decision es de Oscar y de la dueña) sino para
-- que el dia que alguien se pregunte por que casi nadie llega al premio grande, la
-- respuesta este escrita.

begin;

update planes
   set reinicia_al_canjear_chico = true
 where negocio_id = '11111111-1111-4111-8111-111111111111';

commit;

-- ---------------------------------------------------------------------------
-- TRES CONSECUENCIAS DE ESTE UPDATE, ANOTADAS A PROPOSITO
-- ---------------------------------------------------------------------------
--
-- 1. LA REGLA 4 YA NO PUEDE OCURRIR. La regla 4 dice: "si ya uso el premio chico en el
--    ciclo y llena la plantilla, reinicia sin premio". Con el reinicio encendido, el
--    canje del chico ya limpia la bandera `premio_chico_usado_en_ciclo`, asi que el
--    estado "ya uso el chico Y la plantilla esta llena" deja de existir: cada canje
--    abre un ciclo limpio.
--    **El codigo de la regla 4 y sus tests se quedan**, porque la columna soporta los
--    dos valores y porque el dia que la junta la apague, la regla 4 vuelve a ser
--    alcanzable.
--
-- 2. `premio_chico_borra_sellos` QUEDA INALCANZABLE. En `mecanica.ts` y en
--    `recalcular_simulado` las dos banderas viven en la misma rama, como un `if` y un
--    `else if`:
--        si reinicia_al_canjear_chico       -> reinicia el ciclo
--        si no, si premio_chico_borra_sellos -> descuenta los sellos del premio
--    Con el `UPDATE` de arriba, la primera gana siempre y la segunda no se ejecuta
--    nunca. **Hasta hoy si era alcanzable** (lo que estaba en false era la primera), y
--    esa precision salio de una correccion de la mañana del 14 de octubre. La columna y
--    sus dos tests se quedan.
--
-- 3. LA COMPROBACION 8 DE `backend\test\esquema.sql` CAMBIA DE RESULTADO, porque corre
--    contra las filas VIVAS de `planes`. Antes media la regla 4; ahora mide el reinicio
--    al canjear el chico. Quedo actualizada en el mismo commit, con los dos numeros
--    anotados.
