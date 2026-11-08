import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'

function withRepo(files: Record<string, string>, fn: (repo: string, engine: KaxcavVortexEngine) => void): void {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-map-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-map-home-'))
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

const FILES: Record<string, string> = {
  'src/core.ts': 'export interface Store {\n  get(k: string): string\n}\nexport function makeStore(): Store {\n  return { get: (k) => k }\n}\n',
  'src/a.ts': "import { makeStore } from './core'\nexport const a = makeStore()\n",
  'src/b.ts': "import { makeStore } from './core'\nexport const b = makeStore()\n",
  'src/c.ts': "import { a } from './a'\nimport { makeStore } from './core'\nexport function useAll() {\n  return [a, makeStore()]\n}\n",
  'src/leaf.ts': 'export function leaf(): number {\n  return 1\n}\n',
  'test/core.test.ts': "import { makeStore } from '../src/core'\nmakeStore()\n",
  'docs/readme.md': '# docs\n',
}

describe('repo_map', () => {
  it('ranks what the code depends on first, leaves tests and docs out, respects the budget', () => {
    withRepo(FILES, (repo, engine) => {
      const map = engine.repoMap(repo, { budget: 2000 })
      assert.equal(map.ok, true)
      assert.equal(map.files[0].path, 'src/core.ts')
      assert.ok(!map.files.some((f) => f.path.startsWith('test/') || f.path.endsWith('.md')))
      assert.match(map.markdown, /^src\/core\.ts\n {2}export interface Store\n/)
      assert.match(map.markdown, /export function makeStore\(\): Store/)
      const tiny = engine.repoMap(repo, { budget: 200 })
      assert.ok(tiny.tokens <= 200 + 10)
      assert.ok((tiny.omittedFiles ?? 0) >= 0)
      assert.ok(engine.repoMap(repo, { includeTests: true }).files.some((f) => f.path === 'test/core.test.ts'))
    })
  })

  it('focus puts the file first, then its neighbours (dependencies and dependents)', () => {
    withRepo(FILES, (repo, engine) => {
      const map = engine.repoMap(repo, { focus: ['src/a.ts'] })
      assert.deepEqual(map.files.slice(0, 3).map((f) => f.path).sort(), ['src/a.ts', 'src/c.ts', 'src/core.ts'])
      assert.equal(map.files[0].path, 'src/a.ts')
      assert.match(map.markdown, /src\/a\.ts {2}\(foco\)/)
      assert.equal(engine.repoMap(repo, { path: 'src/leaf.ts' }).files.map((f) => f.path).join(), 'src/leaf.ts')
    })
  })

  it('MCP: repo_map answers markdown on the read-only server', () => {
    withRepo(FILES, (repo, engine) => {
      const ro = new VortexMcpServer(engine, () => {}, { readOnly: true })
      const res = ro.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'repo_map', arguments: { repo, budget: 500 } } }) as {
        result: { content: Array<{ text: string }>; meta: { files: number } }
      }
      assert.match(res.result.content[0].text, /^src\/core\.ts/)
      assert.ok(res.result.meta.files >= 1)
    })
  })
})
