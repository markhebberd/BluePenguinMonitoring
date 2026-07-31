#!/usr/bin/env node
/**
 * Keeps the admin page's plain-English explanation of the breeding-detection
 * (family composition) algorithm honest.
 *
 * The explanation (wildwatch_web/wildwatch/src/components/AlgorithmDoc.tsx) is written
 * by hand — no generator can turn scoring rules into prose a monitor can read. What can
 * be enforced is that nobody changes the *algorithm* without re-reading the explanation
 * afterwards. This script fingerprints the exact source regions the explanation
 * describes; if any of them changed since the doc was last reviewed, the check fails.
 *
 * Numbers are handled separately and need no review: every tunable value lives in
 * src/breedingConstants.ts, which the doc imports and quotes, so a changed offset
 * updates the page by itself. (That file is fingerprinted anyway — a NEW constant, or
 * one whose meaning changed, does need prose.)
 *
 * Run by the deploy workflow (.github/workflows/deploy-wildwatch.yml): drift fails the
 * check job and the deploy never triggers.
 *
 * Usage:
 *   node scripts/check-algorithm-doc.mjs           # check; exit 1 on drift
 *   node scripts/check-algorithm-doc.mjs --update  # re-read the doc, then stamp it current
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const SRC = join(ROOT, 'wildwatch_web/wildwatch/src');
const STAMP = join(SRC, 'algorithmFingerprint.ts');

/**
 * The source the explanation claims to describe. Each entry is one top-level
 * declaration (its leading doc comment included) or a whole file.
 * Adding a new piece of algorithm? Add it here, or it goes undocumented silently.
 */
const REGIONS = [
  { file: 'breedingConstants.ts', whole: true },
  // The algorithm proper — one implementation, shared by the SPA and (bundled for node,
  // via breedingCli.ts) reports.php. Whole file: everything in it is algorithm.
  { file: 'breeding.ts', whole: true },
  // What a monitor actually reads off an observation. The algorithm decides when an attempt
  // is post-guard; these decide what the badge says about it, so a change here can make the
  // explanation untrue just as surely as a change to the rule itself.
  { file: 'App.tsx', name: 'displayStatus' },
  { file: 'App.tsx', name: 'isPostGuard' },
  { file: 'App.tsx', name: 'displayStatusOrPrev' },
  { file: 'App.tsx', name: 'seasonOutcome' },
  { file: 'App.tsx', name: 'BoxSighting', kind: 'interface' },
  { file: 'App.tsx', name: 'boxSightings' },
  { file: 'App.tsx', name: 'detectClutchPair' },
  { file: 'App.tsx', name: 'guessedSex' },
  { file: 'App.tsx', name: 'hasClutchPredictions' },
  { file: 'App.tsx', name: 'ClutchPredictions' },
  { file: 'App.tsx', name: 'BoxFamily', kind: 'interface' },
  { file: 'App.tsx', name: 'computeBoxFamilies' },
  { file: 'App.tsx', name: 'detectedPair' },
  { file: 'App.tsx', name: 'computeClutchVerify' },
  { file: 'api/localdb.ts', name: 'observedSexGuess' },
];

const fileCache = new Map();
const lines = (f) => {
  if (!fileCache.has(f)) fileCache.set(f, readFileSync(join(SRC, f), 'utf8').split('\n'));
  return fileCache.get(f);
};

/** A comment line directly above a declaration is part of it — prose there describes behaviour. */
const isComment = (l) => /^\s*(\/\*\*|\*|\/\/|\*\/)/.test(l);

/**
 * Pull one top-level declaration out of a file: from its leading comment block down to
 * the closing brace in column 0. Everything in this codebase's algorithm is declared at
 * top level, so that brace is unambiguous.
 */
function extract(region) {
  const src = lines(region.file);
  if (region.whole) return src.join('\n');
  const kind = region.kind || 'function';
  const head = kind === 'interface'
    ? new RegExp(`^(export )?interface ${region.name}\\b`)
    : new RegExp(`^(export )?function ${region.name}\\b`);
  const start = src.findIndex((l) => head.test(l));
  if (start < 0) throw new Error(`${region.file}: ${kind} ${region.name} not found — was it renamed or removed? Update REGIONS in this script.`);
  let from = start;
  while (from > 0 && isComment(src[from - 1])) from--;
  let end = start;
  while (end < src.length && src[end] !== '}') end++;
  if (end >= src.length) throw new Error(`${region.file}: no closing brace in column 0 for ${region.name}`);
  return src.slice(from, end + 1).join('\n');
}

function fingerprint() {
  const h = createHash('sha256');
  for (const r of REGIONS) h.update(`--- ${r.file}::${r.name || '*'}\n${extract(r)}\n`);
  return h.digest('hex').slice(0, 16);
}

let actual;
try {
  actual = fingerprint();
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

const stampSrc = readFileSync(STAMP, 'utf8');
const recorded = stampSrc.match(/fingerprint:\s*'([0-9a-f]+)'/)?.[1];

if (process.argv.includes('--update')) {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(STAMP, stampSrc
    .replace(/fingerprint:\s*'[0-9a-f]*'/, `fingerprint: '${actual}'`)
    .replace(/reviewed:\s*'[0-9-]*'/, `reviewed: '${today}'`));
  console.log(`✓ Algorithm explanation stamped current (${actual}, reviewed ${today}).`);
  process.exit(0);
}

if (recorded === actual) process.exit(0);

console.error('✗ The breeding-detection algorithm changed, but the explanation on the admin');
console.error("  page's Algorithm tab has not been re-reviewed.");
console.error('');
console.error(`    recorded: ${recorded || '(none)'}`);
console.error(`    actual:   ${actual}`);
console.error('');
console.error('  Read the changed code against the explanation:');
console.error('    src/components/AlgorithmDoc.tsx   ← the prose monitors read');
console.error('    src/breedingConstants.ts          ← numbers; quoted automatically, never restate them');
console.error('');
console.error('  Fix anything the change made untrue, then stamp it current:');
console.error('    node scripts/check-algorithm-doc.mjs --update');
console.error('');
console.error('  Nothing to change (a rename, a comment tidy)? Stamping is still required —');
console.error("  it records that a human looked. Don't skip it; that's the whole mechanism.");
process.exit(1);
