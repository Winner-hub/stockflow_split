"""StockFlow backend - JSON API only (the web pages live in ../frontend).

Auth: send  Authorization: Bearer <token>  (token comes from POST /api/login).
Data: SQLite file in DATA_DIR (keep it OUTSIDE the git checkout so updates never touch it).
"""
import sqlite3, csv, io, os, secrets, time, tempfile
from functools import wraps
from flask import Flask, g, request, jsonify, Response, send_file
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", BASE)
os.makedirs(DATA_DIR, exist_ok=True)
DB = os.path.join(DATA_DIR, "stockflow.db")
KEY_FILE = os.path.join(DATA_DIR, ".secret_key")
TOKEN_DAYS = int(os.environ.get("TOKEN_DAYS", "14"))
# Comma-separated list of frontend origins allowed to call this API,
# e.g. https://yourname.github.io   ("*" = anyone; fine for local testing only)
ALLOWED = [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _secret():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    if not os.path.exists(KEY_FILE):
        with open(KEY_FILE, "w") as f:
            f.write(secrets.token_hex(32))
    return open(KEY_FILE).read().strip()


SIGNER = URLSafeTimedSerializer(_secret(), salt="stockflow-auth")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 0, reorder INTEGER NOT NULL DEFAULT 5);
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP,
  customer TEXT, total REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sale_items(
  id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER,
  qty INTEGER, price REAL, cost REAL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  full_name TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT DEFAULT CURRENT_TIMESTAMP, last_login TEXT);
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP,
  product_id INTEGER NOT NULL, change INTEGER NOT NULL, qty_after INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- initial | restock | sale | void | adjustment
  ref TEXT, note TEXT, user_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_mov_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS ix_mov_created ON stock_movements(created);
