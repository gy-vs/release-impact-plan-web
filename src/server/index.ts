import express from 'express';
import {fileURLToPath} from 'node:url';
import {GraphStore, RevisionConflictError, ValidationError} from './store';
import {solve, solveIncremental} from './planner';
import type {GraphMutation, PlanResult} from '../shared/model';

export function createApp(store = new GraphStore()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/graph', (_req, res) => {
    const g = store.snapshot();
    res.set('ETag', String(g.revision)).json(g);
  });

  // 并发修改：写队列串行执行；revision 失配返回 409，旧调整不能覆盖新图
  app.post('/api/graph/mutate', async (req, res) => {
    const body = req.body as {revision?: number; mutation?: GraphMutation} | undefined;
    if (!body || typeof body.revision !== 'number' || !body.mutation) {
      res.status(400).json({error: 'bad_request', message: '需要 revision 和 mutation'});
      return;
    }
    try {
      const next = await store.mutate(body.revision, body.mutation);
      res.json(next);
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        res.status(409).json({error: 'revision_conflict', current: err.current});
        return;
      }
      if (err instanceof ValidationError) {
        res.status(400).json({error: 'validation_error', message: err.message});
        return;
      }
      res.status(500).json({error: 'internal'});
    }
  });

  function revisionGuard(req: express.Request, res: express.Response): boolean {
    const rev = Number((req.body as {revision?: unknown})?.revision);
    if (!Number.isInteger(rev)) {
      res.status(400).json({error: 'bad_request', message: '需要 revision'});
      return false;
    }
    if (rev !== store.revision) {
      res.status(409).json({error: 'revision_conflict', current: store.snapshot()});
      return false;
    }
    return true;
  }

  app.post('/api/plan/compute', (req, res) => {
    if (!revisionGuard(req, res)) return;
    const body = req.body as {
      changes: Array<{id: string; to?: string; level?: 'major' | 'minor' | 'patch'}>;
      overrides?: Record<string, string>;
    };
    if (!Array.isArray(body.changes)) {
      res.status(400).json({error: 'bad_request', message: 'changes 必须是数组'});
      return;
    }
    const result: PlanResult = solve(store.snapshot(), {changes: body.changes, overrides: body.overrides}, {mode: 'full'});
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post('/api/plan/recompute', (req, res) => {
    if (!revisionGuard(req, res)) return;
    const body = req.body as {
      changes: Array<{id: string; to?: string; level?: 'major' | 'minor' | 'patch'}>;
      overrides?: Record<string, string>;
      adjustedId?: string;
      previous?: Array<{id: string; to: string; rangeUpdates: Array<{to: string; kind: string; oldRange: string; newRange: string}>}>;
    };
    if (!body.adjustedId || !Array.isArray(body.previous) || !Array.isArray(body.changes)) {
      res.status(400).json({error: 'bad_request', message: '需要 changes、adjustedId、previous'});
      return;
    }
    const result: PlanResult = solveIncremental(store.snapshot(), {
      changes: body.changes,
      overrides: body.overrides,
      adjustedId: body.adjustedId,
      previous: body.previous as never,
    });
    if (!result.ok && result.conflict.kind === 'bad-request') {
      res.status(400).json(result);
      return;
    }
    res.status(result.ok ? 200 : 422).json(result);
  });

  // 测试辅助：恢复初始 revision 1
  app.post('/api/graph/reset', (_req, res) => {
    void store.reset().then((g) => res.json(g));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
