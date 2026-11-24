(function () {
  const KEY = "timsfood-cart";
  const FILTERS = ["All", "Porridge mixes", "Traditional", "Grits & flour", "Family size"];
  const cedis = new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    maximumFractionDigits: 0
  });

  let filter = "All";
  let query = "";
  let lastFocus = null;
  let toastTimer = 0;

  const money = (n) => cedis.format(n);

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function productById(id) {
    return window.EV.products.find((item) => item.id === id);
  }

  function readCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((line) => productById(line.id)) : [];
    } catch (error) {
      return [];
    }
  }

  function writeCart(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch (error) {
      /* The bag still works for this page view if storage is blocked. */
    }
  }

  function keyOf(id) {
    return id;
  }

  function clampQty(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) return 1;
    return Math.min(12, number);
  }

  function totals(cart) {
    const sub = cart.reduce((sum, line) => sum + productById(line.id).price * line.qty, 0);
    const transit = sub === 0 ? 0 : 25;
    return { sub, transit, total: sub + transit };
  }

  function mountChrome() {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="backdrop" data-close-bag hidden></div>
      <aside class="drawer" id="bag" role="dialog" aria-modal="true" aria-labelledby="bag-title" aria-hidden="true" inert>
        <div class="drawer-head">
          <h2 id="bag-title">Your cart</h2>
          <button type="button" class="text-btn" data-close-bag>Close</button>
        </div>
        <div class="drawer-body" id="bag-body"></div>
        <div class="drawer-foot" id="bag-foot"></div>
      </aside>
      <div class="toast" id="toast" role="status"></div>
    `);
  }

  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove("is-visible"), 2400);
  }

  function updateCount(count) {
    document.querySelectorAll("[data-bag-count]").forEach((el) => {
      el.textContent = String(count);
    });
    const button = document.querySelector("[data-open-bag]");
    if (button) button.setAttribute("aria-label", count ? `Open cart, ${count} items` : "Open cart");
  }

  function lineHtml(line) {
    const product = productById(line.id);
    const key = keyOf(line.id);
    const image = product.gallery[0];
    return `
      <article class="line">
        <a href="product.html?id=${encodeURIComponent(product.id)}">
          <img src="${image.src}" alt="" style="object-position:${image.focus || "center"}">
        </a>
        <div>
          <h3><a href="product.html?id=${encodeURIComponent(product.id)}">${escapeHtml(product.name)}</a></h3>
          <p class="line-meta">${escapeHtml(product.format)}</p>
          <div class="qty qty-sm">
            <button type="button" data-line-step="-1" data-key="${key}" aria-label="Decrease quantity">−</button>
            <span>${line.qty}</span>
            <button type="button" data-line-step="1" data-key="${key}" aria-label="Increase quantity">+</button>
          </div>
          <button type="button" class="text-btn" data-remove="${key}">Remove</button>
        </div>
        <p class="price">${money(product.price * line.qty)}</p>
      </article>`;
  }

  function totalsHtml(cart) {
    const figures = totals(cart);
    return `
      <div class="totals">
        <div><span>Subtotal</span><span>${money(figures.sub)}</span></div>
        <div><span>Shipping</span><span>${figures.transit ? money(figures.transit) : money(0)}</span></div>
        <div class="grand"><span>Total</span><span>${money(figures.total)}</span></div>
      </div>
      <p class="quiet">Shipping is GH₵25 across Ghana.</p>`;
  }

  function renderBag() {
    const cart = readCart();
    const body = document.getElementById("bag-body");
    const foot = document.getElementById("bag-foot");
    const count = cart.reduce((sum, line) => sum + line.qty, 0);
    updateCount(count);
    if (!cart.length) {
      body.innerHTML = `<div class="empty-bag"><p>Your cart is empty.</p><a class="btn" href="shop.html">Continue shopping</a></div>`;
      foot.hidden = true;
      foot.innerHTML = "";
      return;
    }
    foot.hidden = false;
    body.innerHTML = cart.map(lineHtml).join("");
    foot.innerHTML = `${totalsHtml(cart)}<a class="btn btn-full" href="checkout.html">Checkout</a>`;
  }

  function setBag(open) {
    const drawer = document.getElementById("bag");
    const backdrop = document.querySelector(".backdrop");
    drawer.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-open", open);
    backdrop.hidden = !open;
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    drawer.toggleAttribute("inert", !open);
    document.body.classList.toggle("bag-open", open);
    if (open) {
      lastFocus = document.activeElement;
      const close = drawer.querySelector("[data-close-bag]");
      if (close) close.focus();
    } else if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    }
  }

  function addToCart(id, qty) {
    const cart = readCart();
    const found = cart.find((line) => line.id === id);
    if (found) found.qty = Math.min(12, found.qty + qty);
    else cart.push({ id, qty: clampQty(qty) });
    writeCart(cart);
    renderBag();
    if (document.body.dataset.page === "checkout") syncCheckout();
  }

  function changeQty(key, delta) {
    const cart = readCart();
    const index = cart.findIndex((line) => keyOf(line.id) === key);
    if (index < 0) return;
    cart[index].qty += delta;
    if (cart[index].qty < 1) cart.splice(index, 1);
    else cart[index].qty = Math.min(12, cart[index].qty);
    writeCart(cart);
    renderBag();
    if (document.body.dataset.page === "checkout") syncCheckout();
  }

  function productCard(product) {
    const href = `product.html?id=${encodeURIComponent(product.id)}`;
    const image = product.gallery[0];
    return `
      <article class="card" style="--accent:${product.accent}">
        <a class="card-media" href="${href}">
          <img src="${image.src}" alt="${escapeHtml(image.alt)}" style="object-position:${image.focus || "center"}" loading="lazy">
          ${product.badge ? `<span class="pill">${escapeHtml(product.badge)}</span>` : ""}
        </a>
        <div class="card-body">
          <h3><a href="${href}">${escapeHtml(product.name)}</a></h3>
          <p class="format">${escapeHtml(product.format)}</p>
          <p class="stars" aria-label="${product.rating} out of 5 stars">★★★★★ <span>${product.rating} (${product.reviews})</span></p>
          <p class="price">${money(product.price)}</p>
          <button class="btn" type="button" data-add="${product.id}">Add to cart</button>
        </div>
      </article>`;
  }

  function renderHome() {
    const grid = document.getElementById("home-grid");
    if (!grid) return;
    grid.innerHTML = window.EV.products.slice(0, 12).map(productCard).join("");
  }

  function visibleProducts() {
    const mode = document.getElementById("sort") ? document.getElementById("sort").value : "featured";
    let list = window.EV.products.filter((product) => {
      if (filter !== "All" && product.variety !== filter) return false;
      if (!query) return true;
      const hay = (product.name + " " + product.format + " " + product.variety).toLowerCase();
      return hay.includes(query.toLowerCase());
    });
    if (mode === "price-asc") list = [...list].sort((a, b) => a.price - b.price);
    if (mode === "price-desc") list = [...list].sort((a, b) => b.price - a.price);
    return list;
  }

  function renderShop() {
    const chips = document.getElementById("chips");
    const grid = document.getElementById("shop-grid");
    const count = document.getElementById("shop-count");
    if (!chips || !grid) return;
    chips.innerHTML = FILTERS.map((name) => `
      <button type="button" class="chip${name === filter ? " is-active" : ""}" data-filter="${name}">${name}</button>
    `).join("");
    const list = visibleProducts();
    count.textContent = list.length === 1 ? "1 product" : `${list.length} products`;
    grid.innerHTML = list.length
      ? list.map(productCard).join("")
      : `<p class="quiet">Nothing in this selection.</p>`;
  }

  function renderProduct() {
    const root = document.getElementById("product-root");
    if (!root) return;
    const id = new URLSearchParams(location.search).get("id");
    const product = productById(id);
    if (!product) {
      document.title = "Product — Tims Food";
      root.innerHTML = `
        <div class="page-hero">
          <p class="crumb"><a href="shop.html">Products</a></p>
          <h1>Product not found.</h1>
          <p class="lede">This item is no longer available.</p>
          <a class="btn" href="shop.html">Back to shop</a>
        </div>`;
      return;
    }
    document.title = `${product.name} — Tims Food`;
    const main = product.gallery[0];
    const related = window.EV.products
      .filter((item) => item.id !== product.id && (item.variety === product.variety || item.category === product.category))
      .concat(window.EV.products.filter((item) => item.id !== product.id && item.variety !== product.variety))
      .filter((item, index, array) => array.findIndex((other) => other.id === item.id) === index)
      .slice(0, 3);

    root.innerHTML = `
      <p class="crumb"><a href="index.html">Home</a> / <a href="shop.html">Shop</a> / ${escapeHtml(product.name)}</p>
      <article class="product">
        <div class="gallery">
          <img class="gallery-main" data-main-image src="${main.src}" alt="${escapeHtml(main.alt)}">
        </div>
        <div class="buy">
          <p class="kicker">${escapeHtml(product.origin)}</p>
          <h1>${escapeHtml(product.name)}</h1>
          <p class="epithet">${escapeHtml(product.epithet)}</p>
          <p class="stars" aria-label="${product.rating} out of 5 stars">★★★★★ <span>${product.rating} (${product.reviews} reviews)</span></p>
          <p class="price">${money(product.price)}</p>
          <p class="format">${escapeHtml(product.format)} · ${escapeHtml(product.weight)}</p>
          <div class="buy-row">
            <div class="qty">
              <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
              <input data-qty-input value="1" inputmode="numeric" aria-label="Quantity">
              <button type="button" data-step="1" aria-label="Increase quantity">+</button>
            </div>
            <button class="btn" type="button" data-add="${product.id}" data-configured="true">Add to cart</button>
          </div>
          <p class="quiet">In stock. Shipping is GH₵25. This preview does not charge your card.</p>
        </div>
      </article>
      <section class="detail-grid" aria-label="About this product">
        <article>
          <h2>About</h2>
          <p>${escapeHtml(product.palate)}</p>
        </article>
        <article>
          <h2>How to use</h2>
          <p>${escapeHtml(product.table)}</p>
        </article>
        <article>
          <h2>Sourcing</h2>
          <p>${escapeHtml(product.harvest)}</p>
        </article>
      </section>
      <dl class="specs">
        <div><dt>Pack</dt><dd>${escapeHtml(product.format)}</dd></div>
        <div><dt>Origin</dt><dd>${escapeHtml(product.origin)}</dd></div>
        <div><dt>Availability</dt><dd>${escapeHtml(product.season)}</dd></div>
        <div><dt>Ships</dt><dd>From Accra</dd></div>
      </dl>
      <section class="section related">
        <div class="section-head">
          <div>
            <h2>Related products</h2>
          </div>
          <a class="text-link" href="shop.html">See all</a>
        </div>
        <div class="product-grid">${related.map(productCard).join("")}</div>
      </section>`;
  }

  function renderSummary() {
    const summary = document.getElementById("summary");
    if (!summary) return;
    const cart = readCart();
    summary.innerHTML = `
      <h2>Order summary</h2>
      ${cart.map(lineHtml).join("")}
      ${totalsHtml(cart)}`;
  }

  function syncCheckout() {
    const empty = document.getElementById("checkout-empty");
    const live = document.getElementById("checkout-live");
    if (!empty || !live) return;
    const cart = readCart();
    const isEmpty = cart.length === 0;
    empty.hidden = !isEmpty;
    live.hidden = isEmpty;
    if (!isEmpty) renderSummary();
  }

  function showConfirm(order) {
    writeCart([]);
    renderBag();
    document.getElementById("checkout-view").hidden = true;
    const view = document.getElementById("confirm-view");
    const lines = order.cart.map((line) => {
      const product = productById(line.id);
      return `<li><span>${escapeHtml(product.name)} · ${escapeHtml(product.format)} × ${line.qty}</span><span>${money(product.price * line.qty)}</span></li>`;
    }).join("");
    view.hidden = false;
    view.innerHTML = `
      <p class="eyebrow">Order ${escapeHtml(order.ref)}</p>
      <h1>Thanks, ${escapeHtml(order.data.name)}.</h1>
      <p class="lede">Your order is confirmed for ${escapeHtml(order.data.city)}. This preview does not charge or ship.</p>
      <ul class="confirm-lines">${lines}</ul>
      <p class="confirm-total"><span>Total</span><span>${money(order.totals.total)}</span></p>
      <p class="quiet">Nothing has been charged, and nothing will ship.</p>
      <a class="btn" href="shop.html">Continue shopping</a>`;
    window.scrollTo(0, 0);
  }

  function bindCheckout() {
    const form = document.getElementById("checkout-form");
    if (!form) return;
    syncCheckout();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const cart = readCart();
      if (!cart.length) {
        syncCheckout();
        return;
      }
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      button.textContent = "Placing order…";
      const data = Object.fromEntries(new FormData(form).entries());
      const year = new Date().getFullYear().toString().slice(2);
      const order = {
        ref: `TF-${year}-${Math.floor(1000 + Math.random() * 9000)}`,
        data,
        cart,
        totals: totals(cart)
      };
      window.setTimeout(() => showConfirm(order), 450);
    });
  }

  function setMenu(open) {
    const menu = document.getElementById("primary-nav");
    const toggle = document.querySelector(".nav-toggle");
    if (!menu || !toggle) return;
    menu.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const label = toggle.querySelector(".nav-toggle-label");
    if (label) label.textContent = open ? "Close" : "Menu";
  }

  function initPage() {
    const page = document.body.dataset.page;
    if (page === "home") renderHome();
    if (page === "shop") {
      const params = new URLSearchParams(location.search);
      const requested = params.get("variety");
      query = params.get("q") || "";
      if (requested && FILTERS.includes(requested)) filter = requested;
      const search = document.querySelector("[data-search]");
      if (search) search.value = query;
      renderShop();
      document.getElementById("sort").addEventListener("change", renderShop);
    }
    if (page === "product") renderProduct();
    if (page === "checkout") bindCheckout();
  }

  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === document.body.dataset.page) link.setAttribute("aria-current", "page");
  });

  const announcement = document.getElementById("announcement");
  try {
    if (sessionStorage.getItem("ev-announce") === "hide" && announcement) announcement.remove();
  } catch (error) {
    /* Session storage is optional. */
  }

  mountChrome();
  renderBag();
  initPage();

  document.querySelector("[data-dismiss-announce]")?.addEventListener("click", () => {
    try { sessionStorage.setItem("ev-announce", "hide"); } catch (error) { /* ignore */ }
    announcement?.remove();
  });

  document.querySelector(".nav-toggle")?.addEventListener("click", () => {
    const menu = document.getElementById("primary-nav");
    setMenu(!menu.classList.contains("is-open"));
  });

  document.getElementById("primary-nav")?.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });

  document.getElementById("letter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = event.currentTarget.querySelector("[data-letter-note]");
    if (note) note.textContent = "Noted. Nothing is sent from this preview.";
    event.currentTarget.reset();
  });

  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-bag]");
    if (open) {
      setBag(true);
      return;
    }
    if (event.target.closest("[data-close-bag]")) {
      setBag(false);
      return;
    }

    const chip = event.target.closest("[data-filter]");
    if (chip && document.body.dataset.page === "shop") {
      filter = chip.dataset.filter;
      const url = filter === "All" ? "shop.html" : `shop.html?variety=${encodeURIComponent(filter)}`;
      history.replaceState(null, "", url);
      renderShop();
      return;
    }

    const add = event.target.closest("[data-add]");
    if (add) {
      const id = add.dataset.add;
      let qty = 1;
      if (add.dataset.configured === "true") {
        const input = document.querySelector("[data-qty-input]");
        qty = clampQty(input ? input.value : 1);
      }
      addToCart(id, qty);
      const product = productById(id);
      toast(`${product.name} added to cart.`);
      return;
    }

    const step = event.target.closest("[data-step]");
    if (step) {
      const input = document.querySelector("[data-qty-input]");
      if (input) input.value = String(clampQty(Number(input.value) + Number(step.dataset.step)));
      return;
    }

    const lineStep = event.target.closest("[data-line-step]");
    if (lineStep) {
      changeQty(lineStep.dataset.key, Number(lineStep.dataset.lineStep));
      return;
    }

    const remove = event.target.closest("[data-remove]");
    if (remove) {
      const cart = readCart().filter((line) => keyOf(line.id) !== remove.dataset.remove);
      writeCart(cart);
      renderBag();
      if (document.body.dataset.page === "checkout") syncCheckout();
      return;
    }

    const thumb = event.target.closest("[data-thumb]");
    if (thumb) {
      const image = document.querySelector("[data-main-image]");
      if (!image) return;
      image.src = thumb.dataset.thumb;
      image.alt = thumb.dataset.alt || "";
      image.style.objectPosition = thumb.dataset.focus || "center";
      document.querySelectorAll("[data-thumb]").forEach((button) => {
        button.classList.toggle("is-active", button === thumb);
      });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const drawer = document.getElementById("bag");
      if (drawer.classList.contains("is-open")) setBag(false);
      else setMenu(false);
      return;
    }
    if (event.key !== "Tab") return;
    const drawer = document.getElementById("bag");
    if (!drawer.classList.contains("is-open")) return;
    const items = [...drawer.querySelectorAll("a, button, input, select, textarea")].filter((el) => !el.disabled && !el.closest("[hidden]"));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
})();
