// Release-impact engine — pure, local, deterministic.
//
// Given a fixed dependency graph (runtime / optional / peer edges) and a set
// of selected package changes (seeds), it computes the minimal release train:
//
//   * impact (major/minor/patch) propagates *backwards* along dependency edges
//     — a consumer only releases when the producer leaves its declared range;
//   * multiple paths merge with the maximum required level, so the result
//     satisfies every constraint at once;
//   * each candidate carries reason chains back to every seed that reaches it;
//   * cycles are solved by fixed-point iteration and reported as SCCs;
//   * peer constraints are aggregated per installed peer over the release
//     closure (mutex / unsatisfied => minimal conflict subgraph);
//   * absent optional dependencies produce warnings, never releases;
//   * private packages bump but are never published.
//
// refinePlan() reruns the engine and marks the affected reverse subgraph while
// reusing candidate objects that did not change.

import {
  bump,
  compareVersions,
  format,
  isMutexPair,
  levelGap,
  parseRange,
  parseVersion,
  satisfies,
  widenRange,
  type Comparator,
} from './semver';
import {
  LEVEL_RANK,
  maxLevel,
  type Candidate,
  type Conflict,
  type Edge,
  type Graph,
  type Level,
  type ManifestChange,
  type Plan,
  type PkgNode,
  type ReasonChain,
  type ReasonHop,
  type RefineResult,
  type Seed,
  type SubGraph,
  type Warning,
} from './types';

type FiredEdge = {edge: Edge; gap: Level; response: Level; newRange: string};

type TrainState = {
  target: string;
  level: Level;
  seeded: boolean;
  overridden: boolean;
  /** incoming edges that pulled this package into the train */
  fired: FiredEdge[];
};

type Ctx = {
  graph: Graph;
  byId: Map<string, PkgNode>;
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
  train: Map<string, TrainState>;
  conflicts: Conflict[];
  warnings: Warning[];
  /** edges to missing workspace nodes observed from train packages */
  missingRuntime: Edge[];
};

const edgeKey = (e: Edge) => `${e.kind}:${e.from}->${e.to}@${e.range}`;

export function computePlan(graph: Graph, seeds: Seed[], overrides: Seed[] = []): Plan {
  const ctx = buildContext(graph);
  const overrideMap = new Map<string, Seed>();
  for (const o of overrides) overrideMap.set(o.pkg, o);

  // ---- 1. validate & place seeds ------------------------------------------------
  const queue: string[] = [];
  for (const seed of seeds) {
    const result = placeSeed(ctx, seed, false);
    if (result) queue.push(result);
  }
  // overrides for packages not seeded are allowed (pre-positioning a consumer);
  // they also seed the train with exactly the requested version.
  for (const o of overrides) {
    if (ctx.train.has(o.pkg)) continue;
    const result = placeSeed(ctx, o, true);
    if (result) queue.push(result);
  }

  // ---- 2. fixed-point impact propagation ---------------------------------------
  propagate(ctx, queue, overrideMap);

  // ---- 3. missing dependencies from train packages -----------------------------
  collectMissing(ctx);

  // ---- 4. peer aggregation across each release closure --------------------------
  const peerWidens = collectPeerEffects(ctx);

  // ---- 5. candidates, reasons, cycles, ordering --------------------------------
  const candidates = buildCandidates(ctx, peerWidens);
  const privateOnes = candidates.filter((c) => c.private);
  if (privateOnes.length) {
    ctx.warnings.push({
      code: 'private-candidate',
      message: `${privateOnes.length} private package(s) are version-bumped for local consistency but will not be published.`,
      nodes: privateOnes.map((c) => c.pkg).sort(),
    });
  }
  const {cycles, releaseOrder} = orderTrain(ctx);
  const conflicts = dedupeConflicts(ctx.conflicts);
  const warnings = dedupeWarnings(ctx.warnings);
  const trainIds = new Set(ctx.train.keys());
  const unaffected = ctx.graph.nodes
    .filter((n) => !n.external && !trainIds.has(n.id))
    .map((n) => n.id)
    .sort();

  return {
    revision: graph.revision,
    candidates,
    releaseOrder,
    cycles,
    conflicts,
    warnings,
    unaffected,
  };
}

function buildContext(graph: Graph): Ctx {
  const byId = new Map<string, PkgNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push(e);
  }
  return {
    graph,
    byId,
    outgoing,
    incoming,
    train: new Map(),
    conflicts: [],
    warnings: [],
    missingRuntime: [],
  };
}

