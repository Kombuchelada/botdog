import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { Chart, registerables } from "chart.js";
import "chartjs-adapter-date-fns";

import {
  buildUserDatesMap,
  getCurrentStreak,
  getLongestStreakEver,
  buildUserMaxDailyMap,
  toPacificDateKey,
  parseUtcTimestamp,
} from "./stats.js";
import {
  db,
  getAllEventsStmt,
  getLeaderboardStmt,
  getUserProfileStmt,
} from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

GlobalFonts.registerFromPath(
  path.join(__dirname, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2"),
  "Inter",
);
GlobalFonts.registerFromPath(
  path.join(__dirname, "node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2"),
  "Inter",
);

Chart.register(...registerables);
Chart.defaults.font.family = "Inter";
Chart.defaults.color = "#cfd2d6";
Chart.defaults.animation = false;
Chart.defaults.responsive = false;
Chart.defaults.devicePixelRatio = 1;

const BG_TOP = "#1a1a2e";
const BG_BOTTOM = "#0e0e1a";
const ACCENT = "#ff6b35";
const ACCENT_SOFT = "#ffa07a";

const getUserDisplayNameStmt = db.prepare(
  "SELECT username FROM hotdog_events WHERE user_id = ? AND username NOT LIKE '<@%' ORDER BY timestamp DESC LIMIT 1",
);

function getDisplayName(userId) {
  const profile = getUserProfileStmt.get(userId);
  if (profile && (profile.global_name || profile.username)) {
    return profile.global_name || profile.username;
  }
  const row = getUserDisplayNameStmt.get(userId);
  if (row && row.username) return row.username;
  return `User ${userId.slice(-4)}`;
}

// In-memory cache of loaded avatar images keyed by Spaces URL.
// Cleared on process restart; daily worker refresh re-uploads when avatars change.
const avatarImageCache = new Map();

async function loadAvatarImage(userId) {
  const profile = getUserProfileStmt.get(userId);
  if (!profile || !profile.avatar_url) return null;
  const url = profile.avatar_url;
  if (avatarImageCache.has(url)) return avatarImageCache.get(url);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    avatarImageCache.set(url, img);
    return img;
  } catch {
    return null;
  }
}

async function loadAvatarImages(userIds) {
  const results = await Promise.all(userIds.map((id) => loadAvatarImage(id).catch(() => null)));
  return new Map(userIds.map((id, i) => [id, results[i]]));
}

function drawCircularAvatar(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.stroke();
  ctx.restore();
}

function drawInitialsAvatar(ctx, name, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#334155";
  ctx.fill();
  ctx.fillStyle = "#cbd5e1";
  ctx.font = `700 ${Math.round(r * 0.95)}px Inter`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((name?.[0] || "?").toUpperCase(), cx, cy + 1);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawAvatarOrPlaceholder(ctx, img, name, cx, cy, r) {
  if (img) drawCircularAvatar(ctx, img, cx, cy, r);
  else drawInitialsAvatar(ctx, name, cx, cy, r);
}

function makeCanvas(w, h) {
  const canvas = createCanvas(w, h);
  // Chart.js looks for these properties on the canvas element.
  canvas.style = {};
  return canvas;
}

function paintBackground(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle radial vignette
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) / 3, w / 2, h / 2, Math.max(w, h));
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

// Plasma — sequential, perceptually uniform, colorblind-safe (designed for
// protan/deutan deficiencies). Same palette used by dashboard.js.
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

