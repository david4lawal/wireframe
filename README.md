# Wireframe

**The deterministic execution layer agents graduate into.**

[**wframe.org**](https://wframe.org) · [Docs](https://wframe.org/docs) · MIT licensed

Wireframe records a few successful agent sessions against a black-box stateful system, infers the protocol's state machine, and compiles a deterministic driver that runs the learned path with **zero model calls**, escalating to the model only on something it has not seen.

> Modern streaming APIs or forty-year-old terminals. If an agent can succeed against it a few times, Wireframe can compile a driver for it.

## Why

An agent driving an undocumented API, a legacy network service, or a flaky MCP server spends most of its time reading raw frames and guessing the next message. It is slow, it costs a model call per step, and because it is guessing it desyncs. Wireframe removes the guessing from the steady state: learn the protocol once, then run it as plain code.

## Proof

The hard part is learning the state machine from examples, and the textbook methods get it wrong. On a controlled protocol whose true machine is known (3 states), measured by the benchmark in this repo:

| Method | States | Matches ground truth |
| --- | --- | --- |
| Prefix tree (no merge) | 24 | no, memorizes traces |
| Naive RPNI (greedy merge) | 1 | no, over-generalizes, accepts illegal sequences |
| k-tails (k=2) | 11 | no, under-generalizes |
| **Evidence-driven red-blue (Wireframe)** | **3** | **yes** |

With the compiled driver: **100%** held-out coverage, **0** unsafe continuations over 305 invalid sequences, **0** model calls on the learned path, and identical output across 1000 deterministic runs. Reproduce it:

```
npm install
npm run bench    # prints PROOF: PASS and writes bench/results.json
```

The live numbers render at [wframe.org](https://wframe.org), shown only when the run passes its own self-check.

It is not only a controlled protocol. Wireframe learns **real** wire protocols too: `npm run demo:smtp:real` records a real Nodemailer SMTP server over a socket and drives the compiled driver to send a multi-recipient email with zero model calls; `npm run demo:postgres:real` recovers the Postgres transaction state machine (idle / in-transaction) from the raw binary wire protocol. No Docker, fully local.

## Install

```
npm i @wframe/core
```

```ts
import { Recorder, infer, compile } from '@wframe/core'

const recorder = new Recorder()
recorder.observe(session)        // { steps: [{ verb, response }], outcome: 'success' }

const model = infer(recorder.sessions)
const { driver, report } = compile(model, { coverageGate: 0.95, heldOut })

driver.start()
driver.step(symbol)              // runs the learned path, escalates on anything unseen
```

## CLI

```
wireframe compile mock --coverage-gate 0.95   # learn a driver against the built-in mock
wireframe inspect ./driver.json               # states, transitions, abstraction
wireframe run ./driver.json --adapter mock    # drive the learned path
```

## MCP server

Use Wireframe from a coding agent (Claude Code, Codex) as an MCP server. The agent drives a target system through Wireframe to record sessions, compiles a driver, then runs a learned sub-workflow with a single deterministic tool call instead of N model-decided steps.

```
claude mcp add wireframe -- npx -y @wframe/mcp
```

Tools: `wireframe_step` (drive a target through Wireframe, recording the session), `wireframe_compile` (infer + compile behind the safety gate), `wireframe_run` (run the learned workflow deterministically, zero model calls), and `wireframe_status`. See [packages/mcp](packages/mcp).

## Repository

```
packages/core         @wframe/core   the library: inference, driver (action selection), adapters
packages/cli          @wframe/cli    the wireframe CLI
packages/mcp          @wframe/mcp    the MCP server for coding agents
packages/core/demos   runnable demos, including the real SMTP and Postgres wire-protocol proofs
bench                 the self-verifying proof harness
```

## Run it yourself

```
npm install            # installs the workspaces
npm test               # @wframe/core unit tests
npm run bench          # the proof harness, prints PROOF: PASS

npm run demo:coffee        -w @wframe/core   # the driver chooses commands toward a goal
npm run demo:http          -w @wframe/core   # the same, over a live local REST API
npm run demo:smtp:real     -w @wframe/core   # learns a REAL SMTP server, then sends an email, 0 model calls
npm run demo:postgres:real -w @wframe/core   # learns the REAL Postgres wire-protocol transaction machine
```

## Research

Wireframe combines three proven primitives that, to our knowledge, had not been combined against a live black-box system:

- L*LM: Learning Automata from Examples using Natural Language Oracles ([arXiv:2402.07051](https://arxiv.org/abs/2402.07051))
- Inferring State Machines from Protocol Implementations ([arXiv:2405.00393](https://arxiv.org/abs/2405.00393))
- LLM Agents with Record and Replay ([arXiv:2505.17716](https://arxiv.org/abs/2505.17716))
- LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks ([arXiv:2402.01817](https://arxiv.org/abs/2402.01817))
- Evaluating LLMs on Sequential API Calls ([arXiv:2507.09481](https://arxiv.org/abs/2507.09481))

## License

MIT. See [LICENSE](LICENSE).
