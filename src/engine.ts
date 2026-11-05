import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  BlastRadiusReport,
  ContextPackResult,
  ContextRequest,
  EngineStatus,
  FederationLink,
  SearchHit,
  ShardHealth,
} from './core/types.ts'
import { MultiRepoFederator } from './federation/federator.ts'
import { SubmodularPacker } from './packer/packer.ts'
import { RepositoryShard } from './storage/shard.ts'

export const KAXCAV_VORTEX_VERSION = '2.0.0-apex'

export class KaxcavVortexEngine {
  readonly storageRoot: string
  private readonly shards = new Map<string, RepositoryShard>()
  private readonly packer = new SubmodularPacker()
  private readonly federator = new MultiRepoFederator()
  private readonly telemetryDb: DatabaseSync
  private cachedFederationLinks: FederationLink[] = []

  constructor(storageRoot?: string) {
    this.storageRoot = resolve(
      storageRoot ?? process.env.KVX_HOME ?? join(homedir(), '.kaxcav-vortex'),
    )
    mkdirSync(this.storageRoot, { recursive: true })
    this.telemetryDb = new DatabaseSync(join(this.storageRoot, 'telemetry.sqlite'))
    this.initTelemetry()
  }

  private initTelemetry(): void {
    this.telemetryDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 8388608;

      CREATE TABLE IF NOT EXISTS query_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        repo TEXT NOT NULL,
        task TEXT NOT NULL,
        tokens_returned INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        elapsed_ms REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registered_repos (
        repo_path TEXT PRIMARY KEY,
        added_at TEXT NOT NULL
      );
    `)
  }

  getOrOpenShard(repositoryPath: string): RepositoryShard {
    const norm = resolve(repositoryPath)
    const key = norm.toLowerCase()
    let shard = this.shards.get(key)
    if (!shard) {
      shard = new RepositoryShard(norm, join(this.storageRoot, 'shards'))
      this.shards.set(key, shard)
      this.telemetryDb
        .prepare('INSERT OR IGNORE INTO registered_repos(repo_path, added_at) VALUES (?, ?)')
        .run(norm, new Date().toISOString())
    }
    return shard
  }

  addRepo(repositoryPath: string): ShardHealth {
    const shard = this.getOrOpenShard(repositoryPath)
    shard.sync(false)
    return shard.health()
  }

  removeRepo(repositoryPath: string): boolean {
    const norm = resolve(repositoryPath)
    const key = norm.toLowerCase()
    const shard = this.shards.get(key)
    if (shard) {
      shard.close()
      this.shards.delete(key)
    }
    const res = this.telemetryDb
      .prepare('DELETE FROM registered_repos WHERE lower(repo_path) = ?')
      .run(key)
    return Number(res.changes) > 0
  }

  loadConfiguredRepos(): string[] {
    const repos = new Set<string>()
    const addIfValid = (p: string) => {
      if (!p) return
      const clean = p.replace(/^['"]|['"]$/g, '').trim()
      if (clean && existsSync(clean)) {
        repos.add(resolve(clean))
      }
    }

    if (process.env.KVX_REPOS) {
      for (const part of process.env.KVX_REPOS.split(/[;,]/)) {
        addIfValid(part)
      }
    }

    const rows = this.telemetryDb
      .prepare('SELECT repo_path FROM registered_repos ORDER BY added_at ASC')
      .all() as Array<{ repo_path: string }>
    for (const r of rows) addIfValid(r.repo_path)

    for (const cfgFile of [join(homedir(), '.kvx', 'config.yaml')]) {
      if (existsSync(cfgFile)) {
        try {
          const raw = readFileSync(cfgFile, 'utf8')
          for (const line of raw.split(/\r?\n/)) {
            const m = /^\s*-\s*path:\s*(.+?)\s*$/.exec(line)
            if (m?.[1]) addIfValid(m[1])
          }
        } catch {}
      }
    }

    if (repos.size === 0) {
      addIfValid(process.cwd())
    }

    return [...repos]
  }

  context(req: ContextRequest): ContextPackResult {
    const shard = this.getOrOpenShard(req.repositoryPath)
    const fedLinks = req.includeFederation
      ? this.cachedFederationLinks.filter(
          (l) =>
            l.sourceRepo.toLowerCase() === shard.repositoryPath.toLowerCase() ||
            l.targetRepo.toLowerCase() === shard.repositoryPath.toLowerCase(),
        )
      : []

    const result = this.packer.pack(shard, req, fedLinks)
    this.recordTelemetry(
      shard.repositoryPath,
      req.task,
      result.tokenCount,
      result.tokensSaved,
      result.elapsedMs,
    )
    return result
  }

  search(repositoryPath: string, query: string, limit = 15): SearchHit[] {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.search(query, limit)
  }

  affected(repositoryPath: string, files: string[]): string[] {
    if (!files.length) return []
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.affectedTests(files)
  }

  blastRadius(repositoryPath: string, targetSymbolOrPath: string): BlastRadiusReport {
    const shard = this.getOrOpenShard(repositoryPath)
    const report = shard.computeBlastRadius(targetSymbolOrPath)
    const lowerTarget = targetSymbolOrPath.toLowerCase()
    report.crossRepoImpacts = this.cachedFederationLinks.filter(
      (l) =>
        l.targetSymbol.toLowerCase().includes(lowerTarget) ||
        l.sourceSymbol.toLowerCase().includes(lowerTarget) ||
        l.targetFile.toLowerCase().includes(lowerTarget),
    )
    return report
  }

  federate(repoPaths?: string[]): FederationLink[] {
    const paths = repoPaths?.length ? repoPaths : this.loadConfiguredRepos()
    const activeShards = paths
      .filter((p) => existsSync(p))
      .map((p) => this.getOrOpenShard(p))
    this.cachedFederationLinks = this.federator.discoverLinks(activeShards)
    return this.cachedFederationLinks
  }

  fileOutline(repositoryPath: string, fileQuery: string) {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.fileOutline(fileQuery)
  }

  readSymbol(repositoryPath: string, symbolQuery: string) {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.readSymbol(symbolQuery)
  }

  callGraph(repositoryPath: string, symbolName: string) {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.callGraph(symbolName)
  }

  diffImpact(repositoryPath: string, windowMinutes = 60) {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.diffImpact(windowMinutes)
  }

  topology(repositoryPath: string) {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.getTopology()
  }

  recentQueries(limit = 40): Array<{
    id: number
    ts: string
    repo: string
    task: string
    tokensReturned: number
    tokensSaved: number
    elapsedMs: number
  }> {
    return this.telemetryDb
      .prepare(
        `SELECT
          id, ts, repo, task,
          tokens_returned AS tokensReturned,
          tokens_saved AS tokensSaved,
          elapsed_ms AS elapsedMs
         FROM query_telemetry
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number
      ts: string
      repo: string
      task: string
      tokensReturned: number
      tokensSaved: number
      elapsedMs: number
    }>
  }

  status(repoPaths?: string[]): EngineStatus {
    const paths = repoPaths?.length ? repoPaths : this.loadConfiguredRepos()
    const shardHealths: ShardHealth[] = []
    for (const p of paths) {
      if (existsSync(p)) {
        shardHealths.push(this.getOrOpenShard(p).health())
      }
    }

    const mem = process.memoryUsage()
    const tRow = this.telemetryDb
      .prepare(
        `SELECT
          COUNT(*) AS totalQueries,
          COALESCE(SUM(tokens_returned), 0) AS totalReturned,
          COALESCE(SUM(tokens_saved), 0) AS totalSaved,
          COALESCE(AVG(elapsed_ms), 0) AS avgLatency
         FROM query_telemetry`,
      )
      .get() as {
      totalQueries: number
      totalReturned: number
      totalSaved: number
      avgLatency: number
    }

    const denom = tRow.totalReturned + tRow.totalSaved
    const savingsPercent = denom > 0 ? Math.round((tRow.totalSaved / denom) * 1000) / 10 : 0

    return {
      engine: 'kaxcav-vortex',
      version: KAXCAV_VORTEX_VERSION,
      startup_phase: 'serving',
      status: 'ready',
      pid: process.pid,
      heap_alloc_bytes: mem.heapUsed,
      rss_bytes: mem.rss,
      shards: shardHealths,
      federationEdges: this.cachedFederationLinks.length,
      telemetry: {
        totalQueries: tRow.totalQueries,
        totalTokensReturned: tRow.totalReturned,
        totalTokensSaved: tRow.totalSaved,
        savingsPercent,
        avgLatencyMs: Math.round(tRow.avgLatency * 100) / 100,
      },
    }
  }

  private recordTelemetry(
    repo: string,
    task: string,
    tokensReturned: number,
    tokensSaved: number,
    elapsedMs: number,
  ): void {
    try {
      this.telemetryDb
        .prepare(
          `INSERT INTO query_telemetry(ts, repo, task, tokens_returned, tokens_saved, elapsed_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(new Date().toISOString(), repo, task.slice(0, 200), tokensReturned, tokensSaved, elapsedMs)
    } catch {}
  }

  close(): void {
    for (const shard of this.shards.values()) {
      shard.close()
    }
    this.shards.clear()
    try {
      this.telemetryDb.close()
    } catch {}
  }
}
