import type {Edge, Graph} from '../shared/types';

export type Position = {x: number; y: number};

/**
 * Stable layered layout: dependency depth from roots (nodes with no incoming
 * dependency edges get layer 0). Cycles collapse to a shared layer. Pure and
 * deterministic so re-renders never make the graph jump.
 */
export function layout(graph: Graph, width: number, rowHeight = 96): Map<string, Position> {
  const ids = graph.nodes.map((n) => n.id).sort();
  const outgoing = new Map<string, Edge[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const e of graph.edges) {
    if (!outgoing.has(e.from) || !outgoing.has(e.to)) continue; // dangling edge
    outgoing.get(e.from)!.push(e);
  }

  // longest-path layering with cycle safety: a package's layer is one below
  // the deepest package it depends on, so dependencies render at the top.
  const depth = new Map<string, number>();
  const computing = new Set<string>();
  const resolve = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return 0; // back edge: treat as same layer
    computing.add(id);
    let d = 0;
    for (const e of outgoing.get(id) ?? []) {
      if (e.kind === 'peer') continue; // peers are side constraints, not depth
      d = Math.max(d, resolve(e.to) + 1);
    }
    computing.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) resolve(id);

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }

  const positions = new Map<string, Position>();
  const maxRows = Math.max(...layers.keys(), 0) + 1;
  for (const [layer, members] of [...layers].sort((a, b) => a[0] - b[0])) {
    const count = members.length;
    const usable = width - 80;
    members.forEach((id, i) => {
      const x = count === 1 ? width / 2 : 40 + (usable * i) / (count - 1);
      const y = 48 + layer * rowHeight;
      positions.set(id, {x, y});
    });
  }
  void maxRows;
  return positions;
}

export function pathFor(edge: Edge, pos: Map<string, Position>): string | null {
  const a = pos.get(edge.from);
  const b = pos.get(edge.to);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = a.x + dx * 0.5;
  // edge runs consumer(from) -> dependency(to); curve the long axis
  if (Math.abs(dy) >= Math.abs(dx)) {
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy * 0.5}, ${b.x} ${b.y - dy * 0.5}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

export const EDGE_COLOR: Record<Edge['kind'], string> = {
  runtime: '#5b7d70',
  optional: '#b08d57',
  peer: '#8a5f8f',
};
