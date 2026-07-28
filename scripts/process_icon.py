from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "app-icon-source.png"
PNG_OUT = ROOT / "assets" / "app-icon.png"
ICO_OUT = ROOT / "assets" / "app-icon.ico"


def is_background(pixel: tuple[int, int, int, int]) -> bool:
    r, g, b, _ = pixel
    return r >= 238 and g >= 238 and b >= 238 and max(r, g, b) - min(r, g, b) <= 10


def remove_connected_white(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    queue: deque[tuple[int, int]] = deque([(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)])
    visited: set[tuple[int, int]] = set()
    while queue:
        x, y = queue.popleft()
        if (x < 0 or y < 0 or x >= width or y >= height or (x, y) in visited):
            continue
        visited.add((x, y))
        pixel = pixels[x, y]
        if not is_background(pixel):
            continue
        pixels[x, y] = (pixel[0], pixel[1], pixel[2], 0)
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return image


def main() -> None:
    source = Image.open(SOURCE)
    result = remove_connected_white(source)
    result.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(result, ((1024 - result.width) // 2, (1024 - result.height) // 2))
    canvas.save(PNG_OUT, optimize=True)
    canvas.save(
        ICO_OUT,
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"PNG={PNG_OUT} ICO={ICO_OUT}")


if __name__ == "__main__":
    main()
