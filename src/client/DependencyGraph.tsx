import {useMemo} from 'react';
import type {Conflict, Graph, Plan} from '../shared/types';
import {EDGE_COLOR, layout, pathFor} from './layout';

const WIDTH = 760;

export function DependencyGraph({
  graph,
  plan,
  affected,
  selectedPkg,
  focusConflict,
  highlightEdge,
  onSelectNode,
}: {
  graph: Graph;
  plan: Plan;
  affected: Set<string>;
  selectedPkg: string | null;
  focusConflict: Conflict | null;
  highlightEdge: string | null;
  onSelectNode: (id: string) => void;
}) {
  const positions = useMemo(() => layout(graph, WIDTH), [graph]);
  const height = useMemo(() => {
    let max = 0;
    for (const p of positions.values()) max = Math.max(max, p.y);
    return max + 90;
  }, [positions]);

  const seeded = new Set(plan.candidates.filter((c) => c.seeded).map((c) => c.pkg));
  const candidate = new Map(plan.candidates.map((c) => [c.pkg, c]));
  const conflictNodes = new Set(plan.conflicts.flatMap((c) => c.subgraph.nodes));
  const conflictEdgeKeys = new Set(
    plan.conflicts.flatMap((c) => c.subgraph.edges.map((e) => `${e.kind}:${e.from}->${e.to}`)),
  );
  const focusNodes = focusConflict ? new Set(focusConflict.subgraph.nodes) : null;
  const focusEdges = focusConflict
    ? new Set(focusConflict.subgraph.edges.map((e) => `${e.kind}:${e.from}->${e.to}`))
    : null;

  return (
    <div className="graph-scroll">
      <svg width={WIDTH} height={height} className="dep-graph">
        <defs>
          <marker id="arrow-runtime" viewBox="0 -5 10 10" refX="8" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,-4 L8,0 L0,4 Z" fill={EDGE_COLOR.runtime} />
          </marker>
          <marker id="arrow-optional" viewBox="0 -5 10 10" refX="8" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,-4 L8,0 L0,4 Z" fill={EDGE_COLOR.optional} />
          </marker>
          <marker id="arrow-peer" viewBox="0 -5 10 10" refX="8" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,-4 L8,0 L0,4 Z" fill={EDGE_COLOR.peer} />
          </marker>
        </defs>

        {graph.edges.map((e) => {
          const d = pathFor(e, positions);
          if (!d) return null;
          const key = `${e.kind}:${e.from}->${e.to}`;
          const inConflict = conflictEdgeKeys.has(key);
          const focused = focusEdges?.has(key);
          const highlighted = highlightEdge === key;
          const dim = (focusNodes && !focused) || (highlightEdge && !highlighted && !inConflict);
          return (
            <g key={key} className={`edge-group ${dim ? 'dim' : ''}`}>
              <path d={d} className="edge-hit" data-key={key} />
              <path
                d={d}
                className={`edge ${inConflict ? 'conflict' : ''} ${highlighted || focused ? 'lit' : ''}`}
                stroke={EDGE_COLOR[e.kind]}
                markerEnd={`url(#arrow-${e.kind})`}
              />
            </g>
          );
        })}

        {graph.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isSeed = seeded.has(n.id);
          const isAffected = affected.has(n.id);
          const isConflict = conflictNodes.has(n.id);
          const isSelected = selectedPkg === n.id;
          const isFocused = focusNodes?.has(n.id);
          const cand = candidate.get(n.id);
          const dim = focusNodes && !isFocused;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              className={`node-group ${dim ? 'dim' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectNode(n.id)}
            >
              {(isSeed || isAffected) && (
                <circle
                  r={31}
                  className={`halo ${isSeed ? 'seed' : 'affected'} ${isConflict ? 'conflict' : ''}`}
                />
              )}
              <circle
                r={24}
                className={`node ${n.external ? 'external' : ''} ${n.private ? 'private' : ''} ${
                  isConflict ? 'conflict' : ''
                } ${isFocused ? 'focused' : ''}`}
              />
              <text className="node-label" y={4} textAnchor="middle">
                {n.name.replace('@studio/', '')}
              </text>
              <text className="node-version" y={40} textAnchor="middle">
                {cand ? `${cand.from} → ${cand.to}` : n.version}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
