# StockFlow – Inventory & Sales Management

Split into two independent parts:

| Folder | What it is | Hosted on (free) |
|---|---|---|
| `frontend/` | The website (HTML/CSS/JS, installable as an app) | **GitHub Pages** |
| `backend/`  | The JSON API + SQLite database (Flask) | **PythonAnywhere** (free, keeps your data) |

The frontend talks to the backend over HTTPS using a login token. Features are the same as before:
logins & roles (admin/staff), products, restock, stock-flow ledger, stock counts, sales, void, CSV export –
plus a new **database backup download** (Admin page).

**➡ Follow `DEPLOY.md` for the step-by-step deployment.**

## Run locally (optional)
    # terminal 1 – backend  (http://127.0.0.1:5000)
    cd backend && pip install -r requirements.txt && python app.py
    # terminal 2 – frontend (http://127.0.0.1:8080)
    cd frontend && python -m http.server 8080
Open http://127.0.0.1:8080 and sign in with **admin / admin123** (set `ADMIN_PASSWORD` before first start to change it).
`frontend/config.js` already points at `http://127.0.0.1:5000` for local use.

## API quick reference (all under `/api`, auth = `Authorization: Bearer <token>`)
`POST /login` · `GET /me` · `POST /password` · `GET /dashboard` · `GET|POST /products` · `GET|PUT|DELETE /products/<id>` ·
`POST /products/<id>/restock` · `GET /stock-flow` · `POST /stock-flow/adjust` · `GET /sales` · `POST /sales` · `GET /sales/<id>` ·
`POST /sales/<id>/void` · `GET /admin` · `POST /admin/users` · `PUT|DELETE /admin/users/<id>` · `GET /admin/backup` · `GET /export/<products|sales>.csv`
