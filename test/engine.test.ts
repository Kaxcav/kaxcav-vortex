import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TsDeclarationScanner } from '../src/parser/ts-scanner.ts'
import { CodeStateMachine } from '../src/parser/lexer.ts'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { checkKvxIgnore, KvxIgnoreError } from '../src/core/kvxignore.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'

const IS_WIN = process.platform === 'win32'

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
      // SQLite may still hold a file on Windows; the OS temp cleaner takes it later.
    }
  }
}
const decls = (src: string) =>
  TsDeclarationScanner.scan(src).declarations.map((d) => `${d.qualifiedSuffix} L${d.startLine}-${d.endLine}`)

const BIG_CLASS = [
  "import { x } from './x'",
  '',
  'export class CloudApp {',
  '  #secret = 1',
  '  private readonly deps: { version?: string }',
  '  handler = async (req: Request) => {',
  '    return req',
  '  }',
  '  constructor(deps: { version?: string }) {',
  '    this.deps = deps',
  '  }',
  '  get version(): string {',
  "    return this.deps.version ?? '1.0.0'",
  '  }',
  ...Array.from({ length: 300 }, (_, i) => `  m${i}(): number {\n    return ${i}\n  }`),
  '  private async finalizeUploadCopy(',
  '    req: Request,',
  '    recovered = false,',
  '  ): Promise<void> {',
  "    if ((req.method ?? 'GET') === 'GET' && recovered) { return }",
  '    const local = 1',
  '    void local',
  '  }',
  '}',
  '',
].join('\n')

describe('TS/JS scanner', () => {
  it('ranges come from the closing token: long consts, one-line types, arrows, routes', () => {
    const src = [
      "import { z } from 'zod'",
      '',
      '/** tipo */',
      "export type TipoRegra = 'a' | 'b'",
      'export interface RegraCatalogo {',
      '  codigo: string',
      '}',
      'export const CATALOGO_REGRAS: RegraCatalogo[] = [',
      ...Array.from({ length: 120 }, (_, i) => `  { codigo: 'RN-${i}' },`),
      ']',
      'const comCodigo = (c: string) => CATALOGO_REGRAS.find((r) => r.codigo === c)!',
      'export function rotas(app: any) {',
      "  app.get('/sancoes', async () => {",
      '    const fornecedorId = 1',
      '    return fornecedorId',
      '  })',
      '',
      "  app.post('/sancoes', async () => {",
      '    const contratoId = 2',
      '    return contratoId',
      '  })',
      '}',
      '',
    ].join('\n')
    const d = decls(src)
    for (const expected of ['TipoRegra L4-4', 'CATALOGO_REGRAS L8-129', 'comCodigo L130-130', 'GET /sancoes L132-135', 'POST /sancoes L137-140']) {
      assert.ok(d.includes(expected), `missing ${expected} in ${d.join(', ')}`)
    }
    assert.ok(!d.some((x) => x.startsWith('fornecedorId') || x.startsWith('contratoId')), 'handler locals are not symbols')
  })

  it('class members of a 900-line class: methods, getters, #fields, arrow properties', () => {
    const d = TsDeclarationScanner.scan(BIG_CLASS).declarations
    assert.equal(d.find((x) => x.name === 'CloudApp')!.endLine, BIG_CLASS.split('\n').length - 1)
    const fin = d.find((x) => x.name === 'finalizeUploadCopy')!
    assert.equal(fin.qualifiedSuffix, 'CloudApp.finalizeUploadCopy')
    assert.equal(fin.exported, false)
    for (const n of ['#secret', 'deps', 'handler', 'constructor', 'version', 'm299']) {
      assert.ok(d.some((x) => x.name === n && x.parent === 'CloudApp'), `missing member ${n}`)
    }
  })

  it('hand-rolled routes span their if-block', () => {
    const src = "export class S {\n  handle(req: any, pathname: string) {\n    if (req.method === 'GET' && pathname === '/api/v1/health') {\n      return 1\n    }\n  }\n}\n"
    assert.ok(decls(src).includes('GET /api/v1/health L3-5'))
  })

  it('static and instance members with the same name get distinct qualified names', () => {
    const src = 'export class A {\n  static detect(f: string) {\n    return f\n  }\n  detect(f: string) {\n    return A.detect(f)\n  }\n}\n'
    assert.deepEqual(
      TsDeclarationScanner.scan(src).declarations.filter((x) => x.name === 'detect').map((x) => x.qualifiedSuffix),
      ['A.detect', 'A.detect~2'],
    )
  })

  it('never stalls on a stray ) or ] inside a class (half-typed code)', () => {
    for (const src of ['export class A {\n  x = foo(1))\n  m() { return 1 }\n}\n', 'export class A {\n  )\n  m() { return 1 }\n}\n']) {
      const t0 = Date.now()
      assert.ok(decls(src).includes('A.m L3-3'))
      assert.ok(Date.now() - t0 < 1000)
    }
  })

  it('regex inside ${}, function-typed returns, `void` at end of line, `let a, b`, URLs in JSX', () => {
    assert.deepEqual(
      decls('function q(s: string) {\n  return `"${s.replace(/"/g, \'""\')}"`\n}\nexport function a() {\n  return `x`\n}\nexport const c = 2\n'),
      ['q L1-3', 'a L4-6', 'c L7-7'],
    )
    assert.ok(decls('export function f(): (x: number) => void {\n  return () => {}\n}\n').includes('f L1-3'))
    assert.deepEqual(decls('type H = () => void\nexport function foo() {\n  return 1\n}\n'), ['H L1-1', 'foo L2-4'])
    assert.deepEqual(decls('let a, b\nexport const c = 1, d = 2\n'), ['a L1-1', 'b L1-1', 'c L2-2', 'd L2-2'])
    assert.deepEqual(decls('export function C() {\n  return <div>{x && <a>see https://x.com</a>}</div>\n}\nexport const after = 1\n'), ['C L1-3', 'after L4-4'])
  })

  it('fuzz: single-character mutations of real sources never throw or hang', () => {
    const sources = ['../src/parser/ts-scanner.ts', '../src/storage/shard.ts'].map((rel) =>
      fs.readFileSync(new URL(rel, import.meta.url), 'utf-8'),
    )
    const noise = ['{', '}', '(', ')', '[', ']', "'", '"', '`', '/', '*', '\n', '<', '>', '$']
    let seed = 20261108
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 120; i++) {
      const src = sources[i % sources.length]
      const at = rand(src.length)
      const mutated = i % 2 === 0 ? src.slice(0, at) + noise[rand(noise.length)] + src.slice(at) : src.slice(0, at) + src.slice(at + 1)
      const t0 = Date.now()
      assert.doesNotThrow(() => TsDeclarationScanner.scan(mutated))
      assert.ok(Date.now() - t0 < 2000, `mutation ${i} took too long`)
    }
  })
})

