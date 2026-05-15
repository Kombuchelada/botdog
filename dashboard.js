import express from "express";
import {
  db,
  getAllEventsStmt,
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  listPublishedStoriesStmt,
  getStoryByIdStmt,
  getArchiveAttachmentByIdStmt,
  getArchiveAttachmentsForMessageStmt,
  getUserProfileStmt,
} from "./database.js";
import {
  buildUserDatesMap,
  getCurrentStreak,
  getLongestStreakEver,
  buildUserMaxDailyMap,
  toPacificDateKey,
  parseUtcTimestamp,
} from "./stats.js";

// ============================================================================
// Data helpers
// ============================================================================

const getUserDisplayNameStmt = db.prepare(
  "SELECT username FROM hotdog_events WHERE user_id = ? AND username NOT LIKE '<@%' ORDER BY timestamp DESC LIMIT 1",
);

function getDisplayName(userId) {
  // Prefer the up-to-date Discord profile name when we have it cached.
  const profile = getUserProfileStmt.get(userId);
  if (profile && (profile.global_name || profile.username)) {
    return profile.global_name || profile.username;
  }
  const row = getUserDisplayNameStmt.get(userId);
  if (row && row.username) return row.username;
  return `User ${String(userId).slice(-4)}`;
}

function getAvatarUrl(userId) {
  const profile = getUserProfileStmt.get(userId);
  return profile && profile.avatar_url ? profile.avatar_url : null;
}

function renderAvatar(userId, size = 32) {
  const url = getAvatarUrl(userId);
  const dim = `width:${size}px;height:${size}px;`;
  if (url) {
    return `<img src="${esc(url)}" alt="" loading="lazy" style="${dim}border-radius:50%;object-fit:cover;display:inline-block;flex-shrink:0;background:#1e293b;">`;
  }
  // Initials placeholder
  const name = getDisplayName(userId);
  const initial = (name[0] || "?").toUpperCase();
  const fontSize = Math.max(10, Math.round(size * 0.45));
  return `<span style="${dim}border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:${fontSize}px;flex-shrink:0;">${esc(initial)}</span>`;
}

// Plasma — sequential, perceptually uniform, colorblind-safe (designed for
// protan/deutan deficiencies). Stops sourced from matplotlib's plasma.
const PLASMA_STOPS = [
  [13, 8, 135],
  [126, 3, 168],
  [204, 71, 120],
  [248, 148, 65],
  [240, 249, 33],
];

function plasmaColor(t) {
  if (t <= 0) return `rgb(${PLASMA_STOPS[0].join(",")})`;
  if (t >= 1) return `rgb(${PLASMA_STOPS[4].join(",")})`;
  const seg = t * (PLASMA_STOPS.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = PLASMA_STOPS[i];
  const b = PLASMA_STOPS[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
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

function shiftDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function aggregateDaily(events, userId) {
  const filtered = userId ? events.filter((e) => e.user_id === userId) : events;
  const map = new Map();
  for (const e of filtered) {
    const key = toPacificDateKey(parseUtcTimestamp(e.timestamp));
    map.set(key, (map.get(key) || 0) + e.amount);
  }
  return map;
}

function dailyTimelineSeries(dailyMap) {
  const keys = Array.from(dailyMap.keys()).sort();
  if (keys.length === 0) return { points: [], total: 0 };
  const start = new Date(keys[0] + "T12:00:00Z");
  const end = new Date(toPacificDateKey(new Date()) + "T12:00:00Z");
  const points = [];
  let cumulative = 0;
  let cursor = new Date(start);
  while (cursor <= end) {
    const k = toPacificDateKey(cursor);
    const daily = dailyMap.get(k) || 0;
    cumulative += daily;
    points.push({ date: k, daily, cumulative });
    cursor = shiftDays(cursor, 1);
  }
  return { points, total: cumulative };
}

// Fixed lower bound for the heatmap — Year of the Glizzy began here.
const HEATMAP_START_ISO = "2025-12-31";
const HEATMAP_MAX_WEEKS = 52;

function heatmapSeries(dailyMap) {
  const now = new Date();
  const todayKey = toPacificDateKey(now);

  // Lower bound: Sunday on/before HEATMAP_START_ISO.
  const lowerBound = new Date(HEATMAP_START_ISO + "T12:00:00Z");
  lowerBound.setUTCDate(lowerBound.getUTCDate() - lowerBound.getUTCDay());

  // End anchor: Saturday of this week.
  const endAnchor = new Date(todayKey + "T12:00:00Z");
  endAnchor.setUTCDate(endAnchor.getUTCDate() + (6 - endAnchor.getUTCDay()));

  // Cap: never go more than HEATMAP_MAX_WEEKS back from endAnchor.
  const maxBackStart = new Date(endAnchor);
  maxBackStart.setUTCDate(maxBackStart.getUTCDate() - (HEATMAP_MAX_WEEKS * 7 - 1));

  const start = lowerBound > maxBackStart ? lowerBound : maxBackStart;
  const capped = maxBackStart > lowerBound;

  const totalDays = Math.round((endAnchor - start) / 86400000) + 1;
  const weeks = Math.ceil(totalDays / 7);

  let max = 0;
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = shiftDays(start, i);
    if (d > now) {
      cells.push({ date: null, value: null });
      continue;
    }
    const key = toPacificDateKey(d);
    const value = dailyMap.get(key) || 0;
    if (value > max) max = value;
    cells.push({ date: key, value });
  }
  return { cells, weeks, max, capped };
}

function heatmapWindowLabel(heatmap) {
  return heatmap.capped ? `Last ${HEATMAP_MAX_WEEKS} weeks` : "Since Dec 31, 2025";
}

const PACIFIC_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  hour12: false,
});

function buildWhenHeatmap(events, userId) {
  const filtered = userId ? events.filter((e) => e.user_id === userId) : events;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const e of filtered) {
    if (e.amount <= 0) continue; // skip protest deductions
    const d = parseUtcTimestamp(e.timestamp);
    if (!d || isNaN(d.getTime())) continue;
    const parts = PACIFIC_FORMATTER.formatToParts(d);
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const hrStr = parts.find((p) => p.type === "hour")?.value;
    const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    let hr = parseInt(hrStr, 10);
    if (hr === 24) hr = 0;
    if (dayIdx < 0 || Number.isNaN(hr)) continue;
    grid[dayIdx][hr] += e.amount;
    if (grid[dayIdx][hr] > max) max = grid[dayIdx][hr];
  }
  return { grid, max };
}

