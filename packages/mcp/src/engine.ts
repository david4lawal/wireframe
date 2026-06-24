/**
 * engine.ts
 *
 * The Wireframe engine the MCP tools and the demo BOTH call. It owns:
 *   - a per-protocol store persisted to a `.wframe` directory (JSON on disk), so state is shared
 *     across separate MCP tool invocations (each tool call is its own process spawn / message);
 *   - the live in-process target session created when learning a protocol (one black box per
 *     protocol, recording every send/response into the current session);
 *   - the infer -> compile pipeline (using @wframe/core EXACTLY as documented), with the coverage +
 *     forward-ambiguity safety gates;
 *   - the deterministic run loop that drives the compiled Driver toward a goal with ZERO model calls.
 *
 * Each exported function maps 1:1 onto one MCP tool, and the demo calls these same functions, so the
 * demo exercises the SAME code paths the tools do.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  infer,
  compile,
  Driver,
  abstractStep,
  resolveAbstraction,
  type Session,
  type Step,
  type CompileReport,
  type ResponseNamespace,
  type Goal,
} from "@wframe/core";

import { makeTarget, registeredTargets, OPS_VOCABULARY, type Target, type OpsTargetOptions } from "./target.js";

/* ------------------------------------------------------------------ */
/* Persisted protocol record.                                          */
/* ------------------------------------------------------------------ */

/** Everything we persist about one learned protocol. The live Target session is NOT persisted. */
export interface ProtocolRecord {
  name: string;
  /** The in-process target name this protocol drives (e.g. "ops"). */
  target: string;
  /** Response-namespacing policy used for inference + compilation. */
  responseNamespace: ResponseNamespace;
  /** Recorded sessions used for inference (a held-out slice is split off at compile time). */
  sessions: Session[];
  /** The compiled driver's serialized form, present once compiled and gate-passing. */
  driver?: ReturnType<Driver["toJSON"]>;
  /** The last compile report, present once compiled. */
  report?: CompileReport;
  /** ISO timestamps for status. */
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Engine: store + live sessions, rooted at a .wframe directory.       */
/* ------------------------------------------------------------------ */

export class Engine {
  readonly dir: string;
  /** Live target sessions, keyed by protocol name. Rebuilt lazily; never persisted. */
  private live = new Map<string, { target: Target; steps: Step[] }>();

  constructor(rootDir: string) {
    this.dir = join(rootDir, ".wframe");
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(name: string): string {
    return join(this.dir, `${safeName(name)}.json`);
  }

  /** Load a protocol record from disk, or undefined if it does not exist. */
  load(name: string): ProtocolRecord | undefined {
    const p = this.pathFor(name);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as ProtocolRecord;
  }

  /** Persist a protocol record to disk. */
  save(record: ProtocolRecord): void {
    record.updatedAt = new Date().toISOString();
    writeFileSync(this.pathFor(record.name), JSON.stringify(record, null, 2) + "\n", "utf8");
  }

  /** List every persisted protocol record. */
  list(): ProtocolRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as ProtocolRecord);
  }

