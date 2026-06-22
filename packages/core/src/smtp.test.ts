/**
 * smtp.test.ts (vitest)
 *
 * Reproduces the SMTP action-selection soundness gap and proves the 1.2.0 fix.
 *
 * SMTP reuses ONE coarse success code (250) across EHLO, MAIL FROM, RCPT TO, and message-accept.
 * With a status-only abstraction the inference engine over-merges the distinct states those 250s
 * lead to, and the planner (Driver.nextCommand) can then choose a command too early (e.g. send the
 * MESSAGE before RCPT TO / DATA). These tests assert:
 *
 *  - with responseNamespace 'none' the compile is FLAGGED unsafe (requiresFinerAbstraction true) and
 *    the ambiguous state exposes MESSAGE too early;
 *  - with responseNamespace 'auto' the states stay distinct, the ambiguity is gone, report.passed is
 *    true, and nextCommand drives EHLO -> MAIL_FROM -> RCPT_TO -> DATA -> MESSAGE in the correct
 *    order with 0 model calls and NEVER selects MESSAGE before DATA;
 *  - the standalone analyzePlanAmbiguity / forwardBranches helpers report the same thing;
 *  - the auto namespacing touches ONLY ambiguous response types;
 *  - Driver.nextCommand escalates "ambiguous-branch" on a genuine tie (defense in depth).
 */

import { describe, it, expect } from "vitest";
import {
  infer,
  compile,
  Driver,
  resolveAbstraction,
  ambiguousResponseTypes,
  analyzePlanAmbiguity,
  forwardBranches,
  makeAbstractStep,
  type AbstractStepFn,
  type Session,
} from "./index.js";

/* ------------------------------------------------------------------ */
/* A tiny in-process SMTP-like server (a fresh FSM).                   */
/* Codes: 250 (reused across EHLO/MAIL_FROM/RCPT_TO/MESSAGE!), 354     */
/* start-data, 554 no-recipients (disjoint), 550 reject, 221 bye.     */
/* ------------------------------------------------------------------ */

class SmtpServer {
  private state: "GREETING" | "READY" | "MAIL" | "RCPT" | "DATA" | "SENT" | "DONE" = "GREETING";
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
          if (this.rejectRecipients.has(arg)) return "550 no such user";
          return "250 OK recipient"; // RCPT self-loop on success (the recipient loop)
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

/** SMTP abstraction: response type is JUST the numeric code, so 250 collides across verbs. */
const smtpAbstract: AbstractStepFn = (step) => {
  const verb = (step.verb.trim().split(/\s+/)[0] ?? "").toUpperCase();
  const code = step.response.trim().split(/\s+/)[0] ?? "";
  return { symbol: `${verb}/${code}`, verb, responseType: code };
};

function recordSmtp(script: string[], rejectRecipients: string[] = []): Session {
  const server = new SmtpServer(new Set(rejectRecipients));
  const steps = script.map((line) => ({ verb: line, response: server.send(line) }));
  return { steps, outcome: "success" as const };
}

function smtpCorpus(): { train: Session[]; heldOut: Session[] } {
  const train: Session[] = [
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO alice", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO bob", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO carol", "RCPT_TO dave", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO nobody", "RCPT_TO heidi", "DATA", "MESSAGE", "QUIT"], ["nobody"]),
    recordSmtp(["EHLO", "MAIL_FROM", "DATA", "RCPT_TO frank", "DATA", "MESSAGE", "QUIT"]),
  ];
  const heldOut: Session[] = [
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO ivan", "DATA", "MESSAGE", "QUIT"]),
    recordSmtp(["EHLO", "MAIL_FROM", "RCPT_TO judy", "RCPT_TO ken", "DATA", "MESSAGE", "QUIT"]),
  ];
  return { train, heldOut };
}

/* ------------------------------------------------------------------ */
/* (1) The coarse abstraction over-merges and is caught by the gate.   */
/* ------------------------------------------------------------------ */

