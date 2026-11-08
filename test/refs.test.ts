import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { blankNonCode, blankHashComments, collectTextRefs } from '../src/parser/refs.ts'
import { initTreeSitter } from '../src/parser/treesitter.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'

let treeSitter = false
before(async () => {
  treeSitter = (await initTreeSitter()).ready
})

function withRepo(files: Record<string, string>, fn: (repo: string, engine: KaxcavVortexEngine) => void): void {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-refs-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-refs-home-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), content)
  }
  const engine = new KaxcavVortexEngine(home)
  try {
    engine.addRepo(repo)
    fn(repo, engine)
  } finally {
    engine.close()
    for (const d of [repo, home]) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        // SQLite may still hold a file on Windows
      }
    }
  }
}
const refsOf = (src: string, lang = 'typescript') => collectTextRefs(src, lang).map((r) => `${r[0]}@${r[1]}:${r[2]}/${r[3]}`)

describe('column-preserving blanking', () => {
  it('blanks strings, comments, regex and template text; keeps ${} code, newlines and columns', () => {
    const src = 'const a = "x // y" // c\nconst re = /a\\/b[/]/g; const d = a / b / c\nconst t = `p ${q(`n ${r}`)} s`\n/* m\n z */ w'
    const out = blankNonCode(src)
    assert.equal(out.length, src.length)
    assert.equal(out.split('\n').length, src.split('\n').length)
    assert.ok(!/x|\/\/ c|\[\//.test(out.split('\n')[0] + out.split('\n')[1].slice(0, 22)))
    assert.match(out.split('\n')[1], /const d = a \/ b \/ c/, 'division is code')
    assert.match(out.split('\n')[2], /q\(/)
    assert.match(out.split('\n')[2], /\br\b/)
    assert.ok(!/\bp\b|\bs\b|\bn\b/.test(out.split('\n')[2].replace('const', '')), 'template text blanked')
    assert.equal(out.split('\n')[4].trim(), 'w')
    assert.equal(blankHashComments('x = "a#b"  # note\ny').replace(/\s+/g, ' ').trim(), 'x = y')
  })

  it('classifies usages: import (multi-line too), call, member_call, member, jsx', () => {
    const r = refsOf("import {\n  helper,\n} from './h'\nhelper(1)\nobj.run(2)\nobj.field\nconst el = <Panel />\nnew Widget()\n")
    assert.ok(r.includes('helper@2:3/import'))
    assert.ok(r.includes('helper@4:1/call'))
    assert.ok(r.includes('run@5:5/member_call'))
    assert.ok(r.includes('field@6:5/member'))
    assert.ok(r.includes('Panel@7:13/jsx'))
    assert.ok(r.includes('Widget@8:5/call'))
  })
})

describe('find_references', () => {
  const FILES = {
    'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\nexport const twice = (x: number) => add(x, x)\n',
    'src/use.ts': "import { add } from './math'\nexport const three = add(1, 2)\n",
    'src/loose.ts': '// uses a global `add`, no import\nexport const four = add(2, 2)\n',
    'src/other.ts': 'export function add(s: string): string {\n  return s\n}\nexport const z = add("x")\n',
    'src/svc.ts': 'export class Svc {\n  run(): number {\n    return this.run2()\n  }\n  run2(): number {\n    return 1\n  }\n}\n',
    'src/client.ts': "import { Svc } from './svc'\nexport const v = new Svc().run2() + other.run2\n",
  }

  it('confidence: same_file, imported, name_only; files with their own `add` are skipped', () => {
    withRepo(FILES, (repo, engine) => {
      const res = engine.findReferences(repo, 'src/math.ts#add')
      assert.equal(res.ok, true, res.reason)
      const got = res.references!.map((r) => `${r.relPath}:${r.line}:${r.kind}:${r.confidence}`)
      assert.deepEqual(got, ['src/math.ts:4:call:same_file', 'src/use.ts:1:import:imported', 'src/use.ts:2:call:imported', 'src/loose.ts:2:call:name_only'])
      assert.equal(res.references![0].inSymbol, 'twice')
      assert.equal(res.references![2].text, 'export const three = add(1, 2)')
      const linked = engine.findReferences(repo, 'src/math.ts#add', { includeNameOnly: false })
      assert.equal(linked.references!.length, 3)
      const amb = engine.findReferences(repo, 'add')
      assert.equal(amb.ok, false)
      assert.deepEqual(amb.candidates?.sort(), ['src/math.ts#add', 'src/other.ts#add'])
    })
  })

  it('members: this.x in its file, obj.x elsewhere; the declaration is not a usage', () => {
    withRepo(FILES, (repo, engine) => {
      const res = engine.findReferences(repo, 'Svc.run2')
      assert.equal(res.ok, true, res.reason)
      const got = res.references!.map((r) => `${r.relPath}:${r.line}:${r.kind}`)
      assert.deepEqual(got, ['src/svc.ts:3:member_call', 'src/client.ts:2:member_call', 'src/client.ts:2:member'])
      assert.equal(res.references![1].confidence, 'imported')
    })
  })

  it('tree-sitter: Python import + call, Java member call through an import', (t) => {
    if (!treeSitter) return t.skip('tree-sitter off')
    withRepo(
      {
        'pkg/util.py': 'def slugify(s):\n    return s.lower()\n',
        'app.py': 'from pkg.util import slugify\n\n@cache\ndef page(t):\n    return slugify(t)\n',
        'src/main/java/com/acme/Invoice.java': 'package com.acme;\npublic class Invoice {\n  public int total() { return 1; }\n}\n',
        'src/test/java/com/acme/InvoiceTest.java': 'package com.acme;\nimport com.acme.Invoice;\nclass InvoiceTest {\n  int t() { return new Invoice().total(); }\n}\n',
      },
      (repo, engine) => {
        const py = engine.findReferences(repo, 'slugify')
        assert.deepEqual(
          py.references!.map((r) => `${r.relPath}:${r.line}:${r.kind}:${r.confidence}`),
          ['app.py:1:import:imported', 'app.py:5:call:imported'],
        )
        const java = engine.findReferences(repo, 'Invoice.total')
        assert.deepEqual(
          java.references!.map((r) => `${r.relPath}:${r.line}:${r.kind}:${r.confidence}:${r.inSymbol}`),
          ['src/test/java/com/acme/InvoiceTest.java:4:member_call:imported:InvoiceTest.t'],
        )
      },
    )
  })

  it('precision (benchmark findings): keys/params, bare member names, same name from another module, static vs instance', () => {
    withRepo(
      {
        'src/conf.ts':
          'export interface Opts {\n  limit?: number\n}\nexport function limit(o: { limit: number }, limit2: number): number {\n  return o.limit + limit2\n}\nexport const use = limit({ limit: 1 }, 2)\n',
        'src/k.ts':
          'export class K {\n  verdict = 1\n  static parse(s: string) {\n    return s\n  }\n  parse(s: string) {\n    return K.parse(s) + this.verdict\n  }\n}\nexport function other() {\n  const verdict = 2\n  return verdict\n}\n',
        'src/types.ts': 'export interface Pack {\n  n: number\n}\n',
        'src/gateway.ts': 'export interface Pack {\n  m: string\n}\n',
        'src/eng.ts': "import type { Pack } from './types'\nexport const p: Pack = { n: 1 }\n",
        'src/use-k.ts': "import { K } from './k'\nexport const a = new K().parse('x') + K.parse('y')\n",
      },
      (repo, engine) => {
        const lines = (q: string) => engine.findReferences(repo, q).references!.map((r) => `${r.relPath}:${r.line}:${r.kind}`)
        // `limit?: number`, `{ limit: 1 }` and `o.limit` are not usages of function `limit`
        assert.deepEqual(lines('src/conf.ts#limit'), ['src/conf.ts:7:call'])
        // a local `verdict` in another function is not the field K.verdict
        assert.deepEqual(lines('K.verdict'), ['src/k.ts:7:member'])
        // eng.ts imports `Pack` from types.ts, not from gateway.ts
        assert.deepEqual(lines('src/gateway.ts#Pack'), [])
        // K.parse (static) vs this/obj.parse (instance)
        assert.deepEqual(lines('src/k.ts#K.parse'), ['src/k.ts:7:member_call', 'src/use-k.ts:2:member_call'])
        assert.deepEqual(
          engine.findReferences(repo, 'src/k.ts#K.parse~2').references!.map((r) => `${r.relPath}:${r.line}:${r.col}`),
          ['src/use-k.ts:2:26'],
        )
      },
    )
  })

  it('MCP: find_references is on the read-only server too', () => {
    withRepo(FILES, (repo, engine) => {
      const ro = new VortexMcpServer(engine, () => {}, { readOnly: true })
      const res = ro.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_references', arguments: { repo, symbol: 'src/math.ts#add', include_name_only: 'false' } },
      }) as { result: { content: Array<{ text: string }>; isError?: boolean } }
      assert.equal(res.result.isError, undefined)
      assert.equal(JSON.parse(res.result.content[0].text).references.length, 3)
    })
  })
})
