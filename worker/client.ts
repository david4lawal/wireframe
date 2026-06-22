/**
 * Tiny framework agnostic client for the Wireframe waitlist worker.
 *
 * The Vite frontend imports these two functions. They are dependency free and
 * use the global fetch, so they work in the browser and in modern Node.
 *
 * The honeypot field "website" is always sent as an empty string. Real users
 * never fill it. Bots that auto fill every field will trip it and get silently
 * dropped by the server.
 */

export interface JoinWaitlistBody {
  email: string;
  ref?: string;
}

export interface JoinWaitlistResult {
  ok: boolean;
  count?: number;
  already?: boolean;
  error?: string;
}

/**
 * Submit an email to the waitlist.
 *
 * @param baseUrl Base URL of the worker, for example http://localhost:8787 in
 *   dev or https://wireframe-waitlist.your-subdomain.workers.dev in prod. No
 *   trailing slash needed.
 * @param body The email and an optional ref code.
 */
export async function joinWaitlist(
  baseUrl: string,
  body: JoinWaitlistBody,
): Promise<JoinWaitlistResult> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: body.email,
        ref: body.ref,
        website: "", // honeypot, always empty for real users
      }),
    });
    const data = (await res.json()) as JoinWaitlistResult;
    return data;
  } catch {
    return { ok: false, error: "network_error" };
  }
}

/**
 * Fetch the current aggregate signup count. This is the only readable value the
 * API exposes. It never returns emails.
 *
 * @param baseUrl Base URL of the worker. No trailing slash needed.
 */
export async function getWaitlistCount(baseUrl: string): Promise<number> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/waitlist/count`);
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}
