import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { KvxIgnoreError } from '../src/core/kvxignore.ts'
import { applyLineEdit } from '../src/edit/symbol-editor.ts'
import { initTreeSitter } from '../src/parser/treesitter.ts'
import { RepositoryShard } from '../src/storage/shard.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'

let treeSitter = false
before(async () => {
  treeSitter = (await initTreeSitter()).ready
})

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}
function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // SQLite may still hold a file on Windows
    }
  }
}
function withRepo(files: Record<string, string>, fn: (repo: string, engine: KaxcavVortexEngine, home: string) => void): void {
  const repo = tmp('kvx-edit-')
  const home = tmp('kvx-edit-home-')
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content)
  const engine = new KaxcavVortexEngine(home)
  try {
    engine.addRepo(repo)
    fn(repo, engine, home)
  } finally {
    engine.close()
    cleanup(repo, home)
  }
}

const SVC = [
  '﻿export class Svc {',
  '  keep(): number {',
  '    return 1',
  '  }',
  '',
  '  run(x: number): number {',
  '    return x + 1',
  '  }',
  '}',
  '',
  'export function helper(a: number): number {',
  '  return a',
  '}',
  '',
].join('\r\n')

describe('applyLineEdit', () => {
  it('keeps BOM, CRLF and the trailing newline; reports the new range', () => {
    const r = applyLineEdit('﻿a\r\nb\r\nc\r\n', 2, 2, 'replace', 'x\ny')
    assert.equal(r.content, '﻿a\r\nx\r\ny\r\nc\r\n')
    assert.deepEqual([r.newStart, r.newEnd, r.linesRemoved, r.linesAdded], [2, 3, 1, 2])
    assert.equal(applyLineEdit('a\nb\nc', 2, 2, 'delete').content, 'a\nc')
    assert.equal(applyLineEdit('a\nb\n', 2, 2, 'insert_after', 'z').content, 'a\nb\nz\n')
    assert.equal(applyLineEdit('a\nb\n', 1, 1, 'insert_before', 'z\n').content, 'z\na\nb\n')
  })
})

