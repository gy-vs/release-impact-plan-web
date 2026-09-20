import {
  bumpVersion,
  compare,
  deriveLevel,
  intersectionWitness,
  isPrerelease,
  parseVersion,
  satisfies,
  updateRange,
} from './semver';
import type {
  Candidate,
  ChangeReq,
  ConflictEdge,
  ConflictNode,
  ConflictSubgraph,
  DepEdge,
  Level,
  PackageGraph,
  PkgNode,
  PlanFailure,
  PlanResult,
  RangeUpdate,
  ReasonHop,
  SkippedEdge,
} from '../shared/model';

interface Index {
  byId: Map<string, PkgNode>;
  outgoing: Map<string, DepEdge[]>;
  incoming: Map<string, DepEdge[]>;
}

const LEVEL_RANK: Record<Level, number> = {patch: 1, minor: 2, major: 3};
const maxLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

function indexGraph(graph: PackageGraph): Index {
  const byId = new Map<string, PkgNode>();
  const outgoing = new Map<string, DepEdge[]>();
  const incoming = new Map<string, DepEdge[]>();
  for (const n of graph.nodes) {
    byId.set(n.id, n);
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of graph.edges) {
    outgoing.get(e.from)?.push(e);
    incoming.get(e.to)?.push(e);
  }
  return {byId, outgoing, incoming};
}

const edgeKey = (e: {to: string; kind: string}) => `${e.to} ${e.kind}`;
const skipKey = (e: {from: string; to: string; kind: string}) => `${e.from}>${e.to}>${e.kind}`;

function impactOf(kind: DepEdge['kind'], depLevel: Level): Level {
  if (kind === 'peer') return 'minor';
  if (kind === 'optional') return 'patch';
  return depLevel;
}

function hopDetail(ownerId: string, depId: string, e: DepEdge, v: string, impact: Level): string {
  if (e.kind === 'peer') {
    return `${ownerId} 的 peer 约束 ${e.range} 不覆盖 ${depId}@${v}，需放宽范围并以 minor 发版`;
  }
  if (e.kind === 'optional') {
    return `可选依赖 ${depId}@${v} 超出 ${ownerId} 声明的 ${e.range}，以补丁版本兜底（不放大 major 影响）`;
  }
  return `${ownerId} 声明的运行依赖范围 ${e.range} 不覆盖 ${depId}@${v}（${impact} 变更），需同步发版`;
}

export interface SolveInput {
  changes: ChangeReq[];
  overrides?: Record<string, string>;
}

interface SolveOptions {
  mode: 'full' | 'incremental';
  adjustedId?: string;
  /** 增量模式：受影响子图之外、沿用上一轮结果的已发版节点 */
  pinned?: Map<string, {to: string; rangeUpdates: RangeUpdate[]}>;
}

const ROUND_CAP_FACTOR = 6;