function placeSeed(ctx: Ctx, seed: Seed, isOverride: boolean): string | null {
  const node = ctx.byId.get(seed.pkg);
  if (!node) {
    ctx.conflicts.push({
      code: 'unknown-package',
      message: `Selected package "${seed.pkg}" does not exist in graph revision ${ctx.graph.revision}.`,
      subgraph: {nodes: [seed.pkg], edges: []},
    });
    return null;
  }
  if (node.external) {
    ctx.conflicts.push({
      code: 'external-seed',
      message: `${node.name} is an external registry package and cannot be released by this workspace.`,
      subgraph: {nodes: [node.id], edges: []},
    });
    return null;
  }
  let target: string;
  let level: Level;
  if (seed.version) {
    const parsed = parseVersion(seed.version);
    if (!parsed) {
      ctx.conflicts.push({
        code: 'invalid-version',
        message: `"${seed.version}" is not a valid semver version for ${node.name}.`,
        subgraph: {nodes: [node.id], edges: []},
      });
      return null;
    }
    if (compareVersions(parsed, node.version) <= 0) {
      ctx.conflicts.push({
        code: 'invalid-version',
        message: `Candidate ${seed.version} for ${node.name} must be greater than current ${node.version}.`,
        subgraph: {nodes: [node.id], edges: []},
      });
      return null;
    }
    target = seed.version;
    level = levelGap(node.version, seed.version) ?? 'patch';
  } else if (seed.level) {
    const next = bump(node.version, seed.level);
    if (!next) {
      ctx.conflicts.push({
        code: 'invalid-version',
        message: `${node.name}@${node.version} cannot be bumped (${seed.level}).`,
        subgraph: {nodes: [node.id], edges: []},
      });
      return null;
    }
    target = next;
    level = seed.level;
  } else {
    ctx.conflicts.push({
      code: 'invalid-version',
      message: `Change for ${node.name} needs a bump level or explicit version.`,
      subgraph: {nodes: [node.id], edges: []},
    });
    return null;
  }

  const existing = ctx.train.get(seed.pkg);
  if (existing) {
    // explicit version adjustment on an already-placed package wins
    if (seed.version) {
      existing.target = target;
      existing.level = level;
      existing.overridden = true;
      return seed.pkg;
    }
    return null;
  }
  ctx.train.set(seed.pkg, {
    target,
    level,
    seeded: !isOverride,
    overridden: Boolean(seed.version),
    fired: [],
  });
  return seed.pkg;
}

// ------------------------------------------------------------------ propagation

function propagate(ctx: Ctx, queueInput: string[], overrides: Map<string, Seed>) {
  const queue = [...queueInput];
  while (queue.length) {
    const id = queue.shift()!;
    const state = ctx.train.get(id)!;

    for (const edge of ctx.incoming.get(id) ?? []) {
      const consumer = ctx.byId.get(edge.from);
      if (!consumer) continue; // missing node: handled in collectMissing
      if (consumer.external) continue; // external manifests are out of scope

      if (edge.kind === 'peer') continue; // peers constrain, they never force a release

      // Range-driven minimal impact: a producer move that still satisfies the
      // declared range is absorbed by it (caret eats minor/patch) and forces
      // no synchronized release. Only an out-of-range move propagates.
      const widened = widenRange(edge.range, state.target);
      if (widened.gap === 'in-range') continue;

      // optional dependency that is not installed pulls nobody into the train
      if (edge.kind === 'optional' && !ctx.byId.has(edge.to)) continue;

      const edgeGap = widened.gap as Level;
      const required = consumerResponseLevel(edge.range, edgeGap);
      const cs = ctx.train.get(consumer.id);
      const override = overrides.get(consumer.id);

      if (!cs) {
        let target: string;
        let level: Level;
        let wasOverridden = false;
        if (override?.version) {
          target = override.version;
          level = levelGap(consumer.version, target) ?? 'patch';
          wasOverridden = true;
        } else {
          level = required;
          target = bump(consumer.version, level)!;
        }
        ctx.train.set(consumer.id, {
          target,
          level,
          seeded: false,
          overridden: wasOverridden,
          fired: [{edge, gap: edgeGap, response: required, newRange: widened.range}],
        });
        if (wasOverridden && LEVEL_RANK[level] < LEVEL_RANK[required]) {
          pushOverrideConflict(ctx, consumer.id, required, target, edge);
        }
        queue.push(consumer.id);
      } else {
        const idx = cs.fired.findIndex((f) => edgeKey(f.edge) === edgeKey(edge));
        if (idx >= 0) cs.fired[idx] = {edge, gap: edgeGap, response: required, newRange: widened.range};
        else cs.fired.push({edge, gap: edgeGap, response: required, newRange: widened.range});
        if (override?.version) {
          if (LEVEL_RANK[cs.level] < LEVEL_RANK[required]) {
            pushOverrideConflict(ctx, consumer.id, required, cs.target, edge);
          }
          continue;
        }
        // merge with every incoming requirement: the package level is the
        // maximum over all paths. Recompute from the current baseline so
        // re-enqueued packages don't compare against their already-raised
        // level (which would spuriously escalate on every reprocessing).
        const merged = cs.fired.reduce(
          (acc, f) => maxLevel(acc, f.response),
          cs.seeded ? cs.level : 'patch',
        );
        if (merged !== cs.level) {
          cs.level = merged;
          cs.target = bump(consumer.version, cs.level)!;
          queue.push(consumer.id); // level rose: downstream constraints may widen
        }
      }
    }
  }
}

