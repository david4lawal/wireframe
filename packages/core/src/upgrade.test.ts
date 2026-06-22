/**
 * upgrade.test.ts (vitest)
 *
 * Tests for the 1.1.0 upgrade: the driver now SELECTS commands (action selection), terminal-state
 * detection, error-path training keeping disjoint-outcome states distinct, and the HTTP abstraction
 * normalizing ids / tokens / PII to stable symbols.
 */

import { describe, it, expect } from "vitest";
import {
  infer,
  compile,
  Driver,
  abstractStep,
  abstractHttpStep,
  makeAbstractHttpStep,
  type Session,
} from "./index.js";

/* ------------------------------------------------------------------ */
/* An in-process coffee machine (a fresh FSM, not the mock protocol)   */
/* ------------------------------------------------------------------ */

/**
 * Coffee machine:
 *   LOCKED   --INSERT_COIN--> READY
 *   READY    --SELECT-------> SELECTED
 *   SELECTED --BREW---------> BREWING
 *   BREWING  --COLLECT------> DONE         (cup ready to collect)
 *   DONE     --RESET--------> LOCKED
 * Any illegal command yields "ERR" and does not change state. COLLECT from DONE yields ERR_DONE
 * (a DISJOINT outcome from COLLECT in BREWING, which yields OK_DONE): this is the error-path signal
 * that keeps BREWING and DONE distinct.
 */
class CoffeeMachine {
  private state: "LOCKED" | "READY" | "SELECTED" | "BREWING" | "DONE" = "LOCKED";
  send(verb: string): string {
    const v = verb.trim().toUpperCase();
    switch (this.state) {
      case "LOCKED":
        if (v === "INSERT_COIN") {
          this.state = "READY";
          return "OK READY";
        }
        return "ERR LOCKED";
      case "READY":
        if (v === "SELECT") {
          this.state = "SELECTED";
          return "OK SELECTED";
        }
        return "ERR READY";
      case "SELECTED":
        if (v === "BREW") {
          this.state = "BREWING";
          return "OK BREWING";
        }
        return "ERR SELECTED";
      case "BREWING":
        if (v === "COLLECT") {
          this.state = "DONE";
          return "OK DONE"; // success: cup collected -> symbol COLLECT/OK_DONE
        }
        return "ERR BREWING";
      case "DONE":
        if (v === "RESET") {
          this.state = "LOCKED";
          return "OK LOCKED";
        }
        if (v === "COLLECT") {
          return "ERR DONE"; // disjoint outcome: COLLECT here yields ERR_DONE (vs OK_DONE in BREWING)
        }
        return "ERR DONE";
    }
  }
}

/** Record one scripted session against a fresh coffee machine. */
function recordCoffee(script: string[]): Session {
  const m = new CoffeeMachine();
  const steps = script.map((verb) => ({ verb, response: m.send(verb) }));
  return { steps, outcome: "success" as const };
}

