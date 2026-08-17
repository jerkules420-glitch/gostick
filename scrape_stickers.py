from __future__ import annotations

import argparse
import asyncio
import base64
import json
import random
import re
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import numpy as np
from dotenv import load_dotenv

load_dotenv()

import cloudinary
import cloudinary.uploader
from PIL import Image
from playwright.async_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright
from scipy.ndimage import binary_propagation


BASE_URL = "https://csgoskins.gg/categories/sticker?page={page}"
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
IMAGE_SIZE_SEGMENT = re.compile(r"/auto/auto/\d+/notrim/")
CLOUDINARY_MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class Sticker:
    name: str
    image_url: str
    page_url: str
    detail_url: str
    preview_url: str | None = None


class SiteRateLimiter:
    def __init__(self, requests_per_minute: float, jitter: float) -> None:
        self.interval = 60.0 / requests_per_minute
        self.jitter = jitter
        self.next_allowed = 0.0

    async def wait(self) -> None:
        now = time.monotonic()
        delay = max(0.0, self.next_allowed - now)
        if self.next_allowed > 0:
            delay += random.uniform(0.0, self.jitter)
        if delay > 0:
            await asyncio.sleep(delay)
        self.next_allowed = time.monotonic() + self.interval

    def defer(self, seconds: float) -> None:
        self.next_allowed = max(self.next_allowed, time.monotonic() + seconds)


def safe_filename(name: str) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:180] or "unnamed-sticker"


def image_extension(content_type: str, url: str) -> str:
    known_types = {
        "image/avif": ".avif",
        "image/gif": ".gif",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }
    media_type = content_type.partition(";")[0].strip().lower()
    if media_type in known_types:
        return known_types[media_type]
    suffix = Path(unquote(urlparse(url).path)).suffix.lower()
    return suffix if suffix in known_types.values() else ".img"


def resized_image_url(url: str, image_size: int) -> str:
    if image_size <= 0:
        return url
    return IMAGE_SIZE_SEGMENT.sub(f"/auto/auto/{image_size}/notrim/", url)


def original_image_url(url: str) -> str | None:
    match = re.search(r"/public/uih/(?:items|inspections)/([^/]+)/", url)
    if not match:
        return None
    encoded = match.group(1).rstrip("-")
    try:
        padding = "=" * (-len(encoded) % 4)
        decoded = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    parsed = urlparse(decoded)
    if parsed.scheme != "https" or parsed.hostname != "cdn.csgoskins.gg":
        return None
    return decoded


