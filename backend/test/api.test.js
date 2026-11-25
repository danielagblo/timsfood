"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { verifyWebhookSignature } = require("../server");

const root = path.resolve(__dirname, "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch (_) {
  /* Real environment variables are also supported. */
}

const testDb = `timsfood_test_${process.pid}`;
const port = 5199;
const base = `http://127.0.0.1:${port}`;
const paystackPort = 5200;
const paystackSecret = "test_secret";
const webhookSecret = "test_webhook_secret";
let paystackMock;
let lastInitialize = null;
let verifyStatus = "success";
let verifyAmount = null;
const dbConnection = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || ""
};

let child;

async function withAdmin(action) {
  const admin = await mysql.createConnection(dbConnection);
  try {
    await action(admin);
  } finally {
    await admin.end();
  }
}

async function withTestDb(action) {
  const connection = await mysql.createConnection({ ...dbConnection, database: testDb });
  try {
    await action(connection);
  } finally {
    await connection.end();
  }
}

async function resetTestDatabase() {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``);
    await admin.query(
      `CREATE DATABASE \`${testDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  });
}

async function dropTestDatabase() {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``);
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/products`);
      if (response.ok) return;
    } catch (_) {
      /* Not listening yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start in time.");
}

async function startServer() {
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_NAME: testDb,
      PAYSTACK_SECRET_KEY: paystackSecret,
      PAYSTACK_WEBHOOK_SECRET: webhookSecret,
      PAYSTACK_API_BASE: `http://127.0.0.1:${paystackPort}`,
      PAYSTACK_CALLBACK_BASE: base
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
}

async function stopServer() {
  if (!child) return;
  const exiting = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exiting;
  child = undefined;
}

function cookieJar() {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async request(endpoint, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      const response = await fetch(base + endpoint, { ...options, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const pair = setCookie.split(";")[0].trim();
        cookie = pair.startsWith("tims_session=") && pair.length > "tims_session=".length
          ? pair
          : "";
      }
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        /* Non-JSON response. */
      }
      return { status: response.status, body, headers: response.headers };
    }
  };
}

const delivery = {
  name: "Ama Mensah",
  email: "ama@example.com",
  phone: "0240000000",
  address: "12 Independence Avenue",
  city: "Accra",
  region: "Greater Accra",
  country: "Ghana",
  note: "Call on arrival"
};

async function startPaystackMock() {
  paystackMock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/transaction/initialize") {
        lastInitialize = JSON.parse(body || "{}");
        assert.equal(req.headers.authorization, `Bearer ${paystackSecret}`);
        return res.end(JSON.stringify({
          status: true,
          data: {
            authorization_url: `http://127.0.0.1:${paystackPort}/checkout/${lastInitialize.reference}`,
            access_code: "mock",
            reference: lastInitialize.reference
          }
        }));
      }
      const verify = req.url.match(/^\/transaction\/verify\/(.+)$/);
      if (verify) {
        const reference = decodeURIComponent(verify[1]);
        return res.end(JSON.stringify({
          status: true,
          data: {
            status: verifyStatus,
            reference,
            amount: verifyAmount == null ? (lastInitialize && lastInitialize.amount) : verifyAmount,
            currency: "GHS"
          }
        }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((resolve) => paystackMock.listen(paystackPort, "127.0.0.1", resolve));
}

async function stopPaystackMock() {
  if (!paystackMock) return;
  await new Promise((resolve) => paystackMock.close(resolve));
  paystackMock = undefined;
}

before(async () => {
  await startPaystackMock();
  await resetTestDatabase();
  await startServer();
});

after(async () => {
  await stopServer();
  await stopPaystackMock();
  await dropTestDatabase();
});

test("API serves seeded products and protects private files", async (t) => {
  await t.test("product list comes from MySQL", async () => {
    const response = await fetch(`${base}/api/products`);
    assert.equal(response.status, 200);
    const { products } = await response.json();
    assert.equal(products.length, 20);
    assert.ok(products.every((product) => Array.isArray(product.gallery)));
    assert.ok(products.some((product) => product.id === "weannimix" && product.table));

    const entries = products.flatMap((product) => product.gallery);
    assert.equal(entries.length, 28);
    assert.ok(entries.every((entry) =>
      typeof entry.imageId === "number" && entry.src.startsWith("/api/images/")
    ));
    assert.ok(new Set(entries.map((entry) => entry.imageId)).size < entries.length);
  });

  await t.test("product images are served from MySQL", async () => {
    const { products } = await (await fetch(`${base}/api/products`)).json();
    const src = products.find((product) => product.id === "soy-powder").gallery[0].src;
    const image = await fetch(base + src);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /image\/png/);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(bytes.length > 10000);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    const missing = await fetch(`${base}/api/images/999999`);
    assert.equal(missing.status, 404);
  });

  await t.test("single product and unknown product", async () => {
    const found = await fetch(`${base}/api/products/weannimix`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).product.name, "Weannimix Tom Brown");
    const missing = await fetch(`${base}/api/products/nope`);
    assert.equal(missing.status, 404);
  });

  await t.test("source and env files cannot be downloaded", async () => {
    for (const endpoint of ["/db/database.js", "/.env"]) {
      const response = await fetch(base + endpoint);
      assert.equal(response.status, 403);
    }
  });
});

