/**
 * target.ts
 *
 * The SELF-CONTAINED, in-process, stateful black-box target the demo (and the MCP server's built-in
 * "ops" target) drive through Wireframe. It is a faithful, dependency-free port of the fulfillment
 * "operations terminal" the wireframe benchmark uses:
 *
 *   LOGIN -> START_ORDER -> ADD_ITEM (loop, OUT_OF_STOCK -> SUBSTITUTE recovery)
 *         -> SET_FIELD (loop) -> REVIEW (FIX_REQUIRED -> CORRECT recovery)
 *         -> VALIDATE -> SUBMIT -> FINALIZE
 *
 * The contract is exactly a wire protocol: `send(message) -> response`. Callers NEVER see the
 * internal state, the seeded RNG, or the goal predicate, so the black-box property Wireframe depends
 * on is preserved. `goalReached()` and `phase()` are exposed only so a harness can judge success;
 * they are not handed to the learner.
 *
 * A `Target` is just `{ send, goalReached, phase }`. The registry maps a target-name string to a
 * factory, so the MCP `wireframe_step` tool can address "ops" (or any registered target) by name and
 * get a FRESH instance per session.
 */

/* ------------------------------------------------------------------ */
/* Seeded RNG + stable hash (deterministic, no deps).                  */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* Catalog + field metadata.                                           */
/* ------------------------------------------------------------------ */

const CATALOG = Array.from({ length: 24 }, (_, i) => ({
  sku: `SKU-${1000 + i}`,
  page: Math.floor(i / 4) + 1,
  name: `part-${1000 + i}`,
}));
const CATALOG_PAGES = 6;
const FIELD_NAMES = ["ship_name", "ship_addr", "ship_city", "ship_zip", "bill_ref", "priority"];

/** Options that fix the seeded error schedule for a single target instance (deterministic demos). */
export interface OpsTargetOptions {
  seed?: number;
  /** Force OUT_OF_STOCK on the first ADD_ITEM (cleared by SUBSTITUTE). */
  forceOutOfStock?: boolean;
  /** Force FIX_REQUIRED on REVIEW (cleared by CORRECT). */
  forceNeedsFix?: boolean;
}

/** The black-box contract exposed to callers (and to Wireframe). */
export interface Target {
  /** Send one wire message, get one response line. The ONLY learner-visible surface. */
  send(message: string): string;
  /** Harness-only: has the goal (a submitted order) been reached? Never given to the learner. */
  goalReached(): boolean;
  /** Harness-only: the current coarse phase, for debugging/printing. Never given to the learner. */
  phase(): string;
}

