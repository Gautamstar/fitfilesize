from pathlib import Path

import pikepdf
import pytest
from PIL import Image, ImageDraw


def _page_image(width: int, height: int, hue: int) -> Image.Image:
    base = Image.linear_gradient("L").resize((width, height))
    r = base
    g = base.transpose(Image.Transpose.ROTATE_180)
    b = base.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    img = Image.merge("RGB", (r, g, b))
    draw = ImageDraw.Draw(img)
    for i in range(6):
        x = 100 + i * (width // 8)
        draw.ellipse([x, 100 + hue * 40, x + 220, 320 + hue * 40], outline=(255, 255, 255), width=8)
    return img


@pytest.fixture(scope="session")
def image_pdf(tmp_path_factory) -> Path:
    """A 3-page image-heavy PDF, smooth gradients so JPEG recompression bites."""
    path = tmp_path_factory.mktemp("corpus") / "image_heavy.pdf"
    pages = [_page_image(1600, 1200, i) for i in range(3)]
    pages[0].save(
        path, "PDF", save_all=True, append_images=pages[1:], resolution=96.0, quality=95
    )
    return path


@pytest.fixture(scope="session")
def photo_jpg(tmp_path_factory) -> Path:
    """A large, high-quality JPEG, the phone-photo case."""
    path = tmp_path_factory.mktemp("corpus") / "photo.jpg"
    _page_image(3000, 2000, 1).save(path, "JPEG", quality=98, optimize=False)
    return path


@pytest.fixture(scope="session")
def photo_png(tmp_path_factory) -> Path:
    """A photo saved as PNG: gradients and grain, which 256 colours cannot
    hold. No 256-colour PNG of it gets under PHOTO_PNG_LIMIT; a JPEG does."""
    path = tmp_path_factory.mktemp("corpus") / "photo.png"
    w, h = 2000, 1500
    g = Image.linear_gradient("L").resize((w, h))
    base = Image.merge("RGB", (g, g.transpose(Image.ROTATE_90).resize((w, h)), g.transpose(Image.FLIP_LEFT_RIGHT)))
    Image.blend(base, Image.effect_noise((w, h), 60).convert("RGB"), 0.5).save(path, "PNG")
    return path


@pytest.fixture(scope="session")
def transparent_photo_png(photo_png, tmp_path_factory) -> Path:
    """photo_png with see-through parts: it can only fit as a JPEG, which
    turns them white."""
    path = tmp_path_factory.mktemp("corpus") / "photo-alpha.png"
    img = Image.open(photo_png).convert("RGBA")
    img.putalpha(Image.linear_gradient("L").resize(img.size))
    img.save(path, "PNG")
    return path


@pytest.fixture(scope="session")
def transparent_png(tmp_path_factory) -> Path:
    """RGBA PNG, to exercise the alpha-flattening path."""
    path = tmp_path_factory.mktemp("corpus") / "logo.png"
    img = _page_image(1200, 900, 2).convert("RGBA")
    alpha = Image.linear_gradient("L").resize((1200, 900))
    img.putalpha(alpha)
    img.save(path, "PNG")
    return path


@pytest.fixture(scope="session")
def blank_pdf(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("corpus") / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    return path
