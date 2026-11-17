"""Paste this into PythonAnywhere's WSGI configuration file (Web tab) and edit the 4 CHANGE lines.
Secrets live here on the server - never commit real values to GitHub."""
import os, sys

USER = "YOUR_PYTHONANYWHERE_USERNAME"                       # CHANGE 1
sys.path.insert(0, f"/home/{USER}/stockflow/backend")

os.environ["SECRET_KEY"] = "PASTE-A-LONG-RANDOM-STRING"       # CHANGE 2
os.environ["ADMIN_PASSWORD"] = "choose-a-strong-password"     # CHANGE 3 (only used on very first start)
os.environ["ALLOWED_ORIGINS"] = "https://YOUR_GITHUB_USERNAME.github.io"  # CHANGE 4
os.environ["DATA_DIR"] = f"/home/{USER}/stockflow-data"       # database lives OUTSIDE the git folder

from app import app as application  # noqa: E402
