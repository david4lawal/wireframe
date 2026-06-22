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

/** Report produced by compile(): coverage, safety, and what was held out. */
export interface CompileReport {
  coverage: number;
  unsafeContinuationRate: number;
  passed: boolean;
  heldOutSessions: number;
}
