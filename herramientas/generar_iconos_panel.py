"""Los dos iconos del panel, para que se instale en el telefono como aplicacion.

    python herramientas/generar_iconos_panel.py
    python herramientas/generar_iconos_panel.py --verificar

Salen a `panel/public/`, que Vite copia tal cual a `web/panel/`.

POR QUE UN ARCHIVO APARTE Y NO DENTRO DE generar_imagenes.py: ese script hace las 16
imagenes de progreso de los pases, que son intocables una vez publicadas, porque Google
cachea por URL. Un icono del panel no tiene nada de eso, no viaja en ningun pase, y
mezclarlos invitaria a regenerar las 16 por cambiar un icono.

ES DETERMINISTA Y LO COMPRUEBA SOLO, igual que el generador de las imagenes: con
`--verificar` regenera en memoria y compara byte por byte contra el disco.

LA SILUETA NO SE DIBUJA: es el canal alfa del logo de la marca, el mismo archivo que
usan las imagenes de progreso, `herramientas/fuente/logo-icono-wallet.png`. Asi el
icono del panel y los sellos del pase son la misma figura por construccion.

MARGEN: Google y Android enmascaran el icono en circulo o en lo que el fabricante
quiera, asi que la figura se dibuja al 62 por ciento del lienzo, centrada. Al 100 se le
cortarian los pies en cuanto el telefono lo recorte.
"""

import sys
from pathlib import Path

from PIL import Image

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent
LOGO = AQUI / "fuente" / "logo-icono-wallet.png"
DESTINO = RAIZ / "panel" / "public"

AZUL = (0x01, 0x38, 0xDD)
MORADO = (0x95, 0x00, 0xB6)
TAMANOS = (192, 512)
# Que fraccion del lienzo ocupa la figura. El resto es el margen que el telefono se
# puede comer al enmascarar.
PROPORCION = 0.62


def fondo(lado: int) -> Image.Image:
    """El degradado de marca, diagonal, igual que el de las imagenes de progreso:
    tres cuartas partes en horizontal y una cuarta en vertical."""
    im = Image.new("RGB", (lado, lado))
    pixeles = im.load()
    delta = tuple(MORADO[c] - AZUL[c] for c in range(3))
    for y in range(lado):
        for x in range(lado):
            t = 0.75 * x / (lado - 1) + 0.25 * y / (lado - 1)
            pixeles[x, y] = (
                round(AZUL[0] + delta[0] * t),
                round(AZUL[1] + delta[1] * t),
                round(AZUL[2] + delta[2] * t),
            )
    return im


def icono(lado: int) -> Image.Image:
    base = fondo(lado)
    logo = Image.open(LOGO).convert("RGBA")
    alfa = logo.getchannel("A")
    recorte = alfa.crop(alfa.getbbox())

    ancho_destino = round(lado * PROPORCION)
    escala = ancho_destino / max(recorte.size)
    medida = (max(1, round(recorte.width * escala)), max(1, round(recorte.height * escala)))
    mascara = recorte.resize(medida, Image.LANCZOS)

    blanco = Image.new("RGB", medida, (255, 255, 255))
    base.paste(blanco, ((lado - medida[0]) // 2, (lado - medida[1]) // 2), mascara)
    return base


def bytes_png(im: Image.Image) -> bytes:
    import io

    bufer = io.BytesIO()
    # Sin metadatos ni fecha: dos corridas tienen que dar el mismo archivo.
    im.save(bufer, format="PNG", optimize=True)
    return bufer.getvalue()


def main() -> int:
    verificar = "--verificar" in sys.argv
    DESTINO.mkdir(parents=True, exist_ok=True)
    fallos = 0

    for lado in TAMANOS:
        ruta = DESTINO / f"icono-{lado}.png"
        datos = bytes_png(icono(lado))
        if verificar:
            if not ruta.exists():
                print(f"FALTA   {ruta.name}")
                fallos += 1
            elif ruta.read_bytes() != datos:
                print(f"DISTINTO {ruta.name}")
                fallos += 1
            else:
                print(f"igual    {ruta.name}  {len(datos)} bytes")
        else:
            ruta.write_bytes(datos)
            print(f"escrito  {ruta.name}  {lado} por {lado}, {len(datos)} bytes")

    if verificar and fallos:
        print(f"\n{fallos} archivos no coinciden con lo que el generador produce hoy.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
