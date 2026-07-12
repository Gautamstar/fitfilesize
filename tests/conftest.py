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
def blank_pdf(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("corpus") / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    return path
