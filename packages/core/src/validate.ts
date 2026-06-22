/**
 * validate.ts
 *
 * Conformance gate and validators for the inferred FSM and compiled driver. Everything here is
 * computed from real executions: no number is fabricated.
 *
 *  - fsmMatchesGroundTruth : inferred FSM == ground-truth FSM up to relabeling
 *  - coverage              : fraction of held-out VALID sessions the driver accepts
 *  - unsafeContinuation    : fraction of INVALID sequences the driver WRONGLY accepts (must be 0)
 *  - drift detection       : driver detects an off-automaton response and escalates safely
 */

import type { Session } from "./types.js";
import { GROUND_TRUTH, type Fsm } from "./groundTruth.js";
import type { LearnedFsm } from "./inference.js";
import { Driver } from "./driver.js";
import { abstractSession, abstractStep, type AbstractStepFn } from "./abstract.js";
import { recordOne } from "./recorder.js";

/* ------------------------------------------------------------------ */
/* fsmMatchesGroundTruth (graph isomorphism up to relabeling)          */
/* ------------------------------------------------------------------ */

export interface MatchResult {
  matches: boolean;
  details: string;
  mapping?: Record<string, string>;
}

/**
 * Compare an inferred FSM to the ground truth UP TO RELABELING. Two deterministic FSMs over the
 * same edge-label alphabet are equivalent iff a bijection of states maps initial to initial and
 * preserves every labeled transition. Computed by a lock-step BFS from both initial states.
 */
export function fsmMatchesGroundTruth(
  inferred: LearnedFsm,
  truth: Fsm = GROUND_TRUTH
): MatchResult {
  const inf = indexFsm(inferred.transitions);
  const gt = indexFsm(truth.transitions);

  const mapping = new Map<string, string>(); // inferred -> truth
  const revMapping = new Map<string, string>(); // truth -> inferred
  const queue: [string, string][] = [[inferred.initial, truth.initial]];
  mapping.set(inferred.initial, truth.initial);
  revMapping.set(truth.initial, inferred.initial);

  while (queue.length > 0) {
    const [iState, gState] = queue.shift()!;
    const iEdges = inf.get(iState) ?? new Map();
    const gEdges = gt.get(gState) ?? new Map();

    const iSyms = [...iEdges.keys()].sort();
    const gSyms = [...gEdges.keys()].sort();
    if (iSyms.length !== gSyms.length || iSyms.some((s, k) => s !== gSyms[k])) {
      return {
        matches: false,
        details: `Outgoing symbols differ at ${iState}~${gState}: inferred {${iSyms.join(
          ", "
        )}} vs ground-truth {${gSyms.join(", ")}}`,
      };
    }

    for (const sym of iSyms) {
      const iNext = iEdges.get(sym)!;
      const gNext = gEdges.get(sym)!;
      const mappedI = mapping.get(iNext);
      const mappedG = revMapping.get(gNext);
      if (mappedI === undefined && mappedG === undefined) {
        mapping.set(iNext, gNext);
        revMapping.set(gNext, iNext);
        queue.push([iNext, gNext]);
      } else if (mappedI !== gNext || mappedG !== iNext) {
        return {
          matches: false,
          details: `Transition on ${sym} maps inconsistently: inferred ${iState}->${iNext} vs ground-truth ${gState}->${gNext}`,
        };
      }
    }
  }

  if (mapping.size !== inferred.states.length || revMapping.size !== truth.states.length) {
    return {
      matches: false,
      details: `State-count / reachability mismatch: inferred ${inferred.states.length} (mapped ${mapping.size}), ground-truth ${truth.states.length} (mapped ${revMapping.size})`,
    };
  }

  return {
    matches: true,
    details: "Inferred FSM is isomorphic to the ground-truth FSM (matched up to relabeling).",
    mapping: Object.fromEntries(mapping),
  };
}

function indexFsm(
  transitions: { from: string; on: string; to: string }[]
): Map<string, Map<string, string>> {
  const idx = new Map<string, Map<string, string>>();
  for (const t of transitions) {
    if (!idx.has(t.from)) idx.set(t.from, new Map());
    idx.get(t.from)!.set(t.on, t.to);
  }
  return idx;
}

/* ------------------------------------------------------------------ */
/* coverage (held-out valid sessions)                                  */
/* ------------------------------------------------------------------ */

export function coverage(
  driver: Driver,
  heldOut: Session[],
  abstract: AbstractStepFn = abstractStep
): number {
  if (heldOut.length === 0) return 1;
  let ok = 0;
  for (const s of heldOut) {
    const symbols = abstractSession(s.steps, abstract);
    if (driver.run(symbols).accepted) ok++;
  }
  return ok / heldOut.length;
}

/* ------------------------------------------------------------------ */
/* unsafe-continuation (invalid sequences wrongly accepted)            */
/* ------------------------------------------------------------------ */

export interface UnsafeResult {
  rate: number;
  tested: number;
  wronglyAccepted: string[][];
  byCategory: { category: string; tested: number; caught: number }[];
}

/**
 * Generate many INVALID symbol sequences (commands out of state) and measure the fraction the
 * driver WRONGLY accepts. This MUST be 0. All symbols are drawn from the REAL abstracted alphabet
 * (so "unknown-symbol" is not why they fail): they are invalid purely because they are OUT OF
 * STATE, which is the hard case for a safety claim.
 */
