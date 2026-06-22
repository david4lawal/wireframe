/**
 * compile.ts
 *
 * The public infer()/compile() entry points.
 *
 *   infer(sessions, opts)  : abstract sessions to symbol traces, run the chosen merge strategy,
 *                            return a ProtocolModel.
 *   compile(model, opts)   : build a Driver, gate on coverage, report safety. passed = coverage
 *                            >= gate AND unsafeContinuationRate === 0.
 */

import type { Session, ProtocolModel, CompileReport, Transition } from "./types.js";
import { abstractStep, PARAMETER_FIELDS, type AbstractStepFn } from "./abstract.js";
import { inferFsm, type MergeMode } from "./inference.js";
import { Driver } from "./driver.js";
import { coverage as coverageOf, unsafeContinuation } from "./validate.js";

export interface InferOptions {
  merge?: MergeMode;
  k?: number;
  /** Abstraction function used to turn concrete steps into symbols. Defaults to the text abstractStep. */
  abstract?: AbstractStepFn;
}

/** Derive the request verb from a symbol "VERB/RESPONSE_TYPE" (fallback when no map entry exists). */
function verbFromSymbol(symbol: string): string {
  return symbol.split("/")[0] ?? "";
}

/** Infer a protocol model from observed sessions. Default merge strategy is evidence-driven red-blue. */
export function infer(sessions: Session[], opts: InferOptions = {}): ProtocolModel {
  const mode: MergeMode = opts.merge ?? "red-blue";
  const k = opts.k ?? 2;
  const abstract = opts.abstract ?? abstractStep;

  // Abstract every training step, building both the symbol traces AND a symbol -> verb map so we
  // can attach the request verb to each learned transition (action selection planning uses it).
  const symbolToVerb = new Map<string, string>();
  const traces = sessions.map((s) =>
    s.steps.map((step) => {
      const a = abstract(step);
      if (!symbolToVerb.has(a.symbol)) symbolToVerb.set(a.symbol, a.verb);
      return a.symbol;
    })
  );

  const fsm = inferFsm(traces, mode, k);
  const transitions: Transition[] = fsm.transitions.map((t) => ({
    ...t,
    verb: symbolToVerb.get(t.on) ?? verbFromSymbol(t.on),
  }));
  return {
    states: fsm.states,
    transitions,
    abstraction: [...PARAMETER_FIELDS],
  };
}

export interface CompileOptions {
  coverageGate: number;
  heldOut: Session[];
  /** Abstraction function used to validate held-out sessions. MUST match the one used to infer(). */
  abstract?: AbstractStepFn;
}

/**
 * Compile a model into a deterministic Driver and report. `passed` is true iff coverage meets the
 * gate AND no invalid sequence is wrongly accepted (unsafeContinuationRate === 0). The invalid
 * battery is derived from the held-out valid sessions (out-of-state continuations of real prefixes).
 */
export function compile(
  model: ProtocolModel,
  opts: CompileOptions
): { driver: Driver; report: CompileReport } {
  const abstract = opts.abstract ?? abstractStep;
  const driver = Driver.fromModel(model);
  const cov = coverageOf(driver, opts.heldOut, abstract);
  const unsafe = unsafeContinuation(driver, opts.heldOut, abstract);
  const passed = cov >= opts.coverageGate && unsafe.rate === 0;
  return {
    driver,
    report: {
      coverage: cov,
      unsafeContinuationRate: unsafe.rate,
      passed,
      heldOutSessions: opts.heldOut.length,
    },
  };
}
