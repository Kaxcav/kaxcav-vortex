import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextRequest } from '../core/types.ts'
import { KaxcavVortexEngine } from '../engine.ts'
import { loadLocalConfig } from '../core/local-config.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML_PATH = join(__dirname, 'dashboard.html')

export class VortexDashboardServer {
  private readonly engine: KaxcavVortexEngine
  private bootstrappedDefaultVault = false

  constructor(engine = new KaxcavVortexEngine()) {
    this.engine = engine
  }

  private getActiveRepos(): string[] {
    return this.engine.loadConfiguredRepos()
  }

  private ensureDefaultWorkspacesBootstrapped(): void {
    if (this.bootstrappedDefaultVault) return
    this.bootstrappedDefaultVault = true
    if (this.engine.nexus.listWorkspaces().length > 0) return

    // Machine-specific vaults live in ~/.kvx/local.json (defaultVaults), never in the repo.
    const defaultSources = loadLocalConfig().defaultVaults ?? []

    for (const src of defaultSources) {
      if (existsSync(src.path)) {
        try {
          const res = this.engine.nexus.ingestDirectory({
            name: src.name,
            sourceDir: src.path,
            tenantSlug: src.tenantSlug,
          })
          if (this.engine.nexus.listTenantApiKeys(res.workspace.workspaceId).length === 0) {
            this.engine.nexus.createTenantApiKey({
              workspaceId: res.workspace.workspaceId,
              tenantName: src.name,
              planTier: 'ENTERPRISE_UNLIMITED',
              monthlyQuota: 500_000,
            })
          }
        } catch {}
      }
    }
  }

