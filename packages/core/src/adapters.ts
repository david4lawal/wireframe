/**
 * adapters.ts
 *
 * Transport adapters: a uniform request/response interface over different wires.
 *
 *   Adapter           : { connect(); send(msg); close() } (all async).
 *   MockAdapter       : wraps the in-process mock protocol (fully working, no network).
 *   WebSocketAdapter  : real, using the 'ws' package, against a ws:// or wss:// URL.
 *   TcpAdapter        : real, using node 'net', line-delimited request/response.
 *
 * The ws/tcp adapters compile and have correct connect/send/close logic; they do not need a live
 * server to pass the library's unit tests.
 */

import { MockConnection, type ServerVariant } from "./mock.js";

export interface Adapter {
  connect(): Promise<void>;
  send(msg: string): Promise<string>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* MockAdapter                                                          */
/* ------------------------------------------------------------------ */

/** Wraps the in-process mock protocol. A new connection is created on connect(). */
export class MockAdapter implements Adapter {
  #conn: MockConnection | null = null;
  #variant: ServerVariant;

  constructor(opts: { variant?: ServerVariant } = {}) {
    this.#variant = opts.variant ?? "baseline";
  }

  async connect(): Promise<void> {
    this.#conn = new MockConnection({ variant: this.#variant });
  }

  async send(msg: string): Promise<string> {
    if (!this.#conn) throw new Error("MockAdapter.send: not connected (call connect() first).");
    return this.#conn.send(msg);
  }

  async close(): Promise<void> {
    this.#conn = null;
  }
}

/* ------------------------------------------------------------------ */
/* WebSocketAdapter (real, 'ws')                                       */
/* ------------------------------------------------------------------ */

/**
 * Real WebSocket adapter using the 'ws' package. Each send() writes one message and resolves with
 * the next inbound message (request/response framing). A timeout guards against a silent server.
 */
export class WebSocketAdapter implements Adapter {
  #url: string;
  #ws: import("ws").WebSocket | null = null;
  #timeoutMs: number;

  constructor(url: string, opts: { timeoutMs?: number } = {}) {
    this.#url = url;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    const { WebSocket } = await import("ws");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      const onOpen = () => {
        ws.off("error", onError);
        this.#ws = ws;
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  async send(msg: string): Promise<string> {
    const ws = this.#ws;
    if (!ws) throw new Error("WebSocketAdapter.send: not connected (call connect() first).");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocketAdapter.send: timed out after ${this.#timeoutMs} ms.`));
      }, this.#timeoutMs);
      const onMessage = (data: import("ws").RawData) => {
        cleanup();
        resolve(data.toString());
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("error", onError);
      };
      ws.once("message", onMessage);
      ws.once("error", onError);
      ws.send(msg);
    });
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
      }
    });
    this.#ws = null;
  }
}

/* ------------------------------------------------------------------ */
/* TcpAdapter (real, node 'net')                                       */
/* ------------------------------------------------------------------ */

/**
 * Real TCP adapter using node 'net'. The protocol is line-delimited: send() writes the request
 * plus a newline and resolves with the next complete line of the response. Partial reads are
 * buffered until a newline arrives.
 */
export class TcpAdapter implements Adapter {
  #host: string;
  #port: number;
  #timeoutMs: number;
  #socket: import("node:net").Socket | null = null;
  #buffer = "";
  /** Queue of pending readers waiting for the next complete line. */
  #waiters: ((line: string) => void)[] = [];

  constructor(opts: { host: string; port: number; timeoutMs?: number }) {
    this.#host = opts.host;
    this.#port = opts.port;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: this.#host, port: this.#port });
      const onConnect = () => {
        socket.off("error", onError);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.#onData(chunk));
        this.#socket = socket;
        resolve();
      };
      const onError = (err: Error) => {
        socket.off("connect", onConnect);
        reject(err);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(idx + 1);
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
    }
  }

  async send(msg: string): Promise<string> {
    const socket = this.#socket;
    if (!socket) throw new Error("TcpAdapter.send: not connected (call connect() first).");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(onLine);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error(`TcpAdapter.send: timed out after ${this.#timeoutMs} ms.`));
      }, this.#timeoutMs);
      const onLine = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.#waiters.push(onLine);
      socket.write(msg.endsWith("\n") ? msg : msg + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          const i = this.#waiters.indexOf(onLine);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(err);
        }
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
    });
    this.#socket = null;
    this.#buffer = "";
    this.#waiters = [];
  }
}
