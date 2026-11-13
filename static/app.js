/* Tenfold – single-page app (no build step, no dependencies) */
"use strict";

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (method !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch("/api/" + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && !path.startsWith("login")) { S.me = null; boot(); throw new Error("Signed out"); }
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

let toastTimer;
function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 2600);
}
async function safe(fn) {
  try { return await fn(); } catch (e) { if (e.message !== "Signed out") toast(e.message, true); }
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};

// dates
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
function weekStart(d = new Date()) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return ymd(x); }
const fmtDate = (s) => s ? parseYmd(s.slice(0, 10)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
function quarterOf(d = new Date()) { return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; }
function quarterEnd(q) { const [y, n] = q.split("-Q").map(Number); return ymd(new Date(y, n * 3, 0)); }
function nextQuarter(q) { let [y, n] = q.split("-Q").map(Number); n++; if (n > 4) { n = 1; y++; } return `${y}-Q${n}`; }
function prevQuarter(q) { let [y, n] = q.split("-Q").map(Number); n--; if (n < 1) { n = 4; y--; } return `${y}-Q${n}`; }
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return `${m}:${pad(s % 60)}`; };

// people
const COLORS = ["#1f6f5c", "#3b6fb6", "#a0522d", "#7b4fa8", "#b0425a", "#2f8f9d", "#8a7a1f", "#4d6b2f", "#c06a1b", "#555e9e"];
const userById = (id) => S.users.find((u) => u.id === id);
const userName = (id) => (userById(id) || {}).name || "Unassigned";
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
function avatar(id, big) {
  const u = userById(id);
  if (!u) return h("span", { class: "av none" + (big ? " lg" : ""), title: "Unassigned" }, "?");
  return h("span", { class: "av" + (big ? " lg" : ""), title: u.name, style: { background: COLORS[u.id % COLORS.length] } }, initials(u.name));
}
// Owners: items can have several owners (owner_ids); older items only have owner_id.
function ownersOf(x, single = "owner_id", multi = "owner_ids") {
  const ids = x && x[multi] && x[multi].length ? x[multi] : x && x[single] ? [x[single]] : [];
  return ids.map(Number).filter((id) => userById(id));
}
function avatars(ids) {
  if (!ids.length) return avatar(null);
  const shown = ids.slice(0, 4);
  return h("span", { class: "avs", title: ids.map(userName).join(", ") }, shown.map((id) => avatar(id)),
    ids.length > 4 ? h("span", { class: "av more" }, "+" + (ids.length - 4)) : null);
}
const ownerNames = (ids) => ids.length ? ids.map(userName).join(", ") : "Unassigned";
const idList = (v) => (v || []).map(Number);
const teamName = (id) => (S.teams.find((t) => t.id === id) || {}).name || "";
const userOptions = (blank = true) => [...(blank ? [["", "Unassigned"]] : []), ...S.users.map((u) => [u.id, u.name])];

// ---------------------------------------------------------------- state
const S = { me: null, users: [], teams: [], teamId: null, timers: [] };
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }

// ---------------------------------------------------------------- modal form
function openModal(title, bodyEl, footEls) {
  const root = $("#modal-root");
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const overlay = h("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "modal", role: "dialog", "aria-label": title },
      h("div", { class: "modal-head" }, h("h3", {}, title), h("button", { class: "x", onclick: close, "aria-label": "Close" }, "×")),
      h("div", { class: "modal-body" }, bodyEl),
      h("div", { class: "modal-foot" }, footEls(close))));
  root.innerHTML = "";
  root.append(overlay);
  const first = overlay.querySelector("input, textarea, select");
  if (first) first.focus();
  return close;
}

/* fields: [{name,label,type,options:[[v,l]],value,hint,required,half}] */
function formModal({ title, fields, submitLabel = "Save", onSubmit, onDelete, extraButtons }) {
  const inputs = {};
  const mk = (f) => {
    let el;
    if (f.type === "textarea") el = h("textarea", { name: f.name, rows: f.rows || 4 });
    else if (f.type === "select") el = h("select", { name: f.name }, f.options.map(([v, l]) => h("option", { value: v }, l)));
    else if (f.type === "checkbox") el = h("input", { type: "checkbox", name: f.name, class: "check" });
    else if (f.type === "multiselect") {
      const sel = new Set((f.value || []).map(String));
      const boxes = f.options.map(([v, l]) => {
        const cb = h("input", { type: "checkbox", value: v, checked: sel.has(String(v)) });
        return h("label", { class: "chip" }, cb, f.avatars ? avatar(Number(v)) : null, h("span", {}, l));
      });
      const all = h("button", { type: "button", class: "btn small", onclick: () => {
        const cbs = el.querySelectorAll("input"); const every = [...cbs].every((c) => c.checked);
        cbs.forEach((c) => (c.checked = !every));
      } }, "Everyone");
      el = h("div", { class: "chips" }, boxes, all);
    }
    else el = h("input", { type: f.type || "text", name: f.name, step: f.step, placeholder: f.placeholder || "" });
    if (f.type === "checkbox") el.checked = !!f.value;
    else if (f.type === "multiselect") { /* set above */ }
    else el.value = f.value == null ? "" : f.value;
    inputs[f.name] = el;
    return h("div", { class: "field" }, h("label", {}, f.label), el, f.hint && h("div", { class: "hint" }, f.hint));
  };
  const body = h("form", { onsubmit: (e) => { e.preventDefault(); submit(); } });
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.half && fields[i + 1] && fields[i + 1].half) { body.append(h("div", { class: "row-fields" }, mk(f), mk(fields[i + 1]))); i += 2; }
    else { body.append(mk(f)); i++; }
  }
  body.append(h("button", { type: "submit", style: { display: "none" } }));
  let close;
  const values = () => {
    const v = {};
    for (const f of fields) {
      const el = inputs[f.name];
      if (f.type === "multiselect") { const ids = [...el.querySelectorAll("input:checked")].map((c) => c.value); v[f.name] = ids.length ? ids : null; continue; }
      v[f.name] = f.type === "checkbox" ? (el.checked ? 1 : 0) : el.value.trim() === "" ? null : el.value.trim();
    }
    return v;
  };
  async function submit() {
    const v = values();
    for (const f of fields) if (f.required && !v[f.name]) { toast(f.type === "multiselect" ? `Pick at least one of the ${f.label.toLowerCase()}` : `${f.label} is required`, true); (inputs[f.name].querySelector("input") || inputs[f.name]).focus(); return; }
    await safe(async () => { await onSubmit(v); close(); });
  }
  close = openModal(title, body, (c) => [
    onDelete ? h("button", { class: "btn danger", type: "button", onclick: async () => { if (confirm("Delete this? This can't be undone.")) await safe(async () => { await onDelete(); c(); }); } }, "Delete") : null,
    ...(extraButtons ? extraButtons(c, values) : []),
    h("span", { class: "spacer" }),
    h("button", { class: "btn", type: "button", onclick: c }, "Cancel"),
    h("button", { class: "btn primary", type: "button", onclick: submit }, submitLabel),
  ]);
}

// ---------------------------------------------------------------- shell & routing
const NAV = [
  ["#/home", "⌂", "My 90"],
  ["#/meetings", "◷", "Meetings"],
  ["#/scorecard", "▦", "Scorecard"],
  ["#/rocks", "◆", "Rocks"],
  ["#/todos", "✓", "To-Dos"],
  ["#/issues", "!", "Issues"],
  ["#/headlines", "❝", "Headlines"],
  ["#/availability", "▥", "Availability"],
  ["sep"],
  ["#/vto", "◎", "Vision / Traction"],
  ["#/chart", "⑂", "Accountability Chart"],
  ["sep"],
  ["#/settings", "⚙", "Settings"],
];

function renderShell() {
  const app = $("#app");
  app.innerHTML = "";
  const teamSel = h("select", { "aria-label": "Team", onchange: (e) => { S.teamId = Number(e.target.value); store.set("tf_team", S.teamId); route(); } },
    S.teams.map((t) => h("option", { value: t.id, selected: t.id === S.teamId }, t.name)));
  const side = h("aside", { class: "side" },
    h("div", { class: "brand" }, h("div", { class: "brand-mark" }, "10"), "Tenfold"),
    S.teams.length ? teamSel : null,
    h("nav", { class: "nav" }, NAV.map(([href, ico, label]) => href === "sep" ? h("div", { class: "nav-sep" }) :
      h("a", { href, "data-href": href, onclick: () => side.classList.remove("open") }, h("span", { class: "ico" }, ico), label))),
    h("div", { class: "side-foot" }, h("div", {}, S.me.name), h("button", { onclick: logout }, "Sign out")));
  const main = h("main", { class: "main", id: "view" });
  app.append(h("div", { class: "shell" }, side, main));
}

async function logout() { await safe(() => api("POST", "logout")); S.me = null; location.hash = ""; boot(); }

const ROUTES = {
  home: pageHome, meetings: pageMeetings, meeting: pageMeeting, scorecard: pageScorecard, rocks: pageRocks,
  todos: pageTodos, issues: pageIssues, availability: pageAvailability, headlines: pageHeadlines, vto: pageVto, chart: pageChart, settings: pageSettings,
};

