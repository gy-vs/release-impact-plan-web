import {describe, expect, it} from 'vitest';
import {solve, solveIncremental} from '../src/server/planner';
import {cloneFixture} from '../src/server/fixture';
import type {Candidate, PlanResult} from '../src/shared/model';

// 纯算法层（不经过 HTTP）的全场景覆盖：环、预发布、互斥 peer、可选缺失、私有包、增量重算。
describe('planner 传播规划', () => {
  const cands = (r: PlanResult): Record<string, Candidate> =>
    r.ok ? Object.fromEntries(r.candidates.map((c) => [c.id, c])) : {};
  const cand = (r: PlanResult, id: string): Candidate => cands(r)[id];
  const ok: (r: PlanResult) => asserts r is Extract<PlanResult, {ok: true}> = (r) => {
    if (!r.ok) throw new Error(`expected plan success, got ${JSON.stringify(r.conflict)}`);
  };

  it('core major：沿 runtime/optional/peer 传播最小影响，多路径取最大级别', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'utils').to).toBe('3.0.0');
    expect(cand(r, 'utils').bump).toBe('major');
    expect(cand(r, 'feature-a').to).toBe('2.0.0');
    expect(cand(r, 'feature-b').to).toBe('2.0.0');
    // peer 失配以 minor 发版并放宽范围
    expect(cand(r, 'plugin-kit').to).toBe('3.2.0');
    expect(cand(r, 'plugin-kit').bump).toBe('minor');
    expect(cand(r, 'plugin-kit').rangeUpdates[0].newRange).toContain('^2.0.0');
    // widget 同时承担 runtime major（utils）/peer minor/optional，结果取最大 major
    expect(cand(r, 'widget').to).toBe('3.0.0');
    expect(cand(r, 'widget').publishable).toBe(false);
    expect(cand(r, 'app').to).toBe('5.0.0');
    // 可选失配不放大 major：internal-tool 对 core 是 optional，但 utils 的 runtime major 仍强迫其 major
    expect(cand(r, 'internal-tool').to).toBe('2.0.0');
    expect(cand(r, 'internal-tool').rangeUpdates.some((u) => u.to === 'core' && u.kind === 'optional')).toBe(true);
    // 未触及的子图
    expect(cand(r, 'next-lib')).toBeUndefined();
    expect(cand(r, 'preview-app')).toBeUndefined();
    expect(cand(r, 'ui-lib')).toBeUndefined();
    // 冻结外部包的范围仍兼容，不构成冲突
    expect(r.skipped.some((s) => s.from === 'frozen-consumer' && s.to === 'utils' && s.reason === 'satisfied')).toBe(true);
    // 原因链：app 经 widget/plugin-kit/internal-tool 多条路径回到 core
    const chains = cand(r, 'app').reasonChains;
    expect(chains.length).toBeGreaterThanOrEqual(3);
    expect(chains.every((c) => c[0].from === 'app' && c[c.length - 1].to === 'core')).toBe(true);
  });

  it('依赖环：feature-a major 强迫 feature-b major，不动点收敛且不越出环', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'feature-a', to: '2.0.0'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'feature-b').to).toBe('2.0.0');
    expect(cand(r, 'app')).toBeUndefined();
    expect(cand(r, 'utils')).toBeUndefined();
  });

  it('caret 内 minor 升级不触发任何同步发版（范围已满足）', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'core', level: 'minor'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'core').to).toBe('1.5.0');
    expect(r.candidates.map((c) => c.id)).toEqual(['core']);
  });

  it('可选依赖缺失：目标发版时记录 optional-missing 且不传播给宿主', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'feature-x', to: '0.4.0'}]}, {mode: 'full'});
    ok(r);
    const s = r.skipped.find((x) => x.from === 'app' && x.to === 'feature-x');
    expect(s?.reason).toBe('optional-missing');
    expect(cand(r, 'app')).toBeUndefined();
  });

  it('预发布毕业：钉版 beta 的下游以 patch 发版并改写为 caret 稳定范围', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'next-lib', to: '1.0.0'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'preview-app').to).toBe('1.0.1');
    expect(cand(r, 'preview-app').bump).toBe('patch');
    expect(cand(r, 'preview-app').rangeUpdates[0].newRange).toBe('^1.0.0');
  });

  it('预发布内推进：beta.2 -> beta.3 精确钉版更新', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'next-lib', to: '1.0.0-beta.3'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'preview-app').rangeUpdates[0].newRange).toBe('1.0.0-beta.3');
    // next-lib 自身仍是预发布
    expect(cand(r, 'next-lib').prerelease).toBe(true);
    // 下游 preview-app 以稳定 patch 发版
    expect(cand(r, 'preview-app').to).toBe('1.0.1');
    expect(cand(r, 'preview-app').prerelease).toBe(false);
  });

  it('互斥 peer 范围：返回 peer-mutex 最小冲突子图，含宿主上下文边', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'peer-lib', to: '2.0.0'}]}, {mode: 'full'});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflict.kind).toBe('peer-mutex');
    const edgeSet = new Set(r.conflict.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet.has('ext-a->peer-lib')).toBe(true);
    expect(edgeSet.has('ext-b->peer-lib')).toBe(true);
    // 页面从 ui-lib 可跳到原因边：宿主作为上下文节点/边出现
    expect(edgeSet.has('ui-lib->ext-a')).toBe(true);
    expect(edgeSet.has('ui-lib->ext-b')).toBe(true);
    expect(r.conflict.edges.filter((e) => e.contradicting)).toHaveLength(2);
    expect(r.conflict.nodes.find((n) => n.id === 'ui-lib')?.context).toBe(true);
  });

  it('冻结运行范围：外部包无法改写范围时返回 frozen-range 冲突子图', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'plugin-kit', to: '4.0.0'}]}, {mode: 'full'});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflict.kind).toBe('frozen-range');
    expect(r.conflict.edges[0]).toMatchObject({
      from: 'frozen-consumer',
      to: 'plugin-kit',
      contradicting: true,
    });
  });

  it('手工调整候选版本合法/非法/降级', () => {
    const good = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}], overrides: {widget: '4.0.0'}}, {mode: 'full'});
    ok(good);
    expect(cand(good, 'widget').to).toBe('4.0.0');

    const bad = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}], overrides: {widget: 'banana'}}, {mode: 'full'});
    expect(!bad.ok && bad.conflict.kind).toBe('override-invalid');

    const downgrade = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}], overrides: {widget: '1.0.0'}}, {mode: 'full'});
    expect(!downgrade.ok && downgrade.conflict.kind).toBe('override-invalid');
  });

  it('私有包仍产出候选并传播给下游，只是不可发布', () => {
    const r = solve(cloneFixture(), {changes: [{id: 'internal-tool', to: '2.0.0'}]}, {mode: 'full'});
    ok(r);
    expect(cand(r, 'internal-tool').publishable).toBe(false);
    expect(cand(r, 'app').to).toBe('5.0.0');
    expect(cand(r, 'app').bump).toBe('major');
  });

  it('增量重算：仅重算调整候选的反向可达子图，其余候选沿用上轮', () => {
    const base = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}]}, {mode: 'full'});
    ok(base);
    const previous = base.candidates.map((c) => ({id: c.id, to: c.to, rangeUpdates: c.rangeUpdates}));
    const r = solveIncremental(cloneFixture(), {
      changes: [{id: 'core', to: '2.0.0'}],
      overrides: {utils: '4.0.0'},
      adjustedId: 'utils',
      previous,
    });
    ok(r);
    expect(r.mode).toBe('incremental');
    expect(cand(r, 'utils').to).toBe('4.0.0');
    // 反向可达 utils 的包被重算
    expect(cand(r, 'feature-a').recomputed).toBe(true);
    // plugin-kit / core 不在 utils 的反向可达集，沿用上一轮
    expect(cand(r, 'plugin-kit').recomputed).toBe(false);
    expect(cand(r, 'plugin-kit').to).toBe('3.2.0');
    expect(cand(r, 'core').recomputed).toBe(false);
    expect(r.affectedNodes).toContain('frozen-consumer');
    expect(r.affectedNodes).not.toContain('plugin-kit');
    expect(r.affectedNodes).not.toContain('preview-app');
    expect(r.removedIds ?? []).toEqual([]);
  });

  it('增量重算：调整使影响消解时，被消解的候选进入 removedIds', () => {
    const base = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}]}, {mode: 'full'});
    ok(base);
    const previous = base.candidates.map((c) => ({id: c.id, to: c.to, rangeUpdates: c.rangeUpdates}));
    const r = solveIncremental(cloneFixture(), {
      changes: [{id: 'core', to: '1.5.0'}],
      adjustedId: 'core',
      previous,
    });
    ok(r);
    expect(r.candidates.map((c) => c.id)).toEqual(['core']);
    expect(r.removedIds).toEqual(expect.arrayContaining(previous.filter((p) => p.id !== 'core').map((p) => p.id)));
  });

  it('增量重算：调整后撞冻结冲突仍返回冲突子图', () => {
    const base = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0.0'}]}, {mode: 'full'});
    ok(base);
    const previous = base.candidates.map((c) => ({id: c.id, to: c.to, rangeUpdates: c.rangeUpdates}));
    const r = solveIncremental(cloneFixture(), {
      changes: [{id: 'core', to: '2.0.0'}],
      overrides: {'plugin-kit': '4.0.0'},
      adjustedId: 'plugin-kit',
      previous,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict.kind).toBe('frozen-range');
  });

  it('重复变更/未知包/非法版本给出 bad-request', () => {
    const dup = solve(cloneFixture(), {changes: [{id: 'core', level: 'patch'}, {id: 'core', level: 'minor'}]}, {mode: 'full'});
    expect(!dup.ok && dup.conflict.kind).toBe('bad-request');
    const ghost = solve(cloneFixture(), {changes: [{id: 'ghost', level: 'patch'}]}, {mode: 'full'});
    expect(!ghost.ok && ghost.conflict.kind).toBe('bad-request');
    const badVer = solve(cloneFixture(), {changes: [{id: 'core', to: '2.0'}]}, {mode: 'full'});
    expect(!badVer.ok && badVer.conflict.kind).toBe('bad-request');
  });
});
