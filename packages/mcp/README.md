# @wframe/mcp

A **Model Context Protocol (MCP) server** that puts [Wireframe](../core) in front of a coding agent
(Claude Code, Codex, …). It is how you **remove the model from the loop** for a repeated
sub-workflow: instead of ~30 model-decided tool calls against a stateful system, the agent

1. drives the target a few times **through Wireframe** so the sessions are recorded,
2. **compiles** a deterministic driver from those sessions (with coverage + safety gates), and
3. runs the learned workflow with a **single deterministic tool call** — **zero model calls** on the
   learned path, escalating safely only on something unseen.

Built on `@wframe/core`: record sessions → abstract (templating) → infer (APTA + red-blue merging) →
compile (coverage gate + forward-ambiguity safety) → drive (pure code, safe drift escalation).

---

## Install & build

From the repo root (npm workspaces):

```bash
npm install
npm run build            # builds @wframe/core, @wframe/cli, and @wframe/mcp
```

## Run the demo (no external services)

```bash
npm run demo:mcp         # from repo root
# or: npm run demo --workspace @wframe/mcp
# or: node packages/mcp/dist/demo.js
```

The demo drives a **self-contained, in-process "operations terminal"** black box (a fulfillment-order
workflow: `LOGIN → START_ORDER → ADD_ITEM* → SET_FIELD* → REVIEW → VALIDATE → SUBMIT → FINALIZE`,
with `OUT_OF_STOCK→SUBSTITUTE` and `FIX_REQUIRED→CORRECT` recovery branches). It:

1. **records** five varied successful sessions via the server's own engine (the same code
   `wireframe_step` / `wireframe_record_done` call),
2. **compiles** — prints `states`, `coverage=1`, and `GATE PASSED=true`,
3. **runs** the learned workflow toward `goal="submitted"` — prints the deterministic command
   sequence (including both recovery branches firing) and **`MODEL CALLS USED: 0`**, then
4. **escalates** on an unseen goal — the driver hands back to the model instead of guessing.

The demo exercises the **same engine** the MCP tools wrap, so it is a faithful preview of the tools.

## Run the MCP server

```bash
node packages/mcp/dist/server.js
# state is persisted under ./.wframe (override with WFRAME_DIR)
```

The server speaks MCP over **stdio**. Protocol state (recorded sessions, the compiled driver, the
compile report) is persisted to a `.wframe/` directory so state is shared across separate tool calls.

---

## Tools

| Tool | What it does |
| --- | --- |
| `wireframe_status` | List protocols with session count, compile state, coverage, and gate result. Also lists the in-process targets and their command vocabulary. |
| `wireframe_step` `{protocol, target, command}` | **During learning:** send one raw command to the target **through Wireframe**, record the step, return the response. Call repeatedly to drive a full successful session. |
| `wireframe_record_done` `{protocol}` | Finish the live session and append it to the protocol's corpus. |
| `wireframe_compile` `{protocol, coverageGate?}` | `infer` + `compile` + gate. Returns `states`, `transitions`, `coverage`, `unsafeContinuationRate`, `requiresFinerAbstraction`, `passed`. |
| `wireframe_run` `{protocol, goal}` | Run the compiled driver deterministically toward a goal. Returns the command sequence, `modelCallsUsed` (**0** on the learned path), `reachedGoal`, `wrongActions`, and whether it `escalated`. Goal accepts aliases: `submitted`/`done`, `validated`, `terminal`, or a literal learned state name. |

### Typical agent flow

```
# 1. learn: drive a few successful sessions through Wireframe
wireframe_step {protocol:"ops", target:"ops", command:"LOGIN"}
wireframe_step {protocol:"ops", target:"ops", command:"START_ORDER"}
... ADD_ITEM / SET_FIELD / REVIEW / VALIDATE / SUBMIT / FINALIZE ...
wireframe_record_done {protocol:"ops"}
# repeat for a handful of varied sessions (different loop counts, the recovery branches)

# 2. compile a deterministic driver and check the gate
wireframe_compile {protocol:"ops", coverageGate:0.95}
#   -> { states, coverage:1, passed:true, ... }

# 3. from now on, ONE deterministic call replaces the whole sub-workflow
wireframe_run {protocol:"ops", goal:"submitted"}
#   -> { commands:[...], modelCallsUsed:0, reachedGoal:true, escalated:false }
```

If `wireframe_run` returns `escalated:true`, the driver hit something it never learned (an unseen
response or no learned path to the goal). It **never guesses** — the agent takes over, and the new
session can be recorded (`wireframe_step`) and the protocol recompiled so the driver learns it.

---

## Add to Claude Code

```bash
claude mcp add wireframe -- node /absolute/path/to/wireframe/packages/mcp/dist/server.js
```

(Optionally set the state directory: append `--env WFRAME_DIR=/absolute/path/to/state`.)

Build first (`npm run build`) so `dist/server.js` exists.

---

## How "zero model calls" actually holds

- **Abstraction** templates each `(verb, raw response)` into a stable symbol `VERB/RESPONSE_TYPE`,
  stripping tokens/ids/timestamps, with `responseNamespace:'auto'` so coarse codes reused across
  verbs are split (and the forward-ambiguity gate has a finer model to compare against).
- **Inference** builds a prefix tree and merges states (red-blue), collapsing the `ADD_ITEM` /
  `SET_FIELD` loops into self-loops so the driver generalizes to any item/field count.
- **Compilation** gates on held-out **coverage**, an **unsafe-continuation rate of 0**, and **no
  spurious forward branch** (`requiresFinerAbstraction=false`). All three must hold for `passed`.
- **Driving** asks `driver.nextCommand(goal)` for each ordering verb (it refuses to guess on tied
  branches), issues task-context loop iterations confirmed legal against the learned model, and
  absorbs the recovery self-loops — all with **no model in the loop**.

## Targets

The server ships one in-process target, `ops` (the fulfillment terminal). Targets are addressed by
name in `wireframe_step`. To wire a real system (HTTP, WebSocket, TCP), register a target factory via
`registerTarget(name, factory)` from `./target.js`, or drive a live adapter from `@wframe/core`
(`HttpAdapter`, `WebSocketAdapter`, `TcpAdapter`) and feed the observed `{verb, response}` steps in.