async function route() {
  if (!S.me) return;
  clearTimers();
  const [name, arg] = (location.hash.replace(/^#\/?/, "") || "home").split("/");
  const fn = ROUTES[name] || pageHome;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.href === "#/" + (name === "meeting" ? "meetings" : name)));
  const view = $("#view");
  if (!view) return;
  // Fresh container per navigation, so a slow page that finishes late renders into a detached node.
  const page = h("div");
  view.replaceChildren(page);
  await safe(() => fn(page, arg));
}

function pageHead(title, sub, ...actions) {
  const menu = h("button", { class: "btn menu-btn", onclick: () => $(".side").classList.toggle("open"), "aria-label": "Menu" }, "☰");
  return h("div", { class: "page-head" }, menu, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null),
    h("span", { class: "spacer" }), h("div", { class: "toolbar" }, actions));
}

function needTeam(view) {
  if (S.teamId) return false;
  view.append(pageHead("No team yet"), h("div", { class: "card card-body" },
    S.me.is_admin ? ["Create a team first in ", h("a", { href: "#/settings" }, "Settings"), "."] : "Ask an admin to create a team."));
  return true;
}

// ---------------------------------------------------------------- boot / auth
async function boot() {
  clearTimers();
  const app = $("#app");
  try {
    S.me = await fetch("/api/me").then((r) => (r.ok ? r.json() : null));
  } catch (e) { S.me = null; }
  if (!S.me) {
    const st = await fetch("/api/status").then((r) => r.json());
    if (st.needs_setup) return renderSetup(app);
    const join = location.hash.match(/^#\/join\/([^/?]+)/);
    if (join) return renderRegister(app, decodeURIComponent(join[1]));
    return renderLogin(app, st.signup_open);
  }
  await loadBasics();
  renderShell();
  route();
}

async function loadBasics() {
  [S.users, S.teams] = await Promise.all([api("GET", "users"), api("GET", "teams")]);
  const saved = Number(store.get("tf_team"));
  S.teamId = S.teams.find((t) => t.id === saved) ? saved : (S.teams[0] || {}).id || null;
}

function authCard(title, sub, fields, btnLabel, onSubmit, footer) {
  const err = h("div", { class: "err" });
  const inputs = fields.map(([name, label, type]) => h("input", { name, type, id: "f_" + name, required: true, autocomplete: type === "password" ? (name === "password" && btnLabel === "Sign in" ? "current-password" : "new-password") : name }));
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      const v = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      try { await onSubmit(v); boot(); } catch (ex) { err.textContent = ex.message; }
    },
  }, fields.map(([name, label], i) => h("div", { class: "field" }, h("label", { for: "f_" + name }, label), inputs[i])), err,
  h("button", { class: "btn primary", type: "submit", style: { width: "100%", justifyContent: "center" } }, btnLabel));
  return h("div", { class: "auth" }, h("div", { class: "card" },
    h("div", { class: "brand", style: { color: "var(--ink)", padding: "0 0 14px" } }, h("div", { class: "brand-mark", style: { color: "#fff" } }, "10"), "Tenfold"),
    h("h1", {}, title), h("p", {}, sub), form,
    footer ? h("p", { style: { margin: "18px 0 0", textAlign: "center" } }, footer) : null));
}

function renderLogin(app, signupOpen) {
  app.innerHTML = "";
  app.append(authCard("Sign in", "Welcome back.", [["email", "Email", "email"], ["password", "Password", "password"]], "Sign in",
    (v) => api("POST", "login", v),
    signupOpen ? ["New here? ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); renderRegister(app, ""); } }, "Create an account")] : "New here? Ask your admin for an invite link."));
}

function renderRegister(app, code) {
  app.innerHTML = "";
  app.append(authCard("Create your account", "You'll need the invite code from your admin. An invite link fills it in for you.",
    [["name", "Your name", "text"], ["email", "Email", "email"], ["password", "Password (8+ characters)", "password"], ["code", "Invite code", "text"]],
    "Create account", async (v) => { await api("POST", "register", v); location.hash = "#/home"; },
    ["Already have an account? ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); location.hash = ""; boot(); } }, "Sign in")]));
  $("#f_code").value = code || "";
}

function renderSetup(app) {
  app.innerHTML = "";
  app.append(authCard("Set up Tenfold", "Create the first admin account. You can add everyone else afterwards.",
    [["name", "Your name", "text"], ["email", "Email", "email"], ["password", "Password (8+ characters)", "password"], ["team", "First team name", "text"]],
    "Create account", (v) => api("POST", "setup", v)));
  $("#f_team").value = "Leadership Team";
}

// ---------------------------------------------------------------- shared panels
// Each panel renders into a card and can be embedded in the meeting runner.

async function todosPanel(el, opts = {}) {
  const { teamId, ownerId, showDone = false, compact = false, title = "To-Dos", onChange } = opts;
  const q = new URLSearchParams();
  if (teamId) q.set("team_id", teamId);
  if (ownerId) q.set("owner_id", ownerId);
  q.set("since", new Date(Date.now() - 7 * 864e5).toISOString());
  let items = await api("GET", "todos?" + q);
  if (!showDone) items = items.filter((t) => !t.done || (t.done_at && Date.now() - new Date(t.done_at) < 7 * 864e5));
  const reload = () => { el.innerHTML = ""; todosPanel(el, opts); onChange && onChange(); };
  const list = h("ul", { class: "rows" });
  if (!items.length) list.append(h("li", { class: "empty" }, "Nothing to do. Nice."));
  for (const t of items) {
    const overdue = !t.done && t.due_date && t.due_date < today();
    list.append(h("li", { class: "rowi" + (t.done ? " done" : "") },
      h("input", { type: "checkbox", class: "check", checked: !!t.done, "aria-label": "Done", onchange: (e) => safe(async () => { await api("PUT", "todos/" + t.id, { done: e.target.checked ? 1 : 0 }); reload(); }) }),
      h("div", { class: "title", onclick: () => editTodo(t, reload) }, h("div", { class: "t" }, t.title), t.description && !compact ? h("div", { class: "d" }, t.description) : null),
      !teamId ? h("span", { class: "tag" }, teamName(t.team_id)) : null,
      h("span", { class: "meta" + (overdue ? " overdue" : "") }, t.due_date ? (overdue ? "Overdue · " : "Due ") + fmtDate(t.due_date) : ""),
      avatar(t.owner_id)));
  }
  const qa = h("input", { placeholder: "Add a to-do and press Enter…", "aria-label": "New to-do" });
  qa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && qa.value.trim()) safe(async () => {
      await api("POST", "todos", { title: qa.value.trim(), team_id: teamId || S.teamId, owner_id: ownerId || S.me.id, due_date: addDays(today(), 7) });
      reload();
    });
  });
  const open = items.filter((t) => !t.done).length;
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, title), h("span", { class: "pill neutral" }, `${open} open`), h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => editTodo({ team_id: teamId || S.teamId, owner_id: ownerId || S.me.id, due_date: addDays(today(), 7) }, reload) }, "+ To-Do")),
    list, S.teamId ? h("div", { class: "quick-add" }, qa) : null));
}

const ownersField = (ids, opts = {}) => ({
  name: opts.name || "owner_ids", label: opts.label || "Owners", type: "multiselect", avatars: true, required: opts.required !== false,
  options: S.users.map((u) => [u.id, u.name]), value: ids.filter(Boolean),
  hint: opts.hint === undefined ? "Pick more than one and everyone gets their own copy to check off." : opts.hint });

async function createTodosForOwners(v, extra = {}) {
  const { owner_ids, ...rest } = v;
  for (const oid of owner_ids) await api("POST", "todos", { ...rest, ...extra, owner_id: Number(oid) });
  if (owner_ids.length > 1) toast(`Created ${owner_ids.length} to-dos`);
}

function editTodo(t, done) {
  formModal({
    title: t.id ? "Edit to-do" : "New to-do",
    fields: [
      { name: "title", label: "Title", value: t.title, required: true },
      { name: "description", label: "Details", type: "textarea", value: t.description, rows: 3 },
      ownersField([t.owner_id], t.id ? { hint: "Adding people gives each of them their own copy of this to-do." } : {}),
      { name: "due_date", label: "Due", type: "date", value: t.due_date },
      { name: "team_id", label: "Team", type: "select", options: S.teams.map((x) => [x.id, x.name]), value: t.team_id },
    ],
    onSubmit: async (v) => {
      if (!t.id) { await createTodosForOwners(v); done(); return; }
      const { owner_ids, ...rest } = v;
      const ids = idList(owner_ids);
      const keep = ids.includes(t.owner_id) ? t.owner_id : ids[0];
      await api("PUT", "todos/" + t.id, { ...rest, owner_id: keep });
      const others = ids.filter((x) => x !== keep);
      for (const o of others) await api("POST", "todos", { ...rest, owner_id: o, issue_id: t.issue_id });
      if (others.length) toast(`Added a copy for ${others.length} more ${others.length === 1 ? "person" : "people"}`);
      done();
    },
    onDelete: t.id ? async () => { await api("DELETE", "todos/" + t.id); done(); } : null,
  });
}

