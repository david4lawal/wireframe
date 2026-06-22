/**
 * groundTruth.ts
 *
 * The KNOWN ground-truth FSM for the mock protocol, defined SEPARATELY from the server so the
 * inferred FSM can be verified against it. Expressed over the ABSTRACTED alphabet, where a symbol
 * is "VERB/RESPONSE_TYPE" with all parameters (token/id/timestamp) abstracted away.
 *
 * Verification is UP TO RELABELING, so an inferred FSM may use names q0/q1/q2 and still match.
 */

export interface Fsm {
  initial: string;
  states: string[];
  transitions: { from: string; on: string; to: string }[];
}

export const GROUND_TRUTH: Fsm = {
  initial: "UNAUTH",
  states: ["UNAUTH", "AUTH", "CLOSED"],
  transitions: [
    // UNAUTH
    { from: "UNAUTH", on: "LOGIN/OK_GREETING", to: "AUTH" },
    { from: "UNAUTH", on: "LIST/ERR_NOAUTH", to: "UNAUTH" }, // rejected before login, self-loop

    // AUTH (read-only operations and error-recover paths are self-loops)
    { from: "AUTH", on: "LIST/OK_ITEMS", to: "AUTH" },
    { from: "AUTH", on: "GET/OK_ITEM", to: "AUTH" },
    { from: "AUTH", on: "GET/ERR_NOTFOUND", to: "AUTH" }, // error-and-recover, still AUTH
    { from: "AUTH", on: "PING/OK_PONG", to: "AUTH" },
    { from: "AUTH", on: "LOGIN/ERR_ALREADYAUTH", to: "AUTH" }, // rejected, still AUTH
    { from: "AUTH", on: "LOGOUT/OK_BYE", to: "CLOSED" },

    // CLOSED (terminal): anything is rejected, self-loop. Probing both PING and LIST after logout
    // makes CLOSED distinguishable from UNAUTH and AUTH by overlapping-verb evidence.
    { from: "CLOSED", on: "PING/ERR_CLOSED", to: "CLOSED" },
    { from: "CLOSED", on: "LIST/ERR_CLOSED", to: "CLOSED" },
  ],
};

export function fsmStats(fsm: Fsm): { states: number; transitions: number } {
  return { states: fsm.states.length, transitions: fsm.transitions.length };
}
