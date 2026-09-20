// Domain types shared by the server engine and the client workbench.
// Everything in this app is a local simulation: no registry calls, no publishes.

export type DepKind = 'runtime' | 'optional' | 'peer';
export type Level = 'major' | 'minor' | 'patch';

export type PkgNode = {
  id: string;
  name: string;
  version: string;
  /** Workspace packages that must never be published. */
  private?: boolean;
  /** Packages that exist outside the workspace (registry only). They can never
   * be seeded for release and never produce candidates. */
  external?: boolean;
};

export type Edge = {
  /** consumer package (`from` declares the dependency on `to`) */
  from: string;
  to: string;
  /** raw package.json style range, e.g. "^1.4.0", "~2.1.0", ">=1.0.0 <2.0.0" */
  range: string;
  kind: DepKind;
};

export type Graph = {
  revision: number;
  nodes: PkgNode[];
  edges: Edge[];
};

export type Seed = {
  pkg: string;
  /** bump level; the candidate version is derived from the current version.
   * Ignored when `version` is given. */
  level?: Level;
  /** explicit candidate version (user override / pin adjustment). */
  version?: string;
};

export type ManifestChange = {
  dep: string;
  kind: DepKind;
  fromRange: string;
  toRange: string;
  /** semver distance the consumer has to absorb */
  gap: Level | 'in-range' | 'peer-widen';
};

export type ReasonHop = {
  from: string;
  to: string;
  kind: DepKind;
  range: string;
  target: string;
  /** why this hop forces a release */
  gap: Level | 'in-range' | 'peer-widen' | 'seed';
  note: string;
};

export type ReasonChain = {
  seedPkg: string;
  level: Level;
  hops: ReasonHop[];
};

export type Candidate = {
  pkg: string;
  name: string;
  from: string;
  to: string;
  level: Level;
  private: boolean;
  /** false for private workspace packages — they get a version bump for local
   * consistency but are never "published" by the simulated train. */
  publish: boolean;
  seeded: boolean;
  overridden: boolean;
  manifestChanges: ManifestChange[];
  reasons: ReasonChain[];
  cycleWith?: string[];
};

export type SubGraph = {
  nodes: string[];
  edges: Edge[];
};

export type Conflict = {
  code:
    | 'peer-unsatisfied'
    | 'peer-mutex'
    | 'missing-runtime'
    | 'invalid-version'
    | 'override-below'
    | 'external-seed'
    | 'unknown-package';
  message: string;
  /** smallest node/edge set that explains the unsatisfiability */
  subgraph: SubGraph;
};

export type Warning = {
  code: 'missing-optional' | 'private-candidate' | 'external-seed';
  message: string;
  nodes: string[];
  edges?: Edge[];
};

export type Plan = {
  revision: number;
  /** candidates in release order (dependencies before consumers). */
  candidates: Candidate[];
  /** release groups; packages inside one group can ship in parallel. Cycles
   * are collapsed into one group. */
  releaseOrder: string[][];
  cycles: string[][];
  conflicts: Conflict[];
  warnings: Warning[];
  unaffected: string[];
};

export type RefineResult = {
  plan: Plan;
  /** packages whose candidate (or conflict status) was recomputed. */
  affected: string[];
  /** candidates reused byte-for-byte from the previous plan. */
  reused: string[];
};

export const LEVEL_RANK: Record<Level, number> = {patch: 1, minor: 2, major: 3};

export function maxLevel(a: Level, b: Level): Level {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}
