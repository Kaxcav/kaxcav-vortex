import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArchitectureBoundaryRule,
  ArchitectureViolation,
  BlastRadiusReport,
  ContextPackResult,
  ContextRequest,
  CycleFinding,
  EngineStatus,
  FederationLink,
  SearchHit,
  SearchOptions,
  ShardHealth,
  SlopFinding,
} from './core/types.ts'
import { checkKvxIgnore, describeKvxIgnoreBlock, KvxIgnoreError, normalizeFsPath } from './core/kvxignore.ts'
import { MultiRepoFederator } from './federation/federator.ts'
import { DriveNexusVault } from './nexus/vault.ts'
import { SubmodularPacker } from './packer/packer.ts'
import { RepositoryShard, type OutlineScope, type SymbolSlice, type TextHit } from './storage/shard.ts'

/**
 * Canonical form of a repository path on this machine (K3): absolute, no trailing
 * separator, upper-case drive letter on Windows. `c:\x`, `C:\x` and `C:/x/` are one repo.
 */
export function normalizeRepoPath(p: string): string {
  let out = resolve(p.trim().replace(/^['"]|['"]$/g, ''))
  if (/^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1)
  if (out.length > 3) out = out.replace(/[\\/]+$/, '')
  return out
}

/** Identity key for a repository path (case-insensitive on Windows). */
export function repoKey(p: string): string {
  return normalizeFsPath(normalizeRepoPath(p))
}

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)/

export interface ReadSymbolOutcome {
  matches: SymbolSlice[]
  via: 'indice' | 'busca_textual' | 'nenhum'
  reason?: string
  similar?: string[]
  textHits?: TextHit[]
}

export const KAXCAV_VORTEX_VERSION = '3.1.0-apex'

export class KaxcavVortexEngine {
  readonly storageRoot: string
  readonly nexus: DriveNexusVault
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
    this.nexus = new DriveNexusVault(this)
  }

  private initTelemetry(): void {
    this.telemetryDb.exec(`
      PRAGMA busy_timeout = 15000;
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

  /** Refuses (K7) any path blocked by .kvxignore, naming the rule that blocked it. */
  assertPathAllowed(absPath: string): void {
    const verdict = checkKvxIgnore(absPath)
    if (verdict.ignored) throw new KvxIgnoreError(describeKvxIgnoreBlock(absPath, verdict), verdict)
  }

  getOrOpenShard(repositoryPath: string): RepositoryShard {
    const norm = normalizeRepoPath(repositoryPath)
    const key = repoKey(norm)
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

  /**
   * Registers and indexes a repository incrementally (mtime/size + content hash).
   * A forced full re-extraction happens only on extractor/schema version changes or via
   * `fabrica index` / `kvx index`: forcing on every call re-parsed whole repos and reset
   * the contract-drift baseline.
   */
  addRepo(repositoryPath: string): ShardHealth {
    const shard = this.getOrOpenShard(repositoryPath)
    shard.sync(false)
    return shard.health()
  }

  removeRepo(repositoryPath: string): boolean {
    const key = repoKey(repositoryPath)
    const shard = this.shards.get(key)
    if (shard) {
      shard.close()
      this.shards.delete(key)
    }
    let removed = 0
    const rows = this.telemetryDb.prepare('SELECT repo_path FROM registered_repos').all() as Array<{ repo_path: string }>
    for (const r of rows) {
      if (repoKey(r.repo_path) === key) {
        removed += Number(this.telemetryDb.prepare('DELETE FROM registered_repos WHERE repo_path = ?').run(r.repo_path).changes)
      }
    }
    return removed > 0
  }

  loadConfiguredRepos(): string[] {
    // Keyed by repoKey so `c:\x` and `C:\x` (both present in registered_repos) count once.
    const repos = new Map<string, string>()
    const addIfValid = (p: string) => {
      if (!p) return
      const clean = p.replace(/^['"]|['"]$/g, '').trim()
      if (clean && existsSync(clean)) {
        const norm = normalizeRepoPath(clean)
        const key = repoKey(norm)
        if (!repos.has(key)) repos.set(key, norm)
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

    return [...repos.values()]
  }

  /** The configured/open repository that contains an absolute path (longest root wins). */
  findRepoForPath(absPath: string): string | null {
    const target = normalizeFsPath(absPath)
    const candidates = new Map<string, string>()
    for (const shard of this.shards.values()) candidates.set(repoKey(shard.repositoryPath), shard.repositoryPath)
    for (const r of this.loadConfiguredRepos()) candidates.set(repoKey(r), r)
    let best: string | null = null
    let bestLen = -1
    for (const [key, repo] of candidates) {
      if ((target === key || target.startsWith(key + '/')) && key.length > bestLen) {
        best = repo
        bestLen = key.length
      }
    }
    return best
  }

  /** Shard for a file argument: the given repo, or the repo that contains an absolute path. */
  private shardForFile(repositoryPath: string, fileArg: string): { shard: RepositoryShard; note?: string } {
    const shard = this.getOrOpenShard(repositoryPath)
    if (ABSOLUTE_PATH_RE.test(fileArg)) {
      this.assertPathAllowed(fileArg)
      if (!shard.resolveRepoPath(fileArg).ok) {
        const owner = this.findRepoForPath(fileArg)
        if (owner) {
          return { shard: this.getOrOpenShard(owner), note: `arquivo pertence ao repositório ${owner}; consulta feita nele` }
        }
      }
    } else if (fileArg) {
      this.assertPathAllowed(resolve(shard.repositoryPath, fileArg))
    }
    return { shard }
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

  pack(req: ContextRequest): ContextPackResult {
    return this.context(req)
  }

  search(
    repositoryPath: string,
    query: string,
    limitOrOptions: number | SearchOptions = 15,
  ): SearchHit[] {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.search(query, limitOrOptions)
  }

  affected(repositoryPath: string, files: string[]): string[] {
    if (!files.length) return []
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.affectedTests(files)
  }

  checkArchitecture(
    repositoryPath: string,
    rules: ArchitectureBoundaryRule[],
  ): { violations: ArchitectureViolation[]; cycles: CycleFinding[] } {
    const shard = this.getOrOpenShard(repositoryPath)
    shard.sync(false)
    const { graph } = shard.getCsrGraph()
    const violations = graph.checkArchitectureBoundaries(rules)
    const cycles = graph.detectCycles()
    return { violations, cycles }
  }

  scanSlop(repositoryPath: string): SlopFinding[] {
    const shard = this.getOrOpenShard(repositoryPath)
    shard.sync(false)
    return shard.scanRepoSlop()
  }

  lockSymbols(
    repositoryPath: string,
    locks: Array<{ qualifiedName: string; relPath: string; mode: 'allow_body_only' | 'frozen' }>,
  ): number {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.lockSymbols(locks)
  }

  verifySymbolLocks(
    repositoryPath: string,
  ): Array<{ qualifiedName: string; relPath: string; violation: string }> {
    const shard = this.getOrOpenShard(repositoryPath)
    return shard.verifySymbolLocks()
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

  fileOutline(repositoryPath: string, fileQuery: string, opts: { scope?: OutlineScope } = {}) {
    const { shard, note } = this.shardForFile(repositoryPath, fileQuery)
    const outline = shard.fileOutline(fileQuery, opts)
    return note ? { ...outline, note } : outline
  }

  /**
   * `C:\other\repo\src\x.ts#name` or `src/x.ts#name` → the path goes to `opts.path` (so an absolute
   * path is routed to the repository that owns it). `K.#secret` stays a member name.
   */
  private splitSymbolQuery(symbolQuery: string, opts: { path?: string }): { query: string; opts: { path?: string } } {
    if (opts.path) return { query: symbolQuery, opts }
    const q = symbolQuery.trim()
    const hashIdx = q.lastIndexOf('#')
    if (hashIdx > 0) {
      const prefix = q.slice(0, hashIdx)
      if (/[\\/]/.test(prefix) || /\.\w{1,5}$/.test(prefix)) return { query: q.slice(hashIdx + 1), opts: { ...opts, path: prefix } }
    }
    return { query: q, opts }
  }

  readSymbol(repositoryPath: string, symbolQuery: string, opts: { path?: string } = {}): SymbolSlice[] {
    const split = this.splitSymbolQuery(symbolQuery, opts)
    const { shard } = this.shardForFile(repositoryPath, split.opts.path ?? '')
    return shard.readSymbol(split.query, split.opts)
  }

  /** read_symbol that never answers a bare empty list (K1): reason, similar names, text fallback. */
  readSymbolDetailed(repositoryPath: string, rawQuery: string, rawOpts: { path?: string } = {}): ReadSymbolOutcome {
    const { query: symbolQuery, opts } = this.splitSymbolQuery(rawQuery, rawOpts)
    const { shard } = this.shardForFile(repositoryPath, opts.path ?? '')
    if (opts.path) {
      const r = shard.resolveRepoPath(opts.path)
      if (!r.ok) return { matches: [], via: 'nenhum', reason: r.reason }
    }
    const matches = shard.readSymbol(symbolQuery, opts)
    if (matches.length > 0) return { matches, via: 'indice' }
    const bare = symbolQuery.replace(/^.*[#:]/, '').split('.').pop() ?? symbolQuery
    const similar = shard.similarSymbolNames(symbolQuery)
    const textHits = bare.length >= 3 ? shard.textSearch([bare], { path: opts.path, limit: 10, wholeWord: true }) : []
    const reason =
      `nenhum símbolo '${symbolQuery}' no índice de ${shard.repositoryPath}` +
      (similar.length ? `; parecidos: ${similar.slice(0, 5).join(', ')}` : '') +
      (textHits.length ? '; ocorrências abaixo via busca textual' : '')
    return { matches: [], via: textHits.length ? 'busca_textual' : 'nenhum', reason, similar, textHits }
  }

  searchDetailed(repositoryPath: string, query: string, opts: SearchOptions = {}) {
    const shard = this.getOrOpenShard(repositoryPath)
    if (opts.path && opts.path.trim()) {
      const abs = ABSOLUTE_PATH_RE.test(opts.path) ? opts.path : resolve(shard.repositoryPath, opts.path)
      this.assertPathAllowed(abs)
    }
    return shard.searchDetailed(query, opts)
  }

  fileIndexAge(repositoryPath: string, fileQuery: string) {
    const { shard } = this.shardForFile(repositoryPath, fileQuery)
    return shard.fileIndexAge(fileQuery)
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
    const seenShards = new Set<string>()
    for (const p of paths) {
      if (existsSync(p)) {
        const shard = this.getOrOpenShard(p)
        if (seenShards.has(shard.shardPath)) continue
        seenShards.add(shard.shardPath)
        shardHealths.push(shard.health())
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
    this.nexus.close()
    try {
      this.telemetryDb.close()
    } catch {}
  }
}
