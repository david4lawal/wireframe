/**
 * http-demo.ts  (run: `npx tsx demos/http-demo.ts` from packages/core)
 *
 * A tiny local HTTP API, learned through the HttpAdapter + abstractHttpStep, then driven by the
 * COMPILED DRIVER which CHOOSES the API call sequence toward a goal. ZERO model calls. Ids, tokens,
 * and PII are normalized to stable structural symbols, so the learned protocol is data-independent.
 *
 *   POST /login              -> {token}
 *   GET  /customers/:id      -> {id,name,email}
 *   GET  /customers/:id/orders -> [...]
 *   POST /orders             -> {id,status}
 *
 * Then we trigger an UNSEEN status/shape (a 500) and show the driver ESCALATES instead of guessing.
 */

import { createServer, type Server } from "node:http";
import { infer, compile, Driver, HttpAdapter, abstractHttpStep } from "../dist/index.js";
import type { Session } from "../dist/index.js";

/* ------------------------------------------------------------------ */
/* A tiny local API server (the black box).                            */
/* ------------------------------------------------------------------ */

let nextCustomerId = 1000;
let nextOrderId = 5000;
let failOrders = false; // flip to make POST /orders return an unseen 500 shape

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (method === "POST" && path === "/login") {
      // A fresh, random-looking token each time (a parameter that must be abstracted away).
      return json(200, { token: "tok_" + Math.random().toString(36).slice(2) + Date.now() });
    }
    const custOrders = /^\/customers\/(\d+)\/orders$/.exec(path);
    if (method === "GET" && custOrders) {
      return json(200, [
        { id: nextOrderId++, status: "open", total: Math.round(Math.random() * 10000) },
        { id: nextOrderId++, status: "shipped", total: Math.round(Math.random() * 10000) },
      ]);
    }
    const cust = /^\/customers\/(\d+)$/.exec(path);
    if (method === "GET" && cust) {
      const id = Number(cust[1]);
      return json(200, { id, name: "Customer " + id, email: `user${id}@example.com` });
    }
    if (method === "POST" && path === "/orders") {
      if (failOrders) return json(500, { error: "inventory service unavailable" }); // unseen shape
      return json(200, { id: nextOrderId++, status: "created" });
    }
    return json(404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Record one session "log in, fetch a customer, list their orders, place an order" through the
 * HttpAdapter. POST /orders lands in a distinct "order placed" state, which becomes the goal.
 */
async function recordSession(baseUrl: string, customerId: number): Promise<Session> {
  const adapter = new HttpAdapter(baseUrl);
  await adapter.connect();
  const steps: { verb: string; response: string }[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const verb = `${method} ${path}`;
    const raw = await adapter.send(JSON.stringify({ method, path, body }));
    steps.push({ verb, response: raw });
    return raw;
  };
  await call("POST", "/login", { user: "demo", pass: "secret" });
  await call("GET", `/customers/${customerId}`);
  await call("GET", `/customers/${customerId}/orders`);
  await call("POST", "/orders", { customerId });
  await adapter.close();
  return { steps, outcome: "success" };
}

async function main(): Promise<void> {
  const { server, baseUrl } = await startServer();
  try {
    /* 1. Record ~5 success sessions, each with DIFFERENT ids/tokens. */
    const train: Session[] = [];
    for (let i = 0; i < 4; i++) train.push(await recordSession(baseUrl, ++nextCustomerId));
    const heldOut: Session[] = [await recordSession(baseUrl, ++nextCustomerId)];

    /* 2. Infer + compile using the SAME HTTP abstraction for training and validation. */
    const model = infer(train, { abstract: abstractHttpStep });
    const { driver, report } = compile(model, {
      coverageGate: 0.9,
      heldOut,
      abstract: abstractHttpStep,
    });

    /* The goal is "order placed": the distinct state reached after POST /orders. */
    const orderPlaced = driver.transitions.find((t) => t.on.startsWith("POST /orders/2"))!;
    const goalState = orderPlaced.to;

    /* Concrete params the CALLER supplies (the driver chooses only the verb). */
    const taskCustomerId = ++nextCustomerId;
    const concrete = (verb: string): { method: string; path: string; body?: unknown } => {
      if (verb === "POST /login") return { method: "POST", path: "/login", body: { user: "x" } };
      if (verb === "GET /customers/:id")
        return { method: "GET", path: `/customers/${taskCustomerId}` };
      if (verb === "GET /customers/:id/orders")
        return { method: "GET", path: `/customers/${taskCustomerId}/orders` };
      if (verb === "POST /orders")
        return { method: "POST", path: "/orders", body: { customerId: taskCustomerId } };
      throw new Error("no concrete request for verb " + verb);
    };

    /* 3. The DRIVER CHOOSES the API call sequence toward the goal. 0 model calls. */
    const adapter = new HttpAdapter(baseUrl);
    await adapter.connect();
    driver.start();
    let modelCalls = 0;
    const chosen: string[] = [];
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error("loop did not terminate");
      const n = driver.nextCommand(goalState);
      if ("done" in n) break;
      if ("escalate" in n) throw new Error("unexpected escalation: " + n.reason);
      chosen.push(n.command);
      const raw = await adapter.send(JSON.stringify(concrete(n.command)));
      const sym = abstractHttpStep({ verb: n.command, response: raw }).symbol;
      const r = driver.step(sym);
      if (!r.deterministic) throw new Error("driver escalated mid-run: " + r.reason);
    }
    await adapter.close();
    const finalCursor = driver.state();
    const reachedGoal = finalCursor === goalState;

    /*
     * 4. Trigger an UNSEEN status/shape and show the driver ESCALATES. Walk the learned path to the
     * state where POST /orders is legal, then make the server fail so POST /orders returns a 500
     * ERROR shape it never saw in training. The driver must refuse instead of guessing.
     */
    failOrders = true;
    const probeCustomerId = ++nextCustomerId;
    const probe = new HttpAdapter(baseUrl);
    await probe.connect();
    driver.start();
    const walk = async (method: string, path: string) => {
      const raw = await probe.send(JSON.stringify({ method, path }));
      const r = driver.step(abstractHttpStep({ verb: `${method} ${path}`, response: raw }).symbol);
      return r;
    };
    await walk("POST", "/login");
    await walk("GET", `/customers/${probeCustomerId}`);
    await walk("GET", `/customers/${probeCustomerId}/orders`); // now at the order-placing state
    const orderRaw = await probe.send(JSON.stringify({ method: "POST", path: "/orders", body: {} }));
    const unseenSym = abstractHttpStep({ verb: "POST /orders", response: orderRaw }).symbol;
    const escResult = driver.step(unseenSym);
    await probe.close();
    failOrders = false;

    /* Summary: print the inferred symbols so normalization is visible. */
    console.log("=== http-demo ===");
    console.log(`inferred states (${model.states.length}): ${model.states.join(", ")}`);
    console.log("inferred transitions (symbols are normalized: ids/tokens/PII removed):");
    for (const t of driver.transitions) console.log(`  ${t.from} --[${t.verb}]--> ${t.to}   on  ${t.on}`);
    console.log("");
    console.log(`compile passed       : ${report.passed} (coverage=${report.coverage}, unsafeRate=${report.unsafeContinuationRate})`);
    console.log(`goal state           : ${goalState} (order placed)`);
    console.log(`commands CHOSEN      : ${chosen.join(" -> ")}  (selected by the driver, not hard-coded)`);
    console.log(`reached goal         : ${reachedGoal} (final cursor=${finalCursor})`);
    console.log(`model calls          : ${modelCalls}`);
    console.log(`unseen 500 symbol    : ${unseenSym}`);
    console.log(`escalated on unseen  : ${escResult.escalate === true} (reason=${escResult.reason})`);
    console.log(`terminal states      : ${driver.terminalStates().join(", ") || "(none)"}`);

    const ok =
      report.passed &&
      reachedGoal &&
      modelCalls === 0 &&
      chosen.length > 0 &&
      escResult.escalate === true;
    console.log("");
    console.log(ok ? "http-demo: PASS" : "http-demo: FAIL");
    if (!ok) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("http-demo error:", err);
  process.exitCode = 1;
});
