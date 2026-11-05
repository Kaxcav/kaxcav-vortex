import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KaxcavVortexEngine } from '../src/engine.ts'
import { VortexMcpServer } from '../src/mcp/server.ts'
import { VortexDashboardServer } from '../src/ui/server.ts'

test('AdmissionFirewall blocks PDFs, binaries, minified blobs and vendor dirs without .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'kvx-firewall-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-store-'))

  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'vendor_legacy'), { recursive: true })

    // Valid source file
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      `export class AuthService {\n  verifyToken(token: string): boolean {\n    return token.length > 10\n  }\n}\n`,
    )

    // Fake PDF with %PDF- magic bytes disguised with .ts or .pdf extension
    writeFileSync(join(root, 'src', 'poison.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))
    writeFileSync(join(root, 'src', 'disguised.ts'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x41]))

    // Minified single-line blob (> 1400 chars on one line)
    writeFileSync(join(root, 'src', 'bundle.js'), 'var a=' + 'x'.repeat(2000) + ';')

    // Excluded directories
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export const x = 1;')
    writeFileSync(join(root, 'vendor_legacy', 'legacy.sql'), 'CREATE TABLE old_data (id INT);')

    const engine = new KaxcavVortexEngine(storage)
    const shard = engine.getOrOpenShard(root)
    const syncRes = shard.sync(true)

    assert.equal(syncRes.totalFiles, 1, 'Only src/auth.ts should pass AdmissionFirewall')
    const hits = engine.search(root, 'AuthService verifyToken')
    assert.ok(hits.length >= 1)
    assert.ok(hits.every((h) => h.relPath === 'src/auth.ts'))
    engine.close()
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('PPR-HD Hub Dampening + Submodular L0-L3 Slicing + ETag Delta Deduplication', () => {
  const root = mkdtempSync(join(tmpdir(), 'kvx-ppr-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-store2-'))

  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })

    // Hub file that links to everything (like MAPA-GERAL.md / CENTRAL-RELACIONAMENTOS.md)
    writeFileSync(
      join(root, 'docs', 'MAPA-GERAL.md'),
      `# Mapa Geral\n` +
        Array.from({ length: 25 }, (_, i) => `- [Modulo ${i}](./mod-${i}.md) payment invoice auth`).join('\n'),
    )

    // Specific target implementation
    writeFileSync(
      join(root, 'src', 'invoice.ts'),
      `/** Processa faturas e calcula impostos governamentais */\nexport class InvoiceProcessor {\n  calculateTax(amount: number): number {\n    return amount * 0.18\n  }\n}\n`,
    )

    writeFileSync(
      join(root, 'src', 'billing.ts'),
      `import { InvoiceProcessor } from './invoice.ts'\nexport class BillingController {\n  run(): number {\n    const p = new InvoiceProcessor()\n    return p.calculateTax(100)\n  }\n}\n`,
    )

    writeFileSync(
      join(root, 'test', 'invoice.test.ts'),
      `import { BillingController } from '../src/billing.ts'\nconst b = new BillingController()\nb.run()\n`,
    )

    const engine = new KaxcavVortexEngine(storage)
    const pack1 = engine.context({
      repositoryPath: root,
      task: 'InvoiceProcessor calculateTax impostos faturas',
      tokenBudget: 1200,
      fidelity: 'graded',
    })

    assert.equal(pack1.unchanged, false)
    assert.ok(pack1.etag.startsWith('kvx-'))
    assert.equal(
      pack1.files[0].path,
      'src/invoice.ts',
      'Specific file must beat generic MAPA-GERAL.md hub',
    )

    // Test ETag Not-Modified short-circuit (--if-none-match)
    const packNotModified = engine.context({
      repositoryPath: root,
      task: 'InvoiceProcessor calculateTax impostos faturas',
      tokenBudget: 1200,
      fidelity: 'graded',
      ifNoneMatch: pack1.etag,
    })
    assert.equal(packNotModified.unchanged, true)
    assert.equal(packNotModified.tokenCount, 0)

    // Test Delta ETag mode (--delta-from)
    const packDelta = engine.context({
      repositoryPath: root,
      task: 'InvoiceProcessor calculateTax impostos faturas',
      tokenBudget: 1200,
      fidelity: 'graded',
      deltaFrom: pack1.etag,
    })
    assert.ok(
      packDelta.slices.every((s) => s.fidelityLevel === 'L0_DELTA'),
      'Unchanged symbols in delta pack should collapse to L0_DELTA markers',
    )

    // Test Affected Tests traversal
    const affected = engine.affected(root, ['src/invoice.ts'])
    assert.ok(affected.includes('test/invoice.test.ts'))

    engine.close()
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('Multi-Repo Federation links REST routes and shared contracts + MCP Server JSON-RPC', () => {
  const repoBackend = mkdtempSync(join(tmpdir(), 'kvx-backend-'))
  const repoFrontend = mkdtempSync(join(tmpdir(), 'kvx-frontend-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-store3-'))

  try {
    writeFileSync(
      join(repoBackend, 'server.ts'),
      `export class LeadController {\n  registerRoutes(app: any) {\n    app.post('/api/v1/leads/convert', (req: any, res: any) => res.json({ ok: true }))\n  }\n}\n`,
    )
    writeFileSync(
      join(repoFrontend, 'client.ts'),
      `export async function convertLeadClient() {\n  return fetch('/api/v1/leads/convert')\n}\n`,
    )

    const engine = new KaxcavVortexEngine(storage)
    const links = engine.federate([repoBackend, repoFrontend])
    assert.ok(
      links.some((l) => l.linkKind === 'rest_route' && l.detail.includes('/api/v1/leads/convert')),
      'Federator must link frontend fetch consumer to backend app.post route',
    )

    const mcp = new VortexMcpServer(engine, () => {})
    const initRes = mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    assert.ok(initRes && 'result' in initRes)

    const callRes = mcp.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'context',
        arguments: { repo: repoBackend, task: 'LeadController convert', budget: 1000 },
      },
    }) as { result?: { meta?: { etag?: string } } }

    assert.ok(callRes?.result?.meta?.etag?.startsWith('kvx-'))
    engine.close()
  } finally {
    try { rmSync(repoBackend, { recursive: true, force: true }) } catch {}
    try { rmSync(repoFrontend, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('v2.0 APEX: State-Machine Lexer, Cross-Process SQLite ETag Delta, Outline, ReadSymbol & Contract Drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'kvx-apex-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-store4-'))

  try {
    mkdirSync(join(root, 'src'), { recursive: true })

    // File with braces inside strings/comments and multi-line function signature
    writeFileSync(
      join(root, 'src', 'payment.ts'),
      [
        'export function processPixPayment(',
        '  pixKey: string,',
        '  amountCents: number,',
        '): { ok: boolean } {',
        '  // Fake brace in comment: {{{ }}}',
        '  const tpl = `template with { braces } ${{ nested: 1 }}`',
        '  return { ok: amountCents > 0 && pixKey.length > 3 }',
        '}',
      ].join('\n'),
    )

    // Process 1: index and generate pack
    const engine1 = new KaxcavVortexEngine(storage)
    const pack1 = engine1.context({
      repositoryPath: root,
      task: 'processPixPayment pixKey amountCents',
      tokenBudget: 1000,
      fidelity: 'graded',
    })
    assert.equal(pack1.slices.length, 1)
    assert.ok(
      pack1.slices[0].content.includes('return { ok: amountCents > 0'),
      'State-machine lexer must not stop at braces inside comments or template strings',
    )
    engine1.close()

    // Process 2: brand new engine instance using persistent SQLite pack_snapshots
    const engine2 = new KaxcavVortexEngine(storage)
    const deltaPack = engine2.context({
      repositoryPath: root,
      task: 'processPixPayment pixKey amountCents',
      tokenBudget: 1000,
      fidelity: 'graded',
      deltaFrom: pack1.etag,
    })
    assert.equal(
      deltaPack.slices[0].fidelityLevel,
      'L0_DELTA',
      'Cross-process SQLite ETag delta must collapse unchanged symbol to L0_DELTA',
    )

    const outline = engine2.fileOutline(root, 'src/payment.ts')
    assert.ok(outline)
    assert.equal(outline.symbols[0].name, 'processPixPayment')
    assert.ok(outline.symbols[0].signature.includes('amountCents: number'))

    const symRead = engine2.readSymbol(root, 'processPixPayment')
    assert.equal(symRead.length, 1)

    // Mutate signature to trigger Contract Drift detection
    writeFileSync(
      join(root, 'src', 'payment.ts'),
      [
        'export function processPixPayment(',
        '  pixKey: string,',
        '  amountCents: number,',
        '  currency: "BRL" | "USD",',
        '): Promise<{ ok: boolean }> {',
        '  return Promise.resolve({ ok: amountCents > 0 && Boolean(currency) })',
        '}',
      ].join('\n'),
    )
    engine2.getOrOpenShard(root).sync(true)
    const drift = engine2.diffImpact(root, 60)
    assert.equal(drift.contractDrifts.length, 1, 'Must detect signature contract drift')
    assert.ok(drift.contractDrifts[0].currentSignature.includes('currency'))

    engine2.close()
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('VortexDashboardServer serves anti-slop Workbench UI and live API endpoints', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'kvx-dash-store-'))
  const engine = new KaxcavVortexEngine(storage)
  const dash = new VortexDashboardServer(engine)
  const serverInfo = await dash.start(0, '127.0.0.1')

  try {
    const htmlRes = await fetch(`${serverInfo.url}/`)
    assert.equal(htmlRes.status, 200)
    const html = await htmlRes.text()

    // Anti-slop invariants check
    assert.ok(html.includes('<meta name="viewport"'), 'Must include responsive viewport meta')
    assert.ok(html.includes('oklch('), 'Must use OKLCH color tokens')
    assert.ok(!html.includes('background-clip: text'), 'Must not contain gradient text AI slop')
    assert.ok(!html.includes('&mdash;'), 'Must not contain em-dash entities')
    assert.ok(!html.includes(' — '), 'Must not contain raw em-dashes')

    const statusRes = await fetch(`${serverInfo.url}/api/status`)
    assert.equal(statusRes.status, 200)
    const statusJson = (await statusRes.json()) as { status: { version: string } }
    assert.equal(statusJson.status.version, '2.0.0-apex')
  } finally {
    serverInfo.close()
    engine.close()
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})
