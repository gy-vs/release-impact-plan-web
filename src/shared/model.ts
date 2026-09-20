// 发布依赖工作台的共享领域模型（服务端与前端共用，不依赖任何运行时）

export type DepKind = 'runtime' | 'optional' | 'peer';
export type Level = 'major' | 'minor' | 'patch';

export interface PkgNode {
  id: string;
  name: string;
  version: string;
  /** 仓库外部包：版本与依赖范围冻结，不可发版（其范围失配只能产生冲突） */
  external?: boolean;
  /** 私有包：可以产出候选版本并继续向下游传播，但不可发布到公共仓库 */
  private?: boolean;
}

export interface DepEdge {
  /** 依赖方 */
  from: string;
  /** 被依赖方 */
  to: string;
  kind: DepKind;
  /** 声明的 semver 范围，如 ^1.2.0 / 2.0.0-rc.1 / ^1 || ^2 */
  range: string;
  /** 仅可选依赖：目标包未安装时不构成约束 */
  missing?: boolean;
}

export interface PackageGraph {
  revision: number;
  updatedAt: string;
  nodes: PkgNode[];
  edges: DepEdge[];
}

export interface ChangeReq {
  id: string;
  /** 显式目标版本；与 level 二选一 */
  to?: string;
  /** 不指定版本时按 major/minor/patch 自动升级 */
  level?: Level;
}

export interface ComputeReq {
  revision: number;
  changes: ChangeReq[];
  /** 前端手工调整的候选版本：id -> 版本 */
  overrides?: Record<string, string>;
}

export interface RecomputeReq extends ComputeReq {
  /** 本次被调整的候选 id */
  adjustedId: string;
  /** 上一轮候选版本（用于固定未受影响子图） */
  previous: Array<{
    id: string;
    to: string;
    rangeUpdates: RangeUpdate[];
  }>;
}

export interface GraphMutation {
  op: 'set-version' | 'set-node' | 'add-edge' | 'remove-edge';
  id?: string;
  version?: string;
  patch?: Partial<Pick<PkgNode, 'name' | 'external' | 'private'>>;
  edge?: DepEdge;
  from?: string;
  to?: string;
  kind?: DepKind;
}

export interface ReasonHop {
  from: string;
  to: string;
  kind: DepKind;
  /** 该边上声明的旧范围 */
  declaredRange: string;
  /** 传播后建议的新范围（若该包发版） */
  newRange?: string;
  /** 触发传播时被依赖方的新版本 */
  dependencyVersion: string;
  /** 这条边贡献的最小影响 */
  impact: Level;
  detail: string;
}

export interface RangeUpdate {
  to: string;
  kind: DepKind;
  oldRange: string;
  newRange: string;
}

export interface Candidate {
  id: string;
  name: string;
  from: string;
  to: string;
  bump: Level;
  prerelease: boolean;
  /** 用户在左侧勾选的原始变更 */
  selected: boolean;
  private: boolean;
  publishable: boolean;
  /** 多条传播路径：每个元素是一条从原始变更到本包的原因链 */
  reasonChains: ReasonHop[][];
  rangeUpdates: RangeUpdate[];
  /** 增量重算时：该候选位于受影响子图中，本轮被重新计算 */
  recomputed?: boolean;
}

export interface SkippedEdge {
  from: string;
  to: string;
  kind: DepKind;
  range: string;
  reason: 'satisfied' | 'optional-missing';
  version: string;
  detail: string;
}

export interface ConflictNode extends PkgNode {
  context?: boolean;
  detail?: string;
}

export interface ConflictEdge {
  from: string;
  to: string;
  kind: DepKind;
  range: string;
  missing?: boolean;
  /** 直接构成矛盾的边；false 表示仅用于追溯原因链的上下⽂边 */
  contradicting: boolean;
  detail?: string;
}

export interface ConflictSubgraph {
  kind: 'frozen-range' | 'peer-mutex' | 'override-invalid' | 'bad-request';
  message: string;
  nodes: ConflictNode[];
  edges: ConflictEdge[];
  /** 从原始变更走到冲突点的原因链 */
  chains: ReasonHop[][];
}

export interface PlanSuccess {
  ok: true;
  graphRevision: number;
  mode: 'full' | 'incremental';
  adjustedId?: string;
  affectedNodes?: string[];
  candidates: Candidate[];
  skipped: SkippedEdge[];
  /** 增量重算时：上一轮存在、本轮被消解的候选 */
  removedIds?: string[];
}

export interface PlanFailure {
  ok: false;
  graphRevision: number;
  conflict: ConflictSubgraph;
}

export type PlanResult = PlanSuccess | PlanFailure;
