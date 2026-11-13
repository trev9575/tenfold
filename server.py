#!/usr/bin/env python3
"""
Tenfold - a small, self-hosted EOS-style team tool.

Zero external dependencies: Python 3.10+ standard library + SQLite.
Run:  python3 server.py      (then open http://localhost:8090)
"""
import base64
import csv
import hashlib
import io
import re
import hmac
import json
import mimetypes
import zipfile
import os
import secrets
import sqlite3
import sys
import time
import queue
import threading
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
VERSION = "1.6.0"

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
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
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
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT 'gray',
  is_done INTEGER NOT NULL DEFAULT 0,
  sort REAL DEFAULT 0,
  created_at TEXT NOT NULL
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
    "seats": dict(cols={"team_id": int, "parent_id": int, "title": str, "roles": str, "user_id": int, "sort": int},
                  team=True, order="sort, id"),
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
    # To-dos double as kanban tasks: a to-do with a board_id is a card on that board.
    "todos": dict(cols={"team_id": int, "title": str, "description": str, "owner_id": int,
                        "due_date": str, "done": int, "issue_id": int,
                        "board_id": int, "column_id": int, "sort": float, "milestone": int, "rock_id": int,
                        "ext_key": str, "priority": str, "project": str, "phase": str, "workstream": str},
                  team=True, order="done, due_date IS NULL, due_date, id"),
    "boards": dict(cols={"team_id": int, "name": str, "sort": float}, required="name", team=True, order="sort, id"),
    "board_columns": dict(cols={"board_id": int, "name": str, "color": str, "is_done": int, "sort": float},
                          required="name", parent=("board_id",), order="sort, id",
                          choices={"color": ("gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")}),
    "headlines": dict(cols={"team_id": int, "title": str, "owner_id": int, "kind": str, "archived": int},
                      choices={"kind": ("customer", "employee", "general")}, team=True,
                      order="archived, created_at DESC"),
    "meetings": dict(cols={"team_id": int, "title": str, "started_at": str, "ended_at": str,
                           "rating": float, "notes": str, "data": str},
                     team=True, order="COALESCE(started_at, created_at) DESC"),
}


# Resources that can have several owners. The first owner is also kept in the
# single-owner column so sorting and older data keep working.
DEFAULT_COLUMNS = [("Not started", "gray", 0), ("In progress", "blue", 0), ("Done", "green", 1)]
TODO_TASK_COLUMNS = [  # added to the to-dos table by migration
    ("board_id", "INTEGER REFERENCES boards(id) ON DELETE CASCADE"),
    ("column_id", "INTEGER REFERENCES board_columns(id) ON DELETE SET NULL"),
    ("sort", "REAL DEFAULT 0"), ("milestone", "INTEGER NOT NULL DEFAULT 0"),
    ("rock_id", "INTEGER REFERENCES rocks(id) ON DELETE SET NULL"),
    ("ext_key", "TEXT"), ("priority", "TEXT"), ("project", "TEXT"), ("phase", "TEXT"), ("workstream", "TEXT"),
]

MULTI_OWNER = {
    "rocks": ("owner_id", "owner_ids"),
    "issues": ("owner_id", "owner_ids"),
    "headlines": ("owner_id", "owner_ids"),
    "measurables": ("owner_id", "owner_ids"),
    "seats": ("user_id", "user_ids"),
    "todos": ("owner_id", "owner_ids"),
}


def encode_ids(ids):
    return "," + ",".join(str(i) for i in ids) + "," if ids else None


def decode_ids(text, fallback):
    if text:
        return [int(x) for x in text.strip(",").split(",") if x.strip().isdigit()]
    return [fallback] if fallback else []


