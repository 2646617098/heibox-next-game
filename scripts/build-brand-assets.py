"""生成「下一个玩什么」的正式图标与封面。

配色直接取自 src/styles.css 的深色主题变量，保证和页面一致：
    page #14191E / surface #1B2127 / surface-muted #232A31 / border #2B3238
    text #F7F8F9 / secondary #91959A / accent #32B846

图标语义：一叠卡片（= 你的游戏库）+ 抽出一张按下播放（= 下一个玩什么）。
封面语义：左边讲清楚产品，右边给出推荐卡的样子。

所有图形先按 4 倍尺寸绘制再 LANCZOS 缩小，避免锯齿。
"""

from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent
while not (ROOT / "package.json").exists():
    if ROOT.parent == ROOT:
        sys.exit("找不到项目根目录（package.json）")
    ROOT = ROOT.parent

ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

# 上架规范尺寸：图标 200x200，封面 510x272（见《小程序工坊上架规则》第十二条设计规范）
ICON_SIZE = 200
COVER_WIDTH, COVER_HEIGHT = 510, 272
# 图标以设计稿位图为准，见 build_icon()
ICON_SOURCE = ASSETS / "icon-source.png"

PAGE = (0x14, 0x19, 0x1E)
SURFACE = (0x1B, 0x21, 0x27)
MUTED = (0x23, 0x2A, 0x31)
BORDER = (0x2B, 0x32, 0x38)
TRACK = (0x2B, 0x32, 0x38)
TEXT = (0xF7, 0xF8, 0xF9)
SECONDARY = (0x91, 0x95, 0x9A)
ACCENT = (0x32, 0xB8, 0x46)

SS = 4  # supersampling 倍数


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """竖向线性渐变。"""
    width, height = size
    gradient = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(height - 1, 1)
        gradient.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return gradient.resize((width, height), Image.Resampling.BILINEAR)


def radial_glow(size: tuple[int, int], center: tuple[float, float], radius: float, color: tuple[int, int, int], strength: float) -> Image.Image:
    """从 center 向外衰减的柔光，用来把主体从背景里托起来。"""
    small = 128  # 低分辨率算完再放大，够柔且快
    width, height = size
    glow = Image.new("L", (small, small), 0)
    pixels = glow.load()
    cx, cy = center[0] / width * small, center[1] / height * small
    r = radius / width * small
    for y in range(small):
        for x in range(small):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d < r:
                pixels[x, y] = int(255 * strength * (1 - d / r) ** 2)
    glow = glow.resize(size, Image.Resampling.BICUBIC)
    layer = Image.new("RGB", size, color)
    return layer, glow


def paste_glow(base: Image.Image, color: tuple[int, int, int], center: tuple[float, float], radius: float, strength: float) -> None:
    layer, mask = radial_glow(base.size, center, radius, color, strength)
    base.paste(layer, (0, 0), mask)


def load_font(names: list[str], size: int) -> ImageFont.FreeTypeFont:
    for name in names:
        path = pathlib.Path("C:/Windows/Fonts") / name
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                continue
    return ImageFont.load_default()


def build_icon() -> Image.Image:
    """200x200 图标：以 `assets/icon-source.png`（设计稿）为准，缩小后轻度锐化。

    设计稿是一张彩色转盘：四个象限分别是手柄、骰子、纸牌、问号，指向「从库里抽一个」。
    它无法用几行绘图代码忠实复现，所以图标改成"位图设计稿 → 规范尺寸"的流程；
    代码重绘的旧版本（斜叠卡 + 播放三角）已随 0.1.1 下线。
    """
    if not ICON_SOURCE.exists():
        sys.exit(f"缺少图标源文件：{ICON_SOURCE}")

    source = Image.open(ICON_SOURCE).convert("RGB")
    # 非正方形时按中心裁成正方形，避免拉伸变形（当前源图 1254x1254，等同原样）。
    side = min(source.size)
    left = (source.width - side) // 2
    top = (source.height - side) // 2
    square = source.crop((left, top, left + side, top + side))

    icon = square.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    # 6 倍降采样会把四象限的分界线糊掉；轻度锐化能让小尺寸下仍然分得清。
    return icon.filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))


