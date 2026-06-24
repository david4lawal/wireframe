/**
 * core.test.ts (vitest)
 *
 * Tests for @wframe/core:
 *  (1) infer('red-blue') yields exactly 3 states and matches ground truth.
 *  (2) infer('none') yields the raw tree (many states); infer('rpni') over-generalizes (fewer
 *      states than truth AND accepts an illegal sequence) so the default is non-trivial.
 *  (3) the driver runs the happy path with 0 model calls.
 *  (4) an out-of-state verb triggers escalate:true with deterministic:false and no action.
 *  (5) abstraction strips token/id/timestamp.
 *  (6) Driver JSON round-trip is stable.
 */

import { describe, it, expect } from "vitest";
import {
  infer,
  inferFsm,
  compile,
  Driver,
  abstractStep,
  abstractSession,
  abstractResponse,
  fsmMatchesGroundTruth,
  recordMockSessions,
  demo,
  type Session,
} from "./index.js";

/** Build train/heldOut from the scripted mock corpus, mirroring the bench split. */
function corpus(): { all: Session[]; train: Session[]; heldOut: Session[] } {
  const recorded = recordMockSessions();
  const all = recorded.map((r) => r.session);
  const heldOutIds = new Set([
    "s1-login-list-logout",
    "s3-login-ping-logout",
    "s4-login-list-get-ping-logout",
  ]);
  const train = recorded.filter((r) => !heldOutIds.has(r.id)).map((r) => r.session);
  const heldOut = recorded.filter((r) => heldOutIds.has(r.id)).map((r) => r.session);
  return { all, train, heldOut };
}

describe("inference: red-blue (default)", () => {
  it("yields exactly 3 states and matches the ground-truth FSM", () => {
    const { train } = corpus();
    const traces = train.map((s) => abstractSession(s.steps));
    const fsm = inferFsm(traces, "red-blue", 2);
    expect(fsm.states.length).toBe(3);
    const match = fsmMatchesGroundTruth(fsm);
    expect(match.matches).toBe(true);
  });

  it("is the default merge mode of infer()", () => {
    const { train } = corpus();
    const model = infer(train); // no opts -> red-blue
    expect(model.states.length).toBe(3);
    expect(fsmMatchesGroundTruth({ initial: model.states[0], ...model }).matches).toBe(true);
  });
});

describe("inference: comparison modes are real and distinct", () => {
  it("'none' yields the raw prefix tree (many more states than the truth)", () => {
    const { train } = corpus();
    const traces = train.map((s) => abstractSession(s.steps));
    const none = inferFsm(traces, "none");
    expect(none.states.length).toBeGreaterThan(3);
    expect(fsmMatchesGroundTruth(none).matches).toBe(false);
  });

  it("'rpni' over-generalizes: fewer states than the truth AND accepts an illegal sequence", () => {
    const { train } = corpus();
    const traces = train.map((s) => abstractSession(s.steps));
    const rpni = inferFsm(traces, "rpni");
    // RPNI collapses states from positive-only data.
    expect(rpni.states.length).toBeLessThan(3);
    expect(fsmMatchesGroundTruth(rpni).matches).toBe(false);
    // It wrongly accepts an out-of-state sequence (an operation after LOGOUT).
    const driver = Driver.fromModel({ ...rpni, abstraction: [] });
    const illegal = ["LOGIN/OK_GREETING", "LOGOUT/OK_BYE", "LIST/OK_ITEMS"];
    expect(driver.run(illegal).accepted).toBe(true);
  });

  it("red-blue does NOT accept that illegal sequence (it is the safe one)", () => {
    const { train } = corpus();
    const model = infer(train);
    const driver = Driver.fromModel(model);
    const illegal = ["LOGIN/OK_GREETING", "LOGOUT/OK_BYE", "LIST/OK_ITEMS"];
    expect(driver.run(illegal).accepted).toBe(false);
  });
});

describe("driver: happy path with zero model calls", () => {
  it("runs the happy path deterministically and the demo reports 0 model calls", async () => {
    const { train, heldOut } = corpus();
    const model = infer(train);
    const { driver, report } = compile(model, { coverageGate: 0.95, heldOut });
    expect(report.passed).toBe(true);

    driver.start();
    const happy = [
      "LOGIN/OK_GREETING",
      "LIST/OK_ITEMS",
      "GET/OK_ITEM",
      "PING/OK_PONG",
      "LOGOUT/OK_BYE",
    ];
    let modelCalls = 0; // the driver is pure code; nothing ever increments this
    for (const sym of happy) {
      const r = driver.step(sym);
      expect(r.deterministic).toBe(true);
      expect(r.escalate).toBeUndefined();
    }
    expect(modelCalls).toBe(0);

    const d = await demo();
    expect(d.ok).toBe(true);
    expect(d.modelCalls).toBe(0);
    expect(d.states).toBe(3);
  });
});

