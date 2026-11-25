"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");

const projectRoot = path.resolve(__dirname, "..");

try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch (_) {
  /* Real environment variables are also supported. */
}

const config = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "timsfood"
};

const schema = [
  `CREATE TABLE IF NOT EXISTS products (
     id          VARCHAR(80) NOT NULL PRIMARY KEY,
     name        VARCHAR(120) NOT NULL,
     format      VARCHAR(80) NOT NULL DEFAULT '',
     epithet     VARCHAR(200) NOT NULL DEFAULT '',
     variety     VARCHAR(60) NOT NULL DEFAULT '',
     category    VARCHAR(40) NOT NULL DEFAULT '',
     origin      VARCHAR(80) NOT NULL DEFAULT '',
     badge       VARCHAR(40) NOT NULL DEFAULT '',
     rating      DOUBLE NOT NULL DEFAULT 0,
     reviews     INT NOT NULL DEFAULT 0,
     price       INT NOT NULL DEFAULT 0,
     season      VARCHAR(40) NOT NULL DEFAULT '',
     weight      VARCHAR(60) NOT NULL DEFAULT '',
     palate      TEXT NOT NULL,
     table_note  TEXT NOT NULL,
     harvest     TEXT NOT NULL,
     gallery     TEXT NOT NULL,
     sort_order  INT NOT NULL DEFAULT 0,
     active      TINYINT(1) NOT NULL DEFAULT 1
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS images (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     checksum   CHAR(64) NOT NULL UNIQUE,
     data       LONGBLOB NOT NULL,
     mime       VARCHAR(64) NOT NULL,
     filename   VARCHAR(200) NOT NULL DEFAULT '',
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS users (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     name          VARCHAR(60) NOT NULL,
     email         VARCHAR(120) NOT NULL UNIQUE,
     password_hash VARCHAR(200) NOT NULL,
     city          VARCHAR(80) NOT NULL DEFAULT '',
     is_admin      TINYINT(1) NOT NULL DEFAULT 0,
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token      CHAR(64) NOT NULL PRIMARY KEY,
     user_id    INT UNSIGNED NOT NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     expires_at DATETIME NOT NULL DEFAULT (DATE_ADD(NOW(), INTERVAL 30 DAY)),
     KEY idx_sessions_expiry (expires_at),
     CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS \`orders\` (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     ref           VARCHAR(40) NOT NULL UNIQUE,
     user_id       INT UNSIGNED NULL,
     customer_name VARCHAR(60) NOT NULL,
     email         VARCHAR(120) NOT NULL,
     phone         VARCHAR(40) NOT NULL,
     address       VARCHAR(200) NOT NULL,
     city          VARCHAR(80) NOT NULL,
     region        VARCHAR(80) NOT NULL DEFAULT '',
     country       VARCHAR(60) NOT NULL DEFAULT 'Ghana',
     note          VARCHAR(400) NOT NULL DEFAULT '',
     subtotal      INT NOT NULL DEFAULT 0,
     shipping      INT NOT NULL DEFAULT 0,
     total         INT NOT NULL DEFAULT 0,
     status        VARCHAR(20) NOT NULL DEFAULT 'pending',
     created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_orders_user (user_id, id),
     CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS order_items (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     order_id   INT UNSIGNED NOT NULL,
     product_id VARCHAR(80) NOT NULL,
     name       VARCHAR(120) NOT NULL,
     format     VARCHAR(80) NOT NULL DEFAULT '',
     qty        INT NOT NULL,
     unit_price INT NOT NULL,
     KEY idx_order_items_order (order_id),
     CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES \`orders\`(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function withTransaction(db, fn) {
  const connection = await db.connection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function mimeForImage(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function seedProducts(db) {
  const row = await db.get("SELECT COUNT(*) AS count FROM products");
  if (Number(row.count) > 0) return 0;

  const source = fs.readFileSync(path.join(projectRoot, "js", "catalog.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "js/catalog.js" });
  const products = (sandbox.window.EV && sandbox.window.EV.products) || [];
  if (!products.length) return 0;

  const insert = `INSERT INTO products
    (id, name, format, epithet, variety, category, origin, badge, rating,
     reviews, price, season, weight, palate, table_note, harvest, gallery, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return withTransaction(db, async (connection) => {
    for (const [index, product] of products.entries()) {
      await connection.execute(insert, [
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
      ]);
    }
    return products.length;
  });
}

/** Copy product images from assets/ into MySQL and point gallery entries at /api/images/:id. */
async function migrateImages(db) {
  const products = await db.all("SELECT id, gallery FROM products");
  const seen = new Set();

  return withTransaction(db, async (connection) => {
    let converted = 0;
    for (const product of products) {
      let gallery;
      try {
        gallery = typeof product.gallery === "string"
          ? JSON.parse(product.gallery)
          : product.gallery;
      } catch (_) {
        continue;
      }
      if (!Array.isArray(gallery)) continue;
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
        if (!seen.has(checksum)) {
          await connection.execute(
            "INSERT IGNORE INTO images (checksum, data, mime, filename) VALUES (?, ?, ?, ?)",
            [checksum, data, mimeForImage(src), path.basename(src)]
          );
          seen.add(checksum);
        }
        const [rows] = await connection.execute(
          "SELECT id FROM images WHERE checksum = ?",
          [checksum]
        );
        if (!rows.length) continue;

        entry.imageId = Number(rows[0].id);
        entry.src = `/api/images/${rows[0].id}`;
        converted += 1;
        changed = true;
      }

      if (changed) {
        await connection.execute(
          "UPDATE products SET gallery = ? WHERE id = ?",
          [JSON.stringify(gallery), product.id]
        );
      }
    }
    return converted;
  });
}

/** Keep the browser-facing shape identical to js/catalog.js. */
function rowToProduct(row) {
  if (!row) return null;
  let gallery = [];
  try {
    gallery = typeof row.gallery === "string" ? JSON.parse(row.gallery) : (row.gallery || []);
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
    rating: Number(row.rating),
    reviews: Number(row.reviews),
    price: Number(row.price),
    season: row.season,
    weight: row.weight,
    palate: row.palate,
    table: row.table_note,
    harvest: row.harvest,
    active: Number(row.active) !== 0,
    gallery
  };
}

async function initDb() {
  if (!/^[A-Za-z0-9_]+$/.test(config.database)) {
    throw new Error("DB_NAME may only contain letters, numbers and underscores.");
  }

  const { database, ...connection } = config;
  const admin = await mysql.createConnection(connection);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }

  const pool = mysql.createPool({
    ...connection,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  for (const statement of schema) {
    await pool.query(statement);
  }

  // Add the admin flag to databases created before it existed.
  const [adminColumns] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_admin'`,
    [database]
  );
  if (!adminColumns.length) {
    await pool.query("ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0");
  }

  const db = {
    pool,
    async get(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows[0] || null;
    },
    async all(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    async run(sql, params = []) {
      const [result] = await pool.execute(sql, params);
      return { insertId: Number(result.insertId), affectedRows: result.affectedRows };
    },
    async connection() {
      return pool.getConnection();
    },
    async end() {
      await pool.end();
    }
  };

  const seededProducts = await seedProducts(db);
  const migratedImages = await migrateImages(db);
  return { db, seededProducts, migratedImages, config };
}

module.exports = { initDb, rowToProduct };
