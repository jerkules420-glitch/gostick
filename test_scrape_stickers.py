import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image

from scrape_stickers import (
    CLOUDINARY_MAX_UPLOAD_BYTES,
    SiteRateLimiter,
    has_transparent_pixels,
    image_extension,
    original_image_url,
    remove_image_background,
    resized_image_url,
    safe_filename,
    upload_transparent_image,
    wait_for_access,
)


class ScraperHelpersTest(unittest.TestCase):
    def test_rate_limiter_converts_requests_per_minute_to_interval(self) -> None:
        limiter = SiteRateLimiter(requests_per_minute=10, jitter=1.5)
        self.assertEqual(limiter.interval, 6.0)
        self.assertEqual(limiter.jitter, 1.5)

    def test_safe_filename_removes_windows_reserved_characters(self) -> None:
        self.assertEqual(safe_filename('Sticker: Team / "Gold"?'), "Sticker_ Team _ _Gold__")

    def test_resized_image_url_replaces_cdn_size(self) -> None:
        source = "https://cdn.csgoskins.gg/public/uih/items/value/auto/auto/85/notrim/hash.webp"
        expected = "https://cdn.csgoskins.gg/public/uih/items/value/auto/auto/512/notrim/hash.webp"
        self.assertEqual(resized_image_url(source, 512), expected)

    def test_original_image_url_decodes_full_resolution_asset(self) -> None:
        source = (
            "https://cdn.csgoskins.gg/public/uih/items/"
            "aHR0cHM6Ly9jZG4uY3Nnb3NraW5zLmdnL3B1YmxpYy9pbWFnZXMvc3RpY2tlci5wbmc-/"
            "auto/auto/85/notrim/hash.webp"
        )
        expected = "https://cdn.csgoskins.gg/public/images/sticker.png"
        self.assertEqual(original_image_url(source), expected)

    def test_original_image_url_decodes_inspection_asset(self) -> None:
        source = (
            "https://cdn.csgoskins.gg/public/uih/inspections/"
            "aHR0cHM6Ly9jZG4uY3Nnb3NraW5zLmdnL3B1YmxpYy9pbWFnZXMvaW5zcGVjdGlvbnMvdjIvc3RpY2tlci1tb3VudGFpbi5wbmc-/"
            "auto/auto/85/notrim/hash.webp"
        )
        expected = (
            "https://cdn.csgoskins.gg/public/images/inspections/v2/sticker-mountain.png"
        )
        self.assertEqual(original_image_url(source), expected)

    def test_image_extension_prefers_content_type(self) -> None:
        self.assertEqual(image_extension("image/png; charset=binary", "image.webp"), ".png")

    def test_has_transparent_pixels_distinguishes_opaque_rgba(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "test.png"
            image = Image.new("RGBA", (2, 2), (255, 255, 255, 255))
            image.save(path)
            self.assertFalse(has_transparent_pixels(path))
            image.putpixel((0, 0), (255, 255, 255, 0))
            image.save(path)
            self.assertTrue(has_transparent_pixels(path))

    def test_background_removal_preserves_enclosed_matching_color(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source = Path(temporary_directory) / "source.png"
            destination = Path(temporary_directory) / "result.png"
            background = (31, 41, 55, 255)
            image = Image.new("RGBA", (7, 7), background)
            for x in range(1, 6):
                for y in range(1, 6):
                    image.putpixel((x, y), (240, 240, 240, 255))
            image.putpixel((3, 3), background)
            image.save(source)

            remove_image_background(source, destination)

            result = Image.open(destination)
            self.assertEqual(result.getpixel((0, 0))[3], 0)
            self.assertEqual(result.getpixel((3, 3))[3], 255)

    @patch("scrape_stickers.cloudinary.uploader.upload")
    def test_cloudinary_upload_targets_sticker_folder(self, upload: AsyncMock) -> None:
        upload.return_value = {
            "public_id": "gostick.gg/stickers/sticker-mountain",
            "secure_url": "https://res.cloudinary.com/demo/image/upload/sticker-mountain.png",
            "version": 1,
            "width": 3042,
            "height": 1318,
            "bytes": 1234,
            "format": "png",
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            source = Path(temporary_directory) / "Mountain.png"
            Image.new("RGBA", (2, 2), (255, 255, 255, 0)).save(source)
            result = upload_transparent_image(
                source,
                "gostick.gg/stickers",
                "sticker-mountain",
            )

            upload.assert_called_once_with(
                str(source),
                folder="gostick.gg/stickers",
                public_id="sticker-mountain",
                resource_type="image",
                overwrite=True,
                invalidate=False,
            )
        self.assertEqual(result["cloudinary_width"], 3042)
        self.assertIn("sticker-mountain.png", result["cloudinary_secure_url"])

    @patch("scrape_stickers.cloudinary.uploader.upload")
    def test_cloudinary_upload_uses_lossless_webp_above_limit(self, upload: AsyncMock) -> None:
        upload.return_value = {
            "public_id": "gostick.gg/stickers/large",
            "secure_url": "https://res.cloudinary.com/demo/image/upload/large.webp",
            "format": "webp",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            source = Path(temporary_directory) / "large.png"
            Image.new("RGBA", (2, 2), (255, 0, 0, 0)).save(source)
            with patch.object(Path, "stat") as stat:
                stat.return_value.st_size = CLOUDINARY_MAX_UPLOAD_BYTES + 1
                result = upload_transparent_image(source, "stickers", "large")

            uploaded_path = Path(upload.call_args.args[0])
            self.assertEqual(uploaded_path.suffix, ".webp")
            self.assertFalse(uploaded_path.exists())
            self.assertTrue(result["cloudinary_lossless_fallback"])


class RateLimiterTest(unittest.IsolatedAsyncioTestCase):
    async def test_second_request_waits_for_interval_and_jitter(self) -> None:
        limiter = SiteRateLimiter(requests_per_minute=10, jitter=1.5)
        with (
            patch("scrape_stickers.time.monotonic", side_effect=[100.0, 100.0, 101.0, 106.5]),
            patch("scrape_stickers.random.uniform", return_value=0.5),
            patch("scrape_stickers.asyncio.sleep", new_callable=AsyncMock) as sleep,
        ):
            await limiter.wait()
            await limiter.wait()

        sleep.assert_awaited_once_with(5.5)


class BrowserChallengeTest(unittest.IsolatedAsyncioTestCase):
    async def test_wait_for_access_fails_fast_without_tty(self) -> None:
        page = AsyncMock()
        page.title.return_value = "Just a moment"
        page.locator.return_value.inner_text.return_value = "Verify you are human"

        with (
            patch("scrape_stickers.is_security_challenge", new_callable=AsyncMock, return_value=True),
            patch("scrape_stickers.sys.stdin.isatty", return_value=False),
            patch("scrape_stickers.asyncio.to_thread") as to_thread,
        ):
            with self.assertRaisesRegex(RuntimeError, "requires a visible browser session"):
                await wait_for_access(page)

        to_thread.assert_not_called()


if __name__ == "__main__":
    unittest.main()