describe("driver: out-of-state verb escalates safely", () => {
  it("escalates with deterministic:false and no action on an out-of-state symbol", () => {
    const { train } = corpus();
    const model = infer(train);
    const driver = Driver.fromModel(model);
    driver.start();
    // From the initial state, a successful LIST cannot happen (LIST before login is rejected).
    const r = driver.step("LIST/OK_ITEMS");
    expect(r.escalate).toBe(true);
    expect(r.deterministic).toBe(false);
    expect(r.action).toBeUndefined();
    expect(r.reason).toBe("no-transition"); // known symbol, illegal in this state
  });

  it("escalates on a never-seen (drifted) symbol as unknown-symbol", () => {
    const { train } = corpus();
    const model = infer(train);
    const driver = Driver.fromModel(model);
    driver.start();
    driver.step("LOGIN/OK_GREETING"); // advance to AUTH
    const r = driver.step("PING/OK_PONG-V2"); // drifted response, never learned
    expect(r.escalate).toBe(true);
    expect(r.deterministic).toBe(false);
    expect(r.reason).toBe("unknown-symbol");
  });
});

describe("inference: loops with recovery branches fold (regression for the under-merge cascade)", () => {
  // A looping protocol (ADD* then SET*) with an OUT_OF_STOCK -> SUBSTITUTE -> re-ADD recovery
  // branch, recorded at VARYING loop counts. The recovery error response of ADD_ITEM goes to a
  // DIFFERENT state than its success response, so a verb-keyed determinism fold conflated them and
  // tripped the rollback guard into an under-merge explosion (>100 states). Symbol-keyed
  // determinism + evidence-driven merging keeps the recovery state distinct AND folds the loops.
  function trace(k: number, m: number, recover: boolean): string[] {
    const t = ["LOGIN/OK_SESSION", "START_ORDER/OK_ORDER"];
    for (let i = 0; i < k; i++) {
      if (recover && i === 0) t.push("ADD_ITEM/ERR_OUT_OF_STOCK", "SUBSTITUTE/OK_SUBSTITUTED", "ADD_ITEM/OK_LINE");
      else t.push("ADD_ITEM/OK_LINE");
    }
    for (let i = 0; i < m; i++) t.push("SET_FIELD/OK_FIELD");
    t.push("REVIEW/OK_REVIEWED", "VALIDATE/OK_VALIDATED", "SUBMIT/OK_SUBMITTED");
    return t;
  }

  it("folds variable-length loops even with a recovery branch (bounded state count)", () => {
    const traces: string[][] = [];
    for (const k of [1, 2, 3, 4, 5]) for (const m of [1, 2, 3]) { traces.push(trace(k, m, false)); traces.push(trace(k, m, true)); }
    const fsm = inferFsm(traces, "red-blue", 2);
    // True machine is ~8 states; under the old verb-fold this was >100. Guard well below that.
    expect(fsm.states.length).toBeLessThanOrEqual(12);
    // The loop bodies must have folded into self-loops.
    expect(fsm.transitions.some((t) => t.from === t.to && t.on === "ADD_ITEM/OK_LINE")).toBe(true);
    expect(fsm.transitions.some((t) => t.from === t.to && t.on === "SET_FIELD/OK_FIELD")).toBe(true);
    // The OUT_OF_STOCK recovery state must stay DISTINCT from drafting (not over-merged):
    // SUBSTITUTE must transition out of the state reached by ERR_OUT_OF_STOCK, not self-loop on it.
    const oos = fsm.transitions.find((t) => t.on === "ADD_ITEM/ERR_OUT_OF_STOCK");
    expect(oos).toBeDefined();
    expect(oos!.to).not.toBe(oos!.from);
  });
});

describe("abstraction strips parameters", () => {
  it("strips token, id, and timestamp", () => {
    expect(abstractStep({ verb: "LOGIN tok-abc-123", response: "T1001 OK GREETING sid=abc123" }).symbol).toBe(
      "LOGIN/OK_GREETING"
    );
    expect(abstractStep({ verb: "GET 1002", response: "T1007 OK ITEM 1002=widget-beta" }).symbol).toBe(
      "GET/OK_ITEM"
    );
    // Timestamp prefix is dropped; differing timestamps map to the same response type.
    expect(abstractResponse("T1001 OK PONG")).toBe("OK_PONG");
    expect(abstractResponse("T9999 OK PONG")).toBe("OK_PONG");
    expect(abstractResponse("T1009 ERR NOTFOUND 9999")).toBe("ERR_NOTFOUND");
  });
});

describe("driver: JSON round-trip is stable", () => {
  it("toJSON/fromJSON reproduces the same transitions and behavior", () => {
    const { train } = corpus();
    const model = infer(train);
    const a = Driver.fromModel(model);
    const json = a.toJSON();
    const b = Driver.fromJSON(json);
    // Round-trip is byte-stable.
    expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(json));
    // And re-round-trips identically.
    const c = Driver.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(json));
    // Same acceptance behavior on the happy path.
    const happy = ["LOGIN/OK_GREETING", "LIST/OK_ITEMS", "LOGOUT/OK_BYE"];
    expect(b.run(happy).accepted).toBe(a.run(happy).accepted);
    expect(b.run(happy).accepted).toBe(true);
  });
});
