/**
 * smtp-demo.ts  (run: `npx tsx demos/smtp-demo.ts` from packages/core, or `npm run demo:smtp`)
 *
 * The SMTP soundness demo. SMTP reuses ONE coarse success code (250) across EHLO, MAIL FROM,
 * RCPT TO, and message-accept. With a status-only abstraction the inference engine over-merges the
 * distinct states those 250s lead to, and the planner (Driver.nextCommand) could then pick a command
 * too early, e.g. send the MESSAGE before RCPT TO / before DATA. This was harmless when the driver
 * only VALIDATED sequences; it is a real bug now that it CHOOSES them.
 *
 * This demo records a tiny in-process SMTP-like server through a custom abstraction (response type
 * is just the numeric code, so 250 collides across verbs), then shows:
 *   - under responseNamespace 'none' the compile is FLAGGED unsafe (requiresFinerAbstraction true),
 *     with an ambiguous state that exposes MESSAGE too early, and
 *   - under responseNamespace 'auto' the states stay distinct, the gate passes, and the driver
 *     drives EHLO -> MAIL_FROM -> RCPT_TO -> DATA -> MESSAGE in the correct order with 0 model calls
 *     and NEVER selects MESSAGE before DATA.
 *
 *   GREETING --EHLO/250--> READY --MAIL_FROM/250--> MAIL --RCPT_TO/250--> RCPT
 *            (RCPT loops on more RCPT_TO/250) --DATA/354--> DATA_OK --MESSAGE/250--> SENT --QUIT/221--> DONE
 *
 * DATA before any RCPT TO yields 554 ("no valid recipients") and does NOT advance: that disjoint
 * outcome is what keeps MAIL and RCPT distinct under the AUTO abstraction, so RCPT_TO is a required
 * step the planner cannot skip.
 */

import {
  infer,
  compile,
  resolveAbstraction,
  Driver,
  type AbstractStepFn,
  type Session,
} from "../dist/index.js";

/* ------------------------------------------------------------------ */
/* A tiny in-process SMTP-like server (the black box).                 */
/* Codes: 250 OK (reused across EHLO/MAIL_FROM/RCPT_TO/MESSAGE!),       */
/*        354 start-data, 554 no-recipients, 550 reject, 221 bye.      */
/* ------------------------------------------------------------------ */

class SmtpServer {
  private state: "GREETING" | "READY" | "MAIL" | "RCPT" | "DATA" | "SENT" | "DONE" = "GREETING";
  /** Recipients the server rejects with 550 (to exercise an error response). */
  constructor(private readonly rejectRecipients: Set<string> = new Set()) {}

  send(line: string): string {
    const parts = line.trim().split(/\s+/);
    const verb = (parts[0] ?? "").toUpperCase();
    const arg = parts.slice(1).join(" ");
    switch (this.state) {
      case "GREETING":
        if (verb === "EHLO") return ((this.state = "READY"), "250 OK greeting");
        return "503 bad sequence";
      case "READY":
        if (verb === "MAIL_FROM") return ((this.state = "MAIL"), "250 OK sender");
        return "503 bad sequence";
      case "MAIL":
        if (verb === "RCPT_TO") {
          if (this.rejectRecipients.has(arg)) return "550 no such user";
          return ((this.state = "RCPT"), "250 OK recipient");
        }
        if (verb === "DATA") return "554 no valid recipients"; // disjoint: DATA needs a recipient
        return "503 bad sequence";
      case "RCPT":
        if (verb === "RCPT_TO") {
          // The recipient loop: more RCPT_TO stays in RCPT (a self-loop) on success.
          if (this.rejectRecipients.has(arg)) return "550 no such user";
          return "250 OK recipient";
        }
        if (verb === "DATA") return ((this.state = "DATA"), "354 start mail input");
        return "503 bad sequence";
      case "DATA":
        if (verb === "MESSAGE") return ((this.state = "SENT"), "250 OK message accepted");
        return "503 bad sequence";
      case "SENT":
        if (verb === "QUIT") return ((this.state = "DONE"), "221 bye");
        return "503 bad sequence";
      case "DONE":
        return "503 bad sequence";
    }
  }
}

