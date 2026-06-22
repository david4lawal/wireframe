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

import type { Session, ProtocolModel, CompileReport } from "./types.js";
import { abstractSession, PARAMETER_FIELDS } from "./abstract.js";
import { inferFsm, type MergeMode } from "./inference.js";
import { Driver } from "./driver.js";
import { coverage as coverageOf, unsafeContinuation } from "./validate.js";

export interface InferOptions {
  merge?: MergeMode;
  k?: number;
}

/** Infer a protocol model from observed sessions. Default merge strategy is evidence-driven red-blue. */
export function infer(sessions: Session[], opts: InferOptions = {}): ProtocolModel {
  const mode: MergeMode = opts.merge ?? "red-blue";
  const k = opts.k ?? 2;
  const traces = sessions.map((s) => abstractSession(s.steps));
  const fsm = inferFsm(traces, mode, k);
  return {
    states: fsm.states,
    transitions: fsm.transitions,
    abstraction: [...PARAMETER_FIELDS],
  };
}

export interface CompileOptions {
  coverageGate: number;
  heldOut: Session[];
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
  const driver = Driver.fromModel(model);
  const cov = coverageOf(driver, opts.heldOut);
  const unsafe = unsafeContinuation(driver, opts.heldOut);
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