async function issuesPanel(el, opts = {}) {
  const { teamId = S.teamId, meeting = false, onChange } = opts;
  let term = opts.term || "short";
  let showSolved = opts.showSolved || false;
  const items = await api("GET", "issues?team_id=" + teamId);
  const reload = () => { el.innerHTML = ""; issuesPanel(el, { ...opts, term, showSolved }); onChange && onChange(); };
  const visible = items.filter((i) => i.term === term && (showSolved || i.status === "open"));
  const used = new Set(items.filter((i) => i.status === "open" && i.term === term && i.priority > 0).map((i) => i.priority));
  const list = h("ul", { class: "rows" });
  if (!visible.length) list.append(h("li", { class: "empty" }, term === "short" ? "No open issues. Add anything that's in the way." : "No long-term issues parked here."));
  for (const i of visible) {
    const solved = i.status === "solved";
    list.append(h("li", { class: "rowi" + (solved ? " done" : "") },
      h("button", {
        class: "prio" + (i.priority ? " p" + i.priority : ""), title: "Set priority (1–3)",
        onclick: () => safe(async () => {
          let p = i.priority;
          do { p = (p + 1) % 4; } while (p !== 0 && used.has(p) && p !== i.priority);
          await api("PUT", "issues/" + i.id, { priority: p }); reload();
        }),
      }, i.priority || ""),
      h("div", { class: "title", onclick: () => editIssue(i, reload) }, h("div", { class: "t" }, i.title), i.description ? h("div", { class: "d" }, i.description) : null),
      h("span", { class: "meta" }, fmtDate(i.created_at)),
      avatars(ownersOf(i)),
      meeting && !solved ? h("button", { class: "btn small", onclick: () => issueToTodo(i, reload) }, "+ To-Do") : null,
      h("button", {
        class: "btn small" + (solved ? "" : " primary"),
        onclick: () => safe(async () => { await api("PUT", "issues/" + i.id, { status: solved ? "open" : "solved", priority: 0 }); toast(solved ? "Reopened" : "Solved ✓"); reload(); }),
      }, solved ? "Reopen" : "Solve")));
  }
  const seg = h("div", { class: "seg" },
    ["short", "long"].map((t) => h("button", { class: term === t ? "on" : "", onclick: () => { term = t; reload(); } }, t === "short" ? "Short-term" : "Long-term")));
  const qa = h("input", { placeholder: "Add an issue and press Enter…", "aria-label": "New issue" });
  qa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && qa.value.trim()) safe(async () => { await api("POST", "issues", { title: qa.value.trim(), team_id: teamId, owner_id: S.me.id, term }); reload(); });
  });
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Issues"), seg, h("span", { class: "spacer" }),
      h("label", { class: "meta" }, h("input", { type: "checkbox", checked: showSolved, onchange: (e) => { showSolved = e.target.checked; reload(); } }), " Show solved"),
      h("button", { class: "btn small", onclick: () => editIssue({ team_id: teamId, owner_id: S.me.id, term }, reload) }, "+ Issue")),
    list, h("div", { class: "quick-add" }, qa)));
}

function editIssue(i, done) {
  formModal({
    title: i.id ? "Edit issue" : "New issue",
    fields: [
      { name: "title", label: "Issue", value: i.title, required: true },
      { name: "description", label: "Details", type: "textarea", value: i.description },
      ownersField(ownersOf(i), { required: false, hint: "Everyone picked shares this item." }),
      { name: "term", label: "List", type: "select", options: [["short", "Short-term"], ["long", "Long-term"]], value: i.term || "short" },
      { name: "team_id", label: "Team", type: "select", options: S.teams.map((x) => [x.id, x.name]), value: i.team_id },
    ],
    onSubmit: async (v) => { await api(i.id ? "PUT" : "POST", "issues" + (i.id ? "/" + i.id : ""), { ...v, owner_ids: idList(v.owner_ids) }); done(); },
    onDelete: i.id ? async () => { await api("DELETE", "issues/" + i.id); done(); } : null,
  });
}

function issueToTodo(i, done) {
  formModal({
    title: "To-do from issue",
    fields: [
      { name: "title", label: "To-do", value: "", required: true, placeholder: "What needs to happen?" },
      ownersField(ownersOf(i).length ? ownersOf(i) : [S.me.id]),
      { name: "due_date", label: "Due", type: "date", value: addDays(today(), 7) },
    ],
    submitLabel: "Create to-do",
    onSubmit: async (v) => { await createTodosForOwners(v, { team_id: i.team_id, issue_id: i.id, description: "From issue: " + i.title }); if (v.owner_ids.length === 1) toast("To-do created"); done(); },
  });
}

async function rocksPanel(el, opts = {}) {
  const { teamId = S.teamId, ownerId, meeting = false } = opts;
  let quarter = opts.quarter || quarterOf();
  const q = new URLSearchParams({ quarter });
  if (teamId) q.set("team_id", teamId);
  if (ownerId) q.set("owner_id", ownerId);
  const items = await api("GET", "rocks?" + q);
  const reload = () => { el.innerHTML = ""; rocksPanel(el, { ...opts, quarter }); };
  const cycle = { on: "off", off: "done", done: "on" };
  const label = { on: "On track", off: "Off track", done: "Done" };
  const groups = new Map();
  for (const r of items) { const k = r.owner_id || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const list = h("ul", { class: "rows" });
  if (!items.length) list.append(h("li", { class: "empty" }, `No rocks for ${quarter}. Rocks are the 3–7 most important things to get done this quarter.`));
  for (const [owner, rocks] of groups) {
    for (const r of rocks) {
      list.append(h("li", { class: "rowi" + (r.status === "done" ? " done" : "") },
        avatars(ownersOf(r)),
        h("div", { class: "title", onclick: () => editRock(r, reload) }, h("div", { class: "t" }, r.title),
          h("div", { class: "d" }, ownerNames(ownersOf(r)) + (teamId ? "" : " · " + teamName(r.team_id)) + (r.description && !meeting ? " — " + r.description : ""))),
        h("span", { class: "meta" }, r.due_date ? "Due " + fmtDate(r.due_date) : ""),
        meeting && r.status === "off" ? h("button", { class: "btn small", onclick: () => safe(async () => { await api("POST", "issues", { title: "Rock off track: " + r.title, team_id: r.team_id, owner_ids: ownersOf(r) }); toast("Added to issues"); }) }, "→ Issue") : null,
        h("button", { class: "pill " + r.status, title: "Click to change status", onclick: () => safe(async () => { await api("PUT", "rocks/" + r.id, { status: cycle[r.status] }); reload(); }) }, label[r.status])));
    }
  }
  const done = items.filter((r) => r.status === "done").length;
  const qsel = h("select", { class: "input", style: { width: "auto" }, onchange: (e) => { quarter = e.target.value; reload(); } },
    [prevQuarter(quarterOf()), quarterOf(), nextQuarter(quarterOf())].concat(quarter).filter((v, i, a) => a.indexOf(v) === i).sort()
      .map((x) => h("option", { value: x, selected: x === quarter }, x)));
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, opts.title || "Rocks"), h("span", { class: "pill neutral" }, `${done}/${items.length} done`), h("span", { class: "spacer" }),
      opts.noQuarter ? null : qsel,
      h("button", { class: "btn small", onclick: () => editRock({ team_id: teamId || S.teamId, owner_id: ownerId || S.me.id, quarter, due_date: quarterEnd(quarter), status: "on" }, reload) }, "+ Rock")),
    list));
}

function editRock(r, done) {
  formModal({
    title: r.id ? "Edit rock" : "New rock",
    fields: [
      { name: "title", label: "Rock", value: r.title, required: true, placeholder: "Specific, measurable, done by end of quarter" },
      { name: "description", label: "Details / milestones", type: "textarea", value: r.description },
      ownersField(ownersOf(r), { required: false, hint: "Everyone picked shares this item." }),
      { name: "status", label: "Status", type: "select", options: [["on", "On track"], ["off", "Off track"], ["done", "Done"]], value: r.status },
      { name: "quarter", label: "Quarter", value: r.quarter, half: true, placeholder: "2026-Q4" },
      { name: "due_date", label: "Due", type: "date", value: r.due_date, half: true },
      { name: "team_id", label: "Team", type: "select", options: S.teams.map((x) => [x.id, x.name]), value: r.team_id },
    ],
    onSubmit: async (v) => { await api(r.id ? "PUT" : "POST", "rocks" + (r.id ? "/" + r.id : ""), { ...v, owner_ids: idList(v.owner_ids) }); done(); },
    onDelete: r.id ? async () => { await api("DELETE", "rocks/" + r.id); done(); } : null,
  });
}

async function headlinesPanel(el, opts = {}) {
  const { teamId = S.teamId, meeting = false } = opts;
  let showArchived = opts.showArchived || false;
  let items = await api("GET", "headlines?team_id=" + teamId);
  if (!showArchived) items = items.filter((x) => !x.archived);
  const reload = () => { el.innerHTML = ""; headlinesPanel(el, { ...opts, showArchived }); };
  const kinds = { customer: "Customer", employee: "Employee", general: "General" };
  const list = h("ul", { class: "rows" });
  if (!items.length) list.append(h("li", { class: "empty" }, "No headlines. Share good news and quick updates about customers and people."));
  for (const x of items) {
    list.append(h("li", { class: "rowi" + (x.archived ? " done" : "") },
      avatars(ownersOf(x)),
      h("div", { class: "title", onclick: () => editHeadline(x, reload) }, h("div", { class: "t" }, x.title)),
      h("span", { class: "pill neutral" }, kinds[x.kind]),
      h("span", { class: "meta" }, fmtDate(x.created_at)),
      h("button", { class: "btn small", title: "Drop down to the issues list", onclick: () => safe(async () => { await api("POST", "issues", { title: x.title, team_id: x.team_id, owner_ids: ownersOf(x) }); await api("PUT", "headlines/" + x.id, { archived: 1 }); toast("Moved to issues"); reload(); }) }, "→ Issue"),
      h("button", { class: "btn small", onclick: () => safe(async () => { await api("PUT", "headlines/" + x.id, { archived: x.archived ? 0 : 1 }); reload(); }) }, x.archived ? "Restore" : "Archive")));
  }
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Headlines"), h("span", { class: "spacer" }),
      meeting ? null : h("label", { class: "meta" }, h("input", { type: "checkbox", checked: showArchived, onchange: (e) => { showArchived = e.target.checked; reload(); } }), " Show archived"),
      h("button", { class: "btn small", onclick: () => editHeadline({ team_id: teamId, owner_id: S.me.id, kind: "general" }, reload) }, "+ Headline")),
    list));
}

