// GlizzyBrawl's primary test seam: the WebSocket boundary.
//
// These tests boot the real Express app against a throwaway SQLite file,
// connect genuine `ws` clients carrying genuine signed session cookies, and
// assert only on two things — what a connected client observes, and what ends
// up in the ledger. No internal state is inspected, because the point is to
// pin the contract a browser actually depends on.
//
// The Arena runs in real time at 30Hz, so a few of these tests genuinely wait
// a second or two. BRAWL_TEST_MODE=1 shrinks the 60s AFK rule to 2s.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Must be set before database.js is imported — it opens the file at import time.
const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brawl-test-")), "test.db");
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_PASSWORD = "brawl-test-secret";
process.env.GAME_SESSION_SECRET = "brawl-test-secret";
process.env.BRAWL_TEST_MODE = "1";

const express = (await import("express")).default;
const { WebSocket } = await import("ws");
const { registerBrawl, attachBrawl, stopBrawl, MAX_FIGHTERS, MAX_CPUS } = await import("../brawl.js");
const { mintSessionCookie } = await import("../oauth.js");
const { db, insertHotdogEventStmt, getBrawlStatsStmt } = await import("../database.js");

const ALICE = "100000000000000001";
const BOB = "100000000000000002";

let server;
let baseUrl;

before(async () => {
  insertHotdogEventStmt.run(ALICE, "alice", 12);
  insertHotdogEventStmt.run(BOB, "bob", 3);

  const app = express();
  registerBrawl(app);
  server = http.createServer(app);
  attachBrawl(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  stopBrawl();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

// ---------------------------------------------------------------- harness

/** A connected client. `userId` null connects as a logged-out spectator. */
async function connect(userId) {
  const url = baseUrl.replace("http", "ws") + "/brawl/ws";
  const headers = userId ? { Cookie: mintSessionCookie(userId) } : {};
  const ws = new WebSocket(url, { headers });
  const received = [];
  const waiters = [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    received.push(msg);
    for (const w of waiters.slice()) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });

  const client = {
    ws,
    received,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    /** Resolve with the first message (past or future) matching `predicate`. */
    waitFor(predicate, { timeout = 8000, label = "message" } = {}) {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        waiters.push(entry);
        setTimeout(() => {
          if (!waiters.includes(entry)) return;
          waiters.splice(waiters.indexOf(entry), 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeout).unref();
      });
    },
    /** Latest snapshot view of a fighter, or undefined. */
    fighter(id) {
      for (let i = received.length - 1; i >= 0; i--) {
        const msg = received[i];
        if (msg.t !== "snap") continue;
        return msg.fighters.find((f) => f.id === id);
      }
      return undefined;
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.on("close", resolve);
        ws.close();
      });
    },
  };

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await client.waitFor((m) => m.t === "hello", { label: "hello" });
  return client;
}

let seq = 0;
function inputMsg(fields) {
  seq += 1;
  return { t: "input", seq, ...fields };
}

