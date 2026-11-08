import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KaxcavVortexEngine } from '../engine.ts'
import { loadLocalConfig } from '../core/local-config.ts'
import type { SheetCatalogItem, VaultFileRecord } from '../nexus/vault.ts'
import {
  DriveAiGateway,
  loadAiConfig,
  maskApiKey,
  saveAiConfig,
  stripBinaryBloat,
} from './ai-gateway.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRIVE_APP_HTML_PATH = join(__dirname, 'index.html')

export interface AskCitation {
  fileUid: string
  relPath: string
  displayName: string
  folderPath: string
  authorityTier: VaultFileRecord['authorityTier']
  authorityLabel: string
  sectionTitle: string
  excerpt: string
  score: number
}

export interface AskResponsePayload {
  question: string
  elapsedMs: number
  directSummary: string
  hasPrimaryTruth: boolean
  primaryItems: AskCitation[]
  historicalItems: AskCitation[]
  relatedConflicts: Array<{
    conflictId: number
    topic: string
    severity: string
    currentFile: string
    currentRuleExcerpt: string
    legacyFile: string
    legacyRuleExcerpt: string
  }>
  relatedSheets: Array<{
    sheetId: number
    workbookPath: string
    sheetTitle: string
    rowCount: number
    colCount: number
    formulaCount: number
    matchedColumns: string[]
    sampleFormulas: Array<{ cell: string; formula: string }>
  }>
}

function mapAuthorityLabel(tier: string): string {
  switch (tier) {
    case 'CURRENT_USER_CONFIRMED':
      return 'Documento principal'
    case 'ACTIVE_OPERATIONAL':
      return 'Arquivo ativo'
    case 'LEGACY_OBSERVED':
      return 'Arquivo histórico'
    case 'LEGACY_IDEA':
      return 'Rascunho / Versão antiga'
    default:
      return 'Arquivo'
  }
}

