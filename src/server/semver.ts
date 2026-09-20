// 本地 semver 实现：仅服务于工作台模拟，不访问任何包仓库。
// 支持：^ ~ x-ranges、比较器、|| 联合、- 区间、预发布（按 npm 规则判断可满足性）。

import type {Level} from '../shared/model';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  build?: string;
}

interface Cmp {
  op: '' | '>' | '>=' | '<' | '<=';
  v: SemVer;
}

export interface Range {
  /** 外层 OR，内层 AND */
  alts: Cmp[][];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(input: string): SemVer | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(VERSION_RE);
  if (!m) return null;
  const pre = (m[4] ?? '').split('.').filter(Boolean).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  if (pre.some((t) => typeof t === 'number' && !Number.isSafeInteger(t))) return null;
  return {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: pre, build: m[5]};
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

export function format(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  const pre = v.prerelease.length ? `-${v.prerelease.join('.')}` : '';
  return core + pre;
}

// 数字标识小于字符串；预发布 < 同元组稳定版
export function compare(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const t = (x: SemVer): number[] => [x.major, x.minor, x.patch];
  const ta = t(a);
  const tb = t(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  if (a.prerelease.length && !b.prerelease.length) return -1;
  if (!a.prerelease.length && b.prerelease.length) return 1;
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && !yn) return -1;
    if (!xn && yn) return 1;
    if (xn && yn) {
      if (x !== y) return (x as number) < (y as number) ? -1 : 1;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

function cmpHold(op: Cmp['op'], c: -1 | 0 | 1): boolean {
  switch (op) {
    case '':
      return c === 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
  }
}

function partialTuple(tok: string): [number, number, number, number] | null {
  // 返回 [major, minor, patch, 完整度0-3]，x 位置记 -1
  const parts = tok.replace(/^v/, '').split('.');
  if (parts.length > 3) return null;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let depth = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '' || p === '*' || p === 'x' || p === 'X') {
      out[i] = -1;
    } else {
      if (!/^\d+$/.test(p)) return null;
      out[i] = Number(p);
      depth = i + 1;
    }
  }
  out[3] = depth;
  return out;
}

function sv(major: number, minor: number, patch: number, pre: ReadonlyArray<string | number> = []): SemVer {
  return {major, minor, patch, prerelease: pre};
}

function parseCmpToken(tok: string): Cmp[] {
  tok = tok.trim();
  if (tok === '' || tok === '*' || tok === 'x' || tok === 'X' || tok.toLowerCase() === 'latest') return [];
  const m = tok.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
  if (!m) return [];
  const op = (m[1] ?? '') as Cmp['op'] | '=' | '^' | '~';
  const rest = m[2].trim();
  // 取预发布后缀，并先从版本 token 中剥离，便于解析 [major.minor.patch]
  const preMatch = rest.match(/^(\d+(?:\.\d+){0,2})-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/);
  const core = preMatch ? preMatch[1] : rest;
  const pre = (preMatch?.[2] ?? '').split('.').filter(Boolean).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  const tup = partialTuple(core);
  if (!tup) return [];
  const [M, mm, pp, depth] = tup;
  const hasX = (i: number) => tup[i] === -1;
  if (op === '^' || (!op && depth < 3)) {
    // caret / 裸 partial（x-range）
    const base = sv(Math.max(M, 0), hasX(1) ? 0 : mm, hasX(2) ? 0 : pp, hasX(0) ? [] : pre);
    let upper: SemVer;
    if (base.major > 0 || hasX(0)) upper = sv(base.major + 1, 0, 0);
    else if (base.minor > 0 || hasX(1)) upper = sv(0, base.minor + 1, 0);
    else upper = sv(0, 0, base.patch + 1);
    return [
      {op: '>=', v: base},
      {op: '<', v: upper},
    ];
  }
  if (op === '~') {
    const base = sv(M, mm < 0 ? 0 : mm, pp < 0 ? 0 : pp, pre);
    const upper = mm < 0 ? sv(M + 1, 0, 0) : sv(M, mm + 1, 0);
    return [
      {op: '>=', v: base},
      {op: '<', v: upper},
    ];
  }
  if (op === '>=' || op === '>' || op === '<=' || op === '<') {
    // 部分版本按 npm 规则进位
    if (depth === 3) return [{op, v: sv(M, mm, pp, pre)}];
    if (depth === 2) {
      if (op === '>=') return [{op: '>=', v: sv(M, mm, 0, pre)}];
      if (op === '>') return [{op: '>=', v: sv(M, mm + 1, 0)}];
      if (op === '<') return [{op: '<', v: sv(M, mm, 0)}];
      return [{op: '<', v: sv(M, mm + 1, 0)}];
    }
    if (depth === 1) {
      if (op === '>=') return [{op: '>=', v: sv(M, 0, 0, pre)}];
      if (op === '>') return [{op: '>=', v: sv(M + 1, 0, 0)}];
      if (op === '<') return [{op: '<', v: sv(M, 0, 0)}];
      return [{op: '<', v: sv(M + 1, 0, 0)}];
    }
    return [];
  }
  // 精确（= 或无操作符的完整版本）
  return [{op: '', v: sv(M, mm, pp, pre)}];
}

export function parseRange(input: string | undefined | null): Range {
  const s = (input ?? '').trim();
  if (!s) return {alts: [[]]};
  const alts: Cmp[][] = [];
  for (const rawAlt of s.split('||')) {
    let alt = rawAlt.trim();
    if (!alt) continue;
    // a - b 区间
    const hy = alt.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hy) {
      const lo = parseCmpToken('>=' + hy[1]);
      const tup = partialTuple(hy[2]);
      let high: Cmp[];
      if (tup && tup[3] < 3) {
        const [M, m] = tup;
        high =
          tup[3] === 1
            ? [{op: '<', v: sv(Math.max(M, 0) + 1, 0, 0)}]
            : [{op: '<', v: sv(Math.max(M, 0), Math.max(m, 0) + 1, 0)}];
      } else {
        high = parseCmpToken('<=' + hy[2]);
      }
      alts.push([...lo, ...high]);
      continue;
    }
    const tokens = alt.split(/\s+/).filter(Boolean);
    const cmps: Cmp[] = [];
    for (const tok of tokens) cmps.push(...parseCmpToken(tok));
    alts.push(cmps);
  }
  if (alts.length === 0) alts.push([]);
  return {alts};
}