function editHeadline(x, done) {
  formModal({
    title: x.id ? "Edit headline" : "New headline",
    fields: [
      { name: "title", label: "Headline", value: x.title, required: true, type: "textarea", rows: 2 },
      { name: "kind", label: "Type", type: "select", options: [["general", "General"], ["customer", "Customer"], ["employee", "Employee"]], value: x.kind },
      ownersField(ownersOf(x), { required: false, hint: "Everyone picked shares this item." }),
    ],
    onSubmit: async (v) => { await api(x.id ? "PUT" : "POST", "headlines" + (x.id ? "/" + x.id : ""), { ...v, owner_ids: idList(v.owner_ids), team_id: x.team_id }); done(); },
    onDelete: x.id ? async () => { await api("DELETE", "headlines/" + x.id); done(); } : null,
  });
}

function hitGoal(m, v) {
  if (v == null || m.goal == null) return null;
  switch (m.op) {
    case ">=": return v >= m.goal;
    case "<=": return v <= m.goal;
    case ">": return v > m.goal;
    case "<": return v < m.goal;
    default: return v === m.goal;
  }
}
const fmtNum = (v, unit) => {
  if (v == null) return "";
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return unit === "$" ? "$" + n : unit === "%" ? n + "%" : n;
};

async function scorecardPanel(el, opts = {}) {
  const { teamId = S.teamId } = opts;
  const weeksN = opts.weeks || 13;
  const cur = weekStart();
  const weeks = []; for (let i = weeksN - 1; i >= 0; i--) weeks.push(addDays(cur, -7 * i));
  const [ms, scores] = await Promise.all([api("GET", "measurables?archived=0&team_id=" + teamId), api("GET", `scores?team_id=${teamId}&since=${weeks[0]}`)]);
  const val = new Map(scores.map((s) => [s.measurable_id + "|" + s.week, s.value]));
  const reload = () => { el.innerHTML = ""; scorecardPanel(el, opts); };
  const table = h("table", { class: "sc" });
  table.append(h("thead", {}, h("tr", {},
    h("th", { class: "name" }, "Measurable"), h("th", {}, "Owner"), h("th", {}, "Goal"),
    weeks.map((w) => h("th", { class: w === cur ? "cur" : "" }, fmtDate(w))), h("th", {}, "Avg"))));
  const tb = h("tbody");
  for (const m of ms) {
    const avgOf = () => { const vs = weeks.map((w) => val.get(m.id + "|" + w)).filter((x) => x != null); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; };
    const avgCell = h("td", { class: "goal" }, avgOf() == null ? "" : fmtNum(avgOf(), m.unit));
    tb.append(h("tr", {},
      h("td", { class: "name", onclick: () => editMeasurable(m, reload) }, m.title),
      h("td", {}, avatars(ownersOf(m))),
      h("td", { class: "goal" }, m.goal != null ? `${({ ">=": "≥", "<=": "≤" })[m.op] || m.op} ${fmtNum(m.goal, m.unit)}` : "—"),
      weeks.map((w) => {
        const v = val.get(m.id + "|" + w);
        const hit = hitGoal(m, v);
        const td = h("td", { class: (hit === true ? "hit" : hit === false ? "miss" : "") + (w === cur ? " cur" : "") });
        const inp = h("input", { value: v == null ? "" : v, inputmode: "decimal", "aria-label": `${m.title} ${w}` });
        inp.addEventListener("change", () => safe(async () => {
          const raw = inp.value.replace(/[$,%\s]/g, "");
          if (raw !== "" && isNaN(Number(raw))) { toast("Enter a number", true); return; }
          const nv = raw === "" ? null : Number(raw);
          await api("PUT", "scores", { measurable_id: m.id, week: w, value: nv });
          if (nv == null) val.delete(m.id + "|" + w); else val.set(m.id + "|" + w, nv);
          const h2 = hitGoal(m, nv);
          td.className = (h2 === true ? "hit" : h2 === false ? "miss" : "") + (w === cur ? " cur" : "");
          const a = avgOf(); avgCell.textContent = a == null ? "" : fmtNum(a, m.unit);
        }));
        td.append(inp);
        return td;
      }),
      avgCell));
  }
  if (!ms.length) tb.append(h("tr", {}, h("td", { colspan: weeks.length + 4, class: "empty" }, "No measurables yet. Add 5–15 weekly numbers that tell you how the business is doing.")));
  table.append(tb);
  const wrap = h("div", { class: "sc-wrap" }, table);
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Scorecard"), h("span", { class: "meta" }, "Weeks start Monday · click a measurable to edit"), h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => editMeasurable({ team_id: teamId, owner_id: S.me.id, op: ">=", sort: ms.length }, reload) }, "+ Measurable")),
    wrap));
  wrap.scrollLeft = wrap.scrollWidth;
}

function editMeasurable(m, done) {
  formModal({
    title: m.id ? "Edit measurable" : "New measurable",
    fields: [
      { name: "title", label: "Measurable", value: m.title, required: true, placeholder: "e.g. Sales calls made" },
      ownersField(ownersOf(m), { required: false, hint: "Everyone picked shares this item." }),
      { name: "op", label: "Goal is", type: "select", options: [[">=", "≥ at least"], ["<=", "≤ at most"], ["=", "= exactly"], [">", "> more than"], ["<", "< less than"]], value: m.op, half: true },
      { name: "goal", label: "Goal", type: "number", step: "any", value: m.goal, half: true },
      { name: "unit", label: "Format", type: "select", options: [["", "Number"], ["$", "Currency ($)"], ["%", "Percent (%)"]], value: m.unit || "", half: true },
      { name: "sort", label: "Order", type: "number", value: m.sort || 0, half: true },
    ],
    onSubmit: async (v) => { await api(m.id ? "PUT" : "POST", "measurables" + (m.id ? "/" + m.id : ""), { ...v, owner_ids: idList(v.owner_ids), team_id: m.team_id, unit: v.unit || "" }); done(); },
    onDelete: m.id ? async () => { await api("DELETE", "measurables/" + m.id); done(); } : null,
    extraButtons: m.id ? (c) => [h("button", { class: "btn", type: "button", onclick: () => safe(async () => { await api("PUT", "measurables/" + m.id, { archived: 1 }); c(); done(); toast("Archived"); }) }, "Archive")] : null,
  });
}

// ---------------------------------------------------------------- pages
async function pageHome(view) {
  const qtr = quarterOf();
  const [todos, rocks, issues] = await Promise.all([
    api("GET", "todos?done=0&owner_id=" + S.me.id), api("GET", `rocks?owner_id=${S.me.id}&quarter=${qtr}`), api("GET", `issues?status=open&owner_id=${S.me.id}`)]);
  const overdue = todos.filter((t) => t.due_date && t.due_date < today()).length;
  const rocksDone = rocks.filter((r) => r.status === "done").length;
  const hour = new Date().getHours();
  view.append(pageHead(`Good ${hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, ${S.me.name.split(" ")[0]}`, `Everything on your plate across all teams · ${qtr}`));
  view.append(h("div", { class: "stats" },
    h("div", { class: "stat" }, h("div", { class: "n" }, todos.length), h("div", { class: "l" }, "Open to-dos" + (overdue ? ` · ${overdue} overdue` : ""))),
    h("div", { class: "stat" }, h("div", { class: "n" }, `${rocksDone}/${rocks.length}`), h("div", { class: "l" }, "Rocks done this quarter"),
      h("div", { class: "bar" }, h("i", { style: { width: rocks.length ? (100 * rocksDone / rocks.length) + "%" : "0" } }))),
    h("div", { class: "stat" }, h("div", { class: "n" }, rocks.filter((r) => r.status === "off").length), h("div", { class: "l" }, "Rocks off track")),
    h("div", { class: "stat" }, h("div", { class: "n" }, issues.length), h("div", { class: "l" }, "Issues you own"))));
  const grid = h("div", { class: "grid2" });
  const a = h("div"), b = h("div");
  grid.append(a, b);
  view.append(grid);
  await Promise.all([
    todosPanel(a, { ownerId: S.me.id, title: "My To-Dos", onChange: () => route() }),
    rocksPanel(b, { teamId: null, ownerId: S.me.id, title: "My Rocks", noQuarter: true }),
  ]);
}

