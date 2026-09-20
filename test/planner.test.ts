import {describe, expect, it} from 'vitest';
import {computePlan, refinePlan} from '../src/shared/planner';
import type {Edge, Graph, PkgNode} from '../src/shared/types';

function graph(nodes: Array<PkgNode | [string, string, Partial<PkgNode>?]>, edges: Edge[] = []): Graph {
  return {
    revision: 1,
    nodes: nodes.map((n) =>
      Array.isArray(n)
        ? ({id: n[0], name: '@x/' + n[0], version: n[1], ...(n[2] ?? {})} as PkgNode)
        : n,
    ),
    edges,
  };
}
const e = (from: string, to: string, range: string, kind: Edge['kind'] = 'runtime'): Edge => ({
  from,
  to,
  range,
  kind,
});

describe('impact propagation', () => {
  const g = graph(
    [
      ['a', '1.0.0'],
      ['b', '1.0.0'],
      ['c', '1.0.0'],
      ['d', '1.0.0'],
    ],
    [
      // tilde: minor producer moves break the range and propagate as patch
      e('b', 'a', '~1.0.0'),
      // caret: only major producer moves break it, propagating as minor
      e('c', 'a', '^1.0.0'),
      // exact pin: tight coupling, response keeps the producer's level
      e('d', 'b', '1.0.0'),
    ],
  );

  it('keeps in-range patch/minor moves out of the train (caret absorbs them)', () => {
    const patchOnly = computePlan(g, [{pkg: 'a', level: 'patch'}]);
    expect(patchOnly.candidates.map((c) => c.pkg)).toEqual(['a']);
    const minor = computePlan(g, [{pkg: 'a', level: 'minor'}]);
    // b's tilde breaks on 1.1.0 -> minimal patch response; c's caret absorbs it.
    // d pins b: 1.0.1 breaks the pin and propagates as a patch too.
    expect(minor.candidates.map((x) => x.pkg).sort()).toEqual(['a', 'b', 'd']);
    expect(minor.candidates.find((x) => x.pkg === 'b')!.level).toBe('patch');
    expect(minor.candidates.find((x) => x.pkg === 'd')!.level).toBe('patch');
  });

  it('propagates the minimal impact according to range shape', () => {
    const plan = computePlan(g, [{pkg: 'a', level: 'major'}]);
    const byPkg = new Map(plan.candidates.map((c) => [c.pkg, c]));
    expect(byPkg.get('a')!.to).toBe('2.0.0');
    // tilde breaks major -> minimal minor response
    expect(byPkg.get('b')!.level).toBe('minor');
    expect(byPkg.get('b')!.to).toBe('1.1.0');
    // caret breaks major -> minimal minor response
    expect(byPkg.get('c')!.level).toBe('minor');
    expect(byPkg.get('c')!.to).toBe('1.1.0');
    // d pins b exactly: b's minor (1.1.0) breaks the pin and keeps its level
    expect(byPkg.get('d')!.level).toBe('minor');
  });

  it('merges paths with the maximum required level and records reason chains', () => {
    const plan = computePlan(g, [{pkg: 'a', level: 'major'}]);
    const d = plan.candidates.find((c) => c.pkg === 'd')!;
    expect(d).toBeTruthy();
    const chain = d.reasons.find((r) => r.seedPkg === 'a')!;
    expect(chain.hops.map((h) => `${h.from}>${h.to}`)).toEqual(['a>b', 'b>d']);
    expect(chain.hops[0].gap).toBe('minor'); // a major breaks b's tilde -> minor
    expect(chain.hops[1].gap).toBe('minor'); // pin keeps the level
  });

  it('emits release waves in dependency order', () => {
    const plan = computePlan(g, [{pkg: 'a', level: 'major'}]);
    expect(plan.releaseOrder.map((wave) => wave.join(','))).toEqual(['a', 'b,c', 'd']);
  });
});

describe('dependency cycles', () => {
  it('solves the fixed point and collapses the cycle into one wave', () => {
    const g = graph(
      [
        ['s', '1.0.0'],
        ['c', '1.0.0'],
        ['app', '1.0.0'],
      ],
      [e('s', 'c', '~1.0.0'), e('c', 's', '~1.0.0'), e('app', 's', '1.0.0')],
    );
    const plan = computePlan(g, [{pkg: 's', level: 'minor'}]);
    const ids = plan.candidates.map((x) => x.pkg).sort();
    expect(ids).toEqual(['app', 'c', 's']);
    expect(plan.cycles).toEqual([['c', 's']]);
    const cycleWave = plan.releaseOrder.find((w) => w.includes('s'))!;
    expect(cycleWave.sort()).toEqual(['c', 's']);
    const waveIndex = (id: string) => plan.releaseOrder.findIndex((w) => w.includes(id));
    expect(waveIndex('app')).toBeGreaterThan(waveIndex('s'));
    const app = plan.candidates.find((x) => x.pkg === 'app')!;
    expect(app.cycleWith).toBeUndefined();
    const s = plan.candidates.find((x) => x.pkg === 's')!;
    expect(s.cycleWith).toEqual(['c']);
  });
});