function heatColor(value, max) {
  if (value === 0 || max === 0) return "#23232b";
  const t = Math.min(1, value / max);
  return plasmaColor(t);
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

function startOfPacificDay(date) {
  const key = toPacificDateKey(date);
  return new Date(key + "T08:00:00Z"); // Pacific midnight is roughly 8 UTC; close enough for grid math
}

function shiftDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// ============================================================================
// 1. HEATMAP
// ============================================================================

// Fixed lower bound for the heatmap — Year of the Glizzy began here.
const HEATMAP_START_ISO = "2025-12-31";
const HEATMAP_MAX_WEEKS = 52;

/**
 * Compute the heatmap window: starts at the Sunday on/before HEATMAP_START_ISO,
 * ends at the Saturday of this week, capped to HEATMAP_MAX_WEEKS columns
 * (sliding forward once we accumulate more history than the cap allows).
 */
function computeHeatmapWindow(now = new Date()) {
  const todayPacificKey = toPacificDateKey(now);

  const lowerBound = new Date(HEATMAP_START_ISO + "T12:00:00Z");
  lowerBound.setUTCDate(lowerBound.getUTCDate() - lowerBound.getUTCDay());

  const endAnchor = new Date(todayPacificKey + "T12:00:00Z");
  endAnchor.setUTCDate(endAnchor.getUTCDate() + (6 - endAnchor.getUTCDay()));

  // Start no earlier than (endAnchor - 52 weeks + 1 day): keeps the column count <= 52.
  const maxBackStart = new Date(endAnchor);
  maxBackStart.setUTCDate(maxBackStart.getUTCDate() - (HEATMAP_MAX_WEEKS * 7 - 1));

  const startDate = lowerBound > maxBackStart ? lowerBound : maxBackStart;
  const capped = maxBackStart > lowerBound;

  const totalDays = Math.round((endAnchor - startDate) / 86400000) + 1;
  const weeks = Math.ceil(totalDays / 7);
  return { startDate, endAnchor, weeks, capped, now };
}

export function renderHeatmap({ userId } = {}) {
  const events = getAllEventsStmt.all();
  const dailyMap = aggregateDaily(events, userId);

  const { startDate, weeks, capped, now } = computeHeatmapWindow();

  const cellSize = 14;
  const gap = 3;
  const stride = cellSize + gap;
  const gridLeft = 70;
  const gridTop = 80;
  const gridWidth = weeks * stride;
  const gridHeight = 7 * stride;

  const w = gridLeft + gridWidth + 40;
  const h = gridTop + gridHeight + 70;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");

  paintBackground(ctx, w, h);

  // Title
  const isUserScoped = !!userId;
  const subject = isUserScoped ? getDisplayName(userId) : "Server";
  ctx.fillStyle = "#fff";
  ctx.font = "700 24px Inter";
  ctx.fillText(`${subject} — Hot Dog Activity`, 20, 38);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 13px Inter";
  ctx.fillText(capped ? `Last ${HEATMAP_MAX_WEEKS} weeks (Pacific time)` : "Since Dec 31, 2025 (Pacific time)", 20, 58);

  // Determine the max daily total in the visible range for color scaling.
  let max = 1;
  for (let i = 0; i < weeks * 7; i++) {
    const k = toPacificDateKey(shiftDays(startDate, i));
    const v = dailyMap.get(k) || 0;
    if (v > max) max = v;
  }

  // Month labels
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  let lastMonth = -1;
  for (let week = 0; week < weeks; week++) {
    const colDate = shiftDays(startDate, week * 7);
    const m = colDate.getUTCMonth();
    if (m !== lastMonth) {
      const label = colDate.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
      ctx.fillText(label, gridLeft + week * stride, gridTop - 8);
      lastMonth = m;
    }
  }

  // Day-of-week labels
  ctx.fillStyle = "#7d8590";
  ctx.font = "400 11px Inter";
  const dayLabels = { 1: "Mon", 3: "Wed", 5: "Fri" };
  for (let d = 0; d < 7; d++) {
    if (dayLabels[d]) ctx.fillText(dayLabels[d], 30, gridTop + d * stride + 10);
  }

  // Cells
  for (let week = 0; week < weeks; week++) {
    for (let d = 0; d < 7; d++) {
      const cellDate = shiftDays(startDate, week * 7 + d);
      if (cellDate > now) continue;
      const key = toPacificDateKey(cellDate);
      const value = dailyMap.get(key) || 0;
      const x = gridLeft + week * stride;
      const y = gridTop + d * stride;
      ctx.fillStyle = heatColor(value, max);
      fillRoundRect(ctx, x, y, cellSize, cellSize, 3);
    }
  }

  // Continuous gradient legend at bottom-left
  const legendY = gridTop + gridHeight + 26;
  const barLeft = gridLeft + 36;
  const barWidth = 5 * stride;
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  ctx.fillText("Less", gridLeft, legendY + 11);

  const legendGrad = ctx.createLinearGradient(barLeft, 0, barLeft + barWidth, 0);
  legendGrad.addColorStop(0.0, plasmaColor(0.0));
  legendGrad.addColorStop(0.25, plasmaColor(0.25));
  legendGrad.addColorStop(0.5, plasmaColor(0.5));
  legendGrad.addColorStop(0.75, plasmaColor(0.75));
  legendGrad.addColorStop(1.0, plasmaColor(1.0));
  ctx.fillStyle = legendGrad;
  fillRoundRect(ctx, barLeft, legendY, barWidth, cellSize, 3);

  ctx.fillStyle = "#9aa3b0";
  ctx.fillText("More", barLeft + barWidth + 6, legendY + 11);

  // Total at right
  const total = Array.from(dailyMap.values()).reduce((a, b) => a + b, 0);
  ctx.fillStyle = "#fff";
  ctx.font = "700 16px Inter";
  ctx.textAlign = "right";
  ctx.fillText(`${total} hot dogs`, w - 20, legendY + 12);
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  ctx.fillText(`peak day: ${max}`, w - 20, legendY + 30);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

// ============================================================================
// 2. TIMELINE (cumulative)
// ============================================================================

export function renderTimeline({ userId } = {}) {
  const events = getAllEventsStmt.all();
  const dailyMap = aggregateDaily(events, userId);

  // Build sorted list of (date, dailyTotal). Fill gaps with 0 for a smooth line.
  const keys = Array.from(dailyMap.keys()).sort();
  if (keys.length === 0) {
    return renderEmptyState("No data yet — eat some hot dogs!");
  }

  const startDate = new Date(keys[0] + "T12:00:00Z");
  const endDate = new Date(toPacificDateKey(new Date()) + "T12:00:00Z");
  const series = [];
  let cumulative = 0;
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const k = toPacificDateKey(cursor);
    cumulative += dailyMap.get(k) || 0;
    series.push({ x: new Date(cursor), y: cumulative });
    cursor = shiftDays(cursor, 1);
  }

  const w = 960, h = 520;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, w, h);

  // Title
  const subject = userId ? getDisplayName(userId) : "Server";
  ctx.fillStyle = "#fff";
  ctx.font = "700 26px Inter";
  ctx.fillText(`${subject} — Cumulative Hot Dogs`, 28, 42);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 13px Inter";
  ctx.fillText(`${keys.length} days of data`, 28, 64);

  // Big total readout (top-right)
  ctx.fillStyle = "#fff";
  ctx.font = "700 32px Inter";
  ctx.textAlign = "right";
  ctx.fillText(`${cumulative}`, w - 28, 42);
  ctx.font = "400 12px Inter";
  ctx.fillStyle = ACCENT_SOFT;
  ctx.fillText("total hot dogs", w - 28, 62);
  ctx.textAlign = "left";

  // Chart area
  const chartTop = 90;
  const chartLeft = 0;
  const chartWidth = w;
  const chartHeight = h - chartTop - 30;

  // Render the chart to a sub-canvas so the gradient lives in the chart's ctx.
  const chartCanvas = makeCanvas(chartWidth, chartHeight);
  const chartCtx = chartCanvas.getContext("2d");

  const fillGradient = chartCtx.createLinearGradient(0, 0, 0, chartHeight);
  fillGradient.addColorStop(0, "rgba(255,107,53,0.55)");
  fillGradient.addColorStop(1, "rgba(255,107,53,0.02)");

  new Chart(chartCanvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Total",
          data: series,
          borderColor: ACCENT,
          borderWidth: 2.5,
          backgroundColor: fillGradient,
          fill: true,
          pointRadius: 0,
          tension: 0.18,
        },
      ],
    },
    options: {
      animation: false,
      responsive: false,
      devicePixelRatio: 1,
      layout: { padding: { left: 30, right: 30, top: 10, bottom: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: series.length > 365 ? "month" : "week" },
          ticks: { color: "#9aa3b0", font: { family: "Inter", size: 11 }, maxRotation: 0 },
          grid: { color: "rgba(255,255,255,0.04)" },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#9aa3b0", font: { family: "Inter", size: 11 } },
          grid: { color: "rgba(255,255,255,0.06)" },
          border: { display: false },
        },
      },
    },
  });

  // Composite chart onto main canvas
  ctx.drawImage(chartCanvas, chartLeft, chartTop);

  // Accent baseline
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(28, 78);
  ctx.lineTo(w - 28, 78);
  ctx.stroke();
  ctx.globalAlpha = 1;

  return canvas.toBuffer("image/png");
}

