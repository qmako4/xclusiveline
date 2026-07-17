from __future__ import annotations

import io
import json
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps
import imageio_ffmpeg


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
PRODUCTS_API = "https://xclusiveline-images.qmako41212.workers.dev/api/products"
PREFERRED_PRODUCTS = [
    "Triple Sevens T-Shirt",
    "Saint Mxxx Shorts",
    "Kendrick x SZA Vest",
    "Corteiz Grey Joggers",
    "Nike Stussy Polo Shirt",
    "Asics Gel Kayano 14 - Blue",
    "Rick Owens Suede Sneakers",
]


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "XCLUSIVELINE-Hero/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def load_products() -> list[Image.Image]:
    payload = json.loads(fetch(PRODUCTS_API))
    by_name = {product.get("name"): product for product in payload.get("products", [])}
    images = []
    for name in PREFERRED_PRODUCTS:
        product = by_name.get(name)
        product_images = product.get("images", []) if product else []
        if not product_images:
            continue
        image = Image.open(io.BytesIO(fetch(product_images[0]["url"]))).convert("RGB")
        images.append(image)
    if len(images) < 4:
        raise RuntimeError("Not enough storefront product images were available")
    return images


def cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def motion_cover(
    source: Image.Image,
    size: tuple[int, int],
    progress: float,
    reverse: bool = False,
) -> Image.Image:
    width, height = size
    scale = 1.0 + progress * 0.025
    frame = cover(source, (int(width * scale), int(height * scale)))
    travel_x = max(0, frame.width - width)
    travel_y = max(0, frame.height - height)
    left = int(travel_x * ((1 - progress) if reverse else progress))
    top = travel_y // 2
    return frame.crop((left, top, left + width, top + height))


def desktop_frame(
    source: Image.Image,
    companion: Image.Image,
    size: tuple[int, int],
    progress: float,
) -> Image.Image:
    width, height = size
    divider = 8
    left_width = (width - divider) // 2
    right_width = width - divider - left_width
    canvas = Image.new("RGB", size, "#F5A800")
    canvas.paste(motion_cover(source, (left_width, height), progress), (0, 0))
    canvas.paste(
        motion_cover(companion, (right_width, height), progress, reverse=True),
        (left_width + divider, 0),
    )
    return canvas


def mobile_frame(source: Image.Image, size: tuple[int, int], progress: float) -> Image.Image:
    width, height = size
    scale = 1.0 + progress * 0.035
    scaled_size = (int(width * scale), int(height * scale))
    frame = cover(source, scaled_size)
    left = (frame.width - width) // 2
    top = int((frame.height - height) * (0.35 + progress * 0.3))
    return frame.crop((left, top, left + width, top + height))


def render_video(
    images: list[Image.Image],
    output: Path,
    poster: Path,
    size: tuple[int, int],
    mode: str,
) -> None:
    fps = 18
    seconds_per_scene = 1.35
    frames_per_scene = round(fps * seconds_per_scene)
    fade_frames = 1
    renderer = desktop_frame if mode == "desktop" else mobile_frame

    writer = imageio_ffmpeg.write_frames(
        str(output),
        size,
        fps=fps,
        codec="libx264",
        pix_fmt_in="rgb24",
        pix_fmt_out="yuv420p",
        output_params=["-preset", "medium", "-crf", "24", "-movflags", "+faststart"],
        macro_block_size=2,
    )
    writer.send(None)
    first_frame = None
    try:
        for scene_index, image in enumerate(images):
            next_image = images[(scene_index + 1) % len(images)]
            for frame_index in range(frames_per_scene):
                progress = frame_index / max(1, frames_per_scene - 1)
                if mode == "desktop":
                    frame = renderer(image, next_image, size, progress)
                else:
                    frame = renderer(image, size, progress)
                if frame_index >= frames_per_scene - fade_frames:
                    fade = (frame_index - (frames_per_scene - fade_frames) + 1) / fade_frames
                    if mode == "desktop":
                        following_image = images[(scene_index + 2) % len(images)]
                        upcoming = renderer(next_image, following_image, size, fade * 0.08)
                    else:
                        upcoming = renderer(next_image, size, fade * 0.08)
                    frame = Image.blend(frame, upcoming, fade)
                if first_frame is None:
                    first_frame = frame.copy()
                writer.send(frame.convert("RGB").tobytes())
    finally:
        writer.close()

    if first_frame is not None:
        first_frame.save(poster, "JPEG", quality=88, optimize=True, progressive=True)


def main() -> None:
    images = load_products()
    render_video(
        images,
        ASSETS / "xclusiveline-hero-desktop.mp4",
        ASSETS / "xclusiveline-hero-desktop.jpg",
        (1280, 720),
        "desktop",
    )
    render_video(
        images,
        ASSETS / "xclusiveline-hero-mobile.mp4",
        ASSETS / "xclusiveline-hero-mobile.jpg",
        (720, 900),
        "mobile",
    )


if __name__ == "__main__":
    main()
