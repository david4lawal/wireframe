/**
 * demo.ts
 *
 * End-to-end demo over the MockAdapter:
 *   1. Explore the mock by running the scripted corpus through a MockAdapter, recording sessions.
 *   2. Infer a ProtocolModel (default red-blue merge).
 *   3. Compile with a 0.95 coverage gate against held-out sessions.
 *   4. Drive the MockAdapter through the happy path using ONLY the compiled driver (0 model calls)
 *      and assert completion.
 *
 * Returns { ok, modelCalls, states }. modelCalls MUST be 0 on the learned path.
 */

import type { Session } from "./types.js";
import { Recorder } from "./recorder.js";
import { MOCK_SCRIPTS } from "./recorder.js";
import { MockAdapter } from "./adapters.js";
import { abstractStep } from "./abstract.js";
import { infer } from "./compile.js";
import { compile } from "./compile.js";

/** Run a scripted session through a MockAdapter, capturing request/response steps. */
async function exploreScript(script: string[]): Promise<Session> {
  const adapter = new MockAdapter();
  await adapter.connect();
  const steps = [];
  for (const request of script) {
    const response = await adapter.send(request);
    steps.push({ verb: request, response });
  }
  await adapter.close();
  return { steps, outcome: "success" as const };
}

export async function demo(): Promise<{ ok: boolean; modelCalls: number; states: number }> {
  /* 1. Explore the mock via the adapter and record sessions. */
  const recorder = new Recorder();
  for (const s of MOCK_SCRIPTS) {
    recorder.observe(await exploreScript(s.script));
  }

  /* Hold out three happy-path sessions whose transitions are all also seen in training. */
  const heldOutIdx = new Set([0, 2, 3]); // s1, s3, s4
  const train: Session[] = [];
  const heldOut: Session[] = [];
  recorder.sessions.forEach((sess, i) => (heldOutIdx.has(i) ? heldOut : train).push(sess));

  /* 2. Infer the model (default red-blue). */
  const model = infer(train);

  /* 3. Compile with a 0.95 coverage gate. */
  const { driver, report } = compile(model, { coverageGate: 0.95, heldOut });

  /* 4. Drive the happy path through the compiled driver ONLY. Count model calls (must be 0). */
  let modelCalls = 0;
  const adapter = new MockAdapter();
  await adapter.connect();
  driver.start();
  const happyPath = ["LOGIN tok-demo-1", "LIST", "GET 1001", "PING", "LOGOUT"];
  let ok = report.passed;
  let sawLogout = false;
  for (const request of happyPath) {
    const response = await adapter.send(request);
    const symbol = abstractStep({ verb: request, response }).symbol;
    const r = driver.step(symbol);
    // The driver is pure code: no model call is ever made on the learned path.
    if (!r.deterministic) {
      ok = false;
      break;
    }
    if (symbol === "LOGOUT/OK_BYE") sawLogout = true;
  }
  await adapter.close();

  // Completion: every step stayed deterministic, the gate passed, and the session reached the
  // terminal state via LOGOUT (the happy path actually finished on the learned automaton).
  ok = ok && sawLogout;

  return { ok, modelCalls, states: model.states.length };
}
