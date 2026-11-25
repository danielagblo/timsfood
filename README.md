# Tims Foods

A shop front with a **MySQL-backed API** and an admin portal. Products, accounts, orders and product images live in MySQL; payment is pay-on-delivery.

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

Credentials are never committed — `.env` is gitignored.

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
| `GET` | `/api/admin/summary` | Admin dashboard totals |
| `GET` / `POST` | `/api/admin/products` | Admin product list / create |
| `PUT` / `DELETE` | `/api/admin/products/:id` | Edit / remove a product |
| `POST` | `/api/admin/products/:id/image` | Attach an image to a product |
| `DELETE` | `/api/admin/products/:id/images/:imageId` | Detach an image |
| `GET` | `/api/admin/orders` | All orders |
| `PATCH` | `/api/admin/orders/:ref` | Change order status |
| `GET` | `/api/admin/users` | Customer accounts |

Plain SQL via `mysql2/promise` — no ORM. Passwords are scrypt-hashed, sessions are HttpOnly cookies, prices are recomputed server-side, and orders are written in a transaction.