// ============================================================================
// 3. LEADERBOARD bar chart
// ============================================================================

export async function renderLeaderboard({ limit = 10 } = {}) {
  const requested = Math.max(1, Math.min(25, limit));
  const rows = getLeaderboardStmt.all().slice(0, requested);
  if (rows.length === 0) return renderEmptyState("No hot dog counts yet!");

  // Resolve display names cleanly (avoid <@id> mention strings).
  const labelled = rows.map((r) => ({
    user_id: r.user_id,
    name: getDisplayName(r.user_id),
    total: r.total_count,
  }));

  // Pre-warm avatar cache in parallel so we don't serialize 10 network fetches.
  const avatars = await loadAvatarImages(labelled.map((r) => r.user_id));

  const w = 880;
  const rowHeight = 42;
  const headerHeight = 110;
  const footerHeight = 30;
  const h = headerHeight + rows.length * rowHeight + footerHeight;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, w, h);

  // Title
  ctx.fillStyle = "#fff";
  ctx.font = "700 26px Inter";
  ctx.fillText("Hot Dog Leaderboard", 28, 44);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 13px Inter";
  ctx.fillText(`Top ${rows.length}`, 28, 66);

  const grandTotal = labelled.reduce((s, r) => s + r.total, 0);
  ctx.font = "700 32px Inter";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.fillText(`${grandTotal}`, w - 28, 44);
  ctx.font = "400 12px Inter";
  ctx.fillStyle = ACCENT_SOFT;
  ctx.fillText("combined", w - 28, 62);
  ctx.textAlign = "left";

  // Bars
  const maxValue = labelled[0].total;
  const barX = 240; // bumped right to make room for the avatar tile
  const barMaxWidth = w - barX - 100;
  const barHeight = 26;
  const avatarRadius = 13;

  labelled.forEach((row, idx) => {
    const y = headerHeight + idx * rowHeight;
    const rank = idx + 1;

    // Rank number
    ctx.fillStyle = idx === 0 ? "#ffd166" : idx === 1 ? "#cbd5e1" : idx === 2 ? "#d4a574" : "#6b7280";
    ctx.font = "700 22px Inter";
    ctx.textAlign = "right";
    ctx.fillText(`${rank}`, 50, y + barHeight + 1);

    // Avatar
    drawAvatarOrPlaceholder(ctx, avatars.get(row.user_id), row.name, 78, y + barHeight / 2, avatarRadius);

    // Name
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "600 14px Inter";
    ctx.textAlign = "left";
    const truncated = row.name.length > 16 ? row.name.slice(0, 15) + "…" : row.name;
    ctx.fillText(truncated, 102, y + barHeight - 3);

    // Bar with gradient
    const ratio = row.total / maxValue;
    const barWidth = Math.max(4, ratio * barMaxWidth);
    const grad = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
    const hue = 28 - idx * 1.2;
    grad.addColorStop(0, `hsl(${hue}, 90%, 55%)`);
    grad.addColorStop(1, `hsl(${hue}, 80%, 45%)`);
    ctx.fillStyle = grad;
    fillRoundRect(ctx, barX, y, barWidth, barHeight, 6);

    // Subtle shine
    const shine = ctx.createLinearGradient(0, y, 0, y + barHeight);
    shine.addColorStop(0, "rgba(255,255,255,0.18)");
    shine.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = shine;
    fillRoundRect(ctx, barX, y, barWidth, barHeight, 6);

    // Value
    ctx.fillStyle = "#fff";
    ctx.font = "700 16px Inter";
    ctx.textAlign = "left";
    ctx.fillText(`${row.total}`, barX + barWidth + 10, y + barHeight - 5);
  });

  return canvas.toBuffer("image/png");
}

