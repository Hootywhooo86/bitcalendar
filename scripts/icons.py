"""Draws every Bitcalendar icon from one 32x32 pixel-art calendar: web app, Android launcher /
splash / notification / widget previews, and the Windows .ico + tray icon. Run: python3 scripts/icons.py"""
import os
from PIL import Image, ImageDraw, ImageFont

BG, PANEL, LINE, PURPLE, ORANGE, TEXT, CELL, DIM, SOFT = '#0d0d1a', '#1a1a2e', '#3d3d5c', '#b388ff', '#ff9f1c', '#f5f5f5', '#24243c', '#9e9e9e', '#cfcfcf'
FONT = 'app/fonts/PressStart2P.ttf'
RES = 'android/app/src/main/res'


def art(bg=BG):
    """The calendar on a 32x32 grid. bg=None leaves it transparent."""
    im = Image.new('RGBA', (32, 32), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([5, 7, 26, 26], fill=PANEL, outline=PURPLE)
    d.rectangle([6, 8, 25, 12], fill=ORANGE)
    for x in (10, 21):
        d.rectangle([x, 5, x + 1, 9], fill=TEXT)
    for r in range(3):
        for c in range(4):
            x, y = 8 + c * 4, 15 + r * 4
            d.rectangle([x, y, x + 2, y + 2], fill=PURPLE if (r, c) == (1, 2) else LINE)
    d.point([(17, 22)], fill=ORANGE)
    return im


def silhouette():
    """White-on-clear version for Android's status bar (24x24 grid)."""
    im = Image.new('RGBA', (24, 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = (255, 255, 255, 255)
    d.rectangle([2, 4, 21, 21], fill=w)
    d.rectangle([4, 10, 19, 19], fill=(0, 0, 0, 0))
    for x in (6, 16):
        d.rectangle([x, 1, x + 1, 6], fill=w)
    for r in range(2):
        for c in range(4):
            x, y = 5 + c * 4, 11 + r * 4
            d.rectangle([x, y, x + 1, y + 1], fill=w)
    return im


def scaled(im, size):
    return im.resize((size, size), Image.NEAREST)


def centered(canvas_size, im, frac, bg):
    w, h = canvas_size
    out = Image.new('RGBA', (w, h), bg)
    side = max(32, int(min(w, h) * frac) // 32 * 32)
    out.alpha_composite(scaled(im, side), ((w - side) // 2, (h - side) // 2))
    return out


def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)


# ---- web app ----
for s in (192, 512):
    save(scaled(art(), s).convert('RGB'), f'app/icon-{s}.png')
save(scaled(art(), 180).convert('RGB'), 'app/apple-touch-icon.png')

# ---- Android ----
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in DENS.items():
    n = int(48 * k)
    save(scaled(art(), n).convert('RGB'), f'{RES}/mipmap-{name}/ic_launcher.png')
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, n - 1, n - 1], fill=255)
    rnd = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    rnd.paste(centered((n, n), art(None), 0.8, BG), (0, 0), mask)
    save(rnd, f'{RES}/mipmap-{name}/ic_launcher_round.png')
    f = int(108 * k)  # adaptive icon: art inside the 66dp safe zone
    save(centered((f, f), art(None), 0.58, (0, 0, 0, 0)), f'{RES}/mipmap-{name}/ic_launcher_foreground.png')
    save(scaled(silhouette(), int(24 * k)), f'{RES}/drawable-{name}/ic_stat_bitcal.png')
for folder in sorted(os.listdir(RES)):
    p = f'{RES}/{folder}/splash.png'
    if os.path.exists(p):
        w, h = Image.open(p).size
        save(centered((w, h), art(None), 0.28, BG).convert('RGB'), p)
with open(f'{RES}/values/ic_launcher_background.xml', 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0D0D1A</color>\n</resources>\n')


def widget_preview_month(w=500, h=500):
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=35, fill=LINE)
    d.rounded_rectangle([9, 9, w - 10, h - 10], radius=28, fill=PANEL)
    px, py, cw, ch = w * .04, h * .04, w * .92, h * .92
    u, col = ch / 15, cw / 7
    d.text((px + col * .1, py + u * .6), 'OCTOBER 2026', font=ImageFont.truetype(FONT, int(u * .5)), fill=PURPLE)
    for i, ch_ in enumerate('SMTWTFS'):
        f = ImageFont.truetype(FONT, int(u * .4))
        d.text((px + col * (i + .5), py + u * 2.5), ch_, font=f, fill=DIM, anchor='mm')
    f = ImageFont.truetype(FONT, int(min(col, 2 * u) * .3))
    for i in range(42):
        day = i - 3
        x, y = px + col * (i % 7), py + u * 3 + u * 2 * (i // 7)
        g = col * .06
        other = not (1 <= day <= 31)
        today = day == 19
        fill = PURPLE if today else CELL
        cell = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(cell).rounded_rectangle([x + g, y + g, x + col - g, y + 2 * u - g], radius=6, fill=fill)
        if other:
            cell.putalpha(cell.getchannel('A').point(lambda a: a // 4))
        im.alpha_composite(cell)
        num = (day - 1) % 31 + 1 if other else day
        busy = day in (5, 12, 19, 20, 21, 22, 24, 26, 28)
        cy = y + u - (u * .2 if busy else 0)
        d.text((x + col / 2, cy), str(num), font=f, fill=BG if today else (SOFT if not other else '#4a4a5e'), anchor='mm')
        if busy:
            r = col * .05
            d.rectangle([x + col / 2 - r, y + 2 * u * .72 - r, x + col / 2 + r, y + 2 * u * .72 + r], fill=BG if today else ORANGE)
    return im


def widget_preview_upnext(w=500, h=220):
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=22, fill=LINE)
    d.rounded_rectangle([7, 7, w - 8, h - 8], radius=17, fill=PANEL)
    f, fs, ft = ImageFont.truetype(FONT, 14), ImageFont.truetype(FONT, 11), ImageFont.truetype(FONT, 15)
    d.polygon([(25, 22), (25, 34), (33, 28)], fill=ORANGE)
    d.text((40, 21), 'UP NEXT', font=f, fill=ORANGE)
    d.text((w - 25, 21), 'MON OCT 19', font=fs, fill=DIM, anchor='ra')
    rows = [('IN 25M', 'Standup', '#46d6db'), ('IN 5H 10M', 'Design review', '#9fe1e7'), ('TOMORROW', "Nana's birthday", ORANGE)]
    for i, (cd, t, c) in enumerate(rows):
        y = 56 + i * 52
        d.rectangle([25, y, 30, y + 42], fill=c)
        d.text((42, y + 2), cd, font=fs, fill=ORANGE)
        d.text((42, y + 20), t, font=ft, fill=TEXT)
    return im


save(widget_preview_month(), f'{RES}/drawable-nodpi/widget_month_preview.png')
save(widget_preview_upnext(), f'{RES}/drawable-nodpi/widget_upnext_preview.png')

# ---- Windows ----
save(scaled(art(), 512), 'desktop/build/icon.png')
scaled(art(), 256).save('desktop/build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
save(scaled(art(None), 32), 'desktop/build/tray.png')
save(scaled(art(None), 64), 'desktop/build/tray@2x.png')
print('icons done')
