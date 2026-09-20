import {useEffect, useState} from 'react';
import {
  ArrowRight,
  Layers,
  Lock,
  TriangleAlert,
  GitPullRequestArrow,
  CornerDownRight,
} from 'lucide-react';
import type {Conflict, Graph, PkgNode, Plan, ReasonChain, Seed} from '../shared/types';

export function CandidatePanel({
  graph,
  plan,
  affected,
  selectedPkg,
  focusConflict,
  overrides,
  nodeById,
  status,
  onAdjust,
  onSelectPkg,
  onJumpEdge,
  onJumpConflict,
  onClearFocus,
}: {
  graph: Graph | null;
  plan: Plan | null;
  affected: Set<string>;
  selectedPkg: string | null;
  focusConflict: Conflict | null;
  overrides: Seed[];
  nodeById: Map<string, PkgNode>;
  status: {kind: string; text: string; detail?: string};
  onAdjust: (pkg: string, version: string) => void;
  onSelectPkg: (id: string | null) => void;
  onJumpEdge: (from: string, to: string, kind: string) => void;
  onJumpConflict: (c: Conflict) => void;
  onClearFocus: () => void;
}) {
  const overrideMap = new Map(overrides.map((o) => [o.pkg, o.version]));

  return (
    <aside className="pane candidate-pane">
      <div className="pane-head">
        <h2>
          <GitPullRequestArrow size={16} /> Candidate release plan
        </h2>
      </div>
      <div className={`status-line ${status.kind}`}>
        {status.kind === 'conflict' && <TriangleAlert size={13} />}
        {status.text}
      </div>
      {status.detail && <p className="status-detail">{status.detail}</p>}

      {focusConflict ? (
        <ConflictDetail
          conflict={focusConflict}
          nodeById={nodeById}
          onClose={onClearFocus}
          onJumpEdge={onJumpEdge}
          onSelectPkg={onSelectPkg}
        />
      ) : selectedPkg && plan ? (
        <PackageDetail
          pkg={selectedPkg}
          plan={plan}
          nodeById={nodeById}
          override={overrideMap.get(selectedPkg)}
          onAdjust={onAdjust}
          onSelectPkg={onSelectPkg}
          onJumpEdge={onJumpEdge}
        />
      ) : (
        <PlanOverview
          plan={plan}
          affected={affected}
          onSelectPkg={onSelectPkg}
          onJumpConflict={onJumpConflict}
        />
      )}
    </aside>
  );
}