"""
MOVE_KINDS = ["initial", "restock", "sale", "void", "adjustment"]


def init_db():
    """Create tables and migrate older databases in place (safe to re-run)."""
    with sqlite3.connect(DB) as c:
        c.executescript(SCHEMA)
        cols = {r[1] for r in c.execute("PRAGMA table_info(sales)")}
        if "user_id" not in cols:
            c.execute("ALTER TABLE sales ADD COLUMN user_id INTEGER")
        if "status" not in cols:
            c.execute("ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'")
        if c.execute("SELECT COUNT(*) FROM stock_movements").fetchone()[0] == 0:
            c.execute("""INSERT INTO stock_movements(product_id,change,qty_after,kind,note)
                         SELECT id, qty, qty, 'initial', 'Opening balance (migrated)'
                         FROM products WHERE qty<>0""")
        if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            pw = os.environ.get("ADMIN_PASSWORD", "admin123")
            c.execute("INSERT INTO users(username,full_name,password_hash,role) VALUES(?,?,?,?)",
                      ("admin", "Administrator", generate_password_hash(pw), "admin"))
            print("*** First start: login 'admin' created. Change the password after signing in.")


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB, timeout=15)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close(_):
    d = g.pop("db", None)
    if d:
        d.close()


def q(sql, *a):
    return db().execute(sql, a).fetchall()


def rows(sql, *a):
    return [dict(r) for r in q(sql, *a)]


class ApiError(Exception):
    def __init__(self, msg, code=400):
        self.msg, self.code = msg, code


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify(error=e.msg), e.code


@app.errorhandler(404)
def _404(_):
    return jsonify(error="Not found"), 404


@app.errorhandler(405)
def _405(_):
    return jsonify(error="Method not allowed"), 405


@app.errorhandler(500)
def _500(_):
    return jsonify(error="Server error"), 500


# ---------- CORS ----------
@app.after_request
def cors(resp):
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin and ("*" in ALLOWED or origin in ALLOWED):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "86400"
        resp.headers["Access-Control-Expose-Headers"] = "Content-Disposition"
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------- auth ----------
def make_token(uid):
    return SIGNER.dumps({"uid": uid})


@app.before_request
def preflight_and_auth():
    if request.method == "OPTIONS":
        return Response(status=204)
    g.user = None
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer "):
        try:
            data = SIGNER.loads(h[7:], max_age=TOKEN_DAYS * 86400)
            u = db().execute("SELECT * FROM users WHERE id=? AND active=1", (data["uid"],)).fetchone()
            g.user = u
        except (BadSignature, SignatureExpired, KeyError):
            pass


def login_required(f):
    @wraps(f)
    def w(*a, **k):
        if not g.user:
            raise ApiError("Please sign in.", 401)
        return f(*a, **k)
    return w


def admin_required(f):
    @wraps(f)
    @login_required
    def w(*a, **k):
        if g.user["role"] != "admin":
            raise ApiError("Admins only.", 403)
        return f(*a, **k)
    return w


def body():
    return request.get_json(silent=True) or {}


def pub_user(u):
    return {k: u[k] for k in ("id", "username", "full_name", "role", "active")}


_fails = {}  # simple in-memory login throttle: key -> [timestamps]


def _throttled(key):
    now = time.time()
    _fails[key] = [t for t in _fails.get(key, []) if now - t < 600]
    return len(_fails[key]) >= 8


@app.post("/api/login")
def login():
    f = body()
    name, pw = str(f.get("username", "")).strip(), str(f.get("password", ""))
    key = (request.remote_addr, name.lower())
    if _throttled(key):
        raise ApiError("Too many attempts. Wait a few minutes and try again.", 429)
    u = db().execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if u and u["active"] and check_password_hash(u["password_hash"], pw):
        db().execute("UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?", (u["id"],))
        db().commit()
        _fails.pop(key, None)
        return jsonify(token=make_token(u["id"]), user=pub_user(u))
    _fails.setdefault(key, []).append(time.time())
    raise ApiError("Invalid username or password (or account disabled).", 401)


@app.get("/api/me")
@login_required
def me():
    return jsonify(user=pub_user(g.user))


@app.post("/api/password")
@login_required
def change_password():
    f = body()
    if not check_password_hash(g.user["password_hash"], str(f.get("current", ""))):
        raise ApiError("Current password is wrong.")
    new = str(f.get("new", ""))
    if len(new) < 6:
        raise ApiError("New password must be at least 6 characters.")
    if new != f.get("confirm"):
        raise ApiError("New passwords do not match.")
    db().execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new), g.user["id"]))
    db().commit()
    return jsonify(ok=True)


# ---------- stock ledger ----------
def log_move(product_id, change, kind, ref=None, note=None):
    con = db()
    con.execute("UPDATE products SET qty=qty+? WHERE id=?", (change, product_id))
    after = con.execute("SELECT qty FROM products WHERE id=?", (product_id,)).fetchone()["qty"]
    con.execute("""INSERT INTO stock_movements(product_id,change,qty_after,kind,ref,note,user_id)
                   VALUES(?,?,?,?,?,?,?)""",
                (product_id, change, after, kind, ref, note, g.user["id"] if g.get("user") else None))


# ---------- admin: users ----------
@app.get("/api/admin")
@admin_required
def admin():
    users = rows("""SELECT u.id,u.username,u.full_name,u.role,u.active,u.last_login,
                    (SELECT COUNT(*) FROM sales s WHERE s.user_id=u.id) sales_n
                    FROM users u ORDER BY u.role, u.username""")
    st = dict(users=len(users),
              products=q("SELECT COUNT(*) c FROM products")[0]["c"],
              moves=q("SELECT COUNT(*) c FROM stock_movements")[0]["c"],
              sales=q("SELECT COUNT(*) c FROM sales")[0]["c"])
    recent = rows("""SELECT m.*, p.name pname, u.username FROM stock_movements m
                     JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
                     ORDER BY m.id DESC LIMIT 8""")
    return jsonify(users=users, stats=st, recent=recent)


@app.post("/api/admin/users")
@admin_required
def user_new():
    f = body()
    name, pw = str(f.get("username", "")).strip(), str(f.get("password", ""))
    role = f.get("role") if f.get("role") in ("admin", "staff") else "staff"
    if not name or len(pw) < 6:
        raise ApiError("Username required and password must be at least 6 characters.")
    try:
        db().execute("INSERT INTO users(username,full_name,password_hash,role) VALUES(?,?,?,?)",
                     (name, str(f.get("full_name", "")).strip(), generate_password_hash(pw), role))
        db().commit()
    except sqlite3.IntegrityError:
        raise ApiError("That username already exists.", 409)
    return jsonify(ok=True), 201


def _other_admins(uid):
    return q("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id<>?", uid)[0]["c"]


@app.get("/api/admin/users/<int:uid>")
@admin_required
def user_get(uid):
    r = q("SELECT id,username,full_name,role,active FROM users WHERE id=?", uid)
    if not r:
        raise ApiError("User not found.", 404)
    return jsonify(user=dict(r[0]))


@app.put("/api/admin/users/<int:uid>")
@admin_required
def user_edit(uid):
    r = q("SELECT * FROM users WHERE id=?", uid)
    if not r:
        raise ApiError("User not found.", 404)
    u, f = r[0], body()
    role = f.get("role") if f.get("role") in ("admin", "staff") else "staff"
    active = 1 if f.get("active") else 0
    if u["role"] == "admin" and (role != "admin" or not active) and not _other_admins(uid):
        raise ApiError("You can't demote or disable the last active admin.")
    pw = str(f.get("password") or "")
    if pw and len(pw) < 6:
        raise ApiError("Password must be at least 6 characters.")
    db().execute("UPDATE users SET full_name=?, role=?, active=? WHERE id=?",
                 (str(f.get("full_name", "")).strip(), role, active, uid))
    if pw:
        db().execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(pw), uid))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/admin/users/<int:uid>")
@admin_required
def user_delete(uid):
    if not q("SELECT 1 FROM users WHERE id=?", uid):
        raise ApiError("User not found.", 404)
    if uid == g.user["id"]:
        raise ApiError("You can't delete your own account.")
    if q("SELECT 1 FROM sales WHERE user_id=?", uid) or q("SELECT 1 FROM stock_movements WHERE user_id=?", uid):
        raise ApiError("This user has recorded activity; disable the account instead of deleting.")
    db().execute("DELETE FROM users WHERE id=?", (uid,))
    db().commit()
    return jsonify(ok=True)


@app.get("/api/admin/backup")
@admin_required
def backup():
    """Download a consistent copy of the whole database."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    src, dst = sqlite3.connect(DB), sqlite3.connect(path)
    src.backup(dst)
    src.close(); dst.close()
    with open(path, "rb") as fh:
        data = fh.read()
    os.remove(path)
    stamp = time.strftime("%Y%m%d-%H%M")
    return Response(data, mimetype="application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename=stockflow-{stamp}.db"})


