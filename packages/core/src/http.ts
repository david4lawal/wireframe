/**
 * http.ts
 *
 * HTTP transport + a structural HTTP abstraction so Wireframe works on REST / GraphQL APIs.
 *
 *  - HttpAdapter      : an Adapter over Node fetch. A request is a JSON string
 *                       {method, path, headers?, body?}; send() returns a NORMALIZED raw response
 *                       string "<STATUS> <BODY_JSON>" (status line plus the JSON body, or "" body).
 *  - abstractHttpStep : an AbstractStepFn that normalizes HTTP into a stable alphabet symbol so two
 *                       responses differing only in ids / tokens / timestamps / cursors / PII yield
 *                       the SAME symbol. The path is templatized (dynamic segments -> :id, query
 *                       dropped) and the body is reduced to a VALUE-FREE structural signature.
 *
 * The whole point: the learned protocol must be stable across concrete data. Ids and tokens are
 * parameters, not structure, so they never reach the symbol.
 */

import type { Adapter } from "./adapters.js";
import type { AbstractStepFn } from "./abstract.js";

/* ------------------------------------------------------------------ */
/* HttpAdapter                                                         */
/* ------------------------------------------------------------------ */

/** A request the HttpAdapter understands. Encoded as a JSON string on the wire (the verb field). */
export interface HttpRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** A JSON-serializable body, or a raw string body. */
  body?: unknown;
}

/**
 * An Adapter over Node fetch. connect() is a no-op (HTTP is connectionless); send() takes a JSON
 * string {method, path, headers?, body?}, performs the request against the configured base URL, and
 * returns a normalized raw response string: the numeric status, a space, then the response body
 * text (JSON if the response was JSON, else the raw text, else empty). abstractHttpStep turns that
 * raw string into a stable symbol.
 */
export class HttpAdapter implements Adapter {
  #baseUrl: string;
  #timeoutMs: number;
  #defaultHeaders: Record<string, string>;

  constructor(baseUrl: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ""); // no trailing slash
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#defaultHeaders = opts.headers ?? {};
  }

  async connect(): Promise<void> {
    // HTTP is connectionless; nothing to open. Present for Adapter symmetry.
  }

  /**
   * Send one HTTP request. `msg` is a JSON string {method, path, headers?, body?}. Returns
   * "<status> <bodyText>" where bodyText is the response body (JSON re-stringified when the response
   * is JSON, the raw text otherwise, or "" when empty). Network errors surface as "0 <message>".
   */
  async send(msg: string): Promise<string> {
    let req: HttpRequest;
    try {
      req = JSON.parse(msg) as HttpRequest;
    } catch {
      throw new Error("HttpAdapter.send: request must be a JSON string {method, path, headers?, body?}.");
    }
    const url = this.#baseUrl + (req.path.startsWith("/") ? req.path : "/" + req.path);
    const headers: Record<string, string> = { ...this.#defaultHeaders, ...(req.headers ?? {}) };
    let bodyText: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === "string") {
        bodyText = req.body;
      } else {
        bodyText = JSON.stringify(req.body);
        if (!headers["content-type"] && !headers["Content-Type"]) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await fetch(url, {
        method: (req.method ?? "GET").toUpperCase(),
        headers,
        body: bodyText,
        signal: controller.signal,
      });
      const text = await res.text();
      let bodyOut = text;
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("application/json") && text.length > 0) {
        try {
          bodyOut = JSON.stringify(JSON.parse(text)); // re-stringify to a canonical single line
        } catch {
          bodyOut = text;
        }
      }
      return `${res.status} ${bodyOut}`.trimEnd();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `0 ${message}`; // transport failure encoded as status 0 (escalates by being unseen)
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Nothing to close for connectionless HTTP.
  }
}

/* ------------------------------------------------------------------ */
/* HTTP normalization (abstractHttpStep)                              */
/* ------------------------------------------------------------------ */

/** Options for abstractHttpStep. */
export interface HttpAbstractOptions {
  /**
   * Optional hook to map a body shape to a friendly tag (e.g. an object with id/name/email -> the
   * tag "CUSTOMER"). Receives the parsed body and numeric status; return a string tag or undefined
   * to fall back to the structural signature.
   */
  classify?: (body: unknown, status: number) => string | undefined;
}

