/**
 * types.ts
 *
 * Public data types for @wframe/core. Kept dependency free so they can be imported
 * anywhere (tests, CLI, bench) without pulling in transport code.
 */

/** One observed protocol step: a request verb, the raw response, and any abstracted params. */
export interface Step {
  verb: string;
  response: string;
  params?: Record<string, string>;
}

/** An ordered sequence of steps plus the session outcome. */
export interface Session {
  steps: Step[];
  outcome: "success" | "failure";
}

/**
 * One learned transition over the abstracted alphabet. `on` is the opaque symbol
 * ("VERB/RESPONSE_TYPE"); `verb` is the request verb the symbol was produced by, attached so
 * action selection never has to re-parse the symbol (HTTP verbs themselves contain "/").
 */
export interface Transition {
  from: string;
  on: string;
  to: string;
  /** The request verb for this transition. Optional for backward-compat with old JSON. */
  verb?: string;
}

/** A learned protocol model over the abstracted symbol alphabet. */
export interface ProtocolModel {
  states: string[];
  transitions: Transition[];
  /** The parameter fields abstracted away during templating (token/id/timestamp). */
  abstraction: string[];
}

/**
 * A forward branch at a state: the planner has 2+ DISTINCT verbs that each lead to a DIFFERENT
 * successor state. `note` explains why it was classified (spurious merge artifact vs genuine branch).
 */
export interface AmbiguousState {
  state: string;
  verbs: string[];
  note: string;
}

/** Report produced by compile(): coverage, safety, and what was held out. */
export interface CompileReport {
  coverage: number;
  unsafeContinuationRate: number;
  passed: boolean;
  heldOutSessions: number;
  /**
   * True when a forward branch under the GIVEN abstraction DISAPPEARS under the finer auto-namespaced
   * abstraction: the branch is a spurious merge artifact and the planner could guess. Callers should
   * re-infer/compile with responseNamespace:'auto' (or 'by-verb') to remove it. Only meaningful when
   * compile() was given `sessions` to compare against.
   */
  requiresFinerAbstraction?: boolean;
  /** Forward branches judged to be spurious merge artifacts (vanish under the finer abstraction). */
  ambiguousStates?: AmbiguousState[];
  /** Forward branches that SURVIVE the finer abstraction: genuine protocol branches, allowed. */
  genuineBranches?: AmbiguousState[];
}