# ---------- dashboard ----------
@app.get("/api/dashboard")
@login_required
def dashboard():
    s = db().execute("""SELECT COALESCE(SUM(i.qty*i.price),0) rev, COALESCE(SUM(i.qty*(i.price-i.cost)),0) profit
                        FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='completed'""").fetchone()
    stats = dict(rev=s["rev"], profit=s["profit"],
                 sales=q("SELECT COUNT(*) c FROM sales WHERE status='completed'")[0]["c"],
                 value=q("SELECT COALESCE(SUM(qty*cost),0) v FROM products")[0]["v"])
    return jsonify(
        stats=stats,
        low=rows("SELECT * FROM products WHERE qty<=reorder ORDER BY qty"),
        top=rows("""SELECT p.name, SUM(i.qty) n, SUM(i.qty*i.price) rev FROM sale_items i
                    JOIN sales s ON s.id=i.sale_id AND s.status='completed'
                    JOIN products p ON p.id=i.product_id GROUP BY p.id ORDER BY n DESC LIMIT 5"""),
        recent=rows("SELECT * FROM sales ORDER BY id DESC LIMIT 5"))


# ---------- products ----------
def _num(f, key, cast, default=0):
    try:
        return max(cast(f.get(key) or default), 0)
    except (ValueError, TypeError):
        return default


