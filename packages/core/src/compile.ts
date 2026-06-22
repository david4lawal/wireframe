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

import type {
  Session,
  ProtocolModel,
  CompileReport,
  Transition,
  AmbiguousState,
} from "./types.js";
import {
  abstractStep,
  namespaceResponseType,
  PARAMETER_FIELDS,
  type AbstractStepFn,
  type ResponseNamespace,
} from "./abstract.js";
import { inferFsm, type MergeMode } from "./inference.js";
import { Driver } from "./driver.js";
import { coverage as coverageOf, unsafeContinuation } from "./validate.js";

export interface InferOptions {
  merge?: MergeMode;
  k?: number;
  /** Abstraction function used to turn concrete steps into symbols. Defaults to the text abstractStep. */
  abstract?: AbstractStepFn;
  /**
   * Response-namespacing policy applied ON TOP of `abstract`. Defaults to 'none'. With 'auto', the
   * sessions are pre-scanned and ONLY response types that occur under 2+ distinct verbs are
   * namespaced by verb (the rest are left untouched, so valid state merges are not blocked). With
   * 'by-verb', every response type is namespaced by its verb.
   */
  responseNamespace?: ResponseNamespace;
}

/* ------------------------------------------------------------------ */
/* Corpus-aware abstraction resolution (responseNamespace)             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the EFFECTIVE abstraction function for a policy, given the corpus. The returned function
 * is deterministic and corpus-specific, so the SAME instance MUST be used for both training
 * inference and held-out validation (otherwise symbols would not line up).
 *
 *  - 'none'    : the base abstraction unchanged.
 *  - 'by-verb' : wrap the base so every response type is suffixed with its verb.
 *  - 'auto'    : pre-scan `sessions`, find response types seen under 2+ DISTINCT verbs, and wrap the
 *                base so ONLY those are suffixed with the verb. Unambiguous response types pass
 *                through untouched, which avoids over-specializing and blocking valid merges.
 */
export function resolveAbstraction(
  sessions: Session[],
  policy: ResponseNamespace,
  base: AbstractStepFn = abstractStep
): AbstractStepFn {
  if (policy === "none") return base;

  if (policy === "by-verb") {
    return (step) => {
      const a = base(step);
      const responseType = namespaceResponseType(a.responseType, a.verb);
      return { symbol: `${a.verb}/${responseType}`, verb: a.verb, responseType };
    };
  }

  // 'auto': discover the ambiguous response types over the whole corpus first.
  const ambiguous = ambiguousResponseTypes(sessions, base);
  return (step) => {
    const a = base(step);
    if (!ambiguous.has(a.responseType)) return a; // unambiguous: leave untouched (allow merges)
    const responseType = namespaceResponseType(a.responseType, a.verb);
    return { symbol: `${a.verb}/${responseType}`, verb: a.verb, responseType };
  };
}

/**
 * Response types that occur under 2 OR MORE DISTINCT verbs across the corpus. These are the coarse
 * codes (SMTP's 250 after EHLO / MAIL FROM / RCPT TO / message-accept) that over-merge distinct
 * states when left status-only. Only these get namespaced under 'auto'.
 */
export function ambiguousResponseTypes(
  sessions: Session[],
  base: AbstractStepFn = abstractStep
): Set<string> {
  const verbsByResponse = new Map<string, Set<string>>();
  for (const s of sessions) {
    for (const step of s.steps) {
      const a = base(step);
      let verbs = verbsByResponse.get(a.responseType);
      if (!verbs) {
        verbs = new Set<string>();
        verbsByResponse.set(a.responseType, verbs);
      }
      verbs.add(a.verb);
    }
  }
  const ambiguous = new Set<string>();
  for (const [responseType, verbs] of verbsByResponse) {
    if (verbs.size >= 2) ambiguous.add(responseType);
  }
  return ambiguous;
}

/** Derive the request verb from a symbol "VERB/RESPONSE_TYPE" (fallback when no map entry exists). */
function verbFromSymbol(symbol: string): string {
  return symbol.split("/")[0] ?? "";
}