/** Hold an input for `ms`, resending it at roughly the tick rate. */
async function hold(client, fields, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    client.send(inputMsg(fields));
    await sleep(33);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scoreboard() {
  const res = await fetch(`${baseUrl}/api/brawl/scoreboard`);
  return res.json();
}

/**
 * Drop both Fighters to the main stage, then have `attacker` hold their ground
 * swinging while `target` paces in and out of range. Keeping the attacker
 * stationary (attacks plant your feet) and letting the target oscillate makes
 * a connection reliable despite the jitter of a real-time 30Hz Arena.
 */
async function brawl(attacker, target, { attackerId, targetId, ticks = 300, until = () => false }) {
  const groundY = attacker.received.find((m) => m.t === "hello").stage.ground.y;
  const onMainStage = (id) => {
    const f = attacker.fighter(id);
    return !!f && f.y >= groundY - 3;
  };

  // Spawn points are on the soft platforms, so both Fighters have to get down
  // to the main stage first. Walking off the inner platform edge is the boring,
  // timing-independent way to do it — pressing down+jump races the landing, and
  // walking *outward* drifts them off the stage entirely.
  const stage = attacker.received.find((m) => m.t === "hello").stage.ground;
  const centre = (stage.x1 + stage.x2) / 2;
  const inward = (id) => {
    const f = attacker.fighter(id);
    if (!f) return {};
    return f.x < centre ? { right: true } : { left: true };
  };
  let attackerDown = false;
  let targetDown = false;
  for (let i = 0; i < 150 && !(attackerDown && targetDown); i++) {
    attackerDown = attackerDown || onMainStage(attackerId);
    targetDown = targetDown || onMainStage(targetId);
    attacker.send(inputMsg(attackerDown ? {} : inward(attackerId)));
    target.send(inputMsg(targetDown ? {} : inward(targetId)));
    await sleep(33);
  }
  assert.ok(attackerDown && targetDown, "both Fighters reached the main stage");

  for (let i = 0; i < ticks && !until(); i++) {
    const a = attacker.fighter(attackerId);
    const b = attacker.fighter(targetId);
    const gap = a && b ? b.x - a.x : 999;
    attacker.send(inputMsg({ light: i % 6 < 3 }));
    target.send(inputMsg({ left: gap > 25, right: gap < -25, down: i % 20 === 0 }));
    await sleep(33);
  }
}

/** Join, run `fn`, then always tear the connection down. */
async function withClients(userIds, fn) {
  const clients = [];
  try {
    for (const id of userIds) clients.push(await connect(id));
    return await fn(...clients);
  } finally {
    for (const c of clients) await c.close();
    await sleep(120); // let the server process the closes
  }
}

// ------------------------------------------------------------ spectating

test("a logged-out visitor can watch but not fight", async () => {
  await withClients([null], async (guest) => {
    const hello = guest.received.find((m) => m.t === "hello");
    assert.equal(hello.canFight, false);
    assert.equal(hello.you, null);
    assert.ok(hello.stage && hello.roster.length === 4, "the stage and roster arrive with hello");

    guest.send({ t: "join", character: "glizzy" });
    const denied = await guest.waitFor((m) => m.t === "denied", { label: "denied" });
    assert.equal(denied.reason, "auth");
  });
});

test("the Arena is rendering for a spectator with no login at all", async () => {
  await withClients([null], async (guest) => {
    const snap = await guest.waitFor((m) => m.t === "snap", { label: "snapshot" });
    assert.equal(typeof snap.tick, "number");
    assert.ok(Array.isArray(snap.fighters));
  });
});

// ------------------------------------------------------------------ joining

test("a logged-in player joins straight into the Arena", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "ketchup" });
    const joined = await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    assert.equal(joined.fighterId, ALICE);
    assert.equal(joined.character, "ketchup");

    const snap = await alice.waitFor(
      (m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE),
      { label: "self in snapshot" },
    );
    const me = snap.fighters.find((f) => f.id === ALICE);
    assert.equal(me.character, "ketchup");
    assert.equal(me.percent, 0);
  });
});

test("hot dog stats decorate a Fighter and nothing more", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    const joined = await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    // The whole shape: decoration and the numbers that earned it, and nothing
    // resembling a gameplay modifier.
    const keys = Object.keys(joined.cosmetics).sort();
    assert.deepEqual(keys, ["crown", "finish", "lifetime", "notes", "streak", "trail"]);
  });
});

test("input moves your Fighter", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    await alice.waitFor((m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE), { label: "spawn" });

    const startX = alice.fighter(ALICE).x;
    await hold(alice, { right: true }, 500);
    assert.ok(alice.fighter(ALICE).x > startX + 30, "the Fighter ran right");
  });
});

test("a stale input frame is ignored, not replayed", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    await alice.waitFor((m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE), { label: "spawn" });

    // A fresh frame says "run right"; a frame built earlier (lower seq) that
    // arrives late says "run left". The late one must not win.
    alice.send({ t: "input", seq: 5000, right: true });
    await sleep(200);
    const afterRight = alice.fighter(ALICE).x;
    for (let i = 0; i < 10; i++) {
      alice.send({ t: "input", seq: 4000, left: true });
      await sleep(33);
    }
    assert.ok(alice.fighter(ALICE).x >= afterRight, "the stale left-frame never applied");
    seq = 5001;
  });
});

