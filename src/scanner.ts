import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LogFn } from './types';

/**
 * Project scanner + module resolution.
 *
 * scanProject walks the codebase (respecting ignore patterns and
 * include overrides) and builds a normalized manifest of source files.
 * resolveModule turns import specifiers into concrete module paths using
 * Node/bundler-style resolution (relative paths, extension probing,
 * index files, node_modules lookup).
 */

export type ResolutionResult =
  | { status: 'internal'; path: string; resolved: string }
  | { status: 'external'; name: string }
  | { status: 'unresolved' };

export interface FileEntry {
  /** absolute path */
  abs: string;
  /** root-relative path using '/' separators */
  rel: string;
  size: number;
}

export interface ProjectManifest {
  rootDir: string;
  files: FileEntry[];
  fileCount: number;
}

export interface ScannerOptions {
  rootDir: string;
  ignorePatterns: string[];
  includeDirs: string[];
  log: LogFn;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const INDEX_NAMES = ['index', 'main'];

function toPosixSlash(p: string): string {
  return path.normalize(p).split(path.sep).join('/');
}

function normalizePattern(p: string): string {
  return toPosixSlash(p).replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

function normalizePatternToParts(p: string): string[] {
  const norm = normalizePattern(p);
  return norm.split('/').filter(Boolean);
}

/** True when a glob (per path segment, '*' and '**' supported) matches. */
export function globMatch(value: string, pattern: string): boolean {
  const valueParts = value.split('/');
  const patternParts = pattern.split('/').filter(Boolean);
  if (valueParts.length === 0 && patternParts.length === 0) return true;
  const memo = new Map<string, boolean>();

  const walk = (vi: number, pi: number): boolean => {
    const key = `${vi}/${pi}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res = false;
    if (vi < valueParts.length && pi < patternParts.length) {
      const part = patternParts[pi];
      if (part === '**') {
        res = walk(vi, pi + 1) || walk(vi + 1, pi);
      } else if (part === '*') {
        res = walk(vi, pi + 1) || (vi + 1 < valueParts.length && walk(vi + 1, pi + 1));
      } else {
        res = segmentMatch(valueParts[vi], part) && walk(vi + 1, pi + 1);
      }
    } else {
      res = vi === valueParts.length && pi === patternParts.length;
    }
    memo.set(key, res);
    return res;
  };

  return walk(0, 0);
}

function segmentMatch(value: string, pattern: string): boolean {
  if (value === pattern) return true;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+?^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(value);
}

/**
 * A file is included only if it is not ignored. Explicit includeDirs
 * (e.g. --include) bypass ignore patterns for those paths.
 */
export function shouldIgnore(
  rel: string,
  ignorePatterns: string[],
  includeDirs: string[],
): boolean {
  const norm = toPosixSlash(rel).toLowerCase();

  const included = includeDirs.some((d) => {
    const parts = normalizePatternToParts(d);
    if (parts.length === 0) return false;
    return globMatch(norm, parts.join('/'));
  });
  if (included) return false;

  for (const raw of ignorePatterns) {
    const pat = raw.endsWith('/') ? raw.slice(0, -1) + '/**' : raw;
    const parts = normalizePatternToParts(pat);
    if (parts.length === 0) continue;
    if (globMatch(norm, parts.join('/'))) return true;
  }
  return false;
}

export function scanProject(options: ScannerOptions): ProjectManifest {
  const { rootDir, ignorePatterns, includeDirs, log } = options;
  const files: FileEntry[] = [];
  const seen = new Set<string>();

  const walk = (abs: string): void => {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        log(`warn: cannot read directory ${abs}`);
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        walk(path.join(abs, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    const rel = toPosixSlash(path.relative(rootDir, abs));
    const segments = rel.split('/');
    if (segments.some((seg) => seg.startsWith('.'))) return;
    if (seen.has(rel)) return;
    if (shouldIgnore(rel, ignorePatterns, includeDirs)) return;
    seen.add(rel);
    files.push({ abs, rel, size: stat.size });
  };

  walk(rootDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { rootDir, files, fileCount: files.length };
}

function tryCandidateFile(abs: string): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = abs + ext;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  try {
    if (statSync(abs).isFile()) return abs;
  } catch {
    // fall through
  }
  return null;
}

function tryIndexFile(dir: string): string | null {
  for (const name of INDEX_NAMES) {
    const hit = tryCandidateFile(path.join(dir, name));
    if (hit) return hit;
  }
  return null;
}

function findPackageDir(pkgName: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const nodeModules = path.join(dir, 'node_modules', ...pkgName.split('/'));
    if (existsSync(path.join(nodeModules, 'package.json'))) return nodeModules;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve an import specifier to a concrete module the same way Node or a
 * bundler would:
 *  - relative/absolute → extension probing + index files
 *  - bare → node_modules package dir (+ subpath) or "external"
 */
export function resolveModule(
  specifier: string,
  fromDir: string,
  rootDir: string,
  log: LogFn,
): ResolutionResult {
  let spec = specifier;
  const q = spec.indexOf('?');
  if (q >= 0) spec = spec.slice(0, q);
  const hash = spec.indexOf('#');
  if (hash >= 0) spec = spec.slice(0, hash);
  spec = spec.trim();
  if (!spec) return { status: 'unresolved' };

  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const abs = path.isAbsolute(spec) ? path.normalize(spec) : path.resolve(fromDir, spec);
    const hit = tryCandidateFile(abs) ?? tryIndexFile(abs);
    if (!hit) return { status: 'unresolved' };
    let resolved = hit;
    try {
      const realRoot = realpathSync(rootDir);
      const realFile = realpathSync(hit);
      if (path.relative(realRoot, realFile).startsWith('..') || path.isAbsolute(path.relative(realRoot, realFile))) {
        log(`warn: import escaped project root: ${specifier}`);
        return { status: 'external', name: specifier };
      }
      resolved = hit;
    } catch {
      resolved = hit;
    }
    return { status: 'internal', path: toPosixSlash(path.relative(rootDir, resolved)), resolved };
  }

  const parts = spec.split('/');
  const isScoped = parts[0].startsWith('@');
  const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  const sub = isScoped ? parts.slice(2) : parts.slice(1);

  const pkgDir = findPackageDir(pkgName, fromDir);
  if (pkgDir) {
    const target = sub.length > 0 ? path.join(pkgDir, ...sub) : pkgDir;
    const hit = tryCandidateFile(target) ?? tryIndexFile(target);
    if (hit) {
      const rel = toPosixSlash(path.relative(rootDir, hit));
      if (!rel.startsWith('..')) {
        return { status: 'internal', path: rel, resolved: hit };
      }
    }
  }
  return { status: 'external', name: sub.length > 0 ? `${pkgName}/${sub.join('/')}` : pkgName };
}
