import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ScannedFile, SupportedLanguage } from '../src/core/types.ts'
import { initTreeSitter, treeSitterExtract, treeSitterStatus } from '../src/parser/treesitter.ts'
import { extractorVersion } from '../src/parser/extractor.ts'
import { moduleHintToPath } from '../src/storage/shard.ts'
import { KaxcavVortexEngine } from '../src/engine.ts'

// node --test runs every file in its own process: loading tree-sitter here does not change
// the built-in (fallback) extraction exercised by the other suites.

let available = false
before(async () => {
  available = (await initTreeSitter()).ready
})

function scanned(relPath: string, lang: SupportedLanguage, content: string): ScannedFile {
  return { absPath: relPath, relPath, contentHash: 'h', mtimeMs: 0, byteSize: content.length, lang, content, tokenEstimate: 1 }
}
function outline(relPath: string, lang: SupportedLanguage, content: string): string[] {
  const res = treeSitterExtract(scanned(relPath, lang, content))
  assert.ok(res, `tree-sitter handled ${lang}`)
  return res.symbols.map((s) => `${s.kind} ${s.qualifiedName.split('#')[1]} L${s.startLine}-${s.endLine}${s.exported ? '' : ' (priv)'}`)
}

describe('module hints -> paths (no tree-sitter needed)', () => {
  it('maps the import syntaxes of each language', () => {
    assert.equal(moduleHintToPath('com.acme.billing.Invoice'), 'com/acme/billing/invoice')
    assert.equal(moduleHintToPath('crate::db::pool'), 'db/pool')
    assert.equal(moduleHintToPath('App\\Models\\User'), 'app/models/user')
    assert.equal(moduleHintToPath('github.com/org/repo/pkg/util'), 'github.com/org/repo/pkg/util')
    assert.equal(moduleHintToPath('include/net/socket.h'), 'include/net/socket')
    assert.equal(moduleHintToPath('com.acme.*'), 'com/acme')
    assert.equal(moduleHintToPath('System'), null)
    assert.equal(moduleHintToPath('./local'), null)
  })
})

