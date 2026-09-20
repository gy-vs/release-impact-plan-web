import {describe, expect, it} from 'vitest';
import {satisfies, intersectionWitness, format, bumpVersion, updateRange, deriveLevel} from '../src/server/semver';

describe('semver 内核', () => {
  const eq = (name: string, got: unknown, want: unknown) => it(name, () => expect(got).toEqual(want));
  const witness = (ranges: string[]) => {
    const w = intersectionWitness(ranges);
    return w ? format(w) : null;
  };

// 基础 satisfies
eq('caret', satisfies('1.5.0', '^1.0.0'), true);
eq('caret-major-bump', satisfies('2.0.0', '^1.0.0'), false);
eq('caret-0', satisfies('0.3.1', '^0.3.0'), true);
eq('caret-0-break', satisfies('0.4.0', '^0.3.0'), false);
eq('pre-exact', satisfies('1.0.0-beta.2', '1.0.0-beta.2'), true);
eq('pre-not-in-caret', satisfies('1.0.0-beta.2', '^1.0.0'), false);
eq('pre-tuple', satisfies('1.0.0-beta.3', '>=1.0.0-beta.1'), true);
eq('pre-other-tuple', satisfies('1.0.1-beta.1', '>=1.0.0-beta.1'), false);
eq('union-1', satisfies('2.1.0', '^1.0.0 || ^2.0.0'), true);
eq('union-2', satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
eq('hyphen', satisfies('1.5.0', '1.0.0 - 1.5.0'), true);
eq('x-range', satisfies('2.9.9', '2.x'), true);
eq('tilde', satisfies('1.2.9', '~1.2.0'), true);
eq('tilde-block', satisfies('1.3.0', '~1.2.0'), false);

// 交集
eq('intersect-disjoint', witness(['^1.0.0', '^2.0.0']), null);
eq('intersect-overlap', witness(['^1.0.0', '>=1.4.0']) !== null, true);
eq('intersect-union', witness(['^1.0.0 || ^2.0.0', '^2.1.0']), '2.1.0');
eq('intersect-prerelease', witness(['>=1.0.0-beta.1', '1.0.0-beta.2']), '1.0.0-beta.2');
eq('intersect-open', witness(['>=1.0.0', '>=2.0.0']), '2.0.0');

// bump
eq('bump-patch', bumpVersion('1.0.0', 'patch'), '1.0.1');
eq('bump-minor', bumpVersion('1.2.3', 'minor'), '1.3.0');
eq('bump-major', bumpVersion('1.2.3', 'major'), '2.0.0');
eq('bump-pre-patch', bumpVersion('1.0.0-beta.2', 'patch'), '1.0.0-beta.3');
eq('bump-pre-grad', bumpVersion('1.0.0-beta.2', 'minor'), '1.0.0');

// 范围更新
eq('runtime-update', updateRange('^1.0.0', '2.0.0', 'runtime'), '^2.0.0');
eq('pre-pin-update', updateRange('1.0.0-beta.2', '1.0.0', 'runtime'), '^1.0.0');
eq('peer-update-union', updateRange('^1.0.0', '2.0.0', 'peer'), '^1.0.0 || ^2.0.0');
eq('derive-major', deriveLevel('1.0.0', '2.0.0'), 'major');
eq('derive-patch', deriveLevel('1.0.0-beta.2', '1.0.0'), 'patch');
});

