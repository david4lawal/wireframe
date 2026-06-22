import { Fragment, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowRight, ArrowUpRight, Check, ChevronDown, CornerDownLeft, Copy, Database, Github, GitBranch, Loader2, Lock, Mail, Moon, Radio, Server, ShieldCheck, Sun, X, Zap } from 'lucide-react'
import './styles.css'

interface Driver { states: string[]; transitions: Array<{ from: string; on: string; to: string }> }
interface MethodRow { method: string; states: number; coverage: number; matchesGroundTruth: boolean; note: string }
interface CurvePoint { sessions: number; states: number; coverage: number; matchesGroundTruth: boolean }
interface Latency { driver: { p50: number; p95: number; p99: number; n: number; unit: string }; modelBaseline: { p50Ms: number; estimated: boolean; source: string } }
interface Conformance { validSequences: { tested: number; accepted: number }; invalidSequences: { tested: number; rejectedSafely: number; unsafeContinuations: number }; byCategory: Array<{ category: string; tested: number; caught: number }> }
interface Results {
  generatedAt: string
  version: number
  passed?: boolean
  protocol: { name: string; groundTruth: { states: number; transitions: number } }
  learning: { sessionsObserved: number; messagesObserved: number; statesInferred: number; transitionsInferred: number; fsmMatchesGroundTruth: boolean; parameterFieldsAbstracted: string[] }
  metrics: { coverage: number; coverageGate?: number; heldOutSessions: number; unsafeContinuationRate: number; invalidSequencesTested: number; learnedPathModelCalls: number; baselineModelCalls: number; driverP50LatencyMs: number; driftDetected: boolean; driftEscalatedSafely: boolean }
  methodComparison?: MethodRow[]
  learningCurve?: CurvePoint[]
  latency?: Latency
  conformance?: Conformance
  determinism?: { runs: number; distinctOutputs: number; note: string }
  driftScenarios?: Array<{ name: string; detected: boolean; escalatedSafely: boolean }>
  emittedDriver: Driver
}