test("every hit reaches the client, including the ones between snapshots", async () => {
  await withClients([ALICE, BOB], async (alice, bob) => {
    alice.send({ t: "join", character: "glizzy" });
    bob.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "alice joined" });
    await bob.waitFor((m) => m.t === "joined", { label: "bob joined" });

    const hitsSoFar = () =>
      alice.received
        .filter((m) => m.t === "snap")
        .flatMap((m) => m.events)
        .filter((e) => e.type === "hit" && e.victim === BOB).length;
    await brawl(alice, bob, { attackerId: ALICE, targetId: BOB, until: () => hitsSoFar() >= 3 });
    await sleep(200);

    // Percent is the sum of the damage dealt, so if the stream had dropped a
    // hit event (snapshots go out every other tick) the totals would diverge.
    const hits = alice.received
      .filter((m) => m.t === "snap")
      .flatMap((m) => m.events)
      .filter((e) => e.type === "hit" && e.victim === BOB);
    assert.ok(hits.length >= 2, `expected several hits, saw ${hits.length}`);

    const kos = alice.received
      .filter((m) => m.t === "snap")
      .flatMap((m) => m.events)
      .filter((e) => e.type === "ko" && e.victim === BOB).length;
    assert.equal(kos, 0, "this exchange should not have knocked anyone out");

    const dealt = hits.reduce((sum, h) => sum + h.damage, 0);
    assert.ok(
      Math.abs(dealt - alice.fighter(BOB).percent) < 1,
      `reported damage ${dealt} should account for all of Bob's ${alice.fighter(BOB).percent}%`,
    );
  });
});

test("a quick tap is never swallowed, even between server ticks", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    await alice.waitFor((m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE), { label: "spawn" });

    // Press and release inside the same millisecond — both frames land between
    // two server ticks, so a "newest frame wins" server would never see the
    // press at all and the attack would silently not happen.
    alice.send(inputMsg({ light: true }));
    alice.send(inputMsg({ light: false }));

    const swung = await alice.waitFor(
      (m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE && f.attack),
      { timeout: 3000, label: "the attack" },
    );
    assert.ok(swung.fighters.find((f) => f.id === ALICE).attack, "the tap produced an attack");
  });
});

// --------------------------------------------------------------- the ledger

test("a KO is written to the ledger for both players, all-time and today", async () => {
  await withClients([ALICE, BOB], async (alice, bob) => {
    alice.send({ t: "join", character: "glizzy" });
    bob.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "alice joined" });
    await bob.waitFor((m) => m.t === "joined", { label: "bob joined" });
    await alice.waitFor((m) => m.t === "snap" && m.fighters.length >= 2, { label: "both fighters" });

    const landed = () =>
      alice.received.some(
        (m) => m.t === "snap" && m.events.some((e) => e.type === "hit" && e.attacker === ALICE),
      );
    await brawl(alice, bob, { attackerId: ALICE, targetId: BOB, until: landed });
    assert.ok(landed(), "Alice landed a hit on Bob");

    // Bob, freshly hit, runs off the right edge — a Fall credited to Alice.
    const koed = bob.waitFor(
      (m) => m.t === "snap" && m.events.some((e) => e.type === "ko" && e.victim === BOB),
      { timeout: 12000, label: "the KO" },
    );
    for (let i = 0; i < 200; i++) {
      bob.send(inputMsg({ right: true }));
      // Keep Alice in the Arena: her Fighter fading out mid-fall must not be
      // what this test is measuring (that it still credits her is covered by
      // the sim suite).
      alice.send(inputMsg({ down: i % 20 === 0 }));
      await sleep(33);
      if (bob.received.some((m) => m.t === "snap" && m.events.some((e) => e.type === "ko" && e.victim === BOB))) break;
    }
    const koSnap = await koed;
    const ko = koSnap.events.find((e) => e.type === "ko");
    assert.equal(ko.attacker, ALICE, "the last Fighter to land a hit gets the KO");
    await sleep(200);

    const board = await scoreboard();
    const aliceRow = board.allTime.find((r) => r.userId === ALICE);
    const bobRow = board.allTime.find((r) => r.userId === BOB);
    assert.ok(aliceRow && aliceRow.kos >= 1, "Alice's KO is on the all-time board");
    assert.ok(bobRow && bobRow.falls >= 1, "Bob's Fall is on the all-time board");

    const aliceToday = board.today.find((r) => r.userId === ALICE);
    assert.ok(aliceToday && aliceToday.kos >= 1, "and on today's Day Tally");

    const persisted = getBrawlStatsStmt.get(ALICE);
    assert.ok(persisted.kos >= 1);
    assert.ok(persisted.best_streak >= 1, "the KO Streak was remembered");
    assert.ok(JSON.parse(persisted.character_kos).glizzy >= 1, "per-character KOs were remembered");
  });
});

