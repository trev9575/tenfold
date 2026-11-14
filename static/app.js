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

const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

async function api(method, path, body) {
  const opts = { method, headers: { "X-Client-Id": CLIENT_ID }, credentials: "same-origin" };
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
  ["#/boards", "▦", "Boards"],
  ["#/expenses", "$", "Expenses"],
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
    h("div", { class: "side-foot" }, h("div", { id: "presence" }), h("div", {}, S.me.name), h("button", { onclick: logout }, "Sign out")));
  const main = h("main", { class: "main", id: "view" });
  app.append(h("div", { class: "shell" }, side, main));
  renderPresence();
}

async function logout() { await safe(() => api("POST", "logout")); stopLive(); S.me = null; location.hash = ""; boot(); }

const ROUTES = {
  home: pageHome, meetings: pageMeetings, meeting: pageMeeting, scorecard: pageScorecard, rocks: pageRocks,
  todos: pageTodos, issues: pageIssues, availability: pageAvailability, boards: pageBoards, expenses: pageExpenses, headlines: pageHeadlines, vto: pageVto, chart: pageChart, settings: pageSettings,
};

let routeSeq = 0;
async function route(soft = false) {
  if (!S.me) return;
  const seq = ++routeSeq;
  const [name, arg] = (location.hash.replace(/^#\/?/, "") || "home").split("/");
  const fn = ROUTES[name] || pageHome;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.href === "#/" + (name === "meeting" ? "meetings" : name)));
  const view = $("#view");
  if (!view) return;
  // Fresh container per navigation, so a slow page that finishes late renders into a detached node.
  const page = h("div");
  if (soft !== true || !view.firstElementChild) {
    clearTimers();
    view.replaceChildren(page);
    await safe(() => fn(page, arg));
    return;
  }
  // Live refresh: build the new version off-screen, then swap it in so nothing flickers or jumps.
  const scrollers = () => [...view.querySelectorAll(".cal-wrap, .sc-wrap, .chart-scroll, .kanban")];
  const saved = scrollers().map((e) => [e.scrollLeft, e.scrollTop]);
  const winY = window.scrollY;
  page.className = "offscreen";
  view.append(page);
  const oldTimers = S.timers;
  S.timers = [];
  await safe(() => fn(page, arg));
  if (seq !== routeSeq || !page.isConnected) { page.remove(); return; }
  if (userIsBusy()) { S.timers.forEach(clearInterval); S.timers = oldTimers; page.remove(); live.pending = true; return; }
  const act = document.activeElement;
  const refocus = act && act.dataset && act.dataset.liveOk ? [act.dataset.liveOk, act.selectionStart, act.selectionEnd] : null;
  oldTimers.forEach(clearInterval);
  [...view.children].forEach((c) => { if (c !== page) c.remove(); });
  page.className = "";
  scrollers().forEach((e, i) => { if (saved[i]) { e.scrollLeft = saved[i][0]; e.scrollTop = saved[i][1]; } });
  window.scrollTo(0, winY);
  if (refocus) {
    const el = page.querySelector(`[data-live-ok="${refocus[0]}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(refocus[1], refocus[2]); } catch (e) { /* not a text input */ } }
  }
}

// ---------------------------------------------------------------- live updates
const RESOURCE_LABELS = {
  issues: "Issues", todos: "To-Dos", rocks: "Rocks", measurables: "the Scorecard", headlines: "Headlines", meetings: "a meeting",
  seats: "the Accountability Chart", vto: "the V/TO", boards: "Boards", board_columns: "a board", expenses: "Expenses", users: "People", teams: "Teams", availability: "their calendar", settings: "Settings",
};
const live = { es: null, pending: false, needBasics: false, online: [], version: null, lastToast: {} };

function userIsBusy() {
  if (S.dragging) return true;
  if ($("#modal-root") && $("#modal-root").children.length) return true;
  const a = document.activeElement;
  // Inputs marked data-live-ok (search boxes, filters) don't hold back live refreshes.
  return !!(a && a.closest && a.closest("#view") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox" && !a.dataset.liveOk);
}

function startLive() {
  stopLive();
  if (!window.EventSource) return;
  const es = new EventSource("/api/events?client=" + encodeURIComponent(CLIENT_ID));
  live.es = es;
  let first = true;
  es.onmessage = (msg) => {
    let ev; try { ev = JSON.parse(msg.data); } catch (e) { return; }
    if (ev.type === "hello") {
      if (live.version && ev.version !== live.version) { location.reload(); return; } // Tenfold was updated on the server
      live.version = ev.version;
      live.online = ev.online || [];
      renderPresence();
      if (!first) { live.pending = true; live.needBasics = true; } // reconnected: catch up on anything missed
      first = false;
    } else if (ev.type === "presence") {
      live.online = ev.online || [];
      renderPresence();
    } else if (ev.type === "change" && ev.client !== CLIENT_ID) {
      if (["users", "teams", "settings"].includes(ev.resource)) live.needBasics = true;
      live.pending = true;
      const who = ev.user_id && ev.user_id !== S.me.id ? userName(ev.user_id) : null;
      const key = `${ev.user_id}|${ev.resource}`;
      if (who && Date.now() - (live.lastToast[key] || 0) > 15000) {
        live.lastToast[key] = Date.now();
        toast(`${who} updated ${RESOURCE_LABELS[ev.resource] || ev.resource}`);
      }
    }
  };
  es.addEventListener("error", () => { live.online = []; renderPresence(true); });
}

function stopLive() { if (live.es) { live.es.close(); live.es = null; } }

async function applyLiveUpdate() {
  if (!live.pending || !S.me || userIsBusy()) return;
  live.pending = false;
  if (live.needBasics) {
    live.needBasics = false;
    await safe(loadBasics);
    const sel = $(".side select");
    if (sel) {
      sel.replaceChildren(...S.teams.map((t) => h("option", { value: t.id, selected: t.id === S.teamId }, t.name)));
    } else if (S.teams.length) { renderShell(); route(); return; }
  }
  await route(true);
}
setInterval(applyLiveUpdate, 700);

function renderPresence(offline) {
  const el = $("#presence");
  if (!el || !S.me) return;
  const others = live.online.filter((id) => id !== S.me.id && userById(id));
  el.replaceChildren(
    h("div", { class: "presence" + (offline || !live.es || live.es.readyState === 2 ? " off" : "") },
      h("i", { class: "dot" }), others.length ? ["Online", avatars(others)] : live.es && live.es.readyState === 1 ? "Live" : "Reconnecting…"));
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
  startLive();
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

// ---- to-dos (weekly to-dos, board tasks and milestones all live here)
const TODO_SCOPES = [["all", "All"], ["weekly", "Weekly"], ["tasks", "Board tasks"], ["milestones", "Milestones"]];
function inScope(t, scope) {
  if (scope === "weekly") return !t.board_id && !t.milestone;
  if (scope === "tasks") return !!t.board_id;
  if (scope === "milestones") return !!t.milestone;
  // meeting: weekly to-dos, plus board tasks and milestones that are due within a week (or overdue)
  if (scope === "meeting") return (!t.board_id && !t.milestone) || (!!t.due_date && t.due_date <= addDays(today(), 7));
  return true;
}
let rockCache = { at: 0, list: [] };
async function allRocks(force) {
  if (force || Date.now() - rockCache.at > 5000) rockCache = { at: Date.now(), list: await api("GET", "rocks") };
  return rockCache.list;
}
const rockTitle = (id) => ((rockCache.list.find((r) => r.id === id) || {}).title || "");
function taskTags(t, { showRock = true } = {}) {
  return [
    t.milestone ? h("span", { class: "mtag", title: "Milestone" }, "◆ Milestone") : null,
    t.ext_key ? h("span", { class: "tag ktag-key", title: "Board task" }, t.ext_key) : (t.board_id ? h("span", { class: "tag", title: "Board task" }, "Board") : null),
    showRock && t.rock_id && rockTitle(t.rock_id) ? h("span", { class: "rtag", title: "Rock: " + rockTitle(t.rock_id) }, "▲ " + rockTitle(t.rock_id)) : null,
  ];
}

async function todosPanel(el, opts = {}) {
  const { teamId, ownerId, showDone = false, compact = false, title = "To-Dos", onChange, meeting = false } = opts;
  const scopeKey = meeting ? "tf_todo_scope_meeting" : "tf_todo_scope";
  const scopes = meeting ? [["meeting", "Due this week"], ["all", "All"]] : TODO_SCOPES;
  let scope = store.get(scopeKey);
  if (!scopes.some(([k]) => k === scope)) scope = scopes[0][0];
  const q = new URLSearchParams();
  if (teamId) q.set("team_id", teamId);
  if (ownerId) q.set("owner_id", ownerId);
  q.set("since", new Date(Date.now() - 7 * 864e5).toISOString());
  let [items] = await Promise.all([api("GET", "todos?" + q), allRocks()]);
  if (!showDone) items = items.filter((t) => !t.done || (t.done_at && Date.now() - new Date(t.done_at) < 7 * 864e5));
  const reload = () => { el.innerHTML = ""; todosPanel(el, opts); onChange && onChange(); };
  const counts = Object.fromEntries(scopes.map(([k]) => [k, items.filter((t) => !t.done && inScope(t, k)).length]));
  const shown = items.filter((t) => inScope(t, scope));
  const list = h("ul", { class: "rows" });
  if (!shown.length) list.append(h("li", { class: "empty" }, scope === "milestones" ? "No milestones here yet." : "Nothing to do. Nice."));
  for (const t of shown) {
    const overdue = !t.done && t.due_date && t.due_date < today();
    list.append(h("li", { class: "rowi" + (t.done ? " done" : "") + (t.milestone ? " milestone" : "") },
      h("input", { type: "checkbox", class: "check", checked: !!t.done, "aria-label": "Done", onchange: (e) => safe(async () => { await api("PUT", "todos/" + t.id, { done: e.target.checked ? 1 : 0 }); reload(); }) }),
      h("div", { class: "title", onclick: () => editTodo(t, reload) },
        h("div", { class: "t" }, t.title),
        h("div", { class: "tags" }, taskTags(t)),
        t.description && !compact && !t.board_id ? h("div", { class: "d" }, t.description) : null),
      !teamId ? h("span", { class: "tag" }, teamName(t.team_id)) : null,
      h("span", { class: "meta" + (overdue ? " overdue" : "") }, t.due_date ? (overdue ? "Overdue · " : "Due ") + fmtDate(t.due_date) : ""),
      avatars(ownersOf(t))));
  }
  const qa = h("input", { placeholder: "Add a to-do and press Enter…", "aria-label": "New to-do" });
  qa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && qa.value.trim()) safe(async () => {
      await api("POST", "todos", { title: qa.value.trim(), team_id: teamId || S.teamId, owner_id: ownerId || S.me.id, due_date: addDays(today(), 7), milestone: scope === "milestones" ? 1 : 0 });
      reload();
    });
  });
  const seg = h("div", { class: "seg" }, scopes.map(([k, label]) => h("button", {
    class: scope === k ? "on" : "", onclick: () => { store.set(scopeKey, k); reload(); },
  }, label, counts[k] ? h("span", { class: "segn" }, counts[k]) : null)));
  el.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, title), seg, h("span", { class: "spacer" }),
      h("button", { class: "btn small", onclick: () => editTodo({ team_id: teamId || S.teamId, owner_id: ownerId || S.me.id, due_date: addDays(today(), 7), milestone: scope === "milestones" ? 1 : 0 }, reload) }, "+ To-Do")),
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

// One editor for every kind of to-do. Board tasks are shared by their owners; weekly to-dos are copied per person.
async function editTodo(t, done, ctx = {}) {
  const teamId = t.team_id || S.teamId;
  const [rocks, columns] = await Promise.all([
    allRocks(true),
    t.board_id ? (ctx.columns ? Promise.resolve(ctx.columns) : api("GET", "board_columns?board_id=" + t.board_id)) : Promise.resolve(null),
  ]);
  const teamRocks = rocks.filter((r) => r.team_id === teamId).sort((a, b) => (a.status === "done") - (b.status === "done") || String(b.quarter).localeCompare(String(a.quarter)));
  const rockField = { name: "rock_id", label: "Rock", type: "select", value: t.rock_id || "", options: [["", "No rock"], ...teamRocks.map((r) => [r.id, `${r.title}${r.quarter ? " · " + r.quarter : ""}`])] };
  const milestoneField = { name: "milestone", label: "Milestone (shows a Milestone tag; still checks off like a to-do)", type: "checkbox", value: t.milestone };
  const isTask = !!t.board_id;
  const fields = isTask ? [
    { name: "title", label: "Title", value: t.title, required: true },
    { name: "description", label: "Description", type: "textarea", value: t.description, rows: 5 },
    { name: "column_id", label: "Status", type: "select", options: columns.map((c) => [c.id, c.name]), value: t.column_id || (columns[0] || {}).id, half: true },
    { name: "due_date", label: "Due", type: "date", value: t.due_date, half: true },
    ownersField(ownersOf(t).length ? ownersOf(t) : idList(t.owner_ids || []), { required: false, hint: "Everyone picked shares this task." }),
    rockField,
    { name: "priority", label: "Priority", type: "select", options: [["", "None"], ["P0", "P0 · urgent"], ["P1", "P1 · high"], ["P2", "P2 · normal"]], value: t.priority || "", half: true },
    { name: "project", label: "Project", value: t.project, half: true },
    { name: "phase", label: "Phase", value: t.phase, half: true },
    { name: "workstream", label: "Workstream", value: t.workstream, half: true },
    milestoneField,
  ] : [
    { name: "title", label: "Title", value: t.title, required: true },
    { name: "description", label: "Details", type: "textarea", value: t.description, rows: 3 },
    ownersField([t.owner_id], t.id ? { hint: "Adding people gives each of them their own copy of this to-do." } : {}),
    { name: "due_date", label: "Due", type: "date", value: t.due_date, half: true },
    { name: "team_id", label: "Team", type: "select", options: S.teams.map((x) => [x.id, x.name]), value: teamId, half: true },
    rockField,
    milestoneField,
  ];
  formModal({
    title: (t.id ? "Edit " : "New ") + (isTask ? "task" : "to-do") + (t.ext_key ? " · " + t.ext_key : ""),
    fields,
    submitLabel: t.id ? "Save" : "Add",
    onSubmit: async (v) => {
      const common = { rock_id: v.rock_id ? Number(v.rock_id) : null, milestone: v.milestone ? 1 : 0 };
      if (isTask) {
        const body = { ...v, ...common, owner_ids: idList(v.owner_ids), column_id: Number(v.column_id), board_id: t.board_id, team_id: teamId };
        if (t.id && body.column_id === t.column_id) delete body.column_id; // unchanged: keep its place in the column
        await api(t.id ? "PUT" : "POST", "todos" + (t.id ? "/" + t.id : ""), body);
        done();
        return;
      }
      if (!t.id) { await createTodosForOwners({ ...v, ...common }); done(); return; }
      const { owner_ids, ...rest } = v;
      const ids = idList(owner_ids);
      const keep = ids.includes(t.owner_id) ? t.owner_id : ids[0];
      await api("PUT", "todos/" + t.id, { ...rest, ...common, owner_id: keep, owner_ids: [keep] });
      const others = ids.filter((x) => x !== keep);
      for (const o of others) await api("POST", "todos", { ...rest, ...common, owner_id: o, issue_id: t.issue_id });
      if (others.length) toast(`Added a copy for ${others.length} more ${others.length === 1 ? "person" : "people"}`);
      done();
    },
    onDelete: t.id ? async () => { await api("DELETE", "todos/" + t.id); done(); } : null,
    extraButtons: isTask && t.id ? (close) => [h("button", {
      class: "btn", type: "button", title: "Add this task to the team's Issues list",
      onclick: () => safe(async () => { await api("POST", "issues", { title: t.title, description: t.description, team_id: teamId, owner_ids: ownersOf(t) }); close(); toast("Added to Issues"); }),
    }, "Make it an issue")] : null,
  });
}

// ---- kanban boards (cards are to-dos)
const KCOLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const tagColor = (t) => KCOLORS[[...t.toLowerCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % KCOLORS.length];
const colorOptions = () => KCOLORS.map((c) => [c, c[0].toUpperCase() + c.slice(1)]);
const boardFilter = { q: "", mine: false, priority: "", project: "", phase: "", workstream: "", rock: "", milestones: false };

async function pageBoards(view) {
  if (needTeam(view)) return;
  const [boards] = await Promise.all([api("GET", "boards?team_id=" + S.teamId), allRocks(true)]);
  const reload = () => route();
  const key = "tf_board_" + S.teamId;
  const board = boards.find((b) => String(b.id) === store.get(key)) || boards[0];

  const newBoard = () => formModal({
    title: "New board",
    fields: [{ name: "name", label: "Board name", required: true, placeholder: "e.g. Product launch, Website, Hiring" }],
    submitLabel: "Create board",
    onSubmit: async (v) => { const b = await api("POST", "boards", { ...v, team_id: S.teamId, sort: Date.now() / 1000 }); store.set(key, b.id); reload(); },
  });
  const importBtn = h("button", { class: "btn", onclick: () => importWizard(key) }, "Import from Notion / CSV");
  view.append(pageHead("Boards", teamName(S.teamId) + " · every card is also a to-do", importBtn));

  if (!board) {
    view.append(h("div", { class: "card empty" },
      h("p", {}, "Boards are kanban lists for your team's projects. Every card is also a to-do: dragging it to Done checks it off, and checking it off moves it to Done."),
      h("div", { class: "toolbar", style: { justifyContent: "center" } },
        h("button", { class: "btn primary", onclick: newBoard }, "Create a board"), h("button", { class: "btn", onclick: () => importWizard(key) }, "Import from Notion / CSV"))));
    return;
  }
  store.set(key, board.id);
  const editBoard = (b) => formModal({
    title: "Board settings",
    fields: [{ name: "name", label: "Board name", value: b.name, required: true, hint: "Deleting a board also deletes its tasks." }],
    onSubmit: async (v) => { await api("PUT", "boards/" + b.id, v); reload(); },
    onDelete: async () => { await api("DELETE", "boards/" + b.id); store.set(key, ""); reload(); },
  });
  view.append(h("div", { class: "board-tabs" },
    boards.map((b) => h("button", { class: "btab" + (b.id === board.id ? " on" : ""), onclick: () => { store.set(key, b.id); reload(); } }, b.name,
      b.id === board.id ? h("span", { class: "bmenu", title: "Rename or delete board", onclick: (e) => { e.stopPropagation(); editBoard(b); } }, "⋯") : null)),
    h("button", { class: "btab add", onclick: newBoard }, "+ New board")));

  const [columns, cards] = await Promise.all([api("GET", "board_columns?board_id=" + board.id), api("GET", "todos?board_id=" + board.id)]);
  const colById = new Map(columns.map((c) => [c.id, c]));

  // filters
  const distinct = (k) => [...new Set(cards.map((c) => c[k]).filter(Boolean))].sort();
  const filterSelect = (k, label, values) => values.length ? h("select", {
    class: "input fsel", "data-live-ok": "bf-" + k, "aria-label": label,
    onchange: (e) => { boardFilter[k] = e.target.value; draw(); },
  }, h("option", { value: "" }, label + ": all"), values.map(([v, l]) => h("option", { value: v, selected: String(boardFilter[k]) === String(v) }, l))) : null;
  const search = h("input", { class: "input kq", type: "search", placeholder: "Search…", value: boardFilter.q, "aria-label": "Search tasks", "data-live-ok": "bf-q" });
  let qT;
  search.addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(() => { boardFilter.q = search.value; draw(); }, 150); });
  const toggle = (k, label) => {
    const b = h("button", { class: "btn small" + (boardFilter[k] ? " primary" : ""), onclick: () => { boardFilter[k] = !boardFilter[k]; b.classList.toggle("primary", boardFilter[k]); draw(); } }, label);
    return b;
  };
  const usedRocks = [...new Set(cards.map((c) => c.rock_id).filter(Boolean))].map((id) => [id, rockTitle(id) || "Rock " + id]);
  const counter = h("span", { class: "meta" });
  view.append(h("div", { class: "filters" }, search, toggle("mine", "Mine"), toggle("milestones", "◆ Milestones"),
    filterSelect("priority", "Priority", distinct("priority").map((v) => [v, v])),
    filterSelect("rock", "Rock", usedRocks),
    filterSelect("project", "Project", distinct("project").map((v) => [v, v])),
    filterSelect("phase", "Phase", distinct("phase").map((v) => [v, v])),
    filterSelect("workstream", "Workstream", distinct("workstream").map((v) => [v, v])),
    h("span", { style: { flex: 1 } }), counter));

  const kanban = h("div", { class: "kanban" });
  view.append(kanban);
  const visible = (c) => {
    const f = boardFilter;
    if (f.mine && !ownersOf(c).includes(S.me.id)) return false;
    if (f.milestones && !c.milestone) return false;
    for (const k of ["priority", "project", "phase", "workstream"]) if (f[k] && c[k] !== f[k]) return false;
    if (f.rock && String(c.rock_id) !== String(f.rock)) return false;
    const q = f.q.trim().toLowerCase();
    return !q || [c.title, c.description, c.ext_key, c.project].some((x) => (x || "").toLowerCase().includes(q));
  };
  const cardsIn = (colId) => cards.filter((c) => c.column_id === colId).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const prioClass = { P0: "red", P1: "orange", P2: "gray" };

  function cardEl(c) {
    const col = colById.get(c.column_id) || {};
    const overdue = c.due_date && c.due_date < today() && !col.is_done;
    const owners = ownersOf(c);
    return h("div", { class: "kcard" + (c.milestone ? " milestone" : ""), "data-id": c.id, tabindex: 0, onkeydown: (e) => { if (e.key === "Enter") openCard(c); } },
      c.ext_key || c.priority ? h("div", { class: "ktop" }, c.ext_key ? h("span", { class: "kkey" }, c.ext_key) : null,
        c.priority ? h("span", { class: "kprio c-" + (prioClass[c.priority] || "gray") }, c.priority) : null) : null,
      h("div", { class: "kt" }, c.title),
      c.milestone || c.rock_id || c.project ? h("div", { class: "ktags" },
        c.milestone ? h("span", { class: "mtag" }, "◆ Milestone") : null,
        c.rock_id && rockTitle(c.rock_id) ? h("span", { class: "rtag", title: "Rock" }, "▲ " + rockTitle(c.rock_id)) : null,
        c.project ? h("span", { class: "ktag c-" + tagColor(c.project) }, c.project) : null) : null,
      c.due_date || owners.length || c.description ? h("div", { class: "kmeta" },
        c.due_date ? h("span", { class: "kdue" + (overdue ? " overdue" : "") }, "◷ " + fmtDate(c.due_date)) : null,
        c.description ? h("span", { title: "Has a description" }, "≡") : null,
        h("span", { style: { flex: 1 } }), owners.length ? avatars(owners) : null) : null);
  }

  function draw() {
    const sx = kanban.scrollLeft;
    kanban.replaceChildren();
    let shown = 0;
    columns.forEach((col, ci) => {
      const inCol = cardsIn(col.id), vis = inCol.filter(visible);
      shown += vis.length;
      const list = h("div", { class: "kcards", "data-col": col.id }, vis.map(cardEl));
      const adder = h("button", { class: "kadd", onclick: () => quickAdd(col, list, adder) }, "+ New");
      kanban.append(h("div", { class: "kcol", "data-col": col.id },
        h("div", { class: "khead" },
          h("span", { class: "kname c-" + (col.color || "gray") }, col.name),
          h("span", { class: "kcount" }, vis.length === inCol.length ? inCol.length : `${vis.length}/${inCol.length}`),
          col.is_done ? h("span", { class: "kdone", title: "Cards here count as done" }, "✓") : null,
          h("span", { style: { flex: 1 } }),
          h("button", { class: "kicon", title: "Column settings", onclick: () => editColumn(col, ci) }, "⋯"),
          h("button", { class: "kicon", title: "Add a task", onclick: () => editTodo({ board_id: board.id, column_id: col.id, team_id: S.teamId, owner_ids: [S.me.id] }, reload, { columns }) }, "+")),
        list, adder));
    });
    kanban.append(h("div", { class: "kcol ghostcol" }, h("button", {
      class: "kadd", onclick: () => formModal({
        title: "New column",
        fields: [{ name: "name", label: "Column name", required: true },
          { name: "color", label: "Color", type: "select", options: colorOptions(), value: KCOLORS[columns.length % KCOLORS.length] },
          { name: "is_done", label: "Cards in this column count as done", type: "checkbox", value: 0 }],
        onSubmit: async (v) => { await api("POST", "board_columns", { ...v, board_id: board.id, sort: (columns.length ? columns[columns.length - 1].sort : 0) + 1 }); reload(); },
      }),
    }, "+ Add column")));
    counter.textContent = shown === cards.length ? `${cards.length} tasks` : `${shown} of ${cards.length} tasks`;
    kanban.scrollLeft = sx;
  }

  function openCard(c) { editTodo(c, reload, { columns }); }

  function quickAdd(col, list, adder) {
    const inp = h("textarea", { class: "kinput", rows: 2, placeholder: "Type a name, then press Enter…" });
    const box = h("div", { class: "kcard editing" }, inp);
    list.append(box);
    adder.style.display = "none";
    inp.focus();
    const close = () => { box.remove(); adder.style.display = ""; };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const title = inp.value.trim();
        if (!title) { close(); return; }
        inp.value = "";
        safe(async () => {
          const c = await api("POST", "todos", { board_id: board.id, column_id: col.id, team_id: S.teamId, title, owner_ids: [S.me.id] });
          cards.push(c);
          box.before(cardEl(c));
          const cnt = list.parentElement.querySelector(".kcount");
          if (cnt) cnt.textContent = cardsIn(col.id).length;
        });
      }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (box.isConnected && !inp.value.trim() && document.activeElement !== inp) close(); }, 150));
  }

  function editColumn(col, ci) {
    const swap = async (dir) => {
      const other = columns[ci + dir];
      if (!other) return;
      const a = col.sort, b = other.sort === col.sort ? col.sort + dir : other.sort;
      await api("PUT", "board_columns/" + col.id, { sort: b });
      await api("PUT", "board_columns/" + other.id, { sort: a });
      reload();
    };
    formModal({
      title: "Column",
      fields: [
        { name: "name", label: "Name", value: col.name, required: true },
        { name: "color", label: "Color", type: "select", options: colorOptions(), value: col.color || "gray" },
        { name: "is_done", label: "Cards in this column count as done (their to-dos are checked off)", type: "checkbox", value: col.is_done },
      ],
      onSubmit: async (v) => { await api("PUT", "board_columns/" + col.id, v); reload(); },
      onDelete: columns.length > 1 ? async () => { await api("DELETE", "board_columns/" + col.id); reload(); } : null,
      extraButtons: (c) => [
        ci > 0 ? h("button", { class: "btn", type: "button", onclick: () => safe(async () => { c(); await swap(-1); }) }, "← Move") : null,
        ci < columns.length - 1 ? h("button", { class: "btn", type: "button", onclick: () => safe(async () => { c(); await swap(1); }) }, "Move →") : null,
      ],
    });
  }

  // Drag and drop with pointer events (mouse, pen and touch).
  // On touch, press and hold briefly before dragging, so a normal swipe still scrolls the board.
  let justDragged = 0;
  kanban.addEventListener("click", (e) => {
    const el = e.target.closest(".kcard:not(.editing)");
    if (!el || Date.now() - justDragged < 300) return;
    const c = cards.find((x) => x.id === Number(el.dataset.id));
    if (c) openCard(c);
  });
  kanban.addEventListener("contextmenu", (e) => { if (e.target.closest(".kcard")) e.preventDefault(); }); // long-press menu on phones
  // A sideways swipe that would go past the board's edge triggers the browser's back/forward gesture
  // on some phones. Swallow just those edge swipes; normal scrolling is untouched.
  let tx = 0, ty = 0;
  kanban.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  kanban.addEventListener("touchmove", (e) => {
    if (S.dragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - tx, dy = e.touches[0].clientY - ty;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    const atLeft = kanban.scrollLeft <= 0, atRight = kanban.scrollLeft + kanban.clientWidth >= kanban.scrollWidth - 1;
    if ((dx > 0 && atLeft) || (dx < 0 && atRight)) e.preventDefault();
  }, { passive: false });
  kanban.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".kcard:not(.editing)");
    if (!card || e.button !== 0 || e.target.closest("button, a, input, textarea, select")) return;
    const touch = e.pointerType === "touch";
    const sx = e.clientX, sy = e.clientY;
    let armed = !touch, dragging = false, finished = false, ghost, ph, offX, offY, lastX = sx, lastY = sy, raf;
    const holdT = touch ? setTimeout(() => { armed = true; card.classList.add("armed"); if (navigator.vibrate) navigator.vibrate(15); }, 280) : null;
    const blockScroll = (ev) => { if (armed) ev.preventDefault(); };
    card.addEventListener("touchmove", blockScroll, { passive: false });

    const start = () => {
      dragging = true;
      S.dragging = true;
      const r = card.getBoundingClientRect();
      offX = sx - r.left; offY = sy - r.top;
      ghost = card.cloneNode(true);
      ghost.classList.add("kghost");
      ghost.classList.remove("kcard", "armed");
      ghost.style.width = r.width + "px";
      document.body.append(ghost);
      ph = h("div", { class: "kph", style: { height: r.height + "px" } });
      card.after(ph);
      card.style.display = "none";
      document.body.classList.add("kdragging");
    };
    const place = () => {
      ghost.style.transform = `translate(${lastX - offX}px, ${lastY - offY}px) rotate(2deg)`;
      const under = document.elementFromPoint(lastX, lastY);
      const colEl = under && under.closest(".kcol:not(.ghostcol)");
      const list = colEl && colEl.querySelector(".kcards");
      if (list) {
        const after = [...list.querySelectorAll(".kcard")].filter((x) => x !== card)
          .find((x) => { const r = x.getBoundingClientRect(); return lastY < r.top + r.height / 2; });
        if (after) { if (ph.nextSibling !== after) list.insertBefore(ph, after); }
        else if (list.lastElementChild !== ph) list.append(ph);
      }
      const kr = kanban.getBoundingClientRect();
      if (lastX > kr.right - 70) kanban.scrollLeft += 14;
      else if (lastX < kr.left + 70) kanban.scrollLeft -= 14;
    };
    const cleanup = () => {
      clearTimeout(holdT);
      card.classList.remove("armed");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
      card.removeEventListener("touchmove", blockScroll);
    };
    function move(ev) {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!dragging) {
        const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (!armed) { if (dist > 8) cleanup(); return; } // touch moved before the hold finished: it's a scroll
        if (dist < 6) return;
        start();
      }
      ev.preventDefault();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    }
    function up() {
      if (finished) return;
      finished = true;
      cleanup();
      if (!dragging) return;
      cancelAnimationFrame(raf);
      ghost.remove();
      document.body.classList.remove("kdragging");
      const list = ph.parentElement;
      const prevEl = ph.previousElementSibling, nextEl = ph.nextElementSibling;
      ph.replaceWith(card);
      card.style.display = "";
      S.dragging = false;
      justDragged = Date.now();
      const c = cards.find((x) => x.id === Number(card.dataset.id));
      if (!list || !c) return;
      const sortOf = (el) => (el && el.classList.contains("kcard") ? (cards.find((x) => x.id === Number(el.dataset.id)) || {}).sort : undefined);
      const a = sortOf(prevEl), b = sortOf(nextEl);
      const newSort = a != null && b != null ? (a + b) / 2 : a != null ? a + 1 : b != null ? b - 1 : 0;
      const newCol = Number(list.dataset.col);
      if (newCol === c.column_id && newSort === c.sort) return;
      const before = { column_id: c.column_id, sort: c.sort, done: c.done };
      Object.assign(c, { column_id: newCol, sort: newSort, done: (colById.get(newCol) || {}).is_done ? 1 : 0 });
      draw();
      api("PUT", "todos/" + c.id, { column_id: newCol, sort: newSort })
        .catch((err) => { Object.assign(c, before); draw(); toast(err.message, true); });
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
  });

  draw();
}

// ---- import from Notion (zip or CSV) or any CSV
function importWizard(boardKey) {
  const file = h("input", { type: "file", accept: ".zip,.csv,text/csv,application/zip" });
  const status = h("div", { class: "hint" });
  const body = h("div", {},
    h("p", { class: "muted", style: { marginTop: 0 } }, "In Notion, open the database, choose ··· → Export → Markdown & CSV, then upload the zip here. A plain CSV works too."),
    h("div", { class: "field" }, h("label", {}, "File"), file), status);
  let state = null;
  const close = openModal("Import tasks", body, (c) => [h("span", { class: "spacer" }), h("button", { class: "btn", onclick: c }, "Cancel")]);
  file.addEventListener("change", () => safe(async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast("That file is too large (20 MB max)", true); return; }
    status.textContent = "Reading…";
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = () => rej(new Error("Couldn't read the file"));
      r.readAsDataURL(f);
    });
    let preview;
    try { preview = await api("POST", "import/preview", { team_id: S.teamId, filename: f.name, data }); }
    catch (e) { status.textContent = e.message; throw e; }
    state = { filename: f.name, data, preview };
    close();
    importReview(state, boardKey);
  }));
}

function importReview(state, boardKey) {
  const p = state.preview;
  const name = h("input", { class: "input", value: p.board_name });
  const peoplePickers = p.people.map((person) => {
    const sel = new Set((person.guess || []).map(String));
    const chips = h("div", { class: "chips" }, S.users.map((u) => h("label", { class: "chip" },
      h("input", { type: "checkbox", value: u.id, checked: sel.has(String(u.id)) }), avatar(u.id), h("span", {}, u.name))));
    return { person, chips };
  });
  const rockOptions = [["", "No rock"], ...p.rocks.map((r) => [r.id, `${r.title}${r.quarter ? " · " + r.quarter : ""}`])];
  const rockPickers = p.rock_values.map((rv) => {
    const sel = h("select", { class: "input" }, rockOptions.map(([v, l]) => h("option", { value: v, selected: String(rv.guess || "") === String(v) }, l)));
    return { rv, sel };
  });
  const unmatched = () => peoplePickers.filter((x) => !x.chips.querySelector("input:checked")).length;
  const body = h("div", { class: "import-review" },
    h("div", { class: "stats", style: { marginBottom: "14px" } },
      h("div", { class: "stat" }, h("div", { class: "n" }, p.total), h("div", { class: "l" }, "tasks")),
      h("div", { class: "stat" }, h("div", { class: "n" }, p.milestones), h("div", { class: "l" }, "milestones")),
      h("div", { class: "stat" }, h("div", { class: "n" }, p.columns.length), h("div", { class: "l" }, "columns: " + p.columns.map((c) => c.name).join(", ")))),
    h("div", { class: "field" }, h("label", {}, "Board name"), name),
    p.people.length ? [h("h4", {}, `People (from the "${p.people_field}" column)`),
      h("p", { class: "hint" }, "Pick who each name or role should be assigned to. Tasks can have several people."),
      peoplePickers.map(({ person, chips }) => h("div", { class: "map-row" }, h("div", { class: "map-from" }, person.name, h("span", { class: "muted" }, ` · ${person.count}`)), chips))] : null,
    p.rock_values.length ? [h("h4", {}, `Rocks (from the "${p.rock_field}" column)`),
      h("p", { class: "hint" }, "Link tasks to this team's rocks."),
      rockPickers.map(({ rv, sel }) => h("div", { class: "map-row" }, h("div", { class: "map-from" }, rv.name, h("span", { class: "muted" }, ` · ${rv.count}`)), sel))] : null);
  openModal("Review import", body, (c) => [
    h("span", { class: "spacer" }),
    h("button", { class: "btn", onclick: c }, "Cancel"),
    h("button", {
      class: "btn primary", onclick: (e) => safe(async () => {
        const left = unmatched();
        if (left && !confirm(`${left} name${left === 1 ? " isn't" : "s aren't"} matched to anyone. Those tasks will be unassigned. Import anyway?`)) return;
        e.target.disabled = true;
        e.target.textContent = "Importing…";
        try {
          const res = await api("POST", "import/run", {
            team_id: S.teamId, filename: state.filename, data: state.data, board_name: name.value.trim() || p.board_name,
            people_map: Object.fromEntries(peoplePickers.map(({ person, chips }) => [person.name, [...chips.querySelectorAll("input:checked")].map((i) => Number(i.value))])),
            rock_map: Object.fromEntries(rockPickers.map(({ rv, sel }) => [rv.name, sel.value ? Number(sel.value) : null])),
          });
          store.set(boardKey, res.board_id);
          c();
          toast(`Imported ${res.tasks} tasks${res.milestones ? ` (${res.milestones} milestones)` : ""}`);
          location.hash = "#/boards";
          route();
        } finally { e.target.disabled = false; e.target.textContent = "Import"; }
      }),
    }, "Import"),
  ]);
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
  const [items, linked] = await Promise.all([api("GET", "rocks?" + q), api("GET", "todos" + (teamId ? "?team_id=" + teamId : ""))]);
  const reload = () => { el.innerHTML = ""; rocksPanel(el, { ...opts, quarter }); };
  const progress = (r) => {
    const mine = linked.filter((t) => t.rock_id === r.id);
    const ms = mine.filter((t) => t.milestone), tasks = mine.filter((t) => !t.milestone);
    if (!mine.length) return null;
    const done = (xs) => xs.filter((t) => t.done).length;
    return h("div", { class: "rprog" },
      ms.length ? h("span", { class: "mtag" }, `◆ ${done(ms)}/${ms.length} milestones`) : null,
      tasks.length ? h("span", { class: "tag" }, `${done(tasks)}/${tasks.length} tasks`) : null,
      h("a", { href: "#/boards", onclick: () => { boardFilter.rock = String(r.id); } }, "View on board →"));
  };
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
          h("div", { class: "d" }, ownerNames(ownersOf(r)) + (teamId ? "" : " · " + teamName(r.team_id)) + (r.description && !meeting ? " — " + r.description : "")),
          progress(r)),
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
  if (needTeam(view)) return;
  const seats = await api("GET", "seats?team_id=" + S.teamId);
  const reload = () => route();
  view.append(pageHead("Accountability Chart", teamName(S.teamId) + " · seats, the people in them, and the 3–5 roles each owns",
    h("button", { class: "btn primary", onclick: () => editSeat({ team_id: S.teamId, parent_id: null }, seats, reload) }, "+ Seat")));
  const kids = (pid) => seats.filter((s) => (s.parent_id || null) === pid).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const node = (s) => {
    const roles = (s.roles || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const children = kids(s.id);
    return h("li", {},
      h("div", { class: "seat" },
        h("div", { class: "seat-top" }, h("span", {}, s.title),
          h("button", { title: "Add a seat under this one", onclick: () => editSeat({ team_id: s.team_id || S.teamId, parent_id: s.id }, seats, reload) }, "+"),
          h("button", { title: "Edit seat", onclick: () => editSeat(s, seats, reload) }, "✎")),
        ownersOf(s, "user_id", "user_ids").length
          ? ownersOf(s, "user_id", "user_ids").map((id) => h("div", { class: "seat-person" }, avatar(id), userName(id)))
          : h("div", { class: "seat-person vacant" }, "Open seat"),
        roles.length ? h("ul", { class: "roles" }, roles.map((r) => h("li", {}, r))) : null),
      children.length ? h("ul", {}, children.map(node)) : null);
  };
  const roots = kids(null);
  if (!roots.length) {
    view.append(h("div", { class: "card empty" }, h("p", {}, `${teamName(S.teamId)} doesn't have an accountability chart yet. Start with the top seat (often Visionary or Integrator), then add the seats that report to it.`),
      h("button", { class: "btn primary", onclick: () => editSeat({ team_id: S.teamId, parent_id: null, title: "Visionary" }, seats, reload) }, "Add the first seat")));
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
    onSubmit: async (v) => { await api(s.id ? "PUT" : "POST", "seats" + (s.id ? "/" + s.id : ""), { ...v, user_ids: idList(v.user_ids), team_id: s.team_id || S.teamId }); done(); },
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
  let saveT;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(persist, 800); };
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
      return scorecardPanel(box, { weeks: 6 });
    } else if (key === "rocks") {
      content.append(h("div", { class: "prompt" }, "Each owner says “on track” or “off track”. Off-track rocks go to Issues."));
      const box = h("div"); content.append(box);
      return rocksPanel(box, { meeting: true, noQuarter: true });
    } else if (key === "headlines") {
      content.append(h("div", { class: "prompt" }, "Quick customer and employee headlines. Anything needing discussion drops to Issues."));
      const box = h("div"); content.append(box);
      return headlinesPanel(box, { meeting: true });
    } else if (key === "todos") {
      content.append(h("div", { class: "prompt" }, "Review last week's to-dos: done or not done. Check them off as you go."));
      const box = h("div"); content.append(box);
      return todosPanel(box, { teamId: S.teamId, title: "Team to-dos", meeting: true });
    } else if (key === "ids") {
      content.append(h("div", { class: "prompt" }, h("b", {}, "Identify, Discuss, Solve. "), "Pick your top 3 issues (click the circle to rank them), then work them in order. Create to-dos as you solve."));
      const box = h("div"); content.append(box);
      return issuesPanel(box, { meeting: true, onChange: async () => {
        const solved = await api("GET", `issues?team_id=${S.teamId}&status=solved`);
        d.solved = solved.filter((i) => i.solved_at && i.solved_at >= m.started_at.slice(0, 19)).map((i) => i.title);
        persist();
      } });
    } else if (key === "conclude") {
      return renderConclude();
    }
  }

  async function renderConclude() {
    const [todos, solved] = await Promise.all([api("GET", "todos?team_id=" + S.teamId), api("GET", `issues?team_id=${S.teamId}&status=solved`)]);
    const startedIso = new Date(m.started_at).toISOString().slice(0, 19);
    const newTodos = todos.filter((t) => t.created_at >= startedIso);
    const solvedNow = solved.filter((i) => i.solved_at && i.solved_at >= startedIso);
    const ratingInputs = S.users.map((u) => {
      const inp = h("input", { type: "number", min: 1, max: 10, class: "input", value: d.ratings[u.id] || "" });
      inp.addEventListener("input", () => { if (inp.value) d.ratings[u.id] = Number(inp.value); else delete d.ratings[u.id]; saveSoon(); });
      return h("div", { class: "r" }, avatar(u.id), h("span", {}, u.name), inp);
    });
    const cascade = h("textarea", { class: "input", rows: 4, placeholder: "What needs to be communicated, to whom, and by whom?" });
    cascade.value = d.notes.cascade || "";
    cascade.addEventListener("input", () => { d.notes.cascade = cascade.value; saveSoon(); });
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
  await renderSection();
  tick();
  S.timers.push(setInterval(tick, 1000));
}