@app.get("/api/products")
@login_required
def products():
    term = request.args.get("q", "")
    return jsonify(products=rows("SELECT * FROM products WHERE name LIKE ? OR sku LIKE ? ORDER BY name",
                                 f"%{term}%", f"%{term}%"))


@app.get("/api/products/<int:pid>")
@admin_required
def product_get(pid):
    r = rows("SELECT * FROM products WHERE id=?", pid)
    if not r:
        raise ApiError("Product not found.", 404)
    return jsonify(product=r[0])


def _product_vals(f):
    sku, name = str(f.get("sku", "")).strip(), str(f.get("name", "")).strip()
    if not sku or not name:
        raise ApiError("SKU and name are required.")
    return (sku, name, _num(f, "cost", float), _num(f, "price", float), _num(f, "qty", int), _num(f, "reorder", int, 5))


@app.post("/api/products")
@admin_required
def product_create():
    v = _product_vals(body())
    try:
        cur = db().execute("INSERT INTO products(sku,name,cost,price,qty,reorder) VALUES(?,?,?,?,0,?)",
                           v[:4] + (v[5],))
        if v[4]:
            log_move(cur.lastrowid, v[4], "initial", note="Opening stock")
        db().commit()
    except sqlite3.IntegrityError:
        db().rollback()
        raise ApiError("SKU already exists.", 409)
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/products/<int:pid>")
@admin_required
def product_update(pid):
    r = q("SELECT * FROM products WHERE id=?", pid)
    if not r:
        raise ApiError("Product not found.", 404)
    v = _product_vals(body())
    try:
        db().execute("UPDATE products SET sku=?,name=?,cost=?,price=?,reorder=? WHERE id=?", v[:4] + (v[5], pid))
        diff = v[4] - r[0]["qty"]
        if diff:
            log_move(pid, diff, "adjustment", note="Edited quantity on product form")
        db().commit()
    except sqlite3.IntegrityError:
        db().rollback()
        raise ApiError("SKU already exists.", 409)
    return jsonify(ok=True)


@app.delete("/api/products/<int:pid>")
@admin_required
def product_delete(pid):
    if q("SELECT 1 FROM sale_items WHERE product_id=?", pid):
        raise ApiError("Cannot delete: product has sales history.", 409)
    db().execute("DELETE FROM stock_movements WHERE product_id=?", (pid,))
    db().execute("DELETE FROM products WHERE id=?", (pid,))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/products/<int:pid>/restock")
@login_required
def restock(pid):
    f = body()
    try:
        n = int(f.get("qty", 0))
    except (ValueError, TypeError):
        n = 0
    if n <= 0:
        raise ApiError("Enter a quantity above zero.")
    if not q("SELECT 1 FROM products WHERE id=?", pid):
        raise ApiError("Product not found.", 404)
    log_move(pid, n, "restock", note=(str(f.get("note") or "").strip() or None))
    db().commit()
    return jsonify(ok=True)


# ---------- stock flow ----------
def _flow_filters():
    a = request.args
    where, args = ["1=1"], []
    if a.get("product"):
        where.append("m.product_id=?"); args.append(a["product"])
    if a.get("kind") in MOVE_KINDS:
        where.append("m.kind=?"); args.append(a["kind"])
    if a.get("start"):
        where.append("date(m.created)>=date(?)"); args.append(a["start"])
    if a.get("end"):
        where.append("date(m.created)<=date(?)"); args.append(a["end"])
    return " AND ".join(where), args


FLOW_SQL = """SELECT m.*, p.sku, p.name pname, u.username FROM stock_movements m
              JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
              WHERE {w} ORDER BY m.id DESC"""


@app.get("/api/stock-flow")
@login_required
def stock_flow():
    w, args = _flow_filters()
    r = rows(FLOW_SQL.format(w=w) + " LIMIT 500", *args)
    tot = db().execute(f"""SELECT COALESCE(SUM(CASE WHEN change>0 THEN change END),0) i,
                                  COALESCE(SUM(CASE WHEN change<0 THEN -change END),0) o
                           FROM stock_movements m WHERE {w}""", args).fetchone()
    return jsonify(rows=r, totals=dict(i=tot["i"], o=tot["o"]), kinds=MOVE_KINDS, limit=500)