/* ------------------------------------------------------------------ */
/* SMTP abstraction: response type is JUST the numeric code (250/354/  */
/* 550/554/221). This deliberately reuses 250 across EHLO/MAIL_FROM/   */
/* RCPT_TO/MESSAGE, so the coarse abstraction over-merges those states.*/
/* ------------------------------------------------------------------ */

const smtpAbstract: AbstractStepFn = (step) => {
  const verb = (step.verb.trim().split(/\s+/)[0] ?? "").toUpperCase();
  const code = step.response.trim().split(/\s+/)[0] ?? ""; // 250 | 354 | 550 | 554 | 221 | 503
  return { symbol: `${verb}/${code}`, verb, responseType: code };
};

/** Record one scripted SMTP session against a fresh server. */
function recordSmtp(script: string[], rejectRecipients: string[] = []): Session {
  const server = new SmtpServer(new Set(rejectRecipients));
  const steps = script.map((line) => ({ verb: line, response: server.send(line) }));
  return { steps, outcome: "success" as const };
}

/** The training corpus: full deliveries, the RCPT recipient loop, a 550 error probe, and the
 * disjoint DATA-before-RCPT (554) probe that keeps MAIL and RCPT distinct. */
function smtpCorpus(): { train: Session[]; heldOut: Session[] } {
  const train: Session[] = [
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO alice", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO bob", "DATA", "MESSAGE", "QUIT"]),
    // Recipient loop: two RCPT_TO before DATA (RCPT self-loop on the second).
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO carol", "RCPT_TO dave", "DATA", "MESSAGE", "QUIT"]),
    // Error probe: RCPT_TO to a rejected recipient yields 550 (a self-loop in MAIL, no progress).
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO nobody", "RCPT_TO heidi", "DATA", "MESSAGE", "QUIT"], ["nobody"]),
    // Disjoint probe: DATA before any RCPT_TO yields 554 (no recipients), then recover.
    recordSmtp(["EHLO", "MAIL_FROM", "DATA", "RCPT_TO frank", "DATA", "MESSAGE", "QUIT"]),
  ];
  const heldOut: Session[] = [
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO ivan", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO judy", "RCPT_TO ken", "DATA", "MESSAGE", "QUIT"]),
  ];
  return { train, heldOut };
}

/** Find the state reached by the SENT-producing MESSAGE transition (the goal), by verb. */
function findSentState(driver: Driver): string | undefined {
  const t = driver.transitions.find((tr) => (tr.verb ?? "") === "MESSAGE");
  return t?.to;
}

