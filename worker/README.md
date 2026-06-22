# Wireframe waitlist worker

A small Cloudflare Worker that collects waitlist emails for the Wireframe
landing page. Emails are write only from the public's perspective: no bot or
person can read the list through the API. The only readable value is the
aggregate signup count.

## Privacy model

- Emails are encrypted with AES-GCM at rest. The key is derived (SHA-256) from
  the `WAITLIST_SECRET`. The stored KV value contains only ciphertext, an IV, a
  timestamp, and an optional ref. Without the secret, a leak of the KV contents
  does not reveal any email.
- No endpoint ever returns an email or any per record data. There is no "list"
  route, by design.
- The only public aggregate is the signup count from `GET /api/waitlist/count`.
- Bots are deterred two ways: a honeypot field (`website`) that, when filled,
  returns a normal looking success but stores nothing, and a per IP rate limit
  (5 writes per minute, keyed on `CF-Connecting-IP`).
- Dedupe uses a SHA-256 of the lowercased email as the KV key (`e:<hash>`). The
  hash is one way and is only ever used as a key, never returned.

## Endpoints

- `POST /api/waitlist` with JSON body `{ email: string, ref?: string, website?: string }`
  - Returns `{ ok: true, count }` on a new signup.
  - Returns `{ ok: true, count, already: true }` if the email was already on the
    list (count is not incremented).
  - Returns `{ ok: false, error: "invalid_email" }` (400) on a bad email.
  - Returns `{ ok: false, error: "rate_limited" }` (429) when over the IP limit.
  - Honeypot: if `website` is non-empty, returns `{ ok: true, count }` and stores
    nothing.
- `GET /api/waitlist/count` returns `{ count }` only.
- Anything else returns a small JSON 404 or 405.

## Local development on Windows (no Docker)

`wrangler dev` runs a local Workers runtime plus Miniflare for KV. Nothing is
containerized, so Docker is not required.

```powershell
cd C:\Users\David\ideas\wireframe\worker
npm install
npx wrangler dev
```

The worker serves on http://localhost:8787.

KV is persisted to disk under `.wrangler/state`, so dev signups survive
restarts. To start from a clean slate, delete that folder.

In local dev there is no real secret unless you provide one. Wrangler reads a
`.dev.vars` file for local variables and secrets. Create it (do not commit it):

```
# .dev.vars
WAITLIST_SECRET=some-long-random-dev-secret
```

If `WAITLIST_SECRET` is missing the worker fails closed on writes with a 500
`server_misconfigured`, so always set it for local dev.

Quick test from PowerShell:

```powershell
# Join
Invoke-RestMethod -Uri http://localhost:8787/api/waitlist -Method Post `
  -ContentType 'application/json' `
  -Body '{"email":"test@example.com","website":""}'

# Count only
Invoke-RestMethod -Uri http://localhost:8787/api/waitlist/count
```

## Production setup

1. Create the real KV namespace (prints an id):

   ```powershell
   npx wrangler kv namespace create WAITLIST
   ```

   Paste the printed id into the `id` field of the `[[kv_namespaces]]` block in
   `wrangler.toml`. Optionally also create a preview namespace and paste its id
   into `preview_id`:

   ```powershell
   npx wrangler kv namespace create WAITLIST --preview
   ```

2. Set the encryption secret (you are prompted for the value, it is never
   written to disk):

   ```powershell
   npx wrangler secret put WAITLIST_SECRET
   ```

   Use a long random string. Keep a copy somewhere safe: if you lose it, the
   stored emails cannot be decrypted.

3. Set the allowed production origin. Either edit `ALLOWED_ORIGIN` in the
   `[vars]` block of `wrangler.toml` to your real site origin, or set it per
   environment. Localhost dev origins are always allowed.

4. Deploy:

   ```powershell
   npx wrangler deploy
   ```

## How the owner exports the list (out of band)

There is intentionally no API route that returns emails. To get the list, the
owner pulls the encrypted records directly and decrypts them locally with the
secret. This never goes through the public API.

1. List the record keys:

   ```powershell
   npx wrangler kv key list --binding WAITLIST | ConvertFrom-Json |
     Where-Object { $_.name -like 'e:*' }
   ```

2. For each key, read the value:

   ```powershell
   npx wrangler kv key get --binding WAITLIST "e:<hash>"
   ```

   Each value is JSON `{ emailEnc, iv, ts, ref }`.

3. Decrypt locally with the same scheme the worker uses: derive an AES-256-GCM
   key as `SHA-256(WAITLIST_SECRET)`, then AES-GCM decrypt `emailEnc` using the
   base64 `iv`. A short Node script using WebCrypto (the same primitives as the
   worker) recovers the plaintext. Run it on a trusted machine and never expose
   the secret in a deployed endpoint.

This keeps the export path entirely off the public surface: the secret lives
only with the owner, and the API never has a way to reveal an address.

## Frontend integration

The Vite frontend imports `client.ts`:

```ts
import { joinWaitlist, getWaitlistCount } from "../worker/client";

const baseUrl = import.meta.env.VITE_WAITLIST_URL; // see below
await joinWaitlist(baseUrl, { email });
const count = await getWaitlistCount(baseUrl);
```

Set `VITE_WAITLIST_URL` to `http://localhost:8787` in dev and to the deployed
worker URL in production.