/**
 * Minimum response level for a consumer whose dependency declaration must be
 * widened by `edgeGap`:
 *   - exact pins are tight coupling: respond at the producer's level;
 *   - tilde only guarantees patch compatibility, so a minor break needs a
 *     patch response and a major break needs a minor response;
 *   - caret also guarantees minor compatibility inside a major, so a major
 *     break needs a minor response (minor/patch stay in range and never fire).
 */
function consumerResponseLevel(range: string, edgeGap: Level): Level {
  const trimmed = range.trim();
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(trimmed)) return edgeGap; // pin
  if (edgeGap === 'major') return 'minor'; // both caret and tilde
  return 'patch';
}

function pushOverrideConflict(
  ctx: Ctx,
  pkg: string,
  required: Level,
  target: string,
  edge?: Edge,
) {
  const node = ctx.byId.get(pkg)!;
  const path = reasonPaths(ctx, pkg);
  const sub = edge ? mergeSubgraphs(path, edgeSubgraph(edge)) : path;
  ctx.conflicts.push({
    code: 'override-below',
    message: `Adjusted candidate ${node.name}@${target} is below the ${required} impact required by its dependencies.`,
    subgraph: sub,
  });
}

// -------------------------------------------------------------- missing deps / peer

function collectMissing(ctx: Ctx) {
  const missingOptional: Edge[] = [];
  const missingPeer: Edge[] = [];
  for (const id of ctx.train.keys()) {
    for (const e of ctx.outgoing.get(id) ?? []) {
      if (ctx.byId.has(e.to)) continue;
      if (e.kind === 'runtime') ctx.missingRuntime.push(e);
      else if (e.kind === 'optional') missingOptional.push(e);
      else missingPeer.push(e);
    }
  }
  for (const e of ctx.missingRuntime) {
    const consumer = ctx.byId.get(e.from)!;
    ctx.conflicts.push({
      code: 'missing-runtime',
      message: `${consumer.name} requires missing package "${e.to}" (${e.range}); the release cannot be simulated until it exists.`,
      subgraph: {nodes: [e.from, e.to], edges: [e]},
    });
  }
  if (missingOptional.length) {
    const nodes = Array.from(new Set(missingOptional.flatMap((e) => [e.from, e.to]))).sort();
    ctx.warnings.push({
      code: 'missing-optional',
      message: `${missingOptional.length} optional dependency edge(s) point at packages absent from the graph; they are skipped on release.`,
      nodes,
      edges: missingOptional,
    });
  }
  if (missingPeer.length) {
    const nodes = Array.from(new Set(missingPeer.flatMap((e) => [e.from, e.to]))).sort();
    ctx.warnings.push({
      code: 'missing-optional',
      message: `${missingPeer.length} peer edge(s) reference unavailable packages and cannot be verified.`,
      nodes,
      edges: missingPeer,
    });
  }
}

type PeerWiden = {consumer: string; change: ManifestChange};

