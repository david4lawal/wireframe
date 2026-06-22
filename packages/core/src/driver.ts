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
  | {
      escalate: true;
      reason: "no-path-to-goal" | "unknown-state" | "ambiguous-branch";
      deterministic: false;
      /** For "ambiguous-branch": the tied progress verbs the planner refused to choose among. */
      verbs?: string[];
    };

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
   *   { escalate:true, reason:"unknown-state" }      `state` is not a known state;
   *   { escalate:true, reason:"no-path-to-goal" }    no verb path reaches any goal state;
   *   { escalate:true, reason:"ambiguous-branch" }   2+ TIED distinct progress verbs from `state`
   *       each lie on an EQUAL shortest path to the goal but advance to DIFFERENT successor states.
   *       The planner refuses to guess (defense in depth: a finer abstraction should have kept those
   *       successors apart or merged them; either way the planner does not silently pick one).
   *
   * Progress edges (to != from) are preferred over self-loops so the search makes forward progress.
   */
  nextCommand(goal: Goal, state: string = this.current): NextCommand {
    if (!this.byState.has(state)) {
      return { escalate: true, reason: "unknown-state", deterministic: false };
    }
    if (this.satisfiesGoal(state, goal)) return { done: true };

    // Shortest-path distance (in progress edges) from every state to the NEAREST goal state. Reverse
    // BFS from all goal states over reversed progress edges. Used both to find a next verb and to
    // detect a tie among first verbs.
    const dist = this.distancesToGoal(goal);
    const here = dist.get(state);
    if (here === undefined) {
      return { escalate: true, reason: "no-path-to-goal", deterministic: false };
    }

    // Among progress edges out of `state`, the ones that make shortest-path progress are those whose
    // successor is one step closer to the goal (dist(to) === dist(state) - 1). If 2+ of those have
    // DISTINCT verbs AND DISTINCT successors, the choice is a genuine tie: refuse rather than guess.
    const onShortest: { verb: string; to: string }[] = [];
    for (const e of this.verbEdges(state)) {
      if (e.to === state) continue; // self-loop never progresses
      const d = dist.get(e.to);
      if (d !== undefined && d === here - 1) onShortest.push(e);
    }
    const distinctVerbs = new Set(onShortest.map((e) => e.verb));
    const distinctSuccs = new Set(onShortest.map((e) => e.to));
    if (distinctVerbs.size >= 2 && distinctSuccs.size >= 2) {
      return {
        escalate: true,
        reason: "ambiguous-branch",
        deterministic: false,
        verbs: [...distinctVerbs].sort(),
      };
    }

    // Unambiguous: take the (unique) shortest-progress verb. If several edges tie only because one
    // verb leads to several states, or several verbs lead to ONE state, that is not an ambiguous
    // branch; pick the deterministic first by sorted (verb, to).
    if (onShortest.length > 0) {
      onShortest.sort((a, b) => a.verb.localeCompare(b.verb) || a.to.localeCompare(b.to));
      const chosen = onShortest[0];
      return { command: chosen.verb, toward: chosen.to, deterministic: true };
    }

    return { escalate: true, reason: "no-path-to-goal", deterministic: false };
  }

  /**
   * Shortest-path distances (counting progress edges) from each state to the NEAREST state that
   * satisfies `goal`. Reverse BFS from all goal states over reversed progress edges. States with no
   * path to a goal are absent from the map.
   */
  private distancesToGoal(goal: Goal): Map<string, number> {
    // Build reverse adjacency over progress edges (to -> from).
    const rev = new Map<string, Set<string>>();
    for (const t of this.transitions) {
      if (t.to === t.from) continue; // self-loop is not progress
      if (!rev.has(t.to)) rev.set(t.to, new Set());
      rev.get(t.to)!.add(t.from);
    }
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const s of this.states) {
      if (this.satisfiesGoal(s, goal)) {
        dist.set(s, 0);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(cur)!;
      for (const pred of rev.get(cur) ?? []) {
        if (!dist.has(pred)) {
          dist.set(pred, d + 1);
          queue.push(pred);
        }
      }
    }
    return dist;
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
