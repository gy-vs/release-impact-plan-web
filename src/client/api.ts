import type {
  ChangeReq,
  GraphMutation,
  PackageGraph,
  PlanResult,
  RecomputeReq,
} from '../shared/model';

export class StaleRevisionError extends Error {
  current: PackageGraph;
  constructor(current: PackageGraph) {
    super('revision_conflict');
    this.name = 'StaleRevisionError';
    this.current = current;
  }
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super('api_error');
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 409) throw new StaleRevisionError((body as {current: PackageGraph}).current);
    throw new ApiError(res.status, body);
  }
  return body;
}

export const api = {
  async graph(): Promise<PackageGraph> {
    return (await jsonOrThrow(await fetch('/api/graph'))) as PackageGraph;
  },
  async mutate(revision: number, mutation: GraphMutation): Promise<PackageGraph> {
    const res = await fetch('/api/graph/mutate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, mutation}),
    });
    return (await jsonOrThrow(res)) as PackageGraph;
  },
  async compute(revision: number, changes: ChangeReq[], overrides: Record<string, string>): Promise<PlanResult> {
    const res = await fetch('/api/plan/compute', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, changes, overrides}),
    });
    return (await jsonOrThrow(res)) as PlanResult;
  },
  async recompute(
    revision: number,
    payload: Omit<RecomputeReq, 'revision'>,
  ): Promise<PlanResult> {
    const res = await fetch('/api/plan/recompute', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, ...payload}),
    });
    return (await jsonOrThrow(res)) as PlanResult;
  },
};
