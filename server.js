"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db, dbPath, seededProducts, migratedImages, rowToProduct } = require("./db/database");

const root = path.resolve(__dirname);
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || "127.0.0.1";
const sessionDays = 30;
const maxBodyBytes = 64 * 1024;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

/* ---------- shared helpers ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (_) {
    const error = new Error("Invalid JSON body.");
    error.status = 400;
    throw error;
  }
}

const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- accounts ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length || 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch (_) {
        return rest.join("=");
      }
    }
  }
  return null;
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, city: row.city };
}

function currentUser(req) {
  const token = cookieValue(req, "tims_session");
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.city
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString());
  return publicUser(row);
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, expiresAt);
  res.setHeader(
    "Set-Cookie",
    `tims_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDays * 86400}`
  );
}

function endSession(req, res) {
  const token = cookieValue(req, "tims_session");
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.setHeader(
    "Set-Cookie",
    "tims_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  );
}

/* ---------- orders ---------- */

function newReference() {
  const year = new Date().getFullYear().toString().slice(2);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ref = `TF-${year}-${crypto.randomInt(1000, 10000)}`;
    if (!db.prepare("SELECT 1 FROM orders WHERE ref = ?").get(ref)) return ref;
  }
  return `TF-${year}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function getOrder(id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  const items = db.prepare(`
    SELECT product_id, name, format, qty, unit_price
    FROM order_items WHERE order_id = ? ORDER BY id
  `).all(id);
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    createdAt: row.created_at,
    items: items.map((item) => ({
      id: item.product_id,
      name: item.name,
      format: item.format,
      qty: item.qty,
      price: item.unit_price
    })),
    data: {
      name: row.customer_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      city: row.city,
      postcode: row.region,
      country: row.country,
      note: row.note
    },
    totals: { sub: row.subtotal, transit: row.shipping, total: row.total }
  };
}

/* ---------- API ---------- */

async function handleApi(req, res, url, pathname) {
  const method = req.method || "GET";

  // Product images, stored in SQLite as BLOBs
  const imageMatch = pathname.match(/^\/api\/images\/(\d+)$/);
  if (imageMatch && (method === "GET" || method === "HEAD")) {
    const id = Number(imageMatch[1]);
    const row = db.prepare("SELECT data, mime FROM images WHERE id = ?").get(id);
    if (!row) return fail(res, 404, "Image not found.");
    const data = Buffer.from(row.data);
    const etag = `"img-${id}"`;
    res.writeHead(200, {
      "Content-Type": row.mime,
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=86400",
      ETag: etag
    });
    const noBody = method === "HEAD" || req.headers["if-none-match"] === etag;
    return res.end(noBody ? undefined : data);
  }

  // Products
  if (pathname === "/api/products" && method === "GET") {
    let rows = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY sort_order, id").all();
    const variety = url.searchParams.get("variety");
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (variety) rows = rows.filter((row) => row.variety === variety);
    if (query) {
      rows = rows.filter((row) =>
        `${row.name} ${row.format} ${row.variety}`.toLowerCase().includes(query)
      );
    }
    return sendJson(res, 200, { products: rows.map(rowToProduct) });
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && method === "GET") {
    const row = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
      .get(decodeURIComponent(productMatch[1]));
    if (!row) return fail(res, 404, "Product not found.");
    return sendJson(res, 200, { product: rowToProduct(row) });
  }

  // Register
  if (pathname === "/api/auth/register" && method === "POST") {
    const body = await readBody(req);
    const name = text(body.name, 60);
    const email = text(body.email, 120).toLowerCase();
    const city = text(body.city, 80);
    const password = typeof body.password === "string" ? body.password : "";

    if (name.length < 2) return fail(res, 400, "Enter your full name.");
    if (!emailPattern.test(email)) return fail(res, 400, "Enter a valid email address.");
    if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters.");
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      return fail(res, 409, "An account with that email already exists.");
    }

    const info = db.prepare(
      "INSERT INTO users (name, email, password_hash, city) VALUES (?, ?, ?, ?)"
    ).run(name, email, hashPassword(password), city);
    const user = { id: Number(info.lastInsertRowid), name, email, city };
    startSession(res, user.id);
    return sendJson(res, 201, { user });
  }

  // Login
  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    const email = text(body.email, 120).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return fail(res, 401, "Incorrect email or password.");
    }
    startSession(res, row.id);
    return sendJson(res, 200, { user: publicUser(row) });
  }

  // Logout
  if (pathname === "/api/auth/logout" && method === "POST") {
    endSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  // Current account
  if (pathname === "/api/me" && method === "GET") {
    return sendJson(res, 200, { user: currentUser(req) });
  }

  // Place an order (guest or signed in)
  if (pathname === "/api/orders" && method === "POST") {
    const body = await readBody(req);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0 || rawItems.length > 50) {
      return fail(res, 400, "Your cart must contain at least one item.");
    }

    const quantities = new Map();
    for (const item of rawItems) {
      const id = text(item && item.id, 80);
      const qty = Math.round(Number(item && item.qty));
      if (!id || !Number.isFinite(qty) || qty < 1 || qty > 12) {
        return fail(res, 400, "There is an invalid item in your cart.");
      }
      const total = (quantities.get(id) || 0) + qty;
      if (total > 12) return fail(res, 400, "Maximum 12 of any one product.");
      quantities.set(id, total);
    }

    const lines = [];
    for (const [id, qty] of quantities) {
      const product = db.prepare(
        "SELECT id, name, format, price FROM products WHERE id = ? AND active = 1"
      ).get(id);
      if (!product) return fail(res, 400, `Product ${id} is no longer available.`);
      lines.push({
        product_id: product.id,
        name: product.name,
        format: product.format,
        qty,
        unit_price: product.price
      });
    }

    const customer = {
      name: text(body.name, 60),
      email: text(body.email, 120).toLowerCase(),
      phone: text(body.phone, 40),
      address: text(body.address, 200),
      city: text(body.city, 80),
      region: text(body.region, 80),
      country: text(body.country, 60) || "Ghana",
      note: text(body.note, 400)
    };
    if (!customer.name || !emailPattern.test(customer.email) || !customer.phone ||
        !customer.address || !customer.city) {
      return fail(res, 400, "Complete all required delivery details.");
    }

    const subtotal = lines.reduce((sum, line) => sum + line.unit_price * line.qty, 0);
    const shipping = 0;
    const user = currentUser(req);
    const ref = newReference();

    db.exec("BEGIN");
    let orderId;
    try {
      const info = db.prepare(`
        INSERT INTO orders
          (ref, user_id, customer_name, email, phone, address, city, region,
           country, note, subtotal, shipping, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ref, user ? user.id : null, customer.name, customer.email, customer.phone,
        customer.address, customer.city, customer.region, customer.country, customer.note,
        subtotal, shipping, subtotal + shipping
      );
      orderId = Number(info.lastInsertRowid);
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, format, qty, unit_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const line of lines) {
        insertItem.run(orderId, line.product_id, line.name, line.format, line.qty, line.unit_price);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return sendJson(res, 201, { order: getOrder(orderId) });
  }

  // Order history (signed in only)
  if (pathname === "/api/orders" && method === "GET") {
    const user = currentUser(req);
    if (!user) return fail(res, 401, "Sign in to view your orders.");
    const orders = db.prepare("SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC")
      .all(user.id)
      .map((row) => getOrder(row.id));
    return sendJson(res, 200, { orders });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === "GET") {
    const user = currentUser(req);
    if (!user) return fail(res, 401, "Sign in to view this order.");
    const row = db.prepare("SELECT id FROM orders WHERE ref = ? AND user_id = ?")
      .get(decodeURIComponent(orderMatch[1]), user.id);
    if (!row) return fail(res, 404, "Order not found.");
    return sendJson(res, 200, { order: getOrder(row.id) });
  }

  return fail(res, 404, "Endpoint not found.");
}