function main(): void {
  const { train, heldOut } = smtpCorpus();

  /* -------- (A) Coarse abstraction: responseNamespace 'none'. -------- */
  const modelNone = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
  const compNone = compile(modelNone, {
    coverageGate: 0.9,
    heldOut,
    abstract: smtpAbstract,
    responseNamespace: "none",
    sessions: train, // give the gate the corpus so it can compare to the finer abstraction
  });

  /* -------- (B) Auto-namespaced abstraction: responseNamespace 'auto'. -------- */
  const modelAuto = infer(train, { abstract: smtpAbstract, responseNamespace: "auto" });
  const compAuto = compile(modelAuto, {
    coverageGate: 0.9,
    heldOut,
    abstract: smtpAbstract,
    responseNamespace: "auto",
    sessions: train,
  });

  /* -------- Drive the AUTO model: the driver CHOOSES the command order. -------- */
  const driver = compAuto.driver;
  // The drive loop MUST abstract live responses with the SAME (auto-resolved) abstraction the model
  // was inferred with, or namespaced symbols would not line up and the driver would escalate.
  const autoAbstract = resolveAbstraction(train, "auto", smtpAbstract);
  const sentState = findSentState(driver);
  const chosen: string[] = [];
  const modelCalls = 0; // never incremented: the driver is pure code
  let messageBeforeData = false;
  let sawData = false;

  if (sentState) {
    const server = new SmtpServer();
    driver.start();
    let guard = 0;
    for (;;) {
      if (guard++ > 50) throw new Error("loop did not terminate");
      const n = driver.nextCommand(sentState);
      if ("done" in n) break;
      if ("escalate" in n) throw new Error("unexpected escalation: " + n.reason);
      if (n.command === "DATA") sawData = true;
      if (n.command === "MESSAGE" && !sawData) messageBeforeData = true;
      chosen.push(n.command);
      const raw = server.send(n.command + (n.command === "RCPT_TO" ? " auto-rcpt" : ""));
      const sym = autoAbstract({ verb: n.command, response: raw }).symbol;
      const r = driver.step(sym);
      if (!r.deterministic) throw new Error("driver escalated mid-run: " + r.reason);
    }
  }

  const order = chosen.join(" -> ");
  const correctOrder =
    JSON.stringify(chosen) === JSON.stringify(["EHLO", "MAIL_FROM", "RCPT_TO", "DATA", "MESSAGE"]);

  /* -------- Defense in depth: ask the COARSE 'none' driver to plan toward SENT. The planner must
   * REFUSE rather than silently send MESSAGE too early. -------- */
  const noneDriver = compNone.driver;
  const noneSent = findSentState(noneDriver);
  let coarsePlan = "(no SENT state)";
  if (noneSent) {
    const n = noneDriver.nextCommand(noneSent, noneDriver.initial);
    coarsePlan =
      "command" in n
        ? `picked ${n.command} (UNSOUND: chose without the safety gate)`
        : "done" in n
        ? "done"
        : `escalate reason=${n.reason}${n.verbs ? " verbs=[" + n.verbs.join(", ") + "]" : ""}`;
  }

  /* -------- Summary. -------- */
  console.log("=== smtp-demo ===");
  console.log("");
  console.log("State counts (inferred):");
  console.log(`  responseNamespace 'none' : ${modelNone.states.length} states`);
  console.log(`  responseNamespace 'auto' : ${modelAuto.states.length} states`);
  console.log("");
  console.log("Forward-ambiguity gate verdict:");
  console.log(
    `  'none' : passed=${compNone.report.passed} requiresFinerAbstraction=${compNone.report.requiresFinerAbstraction} ` +
      `ambiguousStates=${(compNone.report.ambiguousStates ?? []).length}`
  );
  for (const a of compNone.report.ambiguousStates ?? [])
    console.log(`           - state ${a.state}: verbs [${a.verbs.join(", ")}]  ${a.note}`);
  console.log(
    `  'auto' : passed=${compAuto.report.passed} requiresFinerAbstraction=${compAuto.report.requiresFinerAbstraction} ` +
      `ambiguousStates=${(compAuto.report.ambiguousStates ?? []).length}`
  );
  console.log("");
  console.log("Defense in depth (coarse 'none' planner toward SENT):");
  console.log(`  ${coarsePlan}`);
  console.log("");
  console.log("Driver-selected command order (auto model, 0 model calls):");
  console.log(`  ${order}`);
  console.log(`  modelCalls           : ${modelCalls}`);
  console.log(`  reached SENT (goal)  : ${sentState !== undefined && driver.state() === sentState}`);
  console.log(`  order is correct     : ${correctOrder}`);
  console.log(`  MESSAGE before DATA  : ${messageBeforeData}  (confirmed NEVER selected before DATA: ${!messageBeforeData})`);
  console.log("");

  const ok =
    compNone.report.requiresFinerAbstraction === true &&
    compNone.report.passed === false &&
    (compNone.report.ambiguousStates ?? []).some((a) => a.verbs.includes("MESSAGE")) &&
    compAuto.report.requiresFinerAbstraction === false &&
    compAuto.report.passed === true &&
    modelAuto.states.length > modelNone.states.length &&
    correctOrder &&
    messageBeforeData === false &&
    modelCalls === 0;

  console.log(ok ? "smtp-demo: PASS" : "smtp-demo: FAIL");
  if (!ok) process.exitCode = 1;
}

main();
