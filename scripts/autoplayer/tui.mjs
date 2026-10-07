// The Autoplayer's live terminal view. Plain ANSI, no dependencies: an
// alternate screen redrawn in place once a second, with the newest log lines
// filling whatever height is left. Colours stay off red/green (the owner is
// colourblind) and on the site's orange accent.

const ESC = "\x1b[";
const c = {
  dim: (s) => ESC + "2m" + s + ESC + "22m",
  bold: (s) => ESC + "1m" + s + ESC + "22m",
  accent: (s) => ESC + "38;5;208m" + s + ESC + "39m",  // #ff6b35-ish
  gold: (s) => ESC + "38;5;220m" + s + ESC + "39m",
  purple: (s) => ESC + "38;5;141m" + s + ESC + "39m",
};

const SCALES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
export function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1000) return n < 10 && n % 1 ? n.toFixed(1) : String(Math.floor(n));
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SCALES.length) return n.toExponential(2);
  return (n / Math.pow(1000, tier)).toFixed(2) + SCALES[tier];
}
export function fmtDur(s) {
  if (!Number.isFinite(s)) return "never";
  s = Math.max(0, s);
  if (s < 60) return Math.ceil(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + String(Math.floor(s % 60)).padStart(2, "0") + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m";
  return Math.floor(s / 86400) + "d" + Math.floor((s % 86400) / 3600) + "h";
}

// What the Autoplayer actually earns per second: production plus its clicking.
export function income(snap) {
  return snap.perSecond + snap.cps * snap.perClick;
}

// One line per thing worth knowing, for the log file and non-TTY output.
export function statusLine(snap) {
  const t = snap.target;
  return fmt(snap.perSecond) + "/s · " + fmt(snap.perClick) + "/click · bank " + fmt(snap.bank) +
    " · next: " + (t ? t.name + " in " + fmtDur((t.cost - snap.bank) / income(snap)) : "—");
}

function buffLabel(b, now) {
  const what = b.kind === "prod_mult" ? "production" : b.kind === "click_mult" ? "click power" : b.building;
  const label = "×" + fmt(b.mult) + " " + what;
  if (b.mode === "queued") return c.dim("  " + label.padEnd(28) + "queued · starts in " + fmtDur((b.startsAt - now) / 1000) + ", runs " + fmtDur((b.expiresAt - b.startsAt) / 1000));
  if (b.mode === "eclipsed") return c.dim("  " + label.padEnd(28) + fmtDur((b.expiresAt - now) / 1000) + " left · outranked");
  return c.gold("▶ " + label.padEnd(28)) + fmtDur((b.expiresAt - now) / 1000) + " left";
}

export function createTui({ title }) {
  const out = process.stdout;
  const events = [];
  let snap = null;
  let health = "";
  let active = true;

  out.write(ESC + "?1049h" + ESC + "?25l"); // alternate screen, hide cursor
  const restore = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    out.write(ESC + "?25h" + ESC + "?1049l");
  };
  process.on("exit", restore);

  function draw() {
    if (!active) return;
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const now = Date.now();
    const rule = c.dim("─".repeat(Math.min(cols, 100)));
    const L = [];
    L.push(c.accent(c.bold(" GLIZZY AUTOPLAYER ")) + c.dim(" " + title + (snap ? " · up " + fmtDur((now - snap.startedAt) / 1000) : "") + (health ? " · " + health : "")));
    L.push(rule);
    if (!snap) {
      L.push("  waiting for the game page…");
    } else {
      const age = Math.max(0, (now - snap.at) / 1000);
      // Extrapolated a few seconds past the snapshot so the number keeps
      // moving between polls, but not on indefinitely if the page stops answering.
      const bank = snap.bank + income(snap) * Math.min(age, 5);
      const kv = (k, v) => "  " + c.dim(k.padEnd(12)) + v;
      L.push(kv("Bank", c.bold(fmt(bank))) + c.dim("    lifetime " + fmt(snap.lifetime)));
      L.push(kv("Production", c.accent(fmt(snap.perSecond) + "/s")));
      L.push(kv("Per click", c.accent(fmt(snap.perClick))) + c.dim("  × " + snap.cps + "/s = " + fmt(snap.cps * snap.perClick) + "/s"));
      L.push(kv("Income", c.bold(fmt(income(snap)) + "/s")));
      const t = snap.target;
      L.push(kv("Next buy", t
        ? c.purple(t.name) + c.dim(" · " + fmt(t.cost) + " · ") + c.bold(t.cost <= bank ? "now" : "in " + fmtDur((t.cost - bank) / income(snap)))
        : c.dim("buying…")));
      L.push(kv("Session", snap.purchases + " bought · " + snap.goldensClaimed + " golden glizzies"));
      if (snap.hidden) L.push(c.gold("  ⚠ page hidden — golden glizzies paused, timers throttled"));
      L.push(rule);
      L.push(c.bold("  Golden buffs"));
      if (snap.buffs.length) for (const b of snap.buffs) L.push("  " + buffLabel(b, now));
      else L.push(c.dim("    none running"));
      L.push(c.bold("  Bonuses") + c.dim("  from your hot dog stats"));
      if (snap.bonuses.length) for (const b of snap.bonuses) L.push("    " + b.emoji + " " + b.name + c.dim(" — " + b.description));
      else L.push(c.dim("    none today"));
    }
    L.push(rule);
    const room = Math.max(0, rows - L.length - 1);
    for (const e of events.slice(-room)) L.push(" " + e);

    // Clip to the terminal; a wrapped line would scroll the whole frame.
    const clip = (s) => {
      let vis = 0, outS = "";
      for (const part of s.split(/(\x1b\[[0-9;?]*[a-zA-Z])/)) {
        if (part.startsWith("\x1b[")) { outS += part; continue; }
        for (const ch of part) {
          const cp = ch.codePointAt(0);
          // Emoji and dingbats take two cells; joiners and variation selectors none.
          const w = cp === 0x200d || cp === 0xfe0f ? 0 : cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1;
          if (vis + w > cols - 1) return outS;
          outS += ch;
          vis += w;
        }
      }
      return outS;
    };
    out.write(ESC + "H" + L.slice(0, rows).map((l) => clip(l) + ESC + "K").join("\n") + ESC + "J");
  }
  const timer = setInterval(draw, 1000);
  out.on("resize", draw);

  return {
    event(line) {
      events.push(line);
      if (events.length > 500) events.splice(0, events.length - 500);
      draw();
    },
    update(s) { snap = s; },
    setHealth(h) { health = h; },
    close: restore,
  };
}
