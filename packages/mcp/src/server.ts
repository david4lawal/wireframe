#!/usr/bin/env node
/**
 * server.ts
 *
 * The Wireframe MCP server (stdio transport). It exposes a small, coherent set of tools that let a
 * coding agent (Claude Code, Codex) REMOVE ITSELF from a repeated sub-workflow:
 *
 *   wireframe_status        - list protocols + their compile/coverage/gate state, plus the target
 *                             vocabulary an agent can drive.
 *   wireframe_step          - DURING LEARNING: send one raw command to the target THROUGH Wireframe,
 *                             record it, and return the response. Repeat to capture a whole session.
 *   wireframe_record_done   - finish the current session and append it to the protocol's corpus.
 *   wireframe_compile       - infer + compile + gate. Returns states/coverage/gate result.
 *   wireframe_run           - run the compiled driver deterministically toward a goal. Returns the
 *                             command sequence, the outcome, model_calls_used (0 on the learned
 *                             path), and whether it escalated.
 *
 * All protocol state lives in a `.wframe` directory under the working dir, so state is shared across
 * tool calls. The tools are thin wrappers over engine.ts; the demo calls the SAME engine.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Engine } from "./engine.js";
import { registeredTargets } from "./target.js";

/** Where to persist protocol state. WFRAME_DIR overrides; default is the process cwd. */
const ROOT = process.env.WFRAME_DIR ?? process.cwd();
const engine = new Engine(ROOT);

const server = new McpServer({ name: "wireframe", version: "1.0.0" });

/** Wrap a handler so any throw becomes a clean MCP tool error instead of crashing the server. */
function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true as const, content: [{ type: "text" as const, text: `error: ${message}` }] };
}

const namespaceEnum = z
  .enum(["none", "by-verb", "auto"])
  .describe("Response-namespacing policy (use 'auto' unless you know you need otherwise).");

server.registerTool(
  "wireframe_status",
  {
    description:
      "List learned protocols with their session count, compile state, coverage, and gate result. " +
      "Also lists the in-process targets and their command vocabulary so an agent knows what to drive.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(engine.status());
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "wireframe_step",
  {
    description:
      "DURING LEARNING: send one raw command to the target THROUGH Wireframe, record the " +
      "request/response step, and return the response. Call repeatedly to drive the target through a " +
      "full successful session, then call wireframe_record_done. The first step of a session spins up " +
      "a fresh black-box target instance.",
    inputSchema: {
      protocol: z.string().describe("Protocol name to record under (created on first use)."),
      target: z
        .string()
        .describe(`In-process target to drive. Registered: ${registeredTargets().join(", ")}.`),
      command: z.string().describe('Raw wire command to send, e.g. "LOGIN" or "ADD_ITEM sku=SKU-1000".'),
      responseNamespace: namespaceEnum.optional(),
      seed: z.number().optional().describe("Seed for the target's deterministic error schedule."),
      forceOutOfStock: z.boolean().optional().describe("Force the OUT_OF_STOCK recovery branch."),
      forceNeedsFix: z.boolean().optional().describe("Force the FIX_REQUIRED recovery branch."),
    },
  },
  async (args) => {
    try {
      return ok(
        engine.step(args.protocol, args.target, args.command, {
          responseNamespace: args.responseNamespace,
          targetOptions: {
            seed: args.seed,
            forceOutOfStock: args.forceOutOfStock,
            forceNeedsFix: args.forceNeedsFix,
          },
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "wireframe_record_done",
  {
    description:
      "Finish the current live session for a protocol and append it to the protocol's corpus. Call " +
      "after driving the target to a successful end with wireframe_step.",
    inputSchema: {
      protocol: z.string().describe("Protocol whose live session to finish."),
      outcome: z.enum(["success", "failure"]).optional().describe("Defaults to 'success'."),
    },
  },
  async (args) => {
    try {
      return ok(engine.recordDone(args.protocol, args.outcome ?? "success"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "wireframe_compile",
  {
    description:
      "Infer the protocol FSM from the recorded sessions and compile a deterministic driver, gating " +
      "on coverage and the forward-ambiguity safety check. Returns states, transitions, coverage, " +
      "unsafeContinuationRate, requiresFinerAbstraction, and whether the gate passed.",
    inputSchema: {
      protocol: z.string().describe("Protocol to compile (needs >= 2 recorded sessions)."),
      coverageGate: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Coverage threshold the held-out check must meet. Defaults to 0.95."),
    },
  },
  async (args) => {
    try {
      return ok(engine.compileProtocol(args.protocol, { coverageGate: args.coverageGate }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "wireframe_run",
  {
    description:
      "Run the compiled driver deterministically toward a goal with ZERO model calls. The driver " +
      "SELECTS each next command itself (shortest verb path), sends it to a fresh target, and steps " +
      "on the observed response. Returns the command sequence, model_calls_used (0 on the learned " +
      "path), whether it reached the goal, and whether it escalated (handing back to the model). " +
      'Goal accepts aliases: "submitted"/"done", "validated", "terminal", or a literal state name.',
    inputSchema: {
      protocol: z.string().describe("Compiled protocol to run."),
      goal: z.string().describe('Goal: "submitted" / "done" / "validated" / "terminal" / a state name.'),
      seed: z.number().optional().describe("Seed for the target's deterministic error schedule."),
      forceOutOfStock: z.boolean().optional().describe("Force the OUT_OF_STOCK recovery branch."),
      forceNeedsFix: z.boolean().optional().describe("Force the FIX_REQUIRED recovery branch."),
    },
  },
  async (args) => {
    try {
      return ok(
        engine.run(args.protocol, args.goal, {
          targetOptions: {
            seed: args.seed,
            forceOutOfStock: args.forceOutOfStock,
            forceNeedsFix: args.forceNeedsFix,
          },
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the protocol channel).
  process.stderr.write(`wireframe-mcp: ready (state dir: ${engine.dir})\n`);
}

main().catch((err) => {
  process.stderr.write(`wireframe-mcp: fatal ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
