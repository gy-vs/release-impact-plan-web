import {describe, expect, it} from 'vitest';
import {
  bump,
  compareVersions,
  intersection,
  levelGap,
  parseRange,
  satisfies,
  widenRange,
} from '../src/shared/semver';

describe('semver', () => {
  it('compares prerelease precedence', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('parses caret/tilde/x-ranges and hyphens', () => {
    expect(satisfies('1.4.9', '^1.4.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.4.0')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    // 0.0.x caret pins the patch tuple exactly
    expect(satisfies('0.0.2', '^0.0.2')).toBe(true);
    expect(satisfies('0.0.3', '^0.0.2')).toBe(false);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('1.4.2', '1.2.0 - 1.4.5')).toBe(true);
    expect(satisfies('1.4.6', '1.2.0 - 1.4.5')).toBe(false);
    expect(satisfies('18.2.0', '^17.0.0 || ^18.0.0')).toBe(true);
    expect(satisfies('17.9.0', '^17.0.0 || ^18.0.0')).toBe(true);
    expect(satisfies('19.0.0', '^17.0.0 || ^18.0.0')).toBe(false);
  });

  it('applies the npm prerelease tuple rule', () => {
    expect(satisfies('0.2.0-beta.4', '^0.2.0-beta.1')).toBe(true);
    expect(satisfies('0.2.0-beta.4', '^0.2.0')).toBe(false);
    // npm prerelease rule: a comparator set admits prereleases only of the
    // exact tuple it explicitly names.
    expect(satisfies('1.0.0-rc.1', '>=1.0.0-rc.1 <2.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>=1.0.0-rc.1 <2.0.0')).toBe(true);
    expect(satisfies('1.5.0-alpha', '>=1.0.0-rc.1 <2.0.0')).toBe(false);
    expect(satisfies('1.5.0-alpha', '^1.0.0')).toBe(false);
    expect(satisfies('0.2.0-beta.4', '0.2.0-beta.4')).toBe(true);
  });

  it('bumps and measures gaps', () => {
    expect(bump('1.2.3', 'patch')).toBe('1.2.4');
    expect(bump('1.2.3', 'minor')).toBe('1.3.0');
    expect(bump('1.2.3', 'major')).toBe('2.0.0');
    expect(levelGap('1.2.3', '1.2.4')).toBe('patch');
    expect(levelGap('1.2.3', '1.3.0')).toBe('minor');
    expect(levelGap('1.2.3', '2.0.0')).toBe('major');
  });

  it('widens ranges minimally and keeps prerelease anchors', () => {
    // caret absorbs compatible minor/patch moves: declaration unchanged
    expect(widenRange('^1.4.0', '1.4.3')).toEqual({range: '^1.4.0', gap: 'in-range'});
    expect(widenRange('^1.4.0', '1.5.0')).toEqual({range: '^1.4.0', gap: 'in-range'});
    expect(widenRange('^1.4.0', '2.0.0').range).toBe('^2.0.0');
    expect(widenRange('~1.2.0', '1.2.9')).toEqual({range: '~1.2.0', gap: 'in-range'});
    expect(widenRange('~1.2.0', '1.3.0').range).toBe('~1.3.0');
    expect(widenRange('1.2.3', '1.3.0')).toEqual({range: '1.3.0', gap: 'minor'});
    const w = widenRange('0.2.0-beta.2', '0.2.0-beta.4');
    expect(w.range).toBe('0.2.0-beta.4');
    expect(satisfies('0.2.0-beta.4', parseRange(w.range)!)).toBe(true);
  });

  it('detects empty intersections over a universe', () => {
    const universe = ['17.0.0', '17.9.0', '18.2.0'];
    expect(intersection(universe, '^17.0.0', '^18.0.0')).toEqual([]);
    expect(intersection(universe, '^17.0.0 || ^18.0.0', '^18.2.0')).toEqual(['18.2.0']);
  });
});