function whenHeatmapSVG(when, cellSize = 22, gap = 3) {
  const { grid, max } = when;
  const stride = cellSize + gap;
  const left = 38; // day labels
  const top = 22; // hour labels
  const width = left + 24 * stride;
  const height = top + 7 * stride;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const cells = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const t = max > 0 ? v / max : 0;
      const fill = v === 0 ? "#1e293b" : plasmaColor(t);
      const x = left + h * stride;
      const y = top + d * stride;
      cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="4" ry="4" fill="${fill}"><title>${esc(days[d])} ${String(h).padStart(2, "0")}:00 — ${esc(v)} dog${v === 1 ? "" : "s"}</title></rect>`);
    }
  }

  // Hour labels at the top (every 3 hours)
  const hourLabels = [];
  for (let h = 0; h < 24; h += 3) {
    const x = left + h * stride + cellSize / 2;
    hourLabels.push(`<text x="${x}" y="14" font-size="10" fill="#94a3b8" text-anchor="middle" font-family="Inter, system-ui, sans-serif">${String(h).padStart(2, "0")}</text>`);
  }

  // Day labels on the left
  const dayLabels = days.map((d, i) => {
    const y = top + i * stride + cellSize / 2 + 4;
    return `<text x="32" y="${y}" font-size="11" fill="#7d8590" text-anchor="end" font-family="Inter, system-ui, sans-serif">${esc(d)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" class="block">${hourLabels.join("")}${dayLabels}${cells.join("")}</svg>`;
}

function buildUserList() {
  const rows = getLeaderboardStmt.all();
  return rows.map((r) => ({
    user_id: r.user_id,
    name: getDisplayName(r.user_id),
    total: r.total_count,
  }));
}

const TOP_USERS_COUNT = 10;

function buildOverview() {
  const events = getAllEventsStmt.all();
  const dailyMap = aggregateDaily(events);
  const timeline = dailyTimelineSeries(dailyMap);
  const heatmap = heatmapSeries(dailyMap);
  const leaderboard = buildUserList();
  const topUsersComparison = buildCompare(
    leaderboard.slice(0, TOP_USERS_COUNT).map((u) => u.user_id),
  );
  const totalDogs = getTotalHotdogsStmt.get().total_hotdogs || 0;
  const activeDays = dailyMap.size;
  const dogsPerDay = activeDays > 0 ? totalDogs / activeDays : 0;
  const biggest = events.reduce(
    (acc, e) => (e.amount > acc.amount ? e : acc),
    { amount: -Infinity },
  );
  return {
    totalDogs,
    totalUsers: leaderboard.length,
    activeDays,
    dogsPerDay,
    biggest: biggest.amount === -Infinity
      ? null
      : {
          user_id: biggest.user_id,
          username: getDisplayName(biggest.user_id),
          amount: biggest.amount,
          timestamp: biggest.timestamp,
        },
    leaderboard: leaderboard.slice(0, 10),
    timeline: timeline.points,
    heatmap,
    when: buildWhenHeatmap(events),
    topUsersComparison,
  };
}

function buildUserDetail(userId) {
  const events = getAllEventsStmt.all();
  const userEvents = events.filter((e) => e.user_id === userId);
  if (userEvents.length === 0) return null;
  const dailyMap = aggregateDaily(events, userId);
  const timeline = dailyTimelineSeries(dailyMap);
  const heatmap = heatmapSeries(dailyMap);
  const datesMap = buildUserDatesMap(events);
  const dates = datesMap.get(userId) || new Set();
  const currentStreak = getCurrentStreak(dates);
  const longestStreak = getLongestStreakEver(dates);
  const maxDailyMap = buildUserMaxDailyMap(events);
  const maxInADay = maxDailyMap.get(userId) || 0;
  const allRows = getLeaderboardStmt.all();
  const rankIndex = allRows.findIndex((r) => r.user_id === userId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : null;
  const totalUsers = allRows.length;
  const total = userEvents.reduce((s, e) => s + e.amount, 0);

  const recent = userEvents
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 20);

  return {
    user_id: userId,
    name: getDisplayName(userId),
    total,
    rank,
    totalUsers,
    currentStreak,
    longestStreak,
    maxInADay,
    activeDays: dates.size,
    submissions: userEvents.length,
    avgPerActiveDay: dates.size > 0 ? total / dates.size : 0,
    timeline: timeline.points,
    heatmap,
    when: buildWhenHeatmap(events, userId),
    recent,
  };
}

function buildCompare(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return { users: [], dates: [], byUser: {} };

  const events = getAllEventsStmt.all();
  const datesMap = buildUserDatesMap(events);
  const maxDailyMap = buildUserMaxDailyMap(events);

  const userMaps = new Map();
  const allDateKeys = new Set();
  for (const id of ids) {
    const m = aggregateDaily(events, id);
    userMaps.set(id, m);
    for (const k of m.keys()) allDateKeys.add(k);
  }
  const dates = Array.from(allDateKeys).sort();

  const users = ids.map((id) => {
    const dailyMap = userMaps.get(id) || new Map();
    const total = Array.from(dailyMap.values()).reduce((a, b) => a + b, 0);
    const userDates = datesMap.get(id) || new Set();
    return {
      user_id: id,
      name: getDisplayName(id),
      total,
      currentStreak: getCurrentStreak(userDates),
      longestStreak: getLongestStreakEver(userDates),
      maxInADay: maxDailyMap.get(id) || 0,
      activeDays: userDates.size,
    };
  });

  // Cumulative series per user across the shared date range.
  const byUser = {};
  for (const id of ids) {
    const m = userMaps.get(id);
    let cum = 0;
    byUser[id] = dates.map((d) => {
      cum += m.get(d) || 0;
      return cum;
    });
  }

  return { users, dates, byUser };
}

// ============================================================================
// Page templates
// ============================================================================

const NAV = `
  <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
      <a href="/" class="flex items-center gap-2 font-semibold">
        <span class="text-2xl">🌭</span>
        <span class="text-slate-100 tracking-tight">Hot Dog Hub</span>
      </a>
      <nav class="flex items-center gap-1 text-sm">
        <a href="/" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Server</a>
        <a href="/users" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Users</a>
        <a href="/compare" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Compare</a>
        <a href="/archive" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Archive</a>
      </nav>
    </div>
  </header>`;

function renderOgTags(og) {
  if (!og) return "";
  const tags = [
    ["og:site_name", "Year of the Glizzy"],
    ["og:type", og.type || "website"],
    ["og:url", og.url || ""],
    ["og:title", og.title || ""],
    ["og:description", og.description || ""],
    og.image && ["og:image", og.image],
    og.imageWidth && ["og:image:width", String(og.imageWidth)],
    og.imageHeight && ["og:image:height", String(og.imageHeight)],
    ["twitter:card", og.image ? "summary_large_image" : "summary"],
    ["twitter:title", og.title || ""],
    ["twitter:description", og.description || ""],
    og.image && ["twitter:image", og.image],
  ].filter(Boolean);
  return tags
    .map(([key, val]) => {
      const isOg = key.startsWith("og:");
      const attr = isOg ? "property" : "name";
      return `<meta ${attr}="${esc(key)}" content="${esc(val)}">`;
    })
    .join("\n");
}

function renderLayout(title, body, data, opts = {}) {
  // Escape `<` so a `</script>` inside any string value can't break us out of the script tag.
  const dataJson = JSON.stringify(data || {}).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Hot Dog Hub</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">
${renderOgTags(opts.og)}
<script>window.PAGE_DATA = ${dataJson};</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          accent: {
            DEFAULT: '#ff6b35',
            soft: '#ffa07a',
            deep: '#e25822',
          },
        },
        fontFamily: {
          sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        },
      },
    },
  };