// ---- availability (Google Calendar via secret iCal link)
const HOUR_PX = 44;
let sessionWeekOffset = 0;
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#/availability")) sessionWeekOffset = 0; });
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
  // Week offset lives only for this browser tab session, so the page always opens on the current week.
  let weekOffset = Number(sessionWeekOffset || 0);
  const rangeKey = HOUR_RANGES[store.get("tf_av_hours")] ? store.get("tf_av_hours") : "day";
  const [h0, h1] = HOUR_RANGES[rangeKey];
  const mon = parseYmd(weekStart());
  mon.setDate(mon.getDate() + 7 * weekOffset);
  const days = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return d; });
  const start = new Date(mon), end = new Date(mon); end.setDate(end.getDate() + 7);
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const go = (off) => { sessionWeekOffset = off; route(); };

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

// ---- expenses
const EXPENSE_CATEGORIES = ["Parts & materials", "Prototyping", "Tools & equipment", "Software & subscriptions", "Shipping",
  "Marketing", "Legal & fees", "Travel", "Meals", "Other"];
const REIMBURSE = { none: "Company paid", owed: "Owed", paid: "Paid back" };
const REIMBURSE_PILL = { none: "neutral", owed: "warn", paid: "on" };
const money = (cents) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function parseMoney(v) {
  const n = Number(String(v || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const expenseFilter = { period: "this-month", category: "", project: "", paid_by: "", reimburse: "", q: "" };
function periodRange(p) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const d = (yy, mm, dd) => ymd(new Date(yy, mm, dd));
  switch (p) {
    case "this-month": return [d(y, m, 1), d(y, m + 1, 0)];
    case "last-month": return [d(y, m - 1, 1), d(y, m, 0)];
    case "this-quarter": { const q = Math.floor(m / 3) * 3; return [d(y, q, 1), d(y, q + 3, 0)]; }
    case "this-year": return [d(y, 0, 1), d(y, 11, 31)];
    case "last-year": return [d(y - 1, 0, 1), d(y - 1, 11, 31)];
    default: return [null, null];
  }
}
const PERIODS = [["this-month", "This month"], ["last-month", "Last month"], ["this-quarter", "This quarter"], ["this-year", "This year"], ["last-year", "Last year"], ["all", "All time"]];

async function pageExpenses(view) {
  if (needTeam(view)) return;
  const [all, boards] = await Promise.all([api("GET", "expenses?team_id=" + S.teamId), api("GET", "boards?team_id=" + S.teamId), allRocks()]);
  const reload = () => route();
  const f = expenseFilter;
  const [from, to] = periodRange(f.period);
  const inPeriod = all.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
  const q = f.q.trim().toLowerCase();
  const shown = inPeriod.filter((e) =>
    (!f.category || e.category === f.category) && (!f.project || (e.project || "") === f.project) &&
    (!f.paid_by || String(e.paid_by) === f.paid_by) && (!f.reimburse || e.reimburse === f.reimburse) &&
    (!q || [e.title, e.vendor, e.notes, e.category, e.project].some((x) => (x || "").toLowerCase().includes(q))));
  const sum = (xs) => xs.reduce((a, e) => a + (e.amount_cents || 0), 0);
  const owedAll = all.filter((e) => e.reimburse === "owed");
  const projects = [...new Set([...all.map((e) => e.project), ...boards.map((b) => b.name)].filter(Boolean))].sort();
  const categories = [...new Set([...EXPENSE_CATEGORIES, ...all.map((e) => e.category)].filter(Boolean))];

  const newBtn = h("button", { class: "btn primary", onclick: () => editExpense({ team_id: S.teamId, date: today(), paid_by: S.me.id, reimburse: "owed" }, { projects, categories }, reload) }, "+ Expense");
  const exportBtn = h("button", { class: "btn", onclick: () => exportExpenses(shown) }, "Export CSV");
  view.append(pageHead("Expenses", teamName(S.teamId) + " · what the team is spending on its projects", exportBtn, newBtn));

  const sel = (k, label, opts) => h("select", { class: "input fsel", "data-live-ok": "ef-" + k, "aria-label": label, onchange: (e) => { f[k] = e.target.value; reload(); } },
    h("option", { value: "" }, label + ": all"), opts.map(([v, l]) => h("option", { value: v, selected: String(f[k]) === String(v) }, l)));
  const search = h("input", { class: "input kq", type: "search", placeholder: "Search…", value: f.q, "data-live-ok": "ef-q", "aria-label": "Search expenses" });
  let qT;
  search.addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(() => { f.q = search.value; reload(); }, 300); });
  view.append(h("div", { class: "filters" },
    h("select", { class: "input fsel", "data-live-ok": "ef-period", "aria-label": "Period", onchange: (e) => { f.period = e.target.value; reload(); } },
      PERIODS.map(([v, l]) => h("option", { value: v, selected: f.period === v }, l))),
    search,
    sel("category", "Category", categories.map((c) => [c, c])),
    sel("project", "Project", projects.map((p) => [p, p])),
    sel("paid_by", "Paid by", S.users.map((u) => [u.id, u.name])),
    sel("reimburse", "Reimbursement", Object.entries(REIMBURSE))));

  // summary
  const byCat = new Map(), byProject = new Map(), byPerson = new Map();
  for (const e of shown) {
    byCat.set(e.category || "Uncategorized", (byCat.get(e.category || "Uncategorized") || 0) + e.amount_cents);
    byProject.set(e.project || "No project", (byProject.get(e.project || "No project") || 0) + e.amount_cents);
    byPerson.set(e.paid_by || 0, (byPerson.get(e.paid_by || 0) || 0) + e.amount_cents);
  }
  const owedByPerson = new Map();
  for (const e of owedAll) owedByPerson.set(e.paid_by || 0, (owedByPerson.get(e.paid_by || 0) || 0) + e.amount_cents);
  const periodLabel = (PERIODS.find(([v]) => v === f.period) || [, ""])[1];
  view.append(h("div", { class: "stats" },
    h("div", { class: "stat" }, h("div", { class: "n" }, money(sum(shown))), h("div", { class: "l" }, `Spent · ${periodLabel.toLowerCase()}${shown.length !== inPeriod.length ? " (filtered)" : ""}`)),
    h("div", { class: "stat" }, h("div", { class: "n" }, shown.length), h("div", { class: "l" }, "Expenses")),
    h("div", { class: "stat" }, h("div", { class: "n" }, money(sum(owedAll))), h("div", { class: "l" }, "Owed back to people (all time)")),
    h("div", { class: "stat" }, h("div", { class: "n" }, money(sum(all))), h("div", { class: "l" }, "Total spent (all time)"))));

  const bars = (title, map, label) => {
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
    return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, title)),
      h("div", { class: "card-body" }, rows.length ? rows.map(([k, v]) => h("div", { class: "brow" },
        h("div", { class: "bl" }, label(k)), h("div", { class: "bt" }, h("i", { style: { width: (100 * Math.abs(v) / max) + "%" } })), h("div", { class: "bv" }, money(v)))) :
        h("div", { class: "muted" }, "Nothing in this period.")));
  };
  const personLabel = (id) => id ? [avatar(id), " ", userName(id)] : "Unknown";
  const breakdown = h("div", { class: "grid3 mt" },
    bars("By category", byCat, (k) => k),
    bars("By project", byProject, (k) => k),
    owedByPerson.size ? bars("Owed back to", owedByPerson, personLabel) : bars("Paid by", byPerson, personLabel));
  if (shown.length || owedByPerson.size) view.append(breakdown);

  // list
  const list = h("table", { class: "xt" },
    h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Expense"), h("th", { class: "hide-sm" }, "Category"), h("th", { class: "hide-sm" }, "Project"),
      h("th", { class: "hide-sm" }, "Paid by"), h("th", {}, "Status"), h("th", { class: "num" }, "Amount"))),
    h("tbody", {}, shown.length ? shown.map((e) => h("tr", { onclick: (ev) => { if (!ev.target.closest("a, button")) editExpense(e, { projects, categories }, reload); } },
      h("td", { class: "nowrap" }, fmtDate(e.date)),
      h("td", {}, h("div", { class: "t" }, e.title, e.receipt_file ? h("a", { class: "rcpt", href: "/api/receipts/" + e.id, target: "_blank", rel: "noopener", title: "Open receipt" }, " 📎") : null),
        h("div", { class: "d" }, [e.vendor, e.rock_id && rockTitle(e.rock_id) ? "▲ " + rockTitle(e.rock_id) : null].filter(Boolean).join(" · "))),
      h("td", { class: "hide-sm" }, e.category ? h("span", { class: "ktag c-" + tagColor(e.category) }, e.category) : ""),
      h("td", { class: "hide-sm" }, e.project || ""),
      h("td", { class: "hide-sm" }, e.paid_by ? avatar(e.paid_by) : ""),
      h("td", {}, h("button", {
        class: "pill " + REIMBURSE_PILL[e.reimburse], title: "Click to change",
        onclick: () => safe(async () => { const next = { none: "owed", owed: "paid", paid: "none" }[e.reimburse]; await api("PUT", "expenses/" + e.id, { reimburse: next }); reload(); }),
      }, REIMBURSE[e.reimburse])),
      h("td", { class: "num" }, money(e.amount_cents)))) :
      h("tr", {}, h("td", { colspan: 7, class: "empty" }, all.length ? "No expenses match these filters." : "No expenses yet. Add the first one with + Expense."))),
    shown.length ? h("tfoot", {}, h("tr", {}, h("td", { colspan: 3 }, "Total"), h("td", { class: "hide-sm", colspan: 3 }), h("td", { class: "num" }, money(sum(shown))))) : null);
  view.append(h("div", { class: "card mt" }, h("div", { class: "xt-wrap" }, list)));
}

