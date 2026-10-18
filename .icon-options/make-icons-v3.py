import pathlib, runpy
mod = runpy.run_path(r"E:\software\Code\VibeCoding\heibox-nextGame\.icon-options\make-icons-v2.py", run_name="lib")
S = mod["S"]; PAGE = mod["PAGE"]; ACCENT = mod["ACCENT"]
card = mod["card"]; triangle = mod["triangle"]; finish = mod["finish"]
base_canvas = mod["base_canvas"]; CARD_BACK = mod["CARD_BACK"]; CARD_MID = mod["CARD_MID"]
from PIL import ImageDraw

# B3：双三角间距修正
canvas = base_canvas(); draw = ImageDraw.Draw(canvas)
card(draw, (0.18, 0.30, 0.68, 0.70), CARD_BACK, 0.11)
card(draw, (0.24, 0.25, 0.74, 0.65), CARD_MID, 0.11)
card(draw, (0.32, 0.39, 0.82, 0.79), ACCENT, 0.11)
triangle(draw, 0.468 * S, 0.59 * S, 0.079 * S, PAGE)
triangle(draw, 0.622 * S, 0.59 * S, 0.079 * S, PAGE)
finish(canvas, "B3-叠卡快进")

# H：斜叠卡 + 右箭头（"从库里挑下一个"）
canvas = base_canvas(); draw = ImageDraw.Draw(canvas)
card(draw, (0.18, 0.30, 0.68, 0.70), CARD_BACK, 0.11)
card(draw, (0.24, 0.25, 0.74, 0.65), CARD_MID, 0.11)
card(draw, (0.32, 0.39, 0.82, 0.79), ACCENT, 0.11)
shaft_y = 0.59 * S
draw.rounded_rectangle((0.405 * S, shaft_y - 0.030 * S, 0.585 * S, shaft_y + 0.030 * S), radius=0.030 * S, fill=PAGE)
draw.polygon([(0.565 * S, shaft_y - 0.105 * S), (0.565 * S, shaft_y + 0.105 * S), (0.685 * S, shaft_y)], fill=PAGE)
finish(canvas, "H-叠卡右箭头")
print("done")
