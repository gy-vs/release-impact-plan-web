import {useState} from 'react';
import {Package, Lock, Globe, TriangleAlert} from 'lucide-react';
import type {Graph, Level, Plan, Seed} from '../shared/types';

const LEVELS: Level[] = ['major', 'minor', 'patch'];

export function SeedPanel({
  graph,
  seeds,
  onChange,
  plan,
  onFocusNode,
}: {
  graph: Graph | null;
  seeds: Seed[];
  onChange: (next: Seed[]) => void;
  plan: Plan | null;
  onFocusNode: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const seedMap = new Map(seeds.map((s) => [s.pkg, s]));

  const toggle = (pkg: string, level: Level) => {
    const existing = seedMap.get(pkg);
    if (existing?.level === level && !existing.version) {
      onChange(seeds.filter((s) => s.pkg !== pkg));
    } else {
      const next = seeds.filter((s) => s.pkg !== pkg);
      next.push({pkg, level});
      onChange(next);
    }
  };

  const nodes = (graph?.nodes ?? [])
    .filter((n) => !n.external)
    .filter((n) => !filter || n.name.includes(filter) || n.id.includes(filter));

  return (
    <aside className="pane seed-pane">
      <h2>Package changes</h2>
      <p className="hint">Select the packages changing in this release train.</p>
      <input
        className="filter"
        placeholder="filter packages…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="seed-list">
        {nodes.map((n) => {
          const seed = seedMap.get(n.id);
          const conflicted = plan?.conflicts.some((c) => c.subgraph.nodes.includes(n.id));
          return (
            <div
              key={n.id}
              className={`seed-row ${seed ? 'on' : ''} ${conflicted ? 'conflicted' : ''}`}
            >
              <div className="seed-id" onClick={() => onFocusNode(n.id)}>
                <Package size={14} />
                <span>
                  {n.name} <code>{n.version}</code>
                </span>
                {n.private && (
                  <i className="tag" title="private — never published">
                    <Lock size={11} /> private
                  </i>
                )}
                {conflicted && (
                  <i className="tag danger" title="part of a conflict subgraph">
                    <TriangleAlert size={11} />
                  </i>
                )}
              </div>
              <div className="level-toggle">
                {LEVELS.map((lv) => (
                  <button
                    key={lv}
                    className={seed?.level === lv && !seed?.version ? 'active' : ''}
                    onClick={() => toggle(n.id, lv)}
                    title={`${lv} bump`}
                  >
                    {lv[0].toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="seed-foot">
        <Globe size={12} /> external registry packages are shown in the graph but cannot be
        selected.
      </div>
    </aside>
  );
}
