/**
 * smtp-real-demo.ts  (run: `npx tsx demos/smtp-real-demo.ts` from packages/core)
 *
 * THE REAL-PROTOCOL PROOF. Not a hand-written FSM: this stands up an actual RFC 5321 SMTP server
 * (Nodemailer's `smtp-server`), drives it over a real TCP socket with real SMTP wire commands to
 * record a handful of successful "send an email" sessions, then uses @wframe/core to:
 *   (a) infer the protocol state machine (with 'auto' response-namespacing, because real SMTP reuses
 *       the 250 code across EHLO / MAIL / RCPT / message-accept), compile it behind the coverage +
 *       forward-ambiguity safety gate, and
 *   (b) drive the COMPILED driver against a FRESH real SMTP connection to actually deliver an email,
 *       choosing the command order itself (nextCommand) with ZERO model calls, and escalating on the
 *       unseen.
 *
 * The recipient list is the variable-length loop (RCPT TO repeats); a couple of sessions try DATA
 * before any recipient (a real "503/554" rejection) and recover, which is what keeps the MAIL and
 * RCPT states distinct so the planner can never skip recipients.
 */

import net from "node:net";
import { SMTPServer } from "smtp-server";
import {
  infer,
  compile,
  resolveAbstraction,
  type AbstractStepFn,
  type Session,
  type Driver,
} from "../dist/index.js";

/* SMTP abstraction: verb = the command label, responseType = the 3-digit reply code. 250 is reused
 * across EHLO/MAIL/RCPT/BODY, so 'auto' namespacing is required to keep those states apart. */
const smtpAbstract: AbstractStepFn = (step) => {
  const verb = (step.verb.trim().split(/\s+/)[0] ?? "").toUpperCase();
  const code = (/\b(\d{3})\b/.exec(step.response)?.[1]) ?? "000";
  return { symbol: `${verb}/${code}`, verb, responseType: code };
};

/* ------------------------------------------------------------------ */
/* A raw SMTP client over a TCP socket (multiline-response aware).     */
/* ------------------------------------------------------------------ */
class SmtpClient {
  private socket!: net.Socket;
  private buffer = "";
  private pending: ((r: { code: number; text: string }) => void) | null = null;

