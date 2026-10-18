"""图标候选 v2：修正卡片层次对比、对齐关系，并补一个手柄方案。

v1 的问题：
  1) 背后的卡片用了 BORDER/MUTED，在深色底上几乎看不见，"一叠"的语义读不出来；
  2) E 的装饰卡偏在左下，看起来像画歪了；
  3) F 三张卡 + 大箭头太挤。
v2 的做法：卡片分三级明度（#262E36 / #303A43 / 绿），装饰卡统一"右上偏移"，
让层叠关系成为有意的设计。
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent
OUT.mkdir(exist_ok=True)

PAGE = (0x14, 0x19, 0x1E)
CARD_BACK = (0x26, 0x2E, 0x36)
CARD_MID = (0x30, 0x3A, 0x43)
TEXT = (0xF7, 0xF8, 0xF9)
ACCENT = (0x32, 0xB8, 0x46)

S = 800


def vertical_gradient(size, top, bottom):
    width, height = size
    gradient = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(height - 1, 1)
        gradient.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return gradient.resize((width, height), Image.Resampling.BILINEAR)


def glow(size, center, radius, color, strength):
    small = 128
    width, height = size
    layer_mask = Image.new("L", (small, small), 0)
    pixels = layer_mask.load()
    cx, cy = center[0] / width * small, center[1] / height * small
    r = radius / width * small
    for y in range(small):
        for x in range(small):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d < r:
                pixels[x, y] = int(255 * strength * (1 - d / r) ** 2)
    return Image.new("RGB", size, color), layer_mask.resize(size, Image.Resampling.BICUBIC)


def base_canvas(glow_strength=0.18):
    canvas = Image.new("RGB", (S, S), PAGE)
    canvas.paste(vertical_gradient((S, S), (0x1F, 0x27, 0x2E), PAGE), (0, 0))
    if glow_strength > 0:
        layer, mask = glow(canvas.size, (0.5 * S, 0.54 * S), 0.46 * S, ACCENT, glow_strength)
        canvas.paste(layer, (0, 0), mask)
    return canvas


def load_font(names, size):
    for name in names:
        path = pathlib.Path("C:/Windows/Fonts") / name
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                continue
    return ImageFont.load_default()


def card(draw, box, fill, radius_ratio=0.10):
    x0, y0, x1, y1 = (v * S for v in box)
    draw.rounded_rectangle((x0, y0, x1, y1), radius=int(S * radius_ratio), fill=fill)


def triangle(draw, cx, cy, r, fill):
    draw.polygon(
        [(cx - r * 0.72, cy - r), (cx - r * 0.72, cy + r), (cx + r * 1.05, cy)],
        fill=fill,
    )


def finish(canvas, name):
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    canvas.putalpha(mask)
    canvas.resize((400, 400), Image.Resampling.LANCZOS).save(OUT / f"{name}@2x.png")
    canvas.resize((200, 200), Image.Resampling.LANCZOS).save(OUT / f"{name}.png")
    print(f"{name}")


# A2：斜叠卡 + 播放（层次更清楚，最贴近现状）
def icon_a2():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.18, 0.30, 0.68, 0.70), CARD_BACK, 0.11)
    card(draw, (0.24, 0.25, 0.74, 0.65), CARD_MID, 0.11)
    card(draw, (0.32, 0.39, 0.82, 0.79), ACCENT, 0.11)
    triangle(draw, 0.565 * S, 0.59 * S, 0.105 * S, PAGE)
    finish(canvas, "A2-叠卡播放")


# B2：斜叠卡 + 快进双三角
def icon_b2():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.18, 0.30, 0.68, 0.70), CARD_BACK, 0.11)
    card(draw, (0.24, 0.25, 0.74, 0.65), CARD_MID, 0.11)
    card(draw, (0.32, 0.39, 0.82, 0.79), ACCENT, 0.11)
    triangle(draw, 0.495 * S, 0.59 * S, 0.082 * S, PAGE)
    triangle(draw, 0.605 * S, 0.59 * S, 0.082 * S, PAGE)
    finish(canvas, "B2-叠卡快进")


# C2：一张卡 + 问号
def icon_c2():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.25, 0.17, 0.75, 0.83), ACCENT, 0.13)
    font = load_font(["msyhbd.ttc", "msyh.ttc", "simhei.ttf"], int(S * 0.54))
    text = "?"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((S - tw) / 2 - bbox[0], (S - th) / 2 - bbox[1] - S * 0.015), text, font=font, fill=PAGE)
    finish(canvas, "C2-卡牌问号")


# D2：骰子
def icon_d2():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.21, 0.21, 0.79, 0.79), ACCENT, 0.22)
    r = 0.038 * S
    for fx, fy in ((0.35, 0.35), (0.65, 0.35), (0.5, 0.5), (0.35, 0.65), (0.65, 0.65)):
        draw.ellipse((fx * S - r, fy * S - r, fx * S + r, fy * S + r), fill=PAGE)
    finish(canvas, "D2-骰子")


# E2：两张卡 + 右箭头（装饰卡右上偏移，看起来是有意的层叠）
def icon_e2():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.20, 0.22, 0.70, 0.70), CARD_MID, 0.12)
    card(draw, (0.28, 0.30, 0.78, 0.78), ACCENT, 0.12)
    shaft_y = 0.54 * S
    draw.rounded_rectangle(
        (0.385 * S, shaft_y - 0.032 * S, 0.60 * S, shaft_y + 0.032 * S),
        radius=0.032 * S,
        fill=PAGE,
    )
    draw.polygon(
        [(0.575 * S, shaft_y - 0.115 * S), (0.575 * S, shaft_y + 0.115 * S), (0.715 * S, shaft_y)],
        fill=PAGE,
    )
    finish(canvas, "E2-卡片箭头")


# G：手柄 + 播放三角
def icon_g():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    # 手柄主体 + 两个握把，同色合并成一个剪影
    draw.rounded_rectangle(
        (0.15 * S, 0.35 * S, 0.85 * S, 0.66 * S),
        radius=0.16 * S,
        fill=ACCENT,
    )
    draw.ellipse((0.13 * S, 0.50 * S, 0.35 * S, 0.78 * S), fill=ACCENT)
    draw.ellipse((0.65 * S, 0.50 * S, 0.87 * S, 0.78 * S), fill=ACCENT)
    triangle(draw, 0.50 * S, 0.565 * S, 0.098 * S, PAGE)
    finish(canvas, "G-手柄播放")


if __name__ == "__main__":
    for fn in (icon_a2, icon_b2, icon_c2, icon_d2, icon_e2, icon_g):
        fn()
