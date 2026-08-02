// Shutdown must not wait on a client that stopped talking.
//
// The Arena is a leave-the-tab-open feature, so at deploy time there is
// usually at least one client that will never ack a WebSocket close
// handshake (backgrounded phone, suspended tab). `stopBrawl()` has to
// sever those sockets outright — `ws.close()` starts a handshake and waits
// up to 30s for a reply, which holds `server.close()` open past Railway's
// draining window and turns every deploy into a SIGKILL.
//
// Own file, own server: this is the one test that tears the server down.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Must be set before database.js is imported — it opens the file at import time.
const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brawl-shutdown-test-")), "test.db");
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_PASSWORD = "brawl-test-secret";
process.env.GAME_SESSION_SECRET = "brawl-test-secret";
process.env.BRAWL_TEST_MODE = "1";

const express = (await import("express")).default;
const { WebSocket } = await import("ws");
const { registerBrawl, attachBrawl, stopBrawl } = await import("../brawl.js");
const { mintSessionCookie } = await import("../oauth.js");
const { db, insertHotdogEventStmt } = await import("../database.js");

const ALICE = "100000000000000001";

test("shutdown completes fast with a client that never acks the close", async () => {
  insertHotdogEventStmt.run(ALICE, "alice", 12);

  const app = express();
  registerBrawl(app);
  const server = http.createServer(app);
  attachBrawl(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/brawl/ws`, {
    headers: { Cookie: mintSessionCookie(ALICE) },
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  // Zombie: the socket stops reading, so a close frame is never seen or acked.
  ws._socket.pause();

  const t0 = Date.now();
  stopBrawl();
  const closed = await Promise.race([
    new Promise((resolve) => server.close(() => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  const elapsed = Date.now() - t0;

  // Un-zombie so a failing run still drains its handles and the runner exits.
  ws.terminate();

  assert.ok(closed, `server.close() still pending after ${elapsed}ms with a silent client`);
  assert.ok(elapsed < 2000, `shutdown took ${elapsed}ms; must beat the deploy draining window`);

  db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});