def has_transparent_pixels(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            if image.mode != "RGBA":
                return False
            return image.getchannel("A").getextrema()[0] < 255
    except (OSError, ValueError):
        return False


def remove_image_background(source: Path, destination: Path) -> None:
    with Image.open(source) as source_image:
        image = np.asarray(source_image.convert("RGBA")).copy()

    rgb = image[:, :, :3].astype(np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    background = np.median(border, axis=0)
    color_distance = np.sqrt(np.sum((rgb - background) ** 2, axis=2))

    soft_start = 2.0
    soft_end = 48.0
    background_candidate = color_distance <= soft_end
    edge_seeds = np.zeros(background_candidate.shape, dtype=bool)
    edge_seeds[0] = background_candidate[0]
    edge_seeds[-1] = background_candidate[-1]
    edge_seeds[:, 0] = background_candidate[:, 0]
    edge_seeds[:, -1] = background_candidate[:, -1]
    connected_background = binary_propagation(edge_seeds, mask=background_candidate)

    edge_alpha = np.clip(
        (color_distance - soft_start) * 255.0 / (soft_end - soft_start),
        0,
        255,
    ).astype(np.uint8)
    image[:, :, 3][connected_background] = np.minimum(
        image[:, :, 3][connected_background], edge_alpha[connected_background]
    )
    Image.fromarray(image, mode="RGBA").save(destination, format="PNG")


async def is_security_challenge(page: Page) -> bool:
    title = (await page.title()).lower()
    body = (await page.locator("body").inner_text()).lower()
    challenge_text = ("just a moment", "security check", "verify you are human")
    return any(text in title or text in body for text in challenge_text)


async def wait_for_access(page: Page) -> bool:
    if not await is_security_challenge(page):
        return False

    print("Cloudflare security check detected.")
    print("Complete it in the Chrome window, then press Enter here.")
    await asyncio.to_thread(input)
    await page.wait_for_load_state("domcontentloaded")
    await page.wait_for_timeout(1_000)
    if await is_security_challenge(page):
        raise RuntimeError(
            "Cloudflare did not accept this browser session. Close this run and use "
            "the documented --cdp-url workflow with an ordinary Chrome window."
        )
    return True


async def load_page(
    page: Page,
    page_number: int,
    timeout_ms: int,
    rate_limiter: SiteRateLimiter,
    challenge_cooldown: float,
) -> None:
    url = BASE_URL.format(page=page_number)
    for attempt in range(1, 4):
        try:
            await rate_limiter.wait()
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            if await wait_for_access(page):
                rate_limiter.defer(challenge_cooldown)
                print(
                    f"Security check solved; pausing site navigation for "
                    f"{challenge_cooldown:.0f} seconds."
                )
            await page.wait_for_timeout(1_000)
            break
        except PlaywrightTimeoutError:
            if attempt == 3:
                raise
            print(f"Page {page_number} timed out; retrying ({attempt}/3)...")

    previous_height = 0
    for _ in range(12):
        height = await page.evaluate("document.body.scrollHeight")
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(250)
        if height == previous_height:
            break
        previous_height = height


async def extract_stickers(page: Page) -> list[Sticker]:
    raw_items: list[dict[str, Any]] = await page.locator(
        'a[href*="/items/sticker-"] img'
    ).evaluate_all(
        """
        images => images.map(image => {
            const anchor = image.closest('a[href]');
            const candidates = [
                image.currentSrc,
                image.getAttribute('data-src'),
                image.getAttribute('data-lazy-src'),
                image.getAttribute('src')
            ].filter(Boolean);
            const srcset = image.getAttribute('srcset') || image.getAttribute('data-srcset');
            if (srcset) {
                const largest = srcset.split(',')
                    .map(part => part.trim().split(/\\s+/))
                    .map(([url, descriptor]) => ({
                        url,
                        size: Number.parseFloat(descriptor || '0') || 0
                    }))
                    .sort((a, b) => b.size - a.size)[0];
                if (largest) candidates.unshift(largest.url);
            }
            return {
                imageUrl: candidates[0] || '',
                detailUrl: anchor ? anchor.href : '',
                imageAlt: image.getAttribute('alt') || '',
                imageTitle: image.getAttribute('title') || '',
                anchorTitle: anchor ? (anchor.getAttribute('title') || '') : '',
                anchorLabel: anchor ? (anchor.getAttribute('aria-label') || '') : '',
                anchorText: anchor ? (anchor.innerText || '') : ''
            };
        })
        """
    )

    stickers: list[Sticker] = []
    seen: set[tuple[str, str]] = set()
    for item in raw_items:
        image_url = str(item["imageUrl"]).strip()
        detail_url = str(item["detailUrl"]).strip()
        if "csgoskins.gg" not in image_url or "/items/sticker-" not in detail_url:
            continue

        name = ""
        for key in ("imageAlt", "imageTitle", "anchorTitle", "anchorLabel", "anchorText"):
            lines = [line.strip() for line in str(item[key]).splitlines() if line.strip()]
            candidate = next(
                (
                    line
                    for line in lines
                    if not re.search(r"(?:\$|€|£)\s*\d", line)
                    and not line.lower().startswith(("buy ", "view "))
                ),
                "",
            )
            if candidate:
                name = candidate
                break

        name = re.sub(r"^(?:sticker\s*[|:-]\s*)", "", name, flags=re.IGNORECASE)
        name = re.sub(r"\s+", " ", name).strip()
        if not name:
            slug = urlparse(detail_url).path.rstrip("/").split("/")[-1]
            name = unquote(slug).replace("-", " ").title()
        if not name:
            continue

        key = (name.casefold(), image_url)
        if key in seen:
            continue
        seen.add(key)
        stickers.append(Sticker(name, image_url, page.url, detail_url))

    return stickers


async def load_inspection_image(
    page: Page,
    sticker: Sticker,
    timeout_ms: int,
    rate_limiter: SiteRateLimiter,
    challenge_cooldown: float,
) -> Sticker:
    for attempt in range(1, 4):
        try:
            await rate_limiter.wait()
            await page.goto(sticker.detail_url, wait_until="domcontentloaded", timeout=timeout_ms)
            if await wait_for_access(page):
                rate_limiter.defer(challenge_cooldown)
                print(
                    f"Security check solved; pausing site navigation for "
                    f"{challenge_cooldown:.0f} seconds."
                )
            inspection = page.locator(
                'img[src*="/uih/inspections/"], img[data-src*="/uih/inspections/"]'
            ).first
            await inspection.wait_for(state="attached", timeout=timeout_ms)
            image_url = await inspection.evaluate(
                "image => image.currentSrc || image.getAttribute('data-src') || image.src"
            )
            if image_url:
                return replace(
                    sticker,
                    image_url=str(image_url),
                    preview_url=sticker.image_url,
                )
        except PlaywrightTimeoutError:
            if attempt == 3:
                break
            print(f"Inspection timed out for {sticker.name}; retrying ({attempt}/3)...")

    raise RuntimeError(
        f"No HD inspection image found for {sticker.name}: {sticker.detail_url}"
    )


def load_manifest(manifest: Path) -> dict[str, dict[str, Any]]:
    if not manifest.exists():
        return {}
    try:
        records = json.loads(manifest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return {
        str(record["detail_url"]): record
        for record in records
        if isinstance(record, dict) and record.get("detail_url")
    }


def write_manifest(manifest: Path, records: dict[str, dict[str, Any]]) -> None:
    ordered = sorted(records.values(), key=lambda record: str(record.get("name", "")).casefold())
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(ordered, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(manifest)


def record_files_exist(output_dir: Path, record: dict[str, Any]) -> bool:
    file = record.get("file")
    original_file = record.get("original_file")
    return bool(
        file
        and original_file
        and (output_dir / str(file)).is_file()
        and (output_dir / str(original_file)).is_file()
        and has_transparent_pixels(output_dir / str(file))
    )


def configure_cloudinary() -> None:
    configuration = cloudinary.config()
    cloud_name = (configuration.cloud_name or "").strip().strip("<>")
    api_key = (configuration.api_key or "").strip().strip("<>")
    api_secret = (configuration.api_secret or "").strip().strip("<>")
    if not cloud_name or not api_key or not api_secret:
        raise RuntimeError(
            "Cloudinary credentials are missing. Set CLOUDINARY_URL in the terminal "
            "or local .env before using a Cloudinary upload option."
        )
    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )


def upload_transparent_image(
    path: Path, folder: str, public_id: str
) -> dict[str, Any]:
    upload_path = path
    temporary_path: Path | None = None
    if path.stat().st_size > CLOUDINARY_MAX_UPLOAD_BYTES:
        temporary_path = path.with_suffix(".cloudinary-upload.webp")
        with Image.open(path) as image:
            image.save(
                temporary_path,
                "WEBP",
                lossless=True,
                quality=100,
                method=6,
                exact=True,
            )
        upload_path = temporary_path

    try:
        result = cloudinary.uploader.upload(
            str(upload_path),
            folder=folder.strip("/"),
            public_id=public_id,
            resource_type="image",
            overwrite=True,
            invalidate=False,
        )
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return {
        "cloudinary_public_id": result["public_id"],
        "cloudinary_secure_url": result["secure_url"],
        "cloudinary_version": result.get("version"),
        "cloudinary_width": result.get("width"),
        "cloudinary_height": result.get("height"),
        "cloudinary_bytes": result.get("bytes"),
        "cloudinary_format": result.get("format"),
        "cloudinary_lossless_fallback": upload_path != path,
    }


async def upload_existing_records(output_dir: Path, folder: str) -> None:
    manifest = output_dir / "stickers.json"
    records = load_manifest(manifest)
    if not records:
        raise RuntimeError(f"No sticker records found in {manifest}")

    uploaded = 0
    skipped = 0
    failed = 0
    for detail_url, record in records.items():
        if record.get("cloudinary_secure_url"):
            skipped += 1
            continue
        file = record.get("file")
        if not file or not (output_dir / str(file)).is_file():
            record["cloudinary_upload_error"] = "Transparent local file is missing"
            failed += 1
            write_manifest(manifest, records)
            continue

        public_id = urlparse(detail_url).path.rstrip("/").split("/")[-1]
        print(f"Uploading {record.get('name', public_id)} to Cloudinary...")
        try:
            cloudinary_data = await asyncio.to_thread(
                upload_transparent_image,
                output_dir / str(file),
                folder,
                public_id,
            )
        except Exception as error:
            record["cloudinary_upload_error"] = str(error)
            failed += 1
            print(f"Cloudinary upload failed: {error}")
        else:
            record.update(cloudinary_data)
            record.pop("cloudinary_upload_error", None)
            record["cloudinary_folder"] = folder.strip("/")
            uploaded += 1
            print(f"Uploaded: {cloudinary_data['cloudinary_secure_url']}")
        write_manifest(manifest, records)

    print(f"Cloudinary upload complete: {uploaded} uploaded, {skipped} skipped, {failed} failed.")


async def process_sticker(
    context: BrowserContext,
    sticker: Sticker,
    output_dir: Path,
    image_size: int,
    delay: float,
    base_name: str,
) -> dict[str, Any]:
    download_urls: list[str] = []
    if image_size > 0:
        download_urls.append(resized_image_url(sticker.image_url, image_size))
    original_url = original_image_url(sticker.image_url)
    if original_url:
        download_urls.append(original_url)
    download_urls.append(sticker.image_url)
    download_urls = list(dict.fromkeys(download_urls))

    response = None
    image_url = sticker.image_url
    for candidate_url in download_urls:
        for attempt in range(1, 3):
            response = await context.request.get(candidate_url, timeout=60_000)
            if response.ok:
                image_url = candidate_url
                break
            if attempt < 2:
                await asyncio.sleep(attempt)
        if response.ok:
            break
    if response is None or not response.ok:
        status = response.status if response else "no response"
        return {**asdict(sticker), "file": None, "status": status}

    extension = image_extension(response.headers.get("content-type", ""), image_url)
    original_destination = output_dir / "originals" / f"{base_name}{extension}"
    if original_destination.exists() and original_destination.stat().st_size > 0:
        download_status = "existing original"
    else:
        original_destination.write_bytes(await response.body())
        download_status = "downloaded original"
    print(f"Downloaded HD original: {original_destination.name}")

    destination = output_dir / "images" / f"{base_name}.png"
    await asyncio.to_thread(remove_image_background, original_destination, destination)
    print(f"Background removed: {destination.name}")
    await asyncio.sleep(delay)
    return {
        **asdict(sticker),
        "download_url": image_url,
        "original_file": original_destination.relative_to(output_dir).as_posix(),
        "file": destination.relative_to(output_dir).as_posix(),
        "status": "background removed",
        "download_status": download_status,
        "background_removed": True,
        "background_removal_method": "edge-connected-color-v1",
    }


async def sticker_processor(
    queue: asyncio.Queue[Sticker | None],
    context: BrowserContext,
    output_dir: Path,
    image_size: int,
    delay: float,
    upload_cloudinary: bool,
    cloudinary_folder: str,
) -> list[dict[str, Any]]:
    (output_dir / "images").mkdir(parents=True, exist_ok=True)
    (output_dir / "originals").mkdir(parents=True, exist_ok=True)
    manifest = output_dir / "stickers.json"
    records = load_manifest(manifest)
    used_names = {
        Path(str(record["file"])).stem.casefold()
        for record in records.values()
        if record.get("file")
    }
    processed = 0

    while True:
        sticker = await queue.get()
        try:
            if sticker is None:
                break
            existing = records.get(sticker.detail_url)
            if existing and record_files_exist(output_dir, existing):
                if upload_cloudinary and not existing.get("cloudinary_secure_url"):
                    transparent_path = output_dir / str(existing["file"])
                    public_id = urlparse(sticker.detail_url).path.rstrip("/").split("/")[-1]
                    print(f"Uploading existing transparent PNG: {sticker.name}")
                    try:
                        cloudinary_data = await asyncio.to_thread(
                            upload_transparent_image,
                            transparent_path,
                            cloudinary_folder,
                            public_id,
                        )
                    except Exception as error:
                        existing["cloudinary_upload_error"] = str(error)
                        print(f"Cloudinary upload failed for {sticker.name}: {error}")
                    else:
                        existing.update(cloudinary_data)
                        existing.pop("cloudinary_upload_error", None)
                        existing["cloudinary_folder"] = cloudinary_folder.strip("/")
                        print(f"Uploaded to Cloudinary: {cloudinary_data['cloudinary_secure_url']}")
                    write_manifest(manifest, records)
                    continue
                print(f"Already processed: {sticker.name}")
                continue

            base_name = safe_filename(sticker.name)
            candidate = base_name
            duplicate = 2
            while candidate.casefold() in used_names:
                candidate = f"{base_name} ({duplicate})"
                duplicate += 1
            used_names.add(candidate.casefold())

            try:
                record = await process_sticker(
                    context, sticker, output_dir, image_size, delay, candidate
                )
                if upload_cloudinary and record.get("file"):
                    transparent_path = output_dir / str(record["file"])
                    public_id = urlparse(sticker.detail_url).path.rstrip("/").split("/")[-1]
                    print(f"Uploading transparent PNG: {sticker.name}")
                    try:
                        cloudinary_data = await asyncio.to_thread(
                            upload_transparent_image,
                            transparent_path,
                            cloudinary_folder,
                            public_id,
                        )
                    except Exception as error:
                        record["cloudinary_upload_error"] = str(error)
                        print(f"Cloudinary upload failed for {sticker.name}: {error}")
                    else:
                        record.update(cloudinary_data)
                        record["cloudinary_folder"] = cloudinary_folder.strip("/")
                        print(f"Uploaded to Cloudinary: {cloudinary_data['cloudinary_secure_url']}")
            except Exception as error:
                print(f"Processing failed for {sticker.name}: {error}")
                record = {**asdict(sticker), "file": None, "status": str(error)}
            records[sticker.detail_url] = record
            processed += 1
            write_manifest(manifest, records)
            print(f"Pipeline completed {processed}; manifest contains {len(records)} records.")
        finally:
            queue.task_done()

    write_manifest(manifest, records)
    return sorted(records.values(), key=lambda record: str(record.get("name", "")).casefold())


async def scrape(args: argparse.Namespace) -> None:
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = output_dir / ".browser-profile"

    if args.upload_cloudinary or args.upload_existing:
        configure_cloudinary()
        print(f"Cloudinary uploads enabled for folder: {args.cloudinary_folder.strip('/')}")
    if args.upload_existing:
        await upload_existing_records(output_dir, args.cloudinary_folder)
        return

    async with async_playwright() as playwright:
        attached_browser = None
        if args.cdp_url:
            attached_browser = await playwright.chromium.connect_over_cdp(args.cdp_url)
            if not attached_browser.contexts:
                raise RuntimeError("Chrome exposed no browser context over CDP.")
            context = attached_browser.contexts[0]
            page = next(
                (candidate for candidate in context.pages if "csgoskins.gg" in candidate.url),
                context.pages[0] if context.pages else await context.new_page(),
            )
            print(f"Attached to verified Chrome at {args.cdp_url}")
        else:
            context = await playwright.chromium.launch_persistent_context(
                profile_dir,
                headless=args.headless,
                viewport={"width": 1440, "height": 1000},
            )
            page = context.pages[0] if context.pages else await context.new_page()
        detail_page = await context.new_page()
        rate_limiter = SiteRateLimiter(args.requests_per_minute, args.request_jitter)
        print(
            f"Site navigation limit: {args.requests_per_minute:g} requests/minute "
            f"with up to {args.request_jitter:g}s jitter."
        )
        queue: asyncio.Queue[Sticker | None] = asyncio.Queue(maxsize=args.pipeline_buffer)
        processor_task = asyncio.create_task(
            sticker_processor(
                queue,
                context,
                output_dir,
                args.image_size,
                args.download_delay,
                args.upload_cloudinary,
                args.cloudinary_folder,
            )
        )
        seen_stickers: set[tuple[str, str]] = set()

        try:
            for page_number in range(args.start_page, args.end_page + 1):
                print(f"Scraping page {page_number}/{args.end_page}...")
                await load_page(
                    page,
                    page_number,
                    args.timeout * 1_000,
                    rate_limiter,
                    args.challenge_cooldown,
                )
                stickers = await extract_stickers(page)
                if not stickers:
                    await page.screenshot(
                        path=output_dir / f"debug-page-{page_number}.png", full_page=True
                    )
                    (output_dir / f"debug-page-{page_number}.html").write_text(
                        await page.content(), encoding="utf-8"
                    )
                    raise RuntimeError(
                        f"No sticker cards found on page {page_number}. "
                        "Debug HTML and screenshot saved."
                    )
                for sticker_index, sticker in enumerate(stickers, 1):
                    print(f"Loading HD inspection {sticker_index}/{len(stickers)}: {sticker.name}")
                    inspected_sticker = await load_inspection_image(
                        detail_page,
                        sticker,
                        args.timeout * 1_000,
                        rate_limiter,
                        args.challenge_cooldown,
                    )
                    key = (inspected_sticker.name.casefold(), inspected_sticker.image_url)
                    if key not in seen_stickers:
                        seen_stickers.add(key)
                        await queue.put(inspected_sticker)
                        print(f"Queued HD inspection: {inspected_sticker.name}")
                    await asyncio.sleep(args.detail_delay)
                print(
                    f"Queued {len(stickers)} inspections from page {page_number} "
                    f"({len(seen_stickers)} unique total)."
                )
                await asyncio.sleep(args.page_delay)
        finally:
            await detail_page.close()
            await queue.put(None)
            await queue.join()

        records = await processor_task
        print(f"Pipeline finished with {len(records)} records in {output_dir / 'stickers.json'}")
        if attached_browser is None:
            await context.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download and alphabetically name sticker images from CSGOSKINS.GG."
    )
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int, default=233)
    parser.add_argument("--output", default="output")
    parser.add_argument(
        "--image-size",
        type=int,
        default=0,
        help="Requested CDN size; 0 downloads the embedded full-resolution original",
    )
    parser.add_argument("--download-delay", type=float, default=0.15)
    parser.add_argument(
        "--pipeline-buffer",
        type=int,
        default=8,
        help="Maximum inspections waiting for download/background removal",
    )
    parser.add_argument(
        "--upload-cloudinary",
        action="store_true",
        help="Upload each transparent PNG to Cloudinary as it is processed",
    )
    parser.add_argument(
        "--upload-existing",
        action="store_true",
        help="Upload existing transparent files from the manifest, then exit",
    )
    parser.add_argument(
        "--cloudinary-folder",
        default="gostick.gg/stickers",
        help="Cloudinary Media Library folder for transparent stickers",
    )
    parser.add_argument("--detail-delay", type=float, default=0.0)
    parser.add_argument("--page-delay", type=float, default=1.0)
    parser.add_argument(
        "--requests-per-minute",
        type=float,
        default=10.0,
        help="Maximum CSGOSKINS page navigations per minute",
    )
    parser.add_argument(
        "--request-jitter",
        type=float,
        default=1.5,
        help="Random seconds added between site navigations",
    )
    parser.add_argument(
        "--challenge-cooldown",
        type=float,
        default=120.0,
        help="Seconds to pause site navigation after completing a security check",
    )
    parser.add_argument("--timeout", type=int, default=60, help="Page timeout in seconds")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument(
        "--cdp-url",
        help="Attach to an already open, user-verified Chrome (for example http://127.0.0.1:9222)",
    )
    args = parser.parse_args()
    if args.start_page < 1 or args.end_page < args.start_page:
        parser.error("page range must satisfy 1 <= start-page <= end-page")
    if args.image_size < 0:
        parser.error("image-size cannot be negative")
    if args.requests_per_minute <= 0:
        parser.error("requests-per-minute must be positive")
    if args.pipeline_buffer < 1:
        parser.error("pipeline-buffer must be positive")
    if args.request_jitter < 0 or args.challenge_cooldown < 0:
        parser.error("request-jitter and challenge-cooldown cannot be negative")
    return args


if __name__ == "__main__":
    asyncio.run(scrape(parse_args()))