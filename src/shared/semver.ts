// Minimal semver engine: parse / compare / satisfies / range intersection /
// gap classification. Supports prereleases and the range shapes used in
// package.json files: caret, tilde, x-ranges, comparators joined with spaces
// ("AND"), || ("OR"), and hyphen ranges. No registry access anywhere.

import type {Level} from './types';

export type Version = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  build?: string;
};

export function parseVersion(input: string): Version | null {
  const raw = String(input ?? '').trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  const prerelease = m[4]
    ? m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  if (m[4]) {
    for (const part of m[4].split('.')) {
      if (!/^[0-9A-Za-z-]+$/.test(part)) return null;
      if (/^0\d+$/.test(part)) return null; // numeric ids must not lead with zero
    }
  }
  return {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease, build: m[5]};
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

function compareIdent(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1; // numeric identifiers have lower precedence
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: Version | string, b: Version | string): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error('invalid version in comparison');
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0;
  if (x.prerelease.length === 0) return 1; // no prerelease > prerelease
  if (y.prerelease.length === 0) return -1;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    if (i >= x.prerelease.length) return -1;
    if (i >= y.prerelease.length) return 1;
    const c = compareIdent(x.prerelease[i], y.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}

export type Comparator = {op: string; version: Version};
type ComparatorSet = Comparator[];

function v(major: number, minor: number, patch: number, prerelease: (string | number)[] = []): Version {
  return {major, minor, patch, prerelease};
}

function parsePartial(raw: string):
  | {major: number; minor: number | null; patch: number | null; pre: (string | number)[]}
  | null {
  const m = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  const minorTok = m[2];
  const patchTok = m[3];
  return {
    major: Number(m[1]),
    minor: minorTok === undefined || /^[xX*]$/.test(minorTok) ? null : Number(minorTok),
    patch: patchTok === undefined || /^[xX*]$/.test(patchTok) ? null : Number(patchTok),
    pre: m[4]?.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) ?? [],
  };
}

function parseCaret(raw: string): Comparator[] | null {
  const p = parsePartial(raw);
  if (!p) return null;
  if (p.minor === null) {
    // ^0 => 0.x ; ^2 => 2.x
    if (p.major === 0)
      return [{op: '>=', version: v(0, 0, 0, p.pre)}, {op: '<', version: v(1, 0, 0)}];
    return [
      {op: '>=', version: v(p.major, 0, 0, p.pre)},
      {op: '<', version: v(p.major + 1, 0, 0)},
    ];
  }
  const minor = p.minor;
  if (p.patch === null) {
    if (p.major === 0)
      return [{op: '>=', version: v(0, minor, 0, p.pre)}, {op: '<', version: v(0, minor + 1, 0)}];
    return [
      {op: '>=', version: v(p.major, minor, 0, p.pre)},
      {op: '<', version: v(p.major + 1, 0, 0)},
    ];
  }
  const patch = p.patch;
  const lower = v(p.major, minor, patch, p.pre);
  let upper: Version;
  if (p.major > 0) upper = v(p.major + 1, 0, 0);
  else if (minor > 0) upper = v(0, minor + 1, 0);
  else upper = v(0, 0, patch + 1);
  return [{op: '>=', version: lower}, {op: '<', version: upper}];
}

function parseTilde(raw: string): Comparator[] | null {
  const p = parsePartial(raw);
  if (!p) return null;
  const minor = p.minor ?? 0;
  const patch = p.patch ?? 0;
  const lower = v(p.major, minor, patch, p.pre);
  const upper = p.minor === null ? v(p.major + 1, 0, 0) : v(p.major, minor + 1, 0);
  return [{op: '>=', version: lower}, {op: '<', version: upper}];
}

function expandLower(raw: string, op: string): Comparator {
  const parts = raw.split('.').map((p) => Number(p));
  return {op, version: v(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0)};
}

