"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { initDb, rowToProduct } = require("./db/database");

const root = path.resolve(process.env.CLIENT_DIR || path.join(__dirname, "..", "client"));
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || "127.0.0.1";
const sessionDays = 30;
const maxBodyBytes = 64 * 1024;
const clientOrigin = (process.env.CLIENT_ORIGIN || "").trim();
const crossSite = process.env.COOKIE_SAME_SITE === "None";
const cookieFlags = [
  "HttpOnly",
  `SameSite=${crossSite ? "None" : "Lax"}`,
  "Path=/",
  crossSite ? "Secure" : ""
].filter(Boolean).join("; ");

const paystackSecret = (process.env.PAYSTACK_SECRET_KEY || "").trim();
const paystackWebhookSecret = (process.env.PAYSTACK_WEBHOOK_SECRET || "").trim();
const paystackApi = (process.env.PAYSTACK_API_BASE || "https://api.paystack.co").replace(/\/$/, "");
const paystackCurrency = (process.env.PAYSTACK_CURRENCY || "GHS").toUpperCase();

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

let db;
let config;

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

function corsHeaders(req) {
  if (!clientOrigin) return null;
  const origin = req.headers.origin;
  if (!origin || origin !== clientOrigin) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readRawBody(req, maxBytes = maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req, maxBytes = maxBodyBytes) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
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
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    city: row.city,
    isAdmin: Boolean(row.is_admin)
  };
}

async function currentUser(req) {
  const token = cookieValue(req, "tims_session");
  if (!token) return null;
  const row = await db.get(`
    SELECT u.id, u.name, u.email, u.city, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > NOW()
  `, [token]);
  return publicUser(row);
}

async function requireAdmin(req, res) {
  const user = await currentUser(req);
  if (!user) {
    fail(res, 401, "Sign in to continue.");
    return null;
  }
  if (!user.isAdmin) {
    fail(res, 403, "Admin access required.");
    return null;
  }
  return user;
}

/** Create or promote the bootstrap admin from env on first start. */
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return false;

  const existing = await db.get("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    await db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [existing.id]);
    return false;
  }
  await db.run(
    "INSERT INTO users (name, email, password_hash, city, is_admin) VALUES (?, ?, ?, ?, 1)",
    ["Administrator", email, hashPassword(password), ""]
  );
  return true;
}

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.run("INSERT INTO sessions (token, user_id) VALUES (?, ?)", [token, userId]);
  res.setHeader(
    "Set-Cookie",
    `tims_session=${token}; ${cookieFlags}; Max-Age=${sessionDays * 86400}`
  );
}

async function endSession(req, res) {
  const token = cookieValue(req, "tims_session");
  if (token) await db.run("DELETE FROM sessions WHERE token = ?", [token]);
  res.setHeader(
    "Set-Cookie",
    `tims_session=; ${cookieFlags}; Max-Age=0`
  );
}

/* ---------- orders ---------- */

async function newReference() {
  const year = new Date().getFullYear().toString().slice(2);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ref = `TF-${year}-${crypto.randomInt(1000, 10000)}`;
    if (!(await db.get("SELECT 1 FROM `orders` WHERE ref = ?", [ref]))) return ref;
  }
  return `TF-${year}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

async function getOrder(id) {
  const row = await db.get("SELECT * FROM `orders` WHERE id = ?", [id]);
  if (!row) return null;
  const items = await db.all(`
    SELECT product_id, name, format, qty, unit_price
    FROM order_items WHERE order_id = ? ORDER BY id
  `, [id]);
  return {
    id: Number(row.id),
    ref: row.ref,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    items: items.map((item) => ({
      id: item.product_id,
      name: item.name,
      format: item.format,
      qty: Number(item.qty),
      price: Number(item.unit_price)
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
    totals: {
      sub: Number(row.subtotal),
      transit: Number(row.shipping),
      total: Number(row.total)
    },
    payment: {
      method: row.payment_method || "delivery",
      status: row.payment_status || "unpaid",
      reference: row.payment_reference || "",
      paidAt: row.paid_at
        ? (row.paid_at instanceof Date ? row.paid_at.toISOString() : String(row.paid_at))
        : null
    }
  };
}

/* ---------- Paystack ---------- */

async function paystackRequest(method, endpoint, body) {
  const response = await fetch(`${paystackApi}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    /* Non-JSON response. */
  }
  if (!response.ok || !data || data.status === false) {
    const message = data && (data.message ||
      (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message));
    const error = new Error(message || `Paystack request failed (${response.status}).`);
    error.status = 502;
    throw error;
  }
  return data.data;
}

