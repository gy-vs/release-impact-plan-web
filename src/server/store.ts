// In-memory, fixed-revision dependency graph store.
// Pure simulation: nothing here ever talks to a package registry.

import {parseRange} from '../shared/semver';
import type {Edge, Graph, PkgNode} from '../shared/types';

export const FIXTURE_GRAPH: Graph = {
  revision: 1,
  nodes: [
    {id: 'core', name: '@studio/core', version: '1.4.2'},
    {id: 'core-utils', name: '@studio/core-utils', version: '2.1.0'},
    {id: 'analytics', name: '@studio/analytics', version: '3.0.0'},
    {id: 'widgets', name: '@studio/widgets', version: '1.9.0'},
    {id: 'legacy-bridge', name: '@studio/legacy-bridge', version: '0.8.0'},
    {id: 'dashboard', name: '@studio/dashboard', version: '2.3.1'},
    {id: 'host-app', name: '@studio/host-app', version: '1.0.0', private: true},
    {id: 'gizmo', name: '@studio/gizmo', version: '0.5.0'},
    {id: 'experimental-rx', name: '@studio/experimental-rx', version: '0.2.0-beta.3'},
    {id: 'plugin-x', name: '@studio/plugin-x', version: '4.0.0'},
    {id: 'shared-store', name: '@studio/shared-store', version: '1.0.0'},
    {id: 'cache-layer', name: '@studio/cache-layer', version: '1.0.0'},
    {id: 'react', name: 'react', version: '18.2.0', external: true},
    // "telemetry-native" is intentionally NOT a node: analytics carries an
    // optional edge to it, demonstrating absent optional dependencies.
  ],
  edges: [
    // tilde edges transmit minor changes (as a patch response); caret edges
    // transmit only major changes (as a minor response); pins transmit all.
    {from: 'core-utils', to: 'core', range: '~1.4.0', kind: 'runtime'},
    {from: 'analytics', to: 'core', range: '^1.4.0', kind: 'runtime'},
    {from: 'analytics', to: 'telemetry-native', range: '^1.0.0', kind: 'optional'},
    {from: 'analytics', to: 'react', range: '^17.0.0 || ^18.0.0', kind: 'peer'},
    {from: 'widgets', to: 'core-utils', range: '^2.1.0', kind: 'runtime'},
    {from: 'widgets', to: 'react', range: '^17.0.0 || ^18.0.0', kind: 'peer'},
    {from: 'legacy-bridge', to: 'react', range: '^17.0.0', kind: 'peer'},
    {from: 'dashboard', to: 'widgets', range: '~1.9.0', kind: 'runtime'},
    {from: 'dashboard', to: 'analytics', range: '^3.0.0', kind: 'runtime'},
    {from: 'dashboard', to: 'core-utils', range: '~2.1.0', kind: 'runtime'},
    {from: 'dashboard', to: 'legacy-bridge', range: '~0.8.0', kind: 'runtime'},
    {from: 'dashboard', to: 'react', range: '^18.0.0', kind: 'peer'},
    {from: 'host-app', to: 'dashboard', range: '~2.3.0', kind: 'runtime'},
    {from: 'host-app', to: 'react', range: '^18.0.0', kind: 'peer'},
    // gizmo pins react to an exact 18 while declaring a 17 peer: the
    // unsatisfied-peer demonstration once gizmo joins a release closure.
    {from: 'gizmo', to: 'react', range: '18.2.0', kind: 'runtime'},
    {from: 'gizmo', to: 'react', range: '^17.0.0', kind: 'peer'},
    // prerelease chain — pinned prerelease anchor
    {from: 'plugin-x', to: 'experimental-rx', range: '0.2.0-beta.2', kind: 'runtime'},
    {from: 'experimental-rx', to: 'core', range: '~1.4.0', kind: 'runtime'},
    // release cycle (tilde: minor changes rotate the whole SCC)
    {from: 'shared-store', to: 'cache-layer', range: '~1.0.0', kind: 'runtime'},
    {from: 'cache-layer', to: 'shared-store', range: '~1.0.0', kind: 'runtime'},
  ],
};

export type GraphOp =
  | {op: 'addNode'; node: PkgNode}
  | {op: 'updateNode'; id: string; patch: Partial<Omit<PkgNode, 'id'>>}
  | {op: 'removeNode'; id: string}
  | {op: 'addEdge'; edge: Edge}
  | {op: 'removeEdge'; from: string; to: string; kind: Edge['kind']};

export type MutationResult =
  | {ok: true; graph: Graph}
  | {ok: false; status: 409 | 400; error: string; graph: Graph};

export class GraphStore {
  private graph: Graph;

  constructor(initial: Graph = structuredClone(FIXTURE_GRAPH)) {
    this.graph = initial;
  }

  get(): Graph {
    // never hand out the live object
    return structuredClone(this.graph);
  }

  get revision(): number {
    return this.graph.revision;
  }

  /** Apply a batch atomically: either every op lands (revision +1) or none. */
  mutate(expectedRevision: number, ops: GraphOp[]): MutationResult {
    if (expectedRevision !== this.graph.revision) {
      return {ok: false, status: 409, error: 'revision_conflict', graph: this.get()};
    }
    const draft = structuredClone(this.graph);
    const nodes = new Map(draft.nodes.map((n) => [n.id, n]));
    const edgeId = (e: Edge) => `${e.kind}:${e.from}->${e.to}`;
    const edges = new Map(draft.edges.map((e) => [edgeId(e), e]));

    for (const operation of ops) {
      if (operation.op === 'addNode') {
        if (nodes.has(operation.node.id))
          return this.reject(draft, `node ${operation.node.id} already exists`);
        if (!isValidNodeVersion(operation.node.version))
          return this.reject(draft, `invalid version "${operation.node.version}"`);
        nodes.set(operation.node.id, structuredClone(operation.node));
      } else if (operation.op === 'updateNode') {
        const node = nodes.get(operation.id);
        if (!node) return this.reject(draft, `unknown node ${operation.id}`);
        if (operation.patch.version !== undefined) {
          if (!isValidNodeVersion(operation.patch.version))
            return this.reject(draft, `invalid version "${operation.patch.version}"`);
        }
        Object.assign(node, operation.patch);
      } else if (operation.op === 'removeNode') {
        if (!nodes.delete(operation.id)) return this.reject(draft, `unknown node ${operation.id}`);
        for (const [key, e] of edges) {
          if (e.from === operation.id || e.to === operation.id) edges.delete(key);
        }
      } else if (operation.op === 'addEdge') {
        const e = operation.edge;
        if (edges.has(edgeId(e))) return this.reject(draft, `edge ${edgeId(e)} already exists`);
        if (!parseRangeOk(e.range)) return this.reject(draft, `invalid range "${e.range}"`);
        edges.set(edgeId(e), structuredClone(e));
      } else {
        const key = `${operation.kind}:${operation.from}->${operation.to}`;
        if (!edges.delete(key)) return this.reject(draft, `edge ${key} does not exist`);
      }
    }

    draft.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    draft.edges = [...edges.values()].sort((a, b) => edgeId(a).localeCompare(edgeId(b)));
    draft.revision += 1;
    this.graph = draft;
    return {ok: true, graph: this.get()};
  }

  private reject(_draft: Graph, error: string): MutationResult {
    // draft is discarded: the whole batch is atomic.
    return {ok: false, status: 400, error, graph: this.get()};
  }
}

function isValidNodeVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v);
}

function parseRangeOk(range: string): boolean {
  return parseRange(range) !== null;
}
