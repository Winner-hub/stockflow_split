# Free deployment guide – GitHub (frontend) + PythonAnywhere (backend)

**Total cost: $0, no credit card.** About 20–30 minutes the first time.

```
 Staff browser ──►  GitHub Pages  (frontend/)  ──── HTTPS + login token ────►  PythonAnywhere (backend/ + stockflow.db)
                    https://YOU.github.io/stockflow/                              https://YOU.pythonanywhere.com
```

Why this split? GitHub can only host *static* websites (the frontend). The backend needs a server and a
database file that survives restarts. PythonAnywhere's free plan keeps files permanently, so your SQLite data is safe.

Replace **YOU** below with your GitHub username and **YOURPA** with the PythonAnywhere username you choose.

---

## PART 1 – Put the code on GitHub

1. Create a free account at <https://github.com> and click **New repository**.
   - Name: `stockflow`  · Visibility: **Public** (free GitHub Pages needs a public repo) · don't tick "add README".
   - *Public is safe here: the repo contains only code. Your passwords, secret key and database are never in it.*
2. On the empty repo page click **uploading an existing file**. Unzip `stockflow_split.zip` on your computer and
   drag **everything inside the `stockflow` folder** (`backend`, `frontend`, `.github`, `README.md`, `DEPLOY.md`, `.gitignore`) into the page.
   - Make sure the `.github` folder goes too (it is hidden on some computers – on Mac press `Cmd+Shift+.`, on Windows enable "Hidden items" in File Explorer's View menu).
   - Alternatively, if you use Git: `git init && git add . && git commit -m "StockFlow" && git branch -M main && git remote add origin https://github.com/YOU/stockflow.git && git push -u origin main`
3. Click **Commit changes**.

## PART 2 – Deploy the backend on PythonAnywhere

1. Sign up at <https://www.pythonanywhere.com> → choose **Create a Beginner account** (free). Your username becomes your address: `YOURPA.pythonanywhere.com`.
2. Open a **Bash console** (Dashboard → *Consoles* → *Bash*) and run:
   ```bash
   git clone https://github.com/YOU/stockflow.git
   mkdir -p ~/stockflow-data
   ```
   (Your database will live in `~/stockflow-data`, outside the code folder, so updating the code can never erase it.)
3. Go to the **Web** tab → **Add a new web app** → *Next* → **Flask** → pick the newest Python (3.11 or higher) → keep the suggested path → *Next*.
4. On the Web tab, find **Code** and click the link next to **WSGI configuration file** (e.g. `/var/www/YOURPA_pythonanywhere_com_wsgi.py`).
   **Delete everything** in it and paste the contents of `backend/wsgi_pythonanywhere.py`, then edit the four `CHANGE` lines:
   | Line | Put |
   |---|---|
   | `USER` | your PythonAnywhere username |
   | `SECRET_KEY` | a long random string (run `python3 -c "import secrets;print(secrets.token_hex(32))"` in the console and paste the result) |
   | `ADMIN_PASSWORD` | the password you want for the first `admin` login |
   | `ALLOWED_ORIGINS` | `https://YOU.github.io` (exactly this: **no** `/stockflow` and **no** trailing slash) |

   Click **Save**.
5. Still on the Web tab, in the **Virtualenv** / **Code** area, set **Working directory** to `/home/YOURPA/stockflow/backend/` (optional but tidy).
6. Click the big green **Reload** button at the top of the Web tab.
7. Test it: open `https://YOURPA.pythonanywhere.com/api/health` in your browser. You should see `{"status":"ok"}`. ✅
   - If you see an error page, open the **Error log** link on the Web tab – the last lines say what's wrong (most often a typo in the WSGI file).

## PART 3 – Deploy the frontend on GitHub Pages

1. In your GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   (Do this first, otherwise the automatic deploy has nowhere to publish.)
2. Open `frontend/config.js`, click the ✏️ pencil, and change the address:
   ```js
   window.STOCKFLOW_API = "https://YOURPA.pythonanywhere.com";
   ```
   (no trailing slash) → **Commit changes**.
3. Open the repo's **Actions** tab. The *Deploy frontend to GitHub Pages* workflow runs after your commit
   (if an earlier run shows a red ✗ because Pages wasn't enabled yet, click the workflow → **Run workflow**). Wait for the green ✅ (about 1 minute).
4. Your app is live at **`https://YOU.github.io/stockflow/`**. Open it, sign in as `admin` with the `ADMIN_PASSWORD` you set, then:
   - **Password** (top bar) → change the admin password.
   - **Admin → + Add user** → create accounts for your staff.
5. On a phone: Chrome menu → **Install app** / **Add to Home screen** (iPhone: Share → *Add to Home Screen*).

🎉 Done. Share the `github.io` link with your staff.

---

## Day-to-day

**Updating the frontend:** edit/upload files in `frontend/` on GitHub → the workflow redeploys automatically.

**Updating the backend:** push changes to GitHub, then in a PythonAnywhere Bash console:
```bash
cd ~/stockflow && git pull
```
and press **Reload** on the Web tab.

**⚠ Keep the free backend alive:** PythonAnywhere free apps are switched off after 3 months unless you log in and press
**"Run until 3 months from today"** on the Web tab. Put a reminder in your calendar (they also email you beforehand).

**Back up your data:** log in as admin → **Admin → Download database backup**. Do this weekly. To restore or move data,
upload that `.db` file to `~/stockflow-data/` on PythonAnywhere (Files tab), name it `stockflow.db`, and Reload.

**Moving data from your old StockFlow:** upload your old `stockflow.db` to `~/stockflow-data/` *before* the first visit
(or replace the file and Reload). It is migrated automatically.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login page says "Cannot reach the server" | Open `…pythonanywhere.com/api/health` directly. If it fails, check the Error log. If it works, `config.js` has the wrong address. |
| Browser console shows a **CORS** error | `ALLOWED_ORIGINS` in the WSGI file must be exactly `https://YOU.github.io` (no path, no trailing `/`, https). Save → Reload. |
| GitHub Pages shows 404 | Settings → Pages → Source must be **GitHub Actions**; check the Actions tab for a green run. |
| Blank page / old version after update | Hard refresh (Ctrl+Shift+R). The installed phone app updates the next time you open it online. |
| "Too many attempts" at login | Too many wrong passwords; wait 10 minutes. |
| Forgot the admin password | PythonAnywhere Bash console: `cd ~/stockflow/backend && DATA_DIR=~/stockflow-data python3 reset_admin.py admin NewPassword123` |

## Environment variables (set in the WSGI file)

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Signs login tokens. Changing it logs everyone out. |
| `ADMIN_PASSWORD` | Password for the first `admin` account (only used when the database is brand new). |
| `ALLOWED_ORIGINS` | Frontend address(es) allowed to call the API; comma-separate several. |
| `DATA_DIR` | Folder holding `stockflow.db`. |
| `TOKEN_DAYS` | How long a login lasts (default 14 days). |

## Other free/cheap hosts for the backend
Any host that can run `gunicorn app:app` (Render, Railway, Fly.io, a VPS) works – set the same environment variables and
mount a **persistent disk/volume** at `DATA_DIR`. Free tiers *without* a persistent disk (e.g. Render free) will lose your
database on every restart, so they are not suitable for the SQLite database.