/** Infer a protocol model from observed sessions. Default merge strategy is evidence-driven red-blue. */
export function infer(sessions: Session[], opts: InferOptions = {}): ProtocolModel {
  const mode: MergeMode = opts.merge ?? "red-blue";
  const k = opts.k ?? 2;
  const base = opts.abstract ?? abstractStep;
  // Apply the response-namespacing policy (default 'none' -> base unchanged). For 'auto' this scans
  // the corpus once to decide which response types are ambiguous.
  const abstract = resolveAbstraction(sessions, opts.responseNamespace ?? "none", base);

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
  /**
   * Response-namespacing policy used by held-out validation. MUST match the policy passed to
   * infer(). When 'auto', the abstraction is re-resolved over `sessions` (so it lines up with the
   * finer abstraction the gate compares against). Defaults to 'none'.
   */
  responseNamespace?: ResponseNamespace;
  /**
   * The TRAINING sessions, used ONLY by the forward-ambiguity gate to re-infer a finer
   * (auto-namespaced) abstraction and compare against it. If omitted, the gate still reports raw
   * forward branches but cannot tell spurious merge artifacts from genuine branches.
   */
  sessions?: Session[];
}

/**
 * Compile a model into a deterministic Driver and report. `passed` is true iff coverage meets the
 * gate AND no invalid sequence is wrongly accepted (unsafeContinuationRate === 0) AND the
 * forward-ambiguity gate finds no spurious merge artifact (requiresFinerAbstraction stays false).
 * The invalid battery is derived from the held-out valid sessions (out-of-state continuations of
 * real prefixes).
 */
export function compile(
  model: ProtocolModel,
  opts: CompileOptions
): { driver: Driver; report: CompileReport } {
  const policy = opts.responseNamespace ?? "none";
  // Held-out validation must use the SAME abstraction the model was inferred with. When the policy
  // is 'auto' we re-resolve over the training sessions if available, else over the held-out set.
  const base = opts.abstract ?? abstractStep;
  const abstractCorpus = opts.sessions ?? opts.heldOut;
  const abstract = resolveAbstraction(abstractCorpus, policy, base);

  const driver = Driver.fromModel(model);
  const cov = coverageOf(driver, opts.heldOut, abstract);
  const unsafe = unsafeContinuation(driver, opts.heldOut, abstract);

  // Forward-ambiguity safety gate: never let nextCommand guess among tied progress verbs that only
  // appear distinct because a coarse abstraction over-merged their successors.
  const ambiguity = analyzePlanAmbiguity(model, {
    sessions: opts.sessions,
    abstract: base,
    finerPolicy: "auto",
  });

  const passed =
    cov >= opts.coverageGate && unsafe.rate === 0 && !ambiguity.requiresFinerAbstraction;

  const report: CompileReport = {
    coverage: cov,
    unsafeContinuationRate: unsafe.rate,
    passed,
    heldOutSessions: opts.heldOut.length,
    requiresFinerAbstraction: ambiguity.requiresFinerAbstraction,
    ambiguousStates: ambiguity.ambiguousStates,
    genuineBranches: ambiguity.genuineBranches,
  };
  return { driver, report };
}

/* ------------------------------------------------------------------ */
/* Forward-ambiguity analysis (the safety gate)                        */
/* ------------------------------------------------------------------ */

/** Outcome of analyzePlanAmbiguity: which forward branches are spurious vs genuine. */
export interface PlanAmbiguityReport {
  /** True iff at least one forward branch is a spurious merge artifact (vanishes under finer abs). */
  requiresFinerAbstraction: boolean;
  /** Forward branches that disappear under the finer abstraction (spurious merge artifacts). */
  ambiguousStates: AmbiguousState[];
  /** Forward branches that survive the finer abstraction (genuine protocol branches, allowed). */
  genuineBranches: AmbiguousState[];
  /** Every raw forward branch found under the GIVEN abstraction (spurious + genuine + unknown). */
  rawForwardBranches: AmbiguousState[];
}

interface AnalyzeOptions {
  /** Training sessions used to re-infer the finer abstraction. If omitted, no comparison is made. */
  sessions?: Session[];
  /** Base abstraction (pre-namespacing) the GIVEN model was inferred with. Defaults to abstractStep. */
  abstract?: AbstractStepFn;
  /** Policy for the finer comparison abstraction. Defaults to 'auto'. */
  finerPolicy?: ResponseNamespace;
}

