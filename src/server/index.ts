import express from 'express';
import {fileURLToPath} from 'node:url';
import {computePlan, refinePlan} from '../shared/planner';
import type {Graph, Plan, Seed} from '../shared/types';
import {GraphStore, type GraphOp} from './store';

export function createApp(store = new GraphStore()) {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  // small bounded session cache so /refine can diff against the previous plan
  const sessionPlans = new Map<string, Plan>();
  function rememberPlan(session: string, plan: Plan) {
    sessionPlans.set(session, plan);
    if (sessionPlans.size > 64) {
      const oldest = sessionPlans.keys().next().value as string;
      sessionPlans.delete(oldest);
    }
  }

  app.get('/api/health', (_req, res) => res.json({ok: true, mode: 'local-simulation'}));

  app.get('/api/graph', (_req, res) => {
    res.json(store.get());
  });

  app.post('/api/graph/mutate', (req, res) => {
    const revision = Number(req.body?.revision);
    const ops = req.body?.ops;
    if (!Number.isInteger(revision)) return res.status(400).json({error: 'revision_required'});
    if (!Array.isArray(ops)) return res.status(400).json({error: 'ops_array_required'});
    const result = store.mutate(revision, ops as GraphOp[]);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        current: result.graph,
      });
    }
    res.json({graph: result.graph});
  });

  function normalizeSelections(body: any): {seeds: Seed[]; overrides: Seed[]} | {error: string} {
    const seeds: Seed[] = [];
    const overrides: Seed[] = [];
    for (const raw of Array.isArray(body?.seeds) ? body.seeds : []) {
      if (!raw || typeof raw.pkg !== 'string') return {error: 'seed_missing_pkg'};
      const seed: Seed = {pkg: raw.pkg};
      if (raw.version !== undefined) seed.version = String(raw.version);
      if (raw.level !== undefined) seed.level = raw.level;
      if (!seed.version && !seed.level) return {error: 'seed_needs_level_or_version'};
      seeds.push(seed);
    }
    for (const raw of Array.isArray(body?.overrides) ? body.overrides : []) {
      if (!raw || typeof raw.pkg !== 'string' || typeof raw.version !== 'string')
        return {error: 'override_needs_pkg_and_version'};
      overrides.push({pkg: raw.pkg, version: String(raw.version)});
    }
    return {seeds, overrides};
  }

  app.post('/api/plan', (req, res) => {
    const expectedRevision = Number(req.body?.revision);
    if (!Number.isInteger(expectedRevision))
      return res.status(400).json({error: 'revision_required'});
    if (expectedRevision !== store.revision)
      return res.status(409).json({error: 'revision_conflict', current: store.get()});
    const selection = normalizeSelections(req.body);
    if ('error' in selection) return res.status(400).json({error: selection.error});

    const graph = store.get();
    const plan = computePlan(graph, selection.seeds, selection.overrides);
    const session = typeof req.body?.session === 'string' ? req.body.session : 'default';
    rememberPlan(session, plan);
    res.json({plan});
  });

  app.post('/api/refine', (req, res) => {
    const expectedRevision = Number(req.body?.revision);
    if (!Number.isInteger(expectedRevision))
      return res.status(400).json({error: 'revision_required'});
    if (expectedRevision !== store.revision)
      return res.status(409).json({error: 'revision_conflict', current: store.get()});
    const selection = normalizeSelections(req.body);
    if ('error' in selection) return res.status(400).json({error: selection.error});

    const session = typeof req.body?.session === 'string' ? req.body.session : 'default';
    const prev = sessionPlans.get(session) ?? null;
    const result = refinePlan(prev, store.get(), selection.seeds, selection.overrides);
    rememberPlan(session, result.plan);
    res.json({...result, session});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
