# GoStick Store Server

Express serves both the static GoStick storefront and its API from one process.

## Catalog propagation

`GET /api/products` lists every image under the Cloudinary folder configured by
`CLOUDINARY_STICKER_FOLDER` (`gostick.gg/stickers` by default). The endpoint follows
Cloudinary pagination, maps assets into storefront products, and caches the result for
60 seconds. New scraper uploads therefore appear automatically without editing frontend
files or maintaining a product database.

Successful catalog responses are also written atomically to
`data/cloudinary-catalog.json`. If Cloudinary DNS or its Admin API is temporarily
unavailable, storefront browsing and checkout continue from this last-known-good snapshot;
the next scheduled synchronization retries Cloudinary without terminating the server.

Product price defaults to `$8.99` and can be changed with `STICKER_PRICE`.

## Printify product propagation

At startup and every minute, the server compares the Cloudinary catalog with
`data/printify-products.json`. Missing products are created sequentially in Printify:

1. Deliver the transparent Cloudinary artwork as a Printify-compatible PNG.
2. Upload it to the Printify media library.
3. Create a **3×3 inch transparent outdoor die-cut sticker** product.
4. Enable its fulfillment variant at the storefront price.
5. Wire the Printify product back to its GoStick item URL.
6. Persist the Printify product and variant IDs atomically.

The verified defaults are blueprint `803` (Transparent Outdoor Stickers, Die-Cut),
provider `73` (Printed Simply), and variant `75060` (Transparent / Die-Cut / 3×3).
Change these with the corresponding `PRINTIFY_STICKER_*` environment variables.
`PRINTIFY_AUTO_SYNC=false` disables scheduled creation, and
`PRINTIFY_SYNC_BATCH_SIZE` limits each run.

Clear areas reveal the application surface and do not produce the white vinyl border from
the prior blueprint. Printify notes that lighter colors can be less visible when applied
to dark surfaces.

For this provider, the verified production cost is `$4.27`; standard US shipping is
`$5.09` for the first item and `$0.07` for each additional item. The active storefront
model charges `$8.99` per sticker, applies 10% off at 3+ and 15% off at 5+, and charges:

- US: `$5.99`, free over `$40`
- Canada: `$10.99`, free over `$70`
- UK / Australia: `$12.99`, free over `$80`

Free-shipping thresholds use the pre-discount subtotal. Stripe restricts the checkout
address countries to the selected shipping zone and charges the canonical server-calculated
rate. Keep `STICKER_PRICE` (storefront dollars) aligned with
`PRINTIFY_STICKER_PRICE_CENTS` (Printify cents) whenever changing retail price.

The storefront shows **Preparing...** until a product has a fulfillment mapping. Checkout
resolves name, price, image, Printify product ID, and variant ID on the server by product
slug. After Stripe payment, the existing webhook creates the Printify order and sends it
to production.

Admin routes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/printify/sync` | Mapping and failure status |
| `POST` | `/api/admin/printify/sync` | Start an idempotent sync; optional `{ "limit": 10 }` |

## Start

From this directory:

```powershell
npm install
npm start
```

Open <http://localhost:5000>. The server loads `CLOUDINARY_URL` from the repository root
`.env`, then applies values from `server/.env` when present.

## Relevant environment variables

| Variable | Default |
|---|---|
| `CLOUDINARY_URL` | Required Cloudinary API environment URL |
| `CLOUDINARY_STICKER_FOLDER` | `gostick.gg/stickers` |
| `CLOUDINARY_CATALOG_CACHE_MS` | `60000` |
| `STICKER_PRICE` | `8.99` |
| `PORT` | `5000` |

Authentication, Stripe checkout, Printify fulfillment, Prisma, and email retain their
existing environment settings in `.env.example`.

## Catalog routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/products` | All current Cloudinary sticker products |
| `GET` | `/api/products/:handle` | One sticker by Cloudinary public-ID slug |
| `GET` | `/api/health` | Server health |
