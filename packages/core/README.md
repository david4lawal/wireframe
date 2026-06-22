# @wframe/core

Infer a protocol state machine from black-box agent sessions, compile a safe deterministic driver, and prove it. No LLM on the learned path.

Part of [Wireframe](https://wframe.org). Full documentation: https://wframe.org/docs

## Install

```
npm i @wframe/core
```

## Use

```ts
import { Recorder, infer, compile } from '@wframe/core'

// 1. Record a few successful sessions. No SDK, no source code.
const recorder = new Recorder()
recorder.observe(session)        // { steps: [{ verb, response }], outcome: 'success' }

// 2. Infer the protocol state machine (evidence-driven red-blue merging).
const model = infer(recorder.sessions)

// 3. Compile behind a coverage gate. Hold out some sessions to verify.
const { driver, report } = compile(model, { coverageGate: 0.95, heldOut })
if (!report.passed) throw new Error('coverage gate not met, keep recording')

// 4. Drive the learned path. Zero model calls. Escalate on anything unseen.
driver.start()
const r = driver.step(symbol)    // { action } or { escalate: true }
```

## License

MIT