</script>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  body { background:#020617; color:#e2e8f0; font-feature-settings: "cv11", "ss03"; }
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; }
  .card-tight { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:12px; }
  .stat-label { color:#94a3b8; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; font-weight:600; }
  .stat-value { color:#f8fafc; font-size:36px; font-weight:700; line-height:1; }
  .stat-suffix { color:#ffa07a; font-size:13px; }
  .accent { color:#ff6b35; }
  .heatmap-cell { stroke-width:0; }
  .glow { box-shadow: 0 0 60px rgba(255,107,53,0.15); }
  /* Story media carousel */
  .carousel { position:relative; background:#020617; }
  .carousel-track {
    display:flex; overflow-x:auto;
    scroll-snap-type: x mandatory; scroll-behavior: smooth;
    scrollbar-width: none;
  }
  .carousel-track::-webkit-scrollbar { display:none; }
  .carousel-slide {
    flex: 0 0 100%; scroll-snap-align: start;
    aspect-ratio: 16/9;
    display:flex; align-items:center; justify-content:center;
    background:#020617;
  }
  .carousel-slide img, .carousel-slide video {
    max-width:100%; max-height:100%; width:auto; height:auto; display:block;
  }
  .carousel-btn {
    position:absolute; top:50%; transform:translateY(-50%);
    background:rgba(0,0,0,0.55); color:#fff; border:0;
    width:40px; height:40px; border-radius:50%; cursor:pointer;
    font-size:22px; line-height:1; padding:0;
    opacity:0; transition:opacity .15s ease, background .15s ease;
  }
  .carousel:hover .carousel-btn, .carousel:focus-within .carousel-btn { opacity:1; }
  .carousel-btn:hover { background:rgba(0,0,0,0.85); }
  .carousel-btn:disabled { opacity:0 !important; cursor:default; }
  .carousel-prev { left:12px; }
  .carousel-next { right:12px; }
  .carousel-indicators {
    position:absolute; bottom:12px; left:50%; transform:translateX(-50%);
    display:flex; gap:6px;
  }
  .carousel-dot {
    width:8px; height:8px; border-radius:50%;
    background:rgba(255,255,255,0.4); cursor:pointer;
    transition:background .15s, transform .15s;
  }
  .carousel-dot:hover { transform:scale(1.2); }
  .carousel-dot.active { background:#fff; }
  .carousel-counter {
    position:absolute; top:12px; right:12px;
    background:rgba(0,0,0,0.6); color:#fff;
    font-size:11px; padding:3px 9px; border-radius:12px;
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-7xl mx-auto px-6 py-8">
  ${body}
</main>
<footer class="mt-16 border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
  🌭 Hot Dog Hub · auto-updated from the bot
</footer>
</body>
</html>`;
}

function statTile(label, value, suffix) {
  return `
    <div class="card p-5">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value mt-2">${esc(value)}</div>
      ${suffix ? `<div class="stat-suffix mt-1">${esc(suffix)}</div>` : ""}
    </div>`;
}

function plasmaLegendSVG() {
  return `<svg width="96" height="10" viewBox="0 0 96 10" aria-label="Plasma gradient less to more">
    <defs>
      <linearGradient id="plasma-legend" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="rgb(13,8,135)"/>
        <stop offset="25%" stop-color="rgb(126,3,168)"/>
        <stop offset="50%" stop-color="rgb(204,71,120)"/>
        <stop offset="75%" stop-color="rgb(248,148,65)"/>
        <stop offset="100%" stop-color="rgb(240,249,33)"/>
      </linearGradient>
    </defs>
    <rect width="96" height="10" rx="2" fill="url(#plasma-legend)"/>
  </svg>`;
}

function heatmapSVG(heatmap, cellSize = 14, gap = 3) {
  const { cells, weeks } = heatmap;
  const stride = cellSize + gap;
  const width = weeks * stride;
  const height = 7 * stride;
  const max = Math.max(1, heatmap.max);
  const rects = cells
    .map((c, i) => {
      const week = Math.floor(i / 7);
      const day = i % 7;
      const x = week * stride;
      const y = day * stride;
      if (c.value === null) return "";
      const t = Math.min(1, c.value / max);
      const fill = c.value === 0 ? "#1e293b" : plasmaColor(t);
      return `<rect class="heatmap-cell" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" ry="3" fill="${fill}"><title>${esc(c.date)}: ${esc(c.value)}</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" class="block">${rects}</svg>`;
}

function renderOverviewPage(data) {
  const usersForPicker = JSON.stringify(data.userList);
  const body = `
    <section class="mb-10">
      <div class="grid md:grid-cols-3 gap-6 items-center">
        <div class="md:col-span-2">
          <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Server overview</div>
          <h1 class="text-6xl md:text-7xl font-bold tracking-tight text-white leading-none">${esc(data.totalDogs)}</h1>
          <div class="mt-3 text-lg text-slate-300">hot dogs consumed across <span class="accent font-semibold">${esc(data.totalUsers)}</span> users</div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="card-tight p-4"><div class="stat-label">Days</div><div class="text-2xl font-bold mt-1">${esc(data.activeDays)}</div></div>
          <div class="card-tight p-4"><div class="stat-label">Per day</div><div class="text-2xl font-bold mt-1">${esc(data.dogsPerDay.toFixed(1))}</div></div>
          <div class="card-tight p-4 col-span-2"><div class="stat-label">Biggest single</div>
            ${data.biggest
              ? `<div class="text-xl font-bold mt-1">${esc(data.biggest.amount)} <span class="text-slate-400 text-sm font-normal">by ${esc(data.biggest.username)}</span></div>`
              : `<div class="text-slate-500 mt-1">—</div>`}
          </div>
        </div>
      </div>
    </section>

    <section class="grid lg:grid-cols-3 gap-6 mb-8">
      <div class="card p-6 lg:col-span-2">
        <div class="flex items-center justify-between mb-2">
          <div>
            <div class="stat-label">Cumulative timeline</div>
            <div class="text-slate-300 text-sm mt-1">Server total over time</div>
          </div>
        </div>
        <div class="h-72 mt-3"><canvas id="chart-timeline"></canvas></div>
      </div>
      <div class="card p-6">
        <div class="stat-label">Leaderboard</div>
        <div class="text-slate-300 text-sm mt-1">Top 10 users</div>
        <div class="h-72 mt-3"><canvas id="chart-leaderboard"></canvas></div>
      </div>
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="stat-label">Top 10 cumulative</div>
          <div class="text-slate-300 text-sm mt-1">How the leaderboard built up over time</div>
        </div>
      </div>
      <div class="h-96 mt-3"><canvas id="chart-overview-compare"></canvas></div>
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="stat-label">Activity heatmap</div>
          <div class="text-slate-300 text-sm mt-1">${esc(heatmapWindowLabel(data.heatmap))} · color by daily total</div>
        </div>
        <div class="text-xs text-slate-500">peak day: <span class="text-slate-200 font-semibold">${esc(data.heatmap.max)}</span></div>
      </div>
      <div class="overflow-x-auto">${heatmapSVG(data.heatmap)}</div>
      <div class="flex items-center gap-2 mt-3 text-xs text-slate-400">
        <span>Less</span>
        ${plasmaLegendSVG()}
        <span>More</span>
      </div>
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="stat-label">When dogs get eaten</div>
          <div class="text-slate-300 text-sm mt-1">Submissions by day of week and hour (Pacific time)</div>
        </div>
        <div class="text-xs text-slate-500">peak hour: <span class="text-slate-200 font-semibold">${esc(data.when.max)}</span></div>
      </div>
      <div class="overflow-x-auto">${whenHeatmapSVG(data.when)}</div>
      <div class="flex items-center gap-2 mt-3 text-xs text-slate-400">
        <span>Less</span>
        ${plasmaLegendSVG()}
        <span>More</span>
      </div>
    </section>

    <section class="grid md:grid-cols-2 gap-6 mb-8">
      <div class="card p-6">
        <div class="stat-label">View a user</div>
        <div class="text-slate-300 text-sm mt-1">Drill into one user's stats</div>
        <div class="mt-4 flex gap-2">
          <select id="user-picker" class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="">Select a user…</option>
            ${data.userList
              .map((u) => `<option value="${esc(u.user_id)}">${esc(u.name)} · ${esc(u.total)}</option>`)
              .join("")}
          </select>
          <button id="user-go" class="px-4 py-2 bg-accent hover:bg-accent-deep text-white rounded-lg font-semibold transition">Go</button>
        </div>
      </div>
      <div class="card p-6">
        <div class="stat-label">Compare users</div>
        <div class="text-slate-300 text-sm mt-1">Side-by-side stats and timelines</div>
        <div class="mt-4"><a href="/compare" class="inline-flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-semibold transition">Open compare →</a></div>
      </div>
    </section>

    <script>
      (function () {
        const data = PAGE_DATA;
        const PALETTE = ['#ff6b35','#22d3ee','#a78bfa','#facc15','#fb7185','#60a5fa','#34d399','#f472b6','#fbbf24','#a3e635'];

        // Timeline chart
        const tlCtx = document.getElementById('chart-timeline').getContext('2d');
        const grad = tlCtx.createLinearGradient(0, 0, 0, 300);
        grad.addColorStop(0, 'rgba(255,107,53,0.55)');
        grad.addColorStop(1, 'rgba(255,107,53,0.02)');
        new Chart(tlCtx, {
          type: 'line',
          data: {
            datasets: [{
              label: 'Total',
              data: data.timeline.map(p => ({ x: p.date, y: p.cumulative })),
              borderColor: '#ff6b35',
              borderWidth: 2.5,
              backgroundColor: grad,
              fill: true,
              pointRadius: 0,
              tension: 0.2,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
            interaction: { mode: 'index', intersect: false },
            scales: {
              x: { type: 'time', time: { unit: data.timeline.length > 365 ? 'month' : 'week' },
                   grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
              y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
            },
          },
        });

        // Leaderboard chart
        const lbCtx = document.getElementById('chart-leaderboard').getContext('2d');
        new Chart(lbCtx, {
          type: 'bar',
          data: {
            labels: data.leaderboard.map(r => r.name),
            datasets: [{
              data: data.leaderboard.map(r => r.total),
              backgroundColor: data.leaderboard.map((_, i) => \`hsl(\${28 - i * 1.4}, 90%, 55%)\`),
              borderRadius: 6,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => \` \${c.parsed.x} hot dogs\` } } },
            scales: {
              x: { grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
              y: { grid: { display: false }, ticks: { color: '#cbd5e1', font: { weight: 600 } }, border: { display: false } },
            },
          },
        });

        // Top-10 cumulative comparison
        const cmpData = data.topUsersComparison;
        if (cmpData && cmpData.users && cmpData.users.length > 0) {
          const cmpCtx = document.getElementById('chart-overview-compare').getContext('2d');
          const datasets = cmpData.users.map((u, i) => ({
            label: u.name,
            data: cmpData.dates.map((d, idx) => ({ x: d, y: cmpData.byUser[u.user_id][idx] })),
            borderColor: PALETTE[i % PALETTE.length],
            backgroundColor: PALETTE[i % PALETTE.length] + '22',
            borderWidth: 2,
            fill: false,
            pointRadius: 0,
            tension: 0.2,
          }));
          new Chart(cmpCtx, {
            type: 'line',
            data: { datasets },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: {
                legend: { labels: { color: '#cbd5e1', usePointStyle: true, boxWidth: 8 } },
                tooltip: { mode: 'index', intersect: false },
              },
              interaction: { mode: 'index', intersect: false },
              scales: {
                x: { type: 'time', time: { unit: cmpData.dates.length > 365 ? 'month' : 'week' },
                     grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
                y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
              },
            },
          });
        }

        // User picker
        const picker = document.getElementById('user-picker');
        document.getElementById('user-go').addEventListener('click', () => {
          if (picker.value) window.location = '/user/' + encodeURIComponent(picker.value);
        });
        picker.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && picker.value) {
            window.location = '/user/' + encodeURIComponent(picker.value);
          }
        });
      })();
    </script>`;
  return renderLayout("Server", body, data);
}

function renderUserPage(data) {
  if (!data) {
    return renderLayout(
      "User not found",
      `<div class="card p-8 text-center">
         <div class="text-2xl mb-2">No data for that user</div>
         <a href="/" class="text-accent">← back to server overview</a>
       </div>`,
      {},
    );
  }
  const body = `
    <section class="mb-8">
      <a href="/" class="text-slate-400 hover:text-slate-200 text-sm">← back to server</a>
      <div class="mt-4 grid md:grid-cols-3 gap-6 items-center">
        <div class="md:col-span-2 flex items-center gap-5">
          <div>${renderAvatar(data.user_id, 96)}</div>
          <div>
            <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">User dashboard</div>
            <h1 class="text-5xl font-bold text-white tracking-tight">${esc(data.name)}</h1>
            <div class="mt-3 text-lg text-slate-300">
              <span class="accent font-bold text-2xl">${esc(data.total)}</span> hot dogs ·
              ${data.rank ? `rank <span class="accent font-semibold">#${esc(data.rank)}</span> of ${esc(data.totalUsers)}` : ""}
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${statTile("Active days", data.activeDays, "")}
          ${statTile("Avg / day", data.avgPerActiveDay.toFixed(1), "")}
        </div>
      </div>
    </section>

    <section class="grid md:grid-cols-3 gap-6 mb-8">
      ${statTile("Current streak", data.currentStreak, data.currentStreak === 1 ? "day" : "days")}
      ${statTile("Longest streak", data.longestStreak, data.longestStreak === 1 ? "day" : "days")}
      ${statTile("Most in a day", data.maxInADay, data.maxInADay === 1 ? "dog" : "dogs")}
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="stat-label">Personal timeline</div>
          <div class="text-slate-300 text-sm mt-1">Cumulative hot dogs over time</div>
        </div>
      </div>
      <div class="h-72 mt-3"><canvas id="chart-user-timeline"></canvas></div>
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="stat-label">Activity heatmap</div>
          <div class="text-slate-300 text-sm mt-1">${esc(heatmapWindowLabel(data.heatmap))}</div>
        </div>
        <div class="text-xs text-slate-500">peak day: <span class="text-slate-200 font-semibold">${esc(data.heatmap.max)}</span></div>
      </div>
      <div class="overflow-x-auto">${heatmapSVG(data.heatmap)}</div>
      <div class="flex items-center gap-2 mt-3 text-xs text-slate-400">
        <span>Less</span>
        ${plasmaLegendSVG()}
        <span>More</span>
      </div>
    </section>

    <section class="card p-6 mb-8">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="stat-label">When they eat</div>
          <div class="text-slate-300 text-sm mt-1">By day of week and hour (Pacific time)</div>
        </div>
        <div class="text-xs text-slate-500">peak hour: <span class="text-slate-200 font-semibold">${esc(data.when.max)}</span></div>
      </div>
      <div class="overflow-x-auto">${whenHeatmapSVG(data.when)}</div>
    </section>

    <section class="card p-6">
      <div class="stat-label mb-3">Recent submissions</div>
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-left">
          <th class="py-2 font-medium">When (UTC)</th>
          <th class="font-medium">Amount</th>
        </tr></thead>
        <tbody>
          ${data.recent
            .map(
              (e) =>
                `<tr class="border-t border-slate-800/50">
                  <td class="py-2 font-mono text-xs text-slate-300">${esc(e.timestamp)}</td>
                  <td class="font-semibold ${e.amount < 0 ? "text-rose-400" : "text-slate-100"}">${esc(e.amount)}</td>
                 </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </section>

    <script>
      (function () {
        const data = PAGE_DATA;
        const ctx = document.getElementById('chart-user-timeline').getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 300);
        grad.addColorStop(0, 'rgba(255,107,53,0.6)');
        grad.addColorStop(1, 'rgba(255,107,53,0.02)');
        new Chart(ctx, {
          type: 'line',
          data: {
            datasets: [{
              data: data.timeline.map(p => ({ x: p.date, y: p.cumulative })),
              borderColor: '#ff6b35', borderWidth: 2.5, backgroundColor: grad,
              fill: true, pointRadius: 0, tension: 0.2,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
            interaction: { mode: 'index', intersect: false },
            scales: {
              x: { type: 'time', time: { unit: data.timeline.length > 365 ? 'month' : 'week' },
                   grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
              y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
            },
          },
        });
      })();
    </script>`;
  return renderLayout(data.name, body, data);
}

function renderComparePage({ users, dates, byUser, allUsers, selected }) {
  // Two states: picker (no selection) and results (selection present).
  if (!selected || selected.length === 0) {
    const body = `
      <section class="mb-6">
        <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Compare users</div>
        <h1 class="text-4xl font-bold text-white tracking-tight">Pick 2 or more users</h1>
        <p class="text-slate-400 mt-2">Check the boxes and hit Compare. Cumulative timelines and stats appear side-by-side.</p>
      </section>
      <form method="get" action="/compare" class="card p-6">
        <input type="text" id="filter-input" placeholder="Search…" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 mb-4 text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent">
        <div id="user-options" class="grid sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
          ${allUsers
            .map(
              (u) => `
              <label class="user-row flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 cursor-pointer" data-name="${esc(u.name.toLowerCase())}">
                <input type="checkbox" name="ids" value="${esc(u.user_id)}" class="accent-accent">
                <span class="flex-1 text-sm text-slate-200">${esc(u.name)}</span>
                <span class="text-xs text-slate-400">${esc(u.total)}</span>
              </label>`,
            )
            .join("")}
        </div>
        <div class="mt-4 flex justify-end">
          <button class="px-5 py-2 bg-accent hover:bg-accent-deep text-white rounded-lg font-semibold transition">Compare →</button>
        </div>
      </form>
      <script>
        (function () {
          const input = document.getElementById('filter-input');
          const rows = document.querySelectorAll('.user-row');
          input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            rows.forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; });
          });
        })();
      </script>`;
    return renderLayout("Compare", body, {});
  }

  const palette = ["#ff6b35", "#22d3ee", "#a78bfa", "#facc15", "#fb7185", "#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a3e635"];
  const body = `
    <section class="mb-6">
      <a href="/compare" class="text-slate-400 hover:text-slate-200 text-sm">← change selection</a>
      <h1 class="text-4xl font-bold text-white tracking-tight mt-2">Comparing ${esc(users.length)} users</h1>
    </section>

    <section class="grid sm:grid-cols-2 lg:grid-cols-${Math.min(4, Math.max(2, users.length))} gap-4 mb-8">
      ${users
        .map(
          (u, i) => `
          <div class="card p-5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                ${renderAvatar(u.user_id, 40)}
                <div>
                  <div class="text-xs uppercase tracking-widest text-slate-400">User</div>
                  <div class="text-lg font-bold text-white mt-1">${esc(u.name)}</div>
                </div>
              </div>
              <div class="w-3 h-3 rounded-full" style="background:${palette[i % palette.length]}"></div>
            </div>
            <div class="mt-3 text-3xl font-bold accent">${esc(u.total)}</div>
            <div class="text-xs text-slate-400">total hot dogs</div>
            <div class="mt-4 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <div class="text-slate-400">Current streak</div><div class="text-right text-slate-100">${esc(u.currentStreak)}</div>
              <div class="text-slate-400">Longest</div><div class="text-right text-slate-100">${esc(u.longestStreak)}</div>
              <div class="text-slate-400">Most/day</div><div class="text-right text-slate-100">${esc(u.maxInADay)}</div>
              <div class="text-slate-400">Active days</div><div class="text-right text-slate-100">${esc(u.activeDays)}</div>
            </div>
          </div>`,
        )
        .join("")}
    </section>

    <section class="card p-6 mb-8">
      <div class="stat-label">Cumulative comparison</div>
      <div class="text-slate-300 text-sm mt-1">Hot dogs over time per user</div>
      <div class="h-96 mt-4"><canvas id="chart-compare"></canvas></div>
    </section>

    <section class="card p-6">
      <div class="stat-label mb-3">Side-by-side totals</div>
      <div class="h-72"><canvas id="chart-compare-bar"></canvas></div>
    </section>

    <script>
      (function () {
        const data = PAGE_DATA;
        const palette = ${JSON.stringify(palette)};
        const datasets = data.users.map((u, i) => ({
          label: u.name,
          data: data.dates.map((d, idx) => ({ x: d, y: data.byUser[u.user_id][idx] })),
          borderColor: palette[i % palette.length],
          backgroundColor: palette[i % palette.length] + '22',
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          tension: 0.2,
        }));
        const ctx = document.getElementById('chart-compare').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#cbd5e1' } }, tooltip: { mode: 'index', intersect: false } },
            interaction: { mode: 'index', intersect: false },
            scales: {
              x: { type: 'time', time: { unit: data.dates.length > 365 ? 'month' : 'week' },
                   grid: { color: 'rgba(148,163,184,0.06)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
              y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
            },
          },
        });

        const barCtx = document.getElementById('chart-compare-bar').getContext('2d');
        new Chart(barCtx, {
          type: 'bar',
          data: {
            labels: data.users.map(u => u.name),
            datasets: [{ data: data.users.map(u => u.total), backgroundColor: data.users.map((_, i) => palette[i % palette.length]), borderRadius: 6 }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#cbd5e1', font: { weight: 600 } }, border: { display: false } },
              y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#94a3b8' }, border: { display: false } },
            },
          },
        });
      })();
    </script>`;
  return renderLayout("Compare", body, { users, dates, byUser });
}

function formatStoryDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function isDisplayableMedia(a) {
  if (!a || !a.content_type) return false;
  return a.content_type.startsWith("image/") || a.content_type.startsWith("video/");
}

function gatherStoryMedia(story) {
  let ids = [];
  try { ids = JSON.parse(story.source_message_ids || "[]"); } catch {}
  const seen = new Set();
  const media = [];
  // Hero first if available
  if (story.hero_attachment_id) {
    const a = getArchiveAttachmentByIdStmt.get(story.hero_attachment_id);
    if (isDisplayableMedia(a)) {
      seen.add(a.id);
      media.push(a);
    }
  }
  // Then every other attachment from source messages, in message + attachment order
  for (const mid of ids) {
    const atts = getArchiveAttachmentsForMessageStmt.all(mid);
    for (const a of atts) {
      if (seen.has(a.id)) continue;
      if (!isDisplayableMedia(a)) continue;
      seen.add(a.id);
      media.push(a);
    }
  }
  return media;
}

function renderMediaItem(a) {
  if (a.content_type.startsWith("video/")) {
    return `<video controls preload="metadata" playsinline><source src="${esc(a.public_url)}" type="${esc(a.content_type)}"></video>`;
  }
  return `<img src="${esc(a.public_url)}" alt="" loading="lazy">`;
}

function renderStoryCarousel(media, storyId) {
  if (media.length === 0) return "";
  if (media.length === 1) {
    return `<div class="aspect-[16/9] overflow-hidden bg-slate-900 flex items-center justify-center">${renderMediaItem(media[0])}</div>`;
  }
  const slides = media.map((a) => `<div class="carousel-slide">${renderMediaItem(a)}</div>`).join("");
  const dots = media.map((_, i) => `<button class="carousel-dot${i === 0 ? " active" : ""}" type="button" aria-label="Slide ${i + 1}" data-index="${i}"></button>`).join("");
  return `
    <div class="carousel" data-carousel data-total="${media.length}">
      <div class="carousel-track">${slides}</div>
      <button class="carousel-btn carousel-prev" type="button" aria-label="Previous">‹</button>
      <button class="carousel-btn carousel-next" type="button" aria-label="Next">›</button>
      <div class="carousel-counter">1 / ${media.length}</div>
      <div class="carousel-indicators">${dots}</div>
    </div>`;
}

function parseTags(story) {
  try {
    const arr = JSON.parse(story.tags || "[]");
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch { return []; }
}

function renderTagChips(tags, opts = {}) {
  if (!tags || tags.length === 0) return "";
  const baseClass = "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium transition";
  return tags
    .map((t) => {
      const active = opts.activeTag && t === opts.activeTag;
      const classes = active
        ? `${baseClass} bg-accent text-white`
        : `${baseClass} bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white`;
      return `<a href="/archive?tag=${encodeURIComponent(t)}" class="${classes}">${esc(t)}</a>`;
    })
    .join(" ");
}

function paragraphs(body) {
  return String(body || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const CAROUSEL_JS = `
  <script>
    document.querySelectorAll('[data-carousel]').forEach((c) => {
      const track = c.querySelector('.carousel-track');
      const prev  = c.querySelector('.carousel-prev');
      const next  = c.querySelector('.carousel-next');
      const dots  = Array.from(c.querySelectorAll('.carousel-dot'));
      const counter = c.querySelector('.carousel-counter');
      const total = dots.length;
      const go = (d) => track.scrollBy({ left: d * track.clientWidth, behavior: 'smooth' });
      const jump = (i) => track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
      prev && prev.addEventListener('click', () => go(-1));
      next && next.addEventListener('click', () => go(1));
      dots.forEach((d, i) => d.addEventListener('click', () => jump(i)));
      let raf = null;
      track.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const i = Math.round(track.scrollLeft / track.clientWidth);
          dots.forEach((d, idx) => d.classList.toggle('active', idx === i));
          if (counter) counter.textContent = (i + 1) + ' / ' + total;
          if (prev) prev.disabled = i === 0;
          if (next) next.disabled = i === total - 1;
        });
      });
      if (prev) prev.disabled = true;
      if (next) next.disabled = total <= 1;
    });
  </script>`;

function buildStoryUrl(storyId) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/archive/${storyId}` : `/archive/${storyId}`;
}

function buildStoryExcerpt(body, maxChars = 240) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars) + "…";
}

function renderStoryPage(story) {
  const media = gatherStoryMedia(story);
  const hero = media[0] || null;
  const dateLabel = story.period_start && story.period_end && story.period_start.slice(0, 10) !== story.period_end.slice(0, 10)
    ? `${formatStoryDate(story.period_start)} – ${formatStoryDate(story.period_end)}`
    : formatStoryDate(story.period_end || story.period_start);
  const og = {
    type: "article",
    url: buildStoryUrl(story.id),
    title: story.title,
    description: buildStoryExcerpt(story.body, 200),
    image: hero && hero.content_type && hero.content_type.startsWith("image/") ? hero.public_url : null,
    imageWidth: hero?.width || null,
    imageHeight: hero?.height || null,
  };
  const tags = parseTags(story);
  const body = `
    <section class="mb-4">
      <a href="/archive" class="text-slate-400 hover:text-slate-200 text-sm">← back to archive</a>
    </section>
    <article class="card overflow-hidden mb-8 max-w-3xl mx-auto">
      ${renderStoryCarousel(media, story.id)}
      <div class="p-6 md:p-8">
        <div class="text-xs uppercase tracking-widest text-accent-soft mb-2">${esc(dateLabel)}</div>
        <h1 class="text-3xl md:text-4xl font-bold text-white tracking-tight mb-3">${esc(story.title)}</h1>
        <div class="prose-archive text-slate-300 leading-relaxed space-y-3 text-lg">${paragraphs(story.body)}</div>
        ${tags.length > 0 ? `<div class="flex flex-wrap gap-1.5 mt-6">${renderTagChips(tags)}</div>` : ""}
      </div>
    </article>
    ${CAROUSEL_JS}`;
  return renderLayout(story.title, body, {}, { og });
}

function renderArchivePage(allStories, activeTag) {
  // Build the set of all unique tags across all (visible) stories for the filter row
  const tagCounts = new Map();
  for (const s of allStories) {
    for (const t of parseTags(s)) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const sortedTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).map(([t]) => t);

  const stories = activeTag
    ? allStories.filter((s) => parseTags(s).includes(activeTag))
    : allStories;

  const filterChips = sortedTags.length > 0
    ? `<div class="flex flex-wrap items-center gap-2 mb-6">
         ${activeTag
           ? `<a href="/archive" class="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-700 text-white hover:bg-slate-600">× clear</a>`
           : `<span class="text-xs text-slate-500 mr-1">filter:</span>`}
         ${sortedTags
           .map((t) => {
             const active = t === activeTag;
             const classes = active
               ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-accent text-white"
               : "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white";
             return `<a href="/archive?tag=${encodeURIComponent(t)}" class="${classes}">${esc(t)} <span class="opacity-60">${esc(tagCounts.get(t))}</span></a>`;
           })
           .join("")}
       </div>`
    : "";

  if (stories.length === 0) {
    const body = `
      <section class="mb-6">
        <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Archive</div>
        <h1 class="text-4xl font-bold text-white tracking-tight">The story so far</h1>
        ${activeTag ? `<p class="text-slate-400 mt-2">No stories tagged <span class="accent font-semibold">${esc(activeTag)}</span>.</p>` : ""}
      </section>
      <div class="max-w-3xl mx-auto">
        ${filterChips}
        <div class="card p-12 text-center">
          <div class="text-5xl mb-3">🌭</div>
          <div class="text-xl text-slate-200 font-semibold">${activeTag ? "No matching stories" : "No stories yet"}</div>
          <div class="text-slate-400 mt-2">${activeTag ? "Try a different tag, or clear the filter." : "The archive bot is still warming up. Check back in a bit."}</div>
          ${activeTag ? `<a href="/archive" class="inline-block mt-4 text-accent hover:text-accent-soft">← back to all stories</a>` : ""}
        </div>
      </div>`;
    return renderLayout("Archive", body, {});
  }

  const cards = stories
    .map((s) => {
      const media = gatherStoryMedia(s);
      const tags = parseTags(s);
      const dateLabel = s.period_start && s.period_end && s.period_start.slice(0, 10) !== s.period_end.slice(0, 10)
        ? `${formatStoryDate(s.period_start)} – ${formatStoryDate(s.period_end)}`
        : formatStoryDate(s.period_end || s.period_start);
      return `
        <article class="card overflow-hidden mb-8">
          ${renderStoryCarousel(media, s.id)}
          <div class="p-6 md:p-8">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs uppercase tracking-widest text-accent-soft">${esc(dateLabel)}</div>
              <a href="/archive/${esc(s.id)}" class="text-slate-500 hover:text-accent-soft text-xs" title="Permalink">↗ link</a>
            </div>
            <h2 class="text-2xl md:text-3xl font-bold text-white tracking-tight mb-3">
              <a href="/archive/${esc(s.id)}" class="text-white hover:text-accent-soft transition">${esc(s.title)}</a>
            </h2>
            <div class="prose-archive text-slate-300 leading-relaxed space-y-3">${paragraphs(s.body)}</div>
            ${tags.length > 0 ? `<div class="flex flex-wrap gap-1.5 mt-5">${renderTagChips(tags, { activeTag })}</div>` : ""}
          </div>
        </article>`;
    })
    .join("");

  const body = `
    <section class="mb-6">
      <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Archive</div>
      <h1 class="text-4xl md:text-5xl font-bold text-white tracking-tight">${activeTag ? `Stories tagged ${esc(activeTag)}` : "The story so far"}</h1>
      <p class="text-slate-400 mt-2">${activeTag ? `${stories.length} of ${allStories.length} stories.` : "Significant moments from the channel, curated automatically."}</p>
    </section>
    <div class="max-w-3xl mx-auto">
      ${filterChips}
      ${cards}
    </div>
    ${CAROUSEL_JS}`;
  return renderLayout("Archive", body, {});
}

function renderUserListPage(users) {
  const body = `
    <section class="mb-6">
      <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Users</div>
      <h1 class="text-4xl font-bold text-white tracking-tight">${esc(users.length)} users</h1>
      <p class="text-slate-400 mt-2">Click any user to open their dashboard.</p>
    </section>
    <section class="card p-2">
      <input type="text" id="filter-input" placeholder="Search…" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 m-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent" style="width:calc(100% - 16px)">
      <div id="user-rows" class="divide-y divide-slate-800/50">
        ${users
          .map(
            (u, i) => `
            <a class="user-row flex items-center justify-between px-4 py-3 hover:bg-slate-800/50 transition" href="/user/${esc(u.user_id)}" data-name="${esc(u.name.toLowerCase())}">
              <div class="flex items-center gap-3">
                <div class="text-sm text-slate-500 w-6 text-right">${esc(i + 1)}</div>
                ${renderAvatar(u.user_id, 32)}
                <div class="text-slate-100 font-medium">${esc(u.name)}</div>
              </div>
              <div class="text-accent font-bold">${esc(u.total)}</div>
            </a>`,
          )
          .join("")}
      </div>
    </section>
    <script>
      (function () {
        const input = document.getElementById('filter-input');
        const rows = document.querySelectorAll('.user-row');
        input.addEventListener('input', () => {
          const q = input.value.trim().toLowerCase();
          rows.forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; });
        });
      })();
    </script>`;
  return renderLayout("Users", body, {});
}

// ============================================================================
// Registration
// ============================================================================

export function registerDashboard(app) {
  const router = express.Router();

  router.get("/", (req, res) => {
    const data = buildOverview();
    data.userList = buildUserList();
    res.send(renderOverviewPage(data));
  });

  router.get("/users", (req, res) => {
    res.send(renderUserListPage(buildUserList()));
  });

  router.get("/archive", (req, res) => {
    const stories = listPublishedStoriesStmt.all();
    const activeTag = req.query.tag ? String(req.query.tag).toLowerCase().trim() : null;
    res.send(renderArchivePage(stories, activeTag));
  });

  router.get("/archive/:id", (req, res) => {
    const story = getStoryByIdStmt.get(req.params.id);
    if (!story || story.hidden) {
      return res.status(404).send(renderLayout("Not found", `
        <div class="card p-12 text-center max-w-2xl mx-auto">
          <div class="text-5xl mb-3">🌭</div>
          <div class="text-xl text-slate-200 font-semibold">Story not found</div>
          <div class="text-slate-400 mt-2">Maybe it was hidden, or the link is wrong.</div>
          <a href="/archive" class="inline-block mt-4 text-accent hover:text-accent-soft">← back to archive</a>
        </div>`, {}));
    }
    res.send(renderStoryPage(story));
  });

  router.get("/user/:id", (req, res) => {
    const data = buildUserDetail(req.params.id);
    res.send(renderUserPage(data));
  });

  router.get("/compare", (req, res) => {
    const rawIds = req.query.ids;
    const ids = !rawIds
      ? []
      : Array.isArray(rawIds)
      ? rawIds.flatMap((s) => String(s).split(","))
      : String(rawIds).split(",");
    const cleaned = ids.map((s) => s.trim()).filter(Boolean);
    const all = buildUserList();
    if (cleaned.length === 0) {
      res.send(renderComparePage({ allUsers: all, selected: [] }));
      return;
    }
    const cmp = buildCompare(cleaned);
    res.send(
      renderComparePage({
        users: cmp.users,
        dates: cmp.dates,
        byUser: cmp.byUser,
        allUsers: all,
        selected: cleaned,
      }),
    );
  });

  app.use("/", router);

  // JSON API (same shape as the SSR'd data, useful for future dynamic features)
  app.get("/api/dashboard/summary", (req, res) => {
    const data = buildOverview();
    data.userList = buildUserList();
    res.json(data);
  });
  app.get("/api/dashboard/users", (req, res) => res.json(buildUserList()));
  app.get("/api/dashboard/user/:id", (req, res) => {
    const data = buildUserDetail(req.params.id);
    if (!data) return res.status(404).json({ error: "not found" });
    res.json(data);
  });
  app.get("/api/dashboard/compare", (req, res) => {
    const rawIds = req.query.ids;
    const ids = !rawIds
      ? []
      : Array.isArray(rawIds)
      ? rawIds.flatMap((s) => String(s).split(","))
      : String(rawIds).split(",");
    res.json(buildCompare(ids.map((s) => s.trim()).filter(Boolean)));
  });
}