  /** Get an existing record, or create a fresh empty one bound to `target`. */
  private getOrCreate(name: string, target: string, responseNamespace: ResponseNamespace): ProtocolRecord {
    const existing = this.load(name);
    if (existing) return existing;
    const now = new Date().toISOString();
    return {
      name,
      target,
      responseNamespace,
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tool: wireframe_step                                              */
  /* ---------------------------------------------------------------- */

  /**
   * During LEARNING, send a raw command to the target THROUGH Wireframe and record the step. The
   * first step of a session spins up a fresh black-box target instance; subsequent steps reuse it.
   * Returns the raw response plus the running step count, so an agent can keep driving the target
   * one command at a time and Wireframe captures the whole session.
   */
  step(
    protocol: string,
    target: string,
    command: string,
    opts: { responseNamespace?: ResponseNamespace; targetOptions?: OpsTargetOptions } = {}
  ): { response: string; stepCount: number; goalReached: boolean; phase: string } {
    const responseNamespace = opts.responseNamespace ?? "auto";
    // Ensure a record exists (binds the protocol to its target + policy).
    const record = this.getOrCreate(protocol, target, responseNamespace);
    if (!this.load(protocol)) this.save(record);

    // Get or start the live target session for this protocol.
    let session = this.live.get(protocol);
    if (!session) {
      const t = makeTarget(target, opts.targetOptions);
      if (!t) {
        throw new Error(
          `unknown target "${target}". Registered targets: ${registeredTargets().join(", ")}`
        );
      }
      session = { target: t, steps: [] };
      this.live.set(protocol, session);
    }

    const response = session.target.send(command);
    session.steps.push({ verb: command, response });
    return {
      response,
      stepCount: session.steps.length,
      goalReached: session.target.goalReached(),
      phase: session.target.phase(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tool: wireframe_record_done                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Mark the live session complete. The captured steps become one recorded Session appended to the
   * protocol's corpus, and the live target is discarded so the next wireframe_step starts fresh.
   */
  recordDone(protocol: string, outcome: "success" | "failure" = "success"): { recordedSteps: number; totalSessions: number } {
    const session = this.live.get(protocol);
    if (!session || session.steps.length === 0) {
      throw new Error(`no live session to finish for protocol "${protocol}" (call wireframe_step first)`);
    }
    const record = this.load(protocol);
    if (!record) throw new Error(`protocol "${protocol}" not found`);
    record.sessions.push({ steps: session.steps, outcome });
    this.save(record);
    this.live.delete(protocol);
    return { recordedSteps: session.steps.length, totalSessions: record.sessions.length };
  }

  /* ---------------------------------------------------------------- */
  /* Tool: wireframe_compile                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Run the documented THREE-STEP pipeline: ABSTRACT + INFER (infer) then COMPILE with the coverage
   * and forward-ambiguity safety gates (compile). Holds out a slice of the recorded sessions for
   * validation. Persists the compiled driver + report. Returns a compact summary.
   *
   * The SAME corpus-resolved abstraction is used for infer() and compile(), per the core's
   * abstraction-stability rule. `sessions` is passed to compile() so the forward-ambiguity gate can
   * compare against a finer auto-namespaced re-inference.
   */
  compileProtocol(
    protocol: string,
    opts: { coverageGate?: number } = {}
  ): {
    states: number;
    transitions: number;
    coverage: number;
    unsafeContinuationRate: number;
    requiresFinerAbstraction: boolean;
    passed: boolean;
    heldOutSessions: number;
    terminalStates: string[];
    responseNamespace: ResponseNamespace;
  } {
    const coverageGate = opts.coverageGate ?? 0.95;
    const record = this.load(protocol);
    if (!record) throw new Error(`protocol "${protocol}" not found`);
    if (record.sessions.length < 2) {
      throw new Error(
        `protocol "${protocol}" has ${record.sessions.length} session(s); need at least 2 (one to train, one to hold out)`
      );
    }

    const { train, heldOut } = splitHeldOut(record.sessions);
    const policy = record.responseNamespace;

    // infer() and compile() take the SAME base abstraction (abstractStep) and the SAME policy, so
    // both internally resolve the identical corpus-aware abstraction (the stability rule). For
    // 'auto', passing `sessions: train` lets the forward-ambiguity gate re-infer a finer model.
    const model = infer(train, { abstract: abstractStep, responseNamespace: policy });
    const { driver, report } = compile(model, {
      coverageGate,
      heldOut,
      abstract: abstractStep,
      responseNamespace: policy,
      sessions: train,
    });

    record.driver = driver.toJSON();
    record.report = report;
    this.save(record);

    return {
      states: model.states.length,
      transitions: model.transitions.length,
      coverage: report.coverage,
      unsafeContinuationRate: report.unsafeContinuationRate,
      requiresFinerAbstraction: report.requiresFinerAbstraction ?? false,
      passed: report.passed,
      heldOutSessions: report.heldOutSessions,
      terminalStates: driver.terminalStates(),
      responseNamespace: policy,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tool: wireframe_run                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Run the compiled driver deterministically toward `goal` against a FRESH target instance, with
   * ZERO model calls on the learned path.
   *
   * The action-selection split (both halves come from the LEARNED model, never a hardcoded
   * sequence) follows the proven Wireframe runner:
   *   - PROTOCOL ORDERING is chosen by driver.nextCommand(goal): which mandatory progress verb comes
   *     next (LOGIN -> START_ORDER -> ... -> VALIDATE -> SUBMIT -> FINALIZE). The driver will never
   *     propose SUBMIT before VALIDATE; that ordering is what it proves safe.
   *   - LOOP ITERATION (how many ADD_ITEM / SET_FIELD to issue) is task context. The COUNTS come from
   *     `task`; the legality of each is confirmed against the learned model via driver.legalFrom +
   *     a self-loop check, then a deterministic driver.step on the observed response.
   *   - RECOVERY branches (OUT_OF_STOCK -> SUBSTITUTE -> re-ADD, FIX_REQUIRED -> CORRECT -> re-REVIEW)
   *     are learned transitions the runner takes in REACTION to an observed recoverable error.
   *
   * A verb the model cannot place (unseen branch / drift), or an unknown goal/state, escalates: the
   * driver NEVER guesses. modelCallsUsed is 0 on the learned path — the whole point.
   */
  run(
    protocol: string,
    goal: string,
    opts: { targetOptions?: OpsTargetOptions; task?: { items: number; fields: number }; maxSteps?: number } = {}
  ): {
    goalState: string | { anyOf: string[] };
    commands: { command: string; symbol: string }[];
    deterministic: boolean;
    escalated: boolean;
    escalation?: { phase: "select" | "observe"; reason: string; verbs?: string[] };
    modelCallsUsed: number;
    wrongActions: number;
    reachedGoal: boolean;
    targetGoalReached: boolean;
    finalState: string;
  } {
    const record = this.load(protocol);
    if (!record) throw new Error(`protocol "${protocol}" not found`);
    if (!record.driver) throw new Error(`protocol "${protocol}" is not compiled (call wireframe_compile)`);

    const driver = Driver.fromJSON(record.driver);
    const target = makeTarget(record.target, opts.targetOptions);
    if (!target) throw new Error(`unknown target "${record.target}"`);

    const goalSpec = resolveGoal(goal, driver);
    const abstract = resolveAbstraction(record.sessions, record.responseNamespace, abstractStep);
    const wantItems = opts.task?.items ?? 2;
    const wantFields = opts.task?.fields ?? 2;
    const maxSteps = opts.maxSteps ?? 200;

    const commands: { command: string; symbol: string }[] = [];
    let escalated = false;
    let escalation: { phase: "select" | "observe"; reason: string; verbs?: string[] } | undefined;
    let reachedGoal = false;
    let wrongActions = 0;

    // Cursor derived ONLY from observed responses (never from target internals).
    const cursor = {
      itemsAdded: 0,
      fieldsSet: 0,
      reviewed: false,
      pendingSub: false,
      pendingCorrect: false,
    };

    /** Is `verb` a learned SELF-LOOP from the driver's current state (a loop-body action)? */
    const loopAvailable = (verb: string): boolean => {
      const state = driver.state();
      for (const sym of driver.legalFrom(state)) {
        if (sym.split("/")[0] === verb && driver.stepFrom(state, sym).to === state) return true;
      }
      return false;
    };
    /** Is `verb` a learned action (any successor) from the current state? Used for back-edges (CORRECT). */
    const legalAvailable = (verb: string): boolean => {
      const state = driver.state();
      for (const sym of driver.legalFrom(state)) if (sym.split("/")[0] === verb) return true;
      return false;
    };

    /** Issue one wire command, classify, step the driver, and bookkeep. Returns {fatal}. */
    const issue = (verb: string, params: { index?: number } = {}): { fatal: boolean } => {
      const wire = concretize(verb, params.index ?? commands.length);
      const response = target.send(wire);
      const a = abstract({ verb: wire, response });
      // A hard error after a driver-placed verb is a WRONG ACTION (the two recoverable branches are
      // legitimate learned transitions and are NOT wrong actions).
      const isErr = a.responseType.startsWith("ERR");
      const kind = a.responseType.replace(/^ERR_?/, "");
      if (isErr && kind !== "OUT_OF_STOCK" && kind !== "FIX_REQUIRED") {
        wrongActions += 1;
        commands.push({ command: wire, symbol: a.symbol });
        escalated = true;
        escalation = { phase: "observe", reason: `wrong-action:${a.responseType}` };
        return { fatal: true };
      }
      const r = driver.step(a.symbol);
      commands.push({ command: wire, symbol: a.symbol });
      if (r.escalate) {
        escalated = true;
        escalation = { phase: "observe", reason: r.reason ?? "drift" };
        return { fatal: true };
      }
      // Cursor updates derive ONLY from observed responses.
      if (verb === "ADD_ITEM" && !isErr) cursor.itemsAdded += 1;
      if (verb === "ADD_ITEM" && kind === "OUT_OF_STOCK") cursor.pendingSub = true;
      if (verb === "SUBSTITUTE") cursor.pendingSub = false;
      if (verb === "SET_FIELD" && !isErr) cursor.fieldsSet += 1;
      if (verb === "REVIEW" && !isErr) cursor.reviewed = true;
      if (verb === "REVIEW" && kind === "FIX_REQUIRED") cursor.pendingCorrect = true;
      if (verb === "CORRECT") cursor.pendingCorrect = false;
      return { fatal: false };
    };

    driver.start();
    for (let guard = 0; guard < maxSteps; guard++) {
      // Already at the goal? (cheap check before doing any loop work).
      if ("done" in driver.nextCommand(goalSpec)) {
        reachedGoal = true;
        break;
      }
      // 1. Resolve any pending recovery first (reacting to an observed recoverable error).
      if (cursor.pendingSub && loopAvailable("SUBSTITUTE")) {
        if (issue("SUBSTITUTE").fatal) break;
        if (issue("ADD_ITEM").fatal) break;
        continue;
      }
      if (cursor.pendingCorrect && legalAvailable("CORRECT")) {
        if (issue("CORRECT").fatal) break;
        continue;
      }
      // 2. Loop work dictated by task context, gated by what the learned state supports.
      if (cursor.itemsAdded < wantItems && loopAvailable("ADD_ITEM")) {
        if (issue("ADD_ITEM").fatal) break;
        continue;
      }
      if (cursor.fieldsSet < wantFields && loopAvailable("SET_FIELD")) {
        if (issue("SET_FIELD").fatal) break;
        continue;
      }
      // A clean REVIEW must precede VALIDATE. REVIEW is a self-loop; FIX_REQUIRED routes to CORRECT.
      if (cursor.itemsAdded >= wantItems && cursor.fieldsSet >= wantFields && !cursor.reviewed && loopAvailable("REVIEW")) {
        if (issue("REVIEW").fatal) break;
        continue;
      }
      // 3. No pending loop work the current state supports: ask the driver for the next ORDERING verb.
      const next = driver.nextCommand(goalSpec);
      if ("done" in next) {
        reachedGoal = true;
        break;
      }
      if ("escalate" in next) {
        escalated = true;
        escalation = { phase: "select", reason: next.reason, verbs: next.verbs };
        break;
      }
      if (issue(next.command).fatal) break;
    }

    return {
      goalState: typeof goalSpec === "string" ? goalSpec : { anyOf: (goalSpec as { anyOf: string[] }).anyOf },
      commands,
      deterministic: !escalated,
      escalated,
      escalation,
      modelCallsUsed: 0, // ZERO on the learned path — that is the whole point.
      wrongActions,
      reachedGoal,
      targetGoalReached: target.goalReached(),
      finalState: driver.state(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tool: wireframe_status                                           */
  /* ---------------------------------------------------------------- */

  /** Summarize every protocol: session count, compile/coverage/gate state, and live-session flag. */
  status(): {
    targets: string[];
    vocabulary: typeof OPS_VOCABULARY;
    protocols: {
      name: string;
      target: string;
      responseNamespace: ResponseNamespace;
      sessions: number;
      liveSessionOpen: boolean;
      compiled: boolean;
      coverage?: number;
      passed?: boolean;
      requiresFinerAbstraction?: boolean;
      updatedAt: string;
    }[];
  } {
    return {
      targets: registeredTargets(),
      vocabulary: OPS_VOCABULARY,
      protocols: this.list().map((r) => ({
        name: r.name,
        target: r.target,
        responseNamespace: r.responseNamespace,
        sessions: r.sessions.length,
        liveSessionOpen: this.live.has(r.name),
        compiled: !!r.driver,
        coverage: r.report?.coverage,
        passed: r.report?.passed,
        requiresFinerAbstraction: r.report?.requiresFinerAbstraction,
        updatedAt: r.updatedAt,
      })),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

/** Sanitize a protocol name into a safe filename. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Split recorded sessions into train/heldOut. Hold out a representative slice (the longest session,
 * which exercises the most transitions) so coverage is a real generalization check, keeping the rest
 * for training. With exactly 2 sessions, 1 trains and 1 is held out.
 */
function splitHeldOut(sessions: Session[]): { train: Session[]; heldOut: Session[] } {
  if (sessions.length < 2) return { train: sessions, heldOut: sessions };
  // Hold out the single longest session.
  let longest = 0;
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].steps.length > sessions[longest].steps.length) longest = i;
  }
  const heldOut = [sessions[longest]];
  const train = sessions.filter((_, i) => i !== longest);
  return { train, heldOut };
}

/**
 * Map a friendly goal alias to a learned state. The learned state names (q0, q1, ...) are not
 * stable across re-inferences, so we resolve a semantic goal ("submitted" / "validated" / "done")
 * to a state by structure:
 *   - "submitted"/"done"/"goal": the state reachable by a SUBMIT verb edge (its successor).
 *   - "validated": the state reachable by a VALIDATE verb edge.
 *   - "terminal": any terminal state (anyOf).
 *   - otherwise: treat the string as a literal state name.
 */
function resolveGoal(goal: string, driver: Driver): Goal {
  const g = goal.trim().toLowerCase();
  const successorOfVerb = (verb: string): string | undefined => {
    for (const t of driver.transitions) {
      if ((t.verb ?? t.on.split("/")[0]) === verb && t.to !== t.from) return t.to;
    }
    return undefined;
  };
  if (g === "submitted" || g === "done" || g === "goal" || g === "submit") {
    const s = successorOfVerb("SUBMIT");
    if (s) return s;
  }
  if (g === "validated" || g === "validate") {
    const s = successorOfVerb("VALIDATE");
    if (s) return s;
  }
  if (g === "terminal") {
    const terms = driver.terminalStates();
    if (terms.length > 0) return { anyOf: terms };
  }
  // Literal state name (or an unknown alias, which nextCommand will safely escalate on).
  return goal;
}

/**
 * Supply concrete params for an ops verb chosen by the driver. The driver decides WHICH verb; this
 * fills in a valid argument for the demo target. Parameterless verbs pass through unchanged.
 */
function concretize(verb: string, index: number): string {
  switch (verb) {
    case "ADD_ITEM":
      return `ADD_ITEM sku=SKU-${1000 + (index % 4)}`;
    case "SUBSTITUTE":
      return `SUBSTITUTE sku=SKU-${1000 + (index % 4)}`;
    case "SET_FIELD": {
      const names = ["ship_name", "ship_addr", "ship_city", "ship_zip", "bill_ref", "priority"];
      const name = names[index % names.length];
      return `SET_FIELD ${name}=value-${index}`;
    }
    default:
      return verb;
  }
}