function PlanOverview({
  plan,
  affected,
  onSelectPkg,
  onJumpConflict,
}: {
  plan: Plan | null;
  affected: Set<string>;
  onSelectPkg: (id: string | null) => void;
  onJumpConflict: (c: Conflict) => void;
}) {
  if (!plan) return <p className="hint">Computing…</p>;
  return (
    <div className="overview">
      {plan.conflicts.length > 0 && (
        <section className="block conflicts">
          <h3>
            <TriangleAlert size={14} /> Unsat ({plan.conflicts.length})
          </h3>
          {plan.conflicts.map((c, i) => (
            <button key={i} className="conflict-card" onClick={() => onJumpConflict(c)}>
              <code className="code-tag">{c.code}</code>
              <span>{c.message}</span>
              <small>
                minimal subgraph: {c.subgraph.nodes.length} nodes · {c.subgraph.edges.length} edges
              </small>
            </button>
          ))}
        </section>
      )}

      <section className="block">
        <h3>
          <Layers size={14} /> Release waves ({plan.releaseOrder.length})
        </h3>
        {plan.releaseOrder.map((wave, i) => (
          <div key={i} className="wave">
            <span className="wave-index">w{i + 1}</span>
            <div className="wave-nodes">
              {wave.map((id) => {
                const cand = plan.candidates.find((c) => c.pkg === id)!;
                return (
                  <button
                    key={id}
                    className={`chip level-${cand.level} ${affected.has(id) ? 'affected' : ''} ${
                      cand.private ? 'private' : ''
                    }`}
                    onClick={() => onSelectPkg(id)}
                    title={cand.private ? 'private — version bump only, not published' : ''}
                  >
                    {cand.name.replace('@studio/', '')}
                    <small>
                      {cand.to}
                      {cand.private && <Lock size={9} />}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {plan.cycles.length > 0 && (
        <section className="block">
          <h3>Cycles ({plan.cycles.length})</h3>
          {plan.cycles.map((cyc, i) => (
            <div key={i} className="cycle-line">
              <CornerDownRight size={12} /> {cyc.join(' ⇄ ')}
            </div>
          ))}
        </section>
      )}

      {plan.warnings.length > 0 && (
        <section className="block warnings">
          <h3>Warnings</h3>
          {plan.warnings.map((w, i) => (
            <div key={i} className="warning-line">
              <code className="code-tag">{w.code}</code> {w.message}
            </div>
          ))}
        </section>
      )}

      {plan.unaffected.length > 0 && (
        <section className="block">
          <h3>Unaffected workspace packages</h3>
          <div className="muted-list">{plan.unaffected.join(', ')}</div>
        </section>
      )}
    </div>
  );
}

function PackageDetail({
  pkg,
  plan,
  nodeById,
  override,
  onAdjust,
  onSelectPkg,
  onJumpEdge,
}: {
  pkg: string;
  plan: Plan;
  nodeById: Map<string, PkgNode>;
  override?: string;
  onAdjust: (pkg: string, version: string) => void;
  onSelectPkg: (id: string | null) => void;
  onJumpEdge: (from: string, to: string, kind: string) => void;
}) {
  const cand = plan.candidates.find((c) => c.pkg === pkg);
  const node = nodeById.get(pkg);
  const [draft, setDraft] = useState(override ?? cand?.to ?? '');
  useEffect(() => setDraft(override ?? cand?.to ?? ''), [pkg, override, cand?.to]);

  if (!cand || !node) {
    return (
      <div>
        <p className="hint">
          {node?.name ?? pkg} is not part of the release train.
        </p>
        <button className="link" onClick={() => onSelectPkg(null)}>
          ← back to plan
        </button>
      </div>
    );
  }

  const valid = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(draft) && draft !== cand.from;
  const inConflict = plan.conflicts.filter((c) => c.subgraph.nodes.includes(pkg));

  return (
    <div className="detail">
      <button className="link" onClick={() => onSelectPkg(null)}>
        ← back to plan
      </button>
      <h3 className="detail-name">
        {cand.name} {cand.private && <Lock size={13} />}
      </h3>
      <div className="version-line">
        <span className="ver from">{cand.from}</span>
        <ArrowRight size={14} />
        <span className={`ver to level-${cand.level}`}>{cand.to}</span>
        <span className={`badge level-${cand.level}`}>{cand.level}</span>
        {cand.seeded && <span className="badge seed">selected change</span>}
        {cand.overridden && <span className="badge override">adjusted</span>}
        {!cand.publish && <span className="badge private">not published</span>}
      </div>

      <label className="adjust-box">
        <span>Adjust candidate version</span>
        <div className="adjust-row">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="x.y.z" />
          <button
            className="primary-sm"
            disabled={!valid || draft === cand.to}
            onClick={() => onAdjust(pkg, draft)}
          >
            Recompute subgraph
          </button>
          {override && (
            <button className="ghost-sm" onClick={() => onAdjust(pkg, '')}>
              reset
            </button>
          )}
        </div>
        <small>
          Only the reverse-affected subgraph is recomputed; other candidates keep their previous
          result object.
        </small>
      </label>

      {inConflict.length > 0 && (
        <section className="block conflicts">
          <h3>
            <TriangleAlert size={13} /> Involved in {inConflict.length} conflict(s)
          </h3>
          {inConflict.map((c, i) => (
            <div key={i} className="conflict-inline">
              <code className="code-tag">{c.code}</code> {c.message}
            </div>
          ))}
        </section>
      )}

      {cand.manifestChanges.length > 0 && (
        <section className="block">
          <h3>Manifest changes</h3>
          {cand.manifestChanges.map((m, i) => (
            <div
              key={i}
              className="manifest-row"
              onClick={() => onJumpEdge(pkg, m.dep, m.kind)}
              role="button"
            >
              <span className={`kind-tag ${m.kind}`}>{m.kind}</span>
              <span className="dep-name">{nodeById.get(m.dep)?.name ?? m.dep}</span>
              <code>
                {m.fromRange} → <strong>{m.toRange}</strong>
              </code>
              <span className="gap-tag">{m.gap}</span>
            </div>
          ))}
        </section>
      )}

      {cand.cycleWith && cand.cycleWith.length > 0 && (
        <section className="block">
          <h3>Release cycle</h3>
          <div className="muted-list">
            ships together with:{' '}
            {cand.cycleWith.map((id) => nodeById.get(id)?.name ?? id).join(', ')}
          </div>
        </section>
      )}

      <section className="block">
        <h3>Why is this released?</h3>
        {cand.reasons.length === 0 && <p className="hint">Directly selected — no upstream cause.</p>}
        {cand.reasons.map((chain, i) => (
          <ReasonChainView
            key={i}
            chain={chain}
            selfPkg={pkg}
            nodeById={nodeById}
            onJumpEdge={onJumpEdge}
            onSelectPkg={onSelectPkg}
          />
        ))}
      </section>
    </div>
  );
}

function ReasonChainView({
  chain,
  selfPkg,
  nodeById,
  onJumpEdge,
  onSelectPkg,
}: {
  chain: ReasonChain;
  selfPkg: string;
  nodeById: Map<string, PkgNode>;
  onJumpEdge: (from: string, to: string, kind: string) => void;
  onSelectPkg: (id: string | null) => void;
}) {
  const seedName = nodeById.get(chain.seedPkg)?.name ?? chain.seedPkg;
  return (
    <div className="reason-chain">
      <button className="chain-head" onClick={() => onSelectPkg(chain.seedPkg)}>
        <span className={`dot level-${chain.level}`} />
        {seedName} <code>{chain.level}</code>
      </button>
      {chain.hops.map((h, i) => (
        <div
          key={i}
          className={`hop ${h.to === selfPkg ? 'terminal' : ''}`}
          onClick={() => onJumpEdge(h.from, h.to, h.kind)}
          role="button"
          title="jump to this edge in the graph"
        >
          <span className={`kind-tag ${h.kind}`}>{h.kind}</span>
          <span className="hop-text">
            {nodeById.get(h.from)?.name ?? h.from}{' '}
            <code>
              {h.range} → {h.target}
            </code>{' '}
            → {nodeById.get(h.to)?.name ?? h.to}
          </span>
          <span className={`gap-tag ${h.gap}`}>{h.gap}</span>
          <small className="hop-note">{h.note}</small>
        </div>
      ))}
    </div>
  );
}

function ConflictDetail({
  conflict,
  nodeById,
  onClose,
  onJumpEdge,
  onSelectPkg,
}: {
  conflict: Conflict;
  nodeById: Map<string, PkgNode>;
  onClose: () => void;
  onJumpEdge: (from: string, to: string, kind: string) => void;
  onSelectPkg: (id: string | null) => void;
}) {
  return (
    <div className="detail conflict-detail">
      <button className="link" onClick={onClose}>
        ← back to plan
      </button>
      <h3>
        <TriangleAlert size={15} /> {conflict.code}
      </h3>
      <p>{conflict.message}</p>
      <h4>Minimal conflict subgraph</h4>
      <div className="subgraph-nodes">
        {conflict.subgraph.nodes.map((id) => (
          <button key={id} className="chip conflict" onClick={() => onSelectPkg(id)}>
            {nodeById.get(id)?.name ?? id}
          </button>
        ))}
      </div>
      {conflict.subgraph.edges.length > 0 && (
        <div className="subgraph-edges">
          {conflict.subgraph.edges.map((e, i) => (
            <div
              key={i}
              className="manifest-row"
              onClick={() => onJumpEdge(e.from, e.to, e.kind)}
              role="button"
            >
              <span className={`kind-tag ${e.kind}`}>{e.kind}</span>
              <span>
                {nodeById.get(e.from)?.name ?? e.from} → {nodeById.get(e.to)?.name ?? e.to}{' '}
                <code>{e.range}</code>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