async function pageTodos(view) {
  if (needTeam(view)) return;
  let mine = store.get("tf_todos_mine") === "1";
  const body = h("div");
  const seg = h("div", { class: "seg" },
    h("button", { class: mine ? "" : "on", onclick: () => { store.set("tf_todos_mine", "0"); route(); } }, "Team"),
    h("button", { class: mine ? "on" : "", onclick: () => { store.set("tf_todos_mine", "1"); route(); } }, "Mine"));
  view.append(pageHead("To-Dos", teamName(S.teamId) + " · 7-day action items", seg), body);
  const done = await api("GET", "todos?team_id=" + S.teamId + "&done=1");
  const recent = done.filter((t) => t.done_at && Date.now() - new Date(t.done_at) < 90 * 864e5);
  const onTime = recent.filter((t) => !t.due_date || t.done_at.slice(0, 10) <= t.due_date).length;
  view.insertBefore(h("div", { class: "stats" },
    h("div", { class: "stat" }, h("div", { class: "n" }, recent.length), h("div", { class: "l" }, "Completed in last 90 days")),
    h("div", { class: "stat" }, h("div", { class: "n" }, recent.length ? Math.round(100 * onTime / recent.length) + "%" : "—"), h("div", { class: "l" }, "Completed on time (goal: 90%)"))), body);
  await todosPanel(body, { teamId: S.teamId, ownerId: mine ? S.me.id : null, title: mine ? "My team to-dos" : "Team to-dos" });
}

async function pageIssues(view) {
  if (needTeam(view)) return;
  view.append(pageHead("Issues", teamName(S.teamId) + " · prioritize your top 3, then Identify, Discuss, Solve"));
  const body = h("div"); view.append(body);
  await issuesPanel(body, {});
}

async function pageRocks(view) {
  if (needTeam(view)) return;
  view.append(pageHead("Rocks", teamName(S.teamId) + " · 90-day priorities"));
  const body = h("div"); view.append(body);
  await rocksPanel(body, {});
}

async function pageHeadlines(view) {
  if (needTeam(view)) return;
  view.append(pageHead("Headlines", teamName(S.teamId) + " · customer and employee news"));
  const body = h("div"); view.append(body);
  await headlinesPanel(body, {});
}

async function pageScorecard(view) {
  if (needTeam(view)) return;
  view.append(pageHead("Scorecard", teamName(S.teamId) + " · last 13 weeks"));
  const body = h("div"); view.append(body);
  await scorecardPanel(body, {});
}

// ---- accountability chart
async function pageChart(view) {
  const seats = await api("GET", "seats");
  const reload = () => route();
  view.append(pageHead("Accountability Chart", "Seats, the people in them, and the 3–5 roles each owns",
    h("button", { class: "btn primary", onclick: () => editSeat({ parent_id: null }, seats, reload) }, "+ Seat")));
  const kids = (pid) => seats.filter((s) => (s.parent_id || null) === pid).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const node = (s) => {
    const roles = (s.roles || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const children = kids(s.id);
    return h("li", {},
      h("div", { class: "seat" },
        h("div", { class: "seat-top" }, h("span", {}, s.title),
          h("button", { title: "Add a seat under this one", onclick: () => editSeat({ parent_id: s.id }, seats, reload) }, "+"),
          h("button", { title: "Edit seat", onclick: () => editSeat(s, seats, reload) }, "✎")),
        ownersOf(s, "user_id", "user_ids").length
          ? ownersOf(s, "user_id", "user_ids").map((id) => h("div", { class: "seat-person" }, avatar(id), userName(id)))
          : h("div", { class: "seat-person vacant" }, "Open seat"),
        roles.length ? h("ul", { class: "roles" }, roles.map((r) => h("li", {}, r))) : null),
      children.length ? h("ul", {}, children.map(node)) : null);
  };
  const roots = kids(null);
  if (!roots.length) {
    view.append(h("div", { class: "card empty" }, h("p", {}, "Start with the top seat (often Visionary or Integrator), then add the seats that report to it."),
      h("button", { class: "btn primary", onclick: () => editSeat({ parent_id: null, title: "Visionary" }, seats, reload) }, "Add the first seat")));
    return;
  }
  view.append(h("div", { class: "card" }, h("div", { class: "chart-scroll" }, h("ul", { class: "tree" }, roots.map(node)))));
}

function editSeat(s, seats, done) {
  const descendants = new Set();
  const walk = (id) => seats.filter((x) => x.parent_id === id).forEach((x) => { descendants.add(x.id); walk(x.id); });
  if (s.id) { descendants.add(s.id); walk(s.id); }
  formModal({
    title: s.id ? "Edit seat" : "New seat",
    fields: [
      { name: "title", label: "Seat", value: s.title, required: true, placeholder: "e.g. Sales & Marketing" },
      ownersField(ownersOf(s, "user_id", "user_ids"), { name: "user_ids", label: "People in the seat", required: false, hint: "Leave empty for an open seat." }),
      { name: "roles", label: "Roles (one per line)", type: "textarea", value: s.roles, rows: 5, hint: "The 3–5 major responsibilities of this seat." },
      { name: "parent_id", label: "Reports to", type: "select", options: [["", "— Top of chart —"], ...seats.filter((x) => !descendants.has(x.id)).map((x) => [x.id, x.title])], value: s.parent_id, half: true },
      { name: "sort", label: "Order (left → right)", type: "number", value: s.sort || 0, half: true },
    ],
    onSubmit: async (v) => { await api(s.id ? "PUT" : "POST", "seats" + (s.id ? "/" + s.id : ""), { ...v, user_ids: idList(v.user_ids) }); done(); },
    onDelete: s.id ? async () => { await api("DELETE", "seats/" + s.id); done(); } : null,
  });
}

// ---- V/TO
const VTO_FIELDS = {
  vision: [
    ["Core Values", [["core_values", "Core values (one per line)", "list"]]],
    ["Core Focus", [["purpose", "Purpose / Cause / Passion", "text"], ["niche", "Our Niche", "text"]]],
    ["10-Year Target", [["ten_year", "10-year target", "textarea"]]],
    ["Marketing Strategy", [["target_market", "Target market / “The List”", "textarea"], ["uniques", "3 Uniques (one per line)", "list"], ["proven_process", "Proven process", "text"], ["guarantee", "Guarantee", "text"]]],
    ["3-Year Picture", [["three_date", "Future date", "date"], ["three_revenue", "Revenue", "text"], ["three_profit", "Profit", "text"], ["three_measurables", "Measurables", "text"], ["three_looks", "What does it look like? (one per line)", "list"]]],
  ],
  traction: [
    ["1-Year Plan", [["one_date", "Future date", "date"], ["one_revenue", "Revenue", "text"], ["one_profit", "Profit", "text"], ["one_measurables", "Measurables", "text"], ["one_goals", "Goals for the year (one per line)", "list"]]],
  ],
};

async function pageVto(view) {
  if (needTeam(view)) return;
  const qtr = quarterOf();
  const [vto, rocks, issues] = await Promise.all([api("GET", "vto/" + S.teamId), api("GET", `rocks?team_id=${S.teamId}&quarter=${qtr}`), api("GET", `issues?team_id=${S.teamId}&status=open&term=long`)]);
  const data = vto.data || {};
  const ind = h("span", { class: "saved-ind" }, vto.updated_at ? "Last saved " + fmtDateTime(vto.updated_at) : "Not saved yet");
  let t;
  const save = () => {
    ind.textContent = "Saving…";
    clearTimeout(t);
    t = setTimeout(() => safe(async () => { const r = await api("PUT", "vto/" + S.teamId, { data }); ind.textContent = "Saved " + fmtDateTime(r.updated_at); }), 600);
  };
  const section = (title, fields) => h("div", { class: "vto-sec" }, h("h3", {}, title), fields.map(([key, label, type]) => {
    const el = type === "textarea" || type === "list" ? h("textarea", { rows: type === "list" ? 4 : 3 }) : h("input", { type: type === "date" ? "date" : "text" });
    el.value = data[key] || "";
    el.addEventListener("input", () => { data[key] = el.value; save(); });
    return h("div", { class: "field" }, h("label", {}, label), el);
  }));
  view.append(pageHead("Vision / Traction Organizer", teamName(S.teamId) + " · edits save automatically", ind,
    h("button", { class: "btn", onclick: () => window.print() }, "Print")));
  view.append(h("div", { class: "vto" },
    h("div", { class: "card" }, h("div", { class: "vto-col-title" }, "Vision"), VTO_FIELDS.vision.map(([t2, f]) => section(t2, f))),
    h("div", { class: "card" }, h("div", { class: "vto-col-title" }, "Traction"), VTO_FIELDS.traction.map(([t2, f]) => section(t2, f)),
      h("div", { class: "vto-sec" }, h("h3", {}, `Rocks · ${qtr}`),
        rocks.length ? h("ol", { class: "vto-list" }, rocks.map((r) => h("li", {}, r.title, " ", h("span", { class: "muted" }, "— " + ownerNames(ownersOf(r)))))) : h("div", { class: "muted" }, "No rocks this quarter."),
        h("div", { class: "mt" }, h("a", { href: "#/rocks" }, "Manage rocks →"))),
      h("div", { class: "vto-sec" }, h("h3", {}, "Issues list (long-term)"),
        issues.length ? h("ol", { class: "vto-list" }, issues.map((i) => h("li", {}, i.title))) : h("div", { class: "muted" }, "No long-term issues."),
        h("div", { class: "mt" }, h("a", { href: "#/issues" }, "Manage issues →"))))));
}

// ---- meetings
const AGENDA = [
  ["segue", "Segue", 5], ["scorecard", "Scorecard", 5], ["rocks", "Rock Review", 5], ["headlines", "Headlines", 5],
  ["todos", "To-Do List", 5], ["ids", "IDS", 60], ["conclude", "Conclude", 5],
];

async function pageMeetings(view) {
  if (needTeam(view)) return;
  const items = await api("GET", "meetings?team_id=" + S.teamId);
  view.append(pageHead("Meetings", teamName(S.teamId) + " · weekly Level 10 meetings",
    h("button", { class: "btn primary", onclick: startMeeting }, "▶ Start Level 10 Meeting")));
  const ended = items.filter((m) => m.ended_at);
  const live = items.filter((m) => !m.ended_at);
  const avg = ended.filter((m) => m.rating != null);
  view.append(h("div", { class: "stats" },
    h("div", { class: "stat" }, h("div", { class: "n" }, ended.length), h("div", { class: "l" }, "Meetings held")),
    h("div", { class: "stat" }, h("div", { class: "n" }, avg.length ? (avg.slice(0, 10).reduce((a, m) => a + m.rating, 0) / Math.min(avg.length, 10)).toFixed(1) : "—"), h("div", { class: "l" }, "Avg rating, last 10 (goal: 8+)"))));
  if (live.length) {
    view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "In progress")),
      h("ul", { class: "rows" }, live.map((m) => h("li", { class: "rowi" },
        h("div", { class: "title", onclick: () => (location.hash = "#/meeting/" + m.id) }, h("div", { class: "t" }, m.title), h("div", { class: "d" }, "Started " + fmtDateTime(m.started_at))),
        h("button", { class: "btn small primary", onclick: () => (location.hash = "#/meeting/" + m.id) }, "Resume"),
        h("button", { class: "btn small danger", onclick: () => { if (confirm("Discard this meeting?")) safe(async () => { await api("DELETE", "meetings/" + m.id); route(); }); } }, "Discard"))))));
  }
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "History")),
    h("ul", { class: "rows" }, ended.length ? ended.map((m) => {
      const mins = Math.round((new Date(m.ended_at) - new Date(m.started_at)) / 60000);
      return h("li", { class: "rowi" },
        h("div", { class: "title", onclick: () => showMeetingSummary(m) }, h("div", { class: "t" }, m.title), h("div", { class: "d" }, `${fmtDateTime(m.started_at)} · ${mins} min`)),
        m.rating != null ? h("span", { class: "pill " + (m.rating >= 8 ? "on" : m.rating >= 6 ? "warn" : "off") }, "★ " + m.rating.toFixed(1)) : null);
    }) : h("li", { class: "empty" }, "No meetings yet. Same day, same time, same agenda, every week."))));
}