test("Arena time accrues while you are in the fight", async () => {
  await withClients([BOB], async (bob) => {
    const before = getBrawlStatsStmt.get(BOB)?.arena_seconds || 0;
    bob.send({ t: "join", character: "grill" });
    await bob.waitFor((m) => m.t === "joined", { label: "joined" });
    await hold(bob, { right: true }, 1200);
    bob.send({ t: "leave" });
    await bob.waitFor((m) => m.t === "despawned", { label: "despawn" });
    await sleep(150);
    const after = getBrawlStatsStmt.get(BOB).arena_seconds;
    assert.ok(after > before, `arena time grew (${before} -> ${after})`);
  });
});

// ------------------------------------------------------------------- CPUs

test("CPUs are for solo practice, and leave no trace on anyone's record", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });

    alice.send({ t: "cpu", count: 2 });
    await alice.waitFor((m) => m.t === "cpus", { label: "cpus spawned" });
    const withCpus = await alice.waitFor(
      (m) => m.t === "snap" && m.fighters.filter((f) => f.cpu).length >= 2,
      { label: "CPUs in the Arena" },
    );
    assert.ok(withCpus.fighters.filter((f) => f.cpu).length >= 2);

    // Alice throws herself off the stage while CPUs are present. Practice must
    // not touch the ledger — not even her own Fall.
    const fallsBefore = getBrawlStatsStmt.get(ALICE).falls;
    const koed = alice.waitFor(
      (m) => m.t === "snap" && m.events.some((e) => e.type === "ko" && e.victim === ALICE),
      { timeout: 15000, label: "a practice KO" },
    );
    for (let i = 0; i < 300; i++) {
      alice.send(inputMsg({ right: true }));
      await sleep(33);
      if (alice.received.some((m) => m.t === "snap" && m.events.some((e) => e.type === "ko" && e.victim === ALICE))) break;
    }
    await koed;
    await sleep(200);
    assert.equal(getBrawlStatsStmt.get(ALICE).falls, fallsBefore, "practice left the ledger alone");
  });
});

test("a second human clears the CPUs out", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });
    alice.send({ t: "cpu", count: 2 });
    await alice.waitFor((m) => m.t === "cpus", { label: "cpus" });
    await alice.waitFor((m) => m.t === "snap" && m.fighters.some((f) => f.cpu), { label: "cpus visible" });

    const bob = await connect(BOB);
    try {
      bob.send({ t: "join", character: "ketchup" });
      await bob.waitFor((m) => m.t === "joined", { label: "bob joined" });
      const cleared = await alice.waitFor(
        (m) => m.t === "snap" && m.fighters.filter((f) => f.cpu).length === 0,
        { label: "CPUs gone" },
      );
      assert.equal(cleared.fighters.filter((f) => f.cpu).length, 0);
    } finally {
      await bob.close();
    }
  });
});

test("CPUs are refused when the Arena is not yours alone", async () => {
  await withClients([ALICE, BOB], async (alice, bob) => {
    alice.send({ t: "join", character: "glizzy" });
    bob.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "alice joined" });
    await bob.waitFor((m) => m.t === "joined", { label: "bob joined" });

    alice.send({ t: "cpu", count: 1 });
    const denied = await alice.waitFor((m) => m.t === "denied", { label: "denied" });
    assert.equal(denied.reason, "cpu_not_alone");
  });
});

// -------------------------------------------------------------------- AFK

test("an idle Fighter fades out and any button brings them back", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });

    // BRAWL_TEST_MODE puts the AFK line at 2s. Say nothing and cross it.
    const gone = await alice.waitFor((m) => m.t === "despawned", { timeout: 8000, label: "afk despawn" });
    assert.equal(gone.reason, "afk");
    const empty = await alice.waitFor(
      (m) => m.t === "snap" && !m.fighters.some((f) => f.id === ALICE),
      { label: "gone from the Arena" },
    );
    assert.ok(empty);

    alice.send(inputMsg({ jump: true }));
    const back = await alice.waitFor((m) => m.t === "joined", { label: "rejoin" });
    assert.equal(back.fighterId, ALICE);
  });
});

// ---------------------------------------------------------- reconnect / cap

