# Tims Foods

A small shop front with a **MySQL-backed** Node server. Products, accounts, orders and product images are stored in MySQL; payment is pay-on-delivery (nothing is charged online).

## Run

Requires **Node.js 26+** and **MySQL 8+**.

```bash
npm install
cp .env.example .env   # then fill in your MySQL credentials
npm start              # http://127.0.0.1:5173/
npm test
```

`.env` is gitignored — credentials never go into the code. Example:

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=timsfood
PORT=5173
```

The database named by `DB_NAME` is created automatically if it does not exist. On first start the 20 products in `js/catalog.js` are imported into the `products` table and their images are copied from `assets/` into MySQL as BLOBs. After that, the database is the source of truth — edit products there, not in the JS file. `js/catalog.js` remains as an offline fallback if the API is unreachable.

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
| `GET` | `/api/admin/summary` | Admin dashboard totals |
| `GET` / `POST` | `/api/admin/products` | Admin product list / create |
| `PUT` / `DELETE` | `/api/admin/products/:id` | Edit / remove a product |
| `POST` | `/api/admin/products/:id/image` | Attach an image to a product in MySQL |
| `DELETE` | `/api/admin/products/:id/images/:imageId` | Remove an image from a product |
| `GET` | `/api/admin/orders` | All orders |
| `PATCH` | `/api/admin/orders/:ref` | Change order status |
| `GET` | `/api/admin/users` | Customer accounts |
| `GET` | `/api/admin/images` | Images stored in MySQL |

Requests and responses are JSON. Sessions use an HttpOnly, SameSite cookie; passwords are hashed with scrypt. Order line prices are recomputed from the database, so client-supplied prices are ignored. Orders are inserted in a single MySQL transaction.

## Database

Plain SQL through `mysql2/promise` — no ORM.

- `products` — catalog, seeded once from `js/catalog.js`
- `images` — product image BLOBs with SHA-256 checksums and MIME types
- `users`, `sessions` — accounts and 30-day login sessions
- `orders`, `order_items` — saved orders with a price/name snapshot per line

Static files are served from the project root; `db/`, `node_modules/` and dotfiles (including `.env`) are never served.

## Admin portal

Open `admin.html` and sign in with the account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`. That account is created (or promoted) automatically on first start. The **Admin** nav link only appears for admin users.

The portal has four sections:

- **Overview** — product/order/customer counts, sales total and recent orders
- **Products** — add, edit, hide and delete products; each row shows the images attached to that product, and the edit dialog lets you add or remove jar images straight into MySQL
- **Orders** — every order with a status dropdown (`pending`, `packed`, `shipped`, `delivered`, `cancelled`)
- **Customers** — accounts and their order counts

All admin endpoints require a signed-in admin session; regular customers get `403`.

## Pages

`index.html`, `shop.html`, `product.html`, `checkout.html`, `about.html`, `login.html`, `account.html`, `admin.html`.