async function startMeeting() {
  await safe(async () => {
    const now = new Date();
    const m = await api("POST", "meetings", {
      team_id: S.teamId, title: `${teamName(S.teamId)} L10 · ${now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
      started_at: now.toISOString(), data: JSON.stringify({ section: 0, sectionStart: Date.now(), elapsed: {}, notes: {}, ratings: {} }),
    });
    location.hash = "#/meeting/" + m.id;
  });
}

function showMeetingSummary(m) {
  const d = JSON.parse(m.data || "{}");
  const body = h("div", {},
    h("p", { class: "muted" }, fmtDateTime(m.started_at) + " → " + fmtDateTime(m.ended_at)),
    m.rating != null ? h("p", {}, h("b", {}, "Average rating: "), m.rating.toFixed(1)) : null,
    d.ratings && Object.keys(d.ratings).length ? h("ul", {}, Object.entries(d.ratings).map(([uid, r]) => h("li", {}, `${userName(Number(uid))}: ${r}`))) : null,
    d.notes && d.notes.segue ? [h("h4", {}, "Segue notes"), h("p", { style: { whiteSpace: "pre-wrap" } }, d.notes.segue)] : null,
    d.notes && d.notes.cascade ? [h("h4", {}, "Cascading messages"), h("p", { style: { whiteSpace: "pre-wrap" } }, d.notes.cascade)] : null,
    d.solved && d.solved.length ? [h("h4", {}, "Issues solved"), h("ul", {}, d.solved.map((x) => h("li", {}, x)))] : null,
    d.newTodos && d.newTodos.length ? [h("h4", {}, "To-dos created"), h("ul", {}, d.newTodos.map((x) => h("li", {}, x)))] : null);
  openModal(m.title, body, (c) => [
    h("button", { class: "btn danger", onclick: () => { if (confirm("Delete this meeting record?")) safe(async () => { await api("DELETE", "meetings/" + m.id); c(); route(); }); } }, "Delete"),
    h("span", { class: "spacer" }), h("button", { class: "btn primary", onclick: c }, "Close")]);
}

async function pageMeeting(view, id) {
  const m = await api("GET", "meetings/" + id);
  if (m.ended_at) { location.hash = "#/meetings"; return; }
  S.teamId = m.team_id;
  const d = Object.assign({ section: 0, sectionStart: Date.now(), elapsed: {}, notes: {}, ratings: {} }, JSON.parse(m.data || "{}"));
  const persist = () => api("PUT", "meetings/" + m.id, { data: JSON.stringify(d) }).catch(() => {});
  const secElapsed = (i) => (d.elapsed[i] || 0) + (i === d.section ? Date.now() - d.sectionStart : 0);

  const totalClock = h("span", { class: "clock" });
  const secClock = h("span", { class: "clock" });
  const agendaTimes = [];
  const agenda = h("div", { class: "card agenda" }, AGENDA.map(([, name, mins], i) => {
    const tm = h("span", { class: "tm" });
    agendaTimes.push(tm);
    return h("button", { class: i === d.section ? "active" : "", onclick: () => go(i) }, h("span", { class: "nm" }, name), tm);
  }));
  const content = h("div");
  const nextBtn = h("button", { class: "btn primary", onclick: () => go(d.section + 1) });

  function tick() {
    const total = Date.now() - new Date(m.started_at).getTime();
    totalClock.textContent = fmtClock(total);
    totalClock.classList.toggle("over", total > 90 * 60000);
    const cur = secElapsed(d.section);
    secClock.textContent = fmtClock(cur) + " / " + AGENDA[d.section][2] + ":00";
    secClock.classList.toggle("over", cur > AGENDA[d.section][2] * 60000);
    AGENDA.forEach(([, , mins], i) => {
      const e = secElapsed(i);
      agendaTimes[i].textContent = e > 0 ? fmtClock(e) : mins + " min";
      agendaTimes[i].classList.toggle("over", e > mins * 60000);
    });
  }

  function go(i) {
    if (i < 0 || i >= AGENDA.length) return;
    d.elapsed[d.section] = secElapsed(d.section);
    d.section = i;
    d.sectionStart = Date.now();
    persist();
    [...agenda.children].forEach((b, j) => b.classList.toggle("active", j === i));
    renderSection();
    tick();
  }

  function renderSection() {
    content.innerHTML = "";
    const key = AGENDA[d.section][0];
    nextBtn.textContent = d.section < AGENDA.length - 1 ? "Next: " + AGENDA[d.section + 1][1] + " →" : "Finish below";
    nextBtn.disabled = d.section === AGENDA.length - 1;
    const notes = (k, ph) => {
      const ta = h("textarea", { class: "input", rows: 5, placeholder: ph });
      ta.value = d.notes[k] || "";
      let t;
      ta.addEventListener("input", () => { d.notes[k] = ta.value; clearTimeout(t); t = setTimeout(persist, 800); });
      return ta;
    };
    const card = (title, ...kids) => h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, title)), h("div", { class: "card-body" }, kids));
    if (key === "segue") {
      content.append(card("Segue", h("div", { class: "prompt" }, "Go around the room: everyone shares one personal and one professional best from the past week."), notes("segue", "Notes (optional)")));
    } else if (key === "scorecard") {
      content.append(h("div", { class: "prompt" }, "Report on each number: on track or off track. No discussion; drop anything off track to Issues."));
      const box = h("div"); content.append(box);
      scorecardPanel(box, { weeks: 6 });
    } else if (key === "rocks") {
      content.append(h("div", { class: "prompt" }, "Each owner says “on track” or “off track”. Off-track rocks go to Issues."));
      const box = h("div"); content.append(box);
      rocksPanel(box, { meeting: true, noQuarter: true });
    } else if (key === "headlines") {
      content.append(h("div", { class: "prompt" }, "Quick customer and employee headlines. Anything needing discussion drops to Issues."));
      const box = h("div"); content.append(box);
      headlinesPanel(box, { meeting: true });
    } else if (key === "todos") {
      content.append(h("div", { class: "prompt" }, "Review last week's to-dos: done or not done. Check them off as you go."));
      const box = h("div"); content.append(box);
      todosPanel(box, { teamId: S.teamId, title: "Team to-dos" });
    } else if (key === "ids") {
      content.append(h("div", { class: "prompt" }, h("b", {}, "Identify, Discuss, Solve. "), "Pick your top 3 issues (click the circle to rank them), then work them in order. Create to-dos as you solve."));
      const box = h("div"); content.append(box);
      issuesPanel(box, { meeting: true, onChange: async () => {
        const solved = await api("GET", `issues?team_id=${S.teamId}&status=solved`);
        d.solved = solved.filter((i) => i.solved_at && i.solved_at >= m.started_at.slice(0, 19)).map((i) => i.title);
        persist();
      } });
    } else if (key === "conclude") {
      renderConclude();
    }
  }

  async function renderConclude() {
    const [todos, solved] = await Promise.all([api("GET", "todos?team_id=" + S.teamId), api("GET", `issues?team_id=${S.teamId}&status=solved`)]);
    const startedIso = new Date(m.started_at).toISOString().slice(0, 19);
    const newTodos = todos.filter((t) => t.created_at >= startedIso);
    const solvedNow = solved.filter((i) => i.solved_at && i.solved_at >= startedIso);
    const ratingInputs = S.users.map((u) => {
      const inp = h("input", { type: "number", min: 1, max: 10, class: "input", value: d.ratings[u.id] || "" });
      inp.addEventListener("input", () => { if (inp.value) d.ratings[u.id] = Number(inp.value); else delete d.ratings[u.id]; });
      return h("div", { class: "r" }, avatar(u.id), h("span", {}, u.name), inp);
    });
    const cascade = h("textarea", { class: "input", rows: 4, placeholder: "What needs to be communicated, to whom, and by whom?" });
    cascade.value = d.notes.cascade || "";
    cascade.addEventListener("input", () => { d.notes.cascade = cascade.value; });
    content.append(
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Recap"), h("span", { class: "pill neutral" }, `${newTodos.length} new to-do${newTodos.length === 1 ? "" : "s"}`), h("span", { class: "pill done" }, `${solvedNow.length} issue${solvedNow.length === 1 ? "" : "s"} solved`)),
        h("ul", { class: "rows" }, newTodos.length ? newTodos.map((t) => h("li", { class: "rowi" }, avatar(t.owner_id), h("div", { class: "title" }, h("div", { class: "t" }, t.title)), h("span", { class: "meta" }, "Due " + fmtDate(t.due_date)))) : h("li", { class: "empty" }, "No new to-dos this meeting."))),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Cascading messages")), h("div", { class: "card-body" }, cascade)),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Rate the meeting (1–10)"), h("span", { class: "meta" }, "Leave blank for anyone not attending")),
        h("div", { class: "card-body" }, h("div", { class: "rating-grid" }, ratingInputs))),
      h("div", { class: "mt", style: { display: "flex", justifyContent: "flex-end" } },
        h("button", { class: "btn primary", onclick: () => safe(async () => {
          d.elapsed[d.section] = secElapsed(d.section);
          d.newTodos = newTodos.map((t) => `${t.title} (${userName(t.owner_id)})`);
          d.solved = solvedNow.map((i) => i.title);
          const rs = Object.values(d.ratings).filter((x) => x >= 1 && x <= 10);
          await api("PUT", "meetings/" + m.id, {
            ended_at: new Date().toISOString(), data: JSON.stringify(d),
            rating: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
          });
          toast("Meeting saved. Nice work.");
          location.hash = "#/meetings";
        }) }, "✓ End meeting")));
  }

  view.append(pageHead(m.title, "Level 10 Meeting · " + teamName(m.team_id),
    h("button", { class: "btn", onclick: () => { persist(); location.hash = "#/meetings"; } }, "Pause & leave")));
  view.append(h("div", { class: "card mtg-bar" },
    h("div", {}, h("div", { class: "lbl" }, "Total"), totalClock),
    h("div", {}, h("div", { class: "lbl" }, "This section"), secClock),
    h("span", { style: { flex: 1 } }), nextBtn));
  view.append(h("div", { class: "mtg" }, agenda, content));
  renderSection();
  tick();
  S.timers.push(setInterval(tick, 1000));
}

// ---- availability (Google Calendar via secret iCal link)
const HOUR_PX = 44;
const HOUR_RANGES = { work: [8, 18, "Work hours"], day: [7, 22, "7am–10pm"], all: [0, 24, "24 hours"] };

function calendarConnectCard(onDone) {
  const connected = S.me.has_calendar;
  const input = h("input", { class: "input", placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics", "aria-label": "Secret iCal address" });
  const save = h("button", { class: "btn primary", onclick: () => safe(async () => {
    if (!input.value.trim()) { toast("Paste your secret iCal address first", true); return; }
    save.disabled = true; save.textContent = "Checking…";
    try { await api("PUT", "me/calendar", { url: input.value.trim() }); } finally { save.disabled = false; save.textContent = "Connect"; }
    S.me.has_calendar = true; toast("Calendar connected"); onDone();
  }) }, "Connect");
  const steps = h("ol", { class: "steps" },
    h("li", {}, "Open ", h("a", { href: "https://calendar.google.com/calendar/r/settings", target: "_blank", rel: "noopener" }, "Google Calendar settings"), " on a computer."),
    h("li", {}, "On the left under ", h("b", {}, "Settings for my calendars"), ", click your calendar, then ", h("b", {}, "Integrate calendar"), "."),
    h("li", {}, "Copy the ", h("b", {}, "Secret address in iCal format"), " and paste it below."));
  const form = h("div", {}, steps, h("div", { style: { display: "flex", gap: "8px" } }, input, save),
    h("p", { class: "hint" }, "Teammates only see when you're busy, never event titles or details. Changes in Google can take a few minutes to show up here."));
  if (!connected) return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Connect your Google Calendar")), h("div", { class: "card-body" }, form));
  const body = h("div", { class: "card-body", style: { display: "none" } }, form);
  return h("div", { class: "card" }, h("div", { class: "card-head" },
    h("span", { class: "pill on" }, "✓ Your Google Calendar is connected"), h("span", { class: "spacer" }),
    h("button", { class: "btn small", onclick: () => { body.style.display = body.style.display ? "" : "none"; } }, "Replace link"),
    h("button", { class: "btn small danger", onclick: () => { if (confirm("Disconnect your calendar?")) safe(async () => { await api("PUT", "me/calendar", { url: "" }); S.me.has_calendar = false; onDone(); }); } }, "Disconnect")), body);
}

async function pageAvailability(view) {
  let weekOffset = Number(store.get("tf_av_week_off") || 0);
  if (Math.abs(weekOffset) > 8) weekOffset = 0;
  const rangeKey = HOUR_RANGES[store.get("tf_av_hours")] ? store.get("tf_av_hours") : "day";
  const [h0, h1] = HOUR_RANGES[rangeKey];
  const mon = parseYmd(weekStart());
  mon.setDate(mon.getDate() + 7 * weekOffset);
  const days = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return d; });
  const start = new Date(mon), end = new Date(mon); end.setDate(end.getDate() + 7);
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const go = (off) => { store.set("tf_av_week_off", String(off)); route(); };

  view.append(pageHead("Availability", `When your team is busy or free · times shown in ${tzName}`,
    h("div", { class: "seg" }, Object.entries(HOUR_RANGES).map(([k, [, , label]]) => h("button", { class: k === rangeKey ? "on" : "", onclick: () => { store.set("tf_av_hours", k); route(); } }, label))),
    h("a", { class: "btn", href: "https://calendar.google.com", target: "_blank", rel: "noopener" }, "Open Google Calendar ↗")));
  view.append(calendarConnectCard(() => route()));

  const status = h("span", { class: "meta" }, "Loading calendars…");
  const chipsRow = h("div", { class: "chips" });
  const grid = h("div", { class: "cal-wrap" });
  const label = `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  view.append(h("div", { class: "card mt" },
    h("div", { class: "card-head" },
      h("button", { class: "btn small", onclick: () => go(weekOffset - 1), "aria-label": "Previous week" }, "‹"),
      h("button", { class: "btn small", onclick: () => go(0) }, "This week"),
      h("button", { class: "btn small", onclick: () => go(weekOffset + 1), "aria-label": "Next week" }, "›"),
      h("h2", {}, label), h("span", { class: "spacer" }),
      h("span", { class: "legend" }, h("i", { class: "free-sw" }), "Everyone selected is free"), status),
    h("div", { class: "card-body", style: { paddingBottom: "8px" } }, chipsRow), grid));

  let data;
  try { data = await api("GET", `availability?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`); }
  catch (e) { status.textContent = ""; throw e; }
  const byUser = new Map(data.map((d) => [d.user_id, d]));
  const connected = S.users.filter((u) => byUser.has(u.id));
  status.textContent = connected.length ? "" : "";
  let hidden;
  try { hidden = new Set(JSON.parse(store.get("tf_av_hidden") || "[]")); } catch (e) { hidden = new Set(); }

  // people chips
  for (const u of S.users) {
    const d = byUser.get(u.id);
    if (!d) { chipsRow.append(h("span", { class: "chip off", title: "Hasn't connected a calendar yet" }, avatar(u.id), h("span", {}, u.name), h("small", {}, "not connected"))); continue; }
    const cb = h("input", { type: "checkbox", checked: !hidden.has(u.id), onchange: () => {
      if (cb.checked) hidden.delete(u.id); else hidden.add(u.id);
      store.set("tf_av_hidden", JSON.stringify([...hidden])); draw();
    } });
    chipsRow.append(h("label", { class: "chip", title: d.error || "" }, cb, avatar(u.id), h("span", {}, u.name), d.error ? h("small", { class: "warn-t" }, "⚠ error") : null));
  }
  const errs = data.filter((d) => d.error);
  if (errs.length) chipsRow.append(h("div", { class: "hint", style: { width: "100%" } }, errs.map((d) => `${userName(d.user_id)}: ${d.error}`).join(" · ")));
  if (!connected.length) {
    grid.append(h("div", { class: "empty" }, "No one has connected a calendar yet. Connect yours above, then ask your team to do the same."));
    return;
  }

  function draw() {
    grid.innerHTML = "";
    const people = connected.filter((u) => !hidden.has(u.id) && !byUser.get(u.id).error);
    const busyOf = (uid) => byUser.get(uid).busy.map(([a, b]) => [new Date(a), new Date(b)]);
    const busy = new Map(people.map((u) => [u.id, busyOf(u.id)]));
    const now = new Date();
    const cal = h("div", { class: "cal", style: { gridTemplateColumns: `52px repeat(7, minmax(110px, 1fr))` } });
    cal.append(h("div", { class: "cal-corner" }));
    for (const d of days) {
      const ds = ymd(d);
      const away = people.filter((u) => byUser.get(u.id).allday.includes(ds));
      cal.append(h("div", { class: "cal-dayhead" + (ds === today() ? " today" : "") },
        h("div", { class: "dn" }, d.toLocaleDateString(undefined, { weekday: "short" })), h("div", { class: "dd" }, d.getDate()),
        away.length ? h("div", { class: "away", title: away.map((u) => u.name).join(", ") + " · all-day event" }, "All day: ", avatars(away.map((u) => u.id))) : null));
    }
    const times = h("div", { class: "cal-times", style: { height: (h1 - h0) * HOUR_PX + "px" } });
    for (let hr = h0; hr < h1; hr++) {
      const t = new Date(2000, 0, 1, hr);
      times.append(h("div", { class: "cal-hr", style: { top: (hr - h0) * HOUR_PX + "px" } }, t.toLocaleTimeString(undefined, { hour: "numeric" })));
    }
    cal.append(times);
    const lanes = Math.max(1, people.length);
    for (const d of days) {
      const col = h("div", { class: "cal-col", style: { height: (h1 - h0) * HOUR_PX + "px", backgroundSize: `100% ${HOUR_PX}px` } });
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h0);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h1 === 24 ? 23 : h1, h1 === 24 ? 59 : 0, h1 === 24 ? 59 : 0);
      const y = (t) => ((t - dayStart) / 3600000) * HOUR_PX;
      // past shading
      if (now > dayStart) col.append(h("div", { class: "cal-past", style: { top: 0, height: Math.min(y(now), (h1 - h0) * HOUR_PX) + "px" } }));
      // everyone-free slots (30 min)
      if (people.length) {
        let runStart = null;
        const flush = (t) => { if (runStart) { col.append(h("div", { class: "cal-free", style: { top: y(runStart) + "px", height: y(t) - y(runStart) + "px" }, title: `Everyone free ${fmtTime(runStart)}–${fmtTime(t)}` })); runStart = null; } };
        for (let t = new Date(dayStart); t < dayEnd; t = new Date(t.getTime() + 30 * 60000)) {
          const t2 = new Date(Math.min(t.getTime() + 30 * 60000, dayEnd.getTime()));
          const free = people.every((u) => !busy.get(u.id).some(([a, b]) => a < t2 && b > t));
          if (free && !runStart) runStart = t;
          if (!free) flush(t);
        }
        flush(dayEnd);
      }
      // busy blocks per person lane
      people.forEach((u, i) => {
        for (const [a, b] of busy.get(u.id)) {
          const s = a < dayStart ? dayStart : a, e = b > dayEnd ? dayEnd : b;
          if (e <= s) continue;
          col.append(h("div", {
            class: "cal-busy", title: `${u.name}: busy ${fmtTime(a)}–${fmtTime(b)}`,
            style: { top: y(s) + "px", height: Math.max(4, y(e) - y(s)) + "px", left: `calc(${(100 / lanes) * i}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, background: COLORS[u.id % COLORS.length] },
          }, y(e) - y(s) >= 18 && lanes <= 4 ? initials(u.name) : ""));
        }
      });
      if (ymd(d) === today() && now >= dayStart && now <= dayEnd) col.append(h("div", { class: "cal-now", style: { top: y(now) + "px" } }));
      cal.append(col);
    }
    grid.append(cal);
    const sc = grid;
    const nowRow = (now.getHours() - h0 - 1) * HOUR_PX;
    if (weekOffset === 0 && nowRow > 0) sc.scrollTop = nowRow;
  }
  draw();
}
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ---- settings / admin
async function pageSettings(view) {
  view.append(pageHead("Settings", "Your profile" + (S.me.is_admin ? ", teams and people" : "")));
  const profile = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "My profile")),
    h("div", { class: "card-body" }, h("p", { class: "muted", style: { marginTop: 0 } }, `${S.me.name} · ${S.me.email}`),
      h("button", { class: "btn", onclick: () => formModal({
        title: "Edit profile",
        fields: [
          { name: "name", label: "Name", value: S.me.name, required: true },
          { name: "email", label: "Email", type: "email", value: S.me.email, required: true },
          { name: "current_password", label: "Current password", type: "password", hint: "Only needed to change your password" },
          { name: "new_password", label: "New password", type: "password" },
        ],
        onSubmit: async (v) => { S.me = await api("PUT", "me", v); await loadBasics(); renderShell(); route(); toast("Profile saved"); },
      }) }, "Edit profile / change password")));
  view.append(profile);
  if (!S.me.is_admin) return;

  const reload = async () => { await loadBasics(); renderShell(); route(); };

  // Invite link
  const inviteBody = h("div", { class: "card-body" });
  const renderInvite = (code) => {
    inviteBody.innerHTML = "";
    if (!code) {
      inviteBody.append(h("p", { class: "muted", style: { marginTop: 0 } }, "Sign-ups are closed. Turn on an invite link so friends can create their own accounts."),
        h("button", { class: "btn primary", onclick: () => safe(async () => renderInvite((await api("POST", "invite", { action: "new" })).code)) }, "Create invite link"));
      return;
    }
    const link = `${location.origin}/#/join/${encodeURIComponent(code)}`;
    const inp = h("input", { class: "input", readonly: true, value: link, onfocus: (e) => e.target.select() });
    inviteBody.append(
      h("p", { class: "muted", style: { marginTop: 0 } }, "Anyone with this link can create an account. Send it to your friends; they can also type the code on the sign-in page."),
      h("div", { style: { display: "flex", gap: "8px", marginBottom: "10px" } }, inp,
        h("button", { class: "btn primary", onclick: async () => {
          try { await navigator.clipboard.writeText(link); toast("Invite link copied"); } catch (e) { inp.focus(); inp.select(); toast("Press Ctrl+C / ⌘C to copy"); }
        } }, "Copy")),
      h("div", { class: "toolbar" }, h("span", { class: "meta" }, "Code: ", h("b", {}, code)), h("span", { style: { flex: 1 } }),
        h("button", { class: "btn small", onclick: () => { if (confirm("Make a new link? The old one will stop working.")) safe(async () => renderInvite((await api("POST", "invite", { action: "new" })).code)); } }, "New link"),
        h("button", { class: "btn small danger", onclick: () => safe(async () => renderInvite((await api("POST", "invite", { action: "disable" })).code)) }, "Turn off sign-ups")));
  };
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Invite friends")), inviteBody));
  renderInvite((await api("GET", "invite")).code);
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Teams"), h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => formModal({ title: "New team", fields: [{ name: "name", label: "Team name", required: true }], onSubmit: async (v) => { const t = await api("POST", "teams", v); S.teamId = t.id; store.set("tf_team", t.id); await reload(); } }) }, "+ Team")),
    h("ul", { class: "rows" }, S.teams.map((t) => h("li", { class: "rowi" },
      h("div", { class: "title", onclick: () => formModal({
        title: "Edit team", fields: [{ name: "name", label: "Team name", value: t.name, required: true }],
        onSubmit: async (v) => { await api("PUT", "teams/" + t.id, v); await reload(); },
        onDelete: async () => { await api("DELETE", "teams/" + t.id); await reload(); },
      }) }, h("div", { class: "t" }, t.name)),
      h("span", { class: "meta" }, "Click to rename or delete"))))));

  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "People"), h("span", { class: "meta" }, "Create accounts for your friends and share their temporary password with them"), h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => formModal({
        title: "Add person",
        fields: [
          { name: "name", label: "Name", required: true },
          { name: "email", label: "Email (used to sign in)", type: "email", required: true },
          { name: "password", label: "Temporary password (8+ characters)", type: "text", required: true, value: Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 6) },
          { name: "is_admin", label: "Admin (can manage people and teams)", type: "checkbox" },
        ],
        onSubmit: async (v) => { await api("POST", "users", v); await reload(); toast("Added. Share the email and temporary password with them."); },
      }) }, "+ Person")),
    h("ul", { class: "rows" }, S.users.map((u) => h("li", { class: "rowi" }, avatar(u.id),
      h("div", { class: "title", onclick: () => formModal({
        title: "Edit " + u.name,
        fields: [
          { name: "name", label: "Name", value: u.name, required: true },
          { name: "email", label: "Email", type: "email", value: u.email, required: true },
          { name: "password", label: "Reset password", type: "text", hint: "Leave blank to keep their current password" },
          ...(u.id === S.me.id ? [] : [{ name: "is_admin", label: "Admin", type: "checkbox", value: u.is_admin }]),
        ],
        onSubmit: async (v) => { await api("PUT", "users/" + u.id, v); await reload(); },
        onDelete: u.id === S.me.id ? null : async () => { await api("DELETE", "users/" + u.id); await reload(); },
      }) }, h("div", { class: "t" }, u.name), h("div", { class: "d" }, u.email)),
      u.is_admin ? h("span", { class: "pill done" }, "Admin") : null)))));
}

// ---------------------------------------------------------------- start
window.addEventListener("hashchange", route);
boot();