export function solve(graph: PackageGraph, req: SolveInput, opts: SolveOptions = {mode: 'full'}): PlanResult {
  const idx = indexGraph(graph);
  const {byId, outgoing, incoming} = idx;

  const badRequest = (message: string, nodeIds: string[] = []): PlanFailure => ({
    ok: false,
    graphRevision: graph.revision,
    conflict: {
      kind: 'bad-request',
      message,
      nodes: nodeIds
        .map((id) => byId.get(id))
        .filter((n): n is PkgNode => !!n)
        .map((n) => ({...n})),
      edges: [],
      chains: [],
    },
  });

  // ---------- 输入校验 ----------
  const changes: ChangeReq[] = [];
  const seenChange = new Set<string>();
  for (const c of req.changes ?? []) {
    if (!c || !c.id) return badRequest('变更项缺少包 id');
    if (seenChange.has(c.id)) return badRequest(`变更重复：${c.id}`, [c.id]);
    seenChange.add(c.id);
    const node = byId.get(c.id);
    if (!node) return badRequest(`图中不存在包：${c.id}`, [c.id]);
    if (!c.to && !c.level) return badRequest(`${c.id} 需要指定 to 或 level`, [c.id]);
    if (c.to) {
      if (!parseVersion(c.to)) return badRequest(`${c.id} 的目标版本非法：${c.to}`, [c.id]);
      const cmp = compare(parseVersion(node.version)!, parseVersion(c.to)!);
      if (cmp > 0) return overrideConflict(graph, c.id, `目标版本 ${c.to} 低于当前版本 ${node.version}（不允许降级）`);
      if (cmp === 0) return badRequest(`${c.id} 的目标版本与当前版本相同：${c.to}`, [c.id]);
    }
    changes.push(c);
  }

  const overrides = new Map<string, string>();
  for (const [id, v] of Object.entries(req.overrides ?? {})) {
    const node = byId.get(id);
    if (!node) return badRequest(`调整的包不在图中：${id}`, [id]);
    if (!parseVersion(v)) return overrideConflict(graph, id, `调整后的版本非法：${v}`);
    if (compare(parseVersion(node.version)!, parseVersion(v)!) > 0) {
      return overrideConflict(graph, id, `调整后的版本 ${v} 低于当前版本 ${node.version}（不允许降级）`);
    }
    overrides.set(id, v);
  }

  // ---------- 受影响子图（仅从被调整候选沿反向依赖边可达；缺失可选边不传播） ----------
  // 原始选中变更是稳定输入，不纳入“受影响”范围，其结果沿用上一轮并作为固定点参与传播。
  const affectedNodes = new Set<string>();
  if (opts.mode === 'incremental' && opts.adjustedId) {
    const queue = [opts.adjustedId].filter((id) => byId.has(id));
    while (queue.length) {
      const id = queue.shift()!;
      if (affectedNodes.has(id)) continue;
      affectedNodes.add(id);
      for (const e of incoming.get(id) ?? []) {
        if (!e.missing) queue.push(e.from);
      }
    }
  }

  // ---------- 状态 ----------
  const released = new Set<string>();
  const explicit = new Map<string, string>();
  const seedIds = new Set(changes.map((c) => c.id));
  const pinned = opts.pinned ?? new Map();
  const pinnedSet = new Set<string>();
  const levels = new Map<string, Level>();
  const updates = new Map<string, Map<string, RangeUpdate>>();

  for (const c of changes) {
    released.add(c.id);
    if (c.to) explicit.set(c.id, c.to);
    else levels.set(c.id, c.level as Level);
  }
  for (const [id, p] of pinned) {
    if (opts.mode === 'incremental' && affectedNodes.has(id)) continue;
    if (!byId.has(id)) continue;
    released.add(id);
    pinnedSet.add(id);
    explicit.set(id, p.to);
    const m = new Map<string, RangeUpdate>();
    for (const ru of p.rangeUpdates) m.set(edgeKey(ru), ru);
    updates.set(id, m);
  }
  for (const [id, v] of overrides) explicit.set(id, v);

  const targetOf = (id: string): string => {
    const node = byId.get(id)!;
    const ex = explicit.get(id);
    if (ex !== undefined) return ex;
    return bumpVersion(node.version, levels.get(id) ?? 'patch');
  };
  const depLevelOf = (id: string): Level => {
    const ex = explicit.get(id);
    const node = byId.get(id)!;
    if (ex !== undefined) return deriveLevel(node.version, ex) ?? 'patch';
    return levels.get(id) ?? 'patch';
  };
  const currentRangeOf = (owner: string, e: DepEdge): string =>
    updates.get(owner)?.get(edgeKey(e))?.newRange ?? e.range;
  // 是否构成“强迫”：以声明时的旧范围判断（改写后的范围必然满足，不能用它来追溯发版原因）
  const isForcing = (e: DepEdge): boolean =>
    !e.missing && released.has(e.to) && !satisfies(targetOf(e.to), e.range);
  // 失配判断：冻结包不能改写范围，故始终看其声明范围；内部包看有效范围
  const edgeMismatch = (e: DepEdge, v: string): boolean => {
    if (byId.get(e.from)!.external) return !satisfies(v, e.range);
    return !satisfies(v, currentRangeOf(e.from, e));
  };

  // ---------- 不动点传播 ----------
  let guard = 0;
  const roundCap = (byId.size + 2) * ROUND_CAP_FACTOR;
  while (guard++ < roundCap) {
    const fingerprint = () =>
      `${[...released].sort().join(',')}|${[...levels].map(([k, v]) => k + v).sort().join(',')}|${[...updates]
        .map(([o, m]) => o + [...m].map(([, ru]) => ru.newRange).join('&'))
        .sort()
        .join(';')}`;
    const before = fingerprint();

    for (const dep of released) {
      const depV = targetOf(dep);
      for (const e of incoming.get(dep) ?? []) {
        if (e.from === dep || (e.kind === 'optional' && e.missing)) continue;
        const ownerNode = byId.get(e.from)!;
        if (satisfies(depV, currentRangeOf(e.from, e))) continue;
        // 外部冻结包的失配先跳过，收敛后统一裁决（本轮依赖方版本可能尚未传播到位）
        if (ownerNode.external || pinnedSet.has(e.from)) continue;
        const impact = impactOf(e.kind, depLevelOf(dep));
        let m = updates.get(e.from);
        if (!m) {
          m = new Map();
          updates.set(e.from, m);
        }
        const baseRange = m.get(edgeKey(e))?.newRange ?? e.range;
        const newRange = updateRange(baseRange, depV, e.kind);
        m.set(edgeKey(e), {to: dep, kind: e.kind, oldRange: e.range, newRange});
        released.add(e.from);
        levels.set(e.from, maxLevel(levels.get(e.from) ?? impact, impact));
      }
    }

    // level 取全部强迫入边影响的最大值；种子、显式版本与固定点不参与
    for (const id of released) {
      if (explicit.has(id) || pinnedSet.has(id) || seedIds.has(id)) continue;
      let lvl: Level | undefined;
      for (const e of outgoing.get(id) ?? []) {
        if (!isForcing(e)) continue;
        lvl = lvl ? maxLevel(lvl, impactOf(e.kind, depLevelOf(e.to))) : impactOf(e.kind, depLevelOf(e.to));
      }
      if (lvl) levels.set(id, lvl);
    }

    if (fingerprint() === before) break;
  }
  if (guard > roundCap) return badRequest('依赖传播在环中未收敛（超过迭代上限）');

  // ---------- 原因链 ----------
  function buildChains(targetId: string): ReasonHop[][] {
    const results: ReasonHop[][] = [];
    const seenChain = new Set<string>();
    const dfs = (id: string, trail: ReasonHop[], usedEdges: Set<string>, depth: number) => {
      if (seedIds.has(id)) {
        const key = trail.map((h) => `${h.from}>${h.to}>${h.kind}`).join('|');
        if (!seenChain.has(key)) {
          seenChain.add(key);
          results.push([...trail]);
        }
        return;
      }
      if (depth > byId.size + 1 || results.length >= 24) return;
      for (const e of outgoing.get(id) ?? []) {
        if (!isForcing(e)) continue;
        const ek = skipKey(e);
        if (usedEdges.has(ek)) continue;
        const depV = targetOf(e.to);
        const impact = impactOf(e.kind, depLevelOf(e.to));
        usedEdges.add(ek);
        trail.push({
          from: id,
          to: e.to,
          kind: e.kind,
          declaredRange: e.range,
          newRange: updates.get(id)?.get(edgeKey(e))?.newRange,
          dependencyVersion: depV,
          impact,
          detail: hopDetail(id, e.to, e, depV, impact),
        });
        dfs(e.to, trail, usedEdges, depth + 1);
        trail.pop();
        usedEdges.delete(ek);
      }
    };
    dfs(targetId, [], new Set(), 0);
    return results;
  }

  // ---------- 收敛后：skipped 记录与冻结边裁决 ----------
  const skippedMap = new Map<string, SkippedEdge>();
  const addSkipped = (e: DepEdge, v: string, reason: SkippedEdge['reason'], detail: string) => {
    skippedMap.set(skipKey(e), {from: e.from, to: e.to, kind: e.kind, range: e.range, reason, version: v, detail});
  };

  for (const dep of released) {
    const depV = targetOf(dep);
    for (const e of incoming.get(dep) ?? []) {
      if (e.from === dep) continue;
      if (e.kind === 'optional' && e.missing) {
        addSkipped(e, depV, 'optional-missing', `可选依赖 ${dep} 未在 ${e.from} 安装，${e.range} 不构成约束，不触发发版`);
        continue;
      }
      if (!edgeMismatch(e, depV)) {
        addSkipped(e, depV, 'satisfied', `${e.from} 声明的 ${e.kind} 范围 ${currentRangeOf(e.from, e)} 已覆盖 ${dep}@${depV}，无需发版`);
        continue;
      }
      if (byId.get(e.from)!.external && e.kind !== 'peer') {
        return frozenRangeConflict(graph, idx, e, depV, buildChains);
      }
    }
  }
  // 缺失的可选依赖也要在结果中体现（其目标可能不是候选）
  for (const e of graph.edges) {
    if (e.kind === 'optional' && e.missing && released.has(e.to)) {
      if (!skippedMap.has(skipKey(e))) {
        addSkipped(
          e,
          targetOf(e.to),
          'optional-missing',
          `可选依赖 ${e.to} 未在 ${e.from} 安装，${e.range} 不构成约束，不触发发版`,
        );
      }
    }
  }

  // ---------- peer 联合校验：交集非空且覆盖候选版本；互斥范围在此暴露 ----------
  for (const targetId of released) {
    const targetV = targetOf(targetId);
    const peerEntries = incoming.get(targetId)?.filter((e) => e.kind === 'peer' && !e.missing) ?? [];
    if (peerEntries.length === 0) continue;
    const entries = peerEntries.map((e) => {
      const ownerReleased = released.has(e.from) && !byId.get(e.from)!.external;
      return {e, effRange: ownerReleased ? currentRangeOf(e.from, e) : e.range, frozen: !!byId.get(e.from)!.external};
    });
    const badKeys = new Set<string>();
    let mutex = false;
    for (let i = 0; i < entries.length; i++) {
      if (!satisfies(targetV, entries[i].effRange)) badKeys.add(skipKey(entries[i].e));
      for (let j = i + 1; j < entries.length; j++) {
        if (!intersectionWitness([entries[i].effRange, entries[j].effRange])) {
          mutex = true;
          badKeys.add(skipKey(entries[i].e));
          badKeys.add(skipKey(entries[j].e));
        }
      }
    }
    if (badKeys.size > 0) {
      return peerConflict(graph, idx, targetId, targetV, entries, badKeys, mutex, buildChains);
    }
  }

  // ---------- 组装候选 ----------
  const candidates: Candidate[] = [];
  for (const id of released) {
    const node = byId.get(id)!;
    const to = targetOf(id);
    if (!seedIds.has(id) && compare(parseVersion(node.version)!, parseVersion(to)!) === 0) continue;
    const selected = seedIds.has(id);
    candidates.push({
      id,
      name: node.name,
      from: node.version,
      to,
      bump: deriveLevel(node.version, to) ?? 'patch',
      prerelease: isPrerelease(to) || isPrerelease(node.version),
      selected,
      private: !!node.private,
      publishable: !node.external && !node.private,
      reasonChains: selected ? [] : buildChains(id),
      rangeUpdates: [...(updates.get(id)?.values() ?? [])],
      recomputed: opts.mode === 'incremental' ? !pinnedSet.has(id) : undefined,
    });
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    ok: true,
    graphRevision: graph.revision,
    mode: opts.mode,
    adjustedId: opts.adjustedId,
    affectedNodes: opts.mode === 'incremental' ? [...affectedNodes].sort() : [],
    candidates,
    skipped: [...skippedMap.values()],
  };
}

