import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {GraphStore} from '../src/server/store';

describe('发布依赖工作台 API', () => {
  it('读取固定 revision 依赖图', async () => {
    const app = createApp();
    const res = await request(app).get('/api/graph').expect(200);
    expect(res.body.revision).toBe(1);
    expect(res.body.nodes.length).toBeGreaterThan(10);
    expect(res.body.edges.some((e: {kind: string}) => e.kind === 'peer')).toBe(true);
  });

  it('全量计算：成功时返回候选与原因链，不发布、不联网', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'core', to: '2.0.0'}]})
      .expect(200);
    expect(res.body.ok).toBe(true);
    const ids = res.body.candidates.map((c: {id: string}) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['core', 'utils', 'widget', 'app', 'plugin-kit']));
    const appC = res.body.candidates.find((c: {id: string}) => c.id === 'app');
    expect(appC.reasonChains.length).toBeGreaterThanOrEqual(3);
  });

  it('无法满足时 422 返回最小冲突子图（互斥 peer）', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'peer-lib', to: '2.0.0'}]})
      .expect(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.conflict.kind).toBe('peer-mutex');
    expect(res.body.conflict.edges.some((e: {contradicting: boolean}) => e.contradicting)).toBe(true);
  });

  it('冻结运行范围无法改写时 422', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'plugin-kit', to: '4.0.0'}]})
      .expect(422);
    expect(res.body.conflict.kind).toBe('frozen-range');
  });

  it('增量重算：只重算受影响子图并标注沿用项', async () => {
    const app = createApp();
    const base = await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'core', to: '2.0.0'}]})
      .expect(200);
    const previous = base.body.candidates.map((c: {id: string; to: string; rangeUpdates: unknown[]}) => ({
      id: c.id,
      to: c.to,
      rangeUpdates: c.rangeUpdates,
    }));
    const res = await request(app)
      .post('/api/plan/recompute')
      .send({
        revision: 1,
        changes: [{id: 'core', to: '2.0.0'}],
        overrides: {utils: '4.0.0'},
        adjustedId: 'utils',
        previous,
      })
      .expect(200);
    expect(res.body.mode).toBe('incremental');
    const pk = res.body.candidates.find((c: {id: string}) => c.id === 'plugin-kit');
    expect(pk.recomputed).toBe(false);
    const fa = res.body.candidates.find((c: {id: string}) => c.id === 'feature-a');
    expect(fa.recomputed).toBe(true);
  });

  it('增量重算导致消解时返回 removedIds', async () => {
    const app = createApp();
    const base = await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'core', to: '2.0.0'}]})
      .expect(200);
    const previous = base.body.candidates.map((c: {id: string; to: string; rangeUpdates: unknown[]}) => ({
      id: c.id,
      to: c.to,
      rangeUpdates: c.rangeUpdates,
    }));
    const res = await request(app)
      .post('/api/plan/recompute')
      .send({revision: 1, changes: [{id: 'core', to: '1.5.0'}], adjustedId: 'core', previous})
      .expect(200);
    expect(res.body.candidates.map((c: {id: string}) => c.id)).toEqual(['core']);
    expect(res.body.removedIds.length).toBe(previous.length - 1);
  });

  it('图变更：同 revision 串行成功，过期 revision 返回 409 且不覆盖', async () => {
    const store = new GraphStore();
    const app = createApp(store);
    const ok = await request(app)
      .post('/api/graph/mutate')
      .send({revision: 1, mutation: {op: 'set-version', id: 'core', version: '1.5.0'}})
      .expect(200);
    expect(ok.body.revision).toBe(2);
    const core = ok.body.nodes.find((n: {id: string}) => n.id === 'core');
    expect(core.version).toBe('1.5.0');

    const stale = await request(app)
      .post('/api/graph/mutate')
      .send({revision: 1, mutation: {op: 'set-version', id: 'core', version: '9.9.9'}})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    // 旧调整没有覆盖新版本
    const graph = await request(app).get('/api/graph').expect(200);
    expect(graph.body.revision).toBe(2);
    expect(graph.body.nodes.find((n: {id: string}) => n.id === 'core').version).toBe('1.5.0');
  });

  it('并发修改：两个相同 revision 的提交只有一个成功，另一个 409', async () => {
    const app = createApp();
    const [a, b] = await Promise.all([
      request(app)
        .post('/api/graph/mutate')
        .send({revision: 1, mutation: {op: 'set-version', id: 'core', version: '1.6.0'}}),
      request(app)
        .post('/api/graph/mutate')
        .send({revision: 1, mutation: {op: 'set-version', id: 'utils', version: '2.5.0'}}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const graph = await request(app).get('/api/graph').expect(200);
    expect(graph.body.revision).toBe(2);
  });

  it('计划请求使用过期图 revision 时返回 409', async () => {
    const app = createApp();
    await request(app)
      .post('/api/graph/mutate')
      .send({revision: 1, mutation: {op: 'set-version', id: 'core', version: '1.5.0'}})
      .expect(200);
    await request(app)
      .post('/api/plan/compute')
      .send({revision: 1, changes: [{id: 'core', to: '2.0.0'}]})
      .expect(409);
  });

  it('增删边：成功后影响传播；非法操作 400', async () => {
    const app = createApp();
    await request(app)
      .post('/api/graph/mutate')
      .send({revision: 1, mutation: {op: 'remove-edge', from: 'app', to: 'frozen-consumer', kind: 'runtime'}})
      .expect(200);
    // 删边后 app 不再受 frozen-consumer 约束；同时 plugin-kit major 仍通过其它宿主？
    // frozen-consumer 自身仍钉 plugin-kit ^3：直接验 frozen 冲突仍然存在于 frozen-consumer
    const res = await request(app)
      .post('/api/plan/compute')
      .send({revision: 2, changes: [{id: 'plugin-kit', to: '4.0.0'}]})
      .expect(422);
    expect(res.body.conflict.kind).toBe('frozen-range');

    await request(app)
      .post('/api/graph/mutate')
      .send({revision: 2, mutation: {op: 'set-version', id: 'core', version: 'not-a-version'}})
      .expect(400);
  });
});