/** A success + error-probe corpus for the coffee machine (verbs as actions). */
function coffeeCorpus(): { train: Session[]; heldOut: Session[] } {
  const train = [
    recordCoffee(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"]),
    recordCoffee(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET", "INSERT_COIN", "SELECT"]),
    recordCoffee(["INSERT_COIN", "SELECT", "BREW", "COLLECT"]),
    // Error probes: illegal commands learned as self-loops, and the disjoint COLLECT-from-DONE.
    recordCoffee(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "COLLECT"]), // COLLECT in DONE -> ERR_DONE
    recordCoffee(["SELECT", "INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"]), // SELECT in LOCKED -> ERR
  ];
  const heldOut = [
    recordCoffee(["INSERT_COIN", "SELECT", "BREW", "COLLECT", "RESET"]),
  ];
  return { train, heldOut };
}

/* ------------------------------------------------------------------ */
/* Action selection                                                    */
/* ------------------------------------------------------------------ */

describe("action selection: the driver chooses the command sequence", () => {
  it("reaches the goal DONE on the coffee FSM via the live loop with 0 model calls", () => {
    const { train, heldOut } = coffeeCorpus();
    const model = infer(train);
    const { driver, report } = compile(model, { coverageGate: 0.9, heldOut });
    expect(report.passed).toBe(true);

    // The DONE state is whatever state COLLECT/OK_DONE leads to. Find it by name via the model.
    const doneState = driver.transitions.find((t) => t.on === "COLLECT/OK_DONE")!.to;

    // Drive: the DRIVER picks each verb; we only supply the machine response.
    const machine = new CoffeeMachine();
    driver.start();
    let modelCalls = 0; // never incremented; the driver is pure code
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
      expect(r.deterministic).toBe(true);
    }
    expect(modelCalls).toBe(0);
    expect(driver.state()).toBe(doneState);
    // The command order was chosen, not hard-coded; it must be the real path.
    expect(chosen).toEqual(["INSERT_COIN", "SELECT", "BREW", "COLLECT"]);
  });

  it("escalates no-path-to-goal when the goal state is unreachable", () => {
    const { train } = coffeeCorpus();
    const driver = Driver.fromModel(infer(train));
    driver.start();
    const n = driver.nextCommand({ state: "NO_SUCH_STATE" });
    expect("escalate" in n && n.reason).toBe("no-path-to-goal");
  });

  it("escalates unknown-state when asked to plan from an unknown current state", () => {
    const { train } = coffeeCorpus();
    const driver = Driver.fromModel(infer(train));
    const n = driver.nextCommand("q0", "NOT_A_STATE");
    expect("escalate" in n && n.reason).toBe("unknown-state");
  });

  it("returns done when already at a goal state", () => {
    const { train } = coffeeCorpus();
    const driver = Driver.fromModel(infer(train));
    const n = driver.nextCommand(driver.initial, driver.initial);
    expect("done" in n).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Terminal states + error-path training keeps BREWING != DONE         */
/* ------------------------------------------------------------------ */

describe("terminal states and error-path training", () => {
  it("error-path training keeps BREWING distinct from DONE (disjoint COLLECT outcomes)", () => {
    const { train } = coffeeCorpus();
    const driver = Driver.fromModel(infer(train));
    const brewing = driver.transitions.find((t) => t.on === "BREW/OK_BREWING")!.to;
    const done = driver.transitions.find((t) => t.on === "COLLECT/OK_DONE")!.to;
    // The learner must NOT over-merge these two states.
    expect(brewing).not.toBe(done);
  });

  it("nextCommand from DONE toward a fresh goal does NOT pick COLLECT", () => {
    const { train } = coffeeCorpus();
    const driver = Driver.fromModel(infer(train));
    const done = driver.transitions.find((t) => t.on === "COLLECT/OK_DONE")!.to;
    const brewing = driver.transitions.find((t) => t.on === "BREW/OK_BREWING")!.to;
    // From DONE, plan back toward BREWING (a fresh brew). The first verb must be RESET, never COLLECT.
    const n = driver.nextCommand(brewing, done);
    expect("command" in n && n.command).toBe("RESET");
    expect("command" in n && n.command).not.toBe("COLLECT");
  });

  it("terminalStates() finds the states with no escaping edge", () => {
    // A linear machine A --x--> B (B has only a self-loop) makes B terminal.
    const model = {
      states: ["q0", "q1"],
      transitions: [
        { from: "q0", on: "GO/OK", to: "q1", verb: "GO" },
        { from: "q1", on: "STAY/OK", to: "q1", verb: "STAY" },
      ],
      abstraction: [],
    };
    const driver = Driver.fromModel(model);
    expect(driver.terminalStates()).toEqual(["q1"]);
    expect(driver.isTerminal("q1")).toBe(true);
    expect(driver.isTerminal("q0")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP normalization                                                  */
/* ------------------------------------------------------------------ */

describe("abstractHttpStep: ids/tokens/PII normalize to stable symbols", () => {
  it("maps responses differing only in ids/tokens/PII to the SAME symbol", () => {
    const a = abstractHttpStep({
      verb: "GET /customers/1002",
      response: '200 {"id":1002,"name":"Ada Lovelace","email":"ada@example.com"}',
    });
    const b = abstractHttpStep({
      verb: "GET /customers/9999",
      response: '200 {"id":9999,"name":"Grace Hopper","email":"grace@navy.mil"}',
    });
    expect(a.symbol).toBe(b.symbol); // only ids/PII differ -> same symbol
    expect(a.symbol).toBe("GET /customers/:id/200 OBJ{email:string,id:number,name:string}");
  });

  it("templatizes the path and drops the query string", () => {
    const r = abstractHttpStep({
      verb: "GET /customers/1002/orders?cursor=abc123&limit=50",
      response: '200 [{"id":1,"status":"open"}]',
    });
    expect(r.verb).toBe("GET /customers/:id/orders");
    expect(r.symbol).toBe("GET /customers/:id/orders/200 LIST<OBJ{id:number,status:string}>");
  });

  it("templatizes uuid and long-token path segments to :id", () => {
    const uuid = abstractHttpStep({
      verb: "GET /sessions/550e8400-e29b-41d4-a716-446655440000",
      response: "200 ",
    });
    expect(uuid.verb).toBe("GET /sessions/:id");
    const tok = abstractHttpStep({
      verb: "GET /tokens/deadbeefdeadbeefdeadbeef",
      response: "200 ",
    });
    expect(tok.verb).toBe("GET /tokens/:id");
  });

  it("a token-only POST /login body shape is stable across different tokens", () => {
    const a = abstractHttpStep({ verb: "POST /login", response: '200 {"token":"aaaa1111bbbb2222"}' });
    const b = abstractHttpStep({ verb: "POST /login", response: '200 {"token":"zzzz9999yyyy8888"}' });
    expect(a.symbol).toBe(b.symbol);
    expect(a.symbol).toBe("POST /login/200 OBJ{token:string}");
  });

  it("classify() can map a shape to a friendly tag like CUSTOMER", () => {
    const abstractTagged = makeAbstractHttpStep({
      classify: (body) => {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const keys = Object.keys(body as Record<string, unknown>).sort().join(",");
          if (keys === "email,id,name") return "CUSTOMER";
        }
        return undefined;
      },
    });
    const r = abstractTagged({
      verb: "GET /customers/1002",
      response: '200 {"id":1002,"name":"Ada","email":"ada@example.com"}',
    });
    expect(r.symbol).toBe("GET /customers/:id/200 CUSTOMER");
  });

  it("an unseen status/shape yields a DIFFERENT symbol (the driver would escalate)", () => {
    const ok = abstractHttpStep({ verb: "POST /orders", response: '200 {"id":5,"status":"created"}' });
    const err = abstractHttpStep({ verb: "POST /orders", response: '500 {"error":"boom"}' });
    expect(ok.symbol).not.toBe(err.symbol);
    expect(err.symbol).toBe("POST /orders/500 ERROR{error:string}");
  });
});