function paymentCallbackBase(req) {
  if (clientOrigin) return clientOrigin.replace(/\/$/, "");
  const configured = (process.env.PAYSTACK_CALLBACK_BASE || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}

function paymentMatchesOrder(data, order) {
  return Boolean(
    data && data.status === "success" &&
    Number(data.amount) === Number(order.total) * 100 &&
    String(data.currency || "").toUpperCase() === paystackCurrency
  );
}

async function markOrderPaid(id) {
  await db.run("UPDATE `orders` SET payment_status = 'paid', paid_at = NOW() WHERE id = ?", [id]);
}

/* ---------- API ---------- */

async function handleApi(req, res, url, pathname) {
  const method = req.method || "GET";

  // Product images, stored in MySQL as BLOBs
  const imageMatch = pathname.match(/^\/api\/images\/(\d+)$/);
  if (imageMatch && (method === "GET" || method === "HEAD")) {
    const row = await db.get("SELECT data, mime FROM images WHERE id = ?", [Number(imageMatch[1])]);
    if (!row) return fail(res, 404, "Image not found.");
    const data = Buffer.from(row.data);
    const etag = `"img-${imageMatch[1]}"`;
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
    let rows = await db.all("SELECT * FROM products WHERE active = 1 ORDER BY sort_order, id");
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
    const row = await db.get("SELECT * FROM products WHERE id = ? AND active = 1", [
      decodeURIComponent(productMatch[1])
    ]);
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
    if (await db.get("SELECT 1 FROM users WHERE email = ?", [email])) {
      return fail(res, 409, "An account with that email already exists.");
    }

    const result = await db.run(
      "INSERT INTO users (name, email, password_hash, city) VALUES (?, ?, ?, ?)",
      [name, email, hashPassword(password), city]
    );
    const user = { id: result.insertId, name, email, city };
    await startSession(res, user.id);
    return sendJson(res, 201, { user });
  }

  // Login
  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    const email = text(body.email, 120).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const row = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return fail(res, 401, "Incorrect email or password.");
    }
    await startSession(res, Number(row.id));
    return sendJson(res, 200, { user: publicUser(row) });
  }

  // Logout
  if (pathname === "/api/auth/logout" && method === "POST") {
    await endSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  // Current account
  if (pathname === "/api/me" && method === "GET") {
    return sendJson(res, 200, { user: await currentUser(req) });
  }

  // Place an order (guest or signed in)
  if (pathname === "/api/orders" && method === "POST") {
    const body = await readBody(req);
    const paymentMethod = text(body.paymentMethod, 20) === "paystack" ? "paystack" : "delivery";
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
      const product = await db.get(
        "SELECT id, name, format, price FROM products WHERE id = ? AND active = 1",
        [id]
      );
      if (!product) return fail(res, 400, `Product ${id} is no longer available.`);
      lines.push({
        product_id: product.id,
        name: product.name,
        format: product.format,
        qty,
        unit_price: Number(product.price)
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
    const user = await currentUser(req);
    const ref = await newReference();
    let orderId;

    const connection = await db.connection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(`
        INSERT INTO \`orders\`
          (ref, user_id, customer_name, email, phone, address, city, region,
           country, note, subtotal, shipping, total, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        ref, user ? user.id : null, customer.name, customer.email, customer.phone,
        customer.address, customer.city, customer.region, customer.country, customer.note,
        subtotal, shipping, subtotal + shipping, paymentMethod
      ]);
      orderId = Number(result.insertId);
      for (const line of lines) {
        await connection.execute(`
          INSERT INTO order_items (order_id, product_id, name, format, qty, unit_price)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [orderId, line.product_id, line.name, line.format, line.qty, line.unit_price]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return sendJson(res, 201, { order: await getOrder(orderId) });
  }

  // Order history (signed in only)
  if (pathname === "/api/orders" && method === "GET") {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Sign in to view your orders.");
    const rows = await db.all("SELECT id FROM `orders` WHERE user_id = ? ORDER BY id DESC", [user.id]);
    const orders = [];
    for (const row of rows) orders.push(await getOrder(row.id));
    return sendJson(res, 200, { orders });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === "GET") {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Sign in to view this order.");
    const row = await db.get("SELECT id FROM `orders` WHERE ref = ? AND user_id = ?", [
      decodeURIComponent(orderMatch[1]),
      user.id
    ]);
    if (!row) return fail(res, 404, "Order not found.");
    return sendJson(res, 200, { order: await getOrder(row.id) });
  }

  /* ---------- payments ---------- */

  if (pathname === "/api/payments/initialize" && method === "POST") {
    if (!paystackSecret) return fail(res, 400, "Paystack is not configured on the server.");
    const body = await readBody(req);
    const ref = text(body.ref, 40);
    if (!ref) return fail(res, 400, "Order reference is required.");
    const row = await db.get("SELECT * FROM `orders` WHERE ref = ?", [ref]);
    if (!row) return fail(res, 404, "Order not found.");
    const user = await currentUser(req);
    if (row.user_id && (!user || Number(user.id) !== Number(row.user_id))) {
      return fail(res, 403, "This order belongs to another account.");
    }
    if (row.payment_method !== "paystack") {
      return fail(res, 400, "This order is set to pay on delivery.");
    }
    if (row.payment_status === "paid") return fail(res, 400, "This order is already paid.");

    const reference = `${row.ref}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const data = await paystackRequest("POST", "/transaction/initialize", {
      email: row.email,
      amount: Number(row.total) * 100,
      currency: paystackCurrency,
      reference,
      callback_url: `${paymentCallbackBase(req)}/payment.html`,
      metadata: {
        order_ref: row.ref,
        custom_fields: [{ display_name: "Order", variable_name: "order_ref", value: row.ref }]
      }
    });
    if (!data || !data.authorization_url) {
      return fail(res, 502, "Paystack did not return a checkout URL.");
    }
    await db.run(
      "UPDATE `orders` SET payment_reference = ?, payment_status = 'awaiting_payment' WHERE id = ?",
      [reference, row.id]
    );
    return sendJson(res, 200, { authorizationUrl: data.authorization_url, reference });
  }

  if (pathname === "/api/payments/verify" && method === "GET") {
    if (!paystackSecret) return fail(res, 400, "Paystack is not configured on the server.");
    const reference = text(url.searchParams.get("reference") || url.searchParams.get("trxref"), 100);
    if (!reference) return fail(res, 400, "Payment reference is required.");
    const row = await db.get("SELECT * FROM `orders` WHERE payment_reference = ?", [reference]);
    if (!row) return fail(res, 404, "Payment reference not found.");

    const data = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!paymentMatchesOrder(data, row)) {
      await db.run(
        "UPDATE `orders` SET payment_status = 'failed' WHERE id = ? AND payment_status <> 'paid'",
        [row.id]
      );
      return fail(res, 400, "Payment was not completed. Please try again.");
    }
    await markOrderPaid(row.id);
    return sendJson(res, 200, { status: "paid", order: await getOrder(row.id) });
  }

  if (pathname === "/api/payments/webhook" && method === "POST") {
    if (!paystackWebhookSecret) return fail(res, 503, "Paystack webhook is not configured.");
    const raw = await readRawBody(req);
    const signature = String(req.headers["x-paystack-signature"] || "");
    const expected = crypto.createHmac("sha512", paystackWebhookSecret).update(raw).digest("hex");
    if (signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return fail(res, 400, "Invalid webhook signature.");
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      return fail(res, 400, "Invalid webhook payload.");
    }
    if (payload.event === "charge.success") {
      const reference = text(payload.data && payload.data.reference, 100);
      const row = reference
        ? await db.get("SELECT * FROM `orders` WHERE payment_reference = ?", [reference])
        : null;
      if (row && Number(payload.data.amount) === Number(row.total) * 100) {
        await markOrderPaid(row.id);
      }
    }
    return sendJson(res, 200, { received: true });
  }

  /* ---------- admin ---------- */
  if (pathname.startsWith("/api/admin/")) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (pathname === "/api/admin/summary" && method === "GET") {
      const products = await db.get("SELECT COUNT(*) AS count FROM products");
      const active = await db.get("SELECT COUNT(*) AS count FROM products WHERE active = 1");
      const orders = await db.get(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN payment_method = 'delivery' OR payment_status = 'paid'
                                  THEN total ELSE 0 END), 0) AS revenue
         FROM \`orders\``
      );
      const users = await db.get("SELECT COUNT(*) AS count FROM users");
      const images = await db.get("SELECT COUNT(*) AS count FROM images");
      const recent = await db.all(`
        SELECT o.id, o.ref, o.customer_name, o.total, o.status, o.created_at
        FROM \`orders\` o ORDER BY o.id DESC LIMIT 5
      `);
      return sendJson(res, 200, {
        summary: {
          products: Number(products.count),
          activeProducts: Number(active.count),
          orders: Number(orders.count),
          revenue: Number(orders.revenue),
          users: Number(users.count),
          images: Number(images.count)
        },
        recentOrders: recent.map((row) => ({
          ref: row.ref,
          name: row.customer_name,
          total: Number(row.total),
          status: row.status,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
        }))
      });
    }

    if (pathname === "/api/admin/products" && method === "GET") {
      const rows = await db.all("SELECT * FROM products ORDER BY sort_order, id");
      return sendJson(res, 200, { products: rows.map(rowToProduct) });
    }

    if (pathname === "/api/admin/products" && method === "POST") {
      const body = await readBody(req);
      const normalized = normalizeProduct(body, true);
      if (normalized.error) return fail(res, 400, normalized.error);
      const values = normalized.product;
      const columns = Object.keys(values);
      await db.run(
        `INSERT INTO products (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((key) => values[key])
      );
      return sendJson(res, 201, { product: rowToProduct(await db.get("SELECT * FROM products WHERE id = ?", [values.id])) });
    }

    const imageUpload = pathname.match(/^\/api\/admin\/products\/([^/]+)\/image$/);
    if (imageUpload && method === "POST") {
      const id = decodeURIComponent(imageUpload[1]);
      const product = await db.get("SELECT id, gallery FROM products WHERE id = ?", [id]);
      if (!product) return fail(res, 404, "Product not found.");
      const body = await readBody(req, 25 * 1024 * 1024);
      const base64 = String(body.data || "");
      const data = Buffer.from(base64, "base64");
      const allowed = ["image/png", "image/jpeg", "image/webp"];
      const mime = allowed.includes(body.mime) ? body.mime : "";
      if (!data.length || data.length > 20 * 1024 * 1024 || !mime) {
        return fail(res, 400, "Upload a PNG, JPEG or WebP image under 20 MB.");
      }
      const checksum = crypto.createHash("sha256").update(data).digest("hex");
      await db.run(
        "INSERT IGNORE INTO images (checksum, data, mime, filename) VALUES (?, ?, ?, ?)",
        [checksum, data, mime, text(body.filename, 200) || "upload.png"]
      );
      const image = await db.get("SELECT id FROM images WHERE checksum = ?", [checksum]);
      let gallery = [];
      try {
        gallery = typeof product.gallery === "string" ? JSON.parse(product.gallery) : (product.gallery || []);
      } catch (_) {
        gallery = [];
      }
      gallery.push({
        imageId: Number(image.id),
        src: `/api/images/${image.id}`,
        alt: text(body.alt, 200) || product.id,
        focus: "center"
      });
      await db.run("UPDATE products SET gallery = ? WHERE id = ?", [JSON.stringify(gallery), id]);
      return sendJson(res, 201, { imageId: Number(image.id), gallery });
    }

    const removeImage = pathname.match(/^\/api\/admin\/products\/([^/]+)\/images\/(\d+)$/);
    if (removeImage && method === "DELETE") {
      const id = decodeURIComponent(removeImage[1]);
      const imageId = Number(removeImage[2]);
      const product = await db.get("SELECT gallery FROM products WHERE id = ?", [id]);
      if (!product) return fail(res, 404, "Product not found.");
      let gallery = [];
      try {
        gallery = typeof product.gallery === "string" ? JSON.parse(product.gallery) : (product.gallery || []);
      } catch (_) {
        gallery = [];
      }
      const remaining = gallery.filter((entry) => Number(entry.imageId) !== imageId);
      if (remaining.length === gallery.length) return fail(res, 404, "Image is not attached to this product.");
      await db.run("UPDATE products SET gallery = ? WHERE id = ?", [JSON.stringify(remaining), id]);

      // Remove the stored bytes only when no other product still uses them.
      const allProducts = await db.all("SELECT gallery FROM products");
      const stillUsed = allProducts.some((row) => {
        try {
          const list = typeof row.gallery === "string" ? JSON.parse(row.gallery) : (row.gallery || []);
          return list.some((entry) => Number(entry.imageId) === imageId);
        } catch (_) {
          return false;
        }
      });
      if (!stillUsed) await db.run("DELETE FROM images WHERE id = ?", [imageId]);
      return sendJson(res, 200, { gallery: remaining });
    }

    const editProduct = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
    if (editProduct && (method === "PUT" || method === "PATCH" || method === "DELETE")) {
      const id = decodeURIComponent(editProduct[1]);
      if (!await db.get("SELECT 1 FROM products WHERE id = ?", [id])) {
        return fail(res, 404, "Product not found.");
      }
      if (method === "DELETE") {
        await db.run("DELETE FROM products WHERE id = ?", [id]);
        return sendJson(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const normalized = normalizeProduct(body, false);
      if (normalized.error) return fail(res, 400, normalized.error);
      const values = normalized.product;
      const columns = Object.keys(values);
      if (columns.length) {
        await db.run(
          `UPDATE products SET ${columns.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`,
          [...columns.map((key) => values[key]), id]
        );
      }
      return sendJson(res, 200, { product: rowToProduct(await db.get("SELECT * FROM products WHERE id = ?", [id])) });
    }

    if (pathname === "/api/admin/orders" && method === "GET") {
      const rows = await db.all(`
        SELECT o.id, o.user_id, u.email AS user_email
        FROM \`orders\` o LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC LIMIT 200
      `);
      const orders = [];
      for (const row of rows) {
        const order = await getOrder(row.id);
        order.userEmail = row.user_email || null;
        orders.push(order);
      }
      return sendJson(res, 200, { orders });
    }

    const editOrder = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (editOrder && method === "PATCH") {
      const body = await readBody(req);
      const status = text(body.status, 20).toLowerCase();
      if (!["pending", "packed", "shipped", "delivered", "cancelled"].includes(status)) {
        return fail(res, 400, "Unknown order status.");
      }
      const result = await db.run("UPDATE `orders` SET status = ? WHERE ref = ?", [status, decodeURIComponent(editOrder[1])]);
      if (!result.affectedRows) return fail(res, 404, "Order not found.");
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/admin/users" && method === "GET") {
      const rows = await db.all(`
        SELECT u.id, u.name, u.email, u.city, u.is_admin, u.created_at,
               (SELECT COUNT(*) FROM \`orders\` o WHERE o.user_id = u.id) AS order_count
        FROM users u ORDER BY u.id DESC LIMIT 200
      `);
      return sendJson(res, 200, {
        users: rows.map((row) => ({
          id: Number(row.id),
          name: row.name,
          email: row.email,
          city: row.city,
          isAdmin: Boolean(row.is_admin),
          orders: Number(row.order_count),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
        }))
      });
    }

    if (pathname === "/api/admin/images" && method === "GET") {
      const rows = await db.all(
        "SELECT id, mime, filename, LENGTH(data) AS size, created_at FROM images ORDER BY id DESC LIMIT 200"
      );
      return sendJson(res, 200, {
        images: rows.map((row) => ({
          id: Number(row.id),
          src: `/api/images/${row.id}`,
          mime: row.mime,
          filename: row.filename,
          size: Number(row.size),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
        }))
      });
    }

    return fail(res, 404, "Endpoint not found.");
  }

  return fail(res, 404, "Endpoint not found.");
}

/** Validate and map admin product form fields onto database columns. */
function normalizeProduct(body, creating) {
  const product = {};
  if (creating) {
    product.id = text(body.id, 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(product.id)) {
      return { error: "Product ID must use lowercase letters, numbers and dashes." };
    }
  }

  const fields = {
    name: ["name", 120], format: ["format", 80], epithet: ["epithet", 200],
    variety: ["variety", 60], category: ["category", 40], origin: ["origin", 80],
    badge: ["badge", 40], season: ["season", 40], weight: ["weight", 60],
    palate: ["palate", 3000], table: ["table_note", 3000], harvest: ["harvest", 3000]
  };
  for (const [input, [column, max]] of Object.entries(fields)) {
    if (creating || body[input] !== undefined) product[column] = text(body[input], max);
  }
  for (const field of ["rating", "reviews", "price", "sort_order"]) {
    if (creating || body[field] !== undefined) product[field] = Math.max(0, Number(body[field]) || 0);
  }
  if (creating || body.active !== undefined) product.active = body.active === false ? 0 : 1;
  if (creating) product.gallery = "[]";

  if (creating) {
    if (!product.name) return { error: "Product name is required." };
    if (!product.variety) return { error: "Variety is required." };
  }
  return { product };
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

let ready;

/** Initialise the database once per process (also safe for serverless warm starts). */
function init() {
  if (!ready) {
    ready = initDb().then(async (initialized) => {
      db = initialized.db;
      config = initialized.config;
      const createdAdmin = await ensureAdmin();
      return { ...initialized, createdAdmin };
    }).catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/** Request handler with no listen() call, so it can also be used by a host or serverless function. */
async function handler(req, res) {
  const cors = corsHeaders(req);
  if (cors) {
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Length": 0 });
    return res.end();
  }

  await init();

  const url = new URL(req.url || "/", `http://${req.headers.host || host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    pathname = url.pathname;
  }

  if (pathname.startsWith("/api/")) {
    try {
      return await handleApi(req, res, url, pathname);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status && error.status < 500 ? error.status : 500;
      if (status === 500) console.error(error);
      return fail(res, status, status === 500 ? "Server error." : error.message);
    }
  }

  return serveStatic(req, res, pathname, req.method || "GET");
}

async function main() {
  const initialized = await init();
  http.createServer(handler).listen(port, host, () => {
    console.log(`Tims Foods API: http://${host}:${port}/`);
    console.log(`Client files: ${root}`);
    console.log(`MySQL: ${config.host}:${config.port}/${config.database}`);
    if (clientOrigin) console.log(`Allowed browser origin: ${clientOrigin}`);
    if (initialized.seededProducts) {
      console.log(`Seeded ${initialized.seededProducts} products from catalog.js`);
    }
    if (initialized.migratedImages) {
      console.log(`Stored ${initialized.migratedImages} product image references in MySQL`);
    }
    if (initialized.createdAdmin) {
      console.log(`Created admin account: ${process.env.ADMIN_EMAIL}`);
    }
  });
}

module.exports = { handler, init };

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
  });
}
