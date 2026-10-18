"""生成「下一个玩什么」图标的若干候选方案（一次性设计稿，不参与构建）。

统一视觉语言：深色圆角方 + 竖向渐变 + 品牌绿 #32B846 + 柔和光晕。
每个方案输出 200x200（上架规范）与 400x400（供挑选预览）。
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent
OUT.mkdir(exist_ok=True)

PAGE = (0x14, 0x19, 0x1E)
MUTED = (0x23, 0x2A, 0x31)
BORDER = (0x2B, 0x32, 0x38)
TEXT = (0xF7, 0xF8, 0xF9)
ACCENT = (0x32, 0xB8, 0x46)

S = 800  # 4 倍超采样


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


def base_canvas():
    canvas = Image.new("RGB", (S, S), PAGE)
    canvas.paste(vertical_gradient((S, S), (0x1F, 0x27, 0x2E), PAGE), (0, 0))
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


def card(draw, box, fill, outline=None, width=0, radius_ratio=0.10):
    x0, y0, x1, y1 = (v * S for v in box)
    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=int(S * radius_ratio),
        fill=fill,
        outline=outline,
        width=int(width * S),
    )


def triangle(draw, cx, cy, r, fill, scale=1.0):
    draw.polygon(
        [
            (cx - r * 0.72 * scale, cy - r * scale),
            (cx - r * 0.72 * scale, cy + r * scale),
            (cx + r * 1.05 * scale, cy),
        ],
        fill=fill,
    )


def finish(canvas, name):
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    canvas.putalpha(mask)
    canvas.resize((400, 400), Image.Resampling.LANCZOS).save(OUT / f"{name}@2x.png")
    canvas.resize((200, 200), Image.Resampling.LANCZOS).save(OUT / f"{name}.png")
    print(f"{name}: 200x200 + 400x400")


# A：斜叠卡 + 播放三角（现状）
def icon_a():
    canvas = base_canvas()
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.20, 0.24, 0.72, 0.62), BORDER)
    card(draw, (0.26, 0.30, 0.78, 0.70), MUTED)
    card(draw, (0.26, 0.30, 0.78, 0.70), None, BORDER, 0.006)
    card(draw, (0.34, 0.40, 0.80, 0.78), ACCENT)
    triangle(draw, 0.585 * S, 0.592 * S, 0.105 * S, PAGE)
    finish(canvas, "A-叠卡播放")


# B：斜叠卡 + 快进双三角（"下一个"语义更强）
def icon_b():
    canvas = base_canvas()
    layer, mask = glow(canvas.size, (0.57 * S, 0.60 * S), 0.46 * S, ACCENT, 0.20)
    canvas.paste(layer, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.20, 0.24, 0.72, 0.62), BORDER)
    card(draw, (0.26, 0.30, 0.78, 0.70), MUTED)
    card(draw, (0.34, 0.40, 0.80, 0.78), ACCENT)
    # 双三角：左侧实心、右侧略小，形成"继续向前"的节奏
    triangle(draw, 0.505 * S, 0.592 * S, 0.088 * S, PAGE)
    triangle(draw, 0.615 * S, 0.592 * S, 0.088 * S, PAGE)
    finish(canvas, "B-叠卡快进")


# C：一张卡 + 问号（"到底玩什么"）
def icon_c():
    canvas = base_canvas()
    layer, mask = glow(canvas.size, (0.5 * S, 0.5 * S), 0.44 * S, ACCENT, 0.18)
    canvas.paste(layer, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.26, 0.18, 0.74, 0.82), ACCENT, None, 0, 0.13)
    font = load_font(["msyhbd.ttc", "msyh.ttc", "simhei.ttf"], int(S * 0.56))
    text = "?"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((S - tw) / 2 - bbox[0], (S - th) / 2 - bbox[1] - S * 0.02),
        text,
        font=font,
        fill=PAGE,
    )
    finish(canvas, "C-卡牌问号")


# D：骰子（"不知道玩什么就抽一个"）
def icon_d():
    canvas = base_canvas()
    layer, mask = glow(canvas.size, (0.5 * S, 0.5 * S), 0.44 * S, ACCENT, 0.18)
    canvas.paste(layer, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.22, 0.22, 0.78, 0.78), ACCENT, None, 0, 0.20)
    # 五点：骰子最容易被一眼认出的是"五点"
    r = 0.043 * S
    for fx, fy in ((0.34, 0.34), (0.66, 0.34), (0.5, 0.5), (0.34, 0.66), (0.66, 0.66)):
        draw.ellipse((fx * S - r, fy * S - r, fx * S + r, fy * S + r), fill=PAGE)
    finish(canvas, "D-骰子")


# E：一张卡 + 右箭头（极简"下一个"）
def icon_e():
    canvas = base_canvas()
    layer, mask = glow(canvas.size, (0.5 * S, 0.5 * S), 0.44 * S, ACCENT, 0.16)
    canvas.paste(layer, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.16, 0.26, 0.66, 0.74), BORDER)
    card(draw, (0.24, 0.22, 0.74, 0.78), ACCENT, None, 0, 0.13)
    # 箭头：粗杆 + 实心三角头
    shaft_y = 0.5 * S
    draw.rounded_rectangle(
        (0.36 * S, shaft_y - 0.035 * S, 0.585 * S, shaft_y + 0.035 * S),
        radius=0.035 * S,
        fill=PAGE,
    )
    draw.polygon(
        [
            (0.56 * S, shaft_y - 0.13 * S),
            (0.56 * S, shaft_y + 0.13 * S),
            (0.72 * S, shaft_y),
        ],
        fill=PAGE,
    )
    finish(canvas, "E-卡片箭头")


# F：斜叠卡 + 向上箭头（从库里挑出最上面一张）
def icon_f():
    canvas = base_canvas()
    layer, mask = glow(canvas.size, (0.5 * S, 0.44 * S), 0.44 * S, ACCENT, 0.16)
    canvas.paste(layer, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    card(draw, (0.18, 0.40, 0.68, 0.78), BORDER)
    card(draw, (0.24, 0.32, 0.74, 0.72), MUTED)
    card(draw, (0.30, 0.20, 0.80, 0.64), ACCENT, None, 0, 0.12)
    # 上箭头
    cx = 0.55 * S
    draw.rounded_rectangle(
        (cx - 0.035 * S, 0.36 * S, cx + 0.035 * S, 0.58 * S),
        radius=0.035 * S,
        fill=PAGE,
    )
    draw.polygon(
        [(cx - 0.13 * S, 0.375 * S), (cx + 0.13 * S, 0.375 * S), (cx, 0.235 * S)],
        fill=PAGE,
    )
    finish(canvas, "F-叠卡小上箭")


if __name__ == "__main__":
    for fn in (icon_a, icon_b, icon_c, icon_d, icon_e, icon_f):
        fn()
