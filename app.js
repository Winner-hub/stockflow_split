/* StockFlow frontend - plain JavaScript, no build step. Talks to the backend JSON API. */
(function () {
  "use strict";
  var API = (window.STOCKFLOW_API || "").replace(/\/+$/, "");
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };
  var n2 = function (x) { return Number(x || 0).toFixed(2); };
  var sign = function (x) { return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x); };
  var when = function (s) {            // server stores UTC "YYYY-MM-DD HH:MM:SS"
    if (!s) return "";
    var d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? esc(s) : esc(d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var token = store.get("sf_token"), me = null, notice = null, seq = 0, deferredInstall = null;

  // ---------- API ----------
  function qs(o) {
    var p = Object.keys(o || {}).filter(function (k) { return o[k] !== "" && o[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&");
    return p ? "?" + p : "";
  }
  async function api(path, opt) {
    opt = opt || {};
    var headers = {}, body;
    if (token) headers.Authorization = "Bearer " + token;
    if (opt.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opt.body); }
    var r;
    try { r = await fetch(API + path, { method: opt.method || "GET", headers: headers, body: body }); }
    catch (e) { throw new Error("Cannot reach the server. Check your connection, or wait a moment and try again."); }
    if (r.ok && opt.blob) return r.blob();
    var d = {};
    try { d = await r.json(); } catch (e) {}
    if (r.status === 401 && token && path !== "/api/login") {
      token = null; me = null; store.del("sf_token");
      notice = { m: "Your session ended. Please sign in again." };
      location.hash = "#/login"; route();
      throw new Error("");
    }
    if (!r.ok) throw new Error(d.error || ("Server error " + r.status));
    return d;
  }
  async function download(path, name) {
    try {
      var b = await api(path, { blob: true }), a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { if (e.message) msg(e.message); }
  }

  // ---------- UI helpers ----------
  function msg(text, ok) {
    var old = $("#msg"); if (old) old.remove();
    var d = document.createElement("div");
    d.id = "msg"; d.className = "flash" + (ok ? " ok" : ""); d.textContent = text;
    $("#main").prepend(d); window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function go(hash, text, ok) { if (text) notice = { m: text, ok: ok }; if (location.hash === hash) route(); else location.hash = hash; }
  function bind(sel, ev, fn) { $$(sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(e, el); }); }); }
  // form submit helper: collects fields, disables button, shows errors
  function onSubmit(sel, fn) {
    bind(sel, "submit", async function (e, f) {
      e.preventDefault();
      var btn = $("button:not([type=button])", f), data = {};
      new FormData(f).forEach(function (v, k) { data[k] = v; });
      $$("input[type=checkbox]", f).forEach(function (c) { data[c.name] = c.checked; });
      if (btn) btn.disabled = true;
      try { await fn(data, f); } catch (err) { if (err.message) msg(err.message); }
      if (btn) btn.disabled = false;
    });
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, "") || "/", i = h.indexOf("?"), path = i < 0 ? h : h.slice(0, i), q = {};
    if (i >= 0) new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) { q[k] = v; });
    return { path: path, q: q };
  }
  // filter forms navigate to  #/page?field=value
  function filterForm(sel, page) {
    bind(sel, "submit", function (e, f) {
      e.preventDefault(); var o = {}; new FormData(f).forEach(function (v, k) { o[k] = v; });
      location.hash = "#" + page + qs(o);
      if (location.hash === "#" + page + qs(o)) route();
    });
  }
  var isAdmin = function () { return me && me.role === "admin"; };

  // ---------- chrome: nav + launcher ----------
  function drawChrome(path) {
    var nav = $("#nav"), shell = $("#shell");
    if (!me) { nav.innerHTML = '<a class="brand" href="#/"><img src="icon.svg" alt="">StockFlow</a>'; shell.innerHTML = ""; return; }
    var link = function (h, t) { return '<a href="#' + h + '"' + (path === h ? ' class="on"' : "") + ">" + t + "</a>"; };
    nav.innerHTML = '<a class="brand" href="#/"><img src="icon.svg" alt="">StockFlow</a>' +
      link("/", "Dashboard") + link("/products", "Products") + link("/stock-flow", "Stock Flow") + link("/sales", "Sales") + link("/sales/new", "+ New Sale") +
      (isAdmin() ? link("/admin", "Admin") : "") +
      '<span class="sp"></span><span class="mut">' + esc(me.username) + ' <span class="badge ' + esc(me.role) + '">' + esc(me.role) + "</span></span>" +
      link("/password", "Password") + '<button class="lnk" id="logout">Log out</button>';
    $("#logout").onclick = function () { logout(); };
    if (!$("#fab")) {
      shell.innerHTML = '<button id="fab" aria-label="Open StockFlow launcher" title="StockFlow – quick launcher"><img src="icon.svg" alt=""></button>' +
        '<div id="launcher" role="menu"><h4>StockFlow services</h4><div class="tiles">' +
        '<a class="tile main" href="#/sales/new"><span>🛒</span>New Sale</a>' +
        '<a class="tile" href="#/"><span>📊</span>Dashboard</a><a class="tile" href="#/products"><span>📦</span>Products</a><a class="tile" href="#/stock-flow"><span>🔁</span>Stock Flow</a>' +
        '<a class="tile" href="#/sales"><span>🧾</span>Sales</a><button class="tile" id="exp"><span>⬇️</span>Export</button>' +
        '<a class="tile" id="lastTile" href="#/password"><span>🔑</span>Password</a></div>' +
        '<button class="btn install" hidden>⬇ Install StockFlow app</button></div>';
      var pan = $("#launcher");
      $("#fab").onclick = function (e) { e.stopPropagation(); pan.classList.toggle("open"); };
      pan.addEventListener("click", function () { pan.classList.remove("open"); });
      $("#exp").onclick = function () { download("/api/export/products.csv", "products.csv"); };
      bindInstall();
    }
    $("#lastTile").outerHTML = isAdmin() ? '<a class="tile" id="lastTile" href="#/admin"><span>🛠️</span>Admin</a>' : '<a class="tile" id="lastTile" href="#/password"><span>🔑</span>Password</a>';
  }
  document.addEventListener("click", function (e) { var p = $("#launcher"); if (p && !p.contains(e.target)) p.classList.remove("open"); });
  document.addEventListener("keydown", function (e) { var p = $("#launcher"); if (e.key === "Escape" && p) p.classList.remove("open"); });
  function bindInstall() {
    $$(".install").forEach(function (b) {
      b.hidden = !deferredInstall;
      b.onclick = function () { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $$(".install").forEach(function (x) { x.hidden = true; }); } };
    });
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; bindInstall(); });
  window.addEventListener("appinstalled", function () { deferredInstall = null; bindInstall(); });

  function logout() { token = null; me = null; store.del("sf_token"); location.hash = "#/login"; route(); }

  // ---------- views (each returns [html, afterRenderFn]) ----------
  async function vLogin() {
    var html = '<div class="login-wrap"><img class="bgcard" src="bg-wide.jpg" alt="Clement Shaddai &amp; Co. business card">' +
      '<div class="card login"><div class="hero"><img src="icon.svg" alt="StockFlow"><h2 style="margin:12px 0 0">StockFlow</h2><p class="mut">Sign in to continue</p></div>' +
      '<form id="f"><label>Username</label><input name="username" required autofocus autocomplete="username">' +
      '<label>Password</label><input name="password" type="password" required autocomplete="current-password">' +
      '<p><button class="btn" style="width:100%">Sign in</button></p></form>' +
      '<button class="btn alt install" hidden>⬇ Install StockFlow app</button></div></div>';
    return [html, function () {
      onSubmit("#f", async function (d) {
        var r = await api("/api/login", { method: "POST", body: d });
        token = r.token; me = r.user; store.set("sf_token", token);
        go("#/");
      });
    }];
  }
  async function vDash() {
    var d = await api("/api/dashboard"), s = d.stats;
    var html = '<div class="grid">' +
      '<div class="card"><div class="mut">Revenue</div><div class="stat">' + n2(s.rev) + "</div></div>" +
      (isAdmin() ? '<div class="card"><div class="mut">Profit</div><div class="stat">' + n2(s.profit) + "</div></div>" : "") +
      '<div class="card"><div class="mut">Sales</div><div class="stat">' + s.sales + "</div></div>" +
      '<div class="card"><div class="mut">Stock value (cost)</div><div class="stat">' + n2(s.value) + "</div></div></div>" +
      '<div class="card"><h3>Low stock</h3>' + (d.low.length ?
        "<table><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Reorder at</th></tr>" + d.low.map(function (p) {
          return "<tr><td>" + esc(p.sku) + "</td><td>" + esc(p.name) + '</td><td class="red">' + p.qty + "</td><td>" + p.reorder + "</td></tr>";
        }).join("") + "</table>" : '<span class="mut">All stocked up.</span>') + "</div>" +
      '<div class="grid"><div class="card"><h3>Top sellers</h3><table>' + (d.top.length ? d.top.map(function (t) {
        return "<tr><td>" + esc(t.name) + "</td><td>" + t.n + " sold</td><td>" + n2(t.rev) + "</td></tr>";
      }).join("") : '<tr><td class="mut">No sales yet</td></tr>') + "</table></div>" +
      '<div class="card"><h3>Recent sales</h3><table>' + (d.recent.length ? d.recent.map(function (x) {
        return '<tr><td><a href="#/sales/' + x.id + '">#' + x.id + "</a></td><td>" + esc(x.customer) + "</td><td>" + n2(x.total) + "</td></tr>";
      }).join("") : '<tr><td class="mut">None yet</td></tr>') + "</table></div></div>";
    return [html];
  }

  async function vProducts(_, q) {
    var d = await api("/api/products" + qs({ q: q.q })), adm = isAdmin();
    var html = '<div class="row" style="margin-bottom:12px"><form id="sf"><input name="q" value="' + esc(q.q) + '" placeholder="Search name or SKU"> <button class="btn alt">Search</button></form>' +
      '<span><button class="btn alt" id="exp">Export CSV</button> ' + (adm ? '<a class="btn alt" href="#/stock-adjust">Stock count</a> <a class="btn" href="#/products/new">+ Add product</a>' : "") + "</span></div>" +
      '<div class="card"><table><tr><th>SKU</th><th>Name</th><th>Cost</th><th>Price</th><th>Qty</th><th>Restock</th><th></th></tr>' +
      (d.products.length ? d.products.map(function (p) {
        return "<tr><td>" + esc(p.sku) + "</td><td>" + esc(p.name) + "</td><td>" + n2(p.cost) + "</td><td>" + n2(p.price) + "</td>" +
          '<td class="' + (p.qty <= p.reorder ? "red" : "") + '">' + p.qty + "</td>" +
          '<td><form class="inline" data-restock="' + p.id + '"><input type="number" name="qty" min="1" placeholder="+qty" required><button class="btn alt">Add</button></form></td>' +
          '<td><a href="#/stock-flow?product=' + p.id + '">History</a>' +
          (adm ? ' · <a href="#/products/' + p.id + '/edit">Edit</a> <button class="btn del sm" data-delp="' + p.id + '" data-name="' + esc(p.name) + '">✕</button>' : "") + "</td></tr>";
      }).join("") : '<tr><td colspan="7" class="mut">No products yet.</td></tr>') + "</table></div>";
    return [html, function () {
      filterForm("#sf", "/products");
      $("#exp").onclick = function () { download("/api/export/products.csv", "products.csv"); };
      bind("[data-restock]", "submit", async function (e, f) {
        e.preventDefault();
        try { await api("/api/products/" + f.dataset.restock + "/restock", { method: "POST", body: { qty: f.qty.value } }); go(location.hash, "Stock added.", true); }
        catch (err) { msg(err.message); }
      });
      bind("[data-delp]", "click", async function (e, b) {
        if (!confirm("Delete " + b.dataset.name + "?")) return;
        try { await api("/api/products/" + b.dataset.delp, { method: "DELETE" }); go(location.hash, "Product deleted.", true); }
        catch (err) { msg(err.message); }
      });
    }];
  }

  async function vProductForm(a) {
    var id = a[0], p = id ? (await api("/api/products/" + id)).product : null;
    var v = function (k, d) { return esc(p ? p[k] : d); };
    var html = '<div class="card" style="max-width:480px"><h3>' + (p ? "Edit" : "New") + " product</h3><form id=\"f\">" +
      '<label>SKU</label><input name="sku" required value="' + v("sku", "") + '">' +
      '<label>Name</label><input name="name" required value="' + v("name", "") + '">' +
      '<label>Cost price</label><input name="cost" type="number" step="0.01" min="0" value="' + v("cost", 0) + '">' +
      '<label>Selling price</label><input name="price" type="number" step="0.01" min="0" value="' + v("price", 0) + '">' +
      '<label>Quantity in stock</label><input name="qty" type="number" min="0" value="' + v("qty", 0) + '">' +
      '<label>Reorder level</label><input name="reorder" type="number" min="0" value="' + v("reorder", 5) + '">' +
      '<p><button class="btn">Save</button> <a class="btn alt" href="#/products">Cancel</a></p></form></div>';
    return [html, function () {
      onSubmit("#f", async function (d) {
        await api(p ? "/api/products/" + id : "/api/products", { method: p ? "PUT" : "POST", body: d });
        go("#/products", "Product saved.", true);
      });
    }];
  }

  async function vSaleNew() {
    var prods = (await api("/api/products")).products.filter(function (p) { return p.qty > 0; });
    var html = '<div class="card"><h3>New sale</h3><form id="f"><label>Customer</label><input name="customer" placeholder="Walk-in">' +
      '<table id="lines" style="margin-top:12px"><tr><th>Product</th><th>Qty</th></tr></table>' +
      '<p><button type="button" class="btn alt" id="add">+ Add item</button></p>' +
      '<p><b>Total: <span id="total">0.00</span></b></p><button class="btn">Complete sale</button></form></div>';
    return [html, function () {
      if (!prods.length) { $("#add").disabled = true; msg("No products are in stock. Add or restock products first."); return; }
      function calc() {
        var s = 0;
        $$("#lines tr.ln").forEach(function (r) { s += prods[r.querySelector("select").selectedIndex].price * (+r.querySelector("input").value || 0); });
        $("#total").textContent = s.toFixed(2);
      }
      function addRow() {
        var r = $("#lines").insertRow(); r.className = "ln";
        r.innerHTML = "<td><select>" + prods.map(function (p) {
          return "<option>" + esc(p.name) + " (" + p.qty + " in stock, " + n2(p.price) + ")</option>";
        }).join("") + '</select></td><td><input type="number" min="1" value="1"> <a href="#" class="rm">✕</a></td>';
        calc();
      }
      $("#add").onclick = addRow;
      $("#lines").addEventListener("input", calc); $("#lines").addEventListener("change", calc);
      $("#lines").addEventListener("click", function (e) { if (e.target.classList.contains("rm")) { e.preventDefault(); e.target.closest("tr").remove(); calc(); } });
      addRow();
      onSubmit("#f", async function (d) {
        var items = $$("#lines tr.ln").map(function (r) {
          return { product_id: prods[r.querySelector("select").selectedIndex].id, qty: r.querySelector("input").value };
        });
        var r = await api("/api/sales", { method: "POST", body: { customer: d.customer, items: items } });
        go("#/sales/" + r.id, "Sale completed.", true);
      });
    }];
  }

  async function vSales(_, q) {
    var d = await api("/api/sales" + qs(q)), adm = isAdmin(), s = d.summary;
    var html = '<div class="row" style="margin-bottom:12px"><h3>Sales record</h3><span><button class="btn alt" id="exp">Export CSV</button> <a class="btn" href="#/sales/new">+ New sale</a></span></div>' +
      '<form class="filters" id="ff"><div><label>From</label><br><input type="date" name="start" value="' + esc(q.start) + '"></div>' +
      '<div><label>To</label><br><input type="date" name="end" value="' + esc(q.end) + '"></div>' +
      '<div><label>Cashier</label><br><select name="cashier"><option value="">All</option>' + d.users.map(function (u) {
        return '<option value="' + u.id + '"' + (q.cashier === String(u.id) ? " selected" : "") + ">" + esc(u.username) + "</option>";
      }).join("") + "</select></div>" +
      '<div><label>Status</label><br><select name="status"><option value="">All</option>' + ["completed", "voided"].map(function (x) {
        return '<option value="' + x + '"' + (q.status === x ? " selected" : "") + ">" + x + "</option>";
      }).join("") + "</select></div>" +
      '<div><label>Customer</label><br><input name="q" value="' + esc(q.q) + '" placeholder="search"></div><button class="btn">Filter</button><a class="btn alt" href="#/sales">Reset</a></form>' +
      '<div class="grid"><div class="card"><div class="mut">Sales</div><div class="stat">' + s.n + '</div></div><div class="card"><div class="mut">Units sold</div><div class="stat">' + s.units + "</div></div>" +
      '<div class="card"><div class="mut">Revenue</div><div class="stat">' + n2(s.rev) + "</div></div>" +
      (adm ? '<div class="card"><div class="mut">Profit</div><div class="stat">' + n2(s.profit) + "</div></div>" : "") + "</div>" +
      '<div class="card"><table><tr><th>#</th><th>Date</th><th>Customer</th><th>Cashier</th><th>Units</th><th>Total</th><th>Status</th>' + (adm ? "<th>Actions</th>" : "") + "</tr>" +
      (d.rows.length ? d.rows.map(function (x) {
        return '<tr><td><a href="#/sales/' + x.id + '">#' + x.id + "</a></td><td>" + when(x.created) + "</td><td>" + esc(x.customer) + "</td><td>" + esc(x.cashier || "—") + "</td><td>" + x.units + "</td><td>" + n2(x.total) + "</td>" +
          "<td>" + (x.status === "voided" ? '<span class="badge voided">voided</span>' : '<span class="mut">ok</span>') + "</td>" +
          (adm ? '<td><button class="btn del sm" data-dels="' + x.id + '">✕ Delete</button></td>' : "") + "</tr>";
      }).join("") : '<tr><td colspan="' + (adm ? 8 : 7) + '" class="mut">No sales match.</td></tr>') + "</table></div>";
    return [html, function () {
      filterForm("#ff", "/sales");
      $("#exp").onclick = function () { download("/api/export/sales.csv", "sales.csv"); };
      bind("[data-dels]", "click", async function (e, b) {
        if (!confirm("Permanently delete sale record #" + b.dataset.dels + "? (Stock is NOT returned – use Void for that.)")) return;
        try { await api("/api/sales/" + b.dataset.dels, { method: "DELETE" }); go(location.hash, "Sale record deleted.", true); }
        catch (err) { msg(err.message); }
      });
    }];
  }

  async function vSale(a) {
    var id = a[0], d = await api("/api/sales/" + id), s = d.sale;
    var html = '<div class="card"><h3>Sale #' + s.id + " " + (s.status === "voided" ? '<span class="badge voided">voided</span>' : "") + "</h3>" +
      '<p class="mut">' + when(s.created) + " · " + esc(s.customer) + " · cashier: " + esc(s.cashier || "—") + "</p>" +
      "<table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr>" + d.items.map(function (i) {
        return "<tr><td>" + esc(i.sku) + "</td><td>" + esc(i.name) + "</td><td>" + i.qty + "</td><td>" + n2(i.price) + "</td><td>" + n2(i.qty * i.price) + "</td></tr>";
      }).join("") + '<tr><th colspan="4">Total</th><th>' + n2(s.total) + "</th></tr></table>" +
      '<p class="noprint"><a class="btn alt" href="#/sales">Back</a> <button class="btn alt" id="pr">Print</button> ' +
      (isAdmin() && s.status !== "voided" ? '<button class="btn del" id="void">Void sale</button>' : "") + "</p></div>";
    return [html, function () {
      $("#pr").onclick = function () { window.print(); };
      var v = $("#void");
      if (v) v.onclick = async function () {
        if (!confirm("Void this sale and return stock?")) return;
        try { var r = await api("/api/sales/" + id + "/void", { method: "POST", body: {} }); go(location.hash, r.message, true); }
        catch (err) { msg(err.message); }
      };
    }];
  }

  async function vFlow(_, q) {
    var qq = { product: q.product, kind: q.kind, start: q.start, end: q.end };
    var r = await Promise.all([api("/api/stock-flow" + qs(qq)), api("/api/products")]), d = r[0], prods = r[1].products, adm = isAdmin();
    var html = '<div class="row" style="margin-bottom:12px"><h3>Stock flow</h3><span>' + (adm ? '<a class="btn alt" href="#/stock-adjust">Stock count / adjust</a> ' : "") + '<button class="btn alt" id="exp">Export CSV</button></span></div>' +
      '<form class="filters" id="ff"><div><label>Product</label><br><select name="product"><option value="">All</option>' + prods.map(function (p) {
        return '<option value="' + p.id + '"' + (q.product === String(p.id) ? " selected" : "") + ">" + esc(p.name) + " (" + esc(p.sku) + ")</option>";
      }).join("") + "</select></div>" +
      '<div><label>Type</label><br><select name="kind"><option value="">All</option>' + d.kinds.map(function (k) {
        return '<option value="' + k + '"' + (q.kind === k ? " selected" : "") + ">" + k + "</option>";
      }).join("") + "</select></div>" +
      '<div><label>From</label><br><input type="date" name="start" value="' + esc(q.start) + '"></div><div><label>To</label><br><input type="date" name="end" value="' + esc(q.end) + '"></div>' +
      '<button class="btn">Filter</button><a class="btn alt" href="#/stock-flow">Reset</a></form>' +
      '<div class="grid"><div class="card"><div class="mut">Units in</div><div class="stat green">+' + d.totals.i + '</div></div><div class="card"><div class="mut">Units out</div><div class="stat red">−' + d.totals.o + "</div></div></div>" +
      '<div class="card"><table><tr><th>When</th><th>Product</th><th>Type</th><th>Change</th><th>Balance</th><th>Reference / note</th><th>By</th>' + (adm ? "<th>Actions</th>" : "") + "</tr>" +
      (d.rows.length ? d.rows.map(function (m) {
        var ref = m.ref && /^Sale #\d+$/.test(m.ref) ? '<a href="#/sales/' + m.ref.slice(6) + '">' + esc(m.ref) + "</a>" : esc(m.ref || "");
        return '<tr><td class="mut">' + when(m.created) + "</td><td>" + esc(m.pname) + ' <span class="mut">' + esc(m.sku) + '</span></td><td><span class="badge">' + esc(m.kind) + "</span></td>" +
          '<td class="' + (m.change > 0 ? "green" : "red") + '">' + sign(m.change) + "</td><td>" + m.qty_after + "</td><td>" + ref + " " + esc(m.note || "") + "</td><td>" + esc(m.username || "—") + "</td>" +
          (adm ? '<td><button class="btn del sm" data-delm="' + m.id + '">✕ Delete</button></td>' : "") + "</tr>";
      }).join("") : '<tr><td colspan="' + (adm ? 8 : 7) + '" class="mut">No movements match.</td></tr>') + "</table>" +
      (d.rows.length >= d.limit ? '<p class="mut">Showing latest ' + d.limit + " – export CSV for everything.</p>" : "") + "</div>";
    return [html, function () {
      filterForm("#ff", "/stock-flow");
      $("#exp").onclick = function () { download("/api/stock-flow.csv" + qs(qq), "stock_flow.csv"); };
      bind("[data-delm]", "click", async function (e, b) {
        if (!confirm("Delete this movement log record? (Product quantity is not changed.)")) return;
        try { await api("/api/stock-flow/" + b.dataset.delm, { method: "DELETE" }); go(location.hash, "Movement deleted.", true); }
        catch (err) { msg(err.message); }
      });
    }];
  }

  async function vAdjust() {
    var prods = (await api("/api/products")).products;
    var html = '<div class="card" style="max-width:480px"><h3>Stock count / adjustment</h3>' +
      '<p class="mut">Enter the real counted quantity. The difference is recorded in the stock flow with your reason.</p><form id="f">' +
      '<label>Product</label><select name="product_id" required>' + prods.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.name) + " (" + esc(p.sku) + ") – system: " + p.qty + "</option>";
      }).join("") + "</select>" +
      '<label>Counted quantity</label><input name="new_qty" type="number" min="0" required>' +
      '<label>Reason</label><input name="note" required placeholder="e.g. damaged, stocktake, theft">' +
      '<p><button class="btn">Record adjustment</button> <a class="btn alt" href="#/stock-flow">Cancel</a></p></form></div>';
    return [html, function () {
      onSubmit("#f", async function (d) {
        var r = await api("/api/stock-flow/adjust", { method: "POST", body: d });
        go("#/stock-flow?product=" + r.product_id, r.message, true);
      });
    }];
  }

  async function vAdmin() {
    var d = await api("/api/admin"), st = d.stats;
    var card = function (l, v) { return '<div class="card"><div class="mut">' + l + '</div><div class="stat">' + v + "</div></div>"; };
    var html = '<div class="grid">' + card("Users", st.users) + card("Products", st.products) + card("Stock movements", st.moves) + card("Sales", st.sales) + "</div>" +
      '<div class="card"><div class="row"><h3>Users</h3><a class="btn" href="#/admin/users/new">+ Add user</a></div>' +
      "<table><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Sales</th><th>Last login</th><th></th></tr>" + d.users.map(function (u) {
        return "<tr><td>" + esc(u.username) + "</td><td>" + esc(u.full_name || "") + '</td><td><span class="badge ' + esc(u.role) + '">' + esc(u.role) + "</span></td>" +
          "<td>" + (u.active ? "Active" : '<span class="badge off">Disabled</span>') + "</td><td>" + u.sales_n + '</td><td class="mut">' + (u.last_login ? when(u.last_login) : "never") + "</td>" +
          '<td><a href="#/admin/users/' + u.id + '/edit">Edit</a>' + (u.id !== me.id ? ' <button class="btn del sm" data-delu="' + u.id + '" data-name="' + esc(u.username) + '">✕</button>' : "") + "</td></tr>";
      }).join("") + "</table></div>" +
      '<div class="card"><div class="row"><h3>Backup</h3><button class="btn alt" id="bk">⬇ Download database backup</button></div>' +
      '<p class="mut">Free hosting can lose data in rare cases – download a backup regularly and keep it somewhere safe.</p></div>' +
      '<div class="card"><div class="row"><h3>Latest stock activity</h3><a href="#/stock-flow">View all</a></div><table>' +
      (d.recent.length ? d.recent.map(function (m) {
        return '<tr><td class="mut">' + when(m.created) + "</td><td>" + esc(m.pname) + '</td><td><span class="badge">' + esc(m.kind) + "</span></td>" +
          '<td class="' + (m.change > 0 ? "green" : "red") + '">' + sign(m.change) + "</td><td>" + esc(m.username || "—") + "</td></tr>";
      }).join("") : '<tr><td class="mut">Nothing yet</td></tr>') + "</table></div>";
    return [html, function () {
      $("#bk").onclick = function () { download("/api/admin/backup", "stockflow-backup.db"); };
      bind("[data-delu]", "click", async function (e, b) {
        if (!confirm("Delete user " + b.dataset.name + "?")) return;
        try { await api("/api/admin/users/" + b.dataset.delu, { method: "DELETE" }); go(location.hash, "User deleted.", true); }
        catch (err) { msg(err.message); }
      });
    }];
  }

  async function vUserForm(a) {
    var id = a[0], u = id ? (await api("/api/admin/users/" + id)).user : null;
    var html = '<div class="card" style="max-width:440px"><h3>' + (u ? "Edit " + esc(u.username) : "New user") + '</h3><form id="f">' +
      (u ? "" : '<label>Username</label><input name="username" required>') +
      '<label>Full name</label><input name="full_name" value="' + esc(u ? u.full_name || "" : "") + '">' +
      '<label>Role</label><select name="role"><option value="staff"' + (u && u.role === "staff" ? " selected" : "") + '>Staff – sales, restock, view</option><option value="admin"' + (u && u.role === "admin" ? " selected" : "") + ">Admin – everything</option></select>" +
      (u ? '<label><input type="checkbox" name="active"' + (u.active ? " checked" : "") + "> Account active</label>" : "") +
      "<label>" + (u ? "New password (leave blank to keep)" : "Password (6+ chars)") + '</label><input name="password" type="password" ' + (u ? "" : "required ") + 'minlength="6" autocomplete="new-password">' +
      '<p><button class="btn">Save</button> <a class="btn alt" href="#/admin">Cancel</a></p></form></div>';
    return [html, function () {
      onSubmit("#f", async function (d) {
        if (u) await api("/api/admin/users/" + id, { method: "PUT", body: d });
        else await api("/api/admin/users", { method: "POST", body: d });
        go("#/admin", u ? "User updated." : "User created.", true);
      });
    }];
  }

  async function vPassword() {
    var html = '<div class="card" style="max-width:420px"><h3>Change password</h3><form id="f">' +
      '<label>Current password</label><input name="current" type="password" required autocomplete="current-password">' +
      '<label>New password (6+ chars)</label><input name="new" type="password" required minlength="6" autocomplete="new-password">' +
      '<label>Confirm new password</label><input name="confirm" type="password" required autocomplete="new-password">' +
      '<p><button class="btn">Update</button> <a class="btn alt" href="#/">Cancel</a></p></form></div>';
    return [html, function () {
      onSubmit("#f", async function (d) { await api("/api/password", { method: "POST", body: d }); go("#/", "Password updated.", true); });
    }];
  }

  // ---------- router ----------
  var routes = [
    [/^\/$/, vDash], [/^\/products$/, vProducts], [/^\/products\/new$/, vProductForm, 1], [/^\/products\/(\d+)\/edit$/, vProductForm, 1],
    [/^\/stock-flow$/, vFlow], [/^\/stock-adjust$/, vAdjust, 1], [/^\/sales$/, vSales], [/^\/sales\/new$/, vSaleNew], [/^\/sales\/(\d+)$/, vSale],
    [/^\/admin$/, vAdmin, 1], [/^\/admin\/users\/new$/, vUserForm, 1], [/^\/admin\/users\/(\d+)\/edit$/, vUserForm, 1], [/^\/password$/, vPassword]
  ];
  function draw(html, after, path) {
    var main = $("#main");
    main.innerHTML = (notice ? '<div id="msg" class="flash' + (notice.ok ? " ok" : "") + '">' + esc(notice.m) + "</div>" : "") + html;
    notice = null; drawChrome(path); bindInstall();
    if (after) after();
    window.scrollTo(0, 0);
  }
  async function route() {
    var my = ++seq, h = parseHash(), path = h.path;
    if (!API) { draw('<div class="card"><h3>Not configured</h3><p>Edit <code>config.js</code> and set <code>STOCKFLOW_API</code> to your backend address.</p></div>', null, path); return; }
    if (token && !me) {
      try { me = (await api("/api/me")).user; } catch (e) { if (my !== seq) return; if (token) { draw('<div class="card"><h3>Server unreachable</h3><p>' + esc(e.message) + '</p><button class="btn" onclick="location.reload()">Try again</button></div>', null, path); } return; }
      if (my !== seq) return;
    }
    if (!me) {
      if (path !== "/login") { location.hash = "#/login"; return; }
      var r0 = await vLogin(); draw(r0[0], r0[1], path); return;
    }
    if (path === "/login") { location.hash = "#/"; return; }
    var hit = null;
    for (var i = 0; i < routes.length; i++) { var m = path.match(routes[i][0]); if (m) { hit = [routes[i], m.slice(1)]; break; } }
    if (!hit) { draw('<div class="card"><h3>Page not found</h3><a class="btn alt" href="#/">Home</a></div>', null, path); return; }
    if (hit[0][2] && !isAdmin()) { draw('<div class="card"><h3>Admins only</h3><a class="btn alt" href="#/">Home</a></div>', null, path); return; }
    try {
      var res = await hit[0][1](hit[1], h.q);
      if (my !== seq) return;
      draw(res[0], res[1], path);
    } catch (e) {
      if (my !== seq || !e.message) return;
      draw('<div class="card"><h3>Something went wrong</h3><p>' + esc(e.message) + '</p><a class="btn alt" href="#/">Home</a></div>', null, path);
    }
  }
  window.addEventListener("hashchange", route);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  $("#main").innerHTML = '<div class="loading">Loading…</div>';
  route();
})();
