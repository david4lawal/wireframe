/**
 * driver.ts
 *
 * A compiled, deterministic driver over a learned protocol model. It is PURE CODE: running a
 * learned task through it makes ZERO model calls. On ANY unknown state/verb/response (drift) it
 * escalates safely and NEVER guesses. That is the safe-escalation property: deterministic on
 * learned paths, safe escalation otherwise.
 */

import type { ProtocolModel, Transition } from "./types.js";
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

/**
 * A goal for action selection. Either a single target state name, an object naming a state, or a
 * set of acceptable states ({ anyOf }). The driver plans the shortest verb path to ANY goal state.
 */
export type Goal = string | { state: string } | { anyOf: string[] };

/** The result of asking the driver what command to send next toward a goal. */
export type NextCommand =
  | { command: string; toward: string; deterministic: true }
  | { done: true }
  | { escalate: true; reason: "no-path-to-goal" | "unknown-state"; deterministic: false };

/** Internal serialization shape for toJSON / fromJSON. */
interface DriverJson {
  initial: string;
  states: string[];
  transitions: Transition[];
  abstraction: string[];
}

export class Driver {
  private byState: Map<string, Map<string, string>> = new Map();
  /** Per-(state, symbol) request verb, for verb-based action planning. */
  private verbAt: Map<string, Map<string, string>> = new Map();
  private knownSyms: Set<string> = new Set();
  readonly initial: string;
  readonly states: string[];
  readonly transitions: Transition[];
  readonly abstraction: string[];

  /** Live execution cursor: the state the driver is currently in. */
  private current: string;

