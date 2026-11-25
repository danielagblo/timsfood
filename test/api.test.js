"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "timsfood-api-"));
const dbPath = path.join(tmp, "timsfood.db");
const port = 5199;
const base = `http://127.0.0.1:${port}`;

let child;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
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

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("API serves seeded products and protects private files", async (t) => {
  await t.test("product list comes from the database", async () => {
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

  await t.test("product images are served from the database", async () => {
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

  await t.test("database files cannot be downloaded", async () => {
    const response = await fetch(`${base}/data/timsfood.db`);
    assert.equal(response.status, 403);
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