  connect(port: number): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port, host: "127.0.0.1" });
      this.socket.setEncoding("utf8");
      this.socket.on("data", (chunk: string) => { this.buffer += chunk; this.drain(); });
      this.socket.on("error", reject);
      this.pending = resolve; // first response is the 220 greeting
    });
  }

  private drain(): void {
    if (!this.pending) return;
    const lines = this.buffer.split("\r\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const consumed = lines.slice(0, i + 1).join("\r\n").length + 2;
        this.buffer = this.buffer.slice(consumed);
        const code = parseInt(lines[i].slice(0, 3), 10);
        const resolve = this.pending; this.pending = null;
        resolve({ code, text: lines[i].slice(4).trim() });
        return;
      }
    }
  }

  private read(): Promise<{ code: number; text: string }> {
    return new Promise((resolve) => { this.pending = resolve; this.drain(); });
  }

  cmd(line: string): Promise<{ code: number; text: string }> {
    this.socket.write(line + "\r\n");
    return this.read();
  }

  /** After DATA (354), send the message body terminated by the lone dot. */
  dataBody(body: string): Promise<{ code: number; text: string }> {
    this.socket.write(body + "\r\n.\r\n");
    return this.read();
  }

  end(): void { try { this.socket.destroy(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* The real SMTP server (black box).                                   */
/* ------------------------------------------------------------------ */
function startServer(): Promise<{ server: SMTPServer; port: number }> {
  return new Promise((resolve) => {
    const server = new SMTPServer({
      secure: false,
      authOptional: true,
      disabledCommands: ["AUTH", "STARTTLS"],
      onConnect: (_s, cb) => cb(),
      onMailFrom: (_a, _s, cb) => cb(),
      onRcptTo: (_a, _s, cb) => cb(),
      onData: (stream, _s, cb) => { stream.on("data", () => {}); stream.on("end", () => cb()); },
      logger: false,
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

/* Map a learned verb label to a real SMTP wire command (BODY is handled specially). */
async function doAction(client: SmtpClient, verb: string, rcptIdx: number): Promise<{ code: number; text: string }> {
  switch (verb) {
    case "EHLO": return client.cmd("EHLO wframe.test");
    case "MAIL": return client.cmd("MAIL FROM:<sender@wframe.test>");
    case "RCPT": return client.cmd(`RCPT TO:<rcpt${rcptIdx}@wframe.test>`);
    case "DATA": return client.cmd("DATA");
    case "BODY": return client.dataBody("Subject: hello\r\nLearned by Wireframe.");
    case "QUIT": return client.cmd("QUIT");
    default: throw new Error("unknown verb " + verb);
  }
}

/** Drive one real SMTP session following a plan of verb labels; record (verb, response) per step. */
async function recordSession(port: number, plan: string[]): Promise<Session> {
  const client = new SmtpClient();
  await client.connect(port); // consume the 220 greeting (not a recorded step)
  const steps: { verb: string; response: string }[] = [];
  let rcptIdx = 0;
  for (const verb of plan) {
    const idx = verb === "RCPT" ? rcptIdx++ : 0;
    const r = await doAction(client, verb, idx);
    steps.push({ verb, response: `${r.code} ${r.text}` });
  }
  client.end();
  return { steps, outcome: "success" };
}

function findGoal(driver: Driver): string {
  const t = driver.transitions.find((tr) => (tr.verb ?? "") === "BODY");
  if (!t) throw new Error("no BODY transition learned");
  return t.to;
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => { console.error("WATCHDOG: hung, exiting"); process.exit(3); }, 18000);
  const { server, port } = await startServer();
  console.log(`Real SMTP server (Nodemailer smtp-server) listening on 127.0.0.1:${port}`);
  console.log("─".repeat(74));

  /* (a) RECORD natural sessions over the real socket: varying recipient counts (the loop) plus a
   * couple of "DATA too early" rejections that recover (the disjoint probe). */
  const plans: string[][] = [
    ["EHLO", "MAIL", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "RCPT", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "DATA", "RCPT", "DATA", "BODY", "QUIT"], // DATA-before-RCPT rejection + recover
    ["EHLO", "MAIL", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "RCPT", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "DATA", "RCPT", "RCPT", "DATA", "BODY", "QUIT"], // disjoint probe, 2 recipients
    ["EHLO", "MAIL", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "BODY", "QUIT"],
    ["EHLO", "MAIL", "RCPT", "DATA", "BODY", "QUIT"],
  ];
  const all: Session[] = [];
  for (const plan of plans) all.push(await recordSession(port, plan));
  const heldOut = [all[2], all[10]]; // a 3-recipient and a 2-recipient send
  const train = all.filter((s) => s !== heldOut[0] && s !== heldOut[1]);

  console.log(`Recorded ${all.length} real SMTP sessions (${train.length} train / ${heldOut.length} held out).`);
  console.log("  sample session 1:", train[0].steps.map((s) => `${s.verb.split(" ")[0]}→${s.response.split(" ")[0]}`).join("  "));
  const disjoint = all[5].steps.map((s) => `${s.verb}→${s.response.split(" ")[0]}`).join("  ");
  console.log("  DATA-too-early probe:", disjoint);
  console.log("─".repeat(74));

  /* (b) INFER + COMPILE with the safety gate. 250 collides across verbs -> 'auto' namespacing. */
  const model = infer(train, { abstract: smtpAbstract, responseNamespace: "auto" });
  const { driver, report } = compile(model, {
    coverageGate: 0.9,
    heldOut,
    abstract: smtpAbstract,
    responseNamespace: "auto",
    sessions: train,
  });
  console.log("Learned protocol FSM:");
  console.log(`  states=${model.states.length}  transitions=${model.transitions.length}`);
  console.log(`  coverage=${report.coverage}  unsafeContinuationRate=${report.unsafeContinuationRate}  ` +
    `requiresFinerAbstraction=${report.requiresFinerAbstraction}  GATE PASSED=${report.passed}`);
  const rcptLoop = driver.transitions.some((t) => t.from === t.to && (t.verb ?? "") === "RCPT");
  console.log(`  RCPT self-loop folded (recipient loop): ${rcptLoop}`);
  console.log("─".repeat(74));

  /* (c) DRIVE the compiled driver to SEND A REAL EMAIL, choosing the order itself, 0 model calls. */
  const autoAbstract = resolveAbstraction(train, "auto", smtpAbstract);
  const goal = findGoal(driver);
  const client = new SmtpClient();
  await client.connect(port);
  driver.start();
  const wantRecipients = 2;
  let rcptSent = 0;
  const chosen: string[] = [];
  const modelCalls = 0;
  let escalatedMidRun = false;
  for (let guard = 0; guard < 60; guard++) {
    if ("done" in driver.nextCommand(goal)) break;
    const st = driver.state();
    const rcptSelfLoop = [...driver.legalFrom(st)].some((s) => s.split("/")[0] === "RCPT" && driver.stepFrom(st, s).to === st);
    let verb: string;
    if (rcptSent < wantRecipients && rcptSelfLoop) {
      verb = "RCPT";
    } else {
      const n = driver.nextCommand(goal);
      if ("escalate" in n) { console.log(`  driver escalated: ${n.reason}`); escalatedMidRun = true; break; }
      if ("done" in n) break;
      verb = n.command;
    }
    const r = await doAction(client, verb, rcptSent);
    if (verb === "RCPT") rcptSent++;
    const stepRes = driver.step(autoAbstract({ verb, response: `${r.code} ${r.text}` }).symbol);
    chosen.push(`${verb}(${r.code})`);
    if (stepRes.escalate) { console.log(`  driver escalated on response: ${stepRes.reason}`); escalatedMidRun = true; break; }
  }
  const reachedGoal = driver.state() === goal;
  await client.cmd("QUIT").catch(() => ({ code: 0, text: "" }));
  client.end();

  console.log("Drove the COMPILED driver against a fresh real SMTP connection:");
  console.log(`  command order chosen by the driver: ${chosen.join(" → ")}`);
  console.log(`  recipients delivered: ${rcptSent}   reached 'message accepted' goal: ${reachedGoal}`);
  console.log(`  >>> MODEL CALLS USED: ${modelCalls}  (escalated mid-run: ${escalatedMidRun})`);
  console.log("─".repeat(74));

  /* (d) ESCALATE on the unseen: ask the driver to reach a state it never learned. */
  const escDriver = driver;
  escDriver.start();
  const esc = escDriver.nextCommand("STATE_NEVER_LEARNED");
  console.log(`Unseen goal -> escalate: ${"escalate" in esc ? `yes (reason=${esc.reason})` : "NO (bug)"}`);
  console.log("─".repeat(74));

  const ok = report.passed && report.coverage === 1 && report.unsafeContinuationRate === 0 &&
    rcptLoop && reachedGoal && rcptSent === wantRecipients && !escalatedMidRun && "escalate" in esc;
  console.log(ok ? "smtp-real-demo: PASS — learned a real SMTP server and drove it deterministically."
    : "smtp-real-demo: FAIL");
  clearTimeout(watchdog);
  server.close();
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