@app.post("/api/stock-flow/adjust")
@admin_required
def stock_adjust():
    f = body()
    try:
        pid, new = int(f["product_id"]), int(f["new_qty"])
    except (KeyError, ValueError, TypeError):
        raise ApiError("Pick a product and a count of 0 or more.")
    note = str(f.get("note", "")).strip()
    r = q("SELECT * FROM products WHERE id=?", pid)
    if not r or new < 0 or not note:
        raise ApiError("Pick a product, a count of 0 or more, and give a reason.")
    p = r[0]
    if new == p["qty"]:
        raise ApiError("Count matches the system - nothing to adjust.")
    log_move(pid, new - p["qty"], "adjustment", note=note)
    db().commit()
    return jsonify(message=f"{p['name']} adjusted from {p['qty']} to {new}.", product_id=pid)


@app.put("/api/stock-flow/<int:mid>")
@admin_required
def stock_movement_edit(mid):
    r = q("SELECT * FROM stock_movements WHERE id=?", mid)
    if not r:
        raise ApiError("Movement not found.", 404)
    f = body()
    kind = f.get("kind") if f.get("kind") in MOVE_KINDS else r[0]["kind"]
    db().execute("UPDATE stock_movements SET kind=?, note=?, ref=? WHERE id=?",
                 (kind, str(f.get("note", "")).strip(), str(f.get("ref", "")).strip(), mid))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/stock-flow/<int:mid>")
@admin_required
def stock_movement_delete(mid):
    if not q("SELECT 1 FROM stock_movements WHERE id=?", mid):
        raise ApiError("Movement not found.", 404)
    db().execute("DELETE FROM stock_movements WHERE id=?", (mid,))
    db().commit()
    return jsonify(ok=True)


def _csv(name, header, data):
    out = io.StringIO(); w = csv.writer(out)
    w.writerow(header); w.writerows(data)
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={name}.csv"})


@app.get("/api/stock-flow.csv")
@login_required
def stock_flow_csv():
    w, args = _flow_filters()
    r = q(FLOW_SQL.format(w=w), *args)
    return _csv("stock_flow", ["id", "created", "sku", "product", "kind", "change", "qty_after", "ref", "note", "user"],
                [[x["id"], x["created"], x["sku"], x["pname"], x["kind"], x["change"], x["qty_after"],
                  x["ref"], x["note"], x["username"]] for x in r])


# ---------- sales ----------
@app.get("/api/sales")
@login_required
def sales():
    a = request.args
    where, args = ["1=1"], []
    if a.get("start"):
        where.append("date(s.created)>=date(?)"); args.append(a["start"])
    if a.get("end"):
        where.append("date(s.created)<=date(?)"); args.append(a["end"])
    if a.get("cashier"):
        where.append("s.user_id=?"); args.append(a["cashier"])
    if a.get("status") in ("completed", "voided"):
        where.append("s.status=?"); args.append(a["status"])
    if a.get("q"):
        where.append("s.customer LIKE ?"); args.append(f"%{a['q']}%")
    w = " AND ".join(where)
    r = rows(f"""SELECT s.*, u.username cashier,
                   (SELECT COALESCE(SUM(qty),0) FROM sale_items WHERE sale_id=s.id) units,
                   (SELECT COALESCE(SUM(qty*(price-cost)),0) FROM sale_items WHERE sale_id=s.id) profit
                 FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE {w} ORDER BY s.id DESC""", *args)
    ok = [x for x in r if x["status"] == "completed"]
    is_admin = g.user["role"] == "admin"
    summ = dict(n=len(ok), rev=sum(x["total"] for x in ok), units=sum(x["units"] for x in ok),
                profit=sum(x["profit"] for x in ok) if is_admin else None)
    if not is_admin:                      # staff never see profit
        for x in r:
            x.pop("profit", None)
    return jsonify(rows=r, summary=summ, users=rows("SELECT id,username FROM users ORDER BY username"))