// Set VITE_WAITLIST_URL to the deployed worker in production. Defaults to the local wrangler dev server.
const WAITLIST_URL: string = (((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WAITLIST_URL) || 'http://localhost:8787').replace(/\/$/, '')

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1100) }} aria-label="Copy">
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function StateMachine({ driver, label, verified }: { driver: Driver; label: string; verified?: boolean }) {
  const states = driver.states
  const n = Math.max(states.length, 1)
  const W = 520, H = 300, padX = 74, y = 192
  const xs = states.map((_, i) => (n > 1 ? padX + (i * (W - 2 * padX)) / (n - 1) : W / 2))
  const idx = (name: string) => states.indexOf(name)

  const grouped = new Map<string, { from: string; to: string; labels: string[] }>()
  for (const t of driver.transitions) {
    const key = `${t.from}->${t.to}`
    const g = grouped.get(key) ?? { from: t.from, to: t.to, labels: [] }
    g.labels.push(t.on)
    grouped.set(key, g)
  }

  return (
    <div className="machine">
      <div className="machine__bar">
        <span className="dot" />
        <span className="mono">{label}</span>
        {verified
          ? <span className="tag">verified</span>
          : <span className="tag" style={{ color: 'var(--ink-3)', borderColor: 'var(--line-2)' }}>example</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="inferred protocol state machine">
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
          </marker>
        </defs>
        {[...grouped.values()].map((g, k) => {
          const a = idx(g.from), b = idx(g.to)
          if (a < 0 || b < 0) return null
          const text = g.labels.join(', ')
          if (a === b) {
            const x = xs[a]
            return (
              <g key={k}>
                <path className="fsm-edge fsm-edge--accent" d={`M ${x - 16} ${y - 24} C ${x - 34} ${y - 62}, ${x + 34} ${y - 62}, ${x + 16} ${y - 24}`} markerEnd="url(#wf-arrow)" />
                {g.labels.map((lbl, li) => (
                  <text key={li} className="fsm-edge-label" x={x} y={y - 72 - (g.labels.length - 1 - li) * 13} textAnchor="middle">{lbl}</text>
                ))}
              </g>
            )
          }
          const x1 = xs[a], x2 = xs[b]
          const forward = b > a
          const my = forward ? y - 56 : y + 56
          const mx = (x1 + x2) / 2
          const sx = x1 + (forward ? 22 : -22)
          const ex = x2 + (forward ? -22 : 22)
          return (
            <g key={k}>
              <path className="fsm-edge fsm-edge--accent" d={`M ${sx} ${forward ? y - 8 : y + 8} Q ${mx} ${my} ${ex} ${forward ? y - 8 : y + 8}`} markerEnd="url(#wf-arrow)" />
              <text className="fsm-edge-label" x={mx} y={forward ? my - 4 : my + 12} textAnchor="middle">{text}</text>
            </g>
          )
        })}
        {states.map((s, i) => (
          <g key={s}>
            <rect className={i === 0 ? 'fsm-node fsm-node--accent' : 'fsm-node'} x={xs[i] - 38} y={y - 17} width={76} height={34} rx={6} />
            <text className="fsm-label" x={xs[i]} y={y + 4} textAnchor="middle">{s}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

function Hero({ onStart, onProof }: { onStart: () => void; onProof: () => void }) {
  const examples = [
    { cat: 'Compile a streaming API', desc: <>Learn an undocumented <b>websocket</b> protocol into a driver.</> },
    { cat: 'Wrap a legacy service', desc: <>Drive a forty-year-old <b>TCP</b> service with no SDK.</> },
    { cat: 'Bridge an MCP server', desc: <>Turn a flaky <b>MCP tool</b> into a deterministic client.</> },
    { cat: 'Control a device plane', desc: <>Learn a <b>BLE</b> control protocol, read-only first.</> },
  ]
  return (
    <section className="hero">
      <span className="hero-badge"><i /> open source · MIT</span>
      <h1>The <span className="hl">Deterministic</span> Integration Infrastructure for Agents</h1>
      <p className="hero__tagline">A protocol compiler for every system without a usable API.</p>
      <p className="hero__sub">
        Wireframe learns a black-box protocol from a few agent sessions and compiles a driver your agents run with
        zero model calls. Modern streaming APIs or forty-year-old terminals.
      </p>
      <div className="hero-input">
        <div className="hero-input__field"><b>wireframe compile</b> wss://orders.internal:9000 --from ./recorded-sessions</div>
        <div className="hero-input__row">
          <span className="chip-sel">adapter: auto <ChevronDown size={12} /></span>
          <span className="chip-sel">sessions: 5 <ChevronDown size={12} /></span>
          <span className="chip-sel">coverage gate: 95% <ChevronDown size={12} /></span>
          <span className="hero-input__go"><ArrowRight size={16} strokeWidth={2.4} /></span>
        </div>
      </div>
      <div className="hero-cta">
        <button className="btn btn--primary btn--lg" onClick={onStart}>Get started <ArrowRight size={15} /></button>
        <button className="btn btn--lg" onClick={onProof}>See the proof</button>
      </div>
      <div className="hero-examples-label">Example tasks</div>
      <div className="hero-examples">
        {examples.map((e, i) => (
          <div className="ex-card" key={i} onClick={onStart}>
            <span className="ex-card__arrow"><ArrowRight size={15} /></span>
            <div>
              <div className="ex-card__cat">{e.cat}</div>
              <div className="ex-card__desc">{e.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Problem() {
  return (
    <section className="section wrap">
      <div className="problem">
        <div className="problem__txt">
          <span className="kicker">the failure</span>
          <h2>Agents fumble the boundary, slowly, forever.</h2>
          <p>
            Every undocumented API, legacy network service, device control plane, or internal system with no real
            connector gets driven by an agent sitting in a tight loop, reading raw frames and guessing the next
            message. It is the slowest and most expensive I/O an agent does, it re-discovers the same handshake on
            every session, and because it is guessing, it desyncs and fails.
          </p>
        </div>
        <div className="problem__demo">
          <div className="cmp cmp--bad">
            <span className="cmp__tag cmp__tag--bad">today</span>
            <div className="cmp__row">
              <span className="cmp__chip"><b>read frame</b></span>
              <span className="cmp__chip">ask model</span>
              <span className="cmp__chip">guess reply</span>
              <span className="cmp__cost mono">model call / message</span>
            </div>
          </div>
          <div className="cmp cmp--good">
            <span className="cmp__tag cmp__tag--good">after wireframe</span>
            <div className="cmp__row">
              <span className="cmp__chip"><b>compiled driver</b></span>
              <span className="cmp__chip">run learned path</span>
              <span className="cmp__cost mono">0 model calls</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  const stages = [
    { n: '01', t: 'Record', d: 'A proxy captures your agent talking to the system. No SDK, no source code.', icon: <Radio size={17} /> },
    { n: '02', t: 'Confirm', d: 'You mark a session that succeeded and the result it should produce.', icon: <Check size={17} /> },
    { n: '03', t: 'Infer', d: 'It separates protocol structure from parameters and induces the state machine.', icon: <GitBranch size={17} /> },
    { n: '04', t: 'Verify', d: 'It replays held-out traces and gates on coverage before a driver ships.', icon: <ShieldCheck size={17} /> },
    { n: '05', t: 'Serve', d: 'The compiled driver runs the learned path at native speed, zero model calls.', icon: <Zap size={17} /> },
  ]
  return (
    <section className="section wrap" id="how">
      <div className="section__head">
        <span className="kicker">how it works</span>
        <h2>Agents explore. Then they graduate into determinism.</h2>
      </div>
      <div className="pipeline">
        {stages.map((s, i) => (
          <Fragment key={s.n}>
            <div className="stage">
              <div className="stage__top"><span className="stage__icon">{s.icon}</span><span className="stage__num">{s.n}</span></div>
              <div className="stage__title">{s.t}</div>
              <div className="stage__desc">{s.d}</div>
            </div>
            {i < stages.length - 1 ? <div className="link" /> : null}
          </Fragment>
        ))}
      </div>
      <div className="pipeline__return"><CornerDownLeft size={14} /> <span>Anything the driver has not learned <b>stops and returns to the model.</b></span></div>
    </section>
  )
}

function MethodComparison({ rows, truthStates, sessions }: { rows: MethodRow[]; truthStates: number; sessions: number }) {
  return (
    <div className="pcard pcard--wide">
      <div className="pcard__h"><GitBranch size={14} /> Why naive merging fails<span className="pcard__sub">same {sessions} sessions, four algorithms</span></div>
      <div className="methods">
        {rows.map((r) => {
          const ours = r.matchesGroundTruth
          return (
            <div className={`mrow ${ours ? 'mrow--ours' : ''}`} key={r.method}>
              <div className="mrow__name">{r.method}{ours ? <span className="mrow__badge">ours</span> : null}</div>
              <div className={`mrow__states ${r.states === truthStates ? 'is-ok' : ''}`}>{r.states} {r.states === 1 ? 'state' : 'states'}</div>
              <div className="mrow__bar"><span style={{ width: `${Math.round(r.coverage * 100)}%` }} /></div>
              <div className="mrow__match" data-ok={r.matchesGroundTruth}>{r.matchesGroundTruth ? <Check size={14} /> : <X size={14} />}</div>
              <div className="mrow__note">{r.note}</div>
            </div>
          )
        })}
      </div>
      <div className="pcard__cap">Ground truth is {truthStates} states. Only evidence-driven red-blue merging recovers it. Aggressive merging collapses the machine and accepts illegal sequences, no merging memorizes the traces.</div>
    </div>
  )
}

function LearningCurve({ points }: { points: CurvePoint[] }) {
  const W = 320, H = 130, pad = 10
  const maxS = Math.max(...points.map((p) => p.sessions), 1)
  const x = (s: number) => pad + ((s - 1) / Math.max(maxS - 1, 1)) * (W - 2 * pad)
  const y = (c: number) => H - pad - c * (H - 2 * pad)
  const line = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.sessions).toFixed(1)} ${y(p.coverage).toFixed(1)}`).join(' ')
  const area = `${line} L ${x(maxS).toFixed(1)} ${(H - pad).toFixed(1)} L ${x(1).toFixed(1)} ${(H - pad).toFixed(1)} Z`
  const converged = points.find((p) => p.matchesGroundTruth)
  return (
    <div className="pcard">
      <div className="pcard__h"><Activity size={14} /> Learning curve<span className="pcard__sub">coverage vs sessions</span></div>
      <svg className="curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="coverage versus sessions observed">
        <line className="curve__base" x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} />
        <path className="curve__area" d={area} />
        <path className="curve__line" d={line} />
        {converged ? <line className="curve__mark" x1={x(converged.sessions)} y1={pad} x2={x(converged.sessions)} y2={H - pad} /> : null}
        {points.map((p) => <circle key={p.sessions} cx={x(p.sessions)} cy={y(p.coverage)} r={2.8} className="curve__dot" />)}
      </svg>
      <div className="pcard__cap">{converged ? <>Matches ground truth at <b>{converged.sessions} sessions</b>, coverage climbs to {pct(points[points.length - 1].coverage)}.</> : 'Coverage approaching ground truth.'}</div>
    </div>
  )
}

function LatencyCard({ latency }: { latency: Latency }) {
  return (
    <div className="pcard">
      <div className="pcard__h"><Zap size={14} /> Driver latency<span className="pcard__sub">{latency.driver.n.toLocaleString()} steps measured</span></div>
      <div className="lat">
        <div className="lat__big">{latency.driver.p50}<span>ms p50</span></div>
        <div className="lat__row"><span>p95</span><b>{latency.driver.p95} ms</b></div>
        <div className="lat__row"><span>p99</span><b>{latency.driver.p99} ms</b></div>
      </div>
      <div className="pcard__cap">A model call on the same step costs roughly {latency.modelBaseline.p50Ms} ms ({latency.modelBaseline.source}, estimated). The learned path removes the call entirely.</div>
    </div>
  )
}

function ConformanceCard({ c }: { c: Conformance }) {
  return (
    <div className="pcard">
      <div className="pcard__h"><ShieldCheck size={14} /> Conformance gate<span className="pcard__sub">held-out sequences</span></div>
      <div className="conf">
        <div className="conf__cell"><div className="conf__n is-ok">{c.validSequences.accepted}/{c.validSequences.tested}</div><div className="conf__l">valid accepted</div></div>
        <div className="conf__cell"><div className="conf__n is-ok">{c.invalidSequences.rejectedSafely}/{c.invalidSequences.tested}</div><div className="conf__l">invalid refused</div></div>
        <div className="conf__cell"><div className="conf__n is-ok">{c.invalidSequences.unsafeContinuations}</div><div className="conf__l">unsafe continuations</div></div>
      </div>
      <div className="conf__cats">
        {c.byCategory.map((cat) => <div className="conf__cat" key={cat.category}><span>{cat.category}</span><b>{cat.caught}/{cat.tested}</b></div>)}
      </div>
    </div>
  )
}

function DriftCard({ scenarios, determinism }: { scenarios: NonNullable<Results['driftScenarios']>; determinism: NonNullable<Results['determinism']> }) {
  return (
    <div className="pcard">
      <div className="pcard__h"><Activity size={14} /> Drift and determinism<span className="pcard__sub">safe by construction</span></div>
      <div className="drift">
        {scenarios.map((s) => <div className="drift__row" key={s.name}><Check size={13} /> <span>{s.name}</span> <em>{s.escalatedSafely ? 'escalated safely' : 'handled'}</em></div>)}
      </div>
      <div className="pcard__cap">{determinism.runs.toLocaleString()} runs of the same input produced <b>{determinism.distinctOutputs}</b> distinct output. {determinism.note}</div>
    </div>
  )
}

function Proof({ results, passed, missing }: { results: Results | null; passed: boolean; missing: boolean }) {
  return (
    <section className="section wrap" id="proof">
      <div className="section__head">
        <span className="kicker">the proof</span>
        <h2>Inferred against a black-box protocol, checked against ground truth.</h2>
        <p>A read-only stateful protocol with a known state machine, learned from a handful of recorded sessions, then verified. Every number below is computed by the benchmark, shown only when the run passes its own self-check.</p>
      </div>
      {results && passed ? (
        <>
          <div className="proof">
            <div className="stat-grid">
              <div className="stat"><div className="stat__n stat__n--ok">{results.metrics.unsafeContinuationRate}</div><div className="stat__l">unsafe <b>continuations</b></div></div>
              <div className="stat"><div className="stat__n stat__n--ok">{results.metrics.learnedPathModelCalls}</div><div className="stat__l">model calls, <b>learned path</b></div></div>
              <div className="stat"><div className="stat__n">{pct(results.metrics.coverage)}</div><div className="stat__l">held-out <b>coverage</b></div></div>
              <div className="stat"><div className="stat__n">{results.learning.statesInferred}</div><div className="stat__l">states <b>inferred</b></div></div>
            </div>
            <StateMachine driver={results.emittedDriver} label={`${results.protocol.name}.driver`} verified />
            <div className="proof-note" style={{ gridColumn: '1 / -1' }}>
              <span className="check-row"><Check size={13} /> matches ground-truth state machine</span>
              {results.metrics.driftDetected && results.metrics.driftEscalatedSafely ? <span className="check-row"><Check size={13} /> drift detected and escalated safely</span> : null}
              <span className="check-row"><Check size={13} /> abstracted: {results.learning.parameterFieldsAbstracted.join(', ')}</span>
              <p style={{ marginLeft: 'auto' }}>baseline: {results.metrics.baselineModelCalls} model calls per task, learned path: 0.</p>
            </div>
          </div>
          <div className="proof-cards">
            {results.methodComparison ? <MethodComparison rows={results.methodComparison} truthStates={results.protocol.groundTruth.states} sessions={results.learning.sessionsObserved} /> : null}
            {results.learningCurve ? <LearningCurve points={results.learningCurve} /> : null}
            {results.latency ? <LatencyCard latency={results.latency} /> : null}
            {results.conformance ? <ConformanceCard c={results.conformance} /> : null}
            {results.driftScenarios && results.determinism ? <DriftCard scenarios={results.driftScenarios} determinism={results.determinism} /> : null}
          </div>
          <div className="proof-foot mono">artifact generated {new Date(results.generatedAt).toISOString().slice(0, 10)} · self-verified · schema v{results.version}</div>
        </>
      ) : (
        <div className="proof">
          <div className="placeholder">
            {missing
              ? <>Run <code>npm run bench</code> in <code>wireframe/bench</code> to generate the proof. This page shows only real, self-verified results.</>
              : results
                ? <>Proof pending. The current inference run has not converged to the ground-truth state machine yet (coverage {pct(results.metrics.coverage)}, match {String(results.learning.fsmMatchesGroundTruth)}). Verified numbers appear here only once the run passes its self-check.</>
                : 'Loading proof artifact...'}
          </div>
        </div>
      )}
    </section>
  )
}

const PAPERS = [
  {
    id: '2402.07051',
    cat: 'cs.LG',
    title: 'L*LM: Learning Automata from Examples using Natural Language Oracles',
    authors: 'Vazquez-Chanlatte, Elmaaroufi, Witwicki, Zaharia, Seshia',
    year: '2024',
    abstract: 'Expert demonstrations have proven an easy way to indirectly specify complex tasks. Recent algorithms even support extracting unambiguous formal specifications, for example deterministic finite automata, from demonstrations.',
    tags: ['Automata learning', 'DFA', 'Demonstrations'],
    why: 'The learning core. Induce a deterministic state machine from a handful of demonstrations, with an oracle allowed to answer unsure instead of guessing.',
  },
  {
    id: '2405.00393',
    cat: 'cs.CR',
    title: 'Unleashing the Power of LLM to Infer State Machine from the Protocol Implementation',
    authors: 'Wei, Chen, Du, Wu, Huang, Liu, Cheng, Xu, Wang, Mao',
    year: '2024',
    abstract: 'State machines are essential for enhancing protocol analysis to identify vulnerabilities. However, inferring state machines from network protocol implementations is challenging due to complex code syntax and semantics.',
    tags: ['Protocol FSM', 'White-box'],
    why: 'The white-box counterpart. It recovers the same object Wireframe targets, but needs the source code. That is the exact seam we own from the outside.',
  },
  {
    id: '2505.17716',
    cat: 'cs.AI',
    title: 'Get Experience from Practice: LLM Agents with Record and Replay',
    authors: 'Feng, Zhou, Liu, Chen, Dong, Zhang, Zhao, Du, Hua, Xia, Chen',
    year: '2025',
    abstract: 'AI agents have rapidly evolved from chatbots into autonomous entities executing complex, multi-step tasks. However, the inherent uncertainty and heavy compute of LLMs pose challenges to reliability, privacy, cost, and performance.',
    tags: ['Agents', 'Record and replay'],
    why: 'Replay, not compile. It replays captured experience but never synthesizes the automaton, which is the gap a verified driver fills.',
  },
  {
    id: '2402.01817',
    cat: 'cs.AI',
    title: "LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks",
    authors: 'Kambhampati, Valmeekam, Guan, Verma, Stechly, Bhambri, Saldyt, Murthy',
    year: '2024',
    abstract: 'There is considerable confusion about the role of LLMs in planning and reasoning tasks. We argue they cannot plan or self-verify alone, but are valuable inside a framework paired with sound external verifiers.',
    tags: ['Correctness gate', 'Verifier in loop'],
    why: 'The correctness-gate principle. A sound external check decides what ships. Wireframe applies it as a coverage and conformance gate before a driver is emitted.',
  },
  {
    id: '2507.09481',
    cat: 'cs.SE',
    title: 'Evaluating LLMs on Sequential API Call Through Automated Test Generation',
    authors: 'Huang, Song, Song, Ji, Wang, Wang, Ma',
    year: '2025',
    abstract: 'By integrating tools from external APIs, LLMs have expanded their capabilities across complex real-world tasks. However, testing, evaluation, and analysis of LLM tool use remain in their early stages.',
    tags: ['Stateful API', 'Benchmark'],
    why: 'Why this matters. Stateful, sequential API use by LLMs is unreliable and under-tested, which is exactly the surface a compiled driver makes deterministic.',
  },
]

function Research() {
  return (
    <section className="section wrap" id="research">
      <div className="section__head">
        <span className="kicker">grounded in research</span>
        <h2>Built on published work, not a hunch.</h2>
        <p>Wireframe fuses three proven primitives, automata learning, protocol inference, and correctness-gated compilation, that no one has combined against a live black-box system.</p>
      </div>
      <div className="papers">
        {PAPERS.map((p) => (
          <a className="paper-card" key={p.id} href={`https://arxiv.org/abs/${p.id}`} target="_blank" rel="noreferrer">
            <div className="paper-doc">
              <div className="paper-doc__rule" />
              <div className="paper-doc__title">{p.title}</div>
              <div className="paper-doc__authors">{p.authors}</div>
              <div className="paper-doc__mark"><GitBranch size={15} /></div>
              <div className="paper-doc__absh">Abstract</div>
              <div className="paper-doc__abs">{p.abstract}</div>
              <div className="paper-doc__fade" />
            </div>
            <div className="paper-meta">
              <div className="paper-meta__row1">
                <span className="paper-meta__id">{p.id}</span>
                <span className="paper-meta__cat">{p.cat}</span>
                <span className="paper-meta__pdf">PDF <ArrowUpRight size={12} /></span>
              </div>
              <div className="paper-meta__title">{p.title}</div>
              <div className="paper-meta__authors">{p.authors} · {p.year}</div>
              <div className="paper-meta__tags">{p.tags.map((t) => <span key={t} className="ptag">{t}</span>)}</div>
              <div className="paper-meta__why"><b>For Wireframe</b> {p.why}</div>
            </div>
          </a>
        ))}
      </div>
    </section>
  )
}

const WL_JOINED_KEY = 'wireframe-waitlist-joined'
const WL_POPUP_KEY = 'wireframe-waitlist-popup-seen'

function useWaitlist() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [count, setCount] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!WAITLIST_URL) return
    fetch(`${WAITLIST_URL}/api/waitlist/count`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.count === 'number') setCount(d.count) })
      .catch(() => {})
  }, [])

  const submit = async (email: string, hp: string, ref: string) => {
    if (state === 'loading') return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setState('error'); setMsg('Enter a valid email address.'); return }
    setState('loading')
    try {
      const r = await fetch(`${WAITLIST_URL}/api/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, website: hp, ref }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.ok) {
        setState('done')
        if (typeof d.count === 'number') setCount(d.count)
        setMsg(d.already ? 'You are already on the list.' : 'You are on the list.')
        try { localStorage.setItem(WL_JOINED_KEY, '1') } catch { /* ignore */ }
      } else {
        setState('error')
        setMsg(d.error === 'rate_limited' ? 'Too many tries, give it a minute.' : 'Could not join, please try again.')
      }
    } catch {
      setState('error')
      setMsg('Waitlist is offline right now, check back soon.')
    }
  }

  return { state, count, msg, submit }
}

function Waitlist() {
  const { state, count, msg, submit } = useWaitlist()
  const [email, setEmail] = useState('')
  const [hp, setHp] = useState('')
  return (
    <div className="waitlist">
      <div className="waitlist__head">
        <Mail size={16} /><span>Join the waitlist</span>
        {count !== null ? <span className="waitlist__count">{count.toLocaleString()} joined</span> : null}
      </div>
      {state === 'done' ? (
        <div className="waitlist__done"><Check size={15} /> {msg}</div>
      ) : (
        <form className="waitlist__form" onSubmit={(e) => { e.preventDefault(); submit(email, hp, 'landing') }}>
          <input className="waitlist__input" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" aria-label="Email address" />
          <input className="waitlist__hp" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} aria-hidden="true" placeholder="Company website" />
          <button className="btn btn--primary" type="submit" disabled={state === 'loading'}>
            {state === 'loading' ? <Loader2 size={14} className="spin" /> : <>Request access <ArrowRight size={14} /></>}
          </button>
        </form>
      )}
      {state === 'error'
        ? <div className="waitlist__err">{msg}</div>
        : <div className="waitlist__note"><Lock size={11} /> Stored encrypted, never shown publicly, no endpoint returns it. We email once, when hosted opens.</div>}
    </div>
  )
}

function WaitlistModal() {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [hp, setHp] = useState('')
  const { state, count, msg, submit } = useWaitlist()

  // Fire once, after the reader has engaged but before they reach the footer form.
  useEffect(() => {
    try { if (localStorage.getItem(WL_POPUP_KEY) || localStorage.getItem(WL_JOINED_KEY)) return } catch { /* ignore */ }
    let done = false
    const onScroll = () => {
      if (done) return
      const scrollable = document.documentElement.scrollHeight - window.innerHeight
      if (scrollable < 600) return
      const progress = window.scrollY / scrollable
      if (progress > 0.3 && progress < 0.85) {
        try { if (localStorage.getItem(WL_JOINED_KEY)) { done = true; window.removeEventListener('scroll', onScroll); return } } catch { /* ignore */ }
        done = true
        setOpen(true)
        try { localStorage.setItem(WL_POPUP_KEY, '1') } catch { /* ignore */ }
        window.removeEventListener('scroll', onScroll)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (state !== 'done') return
    const t = setTimeout(() => setOpen(false), 2400)
    return () => clearTimeout(t)
  }, [state])

  if (!open) return null
  return (
    <div className="wl-modal" role="dialog" aria-modal="true" aria-label="Join the Wireframe waitlist">
      <div className="wl-modal__backdrop" onClick={() => setOpen(false)} />
      <div className="wl-modal__card">
        <button className="wl-modal__x" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
        <span className="wl-modal__kicker"><span className="wl-modal__dot" /> early access</span>
        <h3>Be first when hosted opens.</h3>
        <p>
          Wireframe compiles your agents a deterministic driver for any black-box system, zero model calls on the learned path. Get an invite before the public launch.
          {count !== null && count >= 25 ? <> <b>{count.toLocaleString()} builders</b> are already in line.</> : null}
        </p>
        {state === 'done' ? (
          <div className="waitlist__done"><Check size={15} /> {msg}</div>
        ) : (
          <form className="wl-modal__form" onSubmit={(e) => { e.preventDefault(); submit(email, hp, 'popup') }}>
            <input className="waitlist__input" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="email" aria-label="Email address" />
            <input className="waitlist__hp" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} aria-hidden="true" placeholder="Company website" />
            <button className="btn btn--primary" type="submit" disabled={state === 'loading'}>
              {state === 'loading' ? <Loader2 size={14} className="spin" /> : <>Request access <ArrowRight size={14} /></>}
            </button>
          </form>
        )}
        {state === 'error'
          ? <div className="waitlist__err">{msg}</div>
          : <div className="wl-modal__note"><Lock size={11} /> Stored encrypted, never shown publicly. One email when hosted opens.</div>}
      </div>
    </div>
  )
}

function Hosted() {
  const features = [
    { icon: <Server size={16} />, t: 'Managed compile', d: 'Push recorded sessions, get a verified driver back. Inference, gating, and conformance run as a service.' },
    { icon: <Database size={16} />, t: 'Private driver store', d: 'Versioned, credentialed drivers for your internal systems. Diff, roll back, and share across a fleet.' },
    { icon: <Activity size={16} />, t: 'Drift monitoring', d: 'Every escalation is logged. When a system changes, you see it and recompile before it bites.' },
    { icon: <Lock size={16} />, t: 'Stays yours', d: 'Self-host the whole stack under MIT, or let us run it. Your protocols and credentials never enter a prompt.' },
  ]
  return (
    <section className="section wrap" id="hosted">
      <div className="section__head">
        <span className="kicker">hosted</span>
        <h2>Run Wireframe as a service.</h2>
        <p>The open core is the recorder, the inference engine, and the runtime. Hosted adds a managed compile pipeline and a private driver store for teams that would rather not operate it.</p>
      </div>
      <div className="hosted">
        <div className="hosted__features">
          {features.map((f) => (
            <div className="hfeat" key={f.t}>
              <span className="hfeat__icon">{f.icon}</span>
              <div><div className="hfeat__t">{f.t}</div><div className="hfeat__d">{f.d}</div></div>
            </div>
          ))}
        </div>
        <Waitlist />
      </div>
    </section>
  )
}

function GetStarted() {
  return (
    <section className="section wrap" id="start">
      <div className="section__head">
        <span className="kicker">get started</span>
        <h2>Compile your first driver.</h2>
      </div>
      <div className="start">
        <div className="start__code">
          <div className="install"><span className="prompt">$</span><span className="mono" style={{ flex: 1 }}>npm i @wireframe/core</span><Copyable text="npm i @wireframe/core" /></div>
          <div className="term">
            <div className="term__bar"><span className="term__dot" /><span className="term__tab mono">compile.ts</span></div>
            <pre>
<span className="k">import</span> {'{ Recorder, infer, compile }'} <span className="k">from</span> <span className="s">'@wireframe/core'</span>{'\n\n'}
<span className="c">// 1. record successful agent sessions (no SDK, no source)</span>{'\n'}
<span className="k">const</span> sessions = <span className="k">new</span> <span className="s">Recorder</span>(){'\n'}
sessions.<span className="s">observe</span>(trace){'\n\n'}
<span className="c">// 2. infer the protocol state machine, gate on coverage</span>{'\n'}
<span className="k">const</span> model = <span className="s">infer</span>(sessions.sessions){'\n'}
<span className="k">const</span> {'{ driver }'} = <span className="s">compile</span>(model, {'{'} coverageGate: <span className="s">0.95</span>, heldOut {'}'}){'\n\n'}
<span className="c">// 3. drive the learned path, zero model calls</span>{'\n'}
driver.<span className="s">start</span>(){'\n'}
driver.<span className="s">step</span>(symbol)   <span className="c">// escalates on anything unseen</span>
            </pre>
          </div>
          <div className="install"><span className="prompt">$</span><span className="mono" style={{ flex: 1 }}>wireframe compile mock --coverage-gate 0.95</span><Copyable text="wireframe compile mock --coverage-gate 0.95" /></div>
        </div>
        <div className="tracks">
          <div className="track">
            <h4>Self-host <span>OPEN SOURCE</span></h4>
            <p>The recorder, the inference engine, the conformance gate, and the runtime are open and inspectable.</p>
            <a className="btn" href="https://github.com" target="_blank" rel="noreferrer"><Github size={14} /> View on GitHub</a>
          </div>
          <div className="track">
            <h4>Hosted <span>SOON</span></h4>
            <p>A managed compile service and a private, credentialed driver store for your internal systems.</p>
            <a className="btn" href="#hosted"><ArrowRight size={14} /> Join the waitlist</a>
          </div>
        </div>
      </div>
    </section>
  )
}

function TopNav({ theme, onTheme, onSection, onNav, active }: { theme: 'dark' | 'light'; onTheme: () => void; onSection: (id: string) => void; onNav: (to: string) => void; active?: 'docs' }) {
  return (
    <header className="nav">
      <button className="brand" onClick={() => onNav('/')}><GitBranch size={18} strokeWidth={2.2} />Wireframe</button>
      <nav className="nav__links">
        <button onClick={() => onSection('how')}>how it works</button>
        <button onClick={() => onSection('research')}>research</button>
        <button onClick={() => onSection('proof')}>proof</button>
        <button className={active === 'docs' ? 'is-active' : ''} onClick={() => onNav('/docs')}>docs</button>
        <button onClick={() => onSection('hosted')}>hosted</button>
      </nav>
      <div className="nav__right">
        <button className="icon-btn" onClick={onTheme} aria-label="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className="btn btn--primary" onClick={() => onSection('start')}>Get started</button>
      </div>
    </header>
  )
}

const DOCS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'install', label: 'Install' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'cli', label: 'CLI' },
  { id: 'safety', label: 'Safety model' },
  { id: 'ai-onboarding', label: 'AI onboarding' },
  { id: 'hosted', label: 'Hosted' },
]

const QUICKSTART = `import { Recorder, infer, compile } from '@wireframe/core'

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
const r = driver.step(symbol)
if (r.escalate) {
  // hand this step back to the model, then record it for the next compile
}`

const CLI_SNIPPET = `# Compile a driver against the built-in mock protocol
wireframe compile mock --coverage-gate 0.95

# Inspect a compiled driver: states, transitions, abstraction
wireframe inspect ./driver.json

# Run the learned path through an adapter
wireframe run ./driver.json --adapter mock`

const AI_ONBOARD_PROMPT = `You are integrating Wireframe (@wireframe/core) into my agent so it can operate a black-box, stateful system deterministically.

What Wireframe does: it records a few successful protocol sessions, infers the protocol's state machine, and compiles a "driver" that runs the learned path with zero model calls and escalates back to you on anything it has not seen.

Do this:
1. Install: npm i @wireframe/core
2. Identify the stateful system my agent talks to: its transport (websocket, tcp, or mcp) and its message shape (the request "verb" and the response type).
3. Capture at least 5 successful sessions, each shaped as { steps: [{ verb, response }], outcome: "success" }. Use "new Recorder()" and "recorder.observe(session)".
4. Infer the model: const model = infer(recorder.sessions)
5. Compile behind a coverage gate, holding out some sessions: const { driver, report } = compile(model, { coverageGate: 0.95, heldOut }). Only ship if report.passed is true.
6. At runtime: call driver.start(), then for each observed response call driver.step(symbol). If the result has escalate: true, do NOT guess. Call me (the model) for that step, append the new step to the recording, and recompile later.

Hard rules:
- Never act on a step the driver did not learn. Always escalate instead.
- The driver is the fast path; the model is the fallback.
- After compiling, report coverage and unsafeContinuationRate. unsafeContinuationRate must be 0.

Reference: https://wframe.org/docs   Package: @wireframe/core`

function Docs({ theme, onTheme, onSection, onNav }: { theme: 'dark' | 'light'; onTheme: () => void; onSection: (id: string) => void; onNav: (to: string) => void }) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView()
  return (
    <>
      <div className="bp" />
      <div className="shell">
        <TopNav theme={theme} onTheme={onTheme} onSection={onSection} onNav={onNav} active="docs" />
        <div className="docs wrap">
          <aside className="docs__side">
            <div className="docs__sidehead">Documentation</div>
            <nav>{DOCS_SECTIONS.map((s) => <button key={s.id} onClick={() => go(s.id)}>{s.label}</button>)}</nav>
            <button className="docs__back" onClick={() => onNav('/')}><ArrowRight size={13} style={{ transform: 'rotate(180deg)' }} /> Back to site</button>
          </aside>

          <main className="docs__main">
            <header className="docs__hero">
              <span className="kicker">docs</span>
              <h1>Compile a black-box protocol into a deterministic driver.</h1>
              <p>Wireframe records a few successful agent sessions against a stateful system, infers the protocol state machine, and compiles a driver that runs the learned path with zero model calls and escalates on anything it has not seen.</p>
            </header>

            <section id="overview" className="docs__sec">
              <h2>Overview</h2>
              <p>An agent driving an undocumented API, a legacy network service, or a flaky MCP server spends most of its time reading raw frames and guessing the next message. It is slow, it costs a model call per step, and because it is guessing it desyncs.</p>
              <p>Wireframe removes the guessing from the steady state. You record a handful of sessions where the agent succeeded, Wireframe infers the protocol's state machine and message grammar, and it compiles a deterministic driver. The driver runs the learned path as plain code, and the model is only called when something genuinely new appears.</p>
            </section>

            <section id="install" className="docs__sec">
              <h2>Install</h2>
              <p>Requires Node 18 or newer. The <code>wireframe</code> CLI ships with the package.</p>
              <div className="install"><span className="prompt">$</span><span className="mono" style={{ flex: 1 }}>npm i @wireframe/core</span><Copyable text="npm i @wireframe/core" /></div>
            </section>

            <section id="concepts" className="docs__sec">
              <h2>Concepts</h2>
              <p>These are the terms used across the API and the CLI.</p>
              <div className="docs-defs">
                <div className="docs-def"><div className="docs-def__t">session</div><div className="docs-def__d">One successful run, a list of <code>{'{ verb, response }'}</code> steps ending in <code>outcome: 'success'</code>. The training data Wireframe learns from.</div></div>
                <div className="docs-def"><div className="docs-def__t">adapter</div><div className="docs-def__d">How Wireframe talks to the target system: <code>mock</code>, <code>websocket</code>, or <code>tcp</code>. <code>auto</code> infers it from the URL scheme, for example <code>wss://</code> means websocket.</div></div>
                <div className="docs-def"><div className="docs-def__t">coverage gate</div><div className="docs-def__d">The minimum fraction of held-out sessions the driver must reproduce before it is allowed to ship. Below it, Wireframe refuses to emit a driver and stays on the model.</div></div>
                <div className="docs-def"><div className="docs-def__t">driver</div><div className="docs-def__d">The compiled, pure-code state machine. Call <code>driver.start()</code>, then <code>driver.step(symbol)</code> returns an action or an escalation. No model calls.</div></div>
                <div className="docs-def"><div className="docs-def__t">escalation</div><div className="docs-def__d">When the driver reaches a state or symbol it never learned, it stops and hands back to the model instead of guessing. This is what keeps it safe.</div></div>
              </div>
            </section>

            <section id="quickstart" className="docs__sec">
              <h2>Quickstart</h2>
              <p>Record, infer, compile, drive. The gate decides whether a driver is allowed to ship.</p>
              <div className="docs-code">
                <div className="docs-code__bar"><span className="mono">compile.ts</span><Copyable text={QUICKSTART} /></div>
                <pre>{QUICKSTART}</pre>
              </div>
            </section>

            <section id="cli" className="docs__sec">
              <h2>CLI</h2>
              <p>The CLI wraps the same pipeline. With <code>--adapter mock</code> it runs end to end against the built-in protocol, so you can try it with no target system.</p>
              <div className="docs-code">
                <div className="docs-code__bar"><span className="mono">terminal</span><Copyable text={CLI_SNIPPET} /></div>
                <pre>{CLI_SNIPPET}</pre>
              </div>
            </section>

            <section id="safety" className="docs__sec">
              <h2>Safety model</h2>
              <p>A driver is only as trustworthy as its guardrails. Wireframe has three.</p>
              <ul>
                <li><b>Coverage gate.</b> No driver ships unless it reproduces held-out sessions above your threshold.</li>
                <li><b>Conformance.</b> The driver accepts valid sequences and refuses invalid ones. The unsafe-continuation rate must be zero.</li>
                <li><b>Drift escalation.</b> If the system changes and returns something unseen, the driver detects it and returns to the model rather than acting on a guess.</li>
              </ul>
              <p>See the measured results on the <button className="link-inline" onClick={() => onSection('proof')}>proof</button> section of the home page.</p>
            </section>

            <section id="ai-onboarding" className="docs__sec">
              <h2>AI onboarding</h2>
              <p>Hand this prompt to your coding agent (Claude Code, Cursor, or similar) and it will wire Wireframe into your project for you. It encodes the safe integration pattern: driver as the fast path, model as the fallback, never guess.</p>
              <div className="prompt-card">
                <div className="prompt-card__bar"><span className="mono">onboard-wireframe.txt</span><Copyable text={AI_ONBOARD_PROMPT} /></div>
                <pre>{AI_ONBOARD_PROMPT}</pre>
              </div>
            </section>

            <section id="hosted" className="docs__sec" style={{ borderBottom: 0 }}>
              <h2>Hosted</h2>
              <p>The open core is the recorder, the inference engine, the conformance gate, and the runtime. Hosted adds a managed compile pipeline, a private credentialed driver store, and drift monitoring for teams that would rather not operate it.</p>
              <button className="btn btn--primary" onClick={() => onSection('hosted')}>Join the waitlist <ArrowRight size={14} /></button>
            </section>
          </main>
        </div>

        <footer className="footer wrap">
          <span>Wireframe / deterministic execution layer for agents</span>
          <span style={{ display: 'flex', gap: 18 }}><button onClick={() => onNav('/')}>Home</button><a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a></span>
        </footer>
      </div>
    </>
  )
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('wireframe-theme') as 'dark' | 'light') ?? 'dark')
  const [results, setResults] = useState<Results | null>(null)
  const [missing, setMissing] = useState(false)
  const [route, setRoute] = useState(() => (window.location.pathname.replace(/\/+$/, '') || '/'))

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('wireframe-theme', theme) }, [theme])
  useEffect(() => {
    fetch('/data/results.json').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setResults(d as Results); else setMissing(true) }).catch(() => setMissing(true))
  }, [])
  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname.replace(/\/+$/, '') || '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (to: string) => {
    const clean = to.replace(/\/+$/, '') || '/'
    if (clean !== route) { window.history.pushState({}, '', clean); setRoute(clean) }
    window.scrollTo(0, 0)
  }
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark')
  const goSection = (id: string) => {
    if (route !== '/') { navigate('/'); window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 90) }
    else document.getElementById(id)?.scrollIntoView()
  }

  const passed = Boolean(
    results &&
    results.learning.fsmMatchesGroundTruth &&
    results.metrics.unsafeContinuationRate === 0 &&
    results.metrics.coverage >= 0.9 &&
    results.metrics.learnedPathModelCalls === 0,
  )

  if (route === '/docs') return <Docs theme={theme} onTheme={toggleTheme} onSection={goSection} onNav={navigate} />

  return (
    <>
      <div className="bp" />
      <div className="shell">
        <TopNav theme={theme} onTheme={toggleTheme} onSection={goSection} onNav={navigate} />
        <main>
          <Hero onStart={() => goSection('start')} onProof={() => goSection('proof')} />
          <Problem />
          <HowItWorks />
          <Research />
          <Proof results={results} passed={passed} missing={missing} />
          <GetStarted />
          <Hosted />
        </main>

        <footer className="footer wrap">
          <span>Wireframe / deterministic execution layer for agents</span>
          <span style={{ display: 'flex', gap: 18 }}><a href="/docs" onClick={(e) => { e.preventDefault(); navigate('/docs') }}>Docs</a><a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a><a href="#proof">Proof</a></span>
        </footer>
      </div>
      <WaitlistModal />
    </>
  )
}

const container = document.getElementById('root')!
const store = window as unknown as { __wireframeRoot?: ReturnType<typeof createRoot> }
const root = store.__wireframeRoot ?? createRoot(container)
store.__wireframeRoot = root
root.render(<App />)