/* ---------- static files ---------- */

function serveStatic(req, res, pathname, method) {
  if (method !== "GET" && method !== "HEAD") {
    return fail(res, 405, "Method not allowed.");
  }

  const urlPath = pathname === "/" ? "/index.html" : pathname;
  const rel = path.normalize(urlPath)
    .replace(/^([.][.][\\/])+/g, "")
    .replace(/^[\\/]+/, "");
  const file = path.resolve(root, rel);
  const insideRoot = file === root || file.startsWith(root + path.sep);
  const privateSegment = rel.split(/[\\/]/).some(
    (segment) => ["data", "db", "node_modules", ".git"].includes(segment) ||
      segment.startsWith(".")
  );

  if (!insideRoot || privateSegment) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Content-Length": data.length
    });
    res.end(method === "HEAD" ? undefined : data);
  });
}

/* ---------- server ---------- */

http.createServer((req, res) => {
  Promise.resolve().then(async () => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      pathname = url.pathname;
    }

    if (pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, url, pathname);
      } catch (error) {
        if (res.headersSent) return res.end();
        const status = error.status && error.status < 500 ? error.status : 500;
        if (status === 500) console.error(error);
        return fail(res, status, status === 500 ? "Server error." : error.message);
      }
      return;
    }

    return serveStatic(req, res, pathname, req.method || "GET");
  });
}).listen(port, host, () => {
  console.log(`Tims Foods shop: http://${host}:${port}/`);
  console.log(`Database: ${dbPath}`);
  if (seededProducts) console.log(`Seeded ${seededProducts} products from js/catalog.js`);
  if (migratedImages) console.log(`Stored ${migratedImages} product image references in the database`);
});
