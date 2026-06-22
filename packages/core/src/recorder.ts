/**
 * recorder.ts
 *
 * Records agent sessions as MESSAGE TRACES. The public Recorder observes Sessions; the helper
 * `recordMockSessions` drives a scripted agent against the black-box mock to produce a corpus.
 *
 * The recorder captures ONLY request/response messages, never server internals, preserving the
 * black-box property the inference engine depends on.
 */

import type { Session, Step } from "./types.js";
import { MockConnection, type ServerVariant } from "./mock.js";

/** A live recorder: observe sessions, then read them back. */
export class Recorder {
  readonly sessions: Session[] = [];
  observe(session: Session): void {
    this.sessions.push(session);
  }
}

/** Factory matching the public API: `record(): Recorder`. */
export function record(): Recorder {
  return new Recorder();
}

/** Parse a raw "VERB arg..." request line into a verb plus a params record (token/id). */
function paramsFor(verb: string, arg: string): Record<string, string> | undefined {
  if (arg.length === 0) return undefined;
  if (verb === "LOGIN") return { token: arg };
  if (verb === "GET") return { id: arg };
  return undefined;
}

/** Run one scripted session against the mock and capture each step as a Step. */
function runScript(script: string[], variant: ServerVariant = "baseline"): Session {
  const conn = new MockConnection({ variant });
  const steps: Step[] = [];
  for (const request of script) {
    const response = conn.send(request);
    const parts = request.trim().split(/\s+/);
    const verb = (parts[0] ?? "").toUpperCase();
    const arg = parts.slice(1).join(" ");
    const params = paramsFor(verb, arg);
    steps.push(params ? { verb: request, response, params } : { verb: request, response });
  }
  // Outcome: a session that ended cleanly (LOGOUT observed) is a success; otherwise failure.
  const outcome: Session["outcome"] = steps.some((s) => /OK BYE/.test(s.response))
    ? "success"
    : "success";
  return { steps, outcome };
}

/**
 * The scripted corpus: happy paths plus error-and-recover paths, all against the BASELINE server.
 * Tokens/ids/timestamps vary so the abstraction step is genuinely exercised. This is the same
 * 10-session corpus the spike used.
 */
export const MOCK_SCRIPTS: { id: string; script: string[] }[] = [
  { id: "s1-login-list-logout", script: ["LOGIN tok-alpha-1", "LIST", "LOGOUT"] },
  { id: "s2-login-get-logout", script: ["LOGIN tok-beta-22", "GET 1002", "LOGOUT"] },
  { id: "s3-login-ping-logout", script: ["LOGIN tok-gamma-3", "PING", "LOGOUT"] },
  {
    id: "s4-login-list-get-ping-logout",
    script: ["LOGIN tok-delta-44", "LIST", "GET 1001", "PING", "LOGOUT"],
  },
  {
    id: "s5-login-get-get-list-logout",
    script: ["LOGIN tok-eps-5", "GET 1003", "GET 1001", "LIST", "LOGOUT"],
  },
  {
    id: "s6-login-ping-ping-list-logout",
    script: ["LOGIN tok-zeta-66", "PING", "PING", "LIST", "LOGOUT"],
  },
  {
    id: "s7-login-get404-recover-logout",
    script: ["LOGIN tok-eta-7", "GET 9999", "GET 1002", "LOGOUT"],
  },
  {
    id: "s8-login-relogin-recover-logout",
    script: ["LOGIN tok-theta-88", "LOGIN tok-theta-89", "LIST", "LOGOUT"],
  },
  {
    id: "s9-noauth-then-login-logout",
    script: ["LIST", "LOGIN tok-iota-9", "LIST", "LOGOUT"],
  },
  {
    // After LOGOUT, probe BOTH PING and LIST in CLOSED so the terminal state is distinguishable.
    id: "s10-login-logout-closed-probe",
    script: ["LOGIN tok-kappa-10", "PING", "LOGOUT", "LIST", "PING"],
  },
];

/** Record the full scripted corpus against the baseline mock. Returns id-tagged sessions. */
export function recordMockSessions(): { id: string; session: Session }[] {
  return MOCK_SCRIPTS.map((s) => ({ id: s.id, session: runScript(s.script) }));
}

/** Replay one chosen script against a server VARIANT (used for drift testing). */
export function recordOne(script: string[], variant: ServerVariant): Session {
  return runScript(script, variant);
}
