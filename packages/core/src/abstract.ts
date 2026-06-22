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

/**
 * The shape of an abstraction function: map a concrete (verb, response) into a stable alphabet
 * symbol plus the structural verb and response type. The default is the text `abstractStep` below;
 * HTTP protocols supply `abstractHttpStep` from http.ts. Training (infer) and validation (compile)
 * MUST use the same abstraction function so symbols line up.
 */
export type AbstractStepFn = (step: { verb: string; response: string }) => {
  symbol: string;
  verb: string;
  responseType: string;
};

/**
 * Response-namespacing policy for the abstraction.
 *
 *  - 'none'    : leave the response type as-is (the default; backward compatible). Coarse protocols
 *                that reuse ONE success code across distinct commands (e.g. SMTP's 250 after EHLO,
 *                MAIL FROM, RCPT TO, and message-accept) can over-merge under this policy.
 *  - 'by-verb' : suffix the response type with the request verb using a non-colliding separator,
 *                so 250 under verb MAIL_FROM becomes "250@MAIL_FROM" (symbol "MAIL_FROM/250@MAIL_FROM").
 *                This forces every command's responses into a distinct alphabet, keeping states apart.
 *  - 'auto'    : data-driven. Resolved by the infer/compile flow, which namespaces ONLY the
 *                response types that are genuinely ambiguous (occur under 2+ distinct verbs) and
 *                leaves unambiguous ones untouched. A plain AbstractStepFn cannot see the corpus, so
 *                makeAbstractStep treats 'auto' as 'none'; the corpus-aware resolution lives in
 *                resolveAbstraction() (compile.ts).
 */
export type ResponseNamespace = "none" | "by-verb" | "auto";

/**
 * The separator that joins a response type to its verb when namespacing by verb. "@" never appears
 * in a verb or in the "VERB/RESPONSE_TYPE" split (which cuts at the FIRST "/"), so the symbol stays
 * unambiguously parseable: verbOf/respOf still split on the first "/", and the verb tail rides along
 * inside the response half.
 */
export const VERB_NAMESPACE_SEP = "@";

/** Apply by-verb namespacing to a response type: "250" under "MAIL_FROM" becomes "250@MAIL_FROM". */
export function namespaceResponseType(responseType: string, verb: string): string {
  return `${responseType}${VERB_NAMESPACE_SEP}${verb}`;
}

/** Options for makeAbstractStep. */
export interface AbstractStepOptions {
  /**
   * Response-namespacing policy. Defaults to 'none' (unchanged behavior). 'by-verb' suffixes every
   * response type with its verb. 'auto' is corpus-aware and resolved by infer/compile; a bare
   * AbstractStepFn produced here treats 'auto' as 'none' (no corpus visible at this layer).
   */
  responseNamespace?: ResponseNamespace;
}

/**
 * Build a text AbstractStepFn with an optional response-namespacing policy. The default policy is
 * 'none', so makeAbstractStep() with no options is identical to the exported `abstractStep`.
 */
export function makeAbstractStep(options: AbstractStepOptions = {}): AbstractStepFn {
  const policy = options.responseNamespace ?? "none";
  return (step) => {
    const verb = abstractVerb(step.verb);
    const responseTypeRaw = abstractResponse(step.response);
    // 'auto' is resolved corpus-wide upstream; at this bare-function layer it is a no-op ('none').
    const responseType =
      policy === "by-verb" ? namespaceResponseType(responseTypeRaw, verb) : responseTypeRaw;
    return { symbol: `${verb}/${responseType}`, verb, responseType };
  };
}

/** Abstract a single step into an alphabet symbol "VERB/RESPONSE_TYPE" (no namespacing). */
export const abstractStep: AbstractStepFn = makeAbstractStep();

/** Abstract a whole session (list of steps) into a list of symbols, with an optional abstraction fn. */
export function abstractSession(steps: Step[], abstract: AbstractStepFn = abstractStep): string[] {
  return steps.map((s) => abstract(s).symbol);
}