// ---------- 冲突构造 ----------
function nodeView(node: PkgNode, context = false, detail?: string): ConflictNode {
  return {
    ...node,
    context,
    detail:
      detail ??
      (node.external
        ? '仓库外部冻结包，版本与依赖范围均不可改写'
        : node.private
          ? '私有包：可产出候选版本并向下游传播，但不可发布到公共仓库'
          : undefined),
  };
}

function frozenRangeConflict(
  graph: PackageGraph,
  idx: Index,
  e: DepEdge,
  depV: string,
  buildChains: (id: string) => ReasonHop[][],
): PlanFailure {
  const dep = idx.byId.get(e.to)!;
  const owner = idx.byId.get(e.from)!;
  const kindLabel = e.kind === 'optional' ? '可选依赖' : '运行依赖';
  const conflict: ConflictSubgraph = {
    kind: 'frozen-range',
    message: `${owner.id} 是仓库外部冻结包，其${kindLabel}范围 ${e.range} 无法改写为覆盖 ${dep.id}@${depV}；本地模拟无法继续传播`,
    nodes: [nodeView(owner, false, '外部冻结包：该范围无法通过发版改写'), nodeView(dep, true)],
    edges: [
      {
        from: e.from,
        to: e.to,
        kind: e.kind,
        range: e.range,
        missing: e.missing,
        contradicting: true,
        detail: `范围 ${e.range} 不覆盖 ${depV}`,
      },
    ],
    chains: buildChains(e.to),
  };
  return {ok: false, graphRevision: graph.revision, conflict};
}