class Hub:
    """Live updates: every open browser tab holds a Server-Sent Events stream."""

    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}  # client_id -> (user_id, queue)

    def subscribe(self, client_id, user_id):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.clients[client_id] = (user_id, q)
        self.publish_presence()
        return q

    def unsubscribe(self, client_id, q):
        with self.lock:
            if self.clients.get(client_id, (None, None))[1] is q:
                del self.clients[client_id]
        self.publish_presence()

    def online(self):
        with self.lock:
            return sorted({uid for uid, _ in self.clients.values()})

    def publish(self, event):
        data = json.dumps(event)
        with self.lock:
            targets = [q for _, q in self.clients.values()]
        for q in targets:
            try:
                q.put_nowait(data)
            except queue.Full:
                pass  # a stuck client just misses events; it refreshes on reconnect

    def publish_presence(self):
        self.publish({"type": "presence", "online": self.online()})


HUB = Hub()
# API calls that change shared data and should notify everyone else.
SILENT_HEADS = {"login", "logout", "setup", "health", "status", "events"}


# ---------------------------------------------------------------- import helpers
STATUS_ORDER = ["backlog", "not started", "to do", "todo", "planned", "in progress", "doing", "blocked",
                "in review", "review", "done", "complete", "completed", "closed", "shipped"]
DONE_RE = re.compile(r"^(done|complete|completed|closed|shipped|finished)$", re.I)
TRUTHY = {"yes", "true", "checked", "1", "x", "y"}
STATUS_COLORS = {"not started": "gray", "backlog": "gray", "to do": "gray", "todo": "gray", "in progress": "blue",
                 "doing": "blue", "blocked": "red", "in review": "purple", "review": "purple"}


def read_import_file(filename, data_b64):
    try:
        raw = base64.b64decode(data_b64, validate=False)
    except Exception:
        raise ApiError(400, "Couldn't read the uploaded file")
    if not raw:
        raise ApiError(400, "The file is empty")
    if len(raw) > 20 * 1024 * 1024:
        raise ApiError(400, "That file is too large (20 MB max)")
    name = filename or "import.csv"
    if raw[:2] == b"PK":
        def csv_entries(z):
            found = []
            for info in z.infolist():
                low = info.filename.lower()
                if low.endswith(".csv"):
                    found.append((info, z))
                elif low.endswith(".zip"):  # Notion sometimes nests a zip inside the zip
                    inner = zipfile.ZipFile(io.BytesIO(z.read(info)))
                    found += csv_entries(inner)
            return found
        try:
            entries = csv_entries(zipfile.ZipFile(io.BytesIO(raw)))
        except zipfile.BadZipFile:
            raise ApiError(400, "That zip file looks damaged")
        if not entries:
            raise ApiError(400, "No CSV file inside that zip. In Notion, export the database as 'Markdown & CSV'.")
        # Notion's "_all.csv" has every property; otherwise take the biggest CSV
        entries.sort(key=lambda e: ("_all" not in e[0].filename, -e[0].file_size))
        info, z = entries[0]
        raw, name = z.read(info), info.filename.rsplit("/", 1)[-1]
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ApiError(400, "That CSV has no header row")
    fields = {f.strip().lower(): f for f in reader.fieldnames if f}
    pick = lambda *names: next((fields[n] for n in names if n in fields), None)
    f_title = pick("name", "title", "task", "task name")
    if not f_title:
        raise ApiError(400, "Couldn't find a Name or Title column")
    f = {k: pick(*v) for k, v in {
        "status": ("status", "stage", "state"), "due": ("due", "due date", "deadline", "date"),
        "notes": ("notes", "description", "details"), "key": ("id", "key", "task id"),
        "priority": ("priority",), "project": ("project",), "phase": ("phase", "sprint"),
        "workstream": ("workstream", "area", "team"), "assignees": ("assignees", "assignee"),
        "owner": ("owner", "owners", "person", "people"), "rock": ("rock",), "milestone": ("milestone", "is milestone"),
    }.items()}
    rows = []
    for rec in reader:
        get = lambda k: (rec.get(f[k]) or "").strip() if f.get(k) else ""
        title = (rec.get(f_title) or "").strip()
        others = [v for k, v in rec.items() if k not in (f_title, "From log") and (v or "").strip()]
        if not title or not others:  # skip blank rows and the parent page row Notion adds
            continue
        people_src = get("assignees") if f.get("assignees") else get("owner")
        rows.append({
            "title": title, "status": get("status"), "due": parse_due(get("due")), "notes": get("notes"),
            "key": get("key"), "priority": get("priority"), "project": get("project"), "phase": get("phase"),
            "workstream": get("workstream"),
            "people": [p.strip() for p in re.split(r"[,;]", people_src) if p.strip()],
            "rock": get("rock") if f.get("rock") else get("project"),
            "milestone": get("milestone").lower() in TRUTHY,
        })
    if not rows:
        raise ApiError(400, "No tasks found in that file")
    for r in rows:
        r["_people_field"] = "Assignees" if f.get("assignees") else ("Owner" if f.get("owner") else None)
        r["_rock_field"] = "Rock" if f.get("rock") else ("Project" if f.get("project") else None)
    stem = re.sub(r"\s+[0-9a-f]{32}$", "", re.sub(r"_all$", "", name.rsplit(".", 1)[0])).strip()
    return rows, stem or "Imported board"


