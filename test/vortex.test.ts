import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KaxcavVortexEngine, KAXCAV_VORTEX_VERSION } from '../src/engine.ts'
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
    assert.equal(statusJson.status.version, KAXCAV_VORTEX_VERSION)
  } finally {
    serverInfo.close()
    engine.close()
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('Authority Tier Multiplier (current/ vs legacy-*) and Scoped Path/Corpus Filtering', () => {
  const root = mkdtempSync(join(tmpdir(), 'kvx-auth-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-store5-'))

  try {
    mkdirSync(join(root, 'current'), { recursive: true })
    mkdirSync(join(root, 'legacy-docs'), { recursive: true })

    writeFileSync(
      join(root, 'current', 'decisoes-vigentes.md'),
      [
        '# Decisoes Vigentes do CRM',
        'Authority: CURRENT_USER_CONFIRMED',
        '',
        '## Entrada por SDR e Conversao Comercial',
        'Lead entra pelo SDR, passa por validacao e vira Oportunidade no Comercial.',
      ].join('\n'),
    )

    writeFileSync(
      join(root, 'legacy-docs', 'fluxos-legado.md'),
      [
        '# Fluxos Legados',
        'Authority: LEGACY_IDEA',
        '',
        '## Entrada por SDR e Conversao Comercial',
        'Lead entra pelo SDR, passa por validacao e vira Oportunidade no Comercial.',
      ].join('\n'),
    )

    writeFileSync(
      join(root, 'legacy-docs', 'campos-crm.sql'),
      'CREATE TABLE oportunidades (\n  id INT PRIMARY KEY,\n  lead_id INT,\n  status_comercial VARCHAR(60)\n);\n',
    )

    const engine = new KaxcavVortexEngine(storage)
    const unscopedHits = engine.search(root, 'Lead validacao Comercial Oportunidade SDR', 10)
    assert.ok(unscopedHits.length >= 2)
    assert.equal(
      unscopedHits[0].relPath,
      'current/decisoes-vigentes.md',
      'Authority multiplier must rank current/ above identical legacy-docs/ content',
    )

    const scopedLegacyHits = engine.search(root, 'Lead validacao Comercial Oportunidade SDR', {
      limit: 10,
      path: 'legacy-docs',
    })
    assert.ok(scopedLegacyHits.length >= 1)
    assert.ok(
      scopedLegacyHits.every((h) => h.relPath.startsWith('legacy-docs/')),
      'Path filter must restrict search results to legacy-docs/',
    )

    const scopedSqlHits = engine.search(root, 'oportunidades status_comercial', {
      limit: 10,
      corpus: 'sql',
    })
    assert.equal(scopedSqlHits.length, 1)
    assert.equal(scopedSqlHits[0].relPath, 'legacy-docs/campos-crm.sql')

    const scopedPack = engine.context({
      repositoryPath: root,
      task: 'Lead validacao Comercial Oportunidade SDR',
      path: 'current/',
      corpus: 'docs',
      tokenBudget: 800,
    })
    assert.equal(scopedPack.files.length, 1)
    assert.equal(scopedPack.files[0].path, 'current/decisoes-vigentes.md')

    engine.close()
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})

test('DriveNexusVault: Zero-Loss Ingestion, AppsScript Unpacking, DLP Secret Vault, Sheet Query & Conflict Radar', () => {
  const rawVault = mkdtempSync(join(tmpdir(), 'kvx-nexus-raw-'))
  const storage = mkdtempSync(join(tmpdir(), 'kvx-nexus-store-'))

  try {
    mkdirSync(join(rawVault, 'current'), { recursive: true })
    mkdirSync(join(rawVault, 'quarentena'), { recursive: true })

    // 1. Current Confirmed Rule
    writeFileSync(
      join(rawVault, 'current', 'decisoes-vigentes.md'),
      [
        '# Regras Atuais do CRM',
        'Authority: CURRENT_USER_CONFIRMED',
        'Validado pelo Comercial: somente nesse momento a Oportunidade é criada. O SDR não cria a Oportunidade diretamente.',
        'Licitação já inicia como Oportunidade.',
        'Toda Oportunidade exige: NEW_LOGO, RENEWAL, AMENDMENT ou ADDITIONAL_LICENSES.',
      ].join('\n'),
    )

    // 2. Legacy Observed Document with conflicting rules
    writeFileSync(
      join(rawVault, 'quarentena', 'reuniao-legada.md'),
      [
        '# Ata de Reuniao Legada',
        'Authority: LEGACY_OBSERVED',
        'Descreve criação automática de Conta e Oportunidade ao qualificar Lead na aba preVenda.',
        'Campos livres tipo_contrato e plano_contrato na planilha Contrata.gov.',
      ].join('\n'),
    )

    // 3. Google Apps Script JSON dump with raw leaked secrets
    writeFileSync(
      join(rawVault, 'quarentena', 'Comercial.json'),
      JSON.stringify({
        files: [
          {
            name: 'api-appsheet',
            type: 'server_js',
            source: [
              "const TEMPLATE_ID = '1pFlIfGrnt3OLKc5-am9VENacsUcmKC67';",
              "const APP_KEY = 'V2-9kLmP-4xQzR-8vBnW-1aSdF';",
              "const GEMINI_KEY = '" + 'AI' + 'za' + 'SyD9876543210abcdefghijklmnopqrstuvwx' + "';",
              "function syncAppSheet() { return 'https://api.appsheet.com/api/v2/apps/12345678-1234-1234-1234-123456789abc/tables'; }",
            ].join('\n'),
          },
        ],
      }),
    )

    // 4. CSV Spreadsheet
    writeFileSync(
      join(rawVault, 'quarentena', 'preVenda.csv'),
      'id,nomeCliente,statusProposta,valor\n1,Prefeitura Municipal,Aprovada,185000\n2,Secretaria Estadual,Em analise tecnica,92000\n',
    )

    // 5. Binary artifact (must be cataloged in manifest, never lost)
    writeFileSync(join(rawVault, 'quarentena', 'gravacao-meet.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))

    const engine = new KaxcavVortexEngine(storage)
    const ingestRes = engine.nexus.ingestDirectory({
      name: 'Enterprise Audit Vault',
      sourceDir: rawVault,
      tenantSlug: 'gov-audit',
    })

    assert.equal(ingestRes.workspace.totalRawFiles, 5, 'All 5 raw files (including binary mp4) must be cataloged')
    assert.ok(ingestRes.workspace.totalDlpFindings >= 4, 'Must detect and redact AppSheet key, App ID, Google API key, and Drive Resource ID')
    assert.ok(ingestRes.workspace.totalConflicts >= 2, 'Must detect conflicts between CURRENT_USER_CONFIRMED and LEGACY_OBSERVED')

    const dlpList = engine.nexus.listDlpFindings(ingestRes.workspace.workspaceId)
    assert.ok(dlpList.some((d) => d.category === 'appsheet_access_key' && d.redactedToken === 'V2-REDACTED'))
    assert.ok(dlpList.some((d) => d.category === 'google_api_key' && d.redactedToken === 'GOOGLE_API_KEY_REDACTED'))

    const sheetRes = engine.nexus.querySheetRows({
      workspaceId: ingestRes.workspace.workspaceId,
      sheetTitle: 'preVenda',
      columnFilter: 'Aprovada',
    })
    assert.ok(sheetRes)
    assert.equal(sheetRes.matchingRows.length, 1)
    assert.equal(sheetRes.matchingRows[0].nomeCliente, 'Prefeitura Municipal')

    const apiKey = engine.nexus.createTenantApiKey({
      workspaceId: ingestRes.workspace.workspaceId,
      tenantName: 'Org Gov BR',
      planTier: 'GOV_AUDIT',
    })
    assert.ok(apiKey.rawApiKey.startsWith('vk_live_'))

    engine.close()
  } finally {
    try { rmSync(rawVault, { recursive: true, force: true }) } catch {}
    try { rmSync(storage, { recursive: true, force: true }) } catch {}
  }
})
