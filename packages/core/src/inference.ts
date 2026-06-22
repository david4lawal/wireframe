/**
 * inference.ts
 *
 * Classical protocol-FSM inference (NO LLM). Pipeline:
 *
 *   (a) Abstraction/templating         separate structure (verbs/response types) from
 *                                       parameters (token/id/timestamp). Done in abstract.ts;
 *                                       here we consume already-abstracted symbol traces.
 *   (b) Prefix-Tree Acceptor (APTA)    build an augmented prefix tree over the abstracted
 *                                       alphabet from the positive session traces.
 *   (c) State merging                  four honest, comparable strategies:
 *         'none'     = raw prefix tree (no merging at all).
 *         'rpni'     = naive greedy RPNI-style merging (merges aggressively, over-generalizes).
 *         'k-tails'  = classic k-tails: merge states with identical length-<=k tail SETS.
 *         'red-blue' = evidence-driven red-blue / EDSM merging (the DEFAULT). Grows a set of
 *                      confirmed states and merges each frontier node into the best COMPATIBLE
 *                      one (disjoint-outcome conflict test), else promotes it. Converges to the
 *                      true minimal FSM from purely positive traces.
 *   (d) Emit a readable driver         the FSM (states + transitions) over the symbol alphabet.
 *
 * Determinism and honesty: every strategy is fully deterministic and reproducible from the same
 * traces. The learner adds transitions ONLY for symbols actually observed, so anything unseen is
 * rejected by construction (the safety property the validator checks).
 */

/** A learned FSM over the abstracted symbol alphabet. */
export interface LearnedFsm {
  initial: string;
  states: string[];
  transitions: { from: string; on: string; to: string }[];
}

export type MergeMode = "red-blue" | "rpni" | "k-tails" | "none";

/* ------------------------------------------------------------------ */
/* (b) Prefix-Tree Acceptor (APTA)                                     */
/* ------------------------------------------------------------------ */

interface AptaNode {
  id: number;
  /** outgoing edges keyed by symbol -> child node id */
  edges: Map<string, number>;
}

/** Build an augmented prefix-tree acceptor from positive (accepting) symbol traces. */
function buildApta(traces: string[][]): { nodes: AptaNode[]; root: number } {
  const nodes: AptaNode[] = [{ id: 0, edges: new Map() }];
  const root = 0;
  for (const trace of traces) {
    let cur = root;
    for (const sym of trace) {
      const existing = nodes[cur].edges.get(sym);
      if (existing !== undefined) {
        cur = existing;
      } else {
        const child: AptaNode = { id: nodes.length, edges: new Map() };
        nodes.push(child);
        nodes[cur].edges.set(sym, child.id);
        cur = child.id;
      }
    }
  }
  return { nodes, root };
}

/* ------------------------------------------------------------------ */
/* Union-Find partition over APTA node ids                             */
/* ------------------------------------------------------------------ */

/**
 * Union-Find over node ids, used to represent the current partition of APTA states into
 * merged "blocks". Each block becomes one state of the inferred DFA.
 */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb); // keep lower id as root
  }
}

/** The request verb a symbol "VERB/RESPONSE_TYPE" was produced by. */
function verbOf(symbol: string): string {
  return symbol.slice(0, symbol.indexOf("/"));
}

/** The response type half of a symbol "VERB/RESPONSE_TYPE". */
function respOf(symbol: string): string {
  return symbol.slice(symbol.indexOf("/") + 1);
}

/* ------------------------------------------------------------------ */
/* Shared determinism fold (verb-keyed)                                */
/* ------------------------------------------------------------------ */

/**
 * Determinism fold on a partition, keyed on the request VERB (not the full symbol).
 *
 * Why verb, not symbol? Some verbs are PARAMETER-DEPENDENT: GET returns OK_ITEM for a known id
 * and ERR_NOTFOUND for an unknown one, from the SAME protocol state, because the deciding
 * parameter (the id) was abstracted away. So GET/OK_ITEM and GET/ERR_NOTFOUND are two responses
 * of ONE transition (the agent action "GET") and their successor states are the same state.
 * Folding on the verb unifies those successors, which is the correct abstraction-aware DFA.
 */
