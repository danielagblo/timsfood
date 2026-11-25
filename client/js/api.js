(function () {
  function apiBase() {
    return String(window.TF_API_BASE || "").replace(/\/$/, "");
  }

  /** Turn an API image path into a full URL when the backend is on another origin. */
  function imageSrc(src) {
    const base = apiBase();
    return base && String(src || "").startsWith("/api/") ? base + src : src;
  }

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
    if (apiBase()) opts.credentials = "include";

    const response = await fetch(apiBase() + path, opts);
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
        window.EV.products = data.products.map((product) => ({
          ...product,
          gallery: (product.gallery || []).map((entry) => ({
            ...entry,
            src: imageSrc(entry.src)
          }))
        }));
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

  window.TF = { request, loadProducts, getMe, imageSrc };
})();
