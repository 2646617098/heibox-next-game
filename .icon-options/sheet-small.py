import pathlib
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(r"E:\software\Code\VibeCoding\heibox-nextGame\.icon-options")
NAMES = [("A2-叠卡播放","A"),("B3-叠卡快进","B"),("H-叠卡右箭头","C"),("E2-卡片箭头","D"),("C2-卡牌问号","E"),("D2-骰子","F")]
SIZES = [200, 96, 48]
PAD = 20
W = PAD + len(NAMES)*(200+PAD)
H = PAD + 200 + 20 + 96 + 20 + 48 + 40 + 30
sheet = Image.new("RGB", (W, H), (0xF7, 0xF8, 0xF9))
draw = ImageDraw.Draw(sheet)
f = ImageFont.truetype(r"C:/Windows/Fonts/msyhbd.ttc", 22)
for i,(slug,label) in enumerate(NAMES):
    x = PAD + i*(200+PAD)
    y = PAD
    for size in SIZES:
        img = Image.open(HERE/f"{slug}@2x.png").convert("RGBA").resize((size,size), Image.Resampling.LANCZOS)
        sheet.paste(img, (x + (200-size)//2, y), img)
        y += size + 20
    draw.text((x+88, H-36), label, font=f, fill=(0x14,0x19,0x1E))
sheet.save(HERE/"00-小尺寸检验.png")
print("ok", sheet.size)
