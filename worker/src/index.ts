/**
 * Wireframe waitlist worker.
 *
 * Privacy model (read the README for the full version):
 *  - Emails are WRITE ONLY from the public's perspective. No endpoint ever
 *    returns an email or any per record data.
 *  - Each email is encrypted with AES-GCM at rest using a key derived from the
 *    WAITLIST_SECRET. The stored KV value contains only ciphertext plus an IV,
 *    so even a leak of the KV contents does not reveal the email without the
 *    secret.
 *  - The only readable aggregate is the signup count.
 *  - A honeypot field plus a per IP rate limit deter bots.
 */

export interface Env {
  // KV namespace that holds encrypted records, the dedupe markers, the rate
  // limit counters, and the aggregate count.
  WAITLIST: KVNamespace;
  // Secret used to derive the AES-GCM key. Set via: wrangler secret put WAITLIST_SECRET
  WAITLIST_SECRET: string;
  // Optional production origin allowed by CORS, for example https://wireframe.example.com
  ALLOWED_ORIGIN?: string;
}

// Origins allowed in local development. The Vite dev server runs on 5188.
const DEV_ORIGINS = [
  "http://localhost:5188",
  "http://127.0.0.1:5188",
];

// RFC-ish email regex. Deliberately permissive but rejects the obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const MAX_EMAIL_LEN = 254;
const RATE_LIMIT_MAX = 5; // writes per window
const RATE_LIMIT_WINDOW = 60; // seconds

interface WaitlistBody {
  email?: unknown;
  ref?: unknown;
  website?: unknown; // honeypot
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function allowedOrigins(env: Env): string[] {
  const list = [...DEV_ORIGINS];
  if (env.ALLOWED_ORIGIN) {
    list.push(env.ALLOWED_ORIGIN);
  }
  return list;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(
  body: unknown,
  status: number,
  request: Request,
  env: Env,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(digest);
}

// Derive a stable AES-GCM key from the secret. We hash the secret with SHA-256
// to get 32 bytes of key material, which is exactly an AES-256 key.
async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
}

interface EncryptedEmail {
  emailEnc: string; // base64 ciphertext
  iv: string; // base64 12 byte nonce
}

async function encryptEmail(
  email: string,
  secret: string,
): Promise<EncryptedEmail> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(email),
  );
  return {
    emailEnc: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
  };
}

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

const COUNT_KEY = "meta:count";

async function getCount(env: Env): Promise<number> {
  const raw = await env.WAITLIST.get(COUNT_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function incrementCount(env: Env): Promise<number> {
  const next = (await getCount(env)) + 1;
  await env.WAITLIST.put(COUNT_KEY, String(next));
  return next;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Returns true if the request is allowed, false if the IP is over the limit.
async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
  const raw = await env.WAITLIST.get(key);
  const current = raw ? parseInt(raw, 10) : 0;
  if (current >= RATE_LIMIT_MAX) {
    return false;
  }
  // Re-write with a fresh TTL. This is a sliding-ish window: the TTL is reset
  // on each write, which is acceptable for simple abuse deterrence.
  await env.WAITLIST.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleJoin(request: Request, env: Env): Promise<Response> {
  if (!env.WAITLIST_SECRET) {
    // Misconfiguration. Do not leak details, just fail closed.
    return json({ ok: false, error: "server_misconfigured" }, 500, request, env);
  }

  let body: WaitlistBody;
  try {
    body = (await request.json()) as WaitlistBody;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, request, env);
  }

  // Honeypot. Real users never see this field, so a non-empty value means a
  // bot. We respond with a normal looking success but store nothing.
  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (website.length > 0) {
    const count = await getCount(env);
    return json({ ok: true, count }, 200, request, env);
  }

  // Validate the email.
  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = rawEmail.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_LEN ||
    !EMAIL_RE.test(email)
  ) {
    return json({ ok: false, error: "invalid_email" }, 400, request, env);
  }

  const ref =
    typeof body.ref === "string" ? body.ref.slice(0, 128) : undefined;

  // Rate limit per IP. CF-Connecting-IP is set by Cloudflare. In local dev it
  // may be absent, so we fall back to a constant bucket.
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return json({ ok: false, error: "rate_limited" }, 429, request, env);
  }

  // Dedupe by hashed email. The hash is keyed only by the lowercased email, so
  // re-submitting the same address is idempotent. The hash is one way: it does
  // not let anyone recover the email, and it is only ever used as a KV key.
  const emailHash = await sha256Hex(email);
  const recordKey = `e:${emailHash}`;
  const existing = await env.WAITLIST.get(recordKey);
  if (existing) {
    const count = await getCount(env);
    return json({ ok: true, count, already: true }, 200, request, env);
  }

  // Encrypt the email at rest and store the record. The stored value contains
  // only ciphertext, the IV, a timestamp, and the optional ref. No plaintext
  // email is ever written.
  const encrypted = await encryptEmail(email, env.WAITLIST_SECRET);
  const record = {
    emailEnc: encrypted.emailEnc,
    iv: encrypted.iv,
    ts: Date.now(),
    ref: ref ?? null,
  };
  await env.WAITLIST.put(recordKey, JSON.stringify(record));

  const count = await incrementCount(env);
  return json({ ok: true, count }, 200, request, env);
}

async function handleCount(request: Request, env: Env): Promise<Response> {
  // The only public aggregate. Returns nothing but the integer count.
  const count = await getCount(env);
  return json({ count }, 200, request, env);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight for any route.
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (path === "/api/waitlist") {
      if (method === "POST") {
        return handleJoin(request, env);
      }
      return json({ ok: false, error: "method_not_allowed" }, 405, request, env);
    }

    if (path === "/api/waitlist/count") {
      if (method === "GET") {
        return handleCount(request, env);
      }
      return json({ ok: false, error: "method_not_allowed" }, 405, request, env);
    }

    return json({ ok: false, error: "not_found" }, 404, request, env);
  },
};