function collectPeerEffects(ctx: Ctx): Map<string, PeerWiden[]> {
  const widens = new Map<string, PeerWiden[]>();
  const closure = releaseClosure(ctx);

  // peer target node -> constraints gathered inside the closure
  const groups = new Map<string, {consumer: string; range: string; edge: Edge}[]>();
  for (const consumerId of closure) {
    for (const e of ctx.outgoing.get(consumerId) ?? []) {
      if (e.kind !== 'peer') continue;
      const peer = ctx.byId.get(e.to);
      if (!peer) continue; // missing peer already warned
      const consumerReleased = ctx.train.has(consumerId);
      const targetVersion = ctx.train.get(e.to)?.target ?? peer.version;

      if (consumerReleased && !satisfies(targetVersion, e.range)) {
        // The release moves the peer out of the declared range. If the move
        // is still feasible inside a widened declaration we propose that
        // manifest change — but only when no other constraint disagrees; the
        // mutex/unsatisfied checks below run against the ORIGINAL range.
        const widened = widenRange(e.range, targetVersion);
        if (widened.gap !== 'in-range') {
          const change: ManifestChange = {
            dep: e.to,
            kind: 'peer',
            fromRange: e.range,
            toRange: widened.range,
            gap: 'peer-widen',
          };
          if (!widens.has(consumerId)) widens.set(consumerId, []);
          widens.get(consumerId)!.push({consumer: consumerId, change});
        }
      }
      if (!groups.has(e.to)) groups.set(e.to, []);
      // group with the ORIGINAL declared range — peer incompatibility must
      // never be silently auto-resolved.
      groups.get(e.to)!.push({consumer: consumerId, range: e.range, edge: e});
    }
  }

  for (const [peerId, constraints] of groups) {
    if (constraints.length < 2) {
      // single constraint: still verify the installed version
      verifyInstalled(ctx, peerId, constraints);
      continue;
    }
    const peer = ctx.byId.get(peerId)!;
    const universe = peerUniverse(peer, constraints.map((c) => c.range), ctx);
    const ranges = constraints.map((c) => c.range);

    // smallest subset of constraints with an empty intersection
    const mutexSubset = findMutexSubset(universe, constraints);
    const installed = ctx.train.get(peerId)?.target ?? peer.version;
    const fullIntersection = universe.filter((v) => ranges.every((r) => satisfies(v, r)));

    if (mutexSubset) {
      // minimal conflict subgraph: the offending peer edges plus their nodes
      const sub = mergeSubgraphs(...mutexSubset.map((c) => edgeSubgraph(c.edge)));
      sub.nodes = Array.from(new Set([...sub.nodes, peerId])).sort();
      const names = mutexSubset.map((c) => `${ctx.byId.get(c.consumer)?.name ?? c.consumer}@${c.range}`);
      ctx.conflicts.push({
        code: 'peer-mutex',
        message: `Mutually exclusive peer ranges on ${peer.name}: ${names.join(' vs ')} — no single version satisfies every consumer.`,
        subgraph: sub,
      });
      continue;
    }
    if (!ranges.every((r) => satisfies(installed, r))) {
      const offenders = constraints.filter((c) => !satisfies(installed, c.range));
      const sub = mergeSubgraphs(...offenders.map((c) => edgeSubgraph(c.edge)));
      sub.nodes = Array.from(new Set([...sub.nodes, peerId])).sort();
      ctx.conflicts.push({
        code: 'peer-unsatisfied',
        message: `Installed ${peer.name}@${installed} violates peer constraint(s) ${offenders
          .map((c) => c.range)
          .join(', ')}; a compatible version exists (${fullIntersection.slice(0, 3).join(', ') || 'none'}).`,
        subgraph: sub,
      });
    }
  }
  return widens;
}

function verifyInstalled(
  ctx: Ctx,
  peerId: string,
  constraints: {consumer: string; range: string; edge: Edge}[],
) {
  const peer = ctx.byId.get(peerId)!;
  const installed = ctx.train.get(peerId)?.target ?? peer.version;
  const c = constraints[0];
  if (satisfies(installed, c.range)) return;
  const sub = mergeSubgraphs(edgeSubgraph(c.edge), reasonPaths(ctx, c.consumer));
  sub.nodes = Array.from(new Set([...sub.nodes, peerId])).sort();
  ctx.conflicts.push({
    code: 'peer-unsatisfied',
    message: `Installed ${peer.name}@${installed} does not satisfy peer ${c.range} required by ${
      ctx.byId.get(c.consumer)?.name ?? c.consumer
    }.`,
    subgraph: sub,
  });
}

