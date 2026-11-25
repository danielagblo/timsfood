(function () {
  const page = document.body.dataset.page;
  if (page !== "login" && page !== "account") return;

  const money = (value) => new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    maximumFractionDigits: 0
  }).format(value);

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function message(el, text) {
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  }

  if (page === "login") {
    const forms = {
      signin: document.getElementById("signin-form"),
      register: document.getElementById("register-form")
    };
    const tabs = document.querySelectorAll("[data-auth-mode]");
    const errorEl = document.querySelector("[data-auth-error]");

    function setMode(mode) {
      Object.entries(forms).forEach(([name, form]) => {
        if (form) form.hidden = name !== mode;
      });
      tabs.forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.authMode === mode);
        tab.setAttribute("aria-pressed", String(tab.dataset.authMode === mode));
      });
      message(errorEl, "");
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => setMode(tab.dataset.authMode));
    });

    async function submit(form, endpoint) {
      if (!form || !form.reportValidity()) return;
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      message(errorEl, "");
      try {
        await window.TF.request(endpoint, {
          method: "POST",
          body: Object.fromEntries(new FormData(form).entries())
        });
        window.location.href = "account.html";
      } catch (error) {
        message(errorEl, error.message);
        button.disabled = false;
      }
    }

    forms.signin?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(forms.signin, "/api/auth/login");
    });
    forms.register?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(forms.register, "/api/auth/register");
    });
  }

  if (page === "account") {
    const loading = document.getElementById("account-loading");
    const signedOut = document.getElementById("account-signed-out");
    const content = document.getElementById("account-content");
    const list = document.getElementById("order-list");

    function orderCard(order) {
      const lines = order.items.map((item) => `
        <li><span>${escapeHtml(item.name)} · ×${item.qty}</span><span>${money(item.price * item.qty)}</span></li>
      `).join("");
      return `
        <article class="order-card">
          <header>
            <div>
              <p class="checkout-kicker">${escapeHtml(order.createdAt)}</p>
              <h3>${escapeHtml(order.ref)}</h3>
            </div>
            <span class="order-status">${escapeHtml(order.status)}</span>
          </header>
          <ul class="confirm-lines">${lines}</ul>
          <p class="confirm-total"><span>Total</span><span>${money(order.totals.total)}</span></p>
          <p class="quiet">${escapeHtml(order.data.city)} · ${escapeHtml(order.data.address)}</p>
        </article>`;
    }

    window.TF.getMe().then(async (user) => {
      if (loading) loading.hidden = true;
      if (!user) {
        if (signedOut) signedOut.hidden = false;
        return;
      }
      if (content) content.hidden = false;
      const nameEl = document.getElementById("account-name");
      const emailEl = document.getElementById("account-email");
      if (nameEl) nameEl.textContent = user.name;
      if (emailEl) emailEl.textContent = user.email;

      try {
        const data = await window.TF.request("/api/orders");
        if (list) {
          list.innerHTML = data.orders.length
            ? data.orders.map(orderCard).join("")
            : `<p class="quiet">No orders yet. <a class="text-link" href="shop.html">Shop the range →</a></p>`;
        }
      } catch (error) {
        if (list) list.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
      }
    });

    document.getElementById("logout-btn")?.addEventListener("click", async () => {
      try {
        await window.TF.request("/api/auth/logout", { method: "POST" });
      } catch (_) {
        /* Still leave the page. */
      }
      window.location.href = "index.html";
    });
  }
})();