/**
 * A forward branch at state S: 2+ DISTINCT verbs that EACH lead to a DIFFERENT successor (to != S).
 * Self-loops (to == S) and optional repeats do NOT count, because the planner already prefers
 * progress edges, so a single progress verb is unambiguous and safe. Returns one entry per state
 * with such a branch, listing the offending verbs (sorted) and the distinct successor states.
 */
export function forwardBranches(model: ProtocolModel): { state: string; verbs: string[]; successors: string[] }[] {
  // Per state: verb -> set of DISTINCT progress successor states (to != from).
  const progress = new Map<string, Map<string, Set<string>>>();
  for (const t of model.transitions) {
    if (t.to === t.from) continue; // self-loop: not progress
    const verb = t.verb ?? t.on.split("/")[0] ?? "";
    let byVerb = progress.get(t.from);
    if (!byVerb) {
      byVerb = new Map();
      progress.set(t.from, byVerb);
    }
    let succ = byVerb.get(verb);
    if (!succ) {
      succ = new Set();
      byVerb.set(verb, succ);
    }
    succ.add(t.to);
  }

  const out: { state: string; verbs: string[]; successors: string[] }[] = [];
  for (const [state, byVerb] of progress) {
    // Distinct progress verbs that lead off this state.
    const verbs = [...byVerb.keys()];
    if (verbs.length < 2) continue; // a single progress verb is unambiguous
    // The union of successor states reached by these verbs; a forward branch needs 2+ distinct ones.
    const successors = new Set<string>();
    for (const succ of byVerb.values()) for (const s of succ) successors.add(s);
    if (successors.size < 2) continue; // all verbs lead to the SAME successor: not a real branch
    out.push({
      state,
      verbs: verbs.sort(),
      successors: [...successors].sort(),
    });
  }
  // Stable order for deterministic reports.
  out.sort((a, b) => a.state.localeCompare(b.state));
  return out;
}

/**
 * Classify each forward branch of `model` as a SPURIOUS merge artifact or a GENUINE protocol branch
 * by comparing against a FINER abstraction (auto-namespaced) re-inferred over the same sessions.
 *
 * The comparison is structural (state names are not stable across inferences): for each forward
 * branch state, find a representative verb-prefix that reaches it in the GIVEN model, replay that
 * same verb-prefix in the FINER model, and check whether the SAME branching verbs still lead to
 * 2+ distinct successors there. If the branch vanishes under the finer abstraction, the coarse one
 * had over-merged distinct states into one (spurious). If it survives, it is a real branch (allowed).
 *
 * When `sessions` is omitted there is nothing finer to compare against: every raw forward branch is
 * reported under rawForwardBranches and treated as unknown (NOT failed), per the spec.
 */
export function analyzePlanAmbiguity(
  model: ProtocolModel,
  opts: AnalyzeOptions = {}
): PlanAmbiguityReport {
  const raw = forwardBranches(model).map<AmbiguousState>((b) => ({
    state: b.state,
    verbs: b.verbs,
    note: `${b.verbs.length} progress verbs lead to ${b.successors.length} distinct successors (${b.successors.join(", ")}).`,
  }));

  // No sessions to compare against: report raw branches, do not classify, do not fail.
  if (!opts.sessions || opts.sessions.length === 0) {
    return {
      requiresFinerAbstraction: false,
      ambiguousStates: [],
      genuineBranches: [],
      rawForwardBranches: raw,
    };
  }

  const base = opts.abstract ?? abstractStep;
  const finerPolicy = opts.finerPolicy ?? "auto";
  const finerAbstract = resolveAbstraction(opts.sessions, finerPolicy, base);
  const finerModel = inferModelWith(opts.sessions, finerAbstract);
  const finerDriver = Driver.fromModel(finerModel);

  const givenDriver = Driver.fromModel(model);
  const branches = forwardBranches(model);

  const ambiguousStates: AmbiguousState[] = [];
  const genuineBranches: AmbiguousState[] = [];

  for (const branch of branches) {
    const prefix = verbPathTo(givenDriver, branch.state);
    const survives =
      prefix !== null && branchSurvives(finerDriver, prefix, branch.verbs);
    if (survives) {
      genuineBranches.push({
        state: branch.state,
        verbs: branch.verbs,
        note: `Survives the finer (auto-namespaced) abstraction: a genuine protocol branch. Distinct successors: ${branch.successors.join(", ")}.`,
      });
    } else {
      ambiguousStates.push({
        state: branch.state,
        verbs: branch.verbs,
        note: `Disappears under the finer (auto-namespaced) abstraction: a spurious merge artifact. The coarse abstraction over-merged distinct states (e.g. a coarse success code reused across verbs), exposing ${branch.verbs.join(", ")} too early.`,
      });
    }
  }

  return {
    requiresFinerAbstraction: ambiguousStates.length > 0,
    ambiguousStates,
    genuineBranches,
    rawForwardBranches: raw,
  };
}

