# Tims Foods

A small shop front with a SQLite-backed Node server. Products, accounts and orders are stored in a real database; payment is pay-on-delivery (nothing is charged online).

## Run

Requires **Node.js 26+** (`node:sqlite` is built in — no npm install needed for the server).

```bash
npm start           # http://127.0.0.1:5173/
npm test            # API integration tests
```

Override the port or database location with environment variables:

```bash
PORT=5273 npm start                       # macOS/Linux
$env:PORT=5273; npm start                 # PowerShell
$env:DB_PATH="C:\temp\shop.db"; npm start # use another database file
```

The database lives at `data/timsfood.db` (gitignored). On first start the 20 products in `js/catalog.js` are imported into the `products` table, and their images are copied from `assets/` into the `images` table as BLOBs. After that, the database is the source of truth — edit products there, not in the JS file. `js/catalog.js` remains as an offline fallback if the API is unreachable.

Product image files are deduplicated by SHA-256, so reused jar photos share one database row. Existing databases are migrated automatically on startup. Decorative site images (logo, hero, category tiles) are still plain files in `assets/`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/products` | List products (`?variety=`, `?q=` filters) |
| `GET` | `/api/products/:id` | Single product |
| `GET` | `/api/images/:id` | Product image bytes (PNG/JPEG/WebP) |
| `POST` | `/api/auth/register` | Create account, starts a session |
| `POST` | `/api/auth/login` | Sign in, starts a session |
| `POST` | `/api/auth/logout` | End session |
| `GET` | `/api/me` | Current user, or `null` |
| `POST` | `/api/orders` | Place an order (guest or signed in) |
| `GET` | `/api/orders` | Signed-in user's order history |
| `GET` | `/api/orders/:ref` | One of that user's orders |

Requests and responses are JSON. Sessions use an HttpOnly, SameSite cookie; passwords are hashed with scrypt. Order line prices are recomputed from the database, so client-supplied prices are ignored.

## Database

- `products` — catalog, seeded once from `js/catalog.js`
- `images` — product image BLOBs with SHA-256 checksums and MIME types
- `users`, `sessions` — accounts and 30-day login sessions
- `orders`, `order_items` — saved orders with a price/name snapshot per line

Static files are served from the project root; `data/`, `db/`, `node_modules/` and dotfiles are never served.

## Pages

`index.html`, `shop.html`, `product.html`, `checkout.html`, `about.html`, `login.html`, `account.html`.