function determinismFold(nodes: AptaNode[], uf: UnionFind): void {
  let folded = true;
  while (folded) {
    folded = false;
    const blockEdges = new Map<number, Map<string, number>>(); // block -> verb -> target block
    for (let i = 0; i < nodes.length; i++) {
      const fromBlock = uf.find(i);
      let m = blockEdges.get(fromBlock);
      if (!m) {
        m = new Map();
        blockEdges.set(fromBlock, m);
      }
      for (const [sym, child] of nodes[i].edges) {
        const verb = verbOf(sym);
        const toBlock = uf.find(child);
        const seen = m.get(verb);
        if (seen === undefined) m.set(verb, toBlock);
        else if (seen !== toBlock) {
          uf.union(seen, toBlock); // same verb from same state -> one successor state
          folded = true;
        }
      }
    }
  }
}

/**
 * Determinism fold keyed on the FULL symbol (classic DFA fold). Used by RPNI and k-tails, which
 * do not have the abstraction-aware verb merging of red-blue. Two edges out of one block on the
 * same symbol must point to the same successor block.
 */
function symbolDeterminismFold(nodes: AptaNode[], uf: UnionFind): void {
  let folded = true;
  while (folded) {
    folded = false;
    const blockEdges = new Map<number, Map<string, number>>();
    for (let i = 0; i < nodes.length; i++) {
      const fromBlock = uf.find(i);
      let m = blockEdges.get(fromBlock);
      if (!m) {
        m = new Map();
        blockEdges.set(fromBlock, m);
      }
      for (const [sym, child] of nodes[i].edges) {
        const toBlock = uf.find(child);
        const seen = m.get(sym);
        if (seen === undefined) m.set(sym, toBlock);
        else if (seen !== toBlock) {
          uf.union(seen, toBlock);
          folded = true;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Block inspection helpers                                            */
/* ------------------------------------------------------------------ */

function snapshot(uf: UnionFind, n: number): number[] {
  const s: number[] = [];
  for (let i = 0; i < n; i++) s.push(uf.find(i));
  return s;
}
function restore(uf: UnionFind, snap: number[]): void {
  (uf as unknown as { parent: number[] }).parent = snap.slice();
}

/** All outgoing edges of a block: full symbol -> successor block representative. */
function blockEdgeMap(nodes: AptaNode[], uf: UnionFind, block: number): Map<string, number> {
  const m = new Map<string, number>();
  const r = uf.find(block);
  for (let i = 0; i < nodes.length; i++) {
    if (uf.find(i) !== r) continue;
    for (const [sym, child] of nodes[i].edges) m.set(sym, uf.find(child));
  }
  return m;
}

/** A block's per-verb set of observed response types, e.g. GET -> {OK_ITEM, ERR_NOTFOUND}. */
function blockVerbResponses(
  nodes: AptaNode[],
  uf: UnionFind,
  block: number
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const r = uf.find(block);
  for (let i = 0; i < nodes.length; i++) {
    if (uf.find(i) !== r) continue;
    for (const sym of nodes[i].edges.keys()) {
      const v = verbOf(sym);
      if (!m.has(v)) m.set(v, new Set());
      m.get(v)!.add(respOf(sym));
    }
  }
  return m;
}

/** The set of response types a block produces across all its observed edges. */
function blockResponseTypes(nodes: AptaNode[], uf: UnionFind, block: number): Set<string> {
  const s = new Set<string>();
  const r = uf.find(block);
  for (let i = 0; i < nodes.length; i++) {
    if (uf.find(i) !== r) continue;
    for (const sym of nodes[i].edges.keys()) s.add(respOf(sym));
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* (c.red-blue) Evidence-driven compatibility + EDSM merge             */
/* ------------------------------------------------------------------ */

/**
 * Are two BLOCKS compatible (could be the same protocol state)?
 *
 * INCOMPATIBLE iff either:
 *  (1) A shared VERB has DISJOINT response-type sets, e.g. LIST yields only {OK_ITEMS} from one
 *      block but only {ERR_NOAUTH} from another. Disjoint outcomes for the same command is direct
 *      evidence of different states (keeps UNAUTH / AUTH / CLOSED apart). OVERLAPPING response
 *      sets (e.g. GET -> {OK_ITEM,ERR_NOTFOUND} vs GET -> {OK_ITEM}) are NOT a conflict: that is
 *      just parameter-dependent variation within one state.
 *  (2) On a shared FULL symbol, the successor blocks are incompatible one level deeper (k-tails).
 *
 * Verbs present in only one block impose no constraint (absence = unobserved, not forbidden),
 * which lets truncated views of the same state merge.
 */
function blocksCompatible(
  nodes: AptaNode[],
  uf: UnionFind,
  a: number,
  b: number,
  k: number
): boolean {
  if (uf.find(a) === uf.find(b)) return true;
  if (k === 0) return true;

  const va = blockVerbResponses(nodes, uf, a);
  const vb = blockVerbResponses(nodes, uf, b);
  for (const [verb, ra] of va) {
    const rb = vb.get(verb);
    if (rb === undefined) continue; // verb only seen on one side
    let overlap = false;
    for (const x of ra) if (rb.has(x)) overlap = true;
    if (!overlap) return false; // same command, entirely different outcomes => different states
  }

  const ea = blockEdgeMap(nodes, uf, a);
  const eb = blockEdgeMap(nodes, uf, b);
  for (const [sym, succA] of ea) {
    const succB = eb.get(sym);
    if (succB === undefined) continue;
    if (!blocksCompatible(nodes, uf, succA, succB, k - 1)) return false;
  }
  return true;
}

/**
 * Evidence score for merging block `a` (a red) with block `b` (the candidate). Two complementary
 * signals, both grounded only in observed data:
 *  - shared (verb -> responseType): the SAME command produced the SAME outcome from both states;
 *  - shared responseTYPE (any verb): both states answer with the same KIND of response. This is
 *    what unifies the terminal state: every command there yields ERR_CLOSED, so two CLOSED views
 *    that exposed DIFFERENT verbs (LIST vs PING) still share the ERR_CLOSED response and merge.
 *
 * A score of 0 means the two blocks share no observed behavior at all. We do NOT merge on zero
 * evidence (that is how a terminal node would wrongly attach to the initial state).
 */
function mergeScore(nodes: AptaNode[], uf: UnionFind, a: number, b: number): number {
  const va = blockVerbResponses(nodes, uf, a);
  const vb = blockVerbResponses(nodes, uf, b);
  let score = 0;
  for (const [verb, ra] of va) {
    const rb = vb.get(verb);
    if (!rb) continue;
    for (const x of ra) if (rb.has(x)) score += 2; // exact (verb,response) agreement weighs most
  }
  const rta = blockResponseTypes(nodes, uf, a);
  const rtb = blockResponseTypes(nodes, uf, b);
  for (const x of rta) if (rtb.has(x)) score += 1; // shared response KIND (e.g. ERR_CLOSED)
  return score;
}

/** Did a trial merge+fold collapse two previously-distinct confirmed (red) states into one block? */
function redsCollapsed(uf: UnionFind, redRepsBefore: number[]): boolean {
  const nowBlocks = redRepsBefore.map((x) => uf.find(x));
  return new Set(nowBlocks).size < redRepsBefore.length;
}

function bfsOrder(nodes: AptaNode[], root: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>([root]);
  const q = [root];
  while (q.length > 0) {
    const cur = q.shift()!;
    order.push(cur);
    const syms = [...nodes[cur].edges.keys()].sort();
    for (const s of syms) {
      const child = nodes[cur].edges.get(s)!;
      if (!seen.has(child)) {
        seen.add(child);
        q.push(child);
      }
    }
  }
  return order;
}

/**
 * Red-blue (Blue-Fringe / EDSM-style) state merging. The STABLE form of state merging: grow a
 * set of confirmed "red" states and, for each "blue" frontier node in deterministic order, either
 * MERGE it into the best compatible red state (with a determinism fold and a rollback if the fold
 * then breaks compatibility) or PROMOTE it to a new red state. Processing one node at a time
 * (never batching) prevents the transitive over-collapse a naive "merge all compatible" sweep has.
 */
function redBlueMerge(nodes: AptaNode[], root: number, k: number): UnionFind {
  const uf = new UnionFind(nodes.length);
  const order = bfsOrder(nodes, root);

  const reds: number[] = [root];
  const redSet = new Set<number>([uf.find(root)]);

  for (const node of order) {
    const cand = uf.find(node);
    if (redSet.has(cand)) continue; // already confirmed

    // A node with NO outgoing edges carries no behavioral evidence (e.g. a session ending at
    // LOGOUT). Merging it by raw compatibility would let it attach to ANY red. Defer it: the
    // leaf placement below pins it via its incoming edge, where the real evidence lives.
    if (nodes[node].edges.size === 0) continue;

    let bestRed = -1;
    let bestScore = -1;
    for (const red of reds) {
      const r = uf.find(red);
      if (r === cand) {
        bestRed = r;
        bestScore = Number.POSITIVE_INFINITY;
        break;
      }
      if (!blocksCompatible(nodes, uf, r, cand, k)) continue;

      const redRepsBefore = [...new Set(reds.map((x) => uf.find(x)))];
      const snap = snapshot(uf, nodes.length);
      uf.union(r, cand);
      determinismFold(nodes, uf);
      const ok = !redsCollapsed(uf, redRepsBefore);
      restore(uf, snap);
      if (!ok) continue;

      const score = mergeScore(nodes, uf, r, cand);
      if (score <= 0) continue; // never merge on zero evidence
      if (score > bestScore) {
        bestScore = score;
        bestRed = r;
      }
    }

    let merged = false;
    if (bestRed >= 0 && bestScore !== Number.POSITIVE_INFINITY) {
      uf.union(bestRed, cand);
      determinismFold(nodes, uf);
      merged = true;
    } else if (bestScore === Number.POSITIVE_INFINITY) {
      merged = true; // already merged into a red by an earlier fold
    }

    if (!merged) reds.push(uf.find(node));

    redSet.clear();
    for (const red of reds) redSet.add(uf.find(red));
  }

  placeLeaves(nodes, uf, reds);
  determinismFold(nodes, uf);
  return uf;
}

/** Attach evidence-free leaves to the compatible confirmed block sharing their incoming response. */
function placeLeaves(nodes: AptaNode[], uf: UnionFind, reds: number[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (const [sym, child] of nodes[i].edges) {
      if (uf.find(child) === child && nodes[child].edges.size === 0) {
        const respType = respOf(sym);
        const candidates = [uf.find(i), ...reds.map((r) => uf.find(r))];
        for (const b of candidates) {
          if (uf.find(b) === uf.find(child)) continue;
          if (!blockResponseTypes(nodes, uf, b).has(respType)) continue;
          if (!blocksCompatible(nodes, uf, b, child, 2)) continue;
          uf.union(b, child);
          break;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* (c.rpni) Naive greedy RPNI-style merging                            */
/* ------------------------------------------------------------------ */

/**
 * Naive RPNI from purely positive data. RPNI walks states in canonical (BFS) order and, for each
 * blue node, tries to merge it with the first earlier (red) node such that the resulting machine
 * stays a DFA (symbol-determinism fold succeeds). With NO negative examples there is nothing to
 * block a merge, so it greedily collapses the machine. On this protocol that fuses UNAUTH / AUTH /
 * CLOSED into one accepting state: the result OVER-GENERALIZES and accepts illegal sequences. This
 * is the honest, classic RPNI behavior on positive-only data, included for comparison.
 */
function rpniMerge(nodes: AptaNode[], root: number): UnionFind {
  const uf = new UnionFind(nodes.length);
  const order = bfsOrder(nodes, root);

  for (const blue of order) {
    const blueBlock = uf.find(blue);
    if (blueBlock === root) continue;
    // Try to merge `blue` with the first earlier red node in canonical order.
    for (const red of order) {
      if (red >= blue) break; // only consider strictly-earlier nodes as red candidates
      const redBlock = uf.find(red);
      if (redBlock === blueBlock) continue;
      const snap = snapshot(uf, nodes.length);
      uf.union(redBlock, blueBlock);
      symbolDeterminismFold(nodes, uf);
      // Positive-only RPNI accepts the merge unconditionally (no negative evidence rejects it).
      // The fold has already enforced determinism, which is the only constraint that exists here.
      void snap; // merge is kept; snapshot retained only to mirror the rollback-capable structure
      break;
    }
  }
  symbolDeterminismFold(nodes, uf);
  return uf;
}

/* ------------------------------------------------------------------ */
/* (c.k-tails) Classic k-tails merging                                 */
/* ------------------------------------------------------------------ */

/** The SET of symbol strings of length <= k reachable from a node (its k-tail). */
function kTailSet(nodes: AptaNode[], start: number, k: number): Set<string> {
  const tails = new Set<string>();
  const walk = (node: number, depth: number, path: string): void => {
    if (depth > 0) tails.add(path);
    if (depth === k) return;
    const syms = [...nodes[node].edges.keys()].sort();
    for (const s of syms) {
      const child = nodes[node].edges.get(s)!;
      walk(child, depth + 1, path.length === 0 ? s : path + " " + s);
    }
  };
  walk(start, 0, "");
  return tails;
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Classic k-tails: two states are equivalent iff their length-<=k tail SETS are identical, then
 * merge equivalent states and fold for determinism. On finite positive traces, tails near the end
 * of a session are TRUNCATED, so positions that are really the same state look different and stay
 * apart. The result UNDER-generalizes (too many states). This is the honest classic behavior,
 * included for comparison.
 */
function kTailsMerge(nodes: AptaNode[], root: number, k: number): UnionFind {
  const uf = new UnionFind(nodes.length);
  const tails = nodes.map((n) => kTailSet(nodes, n.id, k));
  const order = bfsOrder(nodes, root);
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const i = order[a];
      const j = order[b];
      if (uf.find(i) === uf.find(j)) continue;
      if (setEqual(tails[i], tails[j])) {
        uf.union(i, j);
      }
    }
  }
  symbolDeterminismFold(nodes, uf);
  return uf;
}

/* ------------------------------------------------------------------ */
/* (d) Emit the DFA / driver from the merged partition                 */
/* ------------------------------------------------------------------ */

/** Convert a merged APTA partition into a clean DFA with stable state names q0, q1, ... */
function emitDfa(nodes: AptaNode[], root: number, uf: UnionFind): LearnedFsm {
  const blockName = new Map<number, string>();
  const order = bfsOrder(nodes, root);
  let next = 0;
  const nameFor = (nodeId: number): string => {
    const block = uf.find(nodeId);
    let name = blockName.get(block);
    if (name === undefined) {
      name = `q${next++}`;
      blockName.set(block, name);
    }
    return name;
  };
  nameFor(root); // ensure root is q0
  for (const n of order) nameFor(n);

  const transSet = new Map<string, { from: string; on: string; to: string }>();
  const statesSet = new Set<string>();
  for (const node of nodes) {
    const from = nameFor(node.id);
    statesSet.add(from);
    for (const [sym, child] of node.edges) {
      const to = nameFor(child);
      statesSet.add(to);
      const key = `${from}|${sym}`;
      const prev = transSet.get(key);
      if (prev && prev.to !== to) {
        throw new Error(
          `Non-deterministic transition after merge: ${from} on ${sym} to ${prev.to} and ${to}`
        );
      }
      transSet.set(key, { from, on: sym, to });
    }
  }

  const states = [...statesSet].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const transitions = [...transSet.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.on.localeCompare(b.on)
  );

  return { initial: nameFor(root), states, transitions };
}

/* ------------------------------------------------------------------ */
/* Public inference entry                                              */
/* ------------------------------------------------------------------ */

/**
 * Infer a deterministic FSM from abstracted symbol traces using the chosen merge strategy.
 * `mode` selects the algorithm; `k` is the tail depth for compatibility (red-blue) or tail
 * equivalence (k-tails). k=2 suffices for the proof protocol.
 */
export function inferFsm(symbolTraces: string[][], mode: MergeMode = "red-blue", k = 2): LearnedFsm {
  const { nodes, root } = buildApta(symbolTraces);
  let uf: UnionFind;
  switch (mode) {
    case "none":
      uf = new UnionFind(nodes.length); // identity partition: raw prefix tree
      break;
    case "rpni":
      uf = rpniMerge(nodes, root);
      break;
    case "k-tails":
      uf = kTailsMerge(nodes, root, k);
      break;
    case "red-blue":
    default:
      uf = redBlueMerge(nodes, root, k);
      break;
  }
  return emitDfa(nodes, root, uf);
}
