import express from "express";
import {
  db,
  getAllEventsStmt,
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  listPublishedStoriesStmt,
  getArchiveAttachmentByIdStmt,
  getArchiveAttachmentsForMessageStmt,
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
  const row = getUserDisplayNameStmt.get(userId);
  if (row && row.username) return row.username;
  return `User ${String(userId).slice(-4)}`;
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

function heatmapSeries(dailyMap, weeks = 53) {
  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const anchor = new Date(todayKey + "T12:00:00Z");
  const dayOfWeek = anchor.getUTCDay();
  const totalDays = weeks * 7;
  const start = shiftDays(anchor, -(totalDays - 1 - (6 - dayOfWeek)));

  let max = 0;
  const cells = [];
  for (let i = 0; i < totalDays; i++) {
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
  return { cells, weeks, max };
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

function renderLayout(title, body, data) {
  // Escape `<` so a `</script>` inside any string value can't break us out of the script tag.
  const dataJson = JSON.stringify(data || {}).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Hot Dog Hub</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">
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
          <div class="text-slate-300 text-sm mt-1">Last 53 weeks · color by daily total</div>
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
        <div class="md:col-span-2">
          <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">User dashboard</div>
          <h1 class="text-5xl font-bold text-white tracking-tight">${esc(data.name)}</h1>
          <div class="mt-3 text-lg text-slate-300">
            <span class="accent font-bold text-2xl">${esc(data.total)}</span> hot dogs ·
            ${data.rank ? `rank <span class="accent font-semibold">#${esc(data.rank)}</span> of ${esc(data.totalUsers)}` : ""}
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
          <div class="text-slate-300 text-sm mt-1">Last 53 weeks</div>
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
              <div>
                <div class="text-xs uppercase tracking-widest text-slate-400">User</div>
                <div class="text-lg font-bold text-white mt-1">${esc(u.name)}</div>
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

function findHeroAttachment(story) {
  if (story.hero_attachment_id) {
    const a = getArchiveAttachmentByIdStmt.get(story.hero_attachment_id);
    if (a && a.content_type && a.content_type.startsWith("image/")) return a;
  }
  // Fallback: first image attachment among the source messages.
  let ids = [];
  try { ids = JSON.parse(story.source_message_ids || "[]"); } catch {}
  for (const mid of ids) {
    const atts = getArchiveAttachmentsForMessageStmt.all(mid);
    const img = atts.find((a) => a.content_type && a.content_type.startsWith("image/"));
    if (img) return img;
  }
  return null;
}

function paragraphs(body) {
  return String(body || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderArchivePage(stories) {
  if (stories.length === 0) {
    const body = `
      <section class="mb-6">
        <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Archive</div>
        <h1 class="text-4xl font-bold text-white tracking-tight">The story so far</h1>
      </section>
      <div class="card p-12 text-center">
        <div class="text-5xl mb-3">🌭</div>
        <div class="text-xl text-slate-200 font-semibold">No stories yet</div>
        <div class="text-slate-400 mt-2">The archive bot is still warming up. Check back in a bit.</div>
      </div>`;
    return renderLayout("Archive", body, {});
  }

  const cards = stories
    .map((s) => {
      const hero = findHeroAttachment(s);
      const dateLabel = s.period_start && s.period_end && s.period_start.slice(0, 10) !== s.period_end.slice(0, 10)
        ? `${formatStoryDate(s.period_start)} – ${formatStoryDate(s.period_end)}`
        : formatStoryDate(s.period_end || s.period_start);
      const heroHtml = hero
        ? `<div class="aspect-[16/9] overflow-hidden bg-slate-900">
             <img src="${esc(hero.public_url)}" alt="" loading="lazy" class="w-full h-full object-cover">
           </div>`
        : "";
      return `
        <article class="card overflow-hidden mb-8">
          ${heroHtml}
          <div class="p-6 md:p-8">
            <div class="text-xs uppercase tracking-widest text-accent-soft mb-2">${esc(dateLabel)}</div>
            <h2 class="text-2xl md:text-3xl font-bold text-white tracking-tight mb-3">${esc(s.title)}</h2>
            <div class="prose-archive text-slate-300 leading-relaxed space-y-3">${paragraphs(s.body)}</div>
          </div>
        </article>`;
    })
    .join("");

  const body = `
    <section class="mb-8">
      <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Archive</div>
      <h1 class="text-4xl md:text-5xl font-bold text-white tracking-tight">The story so far</h1>
      <p class="text-slate-400 mt-2">Significant moments from the channel, curated automatically.</p>
    </section>
    <div class="max-w-3xl mx-auto">${cards}</div>`;
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
    res.send(renderArchivePage(stories));
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
