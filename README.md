# CSGOSKINS.GG Sticker Scraper

Finds stickers in the CSGOSKINS.GG sticker category, visits each sticker's detail page,
downloads its HD inspection screenshot, and removes the blue background locally. A JSON
manifest keeps the inspection URL, category preview URL, detail URL, source page,
original filename, transparent filename, and processing status.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Run

Cloudflare may reject browsers launched directly by automation. Use the included script
to open ordinary installed Chrome with a separate persistent profile:

```powershell
.\open_verified_chrome.ps1
```

In that Chrome window, complete the security check and wait until the sticker grid is
visible. Leave Chrome open. In a second terminal, start with one page:

```powershell
python scrape_stickers.py --start-page 233 --end-page 233 --output output --cdp-url http://127.0.0.1:9222
```

Then download the full page range:

```powershell
python scrape_stickers.py --start-page 1 --end-page 233 --output output --cdp-url http://127.0.0.1:9222
```

Site navigation is limited to 10 requests per minute by default, with up to 1.5 seconds
of random jitter between requests. This limiter applies to both category pages and every
sticker detail page. If a Cloudflare check still appears, the scraper waits 120 seconds
after you complete it before making another site request.

For a stricter 6-request-per-minute run:

```powershell
python scrape_stickers.py --start-page 1 --end-page 233 --output output --cdp-url http://127.0.0.1:9222 --requests-per-minute 6 --request-jitter 2 --challenge-cooldown 180
```

Higher request rates increase the chance of repeated security checks. A full scrape is
intentionally slow because each sticker requires its own detail-page navigation.

## Processing pipeline

Each HD inspection is queued as soon as its detail page loads. A processor coroutine
downloads the original immediately, runs background removal in a worker thread while
the browser continues scraping, and atomically updates `output/stickers.json` after
every completed sticker. Completed files and manifest entries therefore survive an
interrupted long run instead of waiting until all 233 pages finish.

The queue holds up to eight pending inspections by default. This bounds memory and
automatically slows page traversal if downloading or image processing falls behind.
Change it with `--pipeline-buffer`, for example `--pipeline-buffer 4`.

## Cloudinary uploads

Cloudinary credentials stay local and are loaded from `CLOUDINARY_URL`. In the
Cloudinary Console, open **Settings > API Keys**, copy the API environment variable,
then create a local `.env` from the ignored example file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` directly and replace the placeholder with the real value. Never commit or
paste the API secret into chat. The `.env` file is excluded by `.gitignore`.

Upload transparent PNGs already listed in `output/stickers.json` without scraping again:

```powershell
python scrape_stickers.py --output output --upload-existing --cloudinary-folder gostick.gg/stickers
```

To upload each new transparent PNG from the streaming scraper as soon as background
removal completes, add `--upload-cloudinary`:

```powershell
python scrape_stickers.py --start-page 1 --end-page 233 --output output --cdp-url http://127.0.0.1:9222 --requests-per-minute 6 --request-jitter 2 --challenge-cooldown 180 --upload-cloudinary --cloudinary-folder gostick.gg/stickers
```

Uploads use stable item slugs as Cloudinary public IDs, such as `sticker-mountain`, and
overwrite the same asset on retries rather than creating duplicates. The secure delivery
URL, Cloudinary public ID, dimensions, format, and byte size are saved to the manifest
after each upload. Existing manifest records with delivery URLs are skipped on resume.

The Chrome profile is retained under `.chrome-scraper-profile`, so later runs can reuse
its cookies. Always complete any security check yourself before attaching the scraper.
The scraper does not click or bypass Cloudflare. Close the old automated Chromium window;
it uses a different profile and will remain in the verification loop.

Transparent PNGs are written to `output/images` and naturally sort by sticker name.
Untouched HD inspection images are preserved under `output/originals`. Background
removal uses the inspection's uniform border color and removes only matching pixels
connected to the canvas edge. This preserves enclosed artwork that semantic AI models
can mistake for the foreground subject, such as the full Shooter Close sticker.
Duplicate names receive `(2)`, `(3)`, and so on. No images or API keys are sent to an
external background-removal service.

By default, the scraper decodes and downloads the embedded full-resolution inspection
PNG. For example, Mountain remains 3042×1318 after background removal. Set `--image-size`
to try a specific CDN transform size; the original inspection and signed inspection
image remain fallbacks.

If no sticker cards are detected, the scraper saves `debug-page-N.html` and
`debug-page-N.png` under the output directory. Those files make selector changes
diagnosable without silently downloading unrelated page graphics.

Use conservative delays and follow the site's terms, robots policy, and rate limits.
Reduce `--requests-per-minute` if the site begins throttling. `--page-delay`,
`--detail-delay`, and `--download-delay` provide additional fixed delays when needed.

## Test

```powershell
python -m unittest -v
```