function exportExpenses(rows) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ["Date", "Description", "Amount", "Category", "Vendor", "Paid by", "Project", "Rock", "Reimbursement", "Notes", "Receipt"];
  const lines = [head.join(",")].concat(rows.map((e) => [e.date, e.title, (e.amount_cents / 100).toFixed(2), e.category, e.vendor,
    e.paid_by ? userName(e.paid_by) : "", e.project, e.rock_id ? rockTitle(e.rock_id) : "", REIMBURSE[e.reimburse], e.notes,
    e.receipt_name || ""].map(esc).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `${teamName(S.teamId)} expenses ${today()}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function editExpense(e, { projects, categories }, done) {
  const teamRocks = rockCache.list.filter((r) => r.team_id === (e.team_id || S.teamId));
  const field = (label, el, hint) => h("div", { class: "field" }, h("label", {}, label), el, hint ? h("div", { class: "hint" }, hint) : null);
  const title = h("input", { value: e.title || "", placeholder: "What was it for?" });
  const amount = h("input", { value: e.amount_cents != null ? (e.amount_cents / 100).toFixed(2) : "", inputmode: "decimal", placeholder: "0.00" });
  const date = h("input", { type: "date", value: e.date || today() });
  const catList = "exp-cats", projList = "exp-projects";
  const category = h("input", { value: e.category || "", list: catList, placeholder: "Pick or type a category" });
  const vendor = h("input", { value: e.vendor || "", placeholder: "e.g. DigiKey, Amazon, JLCPCB" });
  const paidBy = h("select", {}, h("option", { value: "" }, "—"), S.users.map((u) => h("option", { value: u.id, selected: u.id === e.paid_by }, u.name)));
  const reimburse = h("select", {}, Object.entries(REIMBURSE).map(([v, l]) => h("option", { value: v, selected: (e.reimburse || "none") === v }, l === "Company paid" ? "Company paid (nothing owed)" : l === "Owed" ? "Owed back to the person who paid" : "Paid back")));
  const project = h("input", { value: e.project || "", list: projList, placeholder: "Pick a board or type a project" });
  const rock = h("select", {}, h("option", { value: "" }, "No rock"), teamRocks.map((r) => h("option", { value: r.id, selected: r.id === e.rock_id }, r.title)));
  const notes = h("textarea", { rows: 2 });
  notes.value = e.notes || "";
  const file = h("input", { type: "file", accept: "image/*,application/pdf,.heic,.heif" });
  const current = e.receipt_file ? h("div", { class: "hint" }, "Current receipt: ", h("a", { href: "/api/receipts/" + e.id, target: "_blank", rel: "noopener" }, e.receipt_name || "open"), " · ",
    h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); removeReceipt = true; current.textContent = "Receipt will be removed when you save."; } }, "remove")) : null;
  let removeReceipt = false;
  const body = h("form", { onsubmit: (ev) => { ev.preventDefault(); save(); } },
    field("Description", title),
    h("div", { class: "row-fields" }, field("Amount ($)", amount), field("Date", date)),
    h("div", { class: "row-fields" }, field("Category", category), field("Vendor", vendor)),
    h("div", { class: "row-fields" }, field("Paid by", paidBy), field("Reimbursement", reimburse)),
    h("div", { class: "row-fields" }, field("Project", project), field("Rock", rock)),
    field("Notes", notes),
    field("Receipt", file, current || "Photo or PDF, up to 15 MB. On a phone you can take a picture."),
    h("datalist", { id: catList }, categories.map((c) => h("option", { value: c }))),
    h("datalist", { id: projList }, projects.map((p) => h("option", { value: p }))),
    h("button", { type: "submit", style: { display: "none" } }));
  let close;
  async function save() {
    const cents = parseMoney(amount.value);
    if (!title.value.trim()) { toast("Add a description", true); title.focus(); return; }
    if (Number.isNaN(cents) || amount.value.trim() === "") { toast("Enter an amount, like 24.99", true); amount.focus(); return; }
    if (!date.value) { toast("Pick a date", true); return; }
    const f0 = file.files[0];
    if (f0 && f0.size > 15 * 1024 * 1024) { toast("Receipts can be up to 15 MB", true); return; }
    await safe(async () => {
      const payload = {
        team_id: e.team_id || S.teamId, title: title.value.trim(), amount_cents: cents, date: date.value, category: category.value.trim() || null,
        vendor: vendor.value.trim() || null, paid_by: paidBy.value ? Number(paidBy.value) : null, reimburse: reimburse.value,
        project: project.value.trim() || null, rock_id: rock.value ? Number(rock.value) : null, notes: notes.value.trim() || null,
      };
      const saved = await api(e.id ? "PUT" : "POST", "expenses" + (e.id ? "/" + e.id : ""), payload);
      if (f0) {
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(new Error("Couldn't read the receipt")); r.readAsDataURL(f0); });
        await api("POST", `expenses/${saved.id}/receipt`, { filename: f0.name, data });
      } else if (removeReceipt) {
        await api("DELETE", `expenses/${saved.id}/receipt`);
      }
      close();
      done();
    });
  }
  close = openModal(e.id ? "Edit expense" : "New expense", body, (c) => [
    e.id ? h("button", { class: "btn danger", type: "button", onclick: () => { if (confirm("Delete this expense and its receipt?")) safe(async () => { await api("DELETE", "expenses/" + e.id); c(); done(); }); } }, "Delete") : null,
    h("span", { class: "spacer" }),
    h("button", { class: "btn", type: "button", onclick: c }, "Cancel"),
    h("button", { class: "btn primary", type: "button", onclick: save }, "Save"),
  ]);
  title.focus();
}

// ---- settings / admin
async function pageSettings(view) {
  view.append(pageHead("Settings", "Your profile" + (S.me.is_admin ? ", teams and people" : "")));
  const profile = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "My profile")),
    h("div", { class: "card-body" }, h("p", { class: "muted", style: { marginTop: 0 } }, `${S.me.name} · ${S.me.email}`, h("br"), `Tenfold version ${live.version || "?"}`),
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

  // Backup (admins only; the server refuses everyone else too)
  const backupBtn = h("a", { class: "btn primary", href: "/api/admin/backup", download: "" }, "⬇ Download backup");
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Backup"), h("span", { class: "pill done" }, "Admins only")),
    h("div", { class: "card-body" },
      h("p", { class: "muted", style: { marginTop: 0 } }, "Downloads a zip to this device with a full copy of the database (every team, person, to-do, board, rock, meeting and expense) plus all receipt files. It's safe to do while people are using Tenfold."),
      backupBtn,
      h("p", { class: "hint" }, "To restore, follow RESTORE.txt inside the zip: stop the container, put tenfold.db and the receipts folder back in /mnt/user/appdata/tenfold, and start it again."))));

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