describe('edit_symbol', () => {
  it('replaces a method by Class.member, keeps BOM/CRLF, reindexes and returns the new hash', () => {
    withRepo({ 'src/svc.ts': SVC }, (repo, engine) => {
      const [read] = engine.readSymbol(repo, 'Svc.run')
      const res = engine.editSymbol(repo, {
        symbol: 'Svc.run',
        op: 'replace',
        text: '  run(x: number): number {\n    return x * 2\n  }',
        expectedHash: read.hash,
      })
      assert.equal(res.ok, true, res.reason)
      const disk = fs.readFileSync(path.join(repo, 'src', 'svc.ts'), 'utf8')
      assert.ok(disk.startsWith('﻿'), 'BOM kept')
      assert.ok(disk.includes('    return x * 2\r\n'), 'CRLF kept')
      assert.ok(!/[^\r]\n/.test(disk), 'no bare LF introduced')
      const [now] = engine.readSymbol(repo, 'Svc.run')
      assert.match(now.sliceText, /x \* 2/)
      assert.equal(res.after?.hash, now.hash)
      assert.notEqual(now.hash, read.hash)
    })
  })

  it('stale expected_hash, ambiguity and unknown symbols are refused without writing', () => {
    withRepo({ 'a/util.ts': 'export function same() {\n  return 1\n}\n', 'b/util.ts': 'export function same() {\n  return 2\n}\n' }, (repo, engine) => {
      const amb = engine.editSymbol(repo, { symbol: 'same', op: 'delete' })
      assert.equal(amb.ok, false)
      assert.deepEqual(amb.candidates?.sort(), ['a/util.ts#same', 'b/util.ts#same'])
      const stale = engine.editSymbol(repo, { symbol: 'a/util.ts#same', op: 'delete', expectedHash: 'deadbeef' })
      assert.equal(stale.ok, false)
      assert.match(stale.reason ?? '', /mudou desde a leitura/)
      assert.ok(fs.readFileSync(path.join(repo, 'a', 'util.ts'), 'utf8').includes('same'), 'nothing written')
      const del = engine.editSymbol(repo, { symbol: 'a/util.ts#same', op: 'delete' })
      assert.equal(del.ok, true, del.reason)
      assert.equal(fs.readFileSync(path.join(repo, 'a', 'util.ts'), 'utf8'), '')
      assert.equal(engine.editSymbol(repo, { symbol: 'nope', op: 'delete' }).ok, false)
      assert.equal(engine.editSymbol(repo, { symbol: 'b/util.ts#same', op: 'replace' }).ok, false, 'replace without text')
    })
  })

  it('insert_after and dry_run (preview only)', () => {
    withRepo({ 'src/svc.ts': SVC }, (repo, engine) => {
      const file = path.join(repo, 'src', 'svc.ts')
      const original = fs.readFileSync(file, 'utf8')
      const dry = engine.editSymbol(repo, { symbol: 'helper', op: 'insert_after', text: '\nexport function extra(): void {}', dryRun: true })
      assert.equal(dry.ok, true, dry.reason)
      assert.match(dry.preview ?? '', /export function extra/)
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'dry run writes nothing')
      const ins = engine.editSymbol(repo, { symbol: 'helper', op: 'insert_after', text: '\nexport function extra(): void {}' })
      assert.equal(ins.ok, true, ins.reason)
      assert.equal(engine.readSymbol(repo, 'extra').length, 1)
    })
  })

  it('.kvxignore blocks edits', () => {
    withRepo({ 'src/ok.ts': 'export const a = 1\n', 'secret/x.ts': 'export function x() {\n  return 1\n}\n' }, (repo, engine) => {
      write(repo, '.kvxignore', 'secret/\n')
      assert.throws(() => engine.editSymbol(repo, { symbol: 'secret/x.ts#x', op: 'delete' }), KvxIgnoreError)
      assert.ok(fs.readFileSync(path.join(repo, 'secret', 'x.ts'), 'utf8').includes('function x'))
    })
  })

  it('locks: frozen blocks any change, allow_body_only blocks signature changes; other symbols stay editable', () => {
    withRepo({ 'src/svc.ts': SVC }, (repo, engine) => {
      assert.equal(engine.lockSymbols(repo, [{ qualifiedName: 'Svc.keep', relPath: 'src/svc.ts', mode: 'frozen' }]), 1)
      assert.equal(engine.lockSymbols(repo, [{ qualifiedName: 'helper', relPath: 'src/svc.ts', mode: 'allow_body_only' }]), 1)
      const frozen = engine.editSymbol(repo, { symbol: 'Svc.keep', op: 'replace', text: '  keep(): number {\n    return 2\n  }' })
      assert.equal(frozen.ok, false)
      assert.equal(frozen.violations?.[0]?.qualifiedName, 'Svc.keep')
      const body = engine.editSymbol(repo, { symbol: 'helper', op: 'replace', text: 'export function helper(a: number): number {\n  return a + 0\n}' })
      assert.equal(body.ok, true, body.reason)
      const sig = engine.editSymbol(repo, { symbol: 'helper', op: 'replace', text: 'export function helper(a: number, b = 0): number {\n  return a + b\n}' })
      assert.equal(sig.ok, false)
      assert.match(sig.violations?.[0]?.violation ?? '', /assinatura/)
      const other = engine.editSymbol(repo, { symbol: 'Svc.run', op: 'replace', text: '  run(x: number): number {\n    return x\n  }' })
      assert.equal(other.ok, true, other.reason)
      assert.deepEqual(engine.verifySymbolLocks(repo), [])
      assert.equal(engine.unlockSymbols(repo), 2)
    })
  })

  it('locks recorded by the Fábrica in a v4 shard are respected', () => {
    withRepo({ 'src/svc.ts': SVC }, (repo, engine, home) => {
      const shardRepo = engine.getOrOpenShard(repo).repositoryPath
      const legacy = new DatabaseSync(path.join(home, 'shards', RepositoryShard.shardFileName(shardRepo, 4)))
      legacy.exec(
        `CREATE TABLE symbol_locks (qualified_name TEXT PRIMARY KEY, rel_path TEXT NOT NULL, lock_mode TEXT NOT NULL,
           baseline_signature TEXT NOT NULL, baseline_body_hash TEXT NOT NULL, locked_at TEXT NOT NULL);
         INSERT INTO symbol_locks VALUES ('src/svc.ts#helper', 'src/svc.ts', 'frozen', '', '', '2026-11-08');`,
      )
      legacy.close()
      const res = engine.editSymbol(repo, { symbol: 'helper', op: 'delete' })
      assert.equal(res.ok, false)
      assert.equal(res.violations?.[0]?.source, 'fabrica-v4')
    })
  })

  it('refuses edits that add syntax errors (tree-sitter), unless allowed', (t) => {
    if (!treeSitter) return t.skip('tree-sitter off')
    withRepo({ 'src/svc.ts': SVC, 'py/m.py': 'def f(x):\n    return x\n' }, (repo, engine) => {
      const broken = engine.editSymbol(repo, { symbol: 'helper', op: 'replace', text: 'export function helper(a: number {\n  return a\n}' })
      assert.equal(broken.ok, false)
      assert.match(broken.reason ?? '', /erro\(s\) de sintaxe/)
      const py = engine.editSymbol(repo, { symbol: 'f', op: 'replace', text: 'def f(x)\n    return x\n' })
      assert.equal(py.ok, false)
      const allowed = engine.editSymbol(repo, { symbol: 'f', op: 'replace', text: 'def f(x)\n    return x\n', allowSyntaxErrors: true })
      assert.equal(allowed.ok, true, allowed.reason)
    })
  })

  it('MCP: edit_symbol only on the full server; refusals are isError', () => {
    withRepo({ 'src/svc.ts': SVC }, (repo, engine) => {
      const full = new VortexMcpServer(engine, () => {})
      const ro = new VortexMcpServer(engine, () => {}, { readOnly: true })
      const names = (srv: VortexMcpServer) =>
        (srv.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)
      assert.ok(names(full).includes('edit_symbol'))
      assert.ok(!names(ro).includes('edit_symbol'))
      const call = (srv: VortexMcpServer, args: Record<string, unknown>) =>
        srv.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_symbol', arguments: { repo, ...args } } }) as {
          result?: { isError?: boolean; content: Array<{ text: string }> }
          error?: { message: string }
        }
      assert.match(call(ro, { symbol: 'helper', op: 'delete' }).error?.message ?? '', /só de leitura/)
      assert.equal(call(full, { symbol: 'nope', op: 'delete' }).result?.isError, true)
      const dry = call(full, { symbol: 'helper', op: 'delete', dry_run: 'true' })
      assert.equal(dry.result?.isError, undefined)
      assert.equal(JSON.parse(dry.result!.content[0].text).dryRun, true)
      assert.ok(fs.readFileSync(path.join(repo, 'src', 'svc.ts'), 'utf8').includes('helper'), 'dry_run as string still does not write')
    })
  })
})