/** packages that end up on disk together with every released package */
function releaseClosure(ctx: Ctx): Set<string> {
  const closure = new Set<string>();
  const walk = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const e of ctx.outgoing.get(id) ?? []) {
      if (!ctx.byId.has(e.to)) continue;
      // absent optional deps are simply not installed
      if (e.kind === 'optional' && !ctx.byId.has(e.to)) continue;
      walk(e.to);
    }
  };
  for (const id of ctx.train.keys()) walk(id);
  return closure;
}

function peerUniverse(peer: PkgNode, ranges: string[], ctx: Ctx): string[] {
  const versions = new Set<string>([peer.version]);
  const candidate = ctx.train.get(peer.id)?.target;
  if (candidate) versions.add(candidate);
  // concrete exemplars taken from each range's lower bounds, so that e.g.
  // "^17" vs "^18" is detectable even though only 18.x is installed.
  for (const raw of ranges) {
    for (const set of parseSets(raw)) {
      const lower = set
        .filter((c) => c.op === '>=' || c.op === '>' || c.op === '=')
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      if (lower) versions.add(format(lower.version));
    }
  }
  return Array.from(versions)
    .filter((v) => parseVersion(v))
    .sort((a, b) => compareVersions(a, b));
}

function parseSets(raw: string): Comparator[][] {
  return parseRange(raw)?.sets ?? [];
}

/** smallest constraint subset with empty pairwise/full intersection, or null */
function findMutexSubset(
  universe: string[],
  constraints: {consumer: string; range: string; edge: Edge}[],
) {
  for (let i = 0; i < constraints.length; i++) {
    for (let j = i + 1; j < constraints.length; j++) {
      if (isMutexPair(universe, constraints[i].range, constraints[j].range)) {
        return [constraints[i], constraints[j]];
      }
    }
  }
  // 3+ way: grow an intersection until it collapses
  for (let i = 0; i < constraints.length; i++) {
    let acc = universe.filter((v) => satisfies(v, constraints[i].range));
    const picked = [constraints[i]];
    const rest = constraints.filter((_, k) => k !== i);
    for (const c of rest) {
      const next = acc.filter((v) => satisfies(v, c.range));
      picked.push(c);
      if (next.length === 0) return picked.slice().sort((a, b) => a.consumer.localeCompare(b.consumer));
      acc = next;
    }
  }
  return null;
}

// ------------------------------------------------------------------ candidates

function buildCandidates(ctx: Ctx, peerWidens: Map<string, PeerWiden[]>): Candidate[] {
  const out: Candidate[] = [];
  const seedIds = new Set(
    [...ctx.train].filter(([, s]) => s.seeded).map(([id]) => id),
  );
  for (const [id, state] of [...ctx.train].sort((a, b) => a[0].localeCompare(b[0]))) {
    const node = ctx.byId.get(id)!;
    const manifestChanges: ManifestChange[] = state.fired
      .map((f): ManifestChange => ({
        dep: f.edge.to,
        kind: f.edge.kind,
        fromRange: f.edge.range,
        toRange: f.newRange,
        gap: f.gap,
      }));
    for (const w of peerWidens.get(id) ?? []) manifestChanges.push(w.change);
    manifestChanges.sort((a, b) => a.dep.localeCompare(b.dep) || a.kind.localeCompare(b.kind));

    out.push({
      pkg: id,
      name: node.name,
      from: node.version,
      to: state.target,
      level: state.level,
      private: Boolean(node.private),
      publish: !node.private,
      seeded: seedIds.has(id),
      overridden: state.overridden,
      manifestChanges,
      reasons: buildReasons(ctx, id, seedIds),
    });
  }
  // mark cycle members
  const cycleMembers = new Map<string, string[]>();
  for (const cyc of findCycles(ctx)) {
    for (const id of cyc) cycleMembers.set(id, cyc);
  }
  for (const c of out) {
    const cyc = cycleMembers.get(c.pkg);
    if (cyc && cyc.length > 1) c.cycleWith = cyc.filter((x) => x !== c.pkg);
  }
  return out;
}