describe('lexer and slop markers', () => {
  it('TODO only as an uppercase marker in a comment', () => {
    for (const l of ['// TODO: corrigir', '/* FIXME(joao): x */', '  // TODO remover depois', 'foo() // HACK: y']) {
      assert.ok(CodeStateMachine.hasTodoMarker(l), l)
    }
    for (const l of ['// todo arquivo precisa disso', '// todos os casos', '// visto como um todo', 'const todo = 1']) {
      assert.ok(!CodeStateMachine.hasTodoMarker(l), l)
    }
  })

  it('findings keep their real line after multi-line template literals', () => {
    const src = ['const html = `', '  <p>a</p>', '  <p>b</p>', '`', "const headers = { 'content-type': 'json' }", 'let x: any = 1', ''].join('\n')
    assert.deepEqual(
      CodeStateMachine.scanSlop('src/a.ts', src).filter((f) => f.kind === 'explicit_any').map((f) => f.line),
      [6],
    )
  })
})

describe('engine', () => {
  it('explicit reasons, path normalization, freshness, scope filter, WAL', () => {
    const repo = tmp('kvx-repo-')
    const home = tmp('kvx-home-')
    write(repo, 'src/cloud/app.ts', BIG_CLASS)
    write(repo, 'src/util.ts', 'export function soma(a: number, b: number) {\n  return a + b\n}\n')
    write(repo, 'src/slop.ts', 'export function f() {\n  try { g() } catch (err) {}\n}\nfunction g() {}\n')
    write(repo, 'big.bin.ts', 'x'.repeat(600_000))
    const engine = new KaxcavVortexEngine(home)
    try {
      engine.addRepo(repo)
      const abs = path.join(repo, 'src', 'util.ts')
      const variants = [abs, abs.split(path.sep).join('/')]
      if (IS_WIN) variants.push(abs[0].toLowerCase() + abs.slice(1))
      for (const v of variants) {
        const o = engine.fileOutline(repo, v) as { found: boolean; symbols: Array<{ name: string }> }
        assert.equal(o.found, true, v)
        assert.equal(o.symbols[0].name, 'soma')
      }
      const spellings = [repo, repo.split(path.sep).join('/') + '/']
      if (IS_WIN) spellings.push(repo.toLowerCase())
      assert.equal(engine.status(spellings).shards.length, 1)

      const missing = engine.fileOutline(repo, 'src/nao-existe.ts') as { found: boolean; reason: string }
      assert.equal(missing.found, false)
      assert.match(missing.reason, /não existe/)
      const tooBig = engine.fileOutline(repo, 'big.bin.ts') as { reason: string }
      assert.match(tooBig.reason, /limite|linha única/)
      const outside = engine.fileOutline(repo, path.join(os.tmpdir(), 'zzz-kvx.ts')) as { reason: string }
      assert.match(outside.reason, /fora do repositório/)

      assert.equal(engine.readSymbol(repo, 'finalizeUploadCopy')[0].qualifiedName, 'src/cloud/app.ts#CloudApp.finalizeUploadCopy')
      assert.equal(engine.readSymbol(repo, 'CloudApp.finalizeUploadCopy').length, 1)
      assert.match(engine.readSymbolDetailed(repo, 'finalizeUploadCopyX').reason ?? '', /parecidos: CloudApp\.finalizeUploadCopy/)

      const s = engine.searchDetailed(repo, 'soma', { path: path.join(repo, 'src') })
      assert.equal(s.via, 'indice')
      assert.equal(engine.searchDetailed(repo, 'zzqqxx inexistente').via, 'nenhum')

      const topo = engine.fileOutline(repo, 'src/cloud/app.ts') as { symbols: Array<{ scope: string }> }
      assert.ok(topo.symbols.every((x) => x.scope !== 'local'))

      write(repo, 'src/util.ts', 'export function soma(a: number, b: number, c = 0) {\n  return a + b + c\n}\nexport const NOVO = 1\n')
      const fresh = engine.fileOutline(repo, 'src/util.ts') as { symbols: Array<{ name: string }> }
      assert.ok(fresh.symbols.some((x) => x.name === 'NOVO'))

      assert.ok(engine.scanSlop(repo).some((f) => f.relPath === 'src/slop.ts' && f.kind === 'empty_catch'))
      write(repo, 'src/slop.ts', 'export function f() {\n  g()\n}\nfunction g() {}\n')
      engine.getOrOpenShard(repo).refreshFile('src/slop.ts')
      assert.ok(!engine.scanSlop(repo).some((f) => f.relPath === 'src/slop.ts'))

      const h = engine.status([repo]).shards[0]
      assert.ok(h.walSizeBytes < 64 * 1024, `wal ${h.walSizeBytes}`)
    } finally {
      engine.close()
      cleanup(repo, home)
    }
  })

  it('imports of declaration-less tests, CAS per path, literal LIKE, drift kept, K.#private, Python methods', () => {
    const repo = tmp('kvx-rev-')
    const home = tmp('kvx-home-')
    write(repo, 'src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
    write(repo, 'test/calc.test.ts', "import { add } from '../src/math'\nimport { test } from 'node:test'\ntest('x', () => add(1, 2))\n")
    write(repo, 'pkgA/util.ts', 'export const shared = 1\n')
    write(repo, 'pkgB/util.ts', 'export const shared = 1\n')
    write(repo, 'src/priv.ts', 'export class K {\n  #secret = 1\n}\n')
    write(repo, 'py/models.py', 'class A:\n    def run(self, x):\n        return x\n\nclass B:\n    def run(self):\n        return 1\n')
    const engine = new KaxcavVortexEngine(home)
    try {
      engine.addRepo(repo)
      assert.deepEqual(engine.affected(repo, ['src/math.ts']), ['test/calc.test.ts'])
      assert.deepEqual(engine.readSymbol(repo, 'shared').map((s) => s.qualifiedName).sort(), ['pkgA/util.ts#shared', 'pkgB/util.ts#shared'])
      assert.equal(engine.readSymbol(repo, 'a_d').length, 0)
      assert.deepEqual(engine.readSymbol(repo, 'K.#secret').map((s) => s.qualifiedName), ['src/priv.ts#K.#secret'])
      assert.deepEqual(engine.readSymbol(repo, 'run').map((s) => s.qualifiedName).sort(), ['py/models.py#A.run', 'py/models.py#B.run'])
      write(repo, 'src/math.ts', 'export function add(a: number, b: number, c = 0): number {\n  return a + b + c\n}\n')
      engine.getOrOpenShard(repo).refreshFile('src/math.ts')
      assert.ok(engine.diffImpact(repo, 60).contractDrifts.some((d) => d.qualifiedName === 'src/math.ts#add'))
      engine.verifySymbolLocks(repo)
      assert.ok(engine.diffImpact(repo, 60).contractDrifts.some((d) => d.qualifiedName === 'src/math.ts#add'), 'drift survives the lock check')
    } finally {
      engine.close()
      cleanup(repo, home)
    }
  })

  it('.kvxignore blocks indexing, file tools and nexus_ingest_vault; a dir cannot be re-included', () => {
    const repo = tmp('kvx-ign-')
    const home = tmp('kvx-home-')
    write(repo, 'src/ok.ts', 'export const OK = 1\n')
    write(repo, 'dados-reais/segredo.ts', 'export const SEGREDO = 1\n')
    write(repo, 'generated/api/token.ts', 'export const t = 1\n')
    write(repo, '.kvxignore', '# dados do portal original\ndados-reais/\ngenerated/\n!generated/api/\n')
    const engine = new KaxcavVortexEngine(home)
    try {
      engine.addRepo(repo)
      assert.equal(engine.readSymbol(repo, 'SEGREDO').length, 0)
      assert.throws(() => engine.fileOutline(repo, 'dados-reais/segredo.ts'), KvxIgnoreError)
      assert.equal(checkKvxIgnore(path.join(repo, 'generated', 'api', 'token.ts')).ignored, true)
      const mcp = new VortexMcpServer(engine, () => {})
      const res = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'nexus_ingest_vault', arguments: { name: 'x', source_dir: path.join(repo, 'dados-reais') } },
      }) as { result: { isError: boolean; content: Array<{ text: string }> } }
      assert.equal(res.result.isError, true)
      assert.match(res.result.content[0].text, /bloqueado por \.kvxignore/)
    } finally {
      engine.close()
      cleanup(repo, home)
    }
  })

  it('read-only MCP server exposes only the 10 code tools', () => {
    const home = tmp('kvx-home-')
    const engine = new KaxcavVortexEngine(home)
    try {
      const ro = new VortexMcpServer(engine, () => {}, { readOnly: true })
      const list = ro.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }
      const names = list.result.tools.map((t) => t.name)
      assert.equal(names.length, 10)
      assert.ok(!names.some((n) => n.startsWith('nexus_')))
      const refused = ro.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nexus_ingest_vault', arguments: {} },
      }) as { error?: { message: string } }
      assert.match(refused.error?.message ?? '', /só de leitura/)
    } finally {
      engine.close()
      cleanup(home)
    }
  })

  it('re-indexing replaces FTS rows by rowid: no orphans after edits and deletions', () => {
    const repo = tmp('kvx-fts-')
    const home = tmp('kvx-home-')
    write(repo, 'src/a.ts', 'export function alphaOld() {\n  return 1\n}\n')
    write(repo, 'src/b.ts', 'export function keepMe() {\n  return 2\n}\n')
    const engine = new KaxcavVortexEngine(home)
    try {
      engine.addRepo(repo)
      const shard = engine.getOrOpenShard(repo)
      write(repo, 'src/a.ts', 'export function betaNew() {\n  return 1\n}\nexport function gammaNew() {\n  return 3\n}\n')
      shard.refreshFile('src/a.ts')
      fs.rmSync(path.join(repo, 'src', 'b.ts'))
      shard.sync(true)
      const shardDir = path.join(home, 'shards')
      const dbFile = fs.readdirSync(shardDir).find((f) => f.endsWith('.sqlite'))!
      const db = new DatabaseSync(path.join(shardDir, dbFile), { readOnly: true })
      try {
        const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c
        assert.equal(count('SELECT COUNT(*) AS c FROM fts_symbols'), count('SELECT COUNT(*) AS c FROM symbols'))
        assert.equal(count('SELECT COUNT(*) AS c FROM fts_files'), count('SELECT COUNT(*) AS c FROM files'))
        assert.equal(count("SELECT COUNT(*) AS c FROM fts_symbols WHERE fts_symbols MATCH 'alphaOld'"), 0)
        assert.equal(count("SELECT COUNT(*) AS c FROM fts_symbols WHERE fts_symbols MATCH 'keepMe'"), 0)
        assert.equal(count("SELECT COUNT(*) AS c FROM fts_symbols WHERE fts_symbols MATCH 'gammaNew'"), 1)
      } finally {
        db.close()
      }
    } finally {
      engine.close()
      cleanup(repo, home)
    }
  })
})
