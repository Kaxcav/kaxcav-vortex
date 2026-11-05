import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextRequest } from '../core/types.ts'
import { KaxcavVortexEngine } from '../engine.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML_PATH = join(__dirname, 'dashboard.html')

export class VortexDashboardServer {
  private readonly engine: KaxcavVortexEngine

  constructor(engine = new KaxcavVortexEngine()) {
    this.engine = engine
  }

  private getActiveRepos(): string[] {
    return this.engine.loadConfiguredRepos()
  }

  start(port = 7788, host = '127.0.0.1'): Promise<{ port: number; url: string; close: () => void }> {
    const activeRepos = this.getActiveRepos()
    this.engine.federate(activeRepos)

    return new Promise((resolvePromise, rejectPromise) => {
      const server = createServer((req, res) => {
        this.handleHttp(req, res).catch((err) => {
          this.sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      })

      server.on('error', rejectPromise)
      server.listen(port, host, () => {
        const addr = server.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : port
        const url = `http://${host}:${actualPort}`
        resolvePromise({
          port: actualPort,
          url,
          close: () => server.close(),
        })
      })
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
