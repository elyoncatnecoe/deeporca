"""Generate Windows and Android icon/splash assets from deepwhale.png."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = Image.open(ROOT / "deepwhale.png").convert("RGB")
RES = ROOT / "android" / "app" / "src" / "main" / "res"


def gradient(size, top, bottom):
    image = Image.new("RGB", (1, size[1]))
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (0, y)], fill=color)
    return image.resize(size)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def make_master(size=1024):
    canvas = gradient((size, size), (10, 63, 79), (4, 20, 29)).convert("RGBA")
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [size * 0.16, size * 0.16, size * 0.84, size * 0.84],
        fill=(64, 190, 200, 70),
    )
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(size * 0.06)))

    card_size = int(size * 0.72)
    pad = int(card_size * 0.055)
    card = Image.new("RGBA", (card_size, card_size), (250, 250, 250, 255))
    whale = SRC.resize((card_size - pad * 2, card_size - pad * 2), Image.LANCZOS).convert("RGBA")
    card.paste(whale, (pad, pad))
    card.putalpha(rounded_mask(card_size, int(card_size * 0.24)))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_card = Image.new("RGBA", (card_size, card_size), (0, 0, 0, 150))
    shadow_card.putalpha(rounded_mask(card_size, int(card_size * 0.24)))
    shadow.alpha_composite(shadow_card, (int(size * 0.14), int(size * 0.145)))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.025)))

    canvas.alpha_composite(card, ((size - card_size) // 2, (size - card_size) // 2))
    return canvas


MASTER = make_master(1024)

(ROOT / "resources").mkdir(exist_ok=True)
MASTER.resize((512, 512), Image.LANCZOS).save(ROOT / "resources" / "icon.png")
MASTER.resize((256, 256), Image.LANCZOS).save(
    ROOT / "resources" / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

for density, size in SIZES.items():
    folder = RES / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    legacy = MASTER.resize((size, size), Image.LANCZOS)
    legacy.save(folder / "ic_launcher.png")
    round_icon = legacy.convert("RGBA")
    circle = Image.new("L", (size, size), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, size - 1, size - 1], fill=255)
    round_icon.putalpha(circle)
    round_icon.save(folder / "ic_launcher_round.png")

for density, size in FG.items():
    folder = RES / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    card_size = int(size * 0.62)
    card = Image.new("RGBA", (card_size, card_size), (250, 250, 250, 255))
    pad = int(card_size * 0.055)
    whale = SRC.resize((card_size - pad * 2, card_size - pad * 2), Image.LANCZOS).convert("RGBA")
    card.paste(whale, (pad, pad))
    card.putalpha(rounded_mask(card_size, int(card_size * 0.24)))
    fg.alpha_composite(card, ((size - card_size) // 2, (size - card_size) // 2))
    fg.save(folder / "ic_launcher_foreground.png")

# Splash: portrait, dark gradient with the logo card centered in the upper half.
splash = gradient((1440, 2560), (7, 43, 56), (3, 15, 22)).convert("RGBA")
logo = MASTER.resize((460, 460), Image.LANCZOS)
splash.alpha_composite(logo, ((1440 - 460) // 2, 900))
splash.convert("RGB").save(RES / "drawable" / "splash.png")

# A dark adaptive-icon background instead of the teal Capacitor default.
(RES / "drawable" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n'
    '    <solid android:color="#04141d" />\n'
    '</shape>\n',
    encoding="utf-8",
)

# App-layer copy used by the HTML UI.
MASTER.resize((512, 512), Image.LANCZOS).save(ROOT / "public" / "app-icon.png")
print("icons written")