def parse_due(v):
    v = (v or "").split("→")[0].strip()
    if not v:
        return None
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y/%m/%d", "%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y %I:%M %p", "%d/%m/%Y"):
        try:
            return datetime.strptime(v, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    m = re.match(r"(\d{4}-\d{2}-\d{2})", v)
    return m.group(1) if m else None


def analyze_import(rows):
    statuses = []
    for r in rows:
        if r["status"] and r["status"] not in statuses:
            statuses.append(r["status"])
    if not statuses:
        statuses = ["Not started"]
    rank = lambda s: STATUS_ORDER.index(s.lower()) if s.lower() in STATUS_ORDER else 5.5
    statuses.sort(key=rank)
    if not any(DONE_RE.match(s) for s in statuses):
        statuses.append("Done")
    columns = [{"name": s, "is_done": bool(DONE_RE.match(s)), "count": sum(1 for r in rows if (r["status"] or statuses[0]) == s),
                "color": "green" if DONE_RE.match(s) else STATUS_COLORS.get(s.lower(), "gray")} for s in statuses]
    people, rock_values = {}, {}
    for r in rows:
        for p in r["people"]:
            people[p] = people.get(p, 0) + 1
        if r["rock"]:
            rock_values[r["rock"]] = rock_values.get(r["rock"], 0) + 1
    return {
        "columns": columns, "milestones": sum(1 for r in rows if r["milestone"]),
        "people": sorted(people.items(), key=lambda x: -x[1]), "rock_values": sorted(rock_values.items(), key=lambda x: -x[1]),
        "people_field": rows[0]["_people_field"], "rock_field": rows[0]["_rock_field"],
    }


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def guess_people(name, users):
    n = _norm(name)
    if not n:
        return []
    for u in users:
        if _norm(u["name"]) == n or _norm(u["email"].split("@")[0]) == n:
            return [u["id"]]
    firsts = [u for u in users if _norm(u["name"]).split(" ")[0] == n.split(" ")[0]]
    return [firsts[0]["id"]] if len(firsts) == 1 else []


def guess_rock(value, rocks):
    n = _norm(value)
    if not n:
        return None
    for r in rocks:
        if _norm(r["title"]) == n:
            return r["id"]
    for r in rocks:
        t = _norm(r["title"])
        if t and (t in n or n in t):
            return r["id"]
    words = {w for w in n.split() if len(w) >= 4}
    best, score = None, 0
    for r in rocks:
        overlap = len(words & {w for w in _norm(r["title"] + " " + (r["description"] or "")).split() if len(w) >= 4})
        if overlap > score:
            best, score = r["id"], overlap
    return best


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
    # Migration: accountability charts became per-team. Older seats move to the first team.
    seat_cols = {r["name"] for r in conn.execute("PRAGMA table_info(seats)")}
    if "team_id" not in seat_cols:
        conn.execute("ALTER TABLE seats ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE")
        conn.execute("UPDATE seats SET team_id = (SELECT MIN(id) FROM teams) WHERE team_id IS NULL")
    todo_cols = {r["name"] for r in conn.execute("PRAGMA table_info(todos)")}
    for col, decl in TODO_TASK_COLUMNS:
        if col not in todo_cols:
            conn.execute(f"ALTER TABLE todos ADD COLUMN {col} {decl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_board ON todos(board_id)")
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
        self.client_id = (self.headers.get("X-Client-Id") or "")[:64]
        self._body = {}
        if path == "/api/events" and method == "GET":
            self.events_stream()
            return
        if path.startswith("/api/"):
            conn = db()
            try:
                parts = [p for p in path[5:].split("/") if p]
                result = self.api(conn, method, parts)
                conn.commit()
                self.send_json(200, result if result is not None else {"ok": True})
                if method != "GET" and parts and parts[0] not in SILENT_HEADS:
                    self.announce(parts, result)
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
            self._body = data
            return data
        return {}

    def announce(self, parts, result):
        user = getattr(self, "user", None)
        team = None
        if isinstance(result, dict) and result.get("team_id"):
            team = result["team_id"]
        elif self._body.get("team_id"):
            team = self._body.get("team_id")
        elif parts[0] == "vto" and len(parts) > 1 and parts[1].isdigit():
            team = int(parts[1])
        resource = {"me": "users", "register": "users", "invite": "settings", "scores": "measurables", "import": "boards"}.get(parts[0], parts[0])
        if parts[0] == "me" and len(parts) > 1 and parts[1] == "calendar":
            resource = "availability"
        HUB.publish({
            "type": "change", "resource": resource, "team_id": team, "method": self.command,
            "user_id": user["id"] if user else None, "client": self.client_id,
        })

    def events_stream(self):
        conn = db()
        try:
            user = self.current_user(conn)
        finally:
            conn.close()
        if not user:
            self.send_json(401, {"error": "Not signed in"})
            return
        client_id = (self.query.get("client") or secrets.token_hex(8))[:64]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")  # tell nginx-style proxies not to buffer
        self.end_headers()
        self.close_connection = True
        q = HUB.subscribe(client_id, user["id"])
        try:
            hello = json.dumps({"type": "hello", "version": VERSION, "online": HUB.online()})
            self.wfile.write(f"retry: 3000\ndata: {hello}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=20)
                    self.wfile.write(f"data: {data}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # keeps proxies from closing an idle stream
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unsubscribe(client_id, q)

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

        if head == "import":
            return self.import_api(conn, method, parts, body)

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

        if name == "seats" and values.get("parent_id"):
            parent = conn.execute("SELECT team_id FROM seats WHERE id=?", (values["parent_id"],)).fetchone()
            team = values.get("team_id")
            if team is None and ident:
                cur_row = conn.execute("SELECT team_id FROM seats WHERE id=?", (int(ident),)).fetchone()
                team = cur_row["team_id"] if cur_row else None
            if not parent or parent["team_id"] != team:
                raise ApiError(400, "A seat can only report to a seat on the same team")

        if name == "todos" and method in ("POST", "PUT"):
            self.sync_task_column(conn, values, rid)

        required = spec.get("required", "title")
        if method == "POST":
            if not values.get(required):
                raise ApiError(400, f"{required.capitalize()} is required")
            if spec.get("team") and not values.get("team_id"):
                raise ApiError(400, "team_id is required")
            for fk in spec.get("parent", ()):
                if not values.get(fk):
                    raise ApiError(400, f"{fk} is required")
            values["created_at"] = now_iso()
            if name == "todos" and values.get("done"):
                values["done_at"] = now_iso()
            if name == "issues" and values.get("status") == "solved":
                values["solved_at"] = now_iso()
            keys = list(values)
            cur = conn.execute(
                f"INSERT INTO {name}({','.join(keys)}) VALUES ({','.join('?' * len(keys))})",
                [values[k] for k in keys])
            if name == "boards":
                for i, (col_name, color, done) in enumerate(DEFAULT_COLUMNS):
                    conn.execute("INSERT INTO board_columns(board_id, name, color, is_done, sort, created_at) VALUES (?,?,?,?,?,?)",
                                 (cur.lastrowid, col_name, color, done, i, now_iso()))
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
            if name == "seats" and "team_id" in values and existing["team_id"] is not None and values["team_id"] != existing["team_id"]:
                raise ApiError(400, "Seats can't be moved to another team")
            if values:
                sets = ", ".join(f"{k}=?" for k in values)
                conn.execute(f"UPDATE {name} SET {sets} WHERE id=?", [*values.values(), rid])
            if name == "board_columns" and "is_done" in values and values["is_done"] != existing["is_done"]:
                d = 1 if values["is_done"] else 0
                conn.execute("UPDATE todos SET done=?, done_at=CASE WHEN ?=1 THEN COALESCE(done_at, ?) ELSE NULL END "
                             "WHERE column_id=?", (d, d, now_iso(), rid))
            return self.out(name, conn.execute(f"SELECT * FROM {name} WHERE id=?", (rid,)).fetchone())

        if method == "DELETE":
            if name == "board_columns":  # keep the tasks: move them to the nearest remaining column
                other = conn.execute(
                    "SELECT * FROM board_columns WHERE board_id=? AND id<>? ORDER BY ABS(sort - ?), sort LIMIT 1",
                    (existing["board_id"], rid, existing["sort"] or 0)).fetchone()
                if other:
                    top = conn.execute("SELECT COALESCE(MAX(sort), 0) FROM todos WHERE column_id=?", (other["id"],)).fetchone()[0]
                    conn.execute(
                        "UPDATE todos SET column_id=?, sort=sort+?, done=?, "
                        "done_at=CASE WHEN ?=1 THEN COALESCE(done_at, ?) ELSE NULL END WHERE column_id=?",
                        (other["id"], top + 1, other["is_done"], other["is_done"], now_iso(), rid))
            if name == "seats":  # children move up to the deleted seat's parent
                conn.execute("UPDATE seats SET parent_id=? WHERE parent_id=?", (existing["parent_id"], rid))
            conn.execute(f"DELETE FROM {name} WHERE id=?", (rid,))
            return {"ok": True}

        raise ApiError(405, "Method not allowed")

    def sync_task_column(self, conn, values, rid):
        """Keep a task's column and its to-do checkbox in step: Done column <-> checked."""
        existing = conn.execute("SELECT * FROM todos WHERE id=?", (rid,)).fetchone() if rid else None
        board = values["board_id"] if "board_id" in values else (existing["board_id"] if existing else None)
        if not board:
            if values.get("column_id"):
                raise ApiError(400, "A column needs a board")
            return
        cols = conn.execute("SELECT * FROM board_columns WHERE board_id=? ORDER BY sort, id", (board,)).fetchall()
        if not cols:
            return
        by_id = {c["id"]: c for c in cols}
        end_sort = lambda cid: conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM todos WHERE column_id=?", (cid,)).fetchone()[0]
        first = lambda done: next((c for c in cols if bool(c["is_done"]) == done), cols[0])
        if values.get("column_id"):
            col = by_id.get(values["column_id"])
            if not col:
                raise ApiError(400, "That column isn't on this board")
            values["done"] = 1 if col["is_done"] else 0
            if "sort" not in values and (not existing or existing["column_id"] != col["id"]):
                values["sort"] = end_sort(col["id"])
            return
        current = by_id.get(existing["column_id"]) if existing and existing["column_id"] else None
        if current is None:  # new task, or a task that just joined this board
            target = first(bool(values.get("done")))
        elif "done" in values and bool(values["done"]) != bool(current["is_done"]):
            target = first(bool(values["done"]))
        else:
            return
        values["column_id"] = target["id"]
        values["done"] = 1 if target["is_done"] else 0
        if "sort" not in values:
            values["sort"] = end_sort(target["id"])

    # ---------- Notion / CSV import ----------
    def import_api(self, conn, method, parts, body):
        if method != "POST" or len(parts) < 2 or parts[1] not in ("preview", "run"):
            raise ApiError(404, "Not found")
        team_id = coerce(int, body.get("team_id"), "team_id")
        if not team_id or not conn.execute("SELECT 1 FROM teams WHERE id=?", (team_id,)).fetchone():
            raise ApiError(400, "Pick a team first")
        rows, source_name = read_import_file(str(body.get("filename") or ""), str(body.get("data") or ""))
        info = analyze_import(rows)
        users = [dict(u) for u in conn.execute("SELECT id, name, email FROM users")]
        rocks = [dict(r) for r in conn.execute(
            "SELECT id, title, description, owner_id, owner_ids, due_date, quarter, status FROM rocks WHERE team_id=? "
            "ORDER BY status='done', quarter DESC, id", (team_id,))]
        if parts[1] == "preview":
            return {
                "board_name": body.get("board_name") or source_name,
                "total": len(rows), "milestones": info["milestones"], "columns": info["columns"],
                "people_field": info["people_field"], "rock_field": info["rock_field"],
                "people": [{"name": n, "count": c, "guess": guess_people(n, users)} for n, c in info["people"]],
                "rock_values": [{"name": n, "count": c, "guess": guess_rock(n, rocks)} for n, c in info["rock_values"]],
                "rocks": [{"id": r["id"], "title": r["title"], "quarter": r["quarter"]} for r in rocks],
            }
        people_map = body.get("people_map") or {}
        rock_map = body.get("rock_map") or {}
        board_name = str(body.get("board_name") or source_name).strip()[:200] or "Imported board"
        valid_users = {u["id"] for u in users}
        rock_by_id = {r["id"]: r for r in rocks}
        now = now_iso()
        cur = conn.execute("INSERT INTO boards(team_id, name, sort, created_at) VALUES (?,?,?,?)",
                           (team_id, board_name, time.time(), now))
        board_id = cur.lastrowid
        col_ids = {}
        for i, c in enumerate(info["columns"]):
            col_ids[c["name"]] = (conn.execute(
                "INSERT INTO board_columns(board_id, name, color, is_done, sort, created_at) VALUES (?,?,?,?,?,?)",
                (board_id, c["name"], c["color"], 1 if c["is_done"] else 0, i, now)).lastrowid, c["is_done"])
        sort_in = {}
        made = milestones = 0
        for r in rows:
            status = r["status"] or info["columns"][0]["name"]
            col_id, is_done = col_ids[status]
            owners = []
            for person in r["people"]:
                for uid in people_map.get(person) or []:
                    uid = int(uid)
                    if uid in valid_users and uid not in owners:
                        owners.append(uid)
            rock_id = rock_map.get(r["rock"]) if r["rock"] else None
            rock_id = int(rock_id) if rock_id and int(rock_id) in rock_by_id else None
            due = r["due"] or (rock_by_id[rock_id]["due_date"] if r["milestone"] and rock_id else None)
            sort_in[col_id] = sort_in.get(col_id, -1) + 1
            conn.execute(
                "INSERT INTO todos(team_id, title, description, owner_id, owner_ids, due_date, done, done_at, board_id, column_id, "
                "sort, milestone, rock_id, ext_key, priority, project, phase, workstream, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (team_id, r["title"][:500], r["notes"] or None, owners[0] if owners else None, encode_ids(owners), due,
                 1 if is_done else 0, None, board_id, col_id,  # already-done imports don't count toward to-do stats sort_in[col_id], 1 if r["milestone"] else 0,
                 rock_id, r["key"] or None, r["priority"] or None, r["project"] or None, r["phase"] or None,
                 r["workstream"] or None, now))
            made += 1
            milestones += 1 if r["milestone"] else 0
        return {"board_id": board_id, "tasks": made, "milestones": milestones}

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
