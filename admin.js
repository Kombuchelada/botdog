import express from "express";
import crypto from "crypto";
import {
  db,
  getEventByIdStmt,
  updateEventStmt,
  deleteEventStmt,
  insertEventWithTimestampStmt,
} from "./database.js";

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;

function adminPassword() {
  return process.env.ADMIN_PASSWORD || "";
}

function expectedToken() {
  return crypto
    .createHmac("sha256", adminPassword())
    .update("logged-in:v1")
    .digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq);
    if (k === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

function requireAuth(req, res, next) {
  if (!adminPassword()) {
    return res
      .status(500)
      .send("ADMIN_PASSWORD env var is not set; admin disabled.");
  }
  const token = readCookie(req, COOKIE_NAME);
  if (!token || !safeEqualHex(token, expectedToken())) {
    return res.redirect("/admin/login");
  }
  next();
}

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC (no tz suffix).
function parseSqlTimestamp(s) {
  if (!s) return null;
  const normalized = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
  const d = new Date(`${normalized}Z`);
  return isNaN(d.getTime()) ? null : d;
}

function formatSqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// Format a Date for the value attribute of <input type="datetime-local" step="1">.
// Returns YYYY-MM-DDTHH:MM:SS interpreted as the UTC clock-time (the form is labeled UTC).
function formatDatetimeLocalInput(date) {
  return date.toISOString().slice(0, 19);
}

// Parse the value posted by <input type="datetime-local"> and convert to SQL UTC string.
function datetimeLocalToSql(value) {
  if (!value) return null;
  const v = String(value);
  // Accept either "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS"
  const withSeconds = v.length === 16 ? `${v}:00` : v;
  const d = new Date(`${withSeconds}Z`);
  if (isNaN(d.getTime())) return null;
  return formatSqlTimestamp(d);
}

function renderLayout(title, body, opts = {}) {
  const flash = opts.flash ? `<div class="alert alert-info">${esc(opts.flash)}</div>` : "";
  const error = opts.error ? `<div class="alert alert-danger">${esc(opts.error)}</div>` : "";
  const nav = opts.hideNav
    ? ""
    : `<nav class="navbar navbar-expand-sm bg-body-tertiary mb-3">
         <div class="container-fluid">
           <a class="navbar-brand" href="/admin/events">🌭 Hotdog Admin</a>
           <div class="navbar-nav me-auto">
             <a class="nav-link" href="/admin/events">Events</a>
             <a class="nav-link" href="/admin/events/new">New event</a>
           </div>
           <form method="post" action="/admin/logout" class="d-inline">
             <button class="btn btn-outline-secondary btn-sm" type="submit">Log out</button>
           </form>
         </div>
       </nav>`;
  return `<!doctype html>
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
  body { padding-bottom: 4rem; }
  table.events td, table.events th { vertical-align: middle; }
  .amount-neg { color: #ff8b8b; }
  .amount-pos { color: #8bff9d; }
  code.small { font-size: 0.85em; }
</style>
</head>
<body>
${nav}
<div class="container">
  ${flash}${error}
  ${body}
</div>
</body>
</html>`;
}

function renderLoginPage(opts = {}) {
  const body = `
  <div class="row justify-content-center">
    <div class="col-md-5">
      <div class="card bg-body-tertiary mt-5">
        <div class="card-body">
          <h4 class="card-title mb-3">🌭 Hotdog Admin</h4>
          <form method="post" action="/admin/login">
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" name="password" class="form-control" autofocus required>
            </div>
            <button type="submit" class="btn btn-primary w-100">Log in</button>
          </form>
        </div>
      </div>
    </div>
  </div>`;
  return renderLayout("Log in", body, { hideNav: true, error: opts.error });
}

function renderEventsTable({ rows, page, totalPages, totalRows, q, userId }) {
  const filterForm = `
    <form class="row g-2 mb-3" method="get" action="/admin/events">
      <div class="col-auto">
        <input class="form-control form-control-sm" type="text" name="q" value="${esc(q || "")}" placeholder="username contains...">
      </div>
      <div class="col-auto">
        <input class="form-control form-control-sm" type="text" name="user_id" value="${esc(userId || "")}" placeholder="exact user_id">
      </div>
      <div class="col-auto">
        <button class="btn btn-sm btn-primary" type="submit">Filter</button>
        <a class="btn btn-sm btn-outline-secondary" href="/admin/events">Reset</a>
      </div>
    </form>`;

  const tableRows = rows.length === 0
    ? `<tr><td colspan="6" class="text-center text-muted py-4">No events match.</td></tr>`
    : rows.map((r) => {
        const splittable = Math.abs(r.amount) >= 2;
        const amountClass = r.amount < 0 ? "amount-neg" : r.amount > 0 ? "amount-pos" : "";
        return `<tr>
          <td><code class="small">${esc(r.id)}</code></td>
          <td><code class="small">${esc(r.timestamp)}</code></td>
          <td><code class="small">${esc(r.user_id)}</code></td>
          <td>${esc(r.username)}</td>
          <td class="${amountClass} fw-bold">${esc(r.amount)}</td>
          <td class="text-nowrap">
            <a class="btn btn-sm btn-outline-primary" href="/admin/events/${esc(r.id)}/edit">Edit</a>
            ${splittable ? `<form method="post" action="/admin/events/${esc(r.id)}/split" class="d-inline" onsubmit="return confirm('Split row ${esc(r.id)} (amount ${esc(r.amount)}) into ${esc(Math.abs(r.amount))} rows?');">
              <button class="btn btn-sm btn-outline-warning" type="submit">Split</button>
            </form>` : ""}
            <form method="post" action="/admin/events/${esc(r.id)}/delete" class="d-inline" onsubmit="return confirm('Delete row ${esc(r.id)}? This cannot be undone.');">
              <button class="btn btn-sm btn-outline-danger" type="submit">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join("");

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (userId) params.set("user_id", userId);
  const qs = params.toString();
  const linkFor = (p) => `/admin/events?${qs ? qs + "&" : ""}page=${p}`;

  const prev = page > 1
    ? `<a class="btn btn-sm btn-outline-secondary" href="${linkFor(page - 1)}">&laquo; Prev</a>`
    : `<button class="btn btn-sm btn-outline-secondary" disabled>&laquo; Prev</button>`;
  const next = page < totalPages
    ? `<a class="btn btn-sm btn-outline-secondary" href="${linkFor(page + 1)}">Next &raquo;</a>`
    : `<button class="btn btn-sm btn-outline-secondary" disabled>Next &raquo;</button>`;

  const body = `
    <div class="d-flex justify-content-between align-items-end mb-2">
      <h3>Events <small class="text-muted">(${totalRows} total)</small></h3>
      <a class="btn btn-success btn-sm" href="/admin/events/new">+ New event</a>
    </div>
    ${filterForm}
    <div class="table-responsive">
      <table class="table table-sm table-striped table-hover events">
        <thead>
          <tr><th>ID</th><th>Timestamp (UTC)</th><th>User ID</th><th>Username</th><th>Amount</th><th>Actions</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="d-flex justify-content-between align-items-center">
      <span class="text-muted">Page ${page} of ${totalPages}</span>
      <div class="btn-group">${prev} ${next}</div>
    </div>`;
  return renderLayout("Events", body);
}

function renderEventForm({ event, mode, error }) {
  const isEdit = mode === "edit";
  const action = isEdit ? `/admin/events/${esc(event.id)}` : "/admin/events";
  const tsValue = isEdit && event.timestamp
    ? formatDatetimeLocalInput(parseSqlTimestamp(event.timestamp) || new Date())
    : formatDatetimeLocalInput(new Date());
  const title = isEdit ? `Edit event #${event.id}` : "New event";
  const body = `
    <h3 class="mb-3">${esc(title)}</h3>
    ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ""}
    <form method="post" action="${action}">
      <div class="mb-3">
        <label class="form-label">User ID <small class="text-muted">(Discord snowflake)</small></label>
        <input class="form-control" type="text" name="user_id" required value="${esc(event && event.user_id || "")}">
      </div>
      <div class="mb-3">
        <label class="form-label">Username</label>
        <input class="form-control" type="text" name="username" required value="${esc(event && event.username || "")}">
      </div>
      <div class="mb-3">
        <label class="form-label">Amount <small class="text-muted">(integer; negative for protest deductions)</small></label>
        <input class="form-control" type="number" name="amount" required step="1" value="${esc(event && event.amount !== undefined ? event.amount : "")}">
      </div>
      <div class="mb-3">
        <label class="form-label">Timestamp <small class="text-muted">(UTC; will default to now if cleared and re-saved)</small></label>
        <input class="form-control" type="datetime-local" step="1" name="timestamp" value="${esc(tsValue)}">
      </div>
      <button class="btn btn-primary" type="submit">${isEdit ? "Save changes" : "Create event"}</button>
      <a class="btn btn-outline-secondary" href="/admin/events">Cancel</a>
    </form>`;
  return renderLayout(title, body);
}

function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return NaN;
  const n = Number(raw);
  if (!Number.isInteger(n)) return NaN;
  return n;
}

function queryEvents({ page, q, userId }) {
  const whereParts = [];
  const params = [];
  if (q) {
    whereParts.push("username LIKE ?");
    params.push(`%${q}%`);
  }
  if (userId) {
    whereParts.push("user_id = ?");
    params.push(userId);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const totalRows = db
    .prepare(`SELECT COUNT(*) as c FROM hotdog_events ${where}`)
    .get(...params).c;
  const offset = (page - 1) * PAGE_SIZE;
  const rows = db
    .prepare(
      `SELECT id, user_id, username, amount, timestamp FROM hotdog_events ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, offset);
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  return { rows, totalRows, totalPages };
}

const splitTxn = db.transaction((orig) => {
  const n = Math.abs(orig.amount);
  const unit = Math.sign(orig.amount);
  const baseDate = parseSqlTimestamp(orig.timestamp) || new Date();
  deleteEventStmt.run(orig.id);
  for (let i = 0; i < n; i++) {
    const ts = formatSqlTimestamp(new Date(baseDate.getTime() + i * 1000));
    insertEventWithTimestampStmt.run(orig.user_id, orig.username, unit, ts);
  }
});

export function registerAdmin(app) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.send(renderLoginPage());
  });

  router.post("/login", (req, res) => {
    const submitted = (req.body && req.body.password) || "";
    const expected = adminPassword();
    if (!expected) {
      return res
        .status(500)
        .send(renderLoginPage({ error: "ADMIN_PASSWORD env var is not set on the server." }));
    }
    const submittedBuf = Buffer.from(submitted);
    const expectedBuf = Buffer.from(expected);
    const ok =
      submittedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(submittedBuf, expectedBuf);
    if (!ok) {
      return res
        .status(401)
        .send(renderLoginPage({ error: "Incorrect password." }));
    }
    res.cookie(COOKIE_NAME, expectedToken(), {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure || req.headers["x-forwarded-proto"] === "https",
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/admin",
    });
    res.redirect("/admin/events");
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/admin" });
    res.redirect("/admin/login");
  });

  router.get("/", requireAuth, (req, res) => res.redirect("/admin/events"));

  router.get("/events", requireAuth, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q = req.query.q ? String(req.query.q).trim() : "";
    const userId = req.query.user_id ? String(req.query.user_id).trim() : "";
    const { rows, totalRows, totalPages } = queryEvents({ page, q, userId });
    res.send(renderEventsTable({ rows, page, totalPages, totalRows, q, userId }));
  });

  router.get("/events/new", requireAuth, (req, res) => {
    res.send(renderEventForm({ event: {}, mode: "new" }));
  });

  router.post("/events", requireAuth, (req, res) => {
    const { user_id, username, amount, timestamp } = req.body || {};
    const amt = parseAmount(amount);
    if (!user_id || !username || Number.isNaN(amt)) {
      return res.status(400).send(
        renderEventForm({
          event: { user_id, username, amount },
          mode: "new",
          error: "user_id, username, and an integer amount are required.",
        }),
      );
    }
    const ts = datetimeLocalToSql(timestamp) || formatSqlTimestamp(new Date());
    insertEventWithTimestampStmt.run(String(user_id).trim(), String(username).trim(), amt, ts);
    res.redirect("/admin/events");
  });

  router.get("/events/:id/edit", requireAuth, (req, res) => {
    const event = getEventByIdStmt.get(req.params.id);
    if (!event) return res.status(404).send(renderLayout("Not found", "<p>Event not found.</p>"));
    res.send(renderEventForm({ event, mode: "edit" }));
  });

  router.post("/events/:id", requireAuth, (req, res) => {
    const event = getEventByIdStmt.get(req.params.id);
    if (!event) return res.status(404).send(renderLayout("Not found", "<p>Event not found.</p>"));
    const { user_id, username, amount, timestamp } = req.body || {};
    const amt = parseAmount(amount);
    if (!user_id || !username || Number.isNaN(amt)) {
      return res.status(400).send(
        renderEventForm({
          event: { ...event, user_id, username, amount },
          mode: "edit",
          error: "user_id, username, and an integer amount are required.",
        }),
      );
    }
    const ts = datetimeLocalToSql(timestamp) || formatSqlTimestamp(new Date());
    updateEventStmt.run(
      String(user_id).trim(),
      String(username).trim(),
      amt,
      ts,
      event.id,
    );
    res.redirect("/admin/events");
  });

  router.post("/events/:id/delete", requireAuth, (req, res) => {
    deleteEventStmt.run(req.params.id);
    res.redirect("/admin/events");
  });

  router.post("/events/:id/split", requireAuth, (req, res) => {
    const event = getEventByIdStmt.get(req.params.id);
    if (!event) return res.status(404).send(renderLayout("Not found", "<p>Event not found.</p>"));
    if (Math.abs(event.amount) < 2) {
      return res
        .status(400)
        .send(renderLayout("Cannot split", `<p>Event #${esc(event.id)} has amount ${esc(event.amount)} — nothing to split.</p><a href="/admin/events" class="btn btn-secondary">Back</a>`));
    }
    splitTxn(event);
    res.redirect("/admin/events");
  });

  app.use("/admin", router);
}
