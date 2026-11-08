import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { initTreeSitter } from '../src/parser/treesitter.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'

let treeSitter = false
before(async () => {
  treeSitter = (await initTreeSitter()).ready
})

function withRepo(files: Record<string, string>, fn: (repo: string, engine: KaxcavVortexEngine, read: (rel: string) => string) => void): void {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-rename-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-rename-home-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), content)
  }
  const engine = new KaxcavVortexEngine(home)
  try {
    engine.addRepo(repo)
    fn(repo, engine, (rel) => fs.readFileSync(path.join(repo, rel), 'utf8'))
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

const FILES: Record<string, string> = {
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\nexport const twice = (x: number) => add(x, x)\n',
  'src/use.ts': "import { add } from './math'\nexport const three = add(1, 2) // add\n",
  'src/loose.ts': 'export const four = add(2, 2)\n',
  'src/svc.ts': 'export class Svc {\n  run(): number {\n    return this.run2()\n  }\n  run2(): number {\n    return 1\n  }\n}\n',
  'src/client.ts': "import { Svc } from './svc'\nexport const v = new Svc().run2()\n",
}

describe('rename_symbol', () => {
  it('plans without writing, then applies with the token: declaration + linked usages; name_only skipped', () => {
    withRepo(FILES, (repo, engine, read) => {
      const plan = engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'plus' })
      assert.equal(plan.ok, true, plan.reason)
      assert.equal(plan.applied, false)
      assert.deepEqual(plan.plan?.files, [
        { relPath: 'src/math.ts', edits: 2 },
        { relPath: 'src/use.ts', edits: 2 },
      ])
      assert.equal(plan.plan?.skipped.length, 1)
      assert.match(plan.plan!.skipped[0], /^src\/loose\.ts:1/)
      assert.ok(read('src/math.ts').includes('function add('), 'planning writes nothing')
      const done = engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'plus', planToken: plan.planToken })
      assert.equal(done.ok, true, done.reason)
      assert.equal(done.applied, true)
      assert.equal(read('src/math.ts'), 'export function plus(a: number, b: number): number {\n  return a + b\n}\nexport const twice = (x: number) => plus(x, x)\n')
      assert.equal(read('src/use.ts'), "import { plus } from './math'\nexport const three = plus(1, 2) // add\n", 'comments untouched')
      assert.equal(read('src/loose.ts'), 'export const four = add(2, 2)\n')
      assert.equal(engine.findReferences(repo, 'src/math.ts#plus').total, 3)
    })
  })

  it('refuses a stale token, name collisions and broken locks', () => {
    withRepo(FILES, (repo, engine, read) => {
      const plan = engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'plus' })
      fs.appendFileSync(path.join(repo, 'src', 'use.ts'), 'export const five = add(2, 3)\n')
      const stale = engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'plus', planToken: plan.planToken })
      assert.equal(stale.ok, false)
      assert.match(stale.reason ?? '', /mudou desde o plano/)
      assert.ok(read('src/math.ts').includes('function add('))
      assert.match(engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'twice' }).reason ?? '', /já existe 'twice'/)
      fs.appendFileSync(path.join(repo, 'src', 'use.ts'), 'export const plus = 0\n')
      assert.match(engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'plus' }).reason ?? '', /use\.ts já declara 'plus'/)
      engine.lockSymbols(repo, [{ qualifiedName: 'twice', relPath: 'src/math.ts', mode: 'frozen' }])
      const locked = engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: 'sum' })
      assert.equal(locked.ok, false)
      assert.equal(locked.violations?.[0]?.qualifiedName, 'twice')
      assert.equal(engine.renameSymbol(repo, { symbol: 'src/math.ts#add', newName: '1bad' }).ok, false)
    })
  })

  it('members: this.x and obj.x in files that import the class', () => {
    withRepo(FILES, (repo, engine, read) => {
      const plan = engine.renameSymbol(repo, { symbol: 'Svc.run2', newName: 'runTwice' })
      assert.equal(plan.ok, true, plan.reason)
      const done = engine.renameSymbol(repo, { symbol: 'Svc.run2', newName: 'runTwice', planToken: plan.planToken })
      assert.equal(done.ok, true, done.reason)
      assert.match(read('src/svc.ts'), /return this\.runTwice\(\)/)
      assert.match(read('src/svc.ts'), /\n {2}runTwice\(\): number/)
      assert.equal(read('src/client.ts'), "import { Svc } from './svc'\nexport const v = new Svc().runTwice()\n")
      assert.equal(engine.readSymbol(repo, 'Svc.runTwice').length, 1)
    })
  })

  it('tree-sitter: Python function renamed across an import', (t) => {
    if (!treeSitter) return t.skip('tree-sitter off')
    withRepo(
      { 'pkg/util.py': 'def slugify(s):\n    return s.lower()\n', 'app.py': 'from pkg.util import slugify\n\ndef page(t):\n    return slugify(t)  # slugify\n' },
      (repo, engine, read) => {
        const plan = engine.renameSymbol(repo, { symbol: 'slugify', newName: 'make_slug' })
        assert.equal(plan.ok, true, plan.reason)
        assert.equal(engine.renameSymbol(repo, { symbol: 'slugify', newName: 'make_slug', planToken: plan.planToken }).ok, true)
        assert.equal(read('pkg/util.py'), 'def make_slug(s):\n    return s.lower()\n')
        assert.equal(read('app.py'), 'from pkg.util import make_slug\n\ndef page(t):\n    return make_slug(t)  # slugify\n')
      },
    )
  })

  it('MCP: plan + apply on the full server; absent from the read-only one', () => {
    withRepo(FILES, (repo, engine, read) => {
      const full = new VortexMcpServer(engine, () => {})
      const call = (args: Record<string, unknown>) =>
        JSON.parse(
          (full.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rename_symbol', arguments: { repo, ...args } } }) as {
            result: { content: Array<{ text: string }> }
          }).result.content[0].text,
        )
      const plan = call({ symbol: 'src/math.ts#add', new_name: 'plus' })
      assert.equal(call({ symbol: 'src/math.ts#add', new_name: 'plus', plan_token: plan.planToken }).applied, true)
      assert.match(read('src/use.ts'), /import \{ plus \}/)
      const ro = new VortexMcpServer(engine, () => {}, { readOnly: true })
      const names = (ro.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)
      assert.ok(!names.includes('rename_symbol') && !names.includes('edit_symbol'))
    })
  })
})