describe('tree-sitter (optional WASM layer)', () => {
  it('reports why it is off, or which languages it covers', (t) => {
    const st = treeSitterStatus()
    if (!available) {
      assert.match(st.reason ?? '', /tree-sitter|KVX_TREE_SITTER/)
      t.skip(treeSitterStatus().reason ?? 'tree-sitter off')
      return
    }
    for (const lang of ['python', 'go', 'java', 'csharp', 'cpp', 'rust', 'ruby', 'php', 'bash', 'powershell']) {
      assert.ok(st.languages.includes(lang), lang)
    }
    assert.match(extractorVersion(), /\+tsw/)
  })

  it('declarations, members, ranges and visibility in 10 languages', (t) => {
    if (!available) return t.skip(treeSitterStatus().reason ?? 'tree-sitter off')
    assert.deepEqual(
      outline('A.java', 'java', 'package a;\npublic class Foo {\n  private int x = 1;\n  public int sum(int a) {\n    return helper(a);\n  }\n}\n'),
      ['class Foo L2-7', 'property Foo.x L3-3 (priv)', 'method Foo.sum L4-6'],
    )
    assert.deepEqual(
      outline('S.cs', 'csharp', 'namespace App.Core {\n  public class Svc {\n    public int Run(string s) { return 1; }\n  }\n}\n'),
      ['namespace App.Core L1-5', 'class Svc L2-4', 'method Svc.Run L3-3'],
    )
    assert.deepEqual(
      outline('m.go', 'go', 'package m\ntype Server struct{}\nfunc (s *Server) Start() error {\n  return nil\n}\nfunc helper() {}\n'),
      ['class Server L2-2', 'method Server.Start L3-5', 'function helper L6-6 (priv)'],
    )
    assert.deepEqual(
      outline('lib.rs', 'rust', 'pub struct Point { x: i32 }\nimpl Point {\n  pub fn new() -> Self { todo!() }\n  fn len(&self) -> i32 { 0 }\n}\n'),
      ['class Point L1-1', 'method Point.new L3-3', 'method Point.len L4-4 (priv)'],
    )
    assert.deepEqual(
      outline('m.py', 'python', '@app.get("/x")\ndef top():\n    """Doc."""\n    def inner():\n        return 1\n    return inner()\n\nclass A:\n    def run(self):\n        return 1\n'),
      ['function top L1-6', 'function inner L4-5 (priv)', 'class A L8-10', 'method A.run L9-10'],
    )
    assert.deepEqual(outline('b.rb', 'ruby', 'module Billing\n  class Invoice\n    def total\n      1\n    end\n  end\nend\n'), [
      'namespace Billing L1-7',
      'class Invoice L2-6',
      'method Invoice.total L3-5',
    ])
    assert.deepEqual(outline('o.php', 'php', '<?php\nclass Order {\n  private $x;\n  public function total() { return 1; }\n}\n'), [
      'class Order L2-5',
      'property Order.x L3-3 (priv)',
      'method Order.total L4-4',
    ])
    assert.deepEqual(outline('w.cpp', 'cpp', 'namespace ns {\nclass W {\n  int size() const { return 0; }\n};\nint W::compute(int a) { return a; }\n}\n'), [
      'namespace ns L1-6',
      'class W L2-4',
      'method W.size L3-3',
      'method W.compute L5-5',
    ])
    assert.deepEqual(outline('d.sh', 'bash', '#!/bin/bash\ndeploy() {\n  make\n}\n'), ['function deploy L2-4'])
    assert.deepEqual(outline('t.ps1', 'powershell', 'function Get-Thing {\n  Write-Output 1\n}\n'), ['function Get-Thing L1-3'])
  })

  it('docs per language syntax: no shebang/#include as doc, Python docstring', (t) => {
    if (!available) return t.skip(treeSitterStatus().reason ?? 'tree-sitter off')
    const doc = (rel: string, lang: SupportedLanguage, src: string) =>
      treeSitterExtract(scanned(rel, lang, src))!.symbols.map((s) => `${s.name}=${s.docSummary}`)
    assert.deepEqual(doc('a.cpp', 'cpp', '#include <x>\nint main() { return 0; }\n'), ['main='])
    assert.deepEqual(doc('d.sh', 'bash', '#!/bin/bash\n# Deploys it.\ndeploy() { make; }\n'), ['deploy=Deploys it.'])
    assert.deepEqual(doc('A.java', 'java', '/** Sums. */\nclass A {}\n'), ['A=Sums.'])
    assert.deepEqual(doc('m.py', 'python', 'def f():\n    """First line.\n\n    More."""\n    return 1\n'), ['f=First line.'])
    assert.deepEqual(doc('l.rs', 'rust', '/// Point doc\n#[derive(Debug)]\npub struct P;\n'), ['P=Point doc'])
  })

  it('engine: Java/Rust symbols readable, module imports drive affected, Python routes kept', (t) => {
    if (!available) return t.skip(treeSitterStatus().reason ?? 'tree-sitter off')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-tsw-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-tsw-home-'))
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), content)
    }
    write('src/main/java/com/acme/billing/Invoice.java', 'package com.acme.billing;\npublic class Invoice {\n  public int total() { return 1; }\n}\n')
    write('src/test/java/com/acme/billing/InvoiceTest.java', 'package com.acme.billing;\nimport com.acme.billing.Invoice;\nclass InvoiceTest {\n  void t() { new Invoice().total(); }\n}\n')
    write('src/db/pool.rs', 'pub fn open() {}\n')
    write('src/main.rs', 'use crate::db::pool;\nfn main() { pool::open(); }\n')
    write('api/app.py', 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.post("/login")\ndef login():\n    return 1\n')
    const engine = new KaxcavVortexEngine(home)
    try {
      engine.addRepo(repo)
      assert.deepEqual(engine.readSymbol(repo, 'Invoice.total').map((s) => s.qualifiedName), [
        'src/main/java/com/acme/billing/Invoice.java#Invoice.total',
      ])
      assert.deepEqual(engine.affected(repo, ['src/main/java/com/acme/billing/Invoice.java']), [
        'src/test/java/com/acme/billing/InvoiceTest.java',
      ])
      const outlineRs = engine.fileOutline(repo, 'src/db/pool.rs')
      assert.ok(outlineRs.symbols.some((s) => s.name === 'open'))
      const health = engine.status([repo]).shards[0]
      assert.match(health.extractorVersion ?? '', /\+tsw/)
      assert.ok(health.routeCount >= 1, 'FastAPI route kept by the tree-sitter path')
      assert.ok(engine.status().parsers?.treeSitter.ready)
    } finally {
      engine.close()
      for (const d of [repo, home]) {
        try {
          fs.rmSync(d, { recursive: true, force: true })
        } catch {
          // sqlite may still hold the file on Windows
        }
      }
    }
  })
})
