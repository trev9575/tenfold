#!/usr/bin/env python3
"""
Tenfold - a small, self-hosted EOS-style team tool.

Zero external dependencies: Python 3.10+ standard library + SQLite.
Run:  python3 server.py      (then open http://localhost:8090)
"""
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import calendar_feed

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "tenfold.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8090"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
COOKIE_NAME = "tf_session"
VERSION = "1.3.0"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES seats(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  roles TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rocks (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  quarter TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS measurables (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  goal REAL,
  op TEXT NOT NULL DEFAULT '>=',
  unit TEXT,
  sort INTEGER DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  measurable_id INTEGER NOT NULL REFERENCES measurables(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  value REAL,
  PRIMARY KEY (measurable_id, week)
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  term TEXT NOT NULL DEFAULT 'short',
  created_at TEXT NOT NULL,
  solved_at TEXT
);
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS headlines (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  rating REAL,
  notes TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS vto (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rocks_team ON rocks(team_id);
CREATE INDEX IF NOT EXISTS idx_issues_team ON issues(team_id);
CREATE INDEX IF NOT EXISTS idx_todos_team ON todos(team_id);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_id);
CREATE INDEX IF NOT EXISTS idx_headlines_team ON headlines(team_id);
CREATE INDEX IF NOT EXISTS idx_meas_team ON measurables(team_id);
"""

# Generic CRUD resources. cols: column -> type. choices: allowed values.
RESOURCES = {
    "teams": dict(cols={"name": str}, required="name", order="name COLLATE NOCASE", admin_write=True),
    "seats": dict(cols={"parent_id": int, "title": str, "roles": str, "user_id": int, "sort": int},
                  order="sort, id"),
    "rocks": dict(cols={"team_id": int, "title": str, "description": str, "owner_id": int,
                        "quarter": str, "due_date": str, "status": str},
                  choices={"status": ("on", "off", "done")}, team=True,
                  order="CASE status WHEN 'done' THEN 1 ELSE 0 END, due_date, id"),
    "measurables": dict(cols={"team_id": int, "title": str, "owner_id": int, "goal": float, "op": str,
                              "unit": str, "sort": int, "archived": int},
                        choices={"op": (">=", "<=", "=", ">", "<")}, team=True, order="sort, id"),
    "issues": dict(cols={"team_id": int, "title": str, "description": str, "owner_id": int,
                         "priority": int, "status": str, "term": str},
                   choices={"status": ("open", "solved"), "term": ("short", "long")}, team=True,
                   order="CASE status WHEN 'solved' THEN 1 ELSE 0 END, "
                         "CASE WHEN priority > 0 THEN priority ELSE 99 END, created_at DESC"),
    "todos": dict(cols={"team_id": int, "title": str, "description": str, "owner_id": int,
                        "due_date": str, "done": int, "issue_id": int},
                  team=True, order="done, due_date IS NULL, due_date, id"),
    "headlines": dict(cols={"team_id": int, "title": str, "owner_id": int, "kind": str, "archived": int},
                      choices={"kind": ("customer", "employee", "general")}, team=True,
                      order="archived, created_at DESC"),
    "meetings": dict(cols={"team_id": int, "title": str, "started_at": str, "ended_at": str,
                           "rating": float, "notes": str, "data": str},
                     team=True, order="COALESCE(started_at, created_at) DESC"),
}


# Resources that can have several owners. The first owner is also kept in the
# single-owner column so sorting and older data keep working.
MULTI_OWNER = {
    "rocks": ("owner_id", "owner_ids"),
    "issues": ("owner_id", "owner_ids"),
    "headlines": ("owner_id", "owner_ids"),
    "measurables": ("owner_id", "owner_ids"),
    "seats": ("user_id", "user_ids"),
}


def encode_ids(ids):
    return "," + ",".join(str(i) for i in ids) + "," if ids else None


def decode_ids(text, fallback):
    if text:
        return [int(x) for x in text.strip(",").split(",") if x.strip().isdigit()]
    return [fallback] if fallback else []


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = db()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "ical_url" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN ical_url TEXT")
    # Migration: add multi-owner columns to databases created by older versions.
    for table, (single, multi) in MULTI_OWNER.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if multi not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {multi} TEXT")
            conn.execute(f"UPDATE {table} SET {multi} = ',' || {single} || ',' WHERE {single} IS NOT NULL")
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
    conn.commit()
    conn.close()


def hash_password(pw):
    salt = secrets.token_bytes(16)
    iters = 240000
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iters)
    return f"pbkdf2${iters}${salt.hex()}${dk.hex()}"


def check_password(pw, stored):
    try:
        _, iters, salt, dk = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(test.hex(), dk)
    except Exception:
        return False


def get_setting(conn, key):
    r = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return r["value"] if r else None


def set_setting(conn, key, value):
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute("INSERT INTO settings(key, value) VALUES (?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def row(r):
    return dict(r) if r is not None else None


def public_user(u):
    d = {k: u[k] for k in ("id", "name", "email", "is_admin", "created_at")}
    d["has_calendar"] = bool(u["ical_url"]) if "ical_url" in u.keys() else False
    return d


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


def coerce(kind, value, col):
    if value is None or value == "":
        return None
    try:
        if kind is int:
            if isinstance(value, bool):
                return int(value)
            return int(value)
        if kind is float:
            return float(value)
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        return str(value)[:20000]
    except (TypeError, ValueError):
        raise ApiError(400, f"Invalid value for {col}")


class Handler(BaseHTTPRequestHandler):
    server_version = "Tenfold/" + VERSION
    protocol_version = "HTTP/1.1"

    # ---------- plumbing ----------
    def log_message(self, fmt, *args):
        if os.environ.get("QUIET_LOGS"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlparse(self.path)
        self.query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path
        self.new_cookie = None
        if path.startswith("/api/"):
            conn = db()
            try:
                parts = [p for p in path[5:].split("/") if p]
                result = self.api(conn, method, parts)
                conn.commit()
                self.send_json(200, result if result is not None else {"ok": True})
            except ApiError as e:
                conn.rollback()
                self.send_json(e.status, {"error": e.msg})
            except sqlite3.IntegrityError as e:
                conn.rollback()
                self.send_json(400, {"error": "Data conflict: " + str(e)})
            except Exception:
                conn.rollback()
                traceback.print_exc()
                self.send_json(500, {"error": "Server error"})
            finally:
                conn.close()
        elif method == "GET":
            self.serve_static(path)
        else:
            self.send_json(404, {"error": "Not found"})

    def body(self):
        if self.command in ("POST", "PUT", "DELETE"):
            ctype = self.headers.get("Content-Type", "")
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            # Requiring a JSON content type blocks simple cross-site form posts (CSRF).
            if "application/json" not in ctype:
                raise ApiError(415, "Expected application/json")
            if not raw:
                return {}
            try:
                data = json.loads(raw)
            except ValueError:
                raise ApiError(400, "Invalid JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "Expected a JSON object")
            return data
        return {}

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.new_cookie is not None:
            self.send_header("Set-Cookie", self.new_cookie)
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")  # SPA fallback
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.end_headers()
        self.wfile.write(data)

    # ---------- auth ----------
    def set_session_cookie(self, token, max_age):
        c = f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
        if COOKIE_SECURE:
            c += "; Secure"
        self.new_cookie = c

    def current_user(self, conn):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = cookies.SimpleCookie()
        try:
            jar.load(raw)
        except cookies.CookieError:
            return None
        if COOKIE_NAME not in jar:
            return None
        token = jar[COOKIE_NAME].value
        r = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > ?", (token, time.time())).fetchone()
        if r:
            self.token = token
        return r

    def start_session(self, conn, user_id):
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)",
                     (token, user_id, time.time() + SESSION_DAYS * 86400))
        self.set_session_cookie(token, SESSION_DAYS * 86400)

    # ---------- API ----------
    def api(self, conn, method, parts):
        body = self.body()
        head = parts[0] if parts else ""

        if head == "health":
            return {"ok": True, "version": VERSION}

        if head == "status" and method == "GET":
            n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            return {"needs_setup": n == 0, "signup_open": bool(get_setting(conn, "invite_code")), "version": VERSION}

        if head == "setup" and method == "POST":
            if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
                raise ApiError(403, "Setup already completed")
            name, email, pw = self.user_fields(body, need_pw=True)
            cur = conn.execute(
                "INSERT INTO users(name,email,pw_hash,is_admin,created_at) VALUES (?,?,?,1,?)",
                (name, email, hash_password(pw), now_iso()))
            team = (body.get("team") or "Leadership Team").strip()
            conn.execute("INSERT INTO teams(name, created_at) VALUES (?,?)", (team, now_iso()))
            self.start_session(conn, cur.lastrowid)
            return {"ok": True}

        if head == "register" and method == "POST":
            code = get_setting(conn, "invite_code")
            given = str(body.get("code", "")).strip()
            if not code or not hmac.compare_digest(given, code):
                time.sleep(0.8)
                raise ApiError(403, "That invite code isn't valid. Ask your admin for a new invite link.")
            name, email, pw = self.user_fields(body, need_pw=True)
            if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                raise ApiError(400, "An account with that email already exists. Try signing in.")
            cur = conn.execute(
                "INSERT INTO users(name,email,pw_hash,is_admin,created_at) VALUES (?,?,?,0,?)",
                (name, email, hash_password(pw), now_iso()))
            self.start_session(conn, cur.lastrowid)
            return {"ok": True}

        if head == "login" and method == "POST":
            email = str(body.get("email", "")).strip()
            pw = str(body.get("password", ""))
            u = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if not u or not check_password(pw, u["pw_hash"]):
                time.sleep(0.8)
                raise ApiError(401, "Wrong email or password")
            self.start_session(conn, u["id"])
            return public_user(u)

        user = self.current_user(conn)
        if not user:
            raise ApiError(401, "Not signed in")
        self.user = user

        if head == "logout" and method == "POST":
            conn.execute("DELETE FROM sessions WHERE token = ?", (self.token,))
            self.set_session_cookie("", 0)
            return {"ok": True}

        if head == "me" and len(parts) > 1 and parts[1] == "calendar" and method == "PUT":
            return self.set_calendar(conn, body)

        if head == "availability" and method == "GET":
            return self.availability(conn)

        if head == "me":
            if method == "GET":
                return public_user(user)
            if method == "PUT":
                return self.update_self(conn, body)

        if head == "invite":
            self.require_admin()
            if method == "POST":
                action = body.get("action")
                if action == "new":
                    set_setting(conn, "invite_code", secrets.token_urlsafe(9))
                elif action == "disable":
                    set_setting(conn, "invite_code", None)
                else:
                    raise ApiError(400, "action must be 'new' or 'disable'")
            return {"code": get_setting(conn, "invite_code")}

        if head == "users":
            return self.users_api(conn, method, parts, body)

        if head == "scores":
            return self.scores_api(conn, method, body)

        if head == "vto":
            return self.vto_api(conn, method, parts, body)

        if head in RESOURCES:
            return self.crud(conn, method, head, parts[1] if len(parts) > 1 else None, body)

        raise ApiError(404, "Not found")

    def user_fields(self, body, need_pw):
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip()
        pw = str(body.get("password", ""))
        if not name:
            raise ApiError(400, "Name is required")
        if "@" not in email:
            raise ApiError(400, "A valid email is required")
        if need_pw and len(pw) < 8:
            raise ApiError(400, "Password must be at least 8 characters")
        return name, email, pw

    def update_self(self, conn, body):
        u = self.user
        name = str(body.get("name", u["name"])).strip() or u["name"]
        email = str(body.get("email", u["email"])).strip() or u["email"]
        conn.execute("UPDATE users SET name=?, email=? WHERE id=?", (name, email, u["id"]))
        if body.get("new_password"):
            if not check_password(str(body.get("current_password", "")), u["pw_hash"]):
                raise ApiError(400, "Current password is incorrect")
            if len(body["new_password"]) < 8:
                raise ApiError(400, "Password must be at least 8 characters")
            conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body["new_password"]), u["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=? AND token<>?", (u["id"], self.token))
        return public_user(conn.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone())

    def set_calendar(self, conn, body):
        url = str(body.get("url") or "").strip()
        old = self.user["ical_url"]
        if old:
            calendar_feed.forget(old)
        if not url:
            conn.execute("UPDATE users SET ical_url=NULL WHERE id=?", (self.user["id"],))
            return {"ok": True, "has_calendar": False}
        try:
            url = calendar_feed.normalize_url(url)
            text = calendar_feed.fetch(url, use_cache=False)
            now = datetime.now(timezone.utc)
            calendar_feed.busy_blocks(text, now, now + timedelta(days=7))
        except calendar_feed.FeedError as e:
            raise ApiError(400, str(e))
        except Exception:
            traceback.print_exc()
            raise ApiError(400, "Downloaded the calendar but couldn't read it.")
        conn.execute("UPDATE users SET ical_url=? WHERE id=?", (url, self.user["id"]))
        return {"ok": True, "has_calendar": True}

    def availability(self, conn):
        def parse(q, default):
            v = self.query.get(q)
            if not v:
                return default
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc)
            except ValueError:
                raise ApiError(400, f"Invalid {q}")
        start = parse("start", datetime.now(timezone.utc))
        end = parse("end", start + timedelta(days=7))
        if end <= start or end - start > timedelta(days=45):
            raise ApiError(400, "Range must be between 0 and 45 days")
        users = conn.execute("SELECT id, ical_url FROM users WHERE ical_url IS NOT NULL AND ical_url <> ''").fetchall()

        def one(u):
            out = {"user_id": u["id"], "busy": [], "allday": [], "error": None}
            try:
                res = calendar_feed.busy_blocks(calendar_feed.fetch(u["ical_url"]), start, end)
                iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
                out["busy"] = [[iso(s), iso(e)] for s, e in res["busy"]]
                out["allday"] = [d.isoformat() for d in res["allday"]]
            except calendar_feed.FeedError as e:
                out["error"] = str(e)
            except Exception:
                traceback.print_exc()
                out["error"] = "Couldn't read this calendar."
            return out

        with ThreadPoolExecutor(max_workers=8) as pool:
            return list(pool.map(one, users))

    def require_admin(self):
        if not self.user["is_admin"]:
            raise ApiError(403, "Admins only")

    def users_api(self, conn, method, parts, body):
        uid = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        if method == "GET":
            return [public_user(r) for r in conn.execute("SELECT * FROM users ORDER BY name COLLATE NOCASE")]
        self.require_admin()
        if method == "POST":
            name, email, pw = self.user_fields(body, need_pw=True)
            cur = conn.execute(
                "INSERT INTO users(name,email,pw_hash,is_admin,created_at) VALUES (?,?,?,?,?)",
                (name, email, hash_password(pw), 1 if body.get("is_admin") else 0, now_iso()))
            return public_user(conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())
        if uid is None:
            raise ApiError(404, "Not found")
        target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            raise ApiError(404, "User not found")
        if method == "PUT":
            name = str(body.get("name", target["name"])).strip() or target["name"]
            email = str(body.get("email", target["email"])).strip() or target["email"]
            is_admin = target["is_admin"]
            if "is_admin" in body and uid != self.user["id"]:
                is_admin = 1 if body["is_admin"] else 0
            conn.execute("UPDATE users SET name=?, email=?, is_admin=? WHERE id=?", (name, email, is_admin, uid))
            if body.get("password"):
                if len(body["password"]) < 8:
                    raise ApiError(400, "Password must be at least 8 characters")
                conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body["password"]), uid))
                conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            return public_user(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        if method == "DELETE":
            if uid == self.user["id"]:
                raise ApiError(400, "You can't delete yourself")
            conn.execute("DELETE FROM users WHERE id=?", (uid,))
            for table, (single, multi) in MULTI_OWNER.items():
                tag = f",{uid},"
                for r in conn.execute(f"SELECT id, {multi} FROM {table} WHERE {multi} LIKE ?", (f"%{tag}%",)).fetchall():
                    ids = [i for i in decode_ids(r[multi], None) if i != uid]
                    conn.execute(f"UPDATE {table} SET {multi}=?, {single}=? WHERE id=?",
                                 (encode_ids(ids), ids[0] if ids else None, r["id"]))
            return {"ok": True}
        raise ApiError(405, "Method not allowed")

    def out(self, name, r):
        d = row(r)
        if d is not None and name in MULTI_OWNER:
            single, multi = MULTI_OWNER[name]
            d[multi] = decode_ids(d.get(multi), d.get(single))
        return d

    def crud(self, conn, method, name, ident, body):
        spec = RESOURCES[name]
        multi = MULTI_OWNER.get(name)
        cols = spec["cols"]
        if ident is not None and not ident.isdigit():
            raise ApiError(404, "Not found")
        rid = int(ident) if ident else None

        if method == "GET":
            if rid:
                r = conn.execute(f"SELECT * FROM {name} WHERE id=?", (rid,)).fetchone()
                if not r:
                    raise ApiError(404, "Not found")
                return self.out(name, r)
            where, args = [], []
            for k, v in self.query.items():
                if multi and k == multi[0]:  # "owned by X" matches any of the owners
                    where.append(f"({multi[0]} = ? OR {multi[1]} LIKE ?)")
                    args += [v, f"%,{v},%"]
                elif k in cols or k == "id":
                    where.append(f"{k} = ?")
                    args.append(v)
            if "since" in self.query and name == "todos":
                where.append("(done = 0 OR done_at >= ?)")
                args.append(self.query["since"])
            sql = f"SELECT * FROM {name}"
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += f" ORDER BY {spec['order']}"
            return [self.out(name, r) for r in conn.execute(sql, args)]

        if spec.get("admin_write"):
            self.require_admin()

        values = {}
        for k, v in body.items():
            if k in cols:
                val = coerce(cols[k], v, k)
                ch = spec.get("choices", {}).get(k)
                if ch and val is not None and val not in ch:
                    raise ApiError(400, f"{k} must be one of {', '.join(ch)}")
                values[k] = val
        if multi and multi[1] in body:
            raw = body[multi[1]] or []
            if not isinstance(raw, list):
                raise ApiError(400, f"{multi[1]} must be a list")
            ids = []
            for x in raw:
                i = coerce(int, x, multi[1])
                if i and i not in ids:
                    ids.append(i)
            values[multi[1]] = encode_ids(ids)
            values[multi[0]] = ids[0] if ids else None
        elif multi and multi[0] in values:
            values[multi[1]] = encode_ids([values[multi[0]]] if values[multi[0]] else [])

        required = spec.get("required", "title")
        if method == "POST":
            if not values.get(required):
                raise ApiError(400, f"{required.capitalize()} is required")
            if spec.get("team") and not values.get("team_id"):
                raise ApiError(400, "team_id is required")
            values["created_at"] = now_iso()
            if name == "todos" and values.get("done"):
                values["done_at"] = now_iso()
            if name == "issues" and values.get("status") == "solved":
                values["solved_at"] = now_iso()
            keys = list(values)
            cur = conn.execute(
                f"INSERT INTO {name}({','.join(keys)}) VALUES ({','.join('?' * len(keys))})",
                [values[k] for k in keys])
            return self.out(name, conn.execute(f"SELECT * FROM {name} WHERE id=?", (cur.lastrowid,)).fetchone())

        if rid is None:
            raise ApiError(404, "Not found")
        existing = conn.execute(f"SELECT * FROM {name} WHERE id=?", (rid,)).fetchone()
        if not existing:
            raise ApiError(404, "Not found")

        if method == "PUT":
            if required in values and not values[required]:
                raise ApiError(400, f"{required.capitalize()} is required")
            if name == "todos" and "done" in values:
                values["done_at"] = (existing["done_at"] or now_iso()) if values["done"] else None
            if name == "issues" and "status" in values:
                values["solved_at"] = (existing["solved_at"] or now_iso()) if values["status"] == "solved" else None
            if name == "seats" and values.get("parent_id") == rid:
                raise ApiError(400, "A seat can't report to itself")
            if values:
                sets = ", ".join(f"{k}=?" for k in values)
                conn.execute(f"UPDATE {name} SET {sets} WHERE id=?", [*values.values(), rid])
            return self.out(name, conn.execute(f"SELECT * FROM {name} WHERE id=?", (rid,)).fetchone())

        if method == "DELETE":
            if name == "seats":  # children move up to the deleted seat's parent
                conn.execute("UPDATE seats SET parent_id=? WHERE parent_id=?", (existing["parent_id"], rid))
            conn.execute(f"DELETE FROM {name} WHERE id=?", (rid,))
            return {"ok": True}

        raise ApiError(405, "Method not allowed")

    def scores_api(self, conn, method, body):
        if method == "GET":
            team = self.query.get("team_id")
            since = self.query.get("since", "0000")
            if not team:
                raise ApiError(400, "team_id is required")
            rows = conn.execute(
                "SELECT s.* FROM scores s JOIN measurables m ON m.id = s.measurable_id "
                "WHERE m.team_id = ? AND s.week >= ?", (team, since))
            return [row(r) for r in rows]
        if method == "PUT":
            mid = coerce(int, body.get("measurable_id"), "measurable_id")
            week = str(body.get("week", ""))
            if not mid or len(week) != 10:
                raise ApiError(400, "measurable_id and week (YYYY-MM-DD) are required")
            value = coerce(float, body.get("value"), "value")
            if value is None:
                conn.execute("DELETE FROM scores WHERE measurable_id=? AND week=?", (mid, week))
            else:
                conn.execute(
                    "INSERT INTO scores(measurable_id, week, value) VALUES (?,?,?) "
                    "ON CONFLICT(measurable_id, week) DO UPDATE SET value=excluded.value", (mid, week, value))
            return {"ok": True}
        raise ApiError(405, "Method not allowed")

    def vto_api(self, conn, method, parts, body):
        if len(parts) < 2 or not parts[1].isdigit():
            raise ApiError(400, "Team id required")
        tid = int(parts[1])
        if method == "GET":
            r = conn.execute("SELECT * FROM vto WHERE team_id=?", (tid,)).fetchone()
            return {"team_id": tid, "data": json.loads(r["data"]) if r else {},
                    "updated_at": r["updated_at"] if r else None}
        if method == "PUT":
            data = body.get("data")
            if not isinstance(data, dict):
                raise ApiError(400, "data must be an object")
            conn.execute(
                "INSERT INTO vto(team_id, data, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(team_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                (tid, json.dumps(data), now_iso()))
            return {"ok": True, "updated_at": now_iso()}
        raise ApiError(405, "Method not allowed")


def drop_privileges():
    """When started as root (as in Docker), own the data folder and switch to PUID/PGID."""
    if not hasattr(os, "getuid") or os.getuid() != 0:
        return
    uid = int(os.environ.get("PUID", "99"))
    gid = int(os.environ.get("PGID", "100"))
    if uid == 0:
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    for root, dirs, files in os.walk(DATA_DIR):
        for p in [root] + [os.path.join(root, f) for f in files]:
            try:
                os.chown(p, uid, gid)
            except OSError:
                pass
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def main():
    drop_privileges()
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"Tenfold {VERSION} running on http://{HOST}:{PORT}  (data: {DB_PATH})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