/** Infer a ProtocolModel directly from sessions with an explicit (already-resolved) abstraction. */
function inferModelWith(sessions: Session[], abstract: AbstractStepFn): ProtocolModel {
  const symbolToVerb = new Map<string, string>();
  const traces = sessions.map((s) =>
    s.steps.map((step) => {
      const a = abstract(step);
      if (!symbolToVerb.has(a.symbol)) symbolToVerb.set(a.symbol, a.verb);
      return a.symbol;
    })
  );
  const fsm = inferFsm(traces, "red-blue", 2);
  const transitions: Transition[] = fsm.transitions.map((t) => ({
    ...t,
    verb: symbolToVerb.get(t.on) ?? verbFromSymbol(t.on),
  }));
  return { states: fsm.states, transitions, abstraction: [...PARAMETER_FIELDS] };
}

/**
 * Shortest verb-prefix that reaches `target` from the driver's initial state, following progress
 * edges only (to != from). Returns the list of verbs, or null if `target` is unreachable. BFS over
 * the verb-labeled state graph; the initial state returns the empty prefix.
 */
function verbPathTo(driver: Driver, target: string): string[] | null {
  if (target === driver.initial) return [];
  const visited = new Set<string>([driver.initial]);
  const queue: { state: string; path: string[] }[] = [{ state: driver.initial, path: [] }];
  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    const edges = progressVerbEdges(driver, state);
    for (const e of edges) {
      if (e.to === target) return [...path, e.verb];
      if (!visited.has(e.to)) {
        visited.add(e.to);
        queue.push({ state: e.to, path: [...path, e.verb] });
      }
    }
  }
  return null;
}

/**
 * Replay a verb-prefix through the FINER model and check whether the reached state STILL has a
 * forward branch on the SAME branching verbs (each leading to a distinct, non-self successor). If
 * the prefix cannot be followed (a verb is missing because the finer abstraction split the path),
 * the branch is treated as NOT surviving (spurious): the over-merged structure is gone.
 */
function branchSurvives(finer: Driver, prefix: string[], verbs: string[]): boolean {
  let state = finer.initial;
  for (const verb of prefix) {
    const edges = progressVerbEdges(finer, state);
    const match = edges.find((e) => e.verb === verb);
    if (!match) return false; // path diverged: the coarse branch's prefix no longer exists
    state = match.to;
  }
  const edges = progressVerbEdges(finer, state);
  const successorsByVerb = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!verbs.includes(e.verb)) continue;
    let s = successorsByVerb.get(e.verb);
    if (!s) {
      s = new Set();
      successorsByVerb.set(e.verb, s);
    }
    s.add(e.to);
  }
  // Surviving forward branch: 2+ of the original verbs present here AND leading to 2+ successors.
  if (successorsByVerb.size < 2) return false;
  const successors = new Set<string>();
  for (const s of successorsByVerb.values()) for (const x of s) successors.add(x);
  return successors.size >= 2;
}

/** Progress (non-self-loop) verb edges out of `state`, deduplicated by (verb -> to). */
function progressVerbEdges(driver: Driver, state: string): { verb: string; to: string }[] {
  const out: { verb: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const t of driver.transitions) {
    if (t.from !== state) continue;
    if (t.to === state) continue; // self-loop is not progress
    const verb = t.verb ?? t.on.split("/")[0] ?? "";
    const key = `${verb}->${t.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ verb, to: t.to });
  }
  return out;
}
