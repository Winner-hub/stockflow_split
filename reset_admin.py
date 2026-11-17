"""Reset a user's password (e.g. a forgotten admin password). Run in a PythonAnywhere Bash console:
    cd ~/stockflow/backend && DATA_DIR=~/stockflow-data python3 reset_admin.py admin NewPassword123
"""
import os, sys, sqlite3
from werkzeug.security import generate_password_hash

if len(sys.argv) != 3 or len(sys.argv[2]) < 6:
    sys.exit("usage: python3 reset_admin.py <username> <new-password (6+ chars)>")
db = os.path.join(os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__))), "stockflow.db")
c = sqlite3.connect(db)
n = c.execute("UPDATE users SET password_hash=?, active=1 WHERE username=?",
              (generate_password_hash(sys.argv[2]), sys.argv[1])).rowcount
c.commit()
print("Password reset." if n else "No such user.")
