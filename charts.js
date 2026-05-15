import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
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
  const row = getUserDisplayNameStmt.get(userId);
  if (row && row.username) return row.username;
  return `User ${userId.slice(-4)}`;
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

function heatColor(value, max) {
  if (value === 0 || max === 0) return "#23232b";
  const t = Math.min(1, value / max);
  // green -> orange -> red. Skip beyond gluttony into deep red.
  const hue = (1 - t) * 130; // 130 = green, 0 = red
  const sat = 65;
  const light = 30 + t * 20;
  return `hsl(${hue}, ${sat}%, ${light}%)`;
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

export function renderHeatmap({ userId } = {}) {
  const events = getAllEventsStmt.all();
  const dailyMap = aggregateDaily(events, userId);

  const weeks = 53;
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
  ctx.fillText("Last 53 weeks (Pacific time)", 20, 58);

  // Compute the grid start date (Sunday of 52 weeks ago).
  const now = new Date();
  const todayPacificKey = toPacificDateKey(now);
  // Walk back to today's day-of-week start.
  // We'll align the rightmost column to the current week.
  // Using a stable anchor: parse today's key back into a date and treat it as Pacific midnight.
  const anchorDate = new Date(todayPacificKey + "T12:00:00Z"); // safe noon
  const dayOfWeek = anchorDate.getUTCDay(); // 0=Sun..6=Sat (close enough for layout)
  const totalDays = weeks * 7;
  const startDate = shiftDays(anchorDate, -(totalDays - 1 - (6 - dayOfWeek)));

  // Determine the max daily total in the visible range for color scaling.
  let max = 1;
  for (let i = 0; i < totalDays; i++) {
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

  // Legend at bottom-left
  const legendY = gridTop + gridHeight + 26;
  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 11px Inter";
  ctx.fillText("Less", gridLeft, legendY + 11);
  for (let i = 0; i < 5; i++) {
    const v = (i / 4) * max;
    ctx.fillStyle = heatColor(v, max);
    fillRoundRect(ctx, gridLeft + 36 + i * stride, legendY, cellSize, cellSize, 3);
  }
  ctx.fillStyle = "#9aa3b0";
  ctx.fillText("More", gridLeft + 36 + 5 * stride + 6, legendY + 11);

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

export function renderLeaderboard({ limit = 10 } = {}) {
  const requested = Math.max(1, Math.min(25, limit));
  const rows = getLeaderboardStmt.all().slice(0, requested);
  if (rows.length === 0) return renderEmptyState("No hot dog counts yet!");

  // Resolve display names cleanly (avoid <@id> mention strings).
  const labelled = rows.map((r) => ({
    user_id: r.user_id,
    name: getDisplayName(r.user_id),
    total: r.total_count,
  }));

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
  const barX = 200;
  const barMaxWidth = w - barX - 100;
  const barHeight = 26;

  labelled.forEach((row, idx) => {
    const y = headerHeight + idx * rowHeight;
    const rank = idx + 1;

    // Rank number
    ctx.fillStyle = idx === 0 ? "#ffd166" : idx === 1 ? "#cbd5e1" : idx === 2 ? "#d4a574" : "#6b7280";
    ctx.font = "700 22px Inter";
    ctx.textAlign = "right";
    ctx.fillText(`${rank}`, 50, y + barHeight + 1);

    // Name
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "600 14px Inter";
    ctx.textAlign = "left";
    const truncated = row.name.length > 18 ? row.name.slice(0, 17) + "…" : row.name;
    ctx.fillText(truncated, 70, y + barHeight - 3);

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
// 4. STAT CARD
// ============================================================================

export function renderStatCard({ userId }) {
  if (!userId) return renderEmptyState("No user supplied.");
  const events = getAllEventsStmt.all();

  const userEvents = events.filter((e) => e.user_id === userId);
  if (userEvents.length === 0) {
    return renderEmptyState(`${getDisplayName(userId)} has no hot dogs yet.`);
  }

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

  // Username header
  const name = getDisplayName(userId);
  ctx.fillStyle = "#fff";
  ctx.font = "700 36px Inter";
  ctx.fillText(name, 32, 70);

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 14px Inter";
  ctx.fillText("Hot dog stat card", 32, 94);

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

  // Mini-heatmap on right (last 26 weeks ≈ 6 months)
  const miniWeeks = 26;
  const miniCell = 14;
  const miniGap = 3;
  const miniStride = miniCell + miniGap;
  const miniLeft = w - 32 - miniWeeks * miniStride;
  const miniTop = 130;

  ctx.fillStyle = "#9aa3b0";
  ctx.font = "400 12px Inter";
  ctx.fillText("LAST 26 WEEKS", miniLeft, miniTop - 12);

  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const anchor = new Date(todayKey + "T12:00:00Z");
  const dayOfWeek = anchor.getUTCDay();
  const miniStart = shiftDays(anchor, -(miniWeeks * 7 - 1 - (6 - dayOfWeek)));

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
