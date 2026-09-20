import type {Graph, Plan, RefineResult, Seed} from '../shared/types';

async function parse(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `request_failed_${res.status}`) as Error & {
      status: number;
      current?: Graph;
    };
    err.status = res.status;
    err.current = body.current;
    throw err;
  }
  return body;
}

export const api = {
  graph: (): Promise<Graph> => fetch('/api/graph').then(parse),
  mutate: (
    revision: number,
    ops: unknown[],
  ): Promise<{graph: Graph}> =>
    fetch('/api/graph/mutate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, ops}),
    }).then(parse),
  plan: (
    revision: number,
    seeds: Seed[],
    overrides: Seed[],
    session: string,
  ): Promise<{plan: Plan}> =>
    fetch('/api/plan', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, seeds, overrides, session}),
    }).then(parse),
  refine: (
    revision: number,
    seeds: Seed[],
    overrides: Seed[],
    session: string,
  ): Promise<RefineResult & {session: string}> =>
    fetch('/api/refine', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, seeds, overrides, session}),
    }).then(parse),
};
