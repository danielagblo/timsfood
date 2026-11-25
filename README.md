# Tims Foods

A shop front with a **MySQL-backed API** and an admin portal. Products, accounts, orders and product images live in MySQL; checkout supports pay-on-delivery and Paystack online payments.

```
timsfood/
  backend/   Node API + MySQL (server.js, db/, test/, catalog.js)
  client/    Static site (HTML, CSS, JS, assets)
```

The two folders are independent and can be deployed separately, or the backend can serve the client locally for development.

## Run locally

```bash
cd backend
npm install
cp .env.example .env      # fill in your MySQL credentials
npm start                 # http://127.0.0.1:5173/
npm test
```

`npm start` serves both the API and the files in `../client`, so the whole site works on one port during development. Point `CLIENT_DIR` at another folder if needed.

The database named by `DB_NAME` is created automatically. On first start the products in `backend/catalog.js` are imported and their images are copied from `client/assets/` into MySQL as BLOBs. After that the database is the source of truth. Image files are deduplicated by SHA-256, so reused jar photos share one row.

## Environment variables (backend/.env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | local root / `timsfood` | MySQL connection |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | none | Bootstrap admin account, created on first start |
| `PORT`, `HOST` | `5173`, `127.0.0.1` | Server bind address |
| `CLIENT_DIR` | `../client` | Static files served in development |
| `CLIENT_ORIGIN` | none | Exact browser origin allowed by CORS (e.g. Vercel URL) |
| `COOKIE_SAME_SITE` | `Lax` | Set to `None` for cross-site hosting (adds `Secure`) |
| `CATALOG_PATH`, `ASSETS_DIR` | local copies | Override seed sources when deploying the backend alone |
| `PAYSTACK_SECRET_KEY` | none | Server key used to initialize and verify payments |
| `PAYSTACK_PUBLIC_KEY` | none | Browser key, kept for reference (hosted checkout uses the secret key) |
| `PAYSTACK_CALLBACK_BASE` | request origin | Public client origin used to build the Paystack callback URL |
| `PAYSTACK_CURRENCY` | `GHS` | Currency sent to Paystack (amounts are converted to pesewas) |
| `PAYSTACK_WEBHOOK_SECRET` | none | Signing secret from the Paystack dashboard, required for webhooks |
| `PAYSTACK_API_BASE` | `https://api.paystack.co` | Override only for local testing against a mock API |

Credentials are never committed — `.env` is gitignored.

## Payments

Checkout offers **Pay on delivery** (unchanged) and **Pay with Paystack**. With Paystack:

1. The order is saved in MySQL first with `payment_status = 'awaiting_payment'`.
2. The browser is redirected to Paystack's hosted checkout using a fresh transaction reference.
3. Paystack redirects back to `payment.html`, which calls `/api/payments/verify`. On success the order becomes `payment_status = 'paid'` and the cart is cleared.
4. Optionally, a signed `charge.success` webhook marks the order paid even if the customer closes the tab.

Add your keys to `backend/.env` (see `.env.example`). For production set `PAYSTACK_CALLBACK_BASE` to the public client URL, e.g. `https://your-client.vercel.app`. In the Paystack dashboard set the webhook URL to `https://your-backend.example.com/api/payments/webhook` and use its signing secret as `PAYSTACK_WEBHOOK_SECRET`. Without keys, delivery orders still work and the Paystack option returns a clear configuration error.

## Deploying separately (recommended)

**Client → Vercel**

- Import the repo, set **Root Directory** to `client`
- Framework Preset: **Other**, Build Command: empty, Output Directory: `.`
- Edit `client/js/config.js` and set the API base to your backend origin:

```js
window.TF_API_BASE = "https://your-backend.example.com";
```

Leave it empty for same-origin hosting. All API calls and product image URLs use this base automatically.

**Backend → Railway / Render / Fly.io**

- Root Directory `backend`, start command `npm start`
- Set all the backend env vars above, including `CLIENT_ORIGIN=https://your-client.vercel.app` and `COOKIE_SAME_SITE=None`
- Use a hosted MySQL (PlanetScale, Aiven, Railway MySQL) — Vercel cannot reach a database on your PC

`backend/server.js` exports `handler(req, res)` and `init()` without calling `listen()` when imported, so the same code can also be wrapped in a serverless function if you prefer a single Vercel project.

**Before deploying:** pre-seed the hosted database once from your machine so cold starts don't try to import 24MB of images:

```powershell
cd backend
$env:DB_HOST="your-host"; $env:DB_USER="..."; $env:DB_PASSWORD="..."; $env:DB_NAME="timsfood"; npm start
```

Then stop it and deploy.

## Admin portal

Open `admin.html` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The **Admin** nav link only appears for admin users.

- **Overview** — product/order/customer counts, sales total, recent orders
- **Products** — add, edit, hide and delete products; each row shows its attached images and the edit dialog can add/remove them
- **Orders** — every order with a status dropdown
- **Customers** — accounts and their order counts

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/products` | List products (`?variety=`, `?q=` filters) |
| `GET` | `/api/products/:id` | Single product |
| `GET` | `/api/images/:id` | Product image bytes |
| `POST` | `/api/auth/register` / `/login` / `/logout` | Accounts and sessions |
| `GET` | `/api/me` | Current user, or `null` |
| `POST` | `/api/orders` | Place an order (guest or signed in) |
| `GET` | `/api/orders` | Signed-in order history |
| `POST` | `/api/payments/initialize` | Start a Paystack checkout for a saved order |
| `GET` | `/api/payments/verify?reference=` | Verify a returned payment and mark the order paid |
| `POST` | `/api/payments/webhook` | Signed Paystack `charge.success` webhook |
| `GET` | `/api/admin/summary` | Admin dashboard totals |
| `GET` / `POST` | `/api/admin/products` | Admin product list / create |
| `PUT` / `DELETE` | `/api/admin/products/:id` | Edit / remove a product |
| `POST` | `/api/admin/products/:id/image` | Attach an image to a product |
| `DELETE` | `/api/admin/products/:id/images/:imageId` | Detach an image |
| `GET` | `/api/admin/orders` | All orders |
| `PATCH` | `/api/admin/orders/:ref` | Change order status |
| `GET` | `/api/admin/users` | Customer accounts |

Plain SQL via `mysql2/promise` — no ORM. Passwords are scrypt-hashed, sessions are HttpOnly cookies, prices are recomputed server-side, and orders are written in a transaction.