function buildReasons(ctx: Ctx, id: string, seedIds: Set<string>): ReasonChain[] {
  const chains: ReasonChain[] = [];
  for (const seedId of [...seedIds].sort()) {
    const path = shortestPath(ctx, seedId, id);
    if (!path) continue;
    const hops: ReasonHop[] = [];
    for (let i = 0; i < path.length; i++) {
      const producer = path[i];
      const producerState = ctx.train.get(producer)!;
      if (i === path.length - 1) break;
      const consumer = path[i + 1];
      const fired = ctx.train
        .get(consumer)!
        .fired.find((f) => f.edge.to === producer);
      if (!fired) continue;
      hops.push({
        from: producer,
        to: consumer,
        kind: fired.edge.kind,
        range: fired.edge.range,
        target: producerState.target,
        gap: fired.response,
        note: hopNote(ctx, fired, producerState.target),
      });
    }
    chains.push({seedPkg: seedId, level: ctx.train.get(seedId)!.level, hops});
  }
  return chains;
}

function hopNote(ctx: Ctx, fired: FiredEdge, producerTarget: string): string {
  const dep = ctx.byId.get(fired.edge.to)!;
  const kind = fired.edge.kind === 'optional' ? 'optional ' : '';
  return `${kind}${dep.name} ${fired.edge.range} → ${producerTarget} (${fired.gap} change) breaks the declared range; widening to ${fired.newRange} requires a ${fired.response} release`;
}

/** fired propagation edges leaving `producerId` (i.e. edges to its consumers). */
function firedOutgoing(ctx: Ctx, producerId: string): FiredEdge[] {
  const out: FiredEdge[] = [];
  for (const [consumerId, state] of ctx.train) {
    if (consumerId === producerId) continue;
    for (const f of state.fired) if (f.edge.to === producerId) out.push(f);
  }
  return out;
}

/** BFS over the fired propagation graph (producer -> consumer). */
function shortestPath(ctx: Ctx, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const f of firedOutgoing(ctx, id)) {
      const next = f.edge.from;
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, id);
      if (next === to) return reconstruct(prev, from, to);
      queue.push(next);
    }
  }
  return null;
}

function reconstruct(prev: Map<string, string>, from: string, to: string): string[] {
  const path = [to];
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }
  return path;
}

/** shortest fired path from any seed to `id` as a subgraph */
function reasonPaths(ctx: Ctx, id: string): SubGraph {
  const seedIds = [...ctx.train].filter(([, s]) => s.seeded).map(([x]) => x).sort();
  let best: string[] | null = null;
  for (const seed of seedIds) {
    const p = shortestPath(ctx, seed, id);
    if (p && (!best || p.length < best.length)) best = p;
  }
  if (!best) return {nodes: [id], edges: []};
  const edges: Edge[] = [];
  for (let i = 0; i < best.length - 1; i++) {
    const producer = best[i];
    const consumer = best[i + 1];
    const fired = ctx.train.get(consumer)?.fired.find((f) => f.edge.to === producer);
    if (fired) edges.push(fired.edge);
  }
  return {nodes: best, edges};
}

// ------------------------------------------------------------------ cycles/order

function findCycles(ctx: Ctx): string[][] {
  // Tarjan SCC over the *underlying* runtime/optional edges between released
  // packages — the dependency cycle exists even when impact only fires one
  // direction during fixed-point propagation.
  const ids = [...ctx.train.keys()].sort();
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  const neighbors = (id: string) =>
    (ctx.outgoing.get(id) ?? [])
      .filter((e) => e.kind !== 'peer' && ctx.train.has(e.to))
      .map((e) => e.to);

  const visit = (v: string) => {
    indexOf.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of neighbors(v)) {
      if (!indexOf.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp.sort());
    }
  };
  for (const id of ids) if (!indexOf.has(id)) visit(id);
  return sccs.filter((c) => c.length > 1);
}