function peerConflict(
  graph: PackageGraph,
  idx: Index,
  targetId: string,
  targetV: string,
  entries: Array<{e: DepEdge; effRange: string; frozen: boolean}>,
  badKeys: Set<string>,
  mutex: boolean,
  buildChains: (id: string) => ReasonHop[][],
): PlanFailure {
  const nodes: ConflictNode[] = [];
  const nodeAdded = new Set<string>();
  const addNode = (n: PkgNode, context: boolean, detail?: string) => {
    if (nodeAdded.has(n.id)) return;
    nodeAdded.add(n.id);
    nodes.push(nodeView(n, context, detail));
  };
  addNode(idx.byId.get(targetId)!, false, `peer 目标候选版本 ${targetV}`);

  const edges: ConflictEdge[] = entries.map(({e, effRange, frozen}) => {
    const bad = badKeys.has(skipKey(e));
    addNode(idx.byId.get(e.from)!, !bad, frozen ? '外部冻结包：peer 范围不可放宽' : undefined);
    return {
      from: e.from,
      to: e.to,
      kind: 'peer',
      range: e.range,
      contradicting: bad,
      detail: bad
        ? mutex
          ? `peer 范围 ${effRange} 与其他约束互斥（无公共交集）`
          : `peer 范围 ${effRange} 不覆盖候选版本 ${targetV}${frozen ? '，且外部包不可放宽' : ''}`
        : `peer 范围 ${effRange} 可覆盖 ${targetV}`,
    };
  });

  // 宿主上下文：谁把声明 peer 约束的包装了进来（页面从包可跳到原因边）
  for (const {e} of entries) {
    for (const h of idx.incoming.get(e.from) ?? []) {
      addNode(idx.byId.get(h.from)!, true);
      edges.push({
        from: h.from,
        to: e.from,
        kind: h.kind,
        range: h.range,
        missing: h.missing,
        contradicting: false,
        detail: `${h.from} 通过 ${h.kind} 范围 ${h.range} 装入 ${e.from}`,
      });
    }
  }

  const conflict: ConflictSubgraph = {
    kind: 'peer-mutex',
    message: mutex
      ? `${targetId}@${targetV} 的多个 peer 约束之间不存在公共交集，无法用一个版本同时满足`
      : `${targetId}@${targetV} 无法满足外部冻结的 peer 约束（该 peer 范围不可放宽）`,
    nodes,
    edges,
    chains: buildChains(targetId),
  };
  return {ok: false, graphRevision: graph.revision, conflict};
}