test("accounts can register, log in and log out", async (t) => {
  const guest = cookieJar();

  await t.test("registration creates a session", async () => {
    const response = await guest.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ama Mensah",
        email: "ama@example.com",
        password: "securepassword",
        city: "Accra"
      })
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.user.email, "ama@example.com");
    assert.ok(guest.cookie);
    const me = await guest.request("/api/me");
    assert.equal(me.body.user.name, "Ama Mensah");
  });

  await t.test("duplicate email is rejected", async () => {
    const other = cookieJar();
    const response = await other.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other", email: "AMA@example.com", password: "securepassword" })
    });
    assert.equal(response.status, 409);
  });

  await t.test("logout clears the session", async () => {
    const response = await guest.request("/api/auth/logout", { method: "POST" });
    assert.equal(response.status, 200);
    const me = await guest.request("/api/me");
    assert.equal(me.body.user, null);
  });

  await t.test("bad password fails, good password succeeds", async () => {
    let response = await guest.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ama@example.com", password: "wrongpassword" })
    });
    assert.equal(response.status, 401);
    response = await guest.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ama@example.com", password: "securepassword" })
    });
    assert.equal(response.status, 200);
    assert.ok(guest.cookie);
  });
});

test("orders are saved with server-side prices", async (t) => {
  const guest = cookieJar();

  await t.test("guest order is stored", async () => {
    const response = await guest.request("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...delivery,
        email: "guest@example.com",
        items: [{ id: "weannimix", qty: 2 }, { id: "soy-powder", qty: 1 }]
      })
    });
    assert.equal(response.status, 201);
    const order = response.body.order;
    assert.match(order.ref, /^TF-\d\d-\d{4}$/);
    assert.equal(order.totals.sub, 45 * 2 + 42);
    assert.equal(order.totals.total, order.totals.sub);
    assert.equal(order.items.length, 2);
    assert.equal(order.items[0].name, "Weannimix Tom Brown");
  });

  await t.test("invalid carts and details are rejected", async () => {
    let response = await guest.request("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...delivery, items: [{ id: "weannimix", qty: 99 }] })
    });
    assert.equal(response.status, 400);
    response = await guest.request("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...delivery, email: "not-an-email", items: [{ id: "soy-powder", qty: 1 }] })
    });
    assert.equal(response.status, 400);
  });

  await t.test("history requires a session and shows only that user's orders", async () => {
    let response = await guest.request("/api/orders");
    assert.equal(response.status, 401);

    response = await guest.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ama@example.com", password: "securepassword" })
    });
    assert.equal(response.status, 200);

    response = await guest.request("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...delivery, items: [{ id: "rice-flour", qty: 3 }] })
    });
    assert.equal(response.status, 201);
    const ref = response.body.order.ref;

    const history = await guest.request("/api/orders");
    assert.equal(history.status, 200);
    assert.equal(history.body.orders.length, 1);
    assert.equal(history.body.orders[0].ref, ref);

    const one = await guest.request(`/api/orders/${encodeURIComponent(ref)}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.order.totals.total, 38 * 3);
  });

  await t.test("orders survive a server restart", async () => {
    const savedCookie = guest.cookie;
    await stopServer();
    await startServer();
    const headers = { Cookie: savedCookie };
    const response = await fetch(`${base}/api/orders`, { headers });
    assert.equal(response.status, 200);
    const { orders } = await response.json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].items[0].id, "rice-flour");
  });
});

test("admin portal manages the shop", async (t) => {
  const admin = cookieJar();

  await t.test("admin account exists and is protected", async () => {
    let response = await admin.request("/api/admin/summary");
    assert.equal(response.status, 401);

    response = await admin.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.isAdmin, true);

    const customer = cookieJar();
    await customer.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ama@example.com", password: "securepassword" })
    });
    response = await customer.request("/api/admin/summary");
    assert.equal(response.status, 403);
  });

  await t.test("dashboard reports database totals", async () => {
    const { products } = await (await fetch(`${base}/api/products`)).json();
    const uniqueImages = new Set(products.flatMap((p) => p.gallery.map((g) => g.imageId))).size;

    const response = await admin.request("/api/admin/summary");
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.products, 20);
    assert.equal(response.body.summary.images, uniqueImages);
    assert.ok(response.body.summary.orders >= 1);
    assert.ok(response.body.recentOrders.length >= 1);
  });

  await t.test("products can be created, edited and removed", async () => {
    let response = await admin.request("/api/admin/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "testjar", name: "Test Jar", format: "Small jar",
        variety: "Porridge mixes", category: "Porridge", price: 25
      })
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.product.price, 25);

    response = await admin.request("/api/admin/products/testjar", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: 31, active: false })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.product.price, 31);
    assert.equal(response.body.product.active, false);

    response = await admin.request("/api/admin/products/testjar/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64"),
        mime: "image/png",
        filename: "testjar.png"
      })
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.gallery.length, 1);
    const imageId = response.body.gallery[0].imageId;

    response = await admin.request("/api/admin/images");
    assert.equal(response.status, 200);
    assert.ok(response.body.images.some((image) => image.filename === "testjar.png"));
    assert.ok(response.body.images.some((image) => image.src.startsWith("/api/images/")));

    response = await admin.request(`/api/admin/products/testjar/images/${imageId}`, {
      method: "DELETE"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.gallery.length, 0);

    response = await admin.request("/api/admin/images");
    assert.ok(!response.body.images.some((image) => image.filename === "testjar.png"));

    response = await admin.request("/api/admin/products/testjar", { method: "DELETE" });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/products/testjar`);
    assert.equal(response.status, 404);
  });

  await t.test("orders and customers are visible, statuses can change", async () => {
    let response = await admin.request("/api/admin/orders");
    assert.equal(response.status, 200);
    assert.ok(response.body.orders.length >= 1);
    assert.equal(response.body.orders[0].userEmail, "ama@example.com");

    const ref = response.body.orders[0].ref;
    response = await admin.request(`/api/admin/orders/${encodeURIComponent(ref)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "shipped" })
    });
    assert.equal(response.status, 200);

    response = await admin.request("/api/admin/orders");
    assert.equal(response.body.orders[0].status, "shipped");

    response = await admin.request("/api/admin/users");
    assert.equal(response.status, 200);
    assert.ok(response.body.users.some((user) => user.email === process.env.ADMIN_EMAIL && user.isAdmin));
  });
});

test("Paystack orders are saved first, then marked paid", async (t) => {
  async function placeOrder(extra = {}) {
    const response = await fetch(`${base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...delivery,
        items: [{ id: "rice-flour", qty: 2 }],
        ...extra
      })
    });
    assert.equal(response.status, 201);
    return (await response.json()).order;
  }

  async function paymentRow(ref) {
    let result;
    await withTestDb(async (connection) => {
      const [rows] = await connection.query(
        "SELECT payment_method, payment_status, payment_reference, paid_at FROM `orders` WHERE ref = ?",
        [ref]
      );
      result = rows[0];
    });
    return result;
  }

  async function initialize(order) {
    const response = await fetch(`${base}/api/payments/initialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: order.ref })
    });
    assert.equal(response.status, 200);
    return (await response.json());
  }

  let paystackOrder;
  let reference;

  await t.test("delivery and Paystack orders start unpaid", async () => {
    const deliveryOrder = await placeOrder();
    assert.equal(deliveryOrder.payment.method, "delivery");
    assert.equal(deliveryOrder.payment.status, "unpaid");

    paystackOrder = await placeOrder({ paymentMethod: "paystack" });
    assert.equal(paystackOrder.payment.method, "paystack");
    assert.equal(paystackOrder.payment.status, "unpaid");
    assert.equal((await paymentRow(paystackOrder.ref)).payment_status, "unpaid");
  });

  await t.test("initialize returns a hosted checkout URL and saves the reference", async () => {
    const result = await initialize(paystackOrder);
    reference = result.reference;
    assert.ok(reference.startsWith(`${paystackOrder.ref}-`));
    assert.ok(result.authorizationUrl.startsWith(`http://127.0.0.1:${paystackPort}/checkout/`));
    assert.equal(lastInitialize.amount, paystackOrder.totals.total * 100);
    assert.equal(lastInitialize.currency, "GHS");
    assert.ok(lastInitialize.callback_url.endsWith("/payment.html"));

    const row = await paymentRow(paystackOrder.ref);
    assert.equal(row.payment_reference, reference);
    assert.equal(row.payment_status, "awaiting_payment");
  });

  await t.test("verification marks the order paid and is idempotent", async () => {
    let response = await fetch(`${base}/api/payments/verify?reference=${encodeURIComponent(reference)}`);
    assert.equal(response.status, 200);
    let data = await response.json();
    assert.equal(data.status, "paid");
    assert.equal(data.order.payment.status, "paid");
    assert.ok(data.order.payment.paidAt);

    response = await fetch(`${base}/api/payments/verify?reference=${encodeURIComponent(reference)}`);
    assert.equal(response.status, 200);

    const order = await placeOrder({ paymentMethod: "paystack" });
    const started = await initialize(order);
    verifyAmount = 1;
    response = await fetch(`${base}/api/payments/verify?reference=${encodeURIComponent(started.reference)}`);
    verifyAmount = null;
    assert.equal(response.status, 400);
    assert.equal((await paymentRow(order.ref)).payment_status, "failed");
  });

  await t.test("a signed webhook marks the order paid", async () => {
    const order = await placeOrder({ paymentMethod: "paystack" });
    const started = await initialize(order);
    const payload = JSON.stringify({
      event: "charge.success",
      data: { reference: started.reference, amount: order.totals.total * 100, currency: "GHS" }
    });
    const post = (signature) => fetch(`${base}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": signature
      },
      body: payload
    });

    let response = await post("bad-signature");
    assert.equal(response.status, 401);
    assert.equal((await paymentRow(order.ref)).payment_status, "awaiting_payment");

    const signature = crypto.createHmac("sha512", webhookSecret).update(payload).digest("hex");
    response = await post(signature);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).received, true);
    assert.equal((await paymentRow(order.ref)).payment_status, "paid");
  });

  await t.test("pay-on-delivery orders cannot be paid online", async () => {
    const order = await placeOrder();
    const response = await fetch(`${base}/api/payments/initialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: order.ref })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /pay on delivery/i);
  });

  await t.test("new whsec_ webhook signatures are verified", async () => {
    const secret = "whsec_test_secret";
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "TF-test" } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha512", secret).update(`${timestamp}.`).update(raw).digest("hex");
    const header = `t=${timestamp},v1=whk_test:${signature}`;

    assert.equal(verifyWebhookSignature(raw, secret, { "paystack-signature": header }), true);
    const stale = `t=${timestamp - 400},v1=whk_test:${signature}`;
    assert.equal(verifyWebhookSignature(raw, secret, { "paystack-signature": stale }), false);
    assert.equal(verifyWebhookSignature(raw, secret, { "x-paystack-signature": signature }), false);
  });
});
