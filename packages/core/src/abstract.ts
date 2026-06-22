/**
 * abstract.ts
 *
 * Templating / abstraction layer.
 *
 * The inference engine must separate STABLE protocol structure (command verbs, response
 * types) from PARAMETERS (token, id, timestamp). This is the classical "message templating"
 * step that precedes protocol-FSM inference: concrete messages become abstract symbols.
 *
 * A trace step carries a verb, a raw response, and optional params. We abstract each into a
 * single symbol "VERB/RESPONSETYPE", which is the alphabet the automaton learner operates over.
 *
 * The fields we strip (token / id / timestamp) are reported as `parameterFieldsAbstracted`.
 */

import type { Step } from "./types.js";

/** Parameter fields that are templated away from structure. Reported in results.json. */
export const PARAMETER_FIELDS = ["token", "id", "timestamp"] as const;

/**
 * Abstract the request verb: keep the verb, drop any parameter (token/id/etc).
 *   "LOGIN abc123tok" becomes "LOGIN"
 *   "GET 1002"        becomes "GET"
 *   "PING"            becomes "PING"
 */
export function abstractVerb(verb: string): string {
  const head = verb.trim().split(/\s+/)[0] ?? "";
  return head.toUpperCase();
}

/**
 * Abstract a response line into a stable response TYPE, stripping a leading timestamp token
 * and any trailing parameters (sid, item payloads, ids, nonces).
 *
 *   "T1001 OK GREETING sid=abc123"   becomes "OK_GREETING"
 *   "T1004 OK ITEMS 1001,1002,1003"  becomes "OK_ITEMS"
 *   "T1007 OK ITEM 1002=widget-beta" becomes "OK_ITEM"
 *   "T1009 ERR NOTFOUND 9999"        becomes "ERR_NOTFOUND"
 *   "T1011 OK PONG"                  becomes "OK_PONG"
 *   "T1099 OK PONG-V2 nonce=7"       becomes "OK_PONG-V2"  (drift: a NEW symbol)
 */
export function abstractResponse(response: string): string {
  const toks = response.trim().split(/\s+/);
  // Drop a leading timestamp token (matches /^T\d+$/). If absent, drop nothing.
  let i = 0;
  if (/^T\d+$/.test(toks[0] ?? "")) i = 1;
  const status = toks[i] ?? ""; // OK | ERR
  const kind = toks[i + 1] ?? ""; // GREETING | ITEMS | ITEM | NOTFOUND | PONG | BYE | ...
  // Keep only status + kind; everything after is a parameter payload and is dropped.
  return `${status}_${kind}`.replace(/_+$/, "");
}

/** Abstract a single step into an alphabet symbol "VERB/RESPONSE_TYPE". */
export function abstractStep(step: { verb: string; response: string }): {
  symbol: string;
  verb: string;
  responseType: string;
} {
  const verb = abstractVerb(step.verb);
  const responseType = abstractResponse(step.response);
  return { symbol: `${verb}/${responseType}`, verb, responseType };
}

/** Abstract a whole session (list of steps) into a list of symbols. */
export function abstractSession(steps: Step[]): string[] {
  return steps.map((s) => abstractStep(s).symbol);
}