  start(port = 7788, host = 'localhost'): Promise<{ port: number; url: string; close: () => void }> {
    const activeRepos = this.getActiveRepos()
    try {
      this.engine.federate(activeRepos)
    } catch (err) {
      // Federation is an enrichment: a busy/locked shard must not keep the dashboard down.
      process.stderr.write(`federação adiada: ${err instanceof Error ? err.message : String(err)}\n`)
    }

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
        const url = `http://${displayHost}:${actualPort}`
        resolvePromise({
          port: actualPort,
          url,
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
    const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = urlObj.pathname

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = readFileSync(DASHBOARD_HTML_PATH, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      const activeRepos = this.getActiveRepos()
      const federationLinks = this.engine.federate(activeRepos)
      const status = this.engine.status(activeRepos)
      const recentQueries = this.engine.recentQueries(30)
      this.sendJson(res, 200, { status, federationLinks, recentQueries })
      return
    }

    if (req.method === 'GET' && pathname === '/api/presets') {
      this.sendJson(res, 200, { presets: loadLocalConfig().presets ?? [] })
      return
    }

    if (req.method === 'POST' && pathname === '/api/repos') {
      const body = (await this.readJsonBody(req)) as { path?: string }
      const targetPath = String(body.path ?? '').trim()
      if (!targetPath || !existsSync(targetPath)) {
        this.sendJson(res, 400, { error: 'Diretório não encontrado no disco.' })
        return
      }
      const shardHealth = this.engine.addRepo(resolve(targetPath))
      const activeRepos = this.getActiveRepos()
      const federationLinks = this.engine.federate(activeRepos)
      this.sendJson(res, 200, { added: shardHealth, repos: activeRepos, federationLinks })
      return
    }

    // Drive Nexus Enterprise Endpoints
    if (req.method === 'GET' && pathname === '/api/nexus/overview') {
      this.ensureDefaultWorkspacesBootstrapped()
      const workspaces = this.engine.nexus.listWorkspaces()
      const requestedWsId = urlObj.searchParams.get('workspaceId') ?? workspaces[0]?.workspaceId ?? ''
      const fileFilter = urlObj.searchParams.get('filter') ?? ''
      const activeWorkspace = requestedWsId ? this.engine.nexus.getWorkspace(requestedWsId) : null

      const files = activeWorkspace
        ? this.engine.nexus.listVaultFiles(activeWorkspace.workspaceId, fileFilter)
        : []
      const spreadsheets = activeWorkspace
        ? this.engine.nexus.listSpreadsheets(activeWorkspace.workspaceId)
        : []
      const dlpFindings = activeWorkspace
        ? this.engine.nexus.listDlpFindings(activeWorkspace.workspaceId)
        : []
      const conflicts = activeWorkspace
        ? this.engine.nexus.listAuthorityConflicts(activeWorkspace.workspaceId)
        : []
      const apiKeys = this.engine.nexus.listTenantApiKeys(activeWorkspace?.workspaceId)

      this.sendJson(res, 200, {
        workspaces,
        activeWorkspace,
        files,
        spreadsheets,
        dlpFindings,
        conflicts,
        apiKeys,
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/nexus/ingest') {
      const body = (await this.readJsonBody(req)) as {
        name?: string
        sourceDir?: string
        tenantSlug?: string
      }
      const sourceDir = String(body.sourceDir ?? '').trim()
      const name = String(body.name ?? (sourceDir.split(/[\\/]/).pop() || 'Drive Vault')).trim()
      if (!sourceDir || !existsSync(sourceDir)) {
        this.sendJson(res, 400, { error: 'Diretório de origem não encontrado no disco.' })
        return
      }
      const result = this.engine.nexus.ingestDirectory({
        name,
        sourceDir,
        tenantSlug: body.tenantSlug,
      })
      this.sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && pathname === '/api/nexus/drive-sync') {
      const body = (await this.readJsonBody(req)) as {
        name?: string
        folderIdOrUrl?: string
        accessToken?: string
        apiKey?: string
        maxFiles?: number
      }
      const folderIdOrUrl = String(body.folderIdOrUrl ?? '').trim()
      if (!folderIdOrUrl) {
        this.sendJson(res, 400, { error: 'Informe o Folder ID ou URL do Google Drive.' })
        return
      }
      const name = String(body.name ?? `Google Drive (${folderIdOrUrl.slice(0, 14)})`).trim()
      const result = await this.engine.nexus.syncGoogleDriveWorkspace({
        name,
        folderIdOrUrl,
        accessToken: body.accessToken ? String(body.accessToken).trim() : undefined,
        apiKey: body.apiKey ? String(body.apiKey).trim() : undefined,
        maxFiles: body.maxFiles ? Number(body.maxFiles) : 120,
      })
      this.sendJson(res, 200, result)
      return
    }

    if (req.method === 'GET' && pathname === '/api/nexus/sheet') {
      const workspaceId = urlObj.searchParams.get('workspaceId') ?? ''
      const sheetId = urlObj.searchParams.get('sheetId')
        ? Number(urlObj.searchParams.get('sheetId'))
        : undefined
      const sheetTitle = urlObj.searchParams.get('sheetTitle') ?? undefined
      const columnFilter = urlObj.searchParams.get('filter') ?? undefined
      const sheetData = this.engine.nexus.querySheetRows({
        workspaceId,
        sheetId,
        sheetTitle,
        columnFilter,
        limit: 100,
      })
      this.sendJson(res, 200, { sheetData })
      return
    }

    if (req.method === 'POST' && pathname === '/api/nexus/api-keys') {
      const body = (await this.readJsonBody(req)) as {
        workspaceId?: string
        tenantName?: string
        planTier?: 'PRO_TEAM' | 'ENTERPRISE_UNLIMITED' | 'GOV_AUDIT'
        monthlyQuota?: number
      }
      const workspaceId = String(body.workspaceId ?? '').trim()
      const tenantName = String(body.tenantName ?? 'Cliente Enterprise B2B').trim()
      if (!workspaceId) {
        this.sendJson(res, 400, { error: 'Selecione um Workspace válido.' })
        return
      }
      const created = this.engine.nexus.createTenantApiKey({
        workspaceId,
        tenantName,
        planTier: body.planTier ?? 'ENTERPRISE_UNLIMITED',
        monthlyQuota: body.monthlyQuota ? Number(body.monthlyQuota) : 500_000,
      })
      this.sendJson(res, 200, { created })
      return
    }

    const fallbackRepo = this.getActiveRepos()[0] ?? process.cwd()

    if (req.method === 'GET' && pathname === '/api/topology') {
      const repo = resolve(urlObj.searchParams.get('repo') ?? fallbackRepo)
      const topo = this.engine.topology(repo)
      this.sendJson(res, 200, topo)
      return
    }

    if (req.method === 'GET' && pathname === '/api/outline') {
      const repo = resolve(urlObj.searchParams.get('repo') ?? fallbackRepo)
      const file = urlObj.searchParams.get('file') ?? ''
      const outline = this.engine.fileOutline(repo, file)
      this.sendJson(res, 200, { outline })
      return
    }

    if (req.method === 'GET' && pathname === '/api/blast') {
      const repo = resolve(urlObj.searchParams.get('repo') ?? fallbackRepo)
      const target = urlObj.searchParams.get('target') ?? ''
      const report = this.engine.blastRadius(repo, target)
      this.sendJson(res, 200, report)
      return
    }

    if (req.method === 'GET' && pathname === '/api/diff-impact') {
      const repo = resolve(urlObj.searchParams.get('repo') ?? fallbackRepo)
      const report = this.engine.diffImpact(repo, 120)
      this.sendJson(res, 200, report)
      return
    }

    if (req.method === 'POST' && pathname === '/api/context') {
      const body = (await this.readJsonBody(req)) as Partial<ContextRequest>
      const pack = this.engine.context({
        repositoryPath: resolve(body.repositoryPath ?? fallbackRepo),
        task: String(body.task ?? 'architecture overview'),
        tokenBudget: Number(body.tokenBudget ?? 1800),
        fidelity: body.fidelity ?? 'graded',
        path: body.path,
        corpus: body.corpus,
        deltaFrom: body.deltaFrom,
        ifNoneMatch: body.ifNoneMatch,
        includeFederation: Boolean(body.includeFederation),
      })
      this.sendJson(res, 200, pack)
      return
    }

    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = (await this.readJsonBody(req)) as { repo?: string }
      const repo = resolve(body.repo ?? fallbackRepo)
      const shard = this.engine.getOrOpenShard(repo)
      const syncStats = shard.sync(true)
      this.sendJson(res, 200, syncStats)
      return
    }

    this.sendJson(res, 404, { error: 'Not found' })
  }

  private readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolvePromise(raw ? JSON.parse(raw) : {})
        } catch (err) {
          rejectPromise(err)
        }
      })
      req.on('error', rejectPromise)
    })
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(data))
  }
}