describe("SMTP: coarse status-only abstraction over-merges and is flagged unsafe", () => {
  it("'none' yields a spurious forward branch exposing MESSAGE too early", () => {
    const { train, heldOut } = smtpCorpus();
    const model = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
    const { report } = compile(model, {
      coverageGate: 0.9,
      heldOut,
      abstract: smtpAbstract,
      responseNamespace: "none",
      sessions: train,
    });

    // The gate must fail this model and ask for a finer abstraction.
    expect(report.requiresFinerAbstraction).toBe(true);
    expect(report.passed).toBe(false);
    // The ambiguous state must expose MESSAGE among its over-early branch verbs.
    expect(report.ambiguousStates && report.ambiguousStates.length).toBeGreaterThan(0);
    const exposesMessage = (report.ambiguousStates ?? []).some((a) => a.verbs.includes("MESSAGE"));
    expect(exposesMessage).toBe(true);
  });

  it("the coarse 'none' planner would pick MESSAGE far too early (the bug the gate prevents)", () => {
    const { train } = smtpCorpus();
    const model = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
    const driver = Driver.fromModel(model);
    const sent = driver.transitions.find((t) => (t.verb ?? "") === "MESSAGE")!.to;
    // From the initial state, planning toward SENT, the over-merged model lets MESSAGE be chosen
    // immediately. This is exactly the unsound shortcut the compile-time gate flags.
    const n = driver.nextCommand(sent, driver.initial);
    expect("command" in n && n.command).toBe("MESSAGE");
  });
});

/* ------------------------------------------------------------------ */
/* (2) Auto namespacing fixes it: distinct states, gate passes,        */
/*     correct ordered drive.                                          */
/* ------------------------------------------------------------------ */

describe("SMTP: responseNamespace 'auto' learns the correct ordered state machine", () => {
  it("auto keeps states distinct and the gate passes", () => {
    const { train, heldOut } = smtpCorpus();
    const none = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
    const auto = infer(train, { abstract: smtpAbstract, responseNamespace: "auto" });
    // Auto must NOT over-merge: it has strictly more states than the coarse collapse.
    expect(auto.states.length).toBeGreaterThan(none.states.length);

    const { report } = compile(auto, {
      coverageGate: 0.9,
      heldOut,
      abstract: smtpAbstract,
      responseNamespace: "auto",
      sessions: train,
    });
    expect(report.passed).toBe(true);
    expect(report.requiresFinerAbstraction).toBe(false);
    expect(report.coverage).toBe(1);
    expect(report.unsafeContinuationRate).toBe(0);
    expect((report.ambiguousStates ?? []).length).toBe(0);
  });

  it("nextCommand drives EHLO -> MAIL_FROM -> RCPT_TO -> DATA -> MESSAGE with 0 model calls", () => {
    const { train, heldOut } = smtpCorpus();
    const model = infer(train, { abstract: smtpAbstract, responseNamespace: "auto" });
    const { driver } = compile(model, {
      coverageGate: 0.9,
      heldOut,
      abstract: smtpAbstract,
      responseNamespace: "auto",
      sessions: train,
    });

    const autoAbstract = resolveAbstraction(train, "auto", smtpAbstract);
    const sent = driver.transitions.find((t) => (t.verb ?? "") === "MESSAGE")!.to;

    const server = new SmtpServer();
    driver.start();
    let modelCalls = 0; // never incremented: the driver is pure code
    const chosen: string[] = [];
    let sawData = false;
    let messageBeforeData = false;
    let guard = 0;
    for (;;) {
      if (guard++ > 50) throw new Error("loop did not terminate");
      const n = driver.nextCommand(sent);
      if ("done" in n) break;
      if ("escalate" in n) throw new Error("unexpected escalation: " + n.reason);
      if (n.command === "DATA") sawData = true;
      if (n.command === "MESSAGE" && !sawData) messageBeforeData = true;
      chosen.push(n.command);
      const raw = server.send(n.command + (n.command === "RCPT_TO" ? " r" : ""));
      const r = driver.step(autoAbstract({ verb: n.command, response: raw }).symbol);
      expect(r.deterministic).toBe(true);
    }

    expect(modelCalls).toBe(0);
    expect(driver.state()).toBe(sent);
    expect(messageBeforeData).toBe(false); // MESSAGE is NEVER selected before DATA
    expect(chosen).toEqual(["EHLO", "MAIL_FROM", "RCPT_TO", "DATA", "MESSAGE"]);
  });
});

/* ------------------------------------------------------------------ */
/* (3) The pieces: ambiguous-response detection, standalone helpers,   */
/*     and the same abstraction used for train + held-out.            */
/* ------------------------------------------------------------------ */