/** Build a fresh ops-terminal black box. The error schedule is fixed by the options for determinism. */
export function createOpsTarget(opts: OpsTargetOptions = {}): Target {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(hashSeed(seed, "ops"));
  const OUT_OF_STOCK_P = 0.25;
  const FIX_REQUIRED_P = 0.5;

  let tick = 1000;
  const stamp = () => `T${tick++}`;

  const state = {
    phase: "ANON" as "ANON" | "AUTHED" | "DRAFTING" | "VALIDATED" | "SUBMITTED" | "CLOSED",
    token: null as string | null,
    orderId: null as string | null,
    page: 1,
    lines: [] as { lineId: string; sku: string }[],
    fields: {} as Record<string, string>,
    outOfStockCleared: false,
    reviewed: false,
    fixApplied: false,
    submitted: false,
  };

  // The very first ADD_ITEM is out of stock iff forced or the seeded roll says so.
  const firstAddOutOfStock =
    typeof opts.forceOutOfStock === "boolean" ? opts.forceOutOfStock : rng() < OUT_OF_STOCK_P;
  const needsFix =
    typeof opts.forceNeedsFix === "boolean" ? opts.forceNeedsFix : rng() < FIX_REQUIRED_P;
  let firstAddSeen = false;

  const ok = (kind: string, extra = "") => `${stamp()} OK ${kind}${extra ? ` ${extra}` : ""}`;
  const err = (code: string, extra = "") => `${stamp()} ERR ${code}${extra ? ` ${extra}` : ""}`;

  function parse(message: string): { verb: string; arg: string } {
    const trimmed = String(message ?? "").trim();
    const sp = trimmed.indexOf(" ");
    if (sp < 0) return { verb: trimmed.toUpperCase(), arg: "" };
    return { verb: trimmed.slice(0, sp).toUpperCase(), arg: trimmed.slice(sp + 1).trim() };
  }

  function suggestSubstitute(sku: string): string {
    const idx = CATALOG.findIndex((c) => c.sku === sku);
    const alt = CATALOG[(idx + 1) % CATALOG.length];
    return alt.sku;
  }

  function send(message: string): string {
    const { verb, arg } = parse(message);
    switch (verb) {
      case "LOGIN": {
        if (state.phase !== "ANON") return err("ALREADY_AUTHED");
        state.phase = "AUTHED";
        state.token = `tok-${hashSeed(seed, "tok").toString(16)}`;
        return ok("SESSION", `token=${state.token} sid=${stamp()}`);
      }
      case "LIST_CATALOG": {
        if (state.phase === "ANON") return err("NOT_AUTHED");
        state.page = 1;
        const items = CATALOG.filter((c) => c.page === 1).map((c) => c.sku).join(",");
        return ok("CATALOG", `page=1 of=${CATALOG_PAGES} skus=${items}`);
      }
      case "NEXT_PAGE": {
        if (state.phase === "ANON") return err("NOT_AUTHED");
        if (state.page >= CATALOG_PAGES) return err("NO_MORE_PAGES");
        state.page += 1;
        const items = CATALOG.filter((c) => c.page === state.page).map((c) => c.sku).join(",");
        return ok("PAGE", `page=${state.page} of=${CATALOG_PAGES} skus=${items}`);
      }
      case "START_ORDER": {
        if (state.phase === "ANON") return err("NOT_AUTHED");
        if (state.phase === "DRAFTING" || state.phase === "VALIDATED") return err("ORDER_OPEN");
        if (state.phase === "SUBMITTED" || state.phase === "CLOSED") return err("ORDER_CLOSED");
        state.phase = "DRAFTING";
        state.orderId = `ord-${hashSeed(seed, "ord").toString(16)}`;
        return ok("ORDER", `order=${state.orderId} created=${stamp()}`);
      }
      case "ADD_ITEM": {
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        const sku = arg.replace(/^sku=/i, "").trim();
        if (!sku) return err("BAD_ARGS", "sku required");
        if (!CATALOG.some((c) => c.sku === sku)) return err("UNKNOWN_SKU", sku);
        if (!firstAddSeen) {
          firstAddSeen = true;
          if (firstAddOutOfStock && !state.outOfStockCleared) {
            return err("OUT_OF_STOCK", `sku=${sku} suggest=${suggestSubstitute(sku)}`);
          }
        }
        const lineId = `ln-${state.lines.length + 1}-${stamp()}`;
        state.lines.push({ lineId, sku });
        state.reviewed = false;
        return ok("LINE", `line=${lineId} sku=${sku} count=${state.lines.length}`);
      }
      case "SUBSTITUTE": {
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        const sku = arg.replace(/^sku=/i, "").trim();
        if (!sku) return err("BAD_ARGS", "sku required");
        state.outOfStockCleared = true;
        return ok("SUBSTITUTED", `sku=${sku} cleared=${stamp()}`);
      }
      case "SET_FIELD": {
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        const m = /^([a-z_]+)=(.*)$/i.exec(arg);
        if (!m) return err("BAD_ARGS", "expected name=value");
        const name = m[1].toLowerCase();
        if (!FIELD_NAMES.includes(name)) return err("UNKNOWN_FIELD", name);
        state.fields[name] = m[2];
        state.reviewed = false;
        return ok("FIELD", `name=${name} set=${stamp()}`);
      }
      case "REVIEW": {
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        if (state.lines.length === 0) return err("EMPTY_ORDER");
        if (needsFix && !state.fixApplied) {
          return err("FIX_REQUIRED", `field=bill_ref reason=missing_ref ts=${stamp()}`);
        }
        state.reviewed = true;
        return ok("REVIEWED", `order=${state.orderId} clean=true ts=${stamp()}`);
      }
      case "CORRECT": {
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        state.fixApplied = true;
        return ok("CORRECTED", `applied=${stamp()}`);
      }
      case "VALIDATE": {
        if (state.phase === "VALIDATED") return err("ALREADY_VALIDATED");
        if (state.phase !== "DRAFTING") return err("NO_OPEN_ORDER");
        if (state.lines.length === 0) return err("EMPTY_ORDER");
        if (!state.reviewed) return err("NEEDS_REVIEW");
        state.phase = "VALIDATED";
        return ok("VALIDATED", `order=${state.orderId} lines=${state.lines.length} ts=${stamp()}`);
      }
      case "SUBMIT": {
        if (state.phase === "SUBMITTED" || state.phase === "CLOSED") return err("ORDER_CLOSED");
        if (state.phase !== "VALIDATED") return err("NOT_VALIDATED");
        state.phase = "SUBMITTED";
        state.submitted = true;
        return ok("SUBMITTED", `order=${state.orderId} confirmation=cnf-${stamp()}`);
      }
      case "FINALIZE": {
        if (state.phase !== "SUBMITTED") return err("NOT_SUBMITTED");
        state.phase = "CLOSED";
        return ok("CLOSED", `order=${state.orderId} receipt=rcp-${stamp()}`);
      }
      default:
        return err("UNKNOWN_COMMAND", verb);
    }
  }

  return {
    send,
    goalReached: () => state.submitted === true,
    phase: () => state.phase,
  };
}

