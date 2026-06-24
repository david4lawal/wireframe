/**
 * postgres-real-demo.ts  (run: `npx tsx demos/postgres-real-demo.ts` from packages/core)
 *
 * THE POSTGRES WIRE-PROTOCOL PROOF. A REAL Postgres engine (PGlite — Postgres compiled to WASM, no
 * Docker, no external server) speaks the REAL binary wire protocol through pg-gateway on a TCP
 * socket; the real `pg` client (node-postgres) generates real wire traffic. Wireframe taps the wire
 * inside the gateway, records the binary message exchanges, and @wframe/core:
 *   (a) infers the protocol's TRANSACTION state machine — idle vs in-transaction — from the one-byte
 *       ReadyForQuery status the server returns after each statement (correctly handling the aborted
 *       status E, where a failed statement keeps the connection IN the transaction until ROLLBACK),
 *       and compiles it behind the coverage + safety gate, then
 *   (b) shows the compiled driver accepts a real valid transaction trace and REJECTS an impossible
 *       one (a failed-state symbol straight from idle, which the protocol never produces).
 *
 * The state the FSM recovers (idle vs in-transaction) is invisible in any single message; it lives in
 * the ReadyForQuery status byte across the session. The disjoint signal that separates the states is
 * that the SAME command behaves differently by state: SELECT returns idle(I) outside a transaction
 * but in-transaction(T) inside one.
 */

import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { fromNodeSocket } from "pg-gateway/node";
import pg from "pg";
import {
  infer,
  compile,
  Driver,
  type AbstractStepFn,
  type Session,
} from "../dist/index.js";

const CLIENT: Record<string, string> = { Q: "QUERY", P: "PARSE", B: "BIND", D: "DESCRIBE", E: "EXECUTE", S: "SYNC", X: "TERMINATE", C: "CLOSE", H: "FLUSH" };
const SERVER: Record<string, string> = {
  "1": "PARSE_OK", "2": "BIND_OK", "3": "CLOSE_OK", C: "CMD_DONE", D: "ROW", E: "ERROR",
  I: "EMPTY", n: "NODATA", T: "ROWDESC", t: "PARAMDESC", Z: "READY", s: "SUSPENDED", G: "COPYIN", H: "COPYOUT",
};