function altAccepts(alt: Cmp[], v: SemVer, allowPrerelease: boolean): boolean {
  let tupleAllowed = allowPrerelease;
  for (const c of alt) {
    if (c.v.prerelease.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch) {
      tupleAllowed = true;
    }
  }
  if (v.prerelease.length && !tupleAllowed) return false;
  return alt.every((c) => cmpHold(c.op, compare(v, c.v)));
}

/** npm 风格的 satisfies：预发布版本仅在范围显式引用同一 [M.m.p] 元组时才满足 */
export function satisfies(version: string | SemVer, range: string | Range, allowPrerelease = false): boolean {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return false;
  const r = typeof range === 'string' ? parseRange(range) : range;
  return r.alts.some((alt) => altAccepts(alt, v, allowPrerelease));
}

/** 求多个范围的交集是否存在；存在时返回一个见证版本 */
export function intersectionWitness(ranges: Array<string | Range>): SemVer | null {
  if (ranges.length === 0) return null;
  const parsed = ranges.map((r) => (typeof r === 'string' ? parseRange(r) : r));
  // 候选：所有比较器端点；半开区间交集若非空必含某个端点
  const candidates: SemVer[] = [];
  for (const r of parsed) {
    for (const alt of r.alts) {
      for (const c of alt) candidates.push(c.v);
    }
  }
  const seen = new Set<string>();
  const uniq: SemVer[] = [];
  for (const c of candidates) {
    const k = format(c);
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(c);
    }
  }
  uniq.sort(compare);
  // 枚举各范围 alt 的笛卡尔积；维度通常很小
  const choose: Cmp[][] = [];
  function search(i: number): SemVer | null {
    if (i === parsed.length) {
      // 在该 AND 组合内找见证：从所有下界的最大值开始
      let witness: SemVer | null = null;
      for (const alt of choose) {
        for (const c of alt) {
          if (c.op === '>=' || c.op === '>') {
            const floor = c.op === '>' ? sv(c.v.major, c.v.minor, c.v.patch + 1, c.v.prerelease) : c.v;
            if (!witness || compare(floor, witness) > 0) witness = floor;
          }
        }
      }
      const tries: SemVer[] = [];
      if (witness) tries.push(witness);
      for (const c of uniq) tries.push(c);
      for (const t of tries) {
        if (choose.every((alt) => altAccepts(alt, t, true))) return t;
      }
      return null;
    }
    for (const alt of parsed[i].alts) {
      choose.push(alt);
      const hit = search(i + 1);
      choose.pop();
      if (hit) return hit;
    }
    return null;
  }
  return search(0);
}