function expandUpper(raw: string): Comparator {
  const dotted = raw.split('-')[0].split('.');
  const maj = Number(dotted[0]);
  const min = dotted[1];
  const pat = dotted[2];
  if (min === undefined) return {op: '<', version: v(maj + 1, 0, 0)};
  if (pat === undefined) return {op: '<', version: v(maj, Number(min) + 1, 0)};
  return {op: '<=', version: parseVersion(raw)!};
}

function parseComparator(token: string): Comparator[] | null {
  token = token.trim();
  if (token === '' || token === '*' || token === 'x' || token === 'X' || token === 'latest')
    return [];

  const hyphen = /^v?(\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\s+-\s+v?(\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/.exec(
    token,
  );
  if (hyphen) return [expandLower(hyphen[1], '>='), expandUpper(hyphen[2])];

  if (token[0] === '^') return parseCaret(token.slice(1));
  if (token[0] === '~') return parseTilde(token.slice(1));

  const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(
    token,
  );
  if (!m) return null;
  const op = m[1] ?? '=';
  const maj = Number(m[2]);
  const minTok = m[3];
  const patTok = m[4];
  const pre = m[5];
  const minorWild = minTok === undefined || minTok === 'x' || minTok === 'X' || minTok === '*';
  const patchWild =
    !minorWild && (patTok === undefined || patTok === 'x' || patTok === 'X' || patTok === '*');

  if (op !== '=' && (minorWild || patchWild)) return null;

  if (minorWild) {
    if (maj === 0) return [{op: '>=', version: v(0, 0, 0)}, {op: '<', version: v(1, 0, 0)}];
    return [{op: '>=', version: v(maj, 0, 0)}, {op: '<', version: v(maj + 1, 0, 0)}];
  }
  const minor = Number(minTok);
  if (patchWild) {
    if (maj === 0 && minor === 0)
      return [{op: '>=', version: v(0, 0, 0)}, {op: '<', version: v(0, 1, 0)}];
    if (maj === 0)
      return [{op: '>=', version: v(0, minor, 0)}, {op: '<', version: v(0, minor + 1, 0)}];
    return [{op: '>=', version: v(maj, minor, 0)}, {op: '<', version: v(maj, minor + 1, 0)}];
  }
  const patch = Number(patTok);
  const version = v(
    maj,
    minor,
    patch,
    pre?.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) ?? [],
  );
  return [{op, version}];
}

export type Range = {sets: ComparatorSet[]; raw: string};

/** Split on whitespace while keeping `a - b` hyphen expressions together. */
function tokenize(part: string): string[] {
  const words = part.trim().split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i + 1] === '-' && words[i + 2] !== undefined) {
      tokens.push(`${words[i]} - ${words[i + 2]}`);
      i += 2;
    } else {
      tokens.push(words[i]);
    }
  }
  return tokens.filter(Boolean);
}

export function parseRange(raw: string): Range | null {
  const text = String(raw ?? '').trim();
  if (text === '') return {sets: [[]], raw: text};
  const sets: ComparatorSet[] = [];
  for (const part of text.split('||')) {
    const comps: Comparator[] = [];
    let ok = true;
    for (const token of tokenize(part)) {
      const expanded = parseComparator(token);
      if (expanded === null) {
        ok = false;
        break;
      }
      comps.push(...expanded);
    }
    if (!ok) return null;
    sets.push(comps);
  }
  return {sets, raw: text};
}

function testComparator(ver: Version, c: Comparator): boolean {
  const cmp = compareVersions(ver, c.version);
  return c.op === '>'
    ? cmp > 0
    : c.op === '>='
      ? cmp >= 0
      : c.op === '<'
        ? cmp < 0
        : c.op === '<='
          ? cmp <= 0
          : cmp === 0;
}

function setSatisfies(ver: Version, set: ComparatorSet): boolean {
  if (!set.every((c) => testComparator(ver, c))) return false;
  if (ver.prerelease.length > 0) {
    // npm rule: prereleases only match when some comparator explicitly
    // names the same [major,minor,patch] tuple — checked once for the set,
    // after every numeric bound has matched.
    const optedIn = set.some(
      (comp) =>
        comp.version.prerelease.length > 0 &&
        comp.version.major === ver.major &&
        comp.version.minor === ver.minor &&
        comp.version.patch === ver.patch,
    );
    if (!optedIn) return false;
  }
  return true;
}

