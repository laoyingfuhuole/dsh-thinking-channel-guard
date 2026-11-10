#!/usr/bin/env node
/**
 * Release integrity: hash every file this package publishes.
 *
 *   node scripts/integrity.mjs           write integrity.json
 *   node scripts/integrity.mjs --check   verify the tree still matches it
 *
 * The manifest is what a reviewer compares against a shipped tarball; it is
 * written from the same `files` list the package manager packs, so a file that
 * is not published cannot appear in it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'integrity.json');

/** Entries of the package `files` list that are always part of a release. */
const EXTRA = ['package.json', 'LICENSE'];

/** Whether a path is a directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Expand one `files` entry into sorted relative file paths. */
function expand(entry) {
  const absolute = join(ROOT, entry);
  if (!isDirectory(absolute)) return [entry];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const path = join(dir, name);
      if (isDirectory(path)) walk(path);
      else out.push(relative(ROOT, path).split('\\').join('/'));
    }
  };
  walk(absolute);
  return out;
}

/** SHA-256 of one file. */
function digest(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

/** Build the manifest object for the current tree. */
function collect() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const paths = new Set([...EXTRA, ...(pkg.files ?? []).flatMap(expand)]);
  paths.delete('integrity.json');
  const files = {};
  for (const path of [...paths].sort()) files[path] = digest(path);
  return { schema: 1, name: pkg.name, version: pkg.version, files };
}

const check = process.argv.includes('--check');
const current = collect();

if (!check) {
  writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  const count = Object.keys(current.files).length;
  console.log(`integrity.json written: ${current.name}@${current.version}, ${count} files`);
  process.exit(0);
}

let recorded;
try {
  recorded = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch {
  console.error('integrity.json missing; run `npm run integrity`');
  process.exit(1);
}

const problems = [];
if (recorded.name !== current.name) problems.push(`name: ${recorded.name} -> ${current.name}`);
if (recorded.version !== current.version) problems.push(`version: ${recorded.version} -> ${current.version}`);

for (const [path, hash] of Object.entries(recorded.files ?? {})) {
  if (!(path in current.files)) problems.push(`missing: ${path}`);
  else if (current.files[path] !== hash) problems.push(`changed: ${path}`);
}
for (const path of Object.keys(current.files)) {
  if (!(path in (recorded.files ?? {}))) problems.push(`added: ${path}`);
}

if (problems.length > 0) {
  console.error(`integrity check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`integrity ok: ${current.name}@${current.version}, ${Object.keys(current.files).length} files`);