function u32(buf: Uint8Array, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/** Walk concatenated [type:1][len:4][payload] messages; return [{type, statusByte?}]. */
function parseMessages(buf: Uint8Array): { type: string; status?: string }[] {
  const out: { type: string; status?: string }[] = [];
  let off = 0;
  while (off + 5 <= buf.length) {
    const type = String.fromCharCode(buf[off]);
    const len = u32(buf, off + 1);
    if (len < 4 || off + 1 + len > buf.length) break;
    const msg: { type: string; status?: string } = { type };
    if (type === "Z") msg.status = String.fromCharCode(buf[off + 5]); // I / T / E
    out.push(msg);
    off += 1 + len;
  }
  return out;
}

/** Driver-visible response summary of one exchange: the ReadyForQuery status if present
 * (READY_I / READY_T / READY_E — the transaction state), else the first notable server message. */
function summarize(resp: Uint8Array): string {
  const msgs = parseMessages(resp);
  const z = msgs.find((m) => m.type === "Z");
  if (z) return `READY_${z.status}`;
  for (const m of msgs) if (SERVER[m.type] && m.type !== "S" && m.type !== "K") return SERVER[m.type];
  return msgs.length ? (SERVER[msgs[0].type] ?? msgs[0].type) : "NONE";
}

/** Abstract a Query message to its SQL command keyword (BEGIN / SELECT / INSERT / COMMIT ...),
 * stripping tables and values — the same parameter-stripping the abstraction does elsewhere. */
function verbOfMessage(data: Uint8Array): string {
  const type = String.fromCharCode(data[0]);
  if (type !== "Q") return CLIENT[type] ?? `?${type}`;
  const text = new TextDecoder().decode(data.subarray(5));
  const kw = text.split(/[\s\x00]+/).filter(Boolean)[0];
  return (kw ?? "QUERY").toUpperCase();
}

const pgAbstract: AbstractStepFn = (step) => ({ symbol: `${step.verb}/${step.response}`, verb: step.verb, responseType: step.response });

let recording: { verb: string; response: string }[] | null = null;

async function startServer(db: PGlite): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer(async (socket) => {
    await fromNodeSocket(socket, {
      serverVersion: "16.0",
      auth: { method: "trust" },
      async onMessage(data: Uint8Array, state: { isAuthenticated?: boolean }) {
        if (!state?.isAuthenticated) return; // skip startup/auth handshake
        const res = await (db as PGlite & { execProtocolRaw(d: Uint8Array): Promise<Uint8Array> }).execProtocolRaw(data);
        const verb = verbOfMessage(data);
        if (recording && verb !== "TERMINATE" && verb !== "FLUSH" && verb !== "SYNC") {
          recording.push({ verb, response: summarize(res) });
        }
        return res;
      },
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function recordSession(port: number, queries: string[]): Promise<Session> {
  recording = [];
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres", ssl: false });
  await client.connect();
  for (const q of queries) {
    try { await client.query(q); } catch { /* a failed statement leaves the tx failed; ROLLBACK recovers */ }
  }
  await client.end();
  const steps = recording!;
  recording = null;
  return { steps, outcome: "success" };
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => { console.error("WATCHDOG: hung"); process.exit(3); }, 30000);
  const db = new PGlite();
  await db.waitReady;
  const { server, port } = await startServer(db);
  console.log(`Real Postgres (PGlite/WASM) over the real wire protocol on 127.0.0.1:${port}`);
  console.log("-".repeat(74));

  { const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" }); await c.connect(); await c.query("CREATE TABLE t(id int)"); await c.end(); }

  const workflows: string[][] = [
    ["SELECT 1"],
    ["SELECT 1", "SELECT 2"],
    ["BEGIN", "INSERT INTO t VALUES(1)", "COMMIT"],
    ["BEGIN", "INSERT INTO t VALUES(2)", "INSERT INTO t VALUES(3)", "COMMIT"],
    ["BEGIN", "SELECT * FROM t", "COMMIT"],
    ["BEGIN", "INSERT INTO t VALUES(4)", "ROLLBACK"],
    ["BEGIN", "SELECT nonexistent_col FROM t", "ROLLBACK"],
    ["SELECT count(*) FROM t"],
    ["BEGIN", "UPDATE t SET id = id", "COMMIT"],
    ["BEGIN", "INSERT INTO t VALUES(5)", "INSERT INTO t VALUES(6)", "INSERT INTO t VALUES(7)", "COMMIT"],
    ["BEGIN", "SELECT bad1 FROM t", "SELECT bad2 FROM t", "ROLLBACK"],
    ["BEGIN", "INSERT INTO t VALUES(8)", "COMMIT"],
    ["SELECT 1", "BEGIN", "INSERT INTO t VALUES(9)", "COMMIT", "SELECT 1"],
    ["SELECT 42"],
    ["BEGIN", "INSERT INTO t VALUES(20)", "ROLLBACK", "SELECT 1"],
    ["BEGIN", "INSERT INTO t VALUES(21)", "ROLLBACK", "BEGIN", "INSERT INTO t VALUES(22)", "COMMIT"],
  ];
  const all: Session[] = [];
  for (const w of workflows) all.push(await recordSession(port, w));
  const heldOut = [all[3], all[10]];
  const train = all.filter((s) => s !== heldOut[0] && s !== heldOut[1]);

  console.log(`Recorded ${all.length} real wire-protocol sessions (${train.length} train / ${heldOut.length} held out).`);
  console.log("  tx + error session :", all[6].steps.map((s) => `${s.verb}/${s.response}`).join("  "));
  console.log("  failed self-loop   :", all[10].steps.map((s) => `${s.verb}/${s.response}`).join("  "));
  console.log("-".repeat(74));

  let policy: "none" | "auto" = "none";
  let model = infer(train, { abstract: pgAbstract, responseNamespace: policy });
  let comp = compile(model, { coverageGate: 0.9, heldOut, abstract: pgAbstract, responseNamespace: policy, sessions: train });
  if (comp.report.requiresFinerAbstraction) {
    policy = "auto";
    model = infer(train, { abstract: pgAbstract, responseNamespace: policy });
    comp = compile(model, { coverageGate: 0.9, heldOut, abstract: pgAbstract, responseNamespace: policy, sessions: train });
  }
  const { driver, report } = comp;

  console.log(`Learned Postgres transaction state machine (responseNamespace=${policy}):`);
  console.log(`  states=${model.states.length}  transitions=${model.transitions.length}`);
  console.log(`  coverage=${report.coverage}  unsafeContinuationRate=${report.unsafeContinuationRate}  GATE PASSED=${report.passed}`);
  for (const t of driver.transitions) console.log(`     ${t.from} --${t.on}--> ${t.to}${t.from === t.to ? "   (self-loop)" : ""}`);
  const sawI = driver.transitions.some((t) => t.on.endsWith("READY_I"));
  const sawT = driver.transitions.some((t) => t.on.endsWith("READY_T"));
  const sawE = driver.transitions.some((t) => t.on.endsWith("READY_E"));
  console.log(`  discovered idle(I)=${sawI}  in-transaction(T)=${sawT}  failed(E)=${sawE}  distinct states>1: ${model.states.length > 1}`);
  console.log("-".repeat(74));

  const valid = all[3].steps.map((s) => pgAbstract({ verb: s.verb, response: s.response }).symbol);
  const okValid = Driver.fromJSON(driver.toJSON()).run(valid).accepted;
  const impossible = ["SELECT/READY_E"]; // a failed-tx status straight from idle: never produced
  const rejected = !Driver.fromJSON(driver.toJSON()).run(impossible).accepted;
  console.log("Deterministic conformance check (0 model calls):");
  console.log(`  accepts a real valid transaction trace [${valid.join(", ")}]: ${okValid}`);
  console.log(`  rejects an impossible 'fail-from-idle' trace [${impossible.join(", ")}]: ${rejected}`);
  console.log("-".repeat(74));

  const ok = report.passed && report.coverage === 1 && report.unsafeContinuationRate === 0 &&
    model.states.length > 1 && sawI && sawT && sawE && okValid && rejected;
  console.log(ok ? "postgres-real-demo: PASS — learned the real Postgres wire transaction protocol." : "postgres-real-demo: FAIL");
  clearTimeout(watchdog);
  await db.close().catch(() => {});
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