function cleanExcerptText(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^<!--.*-->$/.test(line)) return false
      if (/^(Authority|Escopo|Fonte|Arquivo Original|SHA-256|Segredos Redigidos):/i.test(line)) return false
      if (/^-\s*\*\*(Authority|Escopo|Fonte|Arquivo Original|SHA-256|Segredos Redigidos)\*\*/i.test(line)) return false
      if (/^```/.test(line)) return false
      return true
    })

  const cleaned = lines
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length > 440 ? `${cleaned.slice(0, 437)}...` : cleaned
}

function categorizeFile(relPath: string, mimeType = ''): 'docs' | 'sheets' | 'scripts' | 'sql' | 'other' {
  const lower = relPath.toLowerCase()
  const mime = (mimeType || '').toLowerCase()
  if (
    mime.includes('spreadsheet') ||
    mime.includes('csv') ||
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv')
  ) {
    return 'sheets'
  }
  if (lower.endsWith('.sql') || lower.endsWith('.prisma') || mime.includes('sql')) {
    return 'sql'
  }
  if (
    lower.endsWith('.gs') ||
    lower.endsWith('.js') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.py') ||
    lower.endsWith('.json') ||
    lower.endsWith('.ps1') ||
    lower.endsWith('.go')
  ) {
    return 'scripts'
  }
  if (
    mime.includes('wordprocessing') ||
    mime.includes('pdf') ||
    mime.includes('markdown') ||
    lower.endsWith('.docx') ||
    lower.endsWith('.pdf') ||
    lower.endsWith('.md') ||
    lower.endsWith('.txt')
  ) {
    return 'docs'
  }
  return 'other'
}

function buildDynamicSuggestions(
  files: VaultFileRecord[],
  sheets: SheetCatalogItem[],
): Array<{ label: string; query: string }> {
  const suggestions: Array<{ label: string; query: string }> = [
    {
      label: 'Resumo geral da pasta',
      query: 'Quais são os principais documentos, pastas e assuntos presentes neste acervo?',
    },
  ]

  // Pick top spreadsheet with columns or formulas
  const richSheet = sheets.find((s) => s.headers.length > 2) ?? sheets[0]
  if (richSheet) {
    const wbName = richSheet.workbookPath.split(/[/\\]/).pop() ?? richSheet.workbookPath
    suggestions.push({
      label: `Planilha: ${wbName} (${richSheet.sheetTitle})`,
      query: `Quais são as colunas, dados e fórmulas da planilha ${wbName} na aba ${richSheet.sheetTitle}?`,
    })
  }

  // Pick top readable document (.docx, .pdf, .md)
  const topDoc = files.find((f) => {
    const ext = f.relPath.toLowerCase()
    return (
      (ext.endsWith('.docx') || ext.endsWith('.md') || ext.endsWith('.pdf')) &&
      !ext.includes('readme') &&
      !ext.includes('manifest')
    )
  })
  if (topDoc) {
    const docBase = topDoc.relPath.split(/[/\\]/).pop() ?? topDoc.relPath
    suggestions.push({
      label: `Documento: ${docBase.slice(0, 32)}`,
      query: `O que diz o documento ${docBase}? Traga os pontos principais.`,
    })
  }

  suggestions.push({
    label: 'Duplicidades e versões de arquivos',
    query: 'Existem arquivos duplicados, versões diferentes ou conflitos entre documentos neste acervo?',
  })

  return suggestions.slice(0, 5)
}

export class DriveAppServer {
  private readonly engine: KaxcavVortexEngine
  private readonly aiGateway: DriveAiGateway
  private bootstrapped = false

  constructor(engine = new KaxcavVortexEngine()) {
    this.engine = engine
    this.aiGateway = new DriveAiGateway(engine)
  }

  private ensureBootstrapped(): void {
    if (this.bootstrapped) return
    this.bootstrapped = true
    if (this.engine.nexus.listWorkspaces().length > 0) return

    const localCfg = loadLocalConfig() as ReturnType<typeof loadLocalConfig> & { driveAppVaults?: Array<{ path: string; name: string; tenantSlug: string }> }
    // Machine-specific vaults live in ~/.kvx/local.json, never in the repo.
    const defaults = localCfg.driveAppVaults ?? localCfg.defaultVaults ?? []

    for (const src of defaults) {
      if (existsSync(src.path)) {
        try {
          this.engine.nexus.ingestDirectory({
            name: src.name,
            sourceDir: src.path,
            tenantSlug: src.tenantSlug,
          })
        } catch {}
      }
    }
  }

  start(port = 4777, host = 'localhost'): Promise<{ port: number; url: string; close: () => void }> {
    this.ensureBootstrapped()

    return new Promise((resolvePromise, rejectPromise) => {
      const server = createServer((req, res) => {
        this.handleHttp(req, res).catch((err) => {
          this.sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      })

      server.on('error', rejectPromise)
      const onListening = () => {
        const addr = server.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : port
        const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
        resolvePromise({
          port: actualPort,
          url: `http://${displayHost}:${actualPort}`,
          close: () => server.close(),
        })
      }

      if (host === 'localhost' || host === '0.0.0.0' || host === '::') {
        server.listen(port, onListening)
      } else {
        server.listen(port, host, onListening)
      }
    })
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlObj = new URL(req.url ?? '/', 'http://localhost')
    const pathname = urlObj.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Anthropic-Key',
      })
      res.end()
      return
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = readFileSync(DRIVE_APP_HTML_PATH, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      this.ensureBootstrapped()
      const workspaces = this.engine.nexus.listWorkspaces()
      const defaultWs =
        (loadLocalConfig().defaultWorkspaceHint
          ? workspaces.find((w) => w.workspaceId.includes(String(loadLocalConfig().defaultWorkspaceHint)))
          : undefined) ??
        [...workspaces].sort((a, b) => b.totalRawFiles - a.totalRawFiles)[0] ??
        workspaces[0]
      const requestedId = urlObj.searchParams.get('workspaceId') || defaultWs?.workspaceId || ''
      const activeWorkspace = workspaces.find((w) => w.workspaceId === requestedId) ?? defaultWs ?? null

      const files = activeWorkspace ? this.engine.nexus.listVaultFiles(activeWorkspace.workspaceId) : []
      const sheets = activeWorkspace ? this.engine.nexus.listSpreadsheets(activeWorkspace.workspaceId) : []
      const conflicts = activeWorkspace ? this.engine.nexus.listAuthorityConflicts(activeWorkspace.workspaceId) : []
      const dlpFindings = activeWorkspace ? this.engine.nexus.listDlpFindings(activeWorkspace.workspaceId, 250) : []
      const blueprint = activeWorkspace ? this.aiGateway.buildBlueprint(activeWorkspace.workspaceId) : null
      const ledger = activeWorkspace ? this.aiGateway.buildExhaustiveLedger(activeWorkspace.workspaceId) : null
      const technicalLenses = activeWorkspace ? this.aiGateway.buildTechnicalLenses(activeWorkspace.workspaceId) : null
      const aiCfg = loadAiConfig()

      const countsByCategory = {
        all: files.length,
        docs: 0,
        sheets: 0,
        scripts: 0,
        sql: 0,
      }
      const countsByAuthority = {
        CURRENT_USER_CONFIRMED: 0,
        ACTIVE_OPERATIONAL: 0,
        LEGACY_OBSERVED: 0,
        LEGACY_IDEA: 0,
      }

      for (const f of files) {
        const cat = categorizeFile(f.relPath, f.mimeType)
        if (cat in countsByCategory) countsByCategory[cat as keyof typeof countsByCategory]++
        if (f.authorityTier in countsByAuthority) {
          countsByAuthority[f.authorityTier as keyof typeof countsByAuthority]++
        }
      }

      const suggestions = buildDynamicSuggestions(files, sheets)

      this.sendJson(res, 200, {
        workspaces,
        activeWorkspace,
        accountLabel: (loadLocalConfig() as { accountLabel?: string }).accountLabel ?? '',
        countsByCategory,
        countsByAuthority,
        suggestions,
        spreadsheets: sheets,
        conflicts,
        dlpFindings,
        blueprint,
        ledger,
        technicalLenses,
        aiConfig: {
          ok: true,
          configured: Boolean(aiCfg.apiKey),
          hasApiKey: Boolean(aiCfg.apiKey),
          provider: aiCfg.provider,
          model: aiCfg.model,
          maskedKey: maskApiKey(aiCfg.apiKey),
          updatedAt: aiCfg.updatedAt,
        },
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/files') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const category = urlObj.searchParams.get('category') ?? 'all'
      const authority = urlObj.searchParams.get('authority') ?? 'all'
      const folder = (urlObj.searchParams.get('folder') ?? '').trim().replace(/\\/g, '/')
      const q = (urlObj.searchParams.get('q') ?? '').trim().toLowerCase()

      const allFiles = wsId ? this.engine.nexus.listVaultFiles(wsId) : []

      const folderSet = new Map<string, { name: string; path: string; count: number }>()
      for (const f of allFiles) {
        const norm = f.relPath.replace(/\\/g, '/')
        if (folder && !norm.startsWith(folder + '/')) continue
        const remainder = folder ? norm.slice(folder.length + 1) : norm
        const slashIdx = remainder.indexOf('/')
        if (slashIdx !== -1) {
          const subName = remainder.slice(0, slashIdx)
          const subPath = folder ? `${folder}/${subName}` : subName
          const existing = folderSet.get(subPath)
          if (existing) existing.count++
          else folderSet.set(subPath, { name: subName, path: subPath, count: 1 })
        }
      }

      const filtered = allFiles
        .filter((f) => {
          const norm = f.relPath.replace(/\\/g, '/')
          if (folder && !norm.startsWith(folder + '/')) return false
          const cat = categorizeFile(f.relPath, f.mimeType)
          if (category !== 'all' && cat !== category) return false
          if (authority !== 'all' && f.authorityTier !== authority) return false
          if (q) {
            const hay = `${f.relPath} ${f.summary} ${f.mimeType}`.toLowerCase()
            if (!hay.includes(q)) return false
          }
          return true
        })
        .slice(0, 400)
        .map((f) => {
          const norm = f.relPath.replace(/\\/g, '/')
          const parts = norm.split('/')
          const displayName = parts[parts.length - 1] ?? norm
          const folderPath = parts.slice(0, -1).join('/')
          return {
            ...f,
            displayName,
            folderPath,
            category: categorizeFile(f.relPath, f.mimeType),
            authorityLabel: mapAuthorityLabel(f.authorityTier),
          }
        })

      this.sendJson(res, 200, {
        folders: Array.from(folderSet.values()).sort((a, b) => b.count - a.count),
        files: filtered,
        totalMatching: filtered.length,
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/ask') {
      const started = performance.now()
      const body = (await this.readJsonBody(req)) as {
        workspaceId?: string
        question?: string
        scope?: 'all' | 'current' | 'legacy'
      }
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = body.workspaceId ?? workspaces[0]?.workspaceId ?? ''
      const activeWs = workspaces.find((w) => w.workspaceId === wsId) ?? workspaces[0]
      const question = String(body.question ?? '').trim()

      if (!activeWs || !question) {
        this.sendJson(res, 400, { error: 'Digite uma pergunta ou termo para pesquisar no acervo.' })
        return
      }

      const vaultFiles = this.engine.nexus.listVaultFiles(activeWs.workspaceId)
      const byCanonicalRel = new Map<string, VaultFileRecord>()
      const byBaseName = new Map<string, VaultFileRecord>()
      for (const vf of vaultFiles) {
        if (vf.canonicalRelPath) {
          byCanonicalRel.set(vf.canonicalRelPath.replace(/\\/g, '/'), vf)
        }
        const base = vf.relPath.split(/[/\\]/).pop()?.toLowerCase() ?? ''
        if (base && !byBaseName.has(base)) byBaseName.set(base, vf)
      }

      // 1. Search canonical shard in Kaxcav Vortex (3 args: repoPath, query, SearchOptions)
      const searchHits = this.engine.search(activeWs.canonicalDir, question, {
        limit: 20,
        path: body.scope === 'current' ? 'current/' : body.scope === 'legacy' ? 'legacy' : undefined,
      })

      const primaryItems: AskCitation[] = []
      const historicalItems: AskCitation[] = []
      const seenFiles = new Set<string>()

      for (const hit of searchHits) {
        const hitRel = hit.relPath.replace(/\\/g, '/')
        const vf =
          byCanonicalRel.get(hitRel) ??
          byBaseName.get((hitRel.split('/').pop() ?? '').replace(/\.md$/, '').toLowerCase())

        let rawExcerpt = hit.signature || hit.docSummary || ''
        const fullCanonicalPath = join(activeWs.canonicalDir, hit.relPath)
        if (existsSync(fullCanonicalPath)) {
          try {
            const text = readFileSync(fullCanonicalPath, 'utf8')
            const lines = text.split(/\r?\n/)
            const startIdx = Math.max(0, (hit.startLine || 1) - 1)
            const endIdx = Math.min(lines.length, startIdx + 18)
            rawExcerpt = lines.slice(startIdx, endIdx).join('\n')
          } catch {}
        }

        const excerpt = cleanExcerptText(rawExcerpt)
        if (!excerpt) continue

        const origRel = vf ? vf.relPath.replace(/\\/g, '/') : hitRel
        const dedupKey = `${origRel}::${hit.symbolName}`
        if (seenFiles.has(dedupKey)) continue
        seenFiles.add(dedupKey)

        const tier: VaultFileRecord['authorityTier'] = vf
          ? vf.authorityTier
          : hitRel.includes('current')
            ? 'CURRENT_USER_CONFIRMED'
            : 'ACTIVE_OPERATIONAL'

        const parts = origRel.split('/')
        const citation: AskCitation = {
          fileUid: vf?.fileUid ?? hitRel,
          relPath: origRel,
          displayName: parts[parts.length - 1] ?? origRel,
          folderPath: parts.slice(0, -1).join('/'),
          authorityTier: tier,
          authorityLabel: mapAuthorityLabel(tier),
          sectionTitle: hit.symbolName.replace(/^doc_/, '').replace(/_/g, ' '),
          excerpt,
          score: hit.score,
        }

        if (tier === 'CURRENT_USER_CONFIRMED' || tier === 'ACTIVE_OPERATIONAL') {
          if (primaryItems.length < 6) primaryItems.push(citation)
        } else {
          if (historicalItems.length < 6) historicalItems.push(citation)
        }
      }

      // If general overview query and few FTS hits, populate with top documents in the workspace
      const qLower = question.toLowerCase()
      const isOverviewQuery =
        /principais documentos|resumo geral|o que existe|o que tem nesta pasta/i.test(qLower)

      if (isOverviewQuery && primaryItems.length < 4) {
        for (const vf of vaultFiles.slice(0, 8)) {
          if (vf.relPath.includes('vault-inventory-manifest')) continue
          const parts = vf.relPath.replace(/\\/g, '/').split('/')
          const displayName = parts[parts.length - 1] ?? vf.relPath
          if (primaryItems.some((p) => p.relPath === vf.relPath)) continue
          primaryItems.push({
            fileUid: vf.fileUid,
            relPath: vf.relPath,
            displayName,
            folderPath: parts.slice(0, -1).join('/'),
            authorityTier: vf.authorityTier,
            authorityLabel: mapAuthorityLabel(vf.authorityTier),
            sectionTitle: 'Visão geral do arquivo',
            excerpt: vf.summary,
            score: 10,
          })
          if (primaryItems.length >= 6) break
        }
      }

      // 2. Search Spreadsheets & Formulas matching the question
      const qTokens = question
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 3)

      const allSheets = this.engine.nexus.listSpreadsheets(activeWs.workspaceId)
      const relatedSheets: AskResponsePayload['relatedSheets'] = []

      for (const sh of allSheets) {
        const hay = `${sh.workbookPath} ${sh.sheetTitle} ${sh.headers.join(' ')}`
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
        let score = 0
        const matchedCols: string[] = []

        for (const tok of qTokens) {
          if (hay.includes(tok)) score += 2
          for (const col of sh.headers) {
            const colNorm = col.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            if (colNorm.includes(tok) && !matchedCols.includes(col)) {
              matchedCols.push(col)
              score += 3
            }
          }
        }

        if (score > 0 || ((qLower.includes('planilha') || isOverviewQuery) && relatedSheets.length < 6)) {
          relatedSheets.push({
            sheetId: sh.sheetId,
            workbookPath: sh.workbookPath,
            sheetTitle: sh.sheetTitle,
            rowCount: sh.rowCount,
            colCount: sh.colCount,
            formulaCount: sh.formulaCount,
            matchedColumns: matchedCols.slice(0, 8),
            sampleFormulas: sh.sampleFormulas.slice(0, 3),
          })
        }
      }
      relatedSheets.sort(
        (a, b) => b.matchedColumns.length - a.matchedColumns.length || b.formulaCount - a.formulaCount,
      )

      // 3. Check Conflicts / Duplicates / Version Collisions matching the question
      const allConflicts = this.engine.nexus.listAuthorityConflicts(activeWs.workspaceId)
      const seenTopics = new Set<string>()
      const isConflictQuery = /duplicad|versoes|versões|conflit|divergenc/i.test(qLower)
      const relatedConflicts = allConflicts
        .filter((c) => {
          if (seenTopics.has(c.topic)) return false
          const text = `${c.topic} ${c.currentRuleExcerpt} ${c.legacyRuleExcerpt}`
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
          const matches = isConflictQuery || qTokens.some((t) => text.includes(t))
          if (matches) {
            seenTopics.add(c.topic)
            return true
          }
          return false
        })
        .slice(0, 4)

      // 4. Synthesize direct human answer
      let directSummary = ''
      if (isOverviewQuery) {
        const mb = (activeWs.totalBytes / 1048576).toFixed(1)
        directSummary = `O acervo "${activeWs.name}" contém ${activeWs.totalRawFiles.toLocaleString('pt-BR')} arquivos indexados (${mb} MB), incluindo ${activeWs.totalSheets} abas de planilhas com ${activeWs.totalFormulas.toLocaleString('pt-BR')} fórmulas extraídas. Abaixo estão os principais documentos e tabelas encontrados na pasta.`
      } else if (isConflictQuery && relatedConflicts.length > 0) {
        directSummary = `Foram identificadas ${relatedConflicts.length} ocorrências relevantes de duplicidade, múltiplas versões ou divergência entre documentos neste acervo. Confira a comparação detalhada abaixo.`
      } else if (primaryItems.length > 0) {
        const top = primaryItems[0]!
        directSummary = `Em "${top.displayName}": ${top.excerpt}`
      } else if (relatedSheets.length > 0 && historicalItems.length === 0) {
        const topSheet = relatedSheets[0]!
        directSummary = `Encontramos dados estruturados na planilha "${topSheet.workbookPath}" (aba "${topSheet.sheetTitle}", com ${topSheet.rowCount} linhas, ${topSheet.colCount} colunas e ${topSheet.formulaCount} fórmulas).`
      } else if (historicalItems.length > 0) {
        const topHist = historicalItems[0]!
        directSummary = `Em "${topHist.displayName}" (${topHist.authorityLabel}): ${topHist.excerpt}`
      } else {
        directSummary =
          'Não encontramos um trecho exato com esses termos. Tente pesquisar pelo nome do arquivo, assunto, coluna de planilha ou navegue pela aba "Arquivos e pastas".'
      }

      const payload: AskResponsePayload = {
        question,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        directSummary,
        hasPrimaryTruth: primaryItems.length > 0,
        primaryItems,
        historicalItems,
        relatedConflicts,
        relatedSheets: relatedSheets.slice(0, 6),
      }

      this.sendJson(res, 200, payload)
      return
    }

    if (req.method === 'GET' && pathname === '/api/file-preview') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const fileUid = urlObj.searchParams.get('fileUid') ?? ''
      const relPathParam = urlObj.searchParams.get('relPath') ?? ''
      const activeWs = workspaces.find((w) => w.workspaceId === wsId) ?? workspaces[0]

      if (!activeWs) {
        this.sendJson(res, 404, { error: 'Acervo não encontrado.' })
        return
      }

      const files = this.engine.nexus.listVaultFiles(activeWs.workspaceId)
      const vf = files.find(
        (f) =>
          f.fileUid === fileUid ||
          (relPathParam && f.relPath.replace(/\\/g, '/') === relPathParam.replace(/\\/g, '/')),
      )

      let content = ''
      if (vf && vf.summary.includes('Google Apps Script')) {
        const rawStaged = join(activeWs.sourceLocation, vf.relPath)
        if (existsSync(rawStaged)) {
          try {
            const parsed = JSON.parse(readFileSync(rawStaged, 'utf8'))
            if (Array.isArray(parsed?.files)) {
              content = parsed.files
                .map(
                  (m: any, idx: number) =>
                    `// ============================================================================\n// MÓDULO ${idx + 1}: ${m.name ?? 'modulo'} (${m.type ?? 'js'})\n// ============================================================================\n\n${String(m.source ?? '')}`,
                )
                .join('\n\n')
            }
          } catch {}
        }
      }

      if (!content && vf && vf.canonicalRelPath) {
        const fullCanonical = join(activeWs.canonicalDir, vf.canonicalRelPath)
        if (existsSync(fullCanonical)) {
          content = readFileSync(fullCanonical, 'utf8')
        }
      } else if (!content && fileUid && existsSync(join(activeWs.canonicalDir, fileUid))) {
        content = readFileSync(join(activeWs.canonicalDir, fileUid), 'utf8')
      }

      content = stripBinaryBloat(content)

      const allSheets = this.engine.nexus.listSpreadsheets(activeWs.workspaceId)
      const fileSheets = vf
        ? allSheets.filter((s) => s.workbookPath.replace(/\\/g, '/') === vf.relPath.replace(/\\/g, '/'))
        : []

      this.sendJson(res, 200, {
        file: vf
          ? {
              ...vf,
              authorityLabel: mapAuthorityLabel(vf.authorityTier),
              category: categorizeFile(vf.relPath, vf.mimeType),
            }
          : null,
        content,
        sheets: fileSheets,
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/sheet-preview') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const sheetId = Number(urlObj.searchParams.get('sheetId') ?? 0)
      const workbook = urlObj.searchParams.get('workbook') ?? ''
      const sheet = urlObj.searchParams.get('sheet') ?? ''

      const sheetData = this.engine.nexus.querySheet({
        workspaceId: wsId,
        sheetId: sheetId || undefined,
        workbookFilter: workbook || undefined,
        sheetFilter: sheet || undefined,
      })

      this.sendJson(res, 200, { sheetData })
      return
    }

    if (req.method === 'GET' && pathname === '/api/fs-browse') {
      const rawDir = (urlObj.searchParams.get('dir') ?? 'C:\\').trim()
      const targetDir = existsSync(rawDir) ? resolve(rawDir) : 'C:\\'
      const entries: Array<{ name: string; fullPath: string; fileCountHint: number }> = []

      try {
        const items = readdirSync(targetDir, { withFileTypes: true })
        for (const item of items) {
          if (!item.isDirectory()) continue
          if (item.name.startsWith('$') || item.name === 'System Volume Information' || item.name === 'node_modules') {
            continue
          }
          const fullPath = join(targetDir, item.name)
          entries.push({
            name: item.name,
            fullPath,
            fileCountHint: 0,
          })
        }
      } catch {}

      entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      const parentDir = dirname(targetDir) !== targetDir ? dirname(targetDir) : null

      this.sendJson(res, 200, {
        currentDir: targetDir,
        parentDir,
        shortcuts: [
          { label: 'Disco Local (C:\\)', path: 'C:\\' },
          ...(loadLocalConfig().driveShortcuts ?? []),
          { label: 'Usuários (C:\\Users)', path: 'C:\\Users' },
        ].filter((s) => existsSync(s.path)),
        directories: entries.slice(0, 80),
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/connect-folder') {
      const body = (await this.readJsonBody(req)) as {
        sourceDir?: string
        name?: string
      }
      const sourceDir = String(body.sourceDir ?? '').trim()
      if (!sourceDir || !existsSync(sourceDir)) {
        this.sendJson(res, 400, { error: 'A pasta informada não foi encontrada neste computador.' })
        return
      }
      const folderBase = sourceDir.split(/[/\\]/).filter(Boolean).pop() ?? 'Pasta Local'
      const name = String(body.name ?? '').trim() || folderBase
      const result = this.engine.nexus.ingestDirectory({
        name,
        sourceDir: resolve(sourceDir),
      })
      this.sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && pathname === '/api/connect-drive') {
      const body = (await this.readJsonBody(req)) as {
        folderIdOrUrl?: string
        name?: string
        accessToken?: string
        apiKey?: string
      }
      const folderIdOrUrl = String(body.folderIdOrUrl ?? '').trim()
      if (!folderIdOrUrl) {
        this.sendJson(res, 400, { error: 'Cole o link da pasta do Google Drive ou o ID da pasta.' })
        return
      }
      const name = String(body.name ?? '').trim() || 'Pasta do Google Drive'
      const result = await this.engine.nexus.syncGoogleDriveWorkspace({
        name,
        folderIdOrUrl,
        accessToken: body.accessToken ? String(body.accessToken).trim() : undefined,
        apiKey: body.apiKey ? String(body.apiKey).trim() : undefined,
        maxFiles: 150,
      })
      this.sendJson(res, 200, result)
      return
    }

    // =========================================================================
    // UNIVERSAL AI CONTEXT GATEWAY ENDPOINTS (/api/v1/ai/*)
    // =========================================================================

    if (req.method === 'GET' && pathname === '/api/v1/ai/blueprint') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const format = (urlObj.searchParams.get('format') ?? 'json').toLowerCase()
      const blueprint = this.aiGateway.buildBlueprint(wsId)
      if (format === 'markdown' || format === 'md') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(blueprint.markdownBlueprint)
        return
      }
      this.sendJson(res, 200, blueprint)
      return
    }

    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/v1/ai/context-pack') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const body =
        req.method === 'POST'
          ? ((await this.readJsonBody(req)) as {
              workspaceId?: string
              query?: string
              maxTokens?: number
              format?: string
            })
          : {}
      const wsId =
        body.workspaceId ?? urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const query =
        body.query ?? urlObj.searchParams.get('query') ?? urlObj.searchParams.get('q') ?? ''
      const maxTokens = Number(body.maxTokens ?? urlObj.searchParams.get('maxTokens') ?? 45000)
      const format = String(body.format ?? urlObj.searchParams.get('format') ?? 'json').toLowerCase()

      const pack = this.aiGateway.buildContextPack({
        workspaceId: wsId,
        query,
        maxTokens,
      })

      if (format === 'markdown' || format === 'md') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(pack.contextMarkdown)
        return
      }
      this.sendJson(res, 200, pack)
      return
    }

    if (req.method === 'GET' && pathname === '/api/v1/ai/lenses') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const lenses = this.aiGateway.buildTechnicalLenses(wsId)
      this.sendJson(res, 200, lenses)
      return
    }

    if (req.method === 'GET' && pathname === '/api/v1/ai/ledger') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const format = (urlObj.searchParams.get('format') ?? 'json').toLowerCase()
      const ledger = this.aiGateway.buildExhaustiveLedger(wsId)
      if (format === 'markdown' || format === 'md') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(ledger.ledgerMarkdown)
        return
      }
      this.sendJson(res, 200, ledger)
      return
    }

    if (req.method === 'POST' && pathname === '/api/v1/ai/analyze') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const body = (await this.readJsonBody(req)) as {
        workspaceId?: string
        question?: string
        mode?: 'standard' | 'exhaustive_map_reduce'
        apiKey?: string
        model?: string
      }
      const wsId = body.workspaceId ?? workspaces[0]?.workspaceId ?? ''
      const question = String(body.question ?? '').trim()
      if (!question) {
        this.sendJson(res, 400, { error: 'Informe a pergunta ou análise que deseja executar.' })
        return
      }

      const headerKey =
        (req.headers['x-anthropic-key'] as string) ??
        (req.headers['x-api-key'] as string) ??
        String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')

      const result = await this.aiGateway.analyzeWithAi({
        workspaceId: wsId,
        question,
        mode: body.mode,
        apiKeyOverride: body.apiKey?.trim() || headerKey?.trim() || undefined,
        modelOverride: body.model?.trim() || undefined,
      })
      this.sendJson(res, 200, result)
      return
    }

    if (req.method === 'GET' && pathname === '/api/v1/ai/config') {
      const cfg = loadAiConfig()
      const configPayload = {
        configured: Boolean(cfg.apiKey),
        hasApiKey: Boolean(cfg.apiKey),
        provider: cfg.provider,
        model: cfg.model,
        maskedKey: maskApiKey(cfg.apiKey),
        updatedAt: cfg.updatedAt,
      }
      this.sendJson(res, 200, {
        ok: true,
        ...configPayload,
        config: configPayload,
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/v1/ai/config') {
      const body = (await this.readJsonBody(req)) as {
        apiKey?: string
        provider?: 'anthropic' | 'openai' | 'gemini'
        model?: string
      }
      const saved = saveAiConfig(body)
      const configPayload = {
        configured: Boolean(saved.apiKey),
        hasApiKey: Boolean(saved.apiKey),
        provider: saved.provider,
        model: saved.model,
        maskedKey: maskApiKey(saved.apiKey),
        updatedAt: saved.updatedAt,
      }
      this.sendJson(res, 200, {
        ok: true,
        ...configPayload,
        config: configPayload,
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/v1/ai/openapi.json') {
      const workspaces = this.engine.nexus.listWorkspaces()
      const wsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const activeWs = workspaces.find((w) => w.workspaceId === wsId) ?? workspaces[0] ?? null
      const hostHeader = req.headers.host ?? 'localhost:4777'
      const proto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']) : 'http'
      const spec = this.aiGateway.buildOpenApiSpec(`${proto}://${hostHeader}`, activeWs)
      this.sendJson(res, 200, spec)
      return
    }

    this.sendJson(res, 404, { error: 'Rota não encontrada.' })
  }

  private readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (!raw) {
          resolvePromise({})
          return
        }
        try {
          resolvePromise(JSON.parse(raw))
        } catch (err) {
          rejectPromise(err)
        }
      })
      req.on('error', rejectPromise)
    })
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    const payload = JSON.stringify(data)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(payload)
  }
}