  private constructor(json: DriverJson) {
    this.initial = json.initial;
    this.states = [...json.states];
    // Backfill `verb` from the symbol head for old JSON that predates per-transition verbs.
    this.transitions = json.transitions.map((t) => ({
      ...t,
      verb: t.verb ?? t.on.split("/")[0] ?? "",
    }));
    this.abstraction = [...json.abstraction];
    this.current = json.initial;
    for (const s of this.states) {
      this.byState.set(s, new Map());
      this.verbAt.set(s, new Map());
    }
    for (const t of this.transitions) {
      if (!this.byState.has(t.from)) this.byState.set(t.from, new Map());
      if (!this.verbAt.has(t.from)) this.verbAt.set(t.from, new Map());
      this.byState.get(t.from)!.set(t.on, t.to);
      this.verbAt.get(t.from)!.set(t.on, t.verb!);
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

  /* ---------------------------------------------------------------- */
  /* Action selection (the new capability: CHOOSE the next command)    */
  /* ---------------------------------------------------------------- */

  /** True iff `state` satisfies `goal` (it IS the goal / one of the anyOf states). */
  private satisfiesGoal(state: string, goal: Goal): boolean {
    if (typeof goal === "string") return state === goal;
    if ("anyOf" in goal) return goal.anyOf.includes(state);
    return state === goal.state;
  }

  /**
   * Outgoing edges of `state` grouped by VERB. Planning ignores the response (a verb may yield
   * several responses, e.g. GET -> OK_ITEM or ERR_NOTFOUND), so we plan over verbs. When one verb
   * reaches several next states we keep them all as candidate edges; a verb that stays in the same
   * state (a self-loop) is recorded too but is not "progress".
   */
  private verbEdges(state: string): { verb: string; to: string }[] {
    const out: { verb: string; to: string }[] = [];
    const seen = new Set<string>();
    const table = this.byState.get(state);
    const verbs = this.verbAt.get(state);
    if (!table || !verbs) return out;
    for (const [sym, to] of table) {
      const verb = verbs.get(sym) ?? sym.split("/")[0] ?? "";
      const key = `${verb}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ verb, to });
    }
    return out;
  }

  /**
   * Choose the next command (a VERB) to send to make progress toward `goal`, deterministically and
   * with zero model calls. BFS over the state graph where each edge is labeled by its verb (the
   * response is ignored for planning). Returns:
   *   { command, toward, deterministic:true }  the verb to send next, and the state it advances to;
   *   { done:true }                            `state` already satisfies the goal;
   *   { escalate:true, reason:"unknown-state" }   `state` is not a known state;
   *   { escalate:true, reason:"no-path-to-goal" } no verb path reaches any goal state.
   *
   * Progress edges (to != from) are preferred over self-loops so the search makes forward progress.
   */
  nextCommand(goal: Goal, state: string = this.current): NextCommand {
    if (!this.byState.has(state)) {
      return { escalate: true, reason: "unknown-state", deterministic: false };
    }
    if (this.satisfiesGoal(state, goal)) return { done: true };

    // BFS from `state`. parent[s] = { via verb, from state, firstVerb, firstTo } reconstructs the
    // path; we only need the FIRST verb and the state it advances to.
    interface Crumb {
      firstVerb: string;
      firstTo: string;
    }
    const visited = new Set<string>([state]);
    const queue: { node: string; crumb: Crumb | null }[] = [{ node: state, crumb: null }];

    while (queue.length > 0) {
      const { node, crumb } = queue.shift()!;
      // Prefer progress edges (to != node) so a goal reachable through movement is found before
      // self-loops add it to the frontier. Self-loops cannot reach a NEW state anyway.
      const edges = this.verbEdges(node);
      const ordered = [...edges].sort((a, b) => {
        const ap = a.to !== node ? 0 : 1;
        const bp = b.to !== node ? 0 : 1;
        return ap - bp;
      });
      for (const e of ordered) {
        if (e.to === node) continue; // self-loop: no progress, never reaches a new state
        const firstVerb = crumb ? crumb.firstVerb : e.verb;
        const firstTo = crumb ? crumb.firstTo : e.to;
        if (this.satisfiesGoal(e.to, goal)) {
          return { command: firstVerb, toward: firstTo, deterministic: true };
        }
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push({ node: e.to, crumb: { firstVerb, firstTo } });
        }
      }
    }
    return { escalate: true, reason: "no-path-to-goal", deterministic: false };
  }

  /** Action selection from the LIVE cursor (sugar over nextCommand(goal, this.current)). */
  next(goal: Goal): NextCommand {
    return this.nextCommand(goal, this.current);
  }

  /* ---------------------------------------------------------------- */
  /* Terminal states                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Terminal states: states with NO outgoing transition to a DIFFERENT state. A state whose only
   * edges are self-loops (or which has no edges at all) is terminal: nothing learned moves off it.
   */
  terminalStates(): string[] {
    const terminal: string[] = [];
    for (const s of this.states) {
      const table = this.byState.get(s);
      let escapes = false;
      if (table) {
        for (const to of table.values()) {
          if (to !== s) {
            escapes = true;
            break;
          }
        }
      }
      if (!escapes) terminal.push(s);
    }
    return terminal;
  }

  /** True iff `state` is a terminal state (no learned edge leaves it). */
  isTerminal(state: string): boolean {
    const table = this.byState.get(state);
    if (!table) return false; // an unknown state is not a (known) terminal state
    for (const to of table.values()) if (to !== state) return false;
    return true;
  }
}

/*
 * RUNTIME LOOP (how the driver SELECTS commands, not just validates them):
 *
 *   driver.start();
 *   for (;;) {
 *     const n = driver.nextCommand(goal);
 *     if ("done" in n) break;                    // already at a goal state
 *     if ("escalate" in n) { handToModel(); break; }  // no learned path: ask the model
 *     // The driver chose the WHAT (the verb). The caller supplies the HOW (concrete params + transport).
 *     const raw = await adapter.send(buildConcreteRequest(n.command, taskParams));
 *     const sym = abstract({ verb: n.command, response: raw }).symbol;
 *     const r = driver.step(sym);
 *     if (r.escalate) {
 *       // An unseen branch (drift or a new response shape): hand to the model, then record the new
 *       // session and recompile so the driver learns it for next time.
 *       handToModel();
 *       break;
 *     }
 *   }
 */