/**
 * The command vocabulary, documented as an agent would see it. The MCP server returns this from
 * wireframe_status so an agent learning a new target knows what to try.
 */
export const OPS_VOCABULARY = [
  { verb: "LOGIN", args: "", doc: "Authenticate. Must be first. Returns a session token." },
  { verb: "LIST_CATALOG", args: "", doc: "List page 1 of the catalog. Requires login." },
  { verb: "NEXT_PAGE", args: "", doc: "Advance to the next catalog page. Requires login." },
  { verb: "START_ORDER", args: "", doc: "Open a new draft order. Requires login." },
  { verb: "ADD_ITEM", args: "sku=SKU-xxxx", doc: "Add a line item to the draft. May return OUT_OF_STOCK." },
  { verb: "SUBSTITUTE", args: "sku=SKU-xxxx", doc: "Clear an OUT_OF_STOCK hold so a retried ADD_ITEM succeeds." },
  { verb: "SET_FIELD", args: "name=value", doc: "Set an order field on the open draft." },
  { verb: "REVIEW", args: "", doc: "Pre-validation review. May return FIX_REQUIRED. Order must be non-empty." },
  { verb: "CORRECT", args: "", doc: "Apply the fix after a FIX_REQUIRED, then REVIEW again." },
  { verb: "VALIDATE", args: "", doc: "Validate a cleanly-reviewed draft." },
  { verb: "SUBMIT", args: "", doc: "Submit a validated order. Reaches the goal." },
  { verb: "FINALIZE", args: "", doc: "Confirm a submitted order and close it out." },
];

/* ------------------------------------------------------------------ */
/* Target registry: name -> fresh-instance factory.                    */
/* ------------------------------------------------------------------ */

export type TargetFactory = (opts?: OpsTargetOptions) => Target;

const REGISTRY = new Map<string, TargetFactory>([["ops", createOpsTarget]]);

/** Register an in-process target under a name, so wireframe_step can address it. */
export function registerTarget(name: string, factory: TargetFactory): void {
  REGISTRY.set(name, factory);
}

/** Make a fresh instance of a registered target, or undefined if the name is unknown. */
export function makeTarget(name: string, opts?: OpsTargetOptions): Target | undefined {
  const factory = REGISTRY.get(name);
  return factory ? factory(opts) : undefined;
}

/** List the names of all registered in-process targets. */
export function registeredTargets(): string[] {
  return [...REGISTRY.keys()];
}