test("reconnecting drops you back into the fight with your record intact", async () => {
  const first = await connect(ALICE);
  first.send({ t: "join", character: "corndog" });
  const joined = await first.waitFor((m) => m.t === "joined", { label: "joined" });
  await first.close();
  await sleep(150);

  const second = await connect(ALICE);
  try {
    second.send({ t: "join", character: "corndog" });
    const rejoined = await second.waitFor((m) => m.t === "joined", { label: "rejoined" });
    assert.equal(rejoined.fighterId, ALICE);
    assert.ok(rejoined.stats.kos >= joined.stats.kos, "the record came back with them");

    const snap = await second.waitFor(
      (m) => m.t === "snap" && m.fighters.some((f) => f.id === ALICE),
      { label: "back in the Arena" },
    );
    assert.equal(snap.fighters.filter((f) => f.id === ALICE).length, 1, "exactly one body");
  } finally {
    await second.close();
    await sleep(120);
  }
});

test("the Day Tally is bucketed by Pacific day, the all-time board isn't", async () => {
  // A player whose last Arena day was yesterday: still on the all-time board,
  // absent from today's.
  const YESTERDAY = "300000000000000001";
  db.prepare(
    `INSERT OR REPLACE INTO brawl_stats (user_id, kos, falls, best_streak, day_key, day_kos, day_falls)
     VALUES (?, 9, 4, 3, ?, 7, 2)`,
  ).run(YESTERDAY, "1999-01-01");

  const board = await scoreboard();
  assert.ok(board.allTime.some((r) => r.userId === YESTERDAY), "yesterday's KOs are still all-time KOs");
  assert.ok(!board.today.some((r) => r.userId === YESTERDAY), "but they are not today's Day Tally");
});

test("only people who have actually fought appear on the all-time board", async () => {
  const LURKER = "300000000000000002";
  await withClients([LURKER], async (lurker) => {
    lurker.send({ t: "join", character: "glizzy" });
    await lurker.waitFor((m) => m.t === "joined", { label: "joined" });
  });
  const board = await scoreboard();
  assert.ok(!board.allTime.some((r) => r.userId === LURKER), "walking in doesn't put you on the board");
});

test("the CPU cap is a cap", async () => {
  await withClients([ALICE], async (alice) => {
    alice.send({ t: "join", character: "glizzy" });
    await alice.waitFor((m) => m.t === "joined", { label: "joined" });

    alice.send({ t: "cpu", count: 99 });
    const spawned = await alice.waitFor((m) => m.t === "cpus", { label: "cpus" });
    assert.equal(spawned.count, MAX_CPUS);

    alice.send({ t: "cpu", count: 1 });
    const denied = await alice.waitFor((m) => m.t === "denied", { label: "denied" });
    assert.equal(denied.reason, "cpu_limit");

    const snap = await alice.waitFor((m) => m.t === "snap", { label: "snapshot" });
    assert.ok(snap.fighters.filter((f) => f.cpu).length <= MAX_CPUS);
  });
});

test("a full Arena turns the next arrival into a spectator", async () => {
  const ids = Array.from({ length: MAX_FIGHTERS }, (_, i) => `20000000000000${String(i).padStart(4, "0")}`);
  const clients = [];
  try {
    for (const id of ids) {
      const c = await connect(id);
      clients.push(c);
      c.send({ t: "join", character: "glizzy" });
      await c.waitFor((m) => m.t === "joined", { label: `join ${id}` });
      // Keep them from AFK-fading out from under the test.
      c.send(inputMsg({ jump: true }));
    }

    const latecomer = await connect("29999999999999999");
    clients.push(latecomer);
    latecomer.send({ t: "join", character: "glizzy" });
    const denied = await latecomer.waitFor((m) => m.t === "denied", { label: "denied" });
    assert.equal(denied.reason, "full");
    assert.equal(denied.cap, MAX_FIGHTERS);

    const snap = await latecomer.waitFor((m) => m.t === "snap", { label: "still watching" });
    assert.ok(snap.fighters.length >= 1, "the spectator still sees the fight");

    // Their place in the line is made clear...
    const place = await latecomer.waitFor((m) => m.t === "waiting", { label: "queue place" });
    assert.equal(place.place, 1);
    assert.equal(place.waiting, 1);

    // ...and when a slot frees up, they are in it without asking again.
    await clients[0].close();
    const joined = await latecomer.waitFor((m) => m.t === "joined", { timeout: 6000, label: "promoted" });
    assert.equal(joined.fighterId, "29999999999999999");
  } finally {
    for (const c of clients) await c.close();
    await sleep(150);
  }
});
