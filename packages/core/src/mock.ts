/**
 * mock.ts
 *
 * A mock "legacy" stateful text protocol with a KNOWN ground-truth FSM, ported from the spike.
 *
 * Protocol (black box: callers only ever observe request/response MESSAGES):
 *
 *   UNAUTH:  LOGIN <token>     -> AUTH      (OK GREETING)
 *            <anything else>   -> rejected  (ERR NOAUTH, stays UNAUTH)
 *   AUTH:    LIST              -> AUTH      (OK ITEMS ...)
 *            GET <id>          -> AUTH      (OK ITEM ... | ERR NOTFOUND, still AUTH)
 *            PING              -> AUTH      (OK PONG)
 *            LOGOUT            -> CLOSED    (OK BYE)
 *            LOGIN <token>     -> rejected  (ERR ALREADYAUTH, stays AUTH)
 *   CLOSED:  <anything>        -> rejected  (ERR CLOSED, terminal)
 *
 * Messages carry parameters (token, id, timestamp) the inference engine must abstract away.
 */

export type ServerVariant = "baseline" | "drift";

export interface ServerOptions {
  /**
   * "baseline" = the real ground-truth protocol.
   * "drift"    = a subtly changed protocol used ONLY to test drift detection. In drift mode PING
   *              responds "OK PONG-V2 <nonce>" instead of "OK PONG" (an off-automaton response).
   */
  variant?: ServerVariant;
}

/** A black-box stateful connection. The only interaction is send(request) -> response string. */
export class MockConnection {
  #state: "UNAUTH" | "AUTH" | "CLOSED" = "UNAUTH";
  #variant: ServerVariant;
  #clock = 0;

  static readonly #catalog: Record<string, string> = {
    "1001": "widget-alpha",
    "1002": "widget-beta",
    "1003": "widget-gamma",
  };

  constructor(opts: ServerOptions = {}) {
    this.#variant = opts.variant ?? "baseline";
  }

  /** Monotonic fake timestamp so traces carry a varying parameter to be abstracted away. */
  #ts(): string {
    this.#clock += 1;
    return `T${1000 + this.#clock}`;
  }

  /** Send a raw request line, get a raw response line. Black box: no state leaks out. */
  send(request: string): string {
    const ts = this.#ts();
    const parts = request.trim().split(/\s+/);
    const verb = (parts[0] ?? "").toUpperCase();
    const arg = parts.slice(1).join(" ");

    if (this.#state === "CLOSED") {
      return `${ts} ERR CLOSED`;
    }

    if (this.#state === "UNAUTH") {
      if (verb === "LOGIN") {
        if (arg.length === 0) return `${ts} ERR BADLOGIN`; // still UNAUTH
        this.#state = "AUTH";
        return `${ts} OK GREETING sid=${arg.slice(0, 6)}`;
      }
      return `${ts} ERR NOAUTH`; // any other command before login, stays UNAUTH
    }

    // this.#state === "AUTH"
    switch (verb) {
      case "LIST":
        return `${ts} OK ITEMS ${Object.keys(MockConnection.#catalog).join(",")}`;
      case "GET": {
        const item = MockConnection.#catalog[arg];
        if (item) return `${ts} OK ITEM ${arg}=${item}`;
        return `${ts} ERR NOTFOUND ${arg}`; // still AUTH (error-and-recover path)
      }
      case "PING":
        if (this.#variant === "drift") {
          return `${ts} OK PONG-V2 nonce=${this.#clock}`; // off-automaton response
        }
        return `${ts} OK PONG`;
      case "LOGOUT":
        this.#state = "CLOSED";
        return `${ts} OK BYE`;
      case "LOGIN":
        return `${ts} ERR ALREADYAUTH`; // still AUTH
      default:
        return `${ts} ERR UNKNOWN`; // unknown command, stays AUTH
    }
  }
}
