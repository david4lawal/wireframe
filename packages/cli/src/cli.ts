#!/usr/bin/env node
/**
 * wireframe CLI
 *
 * Commands:
 *   wireframe compile <target> --from <dir> --adapter <auto|ws|tcp|mock> --coverage-gate <n> --out <file>
 *   wireframe run <driver.json> --adapter <auto|ws|tcp|mock>
 *   wireframe inspect <driver.json>
 *
 * With --adapter mock (or auto on an unknown target) it runs fully against the in-process mock so
 * `wireframe compile` works out of the box. ESM, Windows-friendly paths (path.join / fileURLToPath).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  infer,
  compile,
  Driver,
  abstractStep,
  recordMockSessions,
  MockAdapter,
  WebSocketAdapter,
  TcpAdapter,
  type Adapter,
  type Session,
} from "@wireframe/core";

type AdapterKind = "auto" | "ws" | "tcp" | "mock";

interface Flags {
  from?: string;
  adapter: AdapterKind;
  coverageGate: number;
  out?: string;
  host?: string;
  port?: number;
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { adapter: "auto", coverageGate: 0.95 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--from":
        flags.from = args[++i];
        break;
      case "--adapter":
        flags.adapter = (args[++i] as AdapterKind) ?? "auto";
        break;
      case "--coverage-gate":
        flags.coverageGate = Number(args[++i]);
        break;
      case "--out":
        flags.out = args[++i];
        break;
      case "--host":
        flags.host = args[++i];
        break;
      case "--port":
        flags.port = Number(args[++i]);
        break;
      default:
        positional.push(a);
    }
  }
  return { positional, flags };
}

/** Resolve which adapter to use. 'auto' falls back to 'mock' for unknown targets. */
function resolveAdapterKind(target: string, flags: Flags): AdapterKind {
  if (flags.adapter !== "auto") return flags.adapter;
  if (/^wss?:\/\//.test(target)) return "ws";
  if (/^tcp:\/\//.test(target) || /:\d+$/.test(target)) return "tcp";
  return "mock"; // unknown target -> mock, so the advertised compile actually runs
}

function buildAdapter(kind: AdapterKind, target: string, flags: Flags): Adapter {
  switch (kind) {
    case "ws":
      return new WebSocketAdapter(target);
    case "tcp": {
      const m = /^(?:tcp:\/\/)?([^:]+):(\d+)$/.exec(target);
      const host = flags.host ?? (m ? m[1] : "127.0.0.1");
      const port = flags.port ?? (m ? Number(m[2]) : 0);
      return new TcpAdapter({ host, port });
    }
    case "mock":
    default:
      return new MockAdapter();
  }
}

/** The exploration scripts used to record sessions when compiling against the mock. */
function mockSessionsSplit(): { train: Session[]; heldOut: Session[] } {
  const recorded = recordMockSessions();
  const heldOutIds = new Set([
    "s1-login-list-logout",
    "s3-login-ping-logout",
    "s4-login-list-get-ping-logout",
  ]);
  const train = recorded.filter((r) => !heldOutIds.has(r.id)).map((r) => r.session);
  const heldOut = recorded.filter((r) => heldOutIds.has(r.id)).map((r) => r.session);
  return { train, heldOut };
}

/** Explore a live adapter using the standard probe scripts and record sessions. */
async function exploreAdapter(make: () => Adapter): Promise<Session[]> {
  // For non-mock adapters we replay a probe corpus that exercises every protocol transition.
  const probeScripts = [
    ["LOGIN tok-a-1", "LIST", "LOGOUT"],
    ["LOGIN tok-b-2", "GET 1002", "LOGOUT"],
    ["LOGIN tok-c-3", "PING", "LOGOUT"],
    ["LOGIN tok-d-4", "LIST", "GET 1001", "PING", "LOGOUT"],
    ["LOGIN tok-e-5", "GET 9999", "GET 1002", "LOGOUT"],
    ["LOGIN tok-f-6", "LOGIN tok-f-7", "LIST", "LOGOUT"],
    ["LIST", "LOGIN tok-g-8", "LIST", "LOGOUT"],
    ["LOGIN tok-h-9", "PING", "LOGOUT", "LIST", "PING"],
  ];
  const sessions: Session[] = [];
  for (const script of probeScripts) {
    const adapter = make();
    await adapter.connect();
    const steps = [];
    for (const request of script) {
      const response = await adapter.send(request);
      steps.push({ verb: request, response });
    }
    await adapter.close();
    sessions.push({ steps, outcome: "success" });
  }
  return sessions;
}

async function cmdCompile(target: string, flags: Flags): Promise<number> {
  const kind = resolveAdapterKind(target, flags);
  process.stdout.write(`wireframe compile: target="${target}" adapter=${kind} gate=${flags.coverageGate}\n`);

  let train: Session[];
  let heldOut: Session[];

  if (kind === "mock") {
    const split = mockSessionsSplit();
    train = split.train;
    heldOut = split.heldOut;
  } else {
    const all = await exploreAdapter(() => buildAdapter(kind, target, flags));
    // Hold out the last two recorded sessions for a real generalization check.
    heldOut = all.slice(-2);
    train = all.slice(0, -2);
  }

  const model = infer(train);
  const { driver, report } = compile(model, { coverageGate: flags.coverageGate, heldOut });

  const driverJson = driver.toJSON();
  const out = flags.out ?? join(flags.from ?? process.cwd(), "driver.json");
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(driverJson, null, 2) + "\n", "utf8");

  process.stdout.write(
    `  states=${model.states.length} transitions=${model.transitions.length} ` +
      `coverage=${report.coverage} unsafeRate=${report.unsafeContinuationRate} passed=${report.passed}\n`
  );
  process.stdout.write(`  wrote driver to ${outPath}\n`);
  return report.passed ? 0 : 1;
}

async function cmdRun(driverPath: string, target: string, flags: Flags): Promise<number> {
  const json = JSON.parse(readFileSync(resolve(driverPath), "utf8"));
  const driver = Driver.fromJSON(json);
  const kind = resolveAdapterKind(target || "mock", flags);
  const adapter = buildAdapter(kind, target || "mock", flags);

  process.stdout.write(`wireframe run: driver="${driverPath}" adapter=${kind}\n`);
  await adapter.connect();
  driver.start();

  const happy = ["LOGIN tok-run-1", "LIST", "GET 1001", "PING", "LOGOUT"];
  let ok = true;
  for (const request of happy) {
    const response = await adapter.send(request);
    const symbol = abstractStep({ verb: request, response }).symbol;
    const r = driver.step(symbol);
    process.stdout.write(
      `  ${request.padEnd(16)} -> ${symbol.padEnd(24)} ${
        r.deterministic ? "[ok " + driver.state() + "]" : "[ESCALATE " + r.reason + "]"
      }\n`
    );
    if (!r.deterministic) {
      ok = false;
      break;
    }
  }
  await adapter.close();
  process.stdout.write(`  result: ${ok ? "completed on learned path (0 model calls)" : "escalated"}\n`);
  return ok ? 0 : 1;
}

function cmdInspect(driverPath: string): number {
  const json = JSON.parse(readFileSync(resolve(driverPath), "utf8"));
  const driver = Driver.fromJSON(json);
  process.stdout.write(`wireframe inspect: ${driverPath}\n`);
  process.stdout.write(`  initial: ${driver.initial}\n`);
  process.stdout.write(`  states (${driver.states.length}): ${driver.states.join(", ")}\n`);
  process.stdout.write(`  transitions (${driver.transitions.length}):\n`);
  for (const t of driver.transitions) {
    process.stdout.write(`    ${t.from} --${t.on}--> ${t.to}\n`);
  }
  if (driver.abstraction.length > 0) {
    process.stdout.write(`  abstraction: ${driver.abstraction.join(", ")}\n`);
  }
  return 0;
}

function usage(): void {
  process.stdout.write(
    [
      "wireframe <command>",
      "",
      "Commands:",
      "  compile <target> --from <dir> --adapter <auto|ws|tcp|mock> --coverage-gate <n> --out <file>",
      "  run <driver.json> [target] --adapter <auto|ws|tcp|mock>",
      "  inspect <driver.json>",
      "",
      "With --adapter mock (or auto on an unknown target) everything runs against the in-process mock.",
      "",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    process.exit(0);
  }
  const command = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  let code = 0;
  switch (command) {
    case "compile": {
      const target = positional[0] ?? "mock";
      code = await cmdCompile(target, flags);
      break;
    }
    case "run": {
      const driverPath = positional[0];
      if (!driverPath) {
        process.stderr.write("run: missing <driver.json>\n");
        code = 2;
        break;
      }
      const target = positional[1] ?? "mock";
      code = await cmdRun(driverPath, target, flags);
      break;
    }
    case "inspect": {
      const driverPath = positional[0];
      if (!driverPath) {
        process.stderr.write("inspect: missing <driver.json>\n");
        code = 2;
        break;
      }
      code = cmdInspect(driverPath);
      break;
    }
    default:
      usage();
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`wireframe: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