// ============================================================================
// 4. WHEN HEATMAP (day-of-week × hour-of-day)
// ============================================================================

const PACIFIC_DOW_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  hour12: false,
});

function buildWhenGrid(events, userId) {
  const filtered = userId ? events.filter((e) => e.user_id === userId) : events;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const e of filtered) {
    if (e.amount <= 0) continue;
    const d = parseUtcTimestamp(e.timestamp);
    if (!d || isNaN(d.getTime())) continue;
    const parts = PACIFIC_DOW_HOUR.formatToParts(d);
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

export function renderWhenHeatmap({ userId } = {}) {
  const events = getAllEventsStmt.all();
  const { grid, max } = buildWhenGrid(events, userId);

  const cellSize = 22;
  const gap = 3;
  const stride = cellSize + gap;
  const gridLeft = 70;
  const gridTop = 90;
  const gridWidth = 24 * stride;
  const gridHeight = 7 * stride;

  const w = gridLeft + gridWidth + 40;
  const h = gridTop + gridHeight + 70;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");

  paintBackground(ctx, w, h);

  const subject = userId ? getDisplayName(userId) : "Server";
  ctx.fillStyle = "#fff";
  ctx.font = "700 24px Inter";
  ctx.fillText(`${subject} — When Dogs Get Eaten`, 20, 38);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 13px Inter";
  ctx.fillText("By day of week and hour (Pacific time)", 20, 58);

  // Hour labels at the top (every 3 hours)
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  ctx.textAlign = "center";
  for (let h = 0; h < 24; h += 3) {
    const x = gridLeft + h * stride + cellSize / 2;
    ctx.fillText(String(h).padStart(2, "0"), x, gridTop - 8);
  }
  ctx.textAlign = "left";

  // Day labels on the left
  ctx.fillStyle = "#7d8590";
  ctx.font = "400 11px Inter";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    ctx.fillText(days[d], 30, gridTop + d * stride + cellSize / 2 + 4);
  }

  // Cells
  for (let d = 0; d < 7; d++) {
    for (let hh = 0; hh < 24; hh++) {
      const v = grid[d][hh];
      const x = gridLeft + hh * stride;
      const y = gridTop + d * stride;
      ctx.fillStyle = heatColor(v, max);
      fillRoundRect(ctx, x, y, cellSize, cellSize, 4);
    }
  }

  // Continuous gradient legend
  const legendY = gridTop + gridHeight + 26;
  const barLeft = gridLeft + 36;
  const barWidth = 5 * stride;
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  ctx.fillText("Less", gridLeft, legendY + 11);
  const legendGrad = ctx.createLinearGradient(barLeft, 0, barLeft + barWidth, 0);
  legendGrad.addColorStop(0.0, plasmaColor(0.0));
  legendGrad.addColorStop(0.25, plasmaColor(0.25));
  legendGrad.addColorStop(0.5, plasmaColor(0.5));
  legendGrad.addColorStop(0.75, plasmaColor(0.75));
  legendGrad.addColorStop(1.0, plasmaColor(1.0));
  ctx.fillStyle = legendGrad;
  fillRoundRect(ctx, barLeft, legendY, barWidth, cellSize - 8, 3);
  ctx.fillStyle = "#9aa3b0";
  ctx.fillText("More", barLeft + barWidth + 6, legendY + 11);

  // Peak callout on right
  ctx.fillStyle = "#fff";
  ctx.font = "700 14px Inter";
  ctx.textAlign = "right";
  ctx.fillText(`peak: ${max}`, w - 20, legendY + 11);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

// ============================================================================
// 5. STAT CARD
// ============================================================================

export async function renderStatCard({ userId }) {
  if (!userId) return renderEmptyState("No user supplied.");
  const events = getAllEventsStmt.all();

  const userEvents = events.filter((e) => e.user_id === userId);
  if (userEvents.length === 0) {
    return renderEmptyState(`${getDisplayName(userId)} has no hot dogs yet.`);
  }

  const avatarImg = await loadAvatarImage(userId);

  const total = userEvents.reduce((s, e) => s + e.amount, 0);
  const datesMap = buildUserDatesMap(events);
  const dates = datesMap.get(userId) || new Set();
  const currentStreak = getCurrentStreak(dates);
  const longestStreak = getLongestStreakEver(dates);

  const maxDailyMap = buildUserMaxDailyMap(events);
  const maxInADay = maxDailyMap.get(userId) || 0;

  // Per-user daily map for the mini-heatmap
  const dailyMap = aggregateDaily(events, userId);

  const w = 960, h = 540;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, w, h);

  // Top accent stripe
  const accentGrad = ctx.createLinearGradient(0, 0, w, 0);
  accentGrad.addColorStop(0, ACCENT);
  accentGrad.addColorStop(1, "#ffb88c");
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, 0, w, 5);

  // Avatar + username header
  const name = getDisplayName(userId);
  drawAvatarOrPlaceholder(ctx, avatarImg, name, 70, 64, 36);
  ctx.fillStyle = "#fff";
  ctx.font = "700 36px Inter";
  ctx.fillText(name, 124, 70);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 14px Inter";
  ctx.fillText("Hot dog stat card", 124, 94);

  // Big total
  ctx.fillStyle = ACCENT;
  ctx.font = "700 84px Inter";
  ctx.fillText(`${total}`, 32, 200);

  ctx.fillStyle = "#cfd2d6";
  ctx.font = "400 16px Inter";
  ctx.fillText("hot dogs consumed", 32, 226);

  // Stat tiles
  const tiles = [
    { label: "Current streak", value: currentStreak, suffix: currentStreak === 1 ? "day" : "days" },
    { label: "Longest streak", value: longestStreak, suffix: longestStreak === 1 ? "day" : "days" },
    { label: "Most in a day",  value: maxInADay,     suffix: maxInADay === 1 ? "dog" : "dogs" },
  ];
  const tileTop = 280;
  const tileWidth = 180;
  const tileHeight = 110;
  const tileGap = 18;
  tiles.forEach((t, i) => {
    const x = 32 + i * (tileWidth + tileGap);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    fillRoundRect(ctx, x, tileTop, tileWidth, tileHeight, 12);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, tileTop, tileWidth, tileHeight, 12);
    ctx.stroke();

    ctx.fillStyle = "#9aa3b0";
    ctx.font = "400 12px Inter";
    ctx.fillText(t.label.toUpperCase(), x + 16, tileTop + 26);

    ctx.fillStyle = "#fff";
    ctx.font = "700 40px Inter";
    ctx.fillText(`${t.value}`, x + 16, tileTop + 78);

    ctx.fillStyle = ACCENT_SOFT;
    ctx.font = "400 13px Inter";
    ctx.fillText(t.suffix, x + 16, tileTop + 98);
  });

  // Mini-heatmap on right: last ~26 weeks, but never earlier than the project start.
  // As history grows past 26 weeks, this stays at 26. While history is shorter than
  // 26 weeks, it clamps to the project start so we don't draw a swath of empty cells.
  const MINI_WEEKS_TARGET = 26;
  const miniCell = 14;
  const miniGap = 3;
  const miniStride = miniCell + miniGap;
  const miniTop = 130;

  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const miniLowerBound = new Date(HEATMAP_START_ISO + "T12:00:00Z");
  miniLowerBound.setUTCDate(miniLowerBound.getUTCDate() - miniLowerBound.getUTCDay());
  const miniEndAnchor = new Date(todayKey + "T12:00:00Z");
  miniEndAnchor.setUTCDate(miniEndAnchor.getUTCDate() + (6 - miniEndAnchor.getUTCDay()));
  const wantStart = new Date(miniEndAnchor);
  wantStart.setUTCDate(wantStart.getUTCDate() - (MINI_WEEKS_TARGET * 7 - 1));
  const miniStart = wantStart > miniLowerBound ? wantStart : miniLowerBound;
  const miniTotalDays = Math.round((miniEndAnchor - miniStart) / 86400000) + 1;
  const miniWeeks = Math.ceil(miniTotalDays / 7);
  const miniLeft = w - 32 - miniWeeks * miniStride;

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 12px Inter";
  const miniLabel = miniWeeks >= MINI_WEEKS_TARGET ? `LAST ${MINI_WEEKS_TARGET} WEEKS` : "RECENT ACTIVITY";
  ctx.fillText(miniLabel, miniLeft, miniTop - 12);

  let miniMax = 1;
  for (let i = 0; i < miniWeeks * 7; i++) {
    const k = toPacificDateKey(shiftDays(miniStart, i));
    const v = dailyMap.get(k) || 0;
    if (v > miniMax) miniMax = v;
  }
  for (let week = 0; week < miniWeeks; week++) {
    for (let d = 0; d < 7; d++) {
      const cellDate = shiftDays(miniStart, week * 7 + d);
      if (cellDate > now) continue;
      const key = toPacificDateKey(cellDate);
      const value = dailyMap.get(key) || 0;
      ctx.fillStyle = heatColor(value, miniMax);
      fillRoundRect(ctx, miniLeft + week * miniStride, miniTop + d * miniStride, miniCell, miniCell, 3);
    }
  }

  // Average per active day
  const avgPerActiveDay = (total / dates.size).toFixed(1);

  // Footer info row
  const footerY = h - 28;
  ctx.fillStyle = "#7d8590";
  ctx.font = "400 12px Inter";
  ctx.fillText(`${dates.size} active days · avg ${avgPerActiveDay}/day · ${userEvents.length} submissions`, 32, footerY);

  // Rank lookup
  const allRows = getLeaderboardStmt.all();
  const rank = allRows.findIndex((r) => r.user_id === userId) + 1;
  if (rank > 0) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#9aa3b0";
    ctx.font = "700 14px Inter";
    ctx.fillText(`Rank #${rank} of ${allRows.length}`, w - 32, footerY);
    ctx.textAlign = "left";
  }

  return canvas.toBuffer("image/png");
}

// ============================================================================
// Empty state helper
// ============================================================================

function renderEmptyState(message) {
  const w = 600, h = 200;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "700 20px Inter";
  ctx.textAlign = "center";
  ctx.fillText(message, w / 2, h / 2);
  return canvas.toBuffer("image/png");
}