describe('prereleases', () => {
  it('moves prerelease chains with tuple-anchored carets', () => {
    const g = graph(
      [
        ['rx', '0.2.0-beta.3'],
        ['px', '4.0.0'],
      ],
      [e('px', 'rx', '0.2.0-beta.2')],
    );
    const plan = computePlan(g, [{pkg: 'rx', version: '0.2.0-beta.4'}]);
    const px = plan.candidates.find((c) => c.pkg === 'px')!;
    expect(px).toBeTruthy();
    const change = px.manifestChanges.find((m) => m.dep === 'rx')!;
    expect(change.toRange).toBe('0.2.0-beta.4');
  });

  it('promotes prerelease to stable with a patch-level consumer response', () => {
    const g = graph(
      [
        ['rx', '0.2.0-beta.3'],
        ['px', '4.0.0'],
      ],
      [e('px', 'rx', '0.2.0-beta.3')],
    );
    const plan = computePlan(g, [{pkg: 'rx', version: '0.2.0'}]);
    const px = plan.candidates.find((c) => c.pkg === 'px')!;
    expect(px.level).toBe('patch');
    expect(px.manifestChanges[0].toRange).toBe('0.2.0');
  });
});

describe('peer constraints', () => {
  const react: PkgNode = {id: 'react', name: 'react', version: '18.2.0', external: true};

  it('flags mutually exclusive peer ranges with the minimal conflict subgraph', () => {
    const g = graph(
      [
        react,
        ['x', '1.0.0'],
        ['y', '1.0.0'],
        ['z', '1.0.0'],
      ],
      [
        e('x', 'react', '^18.0.0', 'peer'),
        e('y', 'react', '^17.0.0', 'peer'),
        e('z', 'x', '^1.0.0'),
        e('z', 'y', '^1.0.0'),
        // pin y to x: x's patch breaks the pin, so y joins the release closure
        e('y', 'x', '1.0.0'),
      ],
    );
    const plan = computePlan(g, [{pkg: 'x', level: 'patch'}]);
    const conflict = plan.conflicts.find((c) => c.code === 'peer-mutex')!;
    expect(conflict).toBeTruthy();
    // minimal: the two peer edges + the two consumers (z need not be present)
    expect(conflict.subgraph.nodes.sort()).toEqual(['react', 'x', 'y']);
    expect(conflict.subgraph.edges).toHaveLength(2);
  });

  it('does not flag intersectable peer ranges', () => {
    const g = graph(
      [
        react,
        ['x', '1.0.0'],
        ['y', '1.0.0'],
      ],
      [
        e('x', 'react', '^17.0.0 || ^18.0.0', 'peer'),
        e('y', 'react', '^18.0.0', 'peer'),
      ],
    );
    const plan = computePlan(g, [{pkg: 'x', level: 'patch'}]);
    expect(plan.conflicts.filter((c) => c.code === 'peer-mutex')).toHaveLength(0);
  });

  it('flags an installed peer that violates a single constraint', () => {
    const g = graph(
      [
        react,
        ['gz', '1.0.0'],
      ],
      [e('gz', 'react', '18.2.0'), e('gz', 'react', '^17.0.0', 'peer')],
    );
    const plan = computePlan(g, [{pkg: 'gz', level: 'patch'}]);
    const conflict = plan.conflicts.find((c) => c.code === 'peer-unsatisfied')!;
    expect(conflict).toBeTruthy();
    expect(conflict.subgraph.nodes).toContain('react');
    expect(conflict.subgraph.edges.some((x) => x.kind === 'peer')).toBe(true);
  });

  it('proposes a peer declaration widening when the released peer moves', () => {
    const g = graph(
      [
        ['react-local', '18.2.0'],
        ['x', '1.0.0'],
      ],
      [e('x', 'react-local', '~18.2.0', 'peer')],
    );
    // peer minor move breaks the tilde; the consumer release would need the
    // declaration widened (and this remains surfaced as a constraint break).
    const plan = computePlan(g, [
      {pkg: 'react-local', level: 'minor'},
      {pkg: 'x', level: 'patch'},
    ]);
    const x = plan.candidates.find((c) => c.pkg === 'x')!;
    const change = x.manifestChanges.find((m) => m.kind === 'peer')!;
    expect(change.toRange).toBe('~18.3.0');
    expect(change.gap).toBe('peer-widen');
    // the engine never silently accepts the widening: it stays a conflict the
    // user must explicitly approve by adjusting the candidate/declaration
    expect(plan.conflicts.some((c) => c.code === 'peer-unsatisfied')).toBe(true);
  });
});