def build_cover() -> Image.Image:
    """510x272 封面（上架规范的封面尺寸）：左侧文案 + 右侧推荐卡示意。

    尺寸必须按规范来：平台封面字段要求 510x272（比例 1.875:1）。原来出的是
    1280x720（1.778:1），比例不对，商店卡片会裁切。所有坐标都是 W/H 的比例，
    所以换比例后布局会自动适配。
    """
    W, H = COVER_WIDTH * 2, COVER_HEIGHT * 2  # 2 倍超采样，尺寸大一点内存仍可控
    canvas = Image.new("RGB", (W, H), PAGE)
    canvas.paste(vertical_gradient((W, H), (0x1B, 0x22, 0x29), (0x10, 0x14, 0x18)), (0, 0))
    paste_glow(canvas, ACCENT, (W * 0.22, H * 0.30), W * 0.42, 0.16)
    paste_glow(canvas, (0x2D, 0x6C, 0xF0), (W * 0.92, H * 0.85), W * 0.35, 0.10)

    draw = ImageDraw.Draw(canvas)
    bold = load_font(["msyhbd.ttc", "msyh.ttc", "simhei.ttf"], int(H * 0.115))
    bold_sm = load_font(["msyhbd.ttc", "msyh.ttc", "simhei.ttf"], int(H * 0.036))
    regular = load_font(["msyh.ttc", "simhei.ttf", "simsun.ttc"], int(H * 0.038))
    small = load_font(["msyh.ttc", "simhei.ttf", "simsun.ttc"], int(H * 0.028))
    name_font = load_font(["msyhbd.ttc", "msyh.ttc", "simhei.ttf"], int(H * 0.046))

    left = W * 0.075
    # eyebrow
    draw.text((left, H * 0.17), "nextGame", font=bold_sm, fill=ACCENT)
    # 标题
    draw.text((left, H * 0.235), "下一个玩什么", font=bold, fill=TEXT)
    # 副标题
    draw.text((left, H * 0.44), "不知道玩什么？", font=regular, fill=SECONDARY)
    draw.text((left, H * 0.505), "按你最近的游玩口味，", font=regular, fill=SECONDARY)
    draw.text((left, H * 0.565), "从你自己的 Steam 库里挑一款。", font=regular, fill=SECONDARY)

    # 底部三个小特性。必须限制在左半区，否则会被右侧卡片盖住。
    feats = ["只读你的库", "不联网", "一次一个答案"]
    x = left
    chip_max_x = W * 0.505 - W * 0.03
    for feat in feats:
        tw = draw.textlength(feat, font=small)
        pad = H * 0.018
        chip_w = tw + pad * 2
        if x + chip_w > chip_max_x:
            break
        draw.rounded_rectangle(
            (x, H * 0.715, x + chip_w, H * 0.715 + H * 0.058),
            radius=H * 0.029,
            fill=MUTED,
        )
        draw.text((x + pad, H * 0.727), feat, font=small, fill=SECONDARY)
        x += chip_w + H * 0.018

    # ── 右侧推荐卡 ──
    card_x0, card_y0 = W * 0.505, H * 0.20
    card_x1, card_y1 = W * 0.935, H * 0.79
    draw.rounded_rectangle(
        (card_x0, card_y0, card_x1, card_y1), radius=H * 0.036, fill=SURFACE, outline=BORDER, width=int(2 * 2)
    )

    pad = W * 0.026
    ix, iy = card_x0 + pad, card_y0 + pad

    # 封面缩略图（渐变方块代替真实图片）
    thumb = W * 0.115
    thumb_img = vertical_gradient((int(thumb), int(thumb)), (0x3A, 0x2E, 0x5C), (0x1B, 0x21, 0x27))
    tmask = Image.new("L", thumb_img.size, 0)
    ImageDraw.Draw(tmask).rounded_rectangle(
        (0, 0, thumb_img.size[0] - 1, thumb_img.size[1] - 1), radius=int(thumb * 0.18), fill=255
    )
    canvas.paste(thumb_img, (int(ix), int(iy)), tmask)

    text_x = ix + thumb + W * 0.018
    draw.text((text_x, iy - H * 0.010), "按你最近的「卡牌战斗」口味挑的", font=small, fill=ACCENT)
    draw.text((text_x, iy + H * 0.026), "超时空方舟", font=name_font, fill=TEXT)

    # 类型标签
    chips = ["牌组构建式类 Rogue", "策略", "独立"]
    chip_y = iy + H * 0.102
    chip_x = text_x
    for chip in chips:
        cw = draw.textlength(chip, font=small)
        cpad = H * 0.014
        if chip_x + cw + cpad * 2 > card_x1 - pad:
            break
        draw.rounded_rectangle(
            (chip_x, chip_y, chip_x + cw + cpad * 2, chip_y + H * 0.046),
            radius=H * 0.023,
            fill=MUTED,
        )
        draw.text((chip_x + cpad, chip_y + H * 0.009), chip, font=small, fill=SECONDARY)
        chip_x += cw + cpad * 2 + H * 0.012

    # 打分条
    bar_y = chip_y + H * 0.085
    draw.text((ix, bar_y), "口味契合度", font=small, fill=SECONDARY)
    bar_x0 = ix + W * 0.085
    bar_x1 = card_x1 - pad - W * 0.075
    draw.rounded_rectangle(
        (bar_x0, bar_y + H * 0.010, bar_x1, bar_y + H * 0.026), radius=H * 0.008, fill=TRACK
    )
    filled = bar_x0 + (bar_x1 - bar_x0) * 0.62
    draw.rounded_rectangle(
        (bar_x0, bar_y + H * 0.010, filled, bar_y + H * 0.026), radius=H * 0.008, fill=ACCENT
    )
    draw.text((bar_x1 + W * 0.012, bar_y - H * 0.002), "62%", font=small, fill=TEXT)

    # 理由
    reason_y = bar_y + H * 0.062
    for line in ["买了之后一次都没启动过", "和你近期的口味重合：卡牌战斗、牌组构建"]:
        draw.ellipse(
            (ix + W * 0.002, reason_y + H * 0.014, ix + W * 0.002 + H * 0.012, reason_y + H * 0.026),
            fill=ACCENT,
        )
        draw.text((ix + W * 0.014, reason_y), line, font=small, fill=SECONDARY)
        reason_y += H * 0.042

    # 底部按钮示意
    btn_y = card_y1 - pad - H * 0.072
    draw.rounded_rectangle(
        (ix, btn_y, card_x1 - pad, btn_y + H * 0.072), radius=H * 0.018, fill=MUTED, outline=BORDER
    )
    btn_text = "在小黑盒看游戏详情"
    tw = draw.textlength(btn_text, font=small)
    draw.text(
        (ix + (card_x1 - pad - ix - tw) / 2, btn_y + H * 0.018), btn_text, font=small, fill=ACCENT
    )

    return canvas.resize((COVER_WIDTH, COVER_HEIGHT), Image.Resampling.LANCZOS)


def main() -> None:
    icon = build_icon()
    icon_path = ASSETS / "icon.png"
    icon.save(icon_path, optimize=True)
    print(f"icon  {icon.size[0]}x{icon.size[1]}  {icon_path.stat().st_size} bytes  → {icon_path}")

    cover = build_cover()
    cover_path = ASSETS / "cover.png"
    cover.save(cover_path, optimize=True)
    print(f"cover {cover.size[0]}x{cover.size[1]}  {cover_path.stat().st_size} bytes  → {cover_path}")


if __name__ == "__main__":
    main()