@app.post("/api/sales")
@login_required
def sale_create():
    f = body()
    lines = {}
    for it in f.get("items") or []:
        try:
            pid, n = int(it.get("product_id")), int(it.get("qty"))
        except (ValueError, TypeError, AttributeError):
            continue
        if n > 0:
            lines[pid] = lines.get(pid, 0) + n
    if not lines:
        raise ApiError("Add at least one item.")
    con = db(); items = []
    for pid, n in lines.items():
        p = con.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if not p:
            raise ApiError("A product in this sale no longer exists.")
        if p["qty"] < n:
            raise ApiError(f"Insufficient stock for {p['name']} (only {p['qty']} left).")
        items.append((p, n))
    total = sum(p["price"] * n for p, n in items)
    cur = con.execute("INSERT INTO sales(customer,total,user_id) VALUES(?,?,?)",
                      (str(f.get("customer") or "").strip() or "Walk-in", total, g.user["id"]))
    for p, n in items:
        con.execute("INSERT INTO sale_items(sale_id,product_id,qty,price,cost) VALUES(?,?,?,?,?)",
                    (cur.lastrowid, p["id"], n, p["price"], p["cost"]))
        log_move(p["id"], -n, "sale", ref=f"Sale #{cur.lastrowid}")
    con.commit()
    return jsonify(id=cur.lastrowid), 201


@app.get("/api/sales/<int:sid>")
@login_required
def sale_view(sid):
    r = rows("SELECT s.*, u.username cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?", sid)
    if not r:
        raise ApiError("Sale not found.", 404)
    items = rows("""SELECT p.name, p.sku, i.qty, i.price FROM sale_items i
                    JOIN products p ON p.id=i.product_id WHERE sale_id=?""", sid)
    return jsonify(sale=r[0], items=items)


@app.post("/api/sales/<int:sid>/void")
@admin_required
def sale_void(sid):
    r = q("SELECT * FROM sales WHERE id=?", sid)
    if not r:
        raise ApiError("Sale not found.", 404)
    if r[0]["status"] == "voided":
        raise ApiError("Sale already voided.")
    for i in q("SELECT * FROM sale_items WHERE sale_id=?", sid):
        if q("SELECT 1 FROM products WHERE id=?", i["product_id"]):
            log_move(i["product_id"], i["qty"], "void", ref=f"Sale #{sid}", note="Sale voided - stock returned")
    db().execute("UPDATE sales SET status='voided' WHERE id=?", (sid,))
    db().commit()
    return jsonify(message=f"Sale #{sid} voided and stock returned.")


@app.put("/api/sales/<int:sid>")
@admin_required
def sale_edit(sid):
    r = q("SELECT * FROM sales WHERE id=?", sid)
    if not r:
        raise ApiError("Sale not found.", 404)
    f = body()
    status = f.get("status") if f.get("status") in ("completed", "voided") else r[0]["status"]
    db().execute("UPDATE sales SET customer=?, status=? WHERE id=?",
                 (str(f.get("customer") or "").strip() or "Walk-in", status, sid))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/sales/<int:sid>")
@admin_required
def sale_delete(sid):
    if not q("SELECT 1 FROM sales WHERE id=?", sid):
        raise ApiError("Sale not found.", 404)
    db().execute("DELETE FROM sale_items WHERE sale_id=?", (sid,))
    db().execute("DELETE FROM sales WHERE id=?", (sid,))
    db().commit()
    return jsonify(ok=True)


# ---------- export ----------
@app.get("/api/export/<what>.csv")
@login_required
def export(what):
    sql = {"products": "SELECT sku,name,cost,price,qty,reorder FROM products",
           "sales": """SELECT s.id,s.created,s.customer,s.total,s.status,u.username cashier
                       FROM sales s LEFT JOIN users u ON u.id=s.user_id"""}.get(what)
    if not sql:
        raise ApiError("Not found", 404)
    cur = db().execute(sql)
    return _csv(what, [c[0] for c in cur.description], [list(r) for r in cur.fetchall()])


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.get("/")
def root():
    return jsonify(service="StockFlow API", health="/api/health")


init_db()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)),
            debug=os.environ.get("FLASK_DEBUG") == "1")
