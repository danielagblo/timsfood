(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const loading = $("#admin-loading");
  const denied = $("#admin-denied");
  const content = $("#admin-content");
  const errorBox = $("[data-admin-error]");
  const dialog = $("#product-dialog");
  const productForm = $("#product-form");
  const imageForm = $("#image-form");
  let me = null;
  let editingId = null;
  let products = [];

  const money = (amount) => `GH₵${Number(amount || 0).toLocaleString("en-GH")}`;
  const when = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-GB");
  };

  function showError(message) {
    errorBox.textContent = message || "";
  }

  function cell(value) {
    const td = document.createElement("td");
    td.textContent = value == null || value === "" ? "—" : String(value);
    return td;
  }

  function table(headers, rows) {
    const wrap = document.createElement("div");
    wrap.className = "admin-table-scroll";
    const el = document.createElement("table");
    el.className = "admin-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    rows.forEach((row) => tbody.appendChild(row));
    el.append(thead, tbody);
    wrap.appendChild(el);
    return wrap;
  }

  function empty(message) {
    const p = document.createElement("p");
    p.className = "quiet";
    p.textContent = message;
    return p;
  }

  async function loadOverview() {
    const { summary, recentOrders } = await TF.request("/api/admin/summary");
    const stats = [
      ["Active products", summary.activeProducts],
      ["Total orders", summary.orders],
      ["Sales", money(summary.revenue)],
      ["Customers", summary.users],
      ["Images in DB", summary.images]
    ];
    $("#stat-grid").replaceChildren(...stats.map(([label, value]) => {
      const card = document.createElement("div");
      card.className = "stat-card";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const small = document.createElement("span");
      small.textContent = label;
      card.append(strong, small);
      return card;
    }));

    const target = $("#recent-orders");
    if (!recentOrders.length) {
      target.replaceChildren(empty("No orders yet."));
      return;
    }
    target.replaceChildren(table(["Reference", "Customer", "Total", "Status", "Placed"], recentOrders.map((order) => {
      const row = document.createElement("tr");
      [order.ref, order.name, money(order.total), order.status, when(order.createdAt)]
        .forEach((value) => row.appendChild(cell(value)));
      return row;
    })));
  }

  async function loadProducts() {
    const data = await TF.request("/api/admin/products");
    products = data.products;
    const target = $("#product-table");
    if (!products.length) {
      target.replaceChildren(empty("No products yet. Add one to get started."));
      return;
    }
    target.replaceChildren(table(
      ["Product", "ID", "Variety", "Price", "Images", "Status", "Actions"],
      products.map((product) => {
        const row = document.createElement("tr");
        [product.name, product.id, product.variety, money(product.price),
          (product.gallery || []).length, product.active === false ? "Hidden" : "Live"]
          .forEach((value) => row.appendChild(cell(value)));

        const actions = document.createElement("td");
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-btn";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openProduct(product));
        actions.appendChild(edit);
        row.appendChild(actions);
        return row;
      })
    ));
  }

  async function loadOrders() {
    const { orders } = await TF.request("/api/admin/orders");
    const target = $("#order-table");
    if (!orders.length) {
      target.replaceChildren(empty("No orders yet."));
      return;
    }
    target.replaceChildren(table(
      ["Reference", "Customer", "Items", "Total", "Status", "Placed", "Account"],
      orders.map((order) => {
        const row = document.createElement("tr");
        [order.ref, order.data.name, order.items.reduce((sum, item) => sum + item.qty, 0),
          money(order.totals.total)]
          .forEach((value) => row.appendChild(cell(value)));

        const statusCell = document.createElement("td");
        const select = document.createElement("select");
        ["pending", "packed", "shipped", "delivered", "cancelled"].forEach((status) => {
          const option = document.createElement("option");
          option.value = status;
          option.textContent = status;
          option.selected = status === order.status;
          select.appendChild(option);
        });
        select.addEventListener("change", async () => {
          try {
            await TF.request(`/api/admin/orders/${encodeURIComponent(order.ref)}`, {
              method: "PATCH",
              body: { status: select.value }
            });
            showError("");
          } catch (error) {
            showError(error.message);
            loadOrders();
          }
        });
        statusCell.appendChild(select);
        row.appendChild(statusCell);
        row.appendChild(cell(when(order.createdAt)));
        row.appendChild(cell(order.userEmail || "Guest"));
        return row;
      })
    ));
  }

  async function loadUsers() {
    const { users } = await TF.request("/api/admin/users");
    const target = $("#user-table");
    if (!users.length) {
      target.replaceChildren(empty("No accounts yet."));
      return;
    }
    target.replaceChildren(table(
      ["Name", "Email", "City", "Orders", "Role", "Joined"],
      users.map((user) => {
        const row = document.createElement("tr");
        [user.name, user.email, user.city, user.orders, user.isAdmin ? "Admin" : "Customer", when(user.createdAt)]
          .forEach((value) => row.appendChild(cell(value)));
        return row;
      })
    ));
  }

  async function loadImages() {
    const { images } = await TF.request("/api/admin/images");
    const target = $("#image-grid");
    if (!images.length) {
      target.replaceChildren(empty("No images in the database yet."));
      return;
    }
    target.replaceChildren(...images.map((image) => {
      const card = document.createElement("figure");
      card.className = "admin-image-card";
      const img = document.createElement("img");
      img.src = image.src;
      img.alt = image.filename || `Image ${image.id}`;
      img.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = `${image.filename || `#${image.id}`} · ${(image.size / 1024).toFixed(0)} KB`;
      card.append(img, caption);
      return card;
    }));
  }

  const panels = {
    overview: loadOverview,
    products: loadProducts,
    orders: loadOrders,
    customers: loadUsers,
    images: loadImages
  };

  async function showPanel(name) {
    document.querySelectorAll("[data-tab]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    });
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    try {
      showError("");
      await panels[name]();
    } catch (error) {
      showError(error.message);
    }
  }

  function setField(name, value) {
    const field = productForm.elements.namedItem(name);
    if (!field) return;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value == null ? "" : String(value);
  }

  function openProduct(product) {
    editingId = product ? product.id : null;
    productForm.reset();
    $("#product-dialog-title").textContent = product ? `Edit ${product.name}` : "Add product";
    $("#delete-product").hidden = !product;
    const idField = productForm.elements.namedItem("id");
    idField.disabled = Boolean(product);
    const values = product || {
      active: true, price: 0, rating: 0, reviews: 0, sort_order: 999
    };
    ["id", "name", "format", "epithet", "variety", "category", "badge", "origin",
      "season", "weight", "price", "rating", "reviews", "sort_order", "active",
      "palate", "table", "harvest"].forEach((name) => setField(name, values[name]));
    imageForm.hidden = !product;
    $("[data-product-error]").textContent = "";
    dialog.showModal();
  }

  function formData() {
    const out = {};
    for (const field of productForm.elements) {
      if (!field.name || field.disabled) continue;
      out[field.name] = field.type === "checkbox" ? field.checked : field.value;
    }
    return out;
  }

  productForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("[data-product-error]");
    try {
      const body = formData();
      if (editingId) {
        await TF.request(`/api/admin/products/${encodeURIComponent(editingId)}`, {
          method: "PUT", body
        });
      } else {
        await TF.request("/api/admin/products", { method: "POST", body });
      }
      dialog.close();
      await loadProducts();
      showError("");
    } catch (err) {
      error.textContent = err.message;
    }
  });

  $("#delete-product").addEventListener("click", async () => {
    if (!editingId || !window.confirm(`Delete ${editingId}? Orders already placed are kept.`)) return;
    try {
      await TF.request(`/api/admin/products/${encodeURIComponent(editingId)}`, { method: "DELETE" });
      dialog.close();
      await loadProducts();
    } catch (err) {
      $("[data-product-error]").textContent = err.message;
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });

  $("#add-product").addEventListener("click", () => openProduct(null));

  imageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editingId) return;
    const file = imageForm.elements.namedItem("file").files[0];
    if (!file) return;
    const error = $("[data-product-error]");
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
      await TF.request(`/api/admin/products/${encodeURIComponent(editingId)}/image`, {
        method: "POST",
        body: { data, mime: file.type, filename: file.name, alt: editingId }
      });
      imageForm.reset();
      error.textContent = "";
      await loadProducts();
    } catch (err) {
      error.textContent = err.message;
    }
  });

  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => showPanel(tab.dataset.tab));
  });

  $("#admin-logout").addEventListener("click", async () => {
    await TF.request("/api/auth/logout", { method: "POST" });
    location.href = "login.html";
  });

  async function init() {
    me = await TF.getMe();
    loading.hidden = true;
    if (!me || !me.isAdmin) {
      denied.hidden = false;
      return;
    }
    content.hidden = false;
    $("#admin-who").textContent = `Signed in as ${me.name} (${me.email})`;
    await showPanel("overview");
  }

  init();
})();
