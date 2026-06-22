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

## Repository

```
packages/core         @wframe/core   the library: inference, driver (action selection), adapters
packages/cli          @wframe/cli    the wireframe CLI
packages/core/demos   runnable coffee and HTTP demos
bench                 the self-verifying proof harness
```

## Run it yourself

```
npm install            # installs the workspaces
npm test               # @wframe/core unit tests
npm run bench          # the proof harness, prints PROOF: PASS

npm run demo:coffee -w @wframe/core   # the driver chooses commands toward a goal
npm run demo:http   -w @wframe/core   # the same, over a live local REST API
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
