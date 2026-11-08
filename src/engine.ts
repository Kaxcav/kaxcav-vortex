import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { AdmissionFirewall } from './core/firewall.ts'
import { applyLineEdit, lockViolations, sliceLines, SYMBOL_EDIT_OPS, type SymbolEditOp, type SymbolLock } from './edit/symbol-editor.ts'
import { PolyglotExtractor } from './parser/extractor.ts'
import { MultiRepoFederator } from './federation/federator.ts'
import { DriveNexusVault } from './nexus/vault.ts'
import { SubmodularPacker } from './packer/packer.ts'
import { syntaxErrorCount, treeSitterStatus } from './parser/treesitter.ts'
import { RepositoryShard, type OutlineScope, type ReferencesResult, type SymbolSlice, type TextHit } from './storage/shard.ts'

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

export interface SymbolEditRequest {
  symbol: string
  path?: string
  op: SymbolEditOp
  /** Whole lines that replace the symbol / are inserted next to it. Not used by `delete`. */
  text?: string
  /** `hash` returned by read_symbol: refuses when the symbol changed since it was read. */
  expectedHash?: string
  dryRun?: boolean
  allowSyntaxErrors?: boolean
}

export interface SymbolEditOutcome {
  ok: boolean
  reason?: string
  candidates?: string[]
  violations?: Array<{ qualifiedName: string; mode: string; violation: string; source: string }>
  dryRun?: boolean
  file?: string
  op?: SymbolEditOp
  symbol?: string
  before?: { startLine: number; endLine: number; hash: string }
  after?: { startLine: number; endLine: number; qualifiedName?: string; hash?: string }
  linesRemoved?: number
  linesAdded?: number
  syntaxErrors?: { before: number | null; after: number | null }
  preview?: string
}

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
  /**
   * An engine on an explicit storage root (tests, embedders) stays isolated: it does not
   * pick up the user's ~/.kvx/config.yaml repos, which status()/bench would then open and sync.
   */
  private readonly readsGlobalConfig: boolean

  constructor(storageRoot?: string) {
    this.readsGlobalConfig = storageRoot === undefined
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

      -- Symbol locks live here, not in the shard: shard files change with the extractor
      -- version and mode (tree-sitter or not), locks must survive both.
      CREATE TABLE IF NOT EXISTS symbol_locks (
        repo_key TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        lock_mode TEXT NOT NULL,
        baseline_signature TEXT NOT NULL,
        baseline_body_hash TEXT NOT NULL,
        locked_at TEXT NOT NULL,
        PRIMARY KEY (repo_key, qualified_name)
      );
    `)
  }

  /** Refuses (K7) any path blocked by .kvxignore, naming the rule that blocked it. */
  assertPathAllowed(absPath: string, opts: { fresh?: boolean } = {}): void {
    const verdict = checkKvxIgnore(absPath, undefined, opts)
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

    for (const cfgFile of this.readsGlobalConfig ? [join(homedir(), '.kvx', 'config.yaml')] : []) {
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
    shard.syncNow()
    const key = repoKey(shard.repositoryPath)
    const now = new Date().toISOString()
    const stmt = this.telemetryDb.prepare(
      `INSERT OR REPLACE INTO symbol_locks (repo_key, qualified_name, rel_path, lock_mode, baseline_signature, baseline_body_hash, locked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    let locked = 0
    for (const l of locks) {
      const base = shard.findSymbolBaseline(l.qualifiedName)
      if (!base) continue
      stmt.run(key, l.qualifiedName, l.relPath || base.relPath, l.mode, base.signature, base.bodyHash, now)
      locked++
    }
    return locked
  }

  unlockSymbols(repositoryPath: string, qualifiedNames?: string[]): number {
    const key = repoKey(repositoryPath)
    if (!qualifiedNames?.length) {
      return Number(this.telemetryDb.prepare('DELETE FROM symbol_locks WHERE repo_key = ?').run(key).changes)
    }
    const stmt = this.telemetryDb.prepare('DELETE FROM symbol_locks WHERE repo_key = ? AND qualified_name = ?')
    return qualifiedNames.reduce((n, q) => n + Number(stmt.run(key, q).changes), 0)
  }

  verifySymbolLocks(
    repositoryPath: string,
  ): Array<{ qualifiedName: string; relPath: string; violation: string }> {
    const shard = this.getOrOpenShard(repositoryPath)
    shard.syncNow()
    const rows = this.telemetryDb
      .prepare('SELECT qualified_name, rel_path, lock_mode, baseline_signature, baseline_body_hash FROM symbol_locks WHERE repo_key = ?')
      .all(repoKey(shard.repositoryPath)) as Array<{
      qualified_name: string
      rel_path: string
      lock_mode: string
      baseline_signature: string
      baseline_body_hash: string
    }>
    const violations: Array<{ qualifiedName: string; relPath: string; violation: string }> = []
    for (const lock of rows) {
      const sym = shard.findSymbolBaseline(lock.qualified_name)
      if (!sym) {
        violations.push({ qualifiedName: lock.qualified_name, relPath: lock.rel_path, violation: 'Symbol deleted' })
      } else if (lock.lock_mode === 'frozen' && sym.bodyHash !== lock.baseline_body_hash) {
        violations.push({ qualifiedName: lock.qualified_name, relPath: lock.rel_path, violation: 'Frozen symbol body modified' })
      } else if (lock.lock_mode === 'allow_body_only' && sym.signature !== lock.baseline_signature) {
        violations.push({
          qualifiedName: lock.qualified_name,
          relPath: lock.rel_path,
          violation: 'Symbol signature modified (only body modifications were allowed)',
        })
      }
    }
    return violations
  }

  /**
   * Locks that edits must respect: this engine's, plus the ones the Fábrica (embedded engine,
   * shard schema v4) recorded in its shard, read-only, until it runs this engine version.
   */
  listSymbolLocks(repositoryPath: string): SymbolLock[] {
    const repo = this.getOrOpenShard(repositoryPath).repositoryPath
    const locks: SymbolLock[] = (
      this.telemetryDb
        .prepare('SELECT qualified_name, rel_path, lock_mode FROM symbol_locks WHERE repo_key = ?')
        .all(repoKey(repo)) as Array<{ qualified_name: string; rel_path: string; lock_mode: string }>
    ).map((r) => ({ qualifiedName: r.qualified_name, relPath: r.rel_path, mode: r.lock_mode as SymbolLock['mode'], source: 'kvx' as const }))
    const legacy = join(this.storageRoot, 'shards', RepositoryShard.shardFileName(repo, 4))
    if (existsSync(legacy)) {
      let db: DatabaseSync | null = null
      try {
        db = new DatabaseSync(legacy, { readOnly: true })
        db.exec('PRAGMA busy_timeout = 5000')
        const rows = db.prepare('SELECT qualified_name, rel_path, lock_mode FROM symbol_locks').all() as Array<{
          qualified_name: string
          rel_path: string
          lock_mode: string
        }>
        for (const r of rows) {
          if (!locks.some((l) => l.qualifiedName === r.qualified_name)) {
            locks.push({ qualifiedName: r.qualified_name, relPath: r.rel_path, mode: r.lock_mode as SymbolLock['mode'], source: 'fabrica-v4' })
          }
        }
      } catch {
        // an old shard without the table, or held by a writer: no legacy locks to add
      } finally {
        db?.close()
      }
    }
    return locks
  }

  /**
   * Symbol-level edit (full server only): resolves exactly one symbol, refuses stale reads,
   * .kvxignore'd files, broken locks and new syntax errors, then writes atomically (keeping
   * BOM, line endings and file mode) and reindexes the file.
   */
  editSymbol(repositoryPath: string, req: SymbolEditRequest): SymbolEditOutcome {
    if (!SYMBOL_EDIT_OPS.includes(req.op)) return { ok: false, reason: `op inválida '${String(req.op)}': use ${SYMBOL_EDIT_OPS.join(' | ')}` }
    if (req.op !== 'delete' && typeof req.text !== 'string') return { ok: false, reason: `op '${req.op}' exige o campo text` }
    const { query, opts } = this.splitSymbolQuery(req.symbol, { path: req.path })
    const { shard } = this.shardForFile(repositoryPath, opts.path ?? '')
    shard.syncNow()
    const matches = shard.readSymbol(query, opts)
    if (matches.length === 0) {
      return { ok: false, reason: this.readSymbolDetailed(repositoryPath, req.symbol, { path: req.path }).reason ?? `símbolo '${req.symbol}' não encontrado` }
    }
    const suffixOf = (m: SymbolSlice) => m.qualifiedName.slice(m.relPath.length + 1)
    const exact = matches.filter((m) => suffixOf(m) === query)
    const pool = exact.length > 0 ? exact : matches
    if (pool.length !== 1) {
      return {
        ok: false,
        reason: `'${req.symbol}' é ambíguo (${pool.length} candidatos): repita com o nome qualificado, ex. caminho#Classe.metodo`,
        candidates: pool.map((m) => m.qualifiedName),
      }
    }
    const target = pool[0]
    const abs = join(shard.repositoryPath, ...target.relPath.split('/'))
    this.assertPathAllowed(abs, { fresh: true })
    const before = { startLine: target.startLine, endLine: target.endLine, hash: target.hash }
    if (req.expectedHash && req.expectedHash !== target.hash) {
      return { ok: false, reason: `o símbolo mudou desde a leitura (hash atual ${target.hash}); leia de novo com read_symbol`, symbol: target.qualifiedName, before }
    }
    const oldContent = readFileSync(abs, 'utf8')
    if (sliceLines(oldContent, target.startLine, target.endLine) !== target.sliceText.replace(/\r\n/g, '\n')) {
      return { ok: false, reason: 'o índice não corresponde ao arquivo em disco; nada foi gravado (tente de novo)', symbol: target.qualifiedName, before }
    }
    const edit = applyLineEdit(oldContent, target.startLine, target.endLine, req.op, req.text)
    const lang = AdmissionFirewall.detectLanguage(target.relPath) ?? 'other'
    const syntaxErrors = { before: syntaxErrorCount(lang, target.relPath, oldContent), after: syntaxErrorCount(lang, target.relPath, edit.content) }
    const base = { file: target.relPath, op: req.op, symbol: target.qualifiedName, before, syntaxErrors }
    if (!req.allowSyntaxErrors && syntaxErrors.before !== null && syntaxErrors.after !== null && syntaxErrors.after > syntaxErrors.before) {
      return { ok: false, ...base, reason: `a edição introduz ${syntaxErrors.after - syntaxErrors.before} erro(s) de sintaxe; nada foi gravado` }
    }
    const locks = this.listSymbolLocks(shard.repositoryPath)
    if (locks.length > 0) {
      const extractor = new PolyglotExtractor()
      const scanned = (content: string) => ({
        absPath: abs,
        relPath: target.relPath,
        contentHash: '',
        mtimeMs: 0,
        byteSize: Buffer.byteLength(content),
        lang,
        content,
        tokenEstimate: Math.ceil(content.length / 4),
      })
      const violations = lockViolations(target.relPath, extractor.extract(scanned(oldContent)), extractor.extract(scanned(edit.content)), locks)
      if (violations.length > 0) {
        return { ok: false, ...base, violations, reason: `a edição quebraria ${violations.length} trava(s) de símbolo; nada foi gravado` }
      }
    }
    const result = { linesRemoved: edit.linesRemoved, linesAdded: edit.linesAdded }
    if (req.dryRun) {
      const lines = edit.content.replace(/^﻿/, '').split(/\r?\n/)
      const from = Math.max(1, edit.newStart - 2)
      const to = Math.min(lines.length, Math.max(edit.newEnd, edit.newStart) + 2)
      const preview = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join('\n')
      return { ok: true, dryRun: true, ...base, ...result, after: { startLine: edit.newStart, endLine: edit.newEnd }, preview }
    }
    const tmp = `${abs}.kvx-${process.pid}-${Date.now()}.tmp`
    try {
      writeFileSync(tmp, edit.content, 'utf8')
      try {
        chmodSync(tmp, statSync(abs).mode)
      } catch {
        // file modes are advisory on Windows
      }
      renameSync(tmp, abs)
    } catch (err) {
      rmSync(tmp, { force: true })
      return { ok: false, ...base, reason: `falha ao gravar: ${err instanceof Error ? err.message : String(err)}` }
    }
    shard.reindexFile(target.relPath)
    const after: NonNullable<SymbolEditOutcome['after']> = { startLine: edit.newStart, endLine: edit.newEnd }
    if (req.op !== 'delete') {
      const fresh = shard.symbolsStartingAt(target.relPath, edit.newStart)[0]
      if (fresh) Object.assign(after, { qualifiedName: fresh.qualifiedName, hash: fresh.hash, endLine: fresh.endLine })
    }
    return { ok: true, ...base, ...result, after }
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

  /** Usages of a symbol with confidence (same_file | imported | name_only); see RepositoryShard.findReferences. */
  findReferences(repositoryPath: string, rawQuery: string, rawOpts: { path?: string; limit?: number; includeNameOnly?: boolean } = {}): ReferencesResult {
    const { query, opts } = this.splitSymbolQuery(rawQuery, { path: rawOpts.path })
    const { shard } = this.shardForFile(repositoryPath, opts.path ?? '')
    return shard.findReferences(query, { ...rawOpts, path: opts.path })
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
      parsers: { treeSitter: treeSitterStatus() },
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