function overrideConflict(graph: PackageGraph, id: string, message: string): PlanFailure {
  return {
    ok: false,
    graphRevision: graph.revision,
    conflict: {
      kind: 'override-invalid',
      message,
      nodes: graph.nodes.filter((n) => n.id === id).map((n) => nodeView(n)),
      edges: [],
      chains: [],
    },
  };
}

// ---------- 增量重算入口 ----------
export function solveIncremental(
  graph: PackageGraph,
  req: {
    changes: ChangeReq[];
    overrides?: Record<string, string>;
    adjustedId: string;
    previous: Array<{id: string; to: string; rangeUpdates: RangeUpdate[]}>;
  },
): PlanResult {
  const idx = indexGraph(graph);
  if (!idx.byId.get(req.adjustedId)) {
    return {
      ok: false,
      graphRevision: graph.revision,
      conflict: {kind: 'bad-request', message: `调整的包不在图中：${req.adjustedId}`, nodes: [], edges: [], chains: []},
    };
  }
  const pinned = new Map<string, {to: string; rangeUpdates: RangeUpdate[]}>();
  for (const p of req.previous ?? []) {
    if (idx.byId.has(p.id)) pinned.set(p.id, {to: p.to, rangeUpdates: p.rangeUpdates ?? []});
  }
  const outcome = solve(
    graph,
    {changes: req.changes, overrides: req.overrides},
    {mode: 'incremental', adjustedId: req.adjustedId, pinned},
  );
  if (!outcome.ok) return outcome;

  const solvedIds = new Set(outcome.candidates.map((c) => c.id));
  const seedIds = new Set(req.changes.map((c) => c.id));
  const affected = new Set(outcome.affectedNodes);

  // 受影响子图之外的候选沿用上一轮结果，不重新计算
  const carried: Candidate[] = [];
  for (const p of req.previous ?? []) {
    const node = idx.byId.get(p.id);
    if (!node || solvedIds.has(p.id) || affected.has(p.id)) continue;
    carried.push({
      id: node.id,
      name: node.name,
      from: node.version,
      to: p.to,
      bump: deriveLevel(node.version, p.to) ?? 'patch',
      prerelease: isPrerelease(p.to) || isPrerelease(node.version),
      selected: seedIds.has(node.id),
      private: !!node.private,
      publishable: !node.external && !node.private,
      reasonChains: [],
      rangeUpdates: p.rangeUpdates ?? [],
      recomputed: false,
    });
  }
  const removedIds = (req.previous ?? [])
    .map((p) => p.id)
    .filter((id) => !solvedIds.has(id) && !carried.some((c) => c.id === id));

  return {
    ...outcome,
    candidates: [...outcome.candidates, ...carried].sort((a, b) => (a.id < b.id ? -1 : 1)),
    removedIds,
  };
}
