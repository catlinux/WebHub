"""Genera el logo y los favicons de WebHub a partir de assets/icono.png.

Uso: python3 scripts/generar-favicons.py  (requiere Pillow)
"""
from pathlib import Path
from PIL import Image

raiz = Path(__file__).resolve().parent.parent
origen = Image.open(raiz / "assets" / "icono.png").convert("RGBA")

# Recorte cuadrado centrado en el gráfico (el original tiene mucho margen oscuro).
ancho, alto = origen.size
lado = int(min(ancho, alto) * 0.78)
cx, cy = ancho // 2, int(alto * 0.505)
recorte = origen.crop((cx - lado // 2, cy - lado // 2, cx + lado // 2, cy + lado // 2))

publico = raiz / "public"
recorte.resize((96, 96), Image.LANCZOS).save(publico / "logo.png", optimize=True)
recorte.resize((180, 180), Image.LANCZOS).save(publico / "apple-touch-icon.png", optimize=True)
recorte.resize((192, 192), Image.LANCZOS).save(publico / "icon-192.png", optimize=True)
recorte.resize((32, 32), Image.LANCZOS).save(publico / "favicon-32.png", optimize=True)
recorte.save(publico / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("Favicons generados en", publico)
