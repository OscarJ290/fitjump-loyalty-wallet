"""
generar_imagenes.py: las 16 imagenes de progreso del pase, de un solo golpe.

    python herramientas\\generar_imagenes.py

Produce 7 mensuales (0 a 6 sellos) y 9 semanales (0 a 8) en `web\\imagenes\\v1\\`.
Requiere Pillow:  pip install Pillow

ES DETERMINISTA A PROPOSITO. Correrlo dos veces produce archivos identicos byte
por byte. Sin aleatoriedad, sin marcas de tiempo dentro del PNG. El modo
`--verificar` lo comprueba: regenera en memoria y compara contra el disco.

POR QUE EXISTE: las 7 mensuales del 14 de septiembre de 2026 se hicieron con
ChatGPT y no son reproducibles. Hacer las semanales a mano habria dado un
segundo estilo parecido pero no igual. Generadas las 16 aqui, salen identicas
en estilo por construccion y no por buena suerte.

---------------------------------------------------------------------------
TODO LO DE ABAJO ESTA MEDIDO CONTRA `imagenes\\hero-mensual-0.png` Y
`imagenes\\hero-mensual-6.png`, NO RECONSTRUIDO DE MEMORIA.
---------------------------------------------------------------------------

El degradado es DIAGONAL, no horizontal ni vertical. Pesa tres cuartas partes
en horizontal y una cuarta parte en vertical. Las cuatro esquinas medidas:

    arriba izquierda  0137DC      arriba derecha  6F0EBF
    abajo  izquierda  2629D3      abajo  derecha  9400B6

Con `t = 0.75 * x/(ancho-1) + 0.25 * y/(alto-1)` entre `0138DD` y `9500B6`,
las cuatro salen dentro de un punto, que es el redondeo del PNG original.

La reticula mensual salio de restar las dos imagenes y buscar que pixeles
cambian: tres columnas que empiezan en x 137, 445 y 753, dos filas que
empiezan en y 177 y 437, casilla de 142 por 199. Margenes simetricos: 137 y
138 a los lados, 177 arriba y abajo.

La silueta NO se dibuja con primitivas: es el canal alfa del logo de la marca,
`herramientas\\fuente\\logo-icono-wallet.png`. Comprobado contra la imagen
original: la silueta del hero y el alfa del logo dan IoU 0.75 y la misma
proporcion (0.690 contra 0.714). Es la misma marca, asi que se usa la marca y
no una imitacion.
"""

import argparse
import hashlib
import io
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Falta Pillow. Instalalo con:  pip install Pillow")


# --------------------------------------------------------------------------
# RUTAS
# --------------------------------------------------------------------------

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(RAIZ, "herramientas", "fuente", "logo-icono-wallet.png")

# Carpeta VERSIONADA. La regla dura dice que nunca se sobrescribe una imagen ya
# publicada, porque Google cachea por URL y los pases ya guardados seguirian
# mostrando la version vieja. Los nombres de archivo tienen que quedarse igual,
# porque `progresoDelPase` en `backend\src\mecanica.ts` los arma a partir del
# numero de sellos. Asi que lo que cambia es la CARPETA: la URL completa es
# nueva, la regla se respeta, y esa funcion no se toca.
SALIDA = os.path.join(RAIZ, "web", "imagenes", "v1")


# --------------------------------------------------------------------------
# MEDIDAS
# --------------------------------------------------------------------------

ANCHO, ALTO = 1032, 812

# Exigido por Google para la imagen hero. Sin texto embebido de ninguna clase.
AZUL = (0x01, 0x38, 0xDD)
MORADO = (0x95, 0x00, 0xB6)

PESO_X, PESO_Y = 0.75, 0.25

# Casilla y filas, iguales en los dos planes. Que el sello mida lo mismo en las
# dos modalidades es a proposito: un sello se ve como un sello, y el ritmo
# vertical de las dos imagenes queda identico.
CASILLA_ANCHO, CASILLA_ALTO = 142, 199
FILAS_Y = (177, 437)

# Lo unico que cambia entre planes es cuantas columnas caben y, por lo tanto,
# cuanto aire queda entre ellas. El margen lateral se encoge en la semanal para
# que cuatro casillas no queden apretadas contra el centro.
#   mensual: 3 columnas, margen 137, hueco 166
#   semanal: 4 columnas, margen 100, hueco  88
RETICULAS = {
    "mensual": {"sellos": 6, "columnas": 3, "margen": 137},
    "semanal": {"sellos": 8, "columnas": 4, "margen": 100},
}

# Lleno es blanco al 100 por ciento, pendiente es el mismo blanco al 20 por
# ciento. Nunca hueco, nunca otro color: el logo es azul y morado, asi que
# sobre el degradado de marca cualquier otro color desaparece.
OPACIDAD_LLENO = 1.0
OPACIDAD_PENDIENTE = 0.20


# --------------------------------------------------------------------------
# PIEZAS
# --------------------------------------------------------------------------


