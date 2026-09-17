#!/usr/bin/env python3
"""Regenerate every app icon from assets/icon-art.svg.

The mark is placed inside each shape with explicit padding, so it never
touches the edge. Adaptive icons on Android get the mark alone on a
transparent 108dp canvas -- the launcher supplies the background and the
mask, so baking the squircle into the foreground would crop the gecko.

Requires: rsvg-convert, Pillow.
"""
import os
import re
import shutil
import subprocess
import sys
from io import BytesIO

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, 'assets', 'icon-art.svg')

NAVY = '#081938'
ART_W, ART_H = 719.5, 745.0

# Fraction of the canvas the mark spans, per shape.
SQUIRCLE_SCALE = 0.68   # rounded square: the whole canvas is visible
ROUND_SCALE = 0.64      # circle: corners are cut, so inset a little more
# Android adaptive foreground: only the centre 72/108 of the canvas shows,
# so match the squircle's visual size inside that viewport.
ADAPTIVE_SCALE = SQUIRCLE_SCALE * 72 / 108


def art_placement(canvas, scale):
    s = (canvas * scale) / ART_H
    w, h = ART_W * s, ART_H * s
    return (canvas - w) / 2, (canvas - h) / 2, s


def compose(canvas, scale, shape):
    """Build an SVG string: background `shape` plus the centred mark."""
    x, y, s = art_placement(canvas, scale)
    if shape == 'squircle':
        bg = f'<rect width="{canvas}" height="{canvas}" rx="{canvas * 0.2246:.3f}" fill="{NAVY}"/>'
    elif shape == 'circle':
        r = canvas / 2
        bg = f'<circle cx="{r}" cy="{r}" r="{r}" fill="{NAVY}"/>'
    elif shape == 'square':
        bg = f'<rect width="{canvas}" height="{canvas}" fill="{NAVY}"/>'
    elif shape == 'none':
        bg = ''
    else:
        raise ValueError(shape)

    inner = re.search(r'<svg[^>]*>(.*)</svg>', open(ART).read(), re.S).group(1)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {canvas} {canvas}" '
        f'width="{canvas}" height="{canvas}">\n  {bg}\n'
        f'  <g transform="translate({x:.3f},{y:.3f}) scale({s:.6f})">{inner}</g>\n</svg>\n'
    )


def render(svg, size):
    out = subprocess.run(
        ['rsvg-convert', '-w', str(size), '-h', str(size), '-f', 'png'],
        input=svg.encode(), capture_output=True, check=True).stdout
    return Image.open(BytesIO(out)).convert('RGBA')


def save(img, path, opaque=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if opaque:
        flat = Image.new('RGB', img.size, NAVY)
        flat.paste(img, mask=img.getchannel('A'))
        img = flat
    img.save(path)
    print('  ', os.path.relpath(path, ROOT))


def main():
    icons = os.path.join(ROOT, 'src-tauri', 'icons')
    squircle = compose(1024, SQUIRCLE_SCALE, 'squircle')
    circle = compose(1024, ROUND_SCALE, 'circle')
    foreground = compose(1024, ADAPTIVE_SCALE, 'none')
    square = compose(1024, SQUIRCLE_SCALE, 'square')

    print('source svgs')
    for path in ('assets/logo.svg', 'public/logo.svg'):
        open(os.path.join(ROOT, path), 'w').write(squircle)
        print('  ', path)

    print('desktop / store')
    for path in ('assets/logo.png', 'public/logo.png'):
        save(render(squircle, 512), os.path.join(ROOT, path))
    for name, size in [('32x32.png', 32), ('64x64.png', 64), ('128x128.png', 128),
                       ('128x128@2x.png', 256), ('icon.png', 512),
                       ('Square30x30Logo.png', 30), ('Square44x44Logo.png', 44),
                       ('Square71x71Logo.png', 71), ('Square89x89Logo.png', 89),
                       ('Square107x107Logo.png', 107), ('Square142x142Logo.png', 142),
                       ('Square150x150Logo.png', 150), ('Square284x284Logo.png', 284),
                       ('Square310x310Logo.png', 310), ('StoreLogo.png', 50)]:
        save(render(squircle, size), os.path.join(icons, name))

    print('windows ico / macos icns')
    ico = os.path.join(icons, 'icon.ico')
    render(squircle, 256).save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64),
                                           (128, 128), (256, 256)])
    print('   src-tauri/icons/icon.ico')
    build_icns(squircle, os.path.join(icons, 'icon.icns'))

    print('ios (system applies its own mask -> full-bleed opaque square)')
    for name, size in [('AppIcon-20x20@1x.png', 20), ('AppIcon-20x20@2x.png', 40),
                       ('AppIcon-20x20@2x-1.png', 40), ('AppIcon-20x20@3x.png', 60),
                       ('AppIcon-29x29@1x.png', 29), ('AppIcon-29x29@2x.png', 58),
                       ('AppIcon-29x29@2x-1.png', 58), ('AppIcon-29x29@3x.png', 87),
                       ('AppIcon-40x40@1x.png', 40), ('AppIcon-40x40@2x.png', 80),
                       ('AppIcon-40x40@2x-1.png', 80), ('AppIcon-40x40@3x.png', 120),
                       ('AppIcon-60x60@2x.png', 120), ('AppIcon-60x60@3x.png', 180),
                       ('AppIcon-76x76@1x.png', 76), ('AppIcon-76x76@2x.png', 152),
                       ('AppIcon-83.5x83.5@2x.png', 167), ('AppIcon-512@2x.png', 1024)]:
        save(render(square, size), os.path.join(icons, 'ios', name), opaque=True)

    print('android')
    # (density, legacy px, adaptive foreground px)
    for density, legacy, fg in [('mdpi', 48, 108), ('hdpi', 49, 162), ('xhdpi', 96, 216),
                                ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432)]:
        d = os.path.join(icons, 'android', 'mipmap-' + density)
        save(render(squircle, legacy), os.path.join(d, 'ic_launcher.png'))
        save(render(circle, legacy), os.path.join(d, 'ic_launcher_round.png'))
        save(render(foreground, fg), os.path.join(d, 'ic_launcher_foreground.png'))

    res = os.path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res')
    if os.path.isdir(res):
        print('android project (gen/)')
        for density in ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'):
            src = os.path.join(icons, 'android', 'mipmap-' + density)
            dst = os.path.join(res, 'mipmap-' + density)
            os.makedirs(dst, exist_ok=True)
            for f in sorted(os.listdir(src)):
                shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
                print('  ', os.path.relpath(os.path.join(dst, f), ROOT))


def build_icns(svg, path):
    """Minimal ICNS writer: PNG-compressed entries, which macOS reads natively."""
    types = [(b'icp4', 16), (b'icp5', 32), (b'ic07', 128), (b'ic08', 256),
             (b'ic09', 512), (b'ic10', 1024), (b'ic11', 32), (b'ic12', 64),
             (b'ic13', 256), (b'ic14', 512)]
    chunks = b''
    for kind, size in types:
        buf = BytesIO()
        render(svg, size).save(buf, format='PNG')
        data = buf.getvalue()
        chunks += kind + (len(data) + 8).to_bytes(4, 'big') + data
    open(path, 'wb').write(b'icns' + (len(chunks) + 8).to_bytes(4, 'big') + chunks)
    print('   src-tauri/icons/icon.icns')


if __name__ == '__main__':
    if shutil.which('rsvg-convert') is None:
        sys.exit('rsvg-convert not found (dnf install librsvg2-tools)')
    main()
