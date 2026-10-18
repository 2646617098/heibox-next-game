"""把候选图标拼成一张对照图，便于一次看全（仅设计评审用）。"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
NAMES = [
    ("A-叠卡播放", "A 斜叠卡 + 播放（现状）"),
    ("B-叠卡快进", "B 斜叠卡 + 快进"),
    ("C-卡牌问号", "C 卡牌 + 问号"),
    ("D-骰子", "D 骰子（抽一个）"),
    ("E-卡片箭头", "E 卡牌 + 右箭头"),
    ("F-叠卡小上箭", "F 叠卡 + 上箭头"),
]

TILE = 400
PAD = 24
LABEL_H = 34
COLS, ROWS = 3, 2
W = COLS * (TILE + PAD) + PAD
H = ROWS * (TILE + LABEL_H + PAD) + PAD
sheet = Image.new("RGB", (W, H), (0x0E, 0x12, 0x16))
draw = ImageDraw.Draw(sheet)


def font(size):
    for name in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf"):
        path = pathlib.Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


f = font(20)
for index, (slug, label) in enumerate(NAMES):
    col, row = index % COLS, index // COLS
    x = PAD + col * (TILE + PAD)
    y = PAD + row * (TILE + LABEL_H + PAD)
    tile = Image.open(HERE / f"{slug}@2x.png").convert("RGB")
    sheet.paste(tile, (x, y))
    draw.text((x, y + TILE + 6), label, font=f, fill=(0xE6, 0xEA, 0xEE))

sheet.save(HERE / "00-对照.png")
print("对照图:", sheet.size)
