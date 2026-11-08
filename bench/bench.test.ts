/**
 * Tests for benchmark harness helpers, ground truth, and kvx adapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mulberry32, deterministicSample, computeMetrics, percentile } from './sample.ts';
import { GroundTruth } from './ground-truth.ts';
import { KvxAdapter } from './adapters/kvx.ts';

test('sample.ts: mulberry32 produces deterministic sequences', () => {
  const rng1 = mulberry32(20261108);
  const rng2 = mulberry32(20261108);

  const seq1: number[] = [];
  const seq2: number[] = [];
  for (let i = 0; i < 50; i++) {
    seq1.push(rng1());
    seq2.push(rng2());
  }

  assert.deepEqual(seq1, seq2);

  // Different seed produces different numbers
  const rng3 = mulberry32(999999);
  assert.notEqual(rng1(), rng3());
});

test('sample.ts: deterministicSample is reproducible and respects sorting', () => {
  const items = ['delta', 'alpha', 'charlie', 'bravo', 'echo', 'foxtrot'];
  const s1 = deterministicSample(items, 3, (x) => x, 20261108);
  const s2 = deterministicSample(items, 3, (x) => x, 20261108);

  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 3);
});

test('sample.ts: computeMetrics handles precision, recall, and F1 cases', () => {
  // Perfect match
  const perfect = computeMetrics(['a', 'b'], ['a', 'b']);
  assert.equal(perfect.precision, 1.0);
  assert.equal(perfect.recall, 1.0);
  assert.equal(perfect.f1, 1.0);

  // Completely disjoint
  const disjoint = computeMetrics(['a', 'b'], ['c', 'd']);
  assert.equal(disjoint.precision, 0.0);
  assert.equal(disjoint.recall, 0.0);
  assert.equal(disjoint.f1, 0.0);

  // Partial match
  const partial = computeMetrics(['a', 'b'], ['b', 'c']);
  assert.equal(partial.precision, 0.5);
  assert.equal(partial.recall, 0.5);
  assert.equal(partial.f1, 0.5);

  // Empty sets
  const empty = computeMetrics([], []);
  assert.equal(empty.precision, 1.0);
  assert.equal(empty.recall, 1.0);
  assert.equal(empty.f1, 1.0);

  // Empty prediction with non-empty ground truth
  const emptyPred = computeMetrics([], ['a']);
  assert.equal(emptyPred.precision, 0.0);
  assert.equal(emptyPred.recall, 0.0);
  assert.equal(emptyPred.f1, 0.0);
});

test('sample.ts: percentile computes correct values', () => {
  const vals = [10, 20, 30, 40, 50];
  assert.equal(percentile(vals, 50), 30);
  assert.equal(percentile(vals, 0), 10);
  assert.equal(percentile(vals, 100), 50);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([], 50), 0);
});

test('ground-truth.ts and kvx adapter on a tiny TS project', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-proj-'));

  try {
    const aContent = [
      'export function add(x: number, y: number): number {',
      '  return x + y;',
      '}',
      '',
      'export class K {',
      '  m(): string {',
      "    return 'hello';",
      '  }',
      '}',
      '',
    ].join('\n');

    const bContent = [
      "import { add, K } from './a.ts';",
      '',
      'const sum = add(1, 2);',
      'const inst = new K();',
      'const val = inst.m();',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tempDir, 'a.ts'), aContent, 'utf8');
    fs.writeFileSync(path.join(tempDir, 'b.ts'), bContent, 'utf8');

    // Test GroundTruth
    const gt = new GroundTruth(tempDir, ['.']);

    // 1. Declarations
    const declsA = gt.declarations('a.ts');
    assert.ok(declsA.length >= 3, `Expected at least 3 declarations in a.ts, got ${declsA.length}`);

    const addDecl = declsA.find((d) => d.name === 'add');
    assert.ok(addDecl, 'Function add not found in ground truth');
    assert.equal(addDecl.kind, 'function');
    assert.equal(addDecl.startLine, 1);
    assert.equal(addDecl.endLine, 3);
    assert.equal(addDecl.exported, true);

    const classKDecl = declsA.find((d) => d.name === 'K');
    assert.ok(classKDecl, 'Class K not found in ground truth');
    assert.equal(classKDecl.kind, 'class');
    assert.equal(classKDecl.startLine, 5);
    assert.equal(classKDecl.endLine, 9);
    assert.equal(classKDecl.exported, true);

    const methodMDecl = declsA.find((d) => d.qualified === 'K.m');
    assert.ok(methodMDecl, 'Method K.m not found in ground truth');
    assert.equal(methodMDecl.kind, 'method');
    assert.equal(methodMDecl.startLine, 6);
    assert.equal(methodMDecl.endLine, 8);

    // 2. References
    const addRefs = gt.references('a.ts', 'add', 1);
    assert.ok(addRefs.length >= 1, `Expected references to add, got ${addRefs.length}`);
    assert.ok(addRefs.some((r) => r.file === 'b.ts'), 'Reference to add in b.ts not found');

    const mRefs = gt.references('a.ts', 'm', 6);
    assert.ok(mRefs.length >= 1, `Expected references to K.m, got ${mRefs.length}`);
    assert.ok(mRefs.some((r) => r.file === 'b.ts'), 'Reference to K.m in b.ts not found');

    // 3. Importers
    const impsA = gt.importers('a.ts');
    assert.deepEqual(impsA, ['b.ts']);

    // Test KvxAdapter
    const kvx = new KvxAdapter(tempDir);
    try {
      // Outline
      const outlineA = kvx.outline('a.ts');
      assert.ok(outlineA.symbols.length >= 3, `Kvx outline should find declarations, got ${outlineA.symbols.length}`);
      assert.ok(outlineA.symbols.some((s) => s.name === 'add'));
      assert.ok(outlineA.symbols.some((s) => s.name === 'K'));
      assert.ok(outlineA.symbols.some((s) => s.name === 'm'));

      // Read Symbol
      const readAdd = kvx.readSymbol('a.ts', 'add');
      assert.ok(readAdd.match, 'Kvx should read symbol add');
      assert.equal(readAdd.match?.startLine, 1);
      assert.equal(readAdd.match?.endLine, 3);

      const readKm = kvx.readSymbol('a.ts', 'K.m');
      assert.ok(readKm.match, 'Kvx should read symbol K.m');
      assert.equal(readKm.match?.startLine, 6);
      assert.equal(readKm.match?.endLine, 8);

      // References
      const kvxRefs = kvx.references('a.ts', 'add');
      assert.ok(kvxRefs.ok, 'Kvx findReferences should succeed');
      assert.ok(kvxRefs.references.some((r) => r.relPath === 'b.ts'), 'Kvx should find reference in b.ts');
    } finally {
      kvx.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