function orderTrain(ctx: Ctx): {cycles: string[][]; releaseOrder: string[][]} {
  const cycles = findCycles(ctx);
  const memberOf = new Map<string, string[]>();
  for (const c of cycles) for (const id of c) memberOf.set(id, c);

  // Build SCC-condensed DAG over underlying dependency edges; dependencies
  // ship before consumers: Kahn from components with no pending deps.
  const comps = new Map<string, string[]>();
  const compKey = (id: string) => memberOf.get(id)?.join('+') ?? id;
  for (const id of ctx.train.keys()) {
    const key = compKey(id);
    if (!comps.has(key)) comps.set(key, []);
    comps.get(key)!.push(id);
  }
  const deps = new Map<string, Set<string>>(); // comp -> components it depends on
  for (const key of comps.keys()) deps.set(key, new Set());
  for (const id of ctx.train.keys()) {
    for (const e of ctx.outgoing.get(id) ?? []) {
      if (e.kind === 'peer') continue;
      if (!ctx.train.has(e.to)) continue;
      const a = compKey(id); // consumer component
      const b = compKey(e.to); // producer component
      if (a !== b) deps.get(a)!.add(b);
    }
  }
  const remainingDeps = new Map<string, Set<string>>([...deps].map(([k, v]) => [k, new Set(v)]));
  const waves: string[][] = [];
  const done = new Set<string>();
  while (done.size < comps.size) {
    const wave = [...remainingDeps.entries()]
      .filter(([k, v]) => !done.has(k) && [...v].every((d) => done.has(d)))
      .map(([k]) => k)
      .sort();
    if (!wave.length) break; // defensive: residual cycle already collapsed
    const flat = wave.flatMap((k) => comps.get(k)!).sort();
    waves.push(flat);
    for (const k of wave) done.add(k);
    for (const v of remainingDeps.values()) for (const k of wave) v.delete(k);
  }
  return {cycles, releaseOrder: waves};
}

// ------------------------------------------------------------------ subgraphs

function edgeSubgraph(e: Edge): SubGraph {
  return {nodes: [e.from, e.to], edges: [e]};
}

function mergeSubgraphs(...subs: SubGraph[]): SubGraph {
  const nodes = new Set<string>();
  const edges = new Map<string, Edge>();
  for (const s of subs) {
    for (const n of s.nodes) nodes.add(n);
    for (const e of s.edges) edges.set(edgeKey(e), e);
  }
  return {nodes: [...nodes].sort(), edges: [...edges.values()]};
}

function dedupeConflicts(conflicts: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const key = c.code + ':' + c.subgraph.edges.map(edgeKey).join('|') + ':' + c.subgraph.nodes.join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeWarnings(warnings: Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = w.code + ':' + (w.edges ?? []).map(edgeKey).join('|') + ':' + w.nodes.join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------------ incremental

/**
 * Recompute after the user adjusts a candidate (or seeds change) and report
 * exactly which packages were affected. Unchanged Candidate objects are
 * returned by reference from `prev`, so React state identity is preserved and
 * old results can never silently overwrite new adjustments.
 */
export function refinePlan(
  prev: Plan | null,
  graph: Graph,
  seeds: Seed[],
  overrides: Seed[] = [],
): RefineResult {
  const next = computePlan(graph, seeds, overrides);
  if (!prev) {
    return {
      plan: next,
      affected: next.candidates.map((c) => c.pkg).concat(next.conflicts.flatMap((c) => c.subgraph.nodes)),
      reused: [],
    };
  }

  const prevById = new Map(prev.candidates.map((c) => [c.pkg, c]));
  const nextById = new Map(next.candidates.map((c) => [c.pkg, c]));

  // reverse-reachable subgraph from every package whose own target changed
  const roots = new Set<string>();
  for (const [id, c] of nextById) {
    const old = prevById.get(id);
    if (!old || old.to !== c.to || old.level !== c.level) roots.add(id);
  }
  for (const old of prevById.keys()) if (!nextById.has(old)) roots.add(old);

  const affected = new Set<string>(roots);
  const queue = [...roots];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.to === id && byId.has(e.from) && !affected.has(e.from)) {
        affected.add(e.from);
        queue.push(e.from);
      }
    }
  }
  // conflict appearance/disappearance is itself an effect worth surfacing
  const oldConflictNodes = new Set(prev.conflicts.flatMap((c) => c.subgraph.nodes));
  for (const c of next.conflicts) for (const n of c.subgraph.nodes) affected.add(n);
  for (const n of oldConflictNodes) affected.add(n);

  // reuse identical candidate objects by reference
  const reused: string[] = [];
  const mergedCandidates: Candidate[] = next.candidates.map((c) => {
    const old = prevById.get(c.pkg);
    if (old && JSON.stringify(old) === JSON.stringify(c)) {
      reused.push(c.pkg);
      return old;
    }
    return c;
  });
  for (const r of reused) affected.delete(r);

  const plan: Plan = {...next, candidates: mergedCandidates};
  return {
    plan,
    affected: [...affected].filter((id) => byId.has(id)).sort(),
    reused: reused.sort(),
  };
}
