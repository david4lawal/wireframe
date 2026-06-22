/**
 * driver.ts
 *
 * A compiled, deterministic driver over a learned protocol model. It is PURE CODE: running a
 * learned task through it makes ZERO model calls. On ANY unknown state/verb/response (drift) it
 * escalates safely and NEVER guesses. That is the safe-escalation property: deterministic on
 * learned paths, safe escalation otherwise.
 */

import type { ProtocolModel } from "./types.js";
import type { LearnedFsm } from "./inference.js";

/** Result of stepping the driver on one observed response symbol. */
export interface DriverStepResult {
  /** An action label for the learned transition (the symbol consumed), if any. */
  action?: string;
  /** True when the driver refused and must hand off (drift / out of state). */
  escalate?: boolean;
  /** True iff the step stayed on the learned automaton (an action was taken). */
  deterministic: boolean;
  /** Why the driver escalated, when it did. */
  reason?: "unknown-symbol" | "no-transition" | "unknown-state";
}

/** Internal serialization shape for toJSON / fromJSON. */
interface DriverJson {
  initial: string;
  states: string[];
  transitions: { from: string; on: string; to: string }[];
  abstraction: string[];
}

export class Driver {
  private byState: Map<string, Map<string, string>> = new Map();
  private knownSyms: Set<string> = new Set();
  readonly initial: string;
  readonly states: string[];
  readonly transitions: { from: string; on: string; to: string }[];
  readonly abstraction: string[];

  /** Live execution cursor: the state the driver is currently in. */
  private current: string;

  private constructor(json: DriverJson) {
    this.initial = json.initial;
    this.states = [...json.states];
    this.transitions = json.transitions.map((t) => ({ ...t }));
    this.abstraction = [...json.abstraction];
    this.current = json.initial;
    for (const s of this.states) this.byState.set(s, new Map());
    for (const t of this.transitions) {
      if (!this.byState.has(t.from)) this.byState.set(t.from, new Map());
      this.byState.get(t.from)!.set(t.on, t.to);
      this.knownSyms.add(t.on);
    }
  }

  /** Build a driver from a learned model. The initial state is the first state (q0). */
  static fromModel(model: ProtocolModel | (LearnedFsm & { abstraction?: string[] })): Driver {
    const initial =
      "initial" in model && typeof (model as LearnedFsm).initial === "string"
        ? (model as LearnedFsm).initial
        : model.states[0];
    return new Driver({
      initial,
      states: model.states,
      transitions: model.transitions,
      abstraction: (model as ProtocolModel).abstraction ?? [],
    });
  }

  /** Rebuild a driver from its serialized JSON form. */
  static fromJSON(json: unknown): Driver {
    const j = json as DriverJson;
    if (!j || !Array.isArray(j.states) || !Array.isArray(j.transitions)) {
      throw new Error("Driver.fromJSON: invalid driver JSON (missing states/transitions).");
    }
    const initial = typeof j.initial === "string" ? j.initial : j.states[0];
    return new Driver({
      initial,
      states: j.states,
      transitions: j.transitions,
      abstraction: Array.isArray(j.abstraction) ? j.abstraction : [],
    });
  }

  /** Serialize to a stable JSON shape (round-trips through fromJSON). */
  toJSON(): DriverJson {
    return {
      initial: this.initial,
      states: [...this.states],
      transitions: this.transitions.map((t) => ({ ...t })),
      abstraction: [...this.abstraction],
    };
  }

  /** Reset the live cursor to the initial state and return it. */
  start(): string {
    this.current = this.initial;
    return this.current;
  }

  /**
   * Step the live cursor on an observed `response` SYMBOL ("VERB/RESPONSE_TYPE"). Deterministic
   * on the learned path: returns an action and advances. On any unknown state, unknown symbol, or
   * out-of-state symbol it escalates (escalate=true, deterministic=false) and takes NO action and
   * does NOT advance the cursor.
   */
  step(response: string): DriverStepResult {
    const table = this.byState.get(this.current);
    if (!table) {
      return { escalate: true, deterministic: false, reason: "unknown-state" };
    }
    if (!table.has(response)) {
      const reason: DriverStepResult["reason"] = this.knownSyms.has(response)
        ? "no-transition" // symbol known but illegal in this state (out of state)
        : "unknown-symbol"; // symbol never seen at all (drifted response type)
      return { escalate: true, deterministic: false, reason };
    }
    const to = table.get(response)!;
    this.current = to;
    return { action: response, deterministic: true };
  }

  /** The state the live cursor is currently in. */
  state(): string {
    return this.current;
  }

  /** Pure, cursorless step from an explicit state (used by validators that track state). */
  stepFrom(state: string, response: string): { accepted: boolean; to?: string; reason?: string } {
    const table = this.byState.get(state);
    if (!table || !table.has(response)) {
      const reason = !table
        ? "unknown-state"
        : this.knownSyms.has(response)
        ? "no-transition"
        : "unknown-symbol";
      return { accepted: false, reason };
    }
    return { accepted: true, to: table.get(response)! };
  }

  /** Run a whole symbol sequence from the initial state without touching the live cursor. */
  run(symbols: string[]): { accepted: boolean; refusedAt?: number; reason?: string } {
    let state = this.initial;
    for (let i = 0; i < symbols.length; i++) {
      const r = this.stepFrom(state, symbols[i]);
      if (!r.accepted) return { accepted: false, refusedAt: i, reason: r.reason };
      state = r.to!;
    }
    return { accepted: true };
  }

  /** Symbols legal (with a learned transition) from a given state. */
  legalFrom(state: string): Set<string> {
    return new Set(this.byState.get(state)?.keys() ?? []);
  }
}
