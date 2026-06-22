/**
 * coffee-demo.ts  (run: `npx tsx demos/coffee-demo.ts` from packages/core)
 *
 * An in-process stateful coffee machine, learned from a few recorded sessions, then driven by the
 * COMPILED DRIVER which CHOOSES the command sequence itself toward a goal. ZERO model calls.
 *
 *   LOCKED --INSERT_COIN--> READY --SELECT--> SELECTED --BREW--> BREWING --COLLECT--> DONE --RESET--> LOCKED
 *
 * Illegal commands yield ERR and do not change state. COLLECT in DONE yields ERR_DONE (a DISJOINT
 * outcome from COLLECT in BREWING, which yields OK_DONE), the error-path signal that keeps BREWING
 * and DONE distinct so the driver never picks COLLECT from DONE.
 */

import { infer, compile, abstractStep, Driver } from "../dist/index.js";
import type { Session } from "../dist/index.js";

/* ------------------------------------------------------------------ */
/* The black-box coffee machine (the "server"). The driver never sees  */
/* its internals; it only observes request/response messages.          */
/* ------------------------------------------------------------------ */

class CoffeeMachine {
  private state: "LOCKED" | "READY" | "SELECTED" | "BREWING" | "DONE" = "LOCKED";
  send(verb: string): string {
    const v = verb.trim().toUpperCase();
    switch (this.state) {
      case "LOCKED":
        if (v === "INSERT_COIN") return ((this.state = "READY"), "OK READY");
        return "ERR LOCKED";
      case "READY":
        if (v === "SELECT") return ((this.state = "SELECTED"), "OK SELECTED");
        return "ERR READY";
      case "SELECTED":
        if (v === "BREW") return ((this.state = "BREWING"), "OK BREWING");
        return "ERR SELECTED";
      case "BREWING":
        if (v === "COLLECT") return ((this.state = "DONE"), "OK DONE");
        return "ERR BREWING";
      case "DONE":
        if (v === "RESET") return ((this.state = "LOCKED"), "OK LOCKED");
        if (v === "COLLECT") return "ERR DONE"; // disjoint outcome vs COLLECT in BREWING
        return "ERR DONE";
    }
  }
}

function record(script: string[]): Session {
  const m = new CoffeeMachine();
  return { steps: script.map((verb) => ({ verb, response: m.send(verb) })), outcome: "success" };
}

function main(): void {
  /* 1. Record ~6 success sessions PLUS a couple error-probe sessions. */
  const train: Session[] = [
    record(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"]),
    record(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET", "INSERT_COIN", "SELECT", "BREW"]),
    record(["INSERT_COIN", "SELECT", "BREW", "COLLECT"]),
    record(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET", "INSERT_COIN"]),
    record(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "COLLECT"]), // error probe: COLLECT in DONE -> ERR_DONE
    record(["SELECT", "INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"]), // error probe: SELECT in LOCKED -> ERR
  ];
  const heldOut: Session[] = [record(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"])];

  /* 2. Infer + compile (gate 0.9). */
  const model = infer(train);
  const { driver, report } = compile(model, { coverageGate: 0.9, heldOut });

  /* Identify the named states by the transitions that reach them (no hard-coding of the path). */
  const doneState = driver.transitions.find((t) => t.on === "COLLECT/OK_DONE")!.to;
  const brewingState = driver.transitions.find((t) => t.on === "BREW/OK_BREWING")!.to;

  /* 3. The DRIVER chooses the command sequence itself toward goal "DONE". 0 model calls. */
  const machine = new CoffeeMachine();
  driver.start();
  let modelCalls = 0; // never incremented: the driver is pure code
  const chosen: string[] = [];
  let guard = 0;
  for (;;) {
    if (guard++ > 20) throw new Error("loop did not terminate");
    const n = driver.nextCommand(doneState);
    if ("done" in n) break;
    if ("escalate" in n) throw new Error("unexpected escalation: " + n.reason);
    chosen.push(n.command);
    const raw = machine.send(n.command);
    const sym = abstractStep({ verb: n.command, response: raw }).symbol;
    const r = driver.step(sym);
    if (!r.deterministic) throw new Error("driver escalated mid-run: " + r.reason);
  }

  /* 4. Out-of-state command escalates: ask for a command from an impossible cursor. */
  const escFromUnknown = driver.nextCommand(doneState, "NOT_A_STATE");
  const escNoPath = driver.nextCommand({ state: "NO_SUCH_STATE" }, driver.initial);

  /* 5. nextCommand from DONE toward a fresh brew must pick RESET, never COLLECT. */
  const fromDone = driver.nextCommand(brewingState, doneState);

  /* Summary. */
  console.log("=== coffee-demo ===");
  console.log(`inferred states (${model.states.length}): ${model.states.join(", ")}`);
  console.log("inferred transitions:");
  for (const t of driver.transitions) console.log(`  ${t.from} --[${t.verb}] ${t.on}--> ${t.to}`);
  console.log("");
  console.log(`compile passed       : ${report.passed} (coverage=${report.coverage}, unsafeRate=${report.unsafeContinuationRate})`);
  console.log(`goal state (DONE)    : ${doneState}`);
  console.log(`commands CHOSEN      : ${chosen.join(" -> ")}  (NOT hard-coded; selected by nextCommand)`);
  console.log(`reached goal         : ${driver.state() === doneState} (cursor=${driver.state()})`);
  console.log(`model calls          : ${modelCalls}`);
  console.log(`BREWING != DONE      : ${brewingState !== doneState} (BREWING=${brewingState}, DONE=${doneState})`);
  console.log(`out-of-state escalate: reason=${"escalate" in escFromUnknown ? escFromUnknown.reason : "(none)"}`);
  console.log(`no-path escalate     : reason=${"escalate" in escNoPath ? escNoPath.reason : "(none)"}`);
  console.log(`from DONE -> brew    : command=${"command" in fromDone ? fromDone.command : "(none)"} (must be RESET, never COLLECT)`);
  console.log(`terminal states      : ${driver.terminalStates().join(", ") || "(none)"}`);

  const ok =
    report.passed &&
    driver.state() === doneState &&
    modelCalls === 0 &&
    brewingState !== doneState &&
    "escalate" in escFromUnknown &&
    escFromUnknown.reason === "unknown-state" &&
    "escalate" in escNoPath &&
    escNoPath.reason === "no-path-to-goal" &&
    "command" in fromDone &&
    fromDone.command === "RESET" &&
    JSON.stringify(chosen) === JSON.stringify(["INSERT_COIN", "SELECT", "BREW", "COLLECT"]);

  console.log("");
  console.log(ok ? "coffee-demo: PASS" : "coffee-demo: FAIL");
  if (!ok) process.exitCode = 1;
}

main();
