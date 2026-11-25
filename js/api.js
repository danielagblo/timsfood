(function () {
  async function request(path, options = {}) {
    const opts = {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.headers || {}) }
    };
    if (opts.body != null && typeof opts.body !== "string") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }

    const response = await fetch(path, opts);
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* Empty or non-JSON response. */
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  }

  async function loadProducts() {
    try {
      const data = await request("/api/products");
      if (Array.isArray(data.products) && data.products.length) {
        window.EV.products = data.products;
      }
    } catch (_) {
      /* Keep the catalog.js copy when the API is unavailable. */
    }
  }

  async function getMe() {
    try {
      return (await request("/api/me")).user || null;
    } catch (_) {
      return null;
    }
  }

  window.TF = { request, loadProducts, getMe };
})();