def fondo() -> Image.Image:
    """El degradado diagonal de marca, pixel por pixel."""
    im = Image.new("RGB", (ANCHO, ALTO))
    pix = im.load()
    # Las dos rampas se calculan una sola vez por eje y despues se suman, en vez
    # de recalcular la interpolacion en cada uno de los 838,000 pixeles.
    rampa_x = [PESO_X * x / (ANCHO - 1) for x in range(ANCHO)]
    rampa_y = [PESO_Y * y / (ALTO - 1) for y in range(ALTO)]
    delta = tuple(MORADO[c] - AZUL[c] for c in range(3))
    for y in range(ALTO):
        base = rampa_y[y]
        for x in range(ANCHO):
            t = base + rampa_x[x]
            pix[x, y] = (
                round(AZUL[0] + delta[0] * t),
                round(AZUL[1] + delta[1] * t),
                round(AZUL[2] + delta[2] * t),
            )
    return im


def silueta() -> Image.Image:
    """
    El canal alfa del logo de la marca, recortado a su contenido y escalado a la
    casilla. Conserva la proporcion: estirarlo para llenar los 142 por 199
    deformaria la figura, y la diferencia entre 0.690 y 0.714 se ve.
    """
    if not os.path.exists(LOGO):
        sys.exit("Falta el logo de origen: %s" % LOGO)
    alfa = Image.open(LOGO).split()[-1]
    recorte = alfa.crop(alfa.getbbox())
    ancho_origen, alto_origen = recorte.size
    escala = min(CASILLA_ANCHO / ancho_origen, CASILLA_ALTO / alto_origen)
    destino = (max(1, round(ancho_origen * escala)), max(1, round(alto_origen * escala)))
    return recorte.resize(destino, Image.LANCZOS)


def posiciones(plan: str) -> list:
    """La esquina superior izquierda de cada casilla, en orden de lectura."""
    conf = RETICULAS[plan]
    columnas, margen = conf["columnas"], conf["margen"]
    ancho_util = ANCHO - 2 * margen
    hueco = (ancho_util - columnas * CASILLA_ANCHO) / (columnas - 1)
    puntos = []
    for fila_y in FILAS_Y:
        for col in range(columnas):
            puntos.append((round(margen + col * (CASILLA_ANCHO + hueco)), fila_y))
    return puntos


def componer(plan: str, sellos: int, marca: Image.Image, base: Image.Image) -> Image.Image:
    """Una imagen: el degradado mas las casillas, llenas y pendientes."""
    im = base.copy()
    blanco = Image.new("RGB", marca.size, (255, 255, 255))
    # La marca puede ser mas angosta que la casilla al conservar la proporcion,
    # asi que se centra dentro de ella.
    sobra_x = (CASILLA_ANCHO - marca.size[0]) // 2
    sobra_y = (CASILLA_ALTO - marca.size[1]) // 2
    for indice, (x, y) in enumerate(posiciones(plan)):
        opacidad = OPACIDAD_LLENO if indice < sellos else OPACIDAD_PENDIENTE
        mascara = marca if opacidad == 1.0 else marca.point(lambda v: round(v * opacidad))
        im.paste(blanco, (x + sobra_x, y + sobra_y), mascara)
    return im


def bytes_png(im: Image.Image) -> bytes:
    """
    El PNG serializado. Pillow no escribe el chunk `tIME`, asi que dos corridas
    con la misma entrada dan los mismos bytes. El modo `--verificar` lo
    comprueba de verdad en vez de confiar en esta frase.
    """
    buffer = io.BytesIO()
    im.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# --------------------------------------------------------------------------
# PRINCIPAL
# --------------------------------------------------------------------------


def planeadas() -> list:
    """Las 16, en orden: nombre de archivo, plan y cuantos sellos lleva."""
    salida = []
    for plan, conf in RETICULAS.items():
        for sellos in range(conf["sellos"] + 1):
            salida.append(("hero-%s-%d.png" % (plan, sellos), plan, sellos))
    return salida


def main() -> int:
    opciones = argparse.ArgumentParser(description="Genera las 16 imagenes de progreso.")
    opciones.add_argument(
        "--verificar",
        action="store_true",
        help="no escribe: regenera en memoria y compara contra lo que hay en disco",
    )
    args = opciones.parse_args()

    marca = silueta()
    base = fondo()
    print("logo recortado y escalado a %d por %d" % marca.size)
    print("destino: %s" % SALIDA)
    print()

    if not args.verificar:
        os.makedirs(SALIDA, exist_ok=True)

    diferencias = 0
    for nombre, plan, sellos in planeadas():
        datos = bytes_png(componer(plan, sellos, marca, base))
        ruta = os.path.join(SALIDA, nombre)
        resumen = hashlib.sha256(datos).hexdigest()[:12]

        if args.verificar:
            if not os.path.exists(ruta):
                print("FALTA     %-22s" % nombre)
                diferencias += 1
                continue
            with open(ruta, "rb") as archivo:
                iguales = archivo.read() == datos
            print("%-9s %-22s %s" % ("ok" if iguales else "DIFIERE", nombre, resumen))
            if not iguales:
                diferencias += 1
        else:
            with open(ruta, "wb") as archivo:
                archivo.write(datos)
            print("%-22s %7d bytes  %s" % (nombre, len(datos), resumen))

    print()
    if args.verificar:
        if diferencias:
            print("%d de %d NO coinciden con el disco." % (diferencias, len(planeadas())))
            return 1
        print("Las %d coinciden byte por byte. El generador es determinista." % len(planeadas()))
    else:
        print("%d imagenes escritas." % len(planeadas()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
