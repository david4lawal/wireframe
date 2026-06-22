/**
 * @wframe/core
 *
 * Infer a protocol FSM from black-box agent sessions, compile a safe deterministic driver, and
 * prove it. No LLM on the learned path.
 *
 * Pipeline: record sessions -> abstract (templating) -> infer (APTA + evidence-driven red-blue
 * merging) -> compile (coverage gate + safety) -> drive (pure code, zero model calls, safe drift
 * escalation).
 */

// Public data types.
export type { Step, Session, ProtocolModel, CompileReport, Transition } from "./types.js";

// Recording.
export { Recorder, record, recordMockSessions, recordOne, MOCK_SCRIPTS } from "./recorder.js";

// Inference and compilation.
export { infer } from "./compile.js";
export type { InferOptions } from "./compile.js";
export { compile } from "./compile.js";
export type { CompileOptions } from "./compile.js";
export { inferFsm } from "./inference.js";
export type { LearnedFsm, MergeMode } from "./inference.js";

// The compiled driver.
export { Driver } from "./driver.js";
export type { DriverStepResult, Goal, NextCommand } from "./driver.js";

// Abstraction (parameter templating).
export {
  abstractStep,
  abstractSession,
  abstractVerb,
  abstractResponse,
  PARAMETER_FIELDS,
} from "./abstract.js";
export type { AbstractStepFn } from "./abstract.js";

// HTTP transport + structural HTTP abstraction (REST / GraphQL).
export { HttpAdapter, abstractHttpStep, makeAbstractHttpStep } from "./http.js";
export type { HttpRequest, HttpAbstractOptions } from "./http.js";

// Ground truth (for verification and the bench).
export { GROUND_TRUTH, fsmStats } from "./groundTruth.js";
export type { Fsm } from "./groundTruth.js";

// Validators.
export {
  fsmMatchesGroundTruth,
  coverage,
  unsafeContinuation,
  executeLearnedTask,
  detectDrift,
  p50,
  percentile,
} from "./validate.js";
export type { MatchResult, UnsafeResult, ExecResult, DriftResult } from "./validate.js";

// Transport adapters.
export { MockAdapter, WebSocketAdapter, TcpAdapter } from "./adapters.js";
export type { Adapter } from "./adapters.js";

// Mock protocol (used by the MockAdapter and the bench).
export { MockConnection } from "./mock.js";
export type { ServerVariant, ServerOptions } from "./mock.js";

// End-to-end demo.
export { demo } from "./demo.js";
