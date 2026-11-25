"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, "timsfood.db");

if (process.env.DB_PATH) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT '',
  epithet     TEXT NOT NULL DEFAULT '',
  variety     TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL DEFAULT '',
  badge       TEXT NOT NULL DEFAULT '',
  rating      REAL NOT NULL DEFAULT 0,
  reviews     INTEGER NOT NULL DEFAULT 0,
  price       INTEGER NOT NULL DEFAULT 0,
  season      TEXT NOT NULL DEFAULT '',
  weight      TEXT NOT NULL DEFAULT '',
  palate      TEXT NOT NULL DEFAULT '',
  table_note  TEXT NOT NULL DEFAULT '',
  harvest     TEXT NOT NULL DEFAULT '',
  gallery     TEXT NOT NULL DEFAULT '[]',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  checksum   TEXT NOT NULL UNIQUE,
  data       BLOB NOT NULL,
  mime       TEXT NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  city          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT NOT NULL UNIQUE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  address       TEXT NOT NULL,
  city          TEXT NOT NULL,
  region        TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT 'Ghana',
  note          TEXT NOT NULL DEFAULT '',
  subtotal      INTEGER NOT NULL DEFAULT 0,
  shipping      INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT '',
  qty        INTEGER NOT NULL,
  unit_price INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

/** One-time import of the existing catalog so the DB becomes the source of truth. */
function seedProducts() {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM products").get();
  if (count > 0) return 0;

  const source = fs.readFileSync(path.join(__dirname, "..", "js", "catalog.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "js/catalog.js" });
  const products = (sandbox.window.EV && sandbox.window.EV.products) || [];
  if (!products.length) return 0;

  const insert = db.prepare(`
    INSERT INTO products
      (id, name, format, epithet, variety, category, origin, badge, rating,
       reviews, price, season, weight, palate, table_note, harvest, gallery, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    products.forEach((product, index) => {
      insert.run(
        product.id,
        product.name,
        product.format || "",
        product.epithet || "",
        product.variety || "",
        product.category || "",
        product.origin || "",
        product.badge || "",
        Number(product.rating) || 0,
        Number(product.reviews) || 0,
        Number(product.price) || 0,
        product.season || "",
        product.weight || "",
        product.palate || "",
        product.table || "",
        product.harvest || "",
        JSON.stringify(product.gallery || []),
        index
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return products.length;
}

const seededProducts = seedProducts();

function mimeForImage(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

/** Copy product images from assets/ into the DB and point gallery entries at /api/images/:id. */
function migrateProductImages() {
  const products = db.prepare("SELECT id, gallery FROM products").all();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO images (checksum, data, mime, filename) VALUES (?, ?, ?, ?)"
  );
  const find = db.prepare("SELECT id FROM images WHERE checksum = ?");
  const update = db.prepare("UPDATE products SET gallery = ? WHERE id = ?");
  let converted = 0;

  for (const product of products) {
    let gallery;
    try {
      gallery = JSON.parse(product.gallery || "[]");
    } catch (_) {
      continue;
    }
    let changed = false;

    for (const entry of gallery) {
      if (entry.imageId) continue;
      const src = String(entry.src || "");
      if (!src.startsWith("assets/")) continue;
      const file = path.resolve(projectRoot, src);
      if (!file.startsWith(projectRoot + path.sep)) continue;

      let data;
      try {
        data = fs.readFileSync(file);
      } catch (_) {
        continue;
      }
      const checksum = crypto.createHash("sha256").update(data).digest("hex");
      insert.run(checksum, data, mimeForImage(src), path.basename(src));
      const row = find.get(checksum);
      if (!row) continue;

      entry.imageId = row.id;
      entry.src = `/api/images/${row.id}`;
      converted += 1;
      changed = true;
    }

    if (changed) update.run(JSON.stringify(gallery), product.id);
  }
  return converted;
}

const migratedImages = migrateProductImages();

/** Keep the browser-facing shape identical to js/catalog.js. */
function rowToProduct(row) {
  if (!row) return null;
  let gallery = [];
  try {
    gallery = JSON.parse(row.gallery || "[]");
  } catch (_) {
    gallery = [];
  }
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    epithet: row.epithet,
    variety: row.variety,
    category: row.category,
    origin: row.origin,
    badge: row.badge,
    rating: row.rating,
    reviews: row.reviews,
    price: row.price,
    season: row.season,
    weight: row.weight,
    palate: row.palate,
    table: row.table_note,
    harvest: row.harvest,
    gallery
  };
}

module.exports = { db, dbPath, seededProducts, migratedImages, rowToProduct };
