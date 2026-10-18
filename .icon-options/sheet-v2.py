import pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(r"E:\software\Code\VibeCoding\heibox-nextGame\.icon-options")
NAMES = [("A2-叠卡播放","A 斜叠卡 + 播放"),("B2-叠卡快进","B 斜叠卡 + 快进"),("C2-卡牌问号","C 卡牌 + 问号"),
         ("D2-骰子","D 骰子（抽一个）"),("E2-卡片箭头","E 卡牌 + 右箭头"),("G-手柄播放","F 手柄 + 播放")]
TILE, PAD, LABEL_H, COLS = 400, 24, 34, 3
ROWS = 2
W = COLS*(TILE+PAD)+PAD; H = ROWS*(TILE+LABEL_H+PAD)+PAD
sheet = Image.new("RGB",(W,H),(0x0E,0x12,0x16)); draw = ImageDraw.Draw(sheet)
def font(size):
    for name in ("msyhbd.ttc","msyh.ttc","simhei.ttf"):
        p = pathlib.Path("C:/Windows/Fonts")/name
        if p.exists(): return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()
f = font(20)
for i,(slug,label) in enumerate(NAMES):
    col,row = i%COLS, i//COLS
    x = PAD+col*(TILE+PAD); y = PAD+row*(TILE+LABEL_H+PAD)
    sheet.paste(Image.open(HERE/f"{slug}@2x.png").convert("RGB"),(x,y))
    draw.text((x,y+TILE+6),label,font=f,fill=(0xE6,0xEA,0xEE))
sheet.save(HERE/"00-对照-v2.png")
print("ok", sheet.size)