/** npm-style satisfaction, including the prerelease tuple rule. */
export function satisfies(version: Version | string, range: Range | string): boolean {
  const ver = typeof version === 'string' ? parseVersion(version) : version;
  const rng = typeof range === 'string' ? parseRange(range) : range;
  if (!ver || !rng) return false;
  return rng.sets.some((set) => setSatisfies(ver, set));
}

/** highest version in `versions` matching the range; null if none match */
export function maxSatisfying(versions: string[], range: Range | string): string | null {
  let best: {v: Version; raw: string} | null = null;
  for (const raw of versions) {
    const ver = parseVersion(raw);
    if (!ver) continue;
    if (!satisfies(ver, range)) continue;
    if (!best || compareVersions(ver, best.v) > 0) best = {v: ver, raw};
  }
  return best ? best.raw : null;
}

export function bump(version: string, level: Level, preTag?: string): string | null {
  const v0 = parseVersion(version);
  if (!v0) return null;
  let {major, minor, patch} = v0;
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  if (preTag) return `${major}.${minor}.${patch}-${preTag}.0`;
  return `${major}.${minor}.${patch}`;
}

/** promote a prerelease to its stable form (1.2.3-rc.2 -> 1.2.3) */
export function finalize(version: string): string | null {
  const v0 = parseVersion(version);
  if (!v0) return null;
  return `${v0.major}.${v0.minor}.${v0.patch}`;
}

/**
 * Distance from `from` to `to` along a release train:
 *  patch : same major.minor ; minor : same major ; major: major changed.
 */
export function levelGap(from: string, to: string): Level | null {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return null;
  if (compareVersions(b, a) <= 0) return null;
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

/**
 * Smallest standard caret/tilde range that admits `newVersion`, given the
 * previous declaration. Returns "in-range" when the declaration already
 * admits the target (caret eats compatible minor/patch moves).
 */
export function widenRange(
  oldRange: string,
  newVersion: string,
): {range: string; gap: Level | 'in-range'} {
  const target = parseVersion(newVersion)!;
  if (satisfies(target, oldRange)) return {range: oldRange, gap: 'in-range'};

  const trimmed = oldRange.trim();
  const anchor = extractAnchor(trimmed);
  const gap: Level = anchor ? (levelGap(anchor, newVersion) ?? 'patch') : 'patch';
  const pre = target.prerelease.length ? `-${target.prerelease.join('.')}` : '';
  const base = `${target.major}.${target.minor}.${target.patch}${pre}`;

  // Preserve explicit pin style ("1.2.3") — pinned deps move the pin.
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    return {range: newVersion, gap};
  }
  if (trimmed.startsWith('~')) {
    return {range: `~${base}`, gap};
  }
  // default: caret (covers ^ and compound ranges alike in the simulation)
  const caret =
    target.major > 0
      ? `^${base}`
      : target.minor > 0
        ? `^0.${target.minor}.${target.patch}${pre}`
        : `^0.0.${target.patch}${pre}`;
  return {range: caret, gap};
}

function extractAnchor(range: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?/.exec(range);
  return m ? m[0] : null;
}

/** Versions in the finite candidate universe accepted by both ranges. */
export function intersection(
  universe: string[],
  a: Range | string,
  b: Range | string,
): string[] {
  return universe.filter((ver) => satisfies(ver, a) && satisfies(ver, b));
}

/** True when no candidate version (within the universe) satisfies both. */
export function isMutexPair(universe: string[], a: string, b: string): boolean {
  return intersection(universe, a, b).length === 0;
}

export function format(ver: Version): string {
  const pre = ver.prerelease.length ? `-${ver.prerelease.join('.')}` : '';
  return `${ver.major}.${ver.minor}.${ver.patch}${pre}`;
}