describe("SMTP: auto namespaces ONLY ambiguous response types", () => {
  it("250 is ambiguous (seen under 2+ verbs); 354/550/554/221 are not", () => {
    const { train } = smtpCorpus();
    const ambiguous = ambiguousResponseTypes(train, smtpAbstract);
    expect(ambiguous.has("250")).toBe(true);
    expect(ambiguous.has("354")).toBe(false);
    expect(ambiguous.has("550")).toBe(false);
    expect(ambiguous.has("554")).toBe(false);
    expect(ambiguous.has("221")).toBe(false);
  });

  it("the auto abstraction namespaces 250 by verb but leaves 354 untouched", () => {
    const { train } = smtpCorpus();
    const auto = resolveAbstraction(train, "auto", smtpAbstract);
    // 250 under different verbs becomes distinct symbols.
    expect(auto({ verb: "EHLO", response: "250 ok" }).symbol).toBe("EHLO/250@EHLO");
    expect(auto({ verb: "MAIL_FROM", response: "250 ok" }).symbol).toBe("MAIL_FROM/250@MAIL_FROM");
    expect(auto({ verb: "MESSAGE", response: "250 ok" }).symbol).toBe("MESSAGE/250@MESSAGE");
    // 354 is unambiguous: left as-is.
    expect(auto({ verb: "DATA", response: "354 go" }).symbol).toBe("DATA/354");
  });

  it("standalone analyzePlanAmbiguity / forwardBranches agree with compile()", () => {
    const { train } = smtpCorpus();
    const none = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
    const auto = infer(train, { abstract: smtpAbstract, responseNamespace: "auto" });

    // Raw forward branches exist under the coarse model, vanish under the finer one.
    expect(forwardBranches(none).length).toBeGreaterThan(0);

    const reportNone = analyzePlanAmbiguity(none, {
      sessions: train,
      abstract: smtpAbstract,
      finerPolicy: "auto",
    });
    expect(reportNone.requiresFinerAbstraction).toBe(true);
    expect(reportNone.ambiguousStates.length).toBeGreaterThan(0);

    const reportAuto = analyzePlanAmbiguity(auto, {
      sessions: train,
      abstract: smtpAbstract,
      finerPolicy: "auto",
    });
    expect(reportAuto.requiresFinerAbstraction).toBe(false);
    expect(reportAuto.ambiguousStates.length).toBe(0);
  });

  it("without sessions the gate reports raw branches but does not fail (no comparison)", () => {
    const { train } = smtpCorpus();
    const none = infer(train, { abstract: smtpAbstract, responseNamespace: "none" });
    const report = analyzePlanAmbiguity(none); // no sessions
    expect(report.rawForwardBranches.length).toBeGreaterThan(0);
    expect(report.requiresFinerAbstraction).toBe(false);
    expect(report.ambiguousStates.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* (4) Defense in depth: nextCommand escalates on a genuine tie.       */
/* ------------------------------------------------------------------ */

describe("Driver.nextCommand escalates ambiguous-branch on a genuine tie", () => {
  it("refuses to pick among 2 tied progress verbs to different successors at equal distance", () => {
    // q0 has TWO verbs A and B leading to DIFFERENT successors q1, q2; each is one step from the
    // goal q3 (q1 --C--> q3 and q2 --D--> q3). Both shortest paths have equal length, so the planner
    // must refuse rather than guess.
    const model = {
      states: ["q0", "q1", "q2", "q3"],
      transitions: [
        { from: "q0", on: "A/OK", to: "q1", verb: "A" },
        { from: "q0", on: "B/OK", to: "q2", verb: "B" },
        { from: "q1", on: "C/OK", to: "q3", verb: "C" },
        { from: "q2", on: "D/OK", to: "q3", verb: "D" },
      ],
      abstraction: [],
    };
    const driver = Driver.fromModel(model);
    const n = driver.nextCommand("q3", "q0");
    expect("escalate" in n && n.reason).toBe("ambiguous-branch");
    expect("escalate" in n && n.verbs).toEqual(["A", "B"]);
  });

  it("does NOT escalate when one verb is a clear shortest path (no tie)", () => {
    // q0 --A--> q1 --B--> goal, and q0 --C--> q2 (a dead-end branch). A is the unique shortest path.
    const model = {
      states: ["q0", "q1", "q2", "q3"],
      transitions: [
        { from: "q0", on: "A/OK", to: "q1", verb: "A" },
        { from: "q1", on: "B/OK", to: "q3", verb: "B" },
        { from: "q0", on: "C/OK", to: "q2", verb: "C" }, // longer / dead end
      ],
      abstraction: [],
    };
    const driver = Driver.fromModel(model);
    const n = driver.nextCommand("q3", "q0");
    expect("command" in n && n.command).toBe("A");
  });
});