/** A segment is "dynamic" (a runtime id) if it is all digits, a UUID, or a long hex/token. */
function isDynamicSegment(seg: string): boolean {
  if (seg.length === 0) return false;
  if (/^\d+$/.test(seg)) return true; // all digits
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) {
    return true; // uuid
  }
  if (/^[0-9a-fA-F]{16,}$/.test(seg)) return true; // long hex / token
  if (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /\d/.test(seg)) return true; // long opaque token with a digit
  return false;
}

/**
 * Templatize an HTTP "<METHOD> <path>" verb: drop the query string entirely and replace dynamic
 * path segments (all-digits, uuid, long hex/token) with ":id".
 *   "GET /customers/1002?expand=orders" -> "GET /customers/:id"
 *   "GET /customers/1002/orders"        -> "GET /customers/:id/orders"
 */
function templatizeVerb(rawVerb: string): string {
  const trimmed = rawVerb.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const method = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toUpperCase();
  let path = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q); // drop the query string entirely
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  const segments = path.split("/").map((seg) => (isDynamicSegment(seg) ? ":id" : seg));
  const templ = segments.join("/") || "/";
  return `${method} ${templ}`.trim();
}

/** The JSON "type" of a value, for structural signatures (null and array are distinguished). */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object | undefined
}

/**
 * A STABLE, VALUE-FREE structural signature of a body. ALL values are removed, so ids, timestamps,
 * tokens, emails, and other PII never appear:
 *   object -> OBJ{key:type, ...} with keys SORTED
 *   array  -> LIST<elemShape>  (elem shape from the first element, or EMPTY for [])
 *   scalar -> its type (STRING / NUMBER / BOOL / NULL)
 *   ""/undefined -> EMPTY
 * An object that looks like an error (has an "error" or "message"-only error field) is tagged ERROR{...}.
 */
function shapeOf(body: unknown): string {
  if (body === undefined || body === null) return "EMPTY";
  if (typeof body === "string") {
    return body.length === 0 ? "EMPTY" : "STRING";
  }
  if (typeof body === "number") return "NUMBER";
  if (typeof body === "boolean") return "BOOL";
  if (Array.isArray(body)) {
    if (body.length === 0) return "LIST<EMPTY>";
    return `LIST<${shapeOf(body[0])}>`;
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const isError = keys.includes("error") || (keys.length === 1 && keys[0] === "message");
    const sig = keys.map((k) => `${k}:${typeOf(obj[k])}`).join(",");
    return isError ? `ERROR{${sig}}` : `OBJ{${sig}}`;
  }
  return "EMPTY";
}

/**
 * Parse a normalized raw HTTP response "<status> <bodyText>" into { status, body }. body is the
 * parsed JSON when parseable, else the raw string, else undefined.
 */
function parseRawResponse(raw: string): { status: number; body: unknown } {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const statusStr = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1) : "";
  const status = Number.parseInt(statusStr, 10);
  if (rest.length === 0) return { status: Number.isNaN(status) ? 0 : status, body: undefined };
  try {
    return { status: Number.isNaN(status) ? 0 : status, body: JSON.parse(rest) };
  } catch {
    return { status: Number.isNaN(status) ? 0 : status, body: rest };
  }
}

/**
 * Build an HTTP AbstractStepFn. The produced symbol is "<METHOD> <templated-path>/<status> <shape>"
 * so that:
 *  - dynamic path segments and the query string never appear (templatized verb);
 *  - the response body contributes only its VALUE-FREE structural shape (or a classify() tag);
 *  - two responses differing only in ids / tokens / timestamps / cursors / PII map to the SAME symbol.
 *
 * Pass `classify` to map a shape to a friendly tag (e.g. -> "CUSTOMER").
 */
export function makeAbstractHttpStep(opts: HttpAbstractOptions = {}): AbstractStepFn {
  return (step) => {
    const verb = templatizeVerb(step.verb);
    const { status, body } = parseRawResponse(step.response);
    let shape = shapeOf(body);
    if (opts.classify) {
      const tag = opts.classify(body, status);
      if (tag) shape = tag;
    }
    const responseType = `${status} ${shape}`;
    return { symbol: `${verb}/${responseType}`, verb, responseType };
  };
}

/**
 * The default HTTP abstraction (structural shapes, no friendly tags). Use makeAbstractHttpStep({
 * classify }) when you want friendly tags like "CUSTOMER".
 */
export const abstractHttpStep: AbstractStepFn = makeAbstractHttpStep();
