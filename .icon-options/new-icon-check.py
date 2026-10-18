import pathlib
from PIL import Image, ImageFilter, ImageDraw, ImageFont
src = Image.open("assets/icon-source.png").convert("RGB")
plain = src.resize((200,200), Image.Resampling.LANCZOS)
sharp = src.resize((200,200), Image.Resampling.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))
sheet = Image.new("RGB", (520, 300), (0xF7,0xF8,0xF9))
sheet.paste(plain, (20, 20))
sheet.paste(sharp, (260, 20))
d = ImageDraw.Draw(sheet)
f = ImageFont.truetype(r"C:/Windows/Fonts/msyhbd.ttc", 18)
d.text((20, 232), "直接 LANCZOS 缩小", font=f, fill=(0x14,0x19,0x1E))
d.text((260, 232), "缩小 + 轻度锐化", font=f, fill=(0x14,0x19,0x1E))
# 小尺寸对照
for i, size in enumerate((96, 48)):
    a = plain.resize((size,size), Image.Resampling.LANCZOS)
    b = sharp.resize((size,size), Image.Resampling.LANCZOS)
    sheet.paste(a, (20 + i*(size+240), 270 - size))
    sheet.paste(b, (260 + i*(size+240), 270 - size))
sheet.save(".icon-options/00-新图标-缩小对比.png")
print("ok")
