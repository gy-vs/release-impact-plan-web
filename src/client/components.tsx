import type {Candidate, ConflictSubgraph, DepEdge, DepKind, PackageGraph, ReasonHop, SkippedEdge} from '../shared/model';

export const KIND_LABEL: Record<DepKind, string> = {
  runtime: '运行',
  optional: '可选',
  peer: 'peer',
};

export function kindClass(kind: DepKind): string {
  return `kind kind-${kind}`;
}

// ---- 左：图浏览器 ----
export function GraphPane({
  graph,
  selectedId,
  onSelect,
}: {
  graph: PackageGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const node = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const incoming = graph.edges.filter((e) => e.to === selectedId);
  const outgoing = graph.edges.filter((e) => e.from === selectedId);
  return (
    <div className="graph-pane">
      <div className="graph-nodes">
        {graph.nodes.map((n) => (
          <button
            key={n.id}
            className={`graph-node ${n.id === selectedId ? 'active' : ''}`}
            onClick={() => onSelect(n.id)}
            title={n.name}
          >
            <span className="node-name">{n.name}</span>
            <span className="node-meta">
              {n.version}
              {n.external ? <em className="tag tag-ext">外部</em> : null}
              {n.private ? <em className="tag tag-private">私有</em> : null}
            </span>
          </button>
        ))}
      </div>
      {node && (
        <div className="graph-detail">
          <h3>
            {node.name} <code>{node.id}</code>
          </h3>
          <p className="muted">
            当前版本 <strong>{node.version}</strong>
            {node.external ? ' · 仓库外部冻结包，范围不可改写' : ''}
            {node.private ? ' · 私有包（不可发布到公共仓库）' : ''}
          </p>
          <EdgeList title="依赖（出边）" edges={outgoing} graph={graph} selfId={node.id} onSelect={onSelect} />
          <EdgeList title="被依赖（入边）" edges={incoming} graph={graph} selfId={node.id} onSelect={onSelect} incomingList />
        </div>
      )}
    </div>
  );
}

function EdgeList({
  title,
  edges,
  graph,
  selfId,
  onSelect,
  incomingList,
}: {
  title: string;
  edges: DepEdge[];
  graph: PackageGraph;
  selfId: string;
  onSelect: (id: string) => void;
  incomingList?: boolean;
}) {
  return (
    <div className="edge-list">
      <h4>{title}</h4>
      {edges.length === 0 && <p className="muted">无</p>}
      {edges.map((e) => {
        const otherId = incomingList ? e.from : e.to;
        const other = graph.nodes.find((n) => n.id === otherId);
        return (
          <div key={`${e.from}-${e.to}-${e.kind}`} className={`edge-row ${e.missing ? 'edge-missing' : ''}`}>
            <span className={kindClass(e.kind)}>{KIND_LABEL[e.kind]}</span>
            <button className="link" onClick={() => onSelect(otherId)}>
              {other?.name ?? otherId}
            </button>
            <code className="range">{e.range}</code>
            {e.missing ? <em className="tag tag-missing">未安装</em> : null}
            {incomingList ? <span className="arrow">{e.from} → {selfId}</span> : <span className="arrow">{selfId} → {otherId}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---- 中：候选版本计划 ----
export function CandidatesTable({
  candidates,
  draftOverrides,
  onOverride,
  onRecompute,
  selectedIds,
  removedIds,
  onSelectNode,
}: {
  candidates: Candidate[];
  draftOverrides: Record<string, string>;
  onOverride: (id: string, value: string) => void;
  onRecompute: (id: string) => void;
  selectedIds: Set<string>;
  removedIds: string[];
  onSelectNode?: (id: string) => void;
}) {
  return (
    <div className="candidates">
      {removedIds.length > 0 && (
        <div className="removed-banner">本轮调整消解：{removedIds.join(', ')}</div>
      )}
      <table>
        <thead>
          <tr>
            <th>包</th>
            <th>当前</th>
            <th>候选版本</th>
            <th>级别</th>
            <th>发布</th>
            <th>原因路径</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            const dirty = draftOverrides[c.id] !== undefined && draftOverrides[c.id] !== c.to;
            const shown = draftOverrides[c.id] ?? c.to;
            return (
              <tr
                key={c.id}
                className={`${selectedIds.has(c.id) ? 'row-selected' : ''} ${c.recomputed === false ? 'row-carried' : ''}`}
              >
                <td>
                  {c.name}
                  {c.private ? <em className="tag tag-private">私有</em> : null}
                  {c.selected ? <em className="tag tag-change">选中变更</em> : null}
                  {c.recomputed === false ? <em className="tag tag-carried">沿用上轮</em> : null}
                </td>
                <td>
                  <code>{c.from}</code>
                </td>
                <td>
                  <input
                    aria-label={`${c.id} 候选版本`}
                    className={`version-input ${dirty ? 'dirty' : ''}`}
                    value={shown}
                    onChange={(ev) => onOverride(c.id, ev.target.value)}
                  />
                </td>
                <td>
                  <span className={`bump bump-${c.bump}`}>{c.bump}</span>
                  {c.prerelease ? <em className="tag tag-pre">预发布</em> : null}
                </td>
                <td>
                  {c.publishable ? (
                    <span className="ok">可发布</span>
                  ) : (
                    <span className="warn">{c.private ? '仅内部' : '不可发'}</span>
                  )}
                </td>
                <td>
                  {c.reasonChains.length === 0 ? (
                    <span className="muted">原始变更</span>
                  ) : (
                    <details>
                      <summary>{c.reasonChains.length} 条原因链</summary>
                      <Chains chains={c.reasonChains} onSelectNode={onSelectNode} />
                    </details>
                  )}
                  {c.rangeUpdates.length > 0 && (
                    <details className="range-updates">
                      <summary>{c.rangeUpdates.length} 条范围更新</summary>
                      <ul>
                        {c.rangeUpdates.map((ru) => (
                          <li key={`${ru.to}-${ru.kind}`}>
                            <span className={kindClass(ru.kind)}>{KIND_LABEL[ru.kind]}</span>
                            <code>{ru.to}</code>：<s>{ru.oldRange}</s> → <strong>{ru.newRange}</strong>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td>
                  <button disabled={!dirty} onClick={() => onRecompute(c.id)} className="recompute-btn">
                    增量重算
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Chains({chains, onSelectNode}: {chains: ReasonHop[][]; onSelectNode?: (id: string) => void}) {
  return (
    <div className="chains">
      {chains.map((chain, i) => (
        <ol key={i} className="chain">
          {chain.map((h, j) => (
            <li key={j} className="hop">
              <span className={kindClass(h.kind)}>{KIND_LABEL[h.kind]}</span>
              {onSelectNode ? (
                <button className="link" onClick={() => onSelectNode(h.from)}>
                  {h.from}
                </button>
              ) : (
                <strong>{h.from}</strong>
              )}
              <span className="arrow">→</span>
              {onSelectNode ? (
                <button className="link" onClick={() => onSelectNode(h.to)}>
                  {h.to}
                </button>
              ) : (
                <strong>{h.to}</strong>
              )}
              <code>{h.declaredRange}</code>
              <span className={`bump bump-${h.impact}`}>{h.impact}</span>
              <span className="hop-detail">{h.detail}</span>
            </li>
          ))}
        </ol>
      ))}
    </div>
  );
}

// ---- 中/右：冲突子图 ----
export function ConflictPane({
  conflict,
  onSelectNode,
  selectedEdge,
  onSelectEdge,
}: {
  conflict: ConflictSubgraph;
  onSelectNode: (id: string) => void;
  selectedEdge: string | null;
  onSelectEdge: (key: string) => void;
}) {
  return (
    <div className="conflict">
      <h3>
        <span className={`conflict-kind kind-${conflict.kind}`}>{conflict.kind}</span>
      </h3>
      <p className="conflict-msg">{conflict.message}</p>
      <div className="conflict-grid">
        <div>
          <h4>子图节点（最小冲突子图）</h4>
          <ul className="conflict-nodes">
            {conflict.nodes.map((n) => (
              <li key={n.id} className={n.context ? 'ctx-node' : 'bad-node'}>
                <button className="link" onClick={() => onSelectNode(n.id)}>
                  {n.name}
                </button>
                <code>{n.version}</code>
                {n.external ? <em className="tag tag-ext">外部</em> : null}
                {n.private ? <em className="tag tag-private">私有</em> : null}
                {n.context ? <em className="tag tag-ctx">上下文</em> : null}
                {n.detail && <p className="muted small">{n.detail}</p>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>原因边（点击跳到包）</h4>
          <ul className="conflict-edges">
            {conflict.edges.map((e) => {
              const key = `${e.from}->${e.to}-${e.kind}`;
              return (
                <li
                  key={key}
                  className={`conflict-edge ${e.contradicting ? 'is-bad' : 'is-ctx'} ${selectedEdge === key ? 'picked' : ''}`}
                >
                  <button className="link" onClick={() => onSelectNode(e.from)}>
                    {e.from}
                  </button>
                  <span className="arrow">→</span>
                  <button className="link" onClick={() => onSelectNode(e.to)}>
                    {e.to}
                  </button>
                  <span className={kindClass(e.kind)}>{KIND_LABEL[e.kind]}</span>
                  <code>{e.range}</code>
                  <button className="pick-edge" onClick={() => onSelectEdge(key)}>
                    定位
                  </button>
                  {e.detail && <p className="muted small">{e.detail}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {conflict.chains.length > 0 && (
        <details open>
          <summary>从选中变更到冲突的原因链</summary>
          <Chains chains={conflict.chains} onSelectNode={onSelectNode} />
        </details>
      )}
    </div>
  );
}

export function SkippedList({skipped}: {skipped: SkippedEdge[]}) {
  if (skipped.length === 0) return null;
  return (
    <details className="skipped">
      <summary>已满足 / 未触发的依赖边（{skipped.length}）</summary>
      <ul>
        {skipped.map((s) => (
          <li key={`${s.from}-${s.to}-${s.kind}`} className={s.reason === 'optional-missing' ? 'miss' : 'ok-line'}>
            <span className={kindClass(s.kind)}>{KIND_LABEL[s.kind]}</span>
            <strong>{s.from}</strong> → <strong>{s.to}</strong> <code>{s.range}</code>
            <em className="muted small">{s.detail}</em>
          </li>
        ))}
      </ul>
    </details>
  );
}
