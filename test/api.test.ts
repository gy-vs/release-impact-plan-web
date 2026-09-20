import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {GraphStore} from '../src/server/store';

function appWithFreshStore() {
  return createApp(new GraphStore());
}

describe('graph mutations', () => {
  it('applies a batch atomically and bumps revision once', async () => {
    const app = appWithFreshStore();
    const before = await request(app).get('/api/graph').expect(200);
    const rev = before.body.revision;
    const res = await request(app)
      .post('/api/graph/mutate')
      .send({
        revision: rev,
        ops: [
          {op: 'addNode', node: {id: 'newton', name: '@studio/newton', version: '1.0.0'}},
          {
            op: 'addEdge',
            edge: {from: 'newton', to: 'core', range: '^1.4.0', kind: 'runtime'},
          },
        ],
      })
      .expect(200);
    expect(res.body.graph.revision).toBe(rev + 1);
    expect(res.body.graph.nodes.find((n: any) => n.id === 'newton')).toBeTruthy();
  });

  it('rejects the whole batch when one op is invalid (atomicity)', async () => {
    const app = appWithFreshStore();
    const before = await request(app).get('/api/graph').expect(200);
    const rev = before.body.revision;
    await request(app)
      .post('/api/graph/mutate')
      .send({
        revision: rev,
        ops: [
          {op: 'addNode', node: {id: 'newton', name: '@studio/newton', version: '1.0.0'}},
          {op: 'addEdge', edge: {from: 'newton', to: 'core', range: 'not a range', kind: 'runtime'}},
        ],
      })
      .expect(400);
    const after = await request(app).get('/api/graph').expect(200);
    expect(after.body.revision).toBe(rev);
    expect(after.body.nodes.find((n: any) => n.id === 'newton')).toBeFalsy();
  });

  it('returns 409 on a stale revision so concurrent edits cannot overwrite', async () => {
    const app = appWithFreshStore();
    const before = await request(app).get('/api/graph').expect(200);
    const rev = before.body.revision;
    await request(app)
      .post('/api/graph/mutate')
      .send({revision: rev, ops: [{op: 'addNode', node: {id: 'a1', name: 'a1', version: '1.0.0'}}]})
      .expect(200);
    const stale = await request(app)
      .post('/api/graph/mutate')
      .send({revision: rev, ops: [{op: 'addNode', node: {id: 'b2', name: 'b2', version: '1.0.0'}}]})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(rev + 1);
  });
});

describe('plan and refine', () => {
  it('rejects plan requests against a stale graph revision', async () => {
    const app = appWithFreshStore();
    const res = await request(app)
      .post('/api/plan')
      .send({revision: 999, seeds: [{pkg: 'core', level: 'patch'}]})
      .expect(409);
    expect(res.body.current.revision).toBeGreaterThan(0);
  });

  it('computes the release train with reasons and waves', async () => {
    const app = appWithFreshStore();
    const graph = (await request(app).get('/api/graph')).body;
    const res = await request(app)
      .post('/api/plan')
      .send({revision: graph.revision, seeds: [{pkg: 'core', level: 'major'}], session: 's1'})
      .expect(200);
    const {plan} = res.body;
    const ids = plan.candidates.map((c: any) => c.pkg);
    // core major propagates via tilde to core-utils (minor) and via caret to
    // analytics (minor); widgets/dashboard follow through tilde edges.
    expect(ids).toContain('core');
    expect(ids).toContain('core-utils');
    expect(ids).toContain('analytics');
    expect(ids).toContain('dashboard');
    const dashboard = plan.candidates.find((c: any) => c.pkg === 'dashboard');
    expect(dashboard.reasons.length).toBeGreaterThan(0);
    expect(dashboard.reasons[0].hops[0].from).toBe('core');
    expect(plan.releaseOrder.length).toBeGreaterThan(1);
  });

  it('incrementally refines: affected subgraph + reused candidates', async () => {
    const app = appWithFreshStore();
    const graph = (await request(app).get('/api/graph')).body;
    await request(app)
      .post('/api/plan')
      .send({revision: graph.revision, seeds: [{pkg: 'core', level: 'major'}], session: 's2'})
      .expect(200);
    const refined = await request(app)
      .post('/api/refine')
      .send({
        revision: graph.revision,
        session: 's2',
        seeds: [{pkg: 'core', level: 'major'}],
        overrides: [{pkg: 'analytics', version: '4.0.0'}],
      })
      .expect(200);
    expect(refined.body.affected).toContain('analytics');
    expect(refined.body.reused).toContain('core');
  });

  it('reports mutually exclusive peers as the minimal conflict subgraph', async () => {
    const app = appWithFreshStore();
    const graph = (await request(app).get('/api/graph')).body;
    // seeding widgets minor drags dashboard (tilde) into the closure with
    // legacy-bridge's ^17 react peer vs everyone else on 18.
    const res = await request(app)
      .post('/api/plan')
      .send({revision: graph.revision, seeds: [{pkg: 'widgets', level: 'minor'}]})
      .expect(200);
    const mutex = res.body.plan.conflicts.find((c: any) => c.code === 'peer-mutex');
    expect(mutex).toBeTruthy();
    // minimal: exactly the two peer participants and the peer node
    expect(mutex.subgraph.nodes.sort()).toEqual(['dashboard', 'legacy-bridge', 'react']);
    expect(mutex.subgraph.edges).toHaveLength(2);
    expect(mutex.subgraph.edges.every((e: any) => e.kind === 'peer')).toBe(true);
  });

  it('refuses refine when the graph revision moved concurrently', async () => {
    const app = appWithFreshStore();
    const graph = (await request(app).get('/api/graph')).body;
    await request(app)
      .post('/api/plan')
      .send({revision: graph.revision, seeds: [{pkg: 'core', level: 'patch'}], session: 's3'})
      .expect(200);
    // someone else edits the graph in between (revision moves)
    await request(app)
      .post('/api/graph/mutate')
      .send({revision: graph.revision, ops: [{op: 'addNode', node: {id: 'z9', name: 'z9', version: '1.0.0'}}]})
      .expect(200);
    const stale = await request(app)
      .post('/api/refine')
      .send({
        revision: graph.revision,
        session: 's3',
        seeds: [{pkg: 'core', level: 'patch'}],
        overrides: [{pkg: 'analytics', version: '3.0.1'}],
      })
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(graph.revision + 1);
  });

  it('reports an unsatisfied pinned peer (gizmo) inside a release closure', async () => {
    const app = appWithFreshStore();
    const graph = (await request(app).get('/api/graph')).body;
    const res = await request(app)
      .post('/api/plan')
      .send({revision: graph.revision, seeds: [{pkg: 'gizmo', level: 'patch'}]})
      .expect(200);
    const unsatisfied = res.body.plan.conflicts.find((c: any) => c.code === 'peer-unsatisfied');
    expect(unsatisfied).toBeTruthy();
    expect(unsatisfied.subgraph.nodes).toContain('react');
    expect(unsatisfied.subgraph.edges.some((e: any) => e.kind === 'peer')).toBe(true);
  });
});