describe('optional and missing dependencies', () => {
  it('skips absent optional dependencies and warns', () => {
    const g = graph(
      [
        ['a', '1.0.0'],
        ['ghost', '1.0.0'],
      ],
      [e('a', 'ghost', '^1.0.0', 'optional')],
    );
    // ghost exists in nodes above; rebuild without it to simulate absence
    const absent: Graph = {
      ...g,
      nodes: g.nodes.filter((n) => n.id !== 'ghost'),
    };
    const plan = computePlan(absent, [{pkg: 'a', level: 'minor'}]);
    expect(plan.candidates.map((c) => c.pkg)).toEqual(['a']);
    const warn = plan.warnings.find((w) => w.code === 'missing-optional')!;
    expect(warn).toBeTruthy();
    expect(warn.nodes).toContain('ghost');
  });

  it('treats a missing runtime dependency as a hard conflict', () => {
    const g: Graph = {
      revision: 1,
      nodes: [{id: 'a', name: '@x/a', version: '1.0.0'}],
      edges: [e('a', 'gone', '^2.0.0')],
    };
    const plan = computePlan(g, [{pkg: 'a', level: 'patch'}]);
    const conflict = plan.conflicts.find((c) => c.code === 'missing-runtime')!;
    expect(conflict).toBeTruthy();
    expect(conflict.subgraph.nodes.sort()).toEqual(['a', 'gone']);
  });
});

describe('private and external packages', () => {
  it('bumps private packages but marks them unpublishable', () => {
    const g = graph(
      [
        ['lib', '1.0.0'],
        ['app', '1.0.0', {private: true}],
      ],
      [e('app', 'lib', '^1.0.0')],
    );
    const plan = computePlan(g, [{pkg: 'lib', level: 'major'}]);
    const app = plan.candidates.find((c) => c.pkg === 'app')!;
    expect(app.private).toBe(true);
    expect(app.publish).toBe(false);
    expect(plan.warnings.some((w) => w.code === 'private-candidate')).toBe(true);
  });

  it('refuses to seed external packages', () => {
    const g = graph([{id: 'r', name: 'r', version: '1.0.0', external: true}], []);
    const plan = computePlan(g, [{pkg: 'r', level: 'patch'}]);
    expect(plan.conflicts.find((c) => c.code === 'external-seed')).toBeTruthy();
  });
});

describe('candidate adjustment and incremental recompute', () => {
  const g = graph(
    [
      ['a', '1.0.0'],
      ['b', '1.0.0'],
      ['c', '1.0.0'],
      ['d', '1.0.0'],
    ],
    [e('b', 'a', '~1.0.0'), e('c', 'a', '^1.0.0'), e('d', 'b', '1.0.0')],
  );

  it('reports the affected reverse subgraph and reuses unchanged candidates', () => {
    const first = computePlan(g, [{pkg: 'a', level: 'major'}]);
    const aBefore = first.candidates.find((c) => c.pkg === 'a')!;
    const cBefore = first.candidates.find((c) => c.pkg === 'c')!;
    const refined = refinePlan(first, g, [{pkg: 'a', level: 'major'}], [
      {pkg: 'b', version: '1.5.0'},
    ]);
    // b changed; d reverse-reaches b through its pin. a and c are untouched.
    expect(refined.affected.sort()).toEqual(['b', 'd']);
    expect(refined.reused.sort()).toEqual(['a', 'c']);
    const aAfter = refined.plan.candidates.find((c) => c.pkg === 'a')!;
    const cAfter = refined.plan.candidates.find((c) => c.pkg === 'c')!;
    expect(aAfter).toBe(aBefore); // object identity preserved
    expect(cAfter).toBe(cBefore);
  });

  it('flags an override below the propagated requirement', () => {
    const tight = graph(
      [
        ['a', '1.0.0'],
        ['b', '1.0.0'],
      ],
      [e('b', 'a', '^1.0.0')],
    );
    // a@2.0.0 breaks caret: b must release minor (1.1.0); pin b to 1.0.5.
    const first = computePlan(tight, [{pkg: 'a', level: 'major'}]);
    const refined = refinePlan(first, tight, [{pkg: 'a', level: 'major'}], [
      {pkg: 'b', version: '1.0.5'},
    ]);
    const conflict = refined.plan.conflicts.find((c) => c.code === 'override-below')!;
    expect(conflict).toBeTruthy();
    expect(conflict.subgraph.nodes).toContain('a');
  });

  it('accepts an override above the propagated requirement', () => {
    const first = computePlan(g, [{pkg: 'a', level: 'major'}]);
    const refined = refinePlan(first, g, [{pkg: 'a', level: 'major'}], [
      {pkg: 'b', version: '2.0.0'},
    ]);
    expect(refined.plan.conflicts.filter((c) => c.code === 'override-below')).toHaveLength(0);
    const b = refined.plan.candidates.find((c) => c.pkg === 'b')!;
    expect(b.to).toBe('2.0.0');
    expect(b.overridden).toBe(true);
  });
});