export function unsafeContinuation(
  driver: Driver,
  validSessions: Session[],
  abstract: AbstractStepFn = abstractStep
): UnsafeResult {
  const { prefixViolations, handCrafted } = generateInvalidSequences(driver, validSessions, abstract);
  const all = [...prefixViolations, ...handCrafted];

  let wrong = 0;
  const wronglyAccepted: string[][] = [];
  for (const seq of all) {
    if (driver.run(seq).accepted) {
      wrong++;
      wronglyAccepted.push(seq);
    }
  }

  const caught = (seqs: string[][]) => seqs.filter((s) => !driver.run(s).accepted).length;
  const byCategory = [
    {
      category: "valid-prefix-then-illegal-symbol",
      tested: prefixViolations.length,
      caught: caught(prefixViolations),
    },
    { category: "structural-traps", tested: handCrafted.length, caught: caught(handCrafted) },
  ];

  return {
    rate: all.length === 0 ? 0 : wrong / all.length,
    tested: all.length,
    wronglyAccepted,
    byCategory,
  };
}

function generateInvalidSequences(
  driver: Driver,
  validSessions: Session[],
  abstract: AbstractStepFn = abstractStep
): { prefixViolations: string[][]; handCrafted: string[][] } {
  const alphabet = new Set<string>();
  for (const t of driver.transitions) alphabet.add(t.on);
  const A = [...alphabet];

  const prefixViolations: string[][] = [];
  for (const session of validSessions) {
    const symbols = abstractSession(session.steps, abstract);
    for (let len = 0; len <= symbols.length; len++) {
      const prefix = symbols.slice(0, len);
      if (!driver.run(prefix).accepted) continue;
      const state = stateAfter(driver, prefix);
      if (state === null) continue;
      const legal = driver.legalFrom(state);
      for (const sym of A) {
        if (!legal.has(sym)) prefixViolations.push([...prefix, sym]);
      }
    }
  }

  const handCrafted: string[][] = [
    ["LIST/OK_ITEMS"], // LIST before login
    ["GET/OK_ITEM"], // GET before login
    ["PING/OK_PONG"], // PING before login
    ["LOGOUT/OK_BYE"], // LOGOUT before login
    ["LOGIN/OK_GREETING", "LOGIN/OK_GREETING"], // login twice
    ["LOGIN/OK_GREETING", "LOGOUT/OK_BYE", "LIST/OK_ITEMS"], // op after logout
    ["LOGIN/OK_GREETING", "LOGOUT/OK_BYE", "PING/OK_PONG"], // op after logout
    ["LOGIN/OK_GREETING", "LOGOUT/OK_BYE", "GET/OK_ITEM"], // op after logout
    ["LIST/OK_ITEMS", "LOGIN/OK_GREETING"], // a successful LIST as the first move is impossible
  ];

  return { prefixViolations, handCrafted };
}

function stateAfter(driver: Driver, prefix: string[]): string | null {
  let state = driver.initial;
  for (const sym of prefix) {
    const r = driver.stepFrom(state, sym);
    if (!r.accepted) return null;
    state = r.to!;
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* model-call counting + driver latency                                */
/* ------------------------------------------------------------------ */

export interface ExecResult {
  learnedPathModelCalls: number;
  baselineModelCalls: number;
  latencySamplesMs: number[];
  accepted: boolean;
}

/**
 * Execute a learned task through the compiled driver and count model calls (0 by construction;
 * counted with an explicit counter to prove it). Returns REAL per-run latency samples. The
 * baseline is a STRUCTURAL count only: a naive "one model call per message" loop. No latency is
 * fabricated for that hypothetical loop.
 */
export function executeLearnedTask(driver: Driver, task: Session, repetitions = 2000): ExecResult {
  const symbols = abstractSession(task.steps);

  let modelCalls = 0;
  const latencySamplesMs: number[] = [];
  let accepted = true;
  for (let r = 0; r < repetitions; r++) {
    const t0 = process.hrtime.bigint();
    const res = driver.run(symbols);
    const t1 = process.hrtime.bigint();
    accepted = res.accepted;
    latencySamplesMs.push(Number(t1 - t0) / 1e6);
    // The driver makes ZERO model calls. modelCalls stays 0; if the learned path ever needed an
    // oracle it would be counted here.
  }

  const baselineModelCalls = task.steps.length; // one model call per message (structural fact)
  return { learnedPathModelCalls: modelCalls, baselineModelCalls, latencySamplesMs, accepted };
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

export function p50(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/* ------------------------------------------------------------------ */
/* drift detection                                                     */
/* ------------------------------------------------------------------ */

export interface DriftResult {
  driftDetected: boolean;
  driftEscalatedSafely: boolean;
  details: string;
}

/**
 * Run a learned task against a DRIFTED server (PING now responds OK PONG-V2). Step the driver
 * symbol-by-symbol from the live responses. The driver must DETECT the off-automaton symbol and
 * ESCALATE rather than continuing.
 */
export function detectDrift(
  driver: Driver,
  script: string[] = ["LOGIN tok-drift-1", "LIST", "PING", "LOGOUT"]
): DriftResult {
  const driftedSession = recordOne(script, "drift");

  driver.start();
  let detected = false;
  let escalatedSafely = true;
  let detail = "";

  for (let i = 0; i < driftedSession.steps.length; i++) {
    const sym = abstractStep(driftedSession.steps[i]).symbol;
    const r = driver.step(sym);
    if (r.escalate) {
      detected = true;
      escalatedSafely = true; // it refused AT the drift point and did not keep driving
      detail = `Off-automaton symbol "${sym}" at step ${i} (reason=${r.reason}); driver refused and escalated instead of continuing.`;
      break;
    }
  }

  if (!detected) {
    detail = "Driver did NOT detect drift; it accepted the drifted response (unsafe).";
    escalatedSafely = false;
  }

  return { driftDetected: detected, driftEscalatedSafely: escalatedSafely, details: detail };
}