/** 升级版本；预发布版本在 minor/major 时毕业到稳定版 */
export function bumpVersion(input: string, level: Level): string {
  const v = parseVersion(input);
  if (!v) throw new Error(`bad version: ${input}`);
  if (v.prerelease.length) {
    if (level === 'patch') {
      // 预发布内推进：最后一段是数字则 +1，否则毕业为同元组稳定版
      const pre = [...v.prerelease];
      const last = pre[pre.length - 1];
      if (typeof last === 'number') {
        pre[pre.length - 1] = last + 1;
        return format({...v, prerelease: pre});
      }
      return format(sv(v.major, v.minor, v.patch));
    }
    // minor/major：预发布毕业到其对应的稳定元组（如 1.0.0-beta.2 -> 1.0.0）
    return format(sv(v.major, v.minor, v.patch));
  }
  if (level === 'patch') return format(sv(v.major, v.minor, v.patch + 1));
  if (level === 'minor') return format(sv(v.major, v.minor + 1, 0));
  return format(sv(v.major + 1, 0, 0));
}

export function isPrerelease(v: string): boolean {
  return (parseVersion(v)?.prerelease.length ?? 0) > 0;
}

/** 比较两个完整版本，得出所需最小升级级别；相同返回 null */
export function deriveLevel(fromStr: string, toStr: string): Level | null {
  const a = parseVersion(fromStr);
  const b = parseVersion(toStr);
  if (!a || !b) return null;
  const c = compare(a, b);
  if (c === 0) return null;
  if (c > 0) return null; // 降级不合法，由调用方另作校验
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

/** 最小的“下一个兼容范围”：普通依赖用 caret，预发布用精确钉版 */
export function caretRange(vStr: string): string {
  const v = parseVersion(vStr);
  if (!v) throw new Error(`bad version: ${vStr}`);
  if (v.prerelease.length) return format(v);
  return `^${v.major}.${v.minor}.${v.patch}`;
}

/**
 * 生成新的声明范围。
 * - runtime/optional：最小提升到兼容新版本的 caret 范围（预发布钉版）。
 * - peer：保留旧范围并并上新兼容范围（旧消费者仍需被支持），相邻重复做化简。
 */
export function updateRange(oldRange: string, newVersion: string, kind: 'runtime' | 'optional' | 'peer'): string {
  const next = caretRange(newVersion);
  if (kind !== 'peer') return next;
  const old = oldRange.trim();
  if (!old || old === '*') return next;
  const oldAlts = old
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>();
  const ordered: string[] = [];
  for (const a of [...oldAlts, next]) {
    if (!set.has(a)) {
      set.add(a);
      ordered.push(a);
    }
  }
  return ordered.join(' || ');
}

export function rangeEndpoints(range: string): SemVer[] {
  return parseRange(range).alts.flat().map((c) => c.v);
}
