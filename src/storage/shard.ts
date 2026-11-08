import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AdmissionFirewall } from '../core/firewall.ts'
import { normalizeFsPath } from '../core/kvxignore.ts'
import type {
  BlastRadiusReport,
  ExtractionResult,
  SearchHit,
  SearchOptions,
  ShardHealth,
  StoredFileRow,
  StoredSymbolRow,
} from '../core/types.ts'
import { CsrGraph, type CsrEdgeInput } from '../graph/csr.ts'
import { extractorVersion, PolyglotExtractor } from '../parser/extractor.ts'
import { treeSitterStatus } from '../parser/treesitter.ts'
import { CODE_LANGUAGES, type SlopFinding } from '../core/types.ts'

/**
 * Bumped when the shard schema or the extractor family changes. The version is part of the
 * shard file name so an older kvx process still running (e.g. an MCP server not yet
 * restarted, or an embedded copy) never writes old rows into a newer shard. v5: polyglot
 * extractor, optional tree-sitter layer.
 */
export const SHARD_SCHEMA_VERSION = 5

/** Minimum interval between two full repository stat-walks triggered by queries. */
const SYNC_THROTTLE_MS = 500

/**
 * A large (re)index commits every N extracted files. One transaction for a whole big repo made
 * the WAL grow to gigabytes and SQLite slower with every page (HyperAv, 8.7k files: 18 min).
 * Every file's rows are replaced together, so a reader between batches sees whole files.
 */
const SYNC_BATCH_FILES = 300

/** WAL is truncated after an indexing pass, or whenever it exceeds this fraction of the DB. */
const WAL_MAX_DB_RATIO = 0.25

/** Escapes `%`, `_` and `\` so user input is literal inside LIKE (use with ESCAPE '\'). */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

/**
 * Turns a non-relative module reference into a lowercase path (2+ segments), or null:
 * `com.acme.Invoice` -> com/acme/invoice, `crate::db::pool` -> db/pool,
 * `App\Models\User` -> app/models/user, `github.com/o/r/pkg/util` stays a path.
 */
export function moduleHintToPath(hint: string): string | null {
  if (!hint || hint.startsWith('.')) return null
  let path: string
  if (hint.includes('/')) {
    path = hint.replace(/\.(?:h|hh|hpp|hxx|rb|php|sh|ps1|py|rs|go|java|cs)$/i, '')
  } else if (/^[A-Za-z_]\w*(?:(?:\.|::|\\)(?:[A-Za-z_]\w*|\*))+$/.test(hint)) {
    path = hint.replace(/::|\\|\./g, '/').replace(/^(?:crate|self|super)\//, '')
  } else {
    return null
  }
  path = path.replace(/\/\*$/, '').toLowerCase()
  return path.includes('/') ? path : null
}

/** Longest suffix of `path` (2+ segments) present in the index; ambiguous (-1) -> undefined. */
function uniqueSuffix(index: Map<string, number>, path: string): number | undefined {
  const parts = path.split('/').filter(Boolean)
  for (let i = 0; i <= parts.length - 2; i++) {
    const v = index.get(parts.slice(i).join('/'))
    if (v !== undefined) return v === -1 ? undefined : v
  }
  return undefined
}

export type OutlineScope = 'topo' | 'exportado' | 'tudo'

export interface OutlineSymbol {
  name: string
  qualifiedName: string
  kind: string
  scope: string
  exported: boolean
  startLine: number
  endLine: number
  signature: string
  docSummary: string
}

export type FileOutlineResult =
  | {
      found: true
      relPath: string
      tokenEstimate: number
      outlineTokens: number
      scope: OutlineScope
      hiddenSymbols: number
      otherMatches?: string[]
      reason?: string
      symbols: OutlineSymbol[]
    }
  | {
      found: false
      relPath?: string
      reason: string
      suggestions: string[]
    }

export interface SymbolSlice {
  relPath: string
  name: string
  qualifiedName: string
  kind: string
  scope: string
  startLine: number
  endLine: number
  signature: string
  docSummary: string
  tokens: number
  sliceText: string
  /** Body hash of the slice: pass it back as `expected_hash` to edit_symbol. */
  hash: string
}

export interface RepoMapResult {
  ok: boolean
  reason?: string
  markdown: string
  files: Array<{ path: string; score: number; symbols: number }>
  tokens: number
  omittedFiles?: number
}

export type RefConfidence = 'same_file' | 'imported' | 'name_only'

export interface ReferenceHit {
  relPath: string
  line: number
  col: number
  kind: string
  confidence: RefConfidence
  /** Innermost non-local symbol around the usage (qualified suffix), if any. */
  inSymbol?: string
  text: string
}

export interface ReferencesResult {
  ok: boolean
  reason?: string
  candidates?: string[]
  target?: { qualifiedName: string; relPath: string; startLine: number; kind: string; scope: string }
  total?: number
  byConfidence?: Record<RefConfidence, number>
  references?: ReferenceHit[]
  truncated?: boolean
}

export interface TextHit {
  relPath: string
  line: number
  text: string
  matchedTerms: number
}

export type PathResolution =
  | { ok: true; relPath: string }
  | { ok: false; reason: string }

export class RepositoryShard {
  readonly repositoryPath: string
  readonly shardPath: string
  readonly db: DatabaseSync
  private readonly firewall: AdmissionFirewall
  private readonly extractor: PolyglotExtractor
  private cachedGraph: CsrGraph | null = null
  private lastSyncEpochMs = 0
  private lastSyncAtIso = ''
  /** Extractor version the stored rows were built with (meta), compared on every sync. */
  private stampedVersion: string | undefined

  constructor(repositoryPath: string, storageRoot: string) {
    this.repositoryPath = resolve(repositoryPath)
    mkdirSync(storageRoot, { recursive: true })
    const slug = RepositoryShard.computeRepoSlug(this.repositoryPath)
    // Processes with and without the tree-sitter layer extract differently: separate files,
    // so they never take turns re-extracting the same shard.
    const mode = treeSitterStatus().ready ? '-tsw' : ''
    this.shardPath = join(storageRoot, `shard-${slug}-v${SHARD_SCHEMA_VERSION}${mode}.sqlite`)
    this.db = new DatabaseSync(this.shardPath)
    this.firewall = new AdmissionFirewall(this.repositoryPath)
    this.extractor = new PolyglotExtractor()
    this.initializeSchema()
    const versionRow = this.db
      .prepare("SELECT value FROM meta WHERE key = 'extractor_version'")
      .get() as { value: string } | undefined
    this.stampedVersion = versionRow?.value
  }

  /**
   * Converts a user-supplied file/path argument (absolute in any drive-letter case or
   * slash style, or repository-relative) into a repository-relative POSIX path.
   */
  resolveRepoPath(input: string): PathResolution {
    // Strip quotes and the Win32 long-path prefix (\\?\C:\...).
    const trimmed = input.trim().replace(/^["']|["']$/g, '').replace(/^\\\\\?\\/, '')
    if (!trimmed) return { ok: true, relPath: '' }
    const looksAbsolute = isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
    if (!looksAbsolute) {
      const rel = posix.normalize(trimmed.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '')
      if (rel === '..' || rel.startsWith('../')) {
        return { ok: false, reason: `caminho fora do repositório indexado (${this.repositoryPath}): ${trimmed}` }
      }
      return { ok: true, relPath: rel === '.' ? '' : rel }
    }
    const rootNorm = normalizeFsPath(this.repositoryPath)
    const inNorm = normalizeFsPath(trimmed)
    if (inNorm === rootNorm) return { ok: true, relPath: '' }
    if (!inNorm.startsWith(rootNorm + '/')) {
      return { ok: false, reason: `caminho fora do repositório indexado (${this.repositoryPath}): ${trimmed}` }
    }
    return { ok: true, relPath: relative(this.repositoryPath, resolve(trimmed)).split(sep).join('/') }
  }

  /** File name of this repository's shard for a given schema version and mode. */
  static shardFileName(repoPath: string, schemaVersion: number = SHARD_SCHEMA_VERSION, treeSitter = false): string {
    return `shard-${RepositoryShard.computeRepoSlug(resolve(repoPath))}-v${schemaVersion}${treeSitter ? '-tsw' : ''}.sqlite`
  }

  private static computeRepoSlug(repoPath: string): string {
    const cleanName = repoPath
      .replace(/^[A-Za-z]:[\\/]/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 32)
    const hash = createHash('sha256').update(repoPath.toLowerCase()).digest('hex').slice(0, 10)
    return `${cleanName || 'repo'}-${hash}`
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA journal_size_limit = 33554432;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 67108864;
      PRAGMA cache_size = -65536;

      CREATE TABLE IF NOT EXISTS symbol_locks (
        qualified_name TEXT PRIMARY KEY,
        rel_path TEXT NOT NULL,
        lock_mode TEXT NOT NULL,
        baseline_signature TEXT NOT NULL,
        baseline_body_hash TEXT NOT NULL,
        locked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cas_extractions (
        content_hash TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pack_snapshots (
        etag TEXT PRIMARY KEY,
        slice_etags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbol_history (
        qualified_name TEXT PRIMARY KEY,
        prev_signature TEXT NOT NULL,
        prev_body_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        lang TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        is_hub INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        headings TEXT NOT NULL DEFAULT '',
        indexed_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS symbols (
        sym_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 1,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        doc_summary TEXT NOT NULL DEFAULT '',
        slice_text TEXT NOT NULL,
        is_hub INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT 'module',
        parent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_rel_path ON symbols(rel_path);

      CREATE TABLE IF NOT EXISTS raw_edges (
        edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
        src_file_id INTEGER NOT NULL,
        src_sym_name TEXT NOT NULL,
        dst_name TEXT NOT NULL,
        dst_path_hint TEXT,
        kind TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0
      );

      CREATE INDEX IF NOT EXISTS idx_raw_edges_src_file ON raw_edges(src_file_id);

      CREATE TABLE IF NOT EXISTS resolved_edges (
        src_file_id INTEGER NOT NULL,
        dst_file_id INTEGER NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (src_file_id, dst_file_id)
      );

      CREATE TABLE IF NOT EXISTS routes (
        route_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        method TEXT NOT NULL,
        path_pattern TEXT NOT NULL,
        framework TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routes_file ON routes(file_id);

      -- Inverted index of usages: which files use a name. Positions stay in the file's CAS
      -- payload (refs), read only for the candidate files of a find_references query.
      CREATE TABLE IF NOT EXISTS ref_names (
        name TEXT NOT NULL,
        file_id INTEGER NOT NULL,
        PRIMARY KEY (name, file_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_ref_names_file ON ref_names(file_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
        sym_id UNINDEXED,
        file_id UNINDEXED,
        rel_path,
        name,
        signature,
        doc_summary,
        slice_text,
        tokenize = 'porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
        file_id UNINDEXED,
        rel_path,
        headings,
        summary,
        body_text,
        tokenize = 'porter unicode61'
      );
    `)
    this.ensureColumn('symbols', 'scope', "TEXT NOT NULL DEFAULT 'module'")
    this.ensureColumn('symbols', 'parent', 'TEXT')
    this.ensureColumn('files', 'indexed_at', 'INTEGER NOT NULL DEFAULT 0')
    this.maybeCheckpointWal(false)
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
  }

  /**
   * Keeps the WAL from outgrowing the database (K9): TRUNCATE checkpoint after an
   * indexing pass, or whenever the WAL exceeds WAL_MAX_DB_RATIO of the DB size.
   */
  maybeCheckpointWal(afterIndexing: boolean): { checkpointed: boolean; walBytesBefore: number } {
    let dbBytes = 0
    let walBytes = 0
    try {
      if (existsSync(this.shardPath)) dbBytes = statSync(this.shardPath).size
      const walPath = `${this.shardPath}-wal`
      if (existsSync(walPath)) walBytes = statSync(walPath).size
    } catch {
      return { checkpointed: false, walBytesBefore: 0 }
    }
    const tooBig = walBytes > Math.max(1_048_576, dbBytes * WAL_MAX_DB_RATIO)
    if (!(afterIndexing && walBytes > 0) && !tooBig) return { checkpointed: false, walBytesBefore: walBytes }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      return { checkpointed: true, walBytesBefore: walBytes }
    } catch {
      return { checkpointed: false, walBytesBefore: walBytes }
    }
  }

  /**
   * Incremental SHA-256 + mtime synchronization.
   * Only parses changed/new files and re-uses Content-Addressable AST cache if contentHash was already seen.
   */
  sync(force = false): {
    totalFiles: number
    updatedFiles: number
    removedFiles: number
    elapsedMs: number
  } {
    const now = Date.now()
    // Compared per sync: the optional tree-sitter layer may finish loading after the shard opens.
    if (this.stampedVersion !== extractorVersion()) {
      force = true
      // Signatures recorded by an older extractor have another format: comparing them would be noise.
      this.db.exec('DELETE FROM symbol_history')
    }
    if (!force && this.lastSyncEpochMs > 0 && now - this.lastSyncEpochMs < SYNC_THROTTLE_MS) {
      const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }
      return { totalFiles: countRow.c, updatedFiles: 0, removedFiles: 0, elapsedMs: 0 }
    }

    const t0 = performance.now()
    const fingerprints = this.firewall.discoverFingerprints(this.repositoryPath)
    const existingRows = this.db
      .prepare('SELECT file_id, rel_path, content_hash, mtime_ms, byte_size FROM files')
      .all() as Array<{
      file_id: number
      rel_path: string
      content_hash: string
      mtime_ms: number
      byte_size: number
    }>

    const existingByPath = new Map(existingRows.map((r) => [r.rel_path, r]))
    const seenPaths = new Set<string>()

    let updatedFiles = 0
    let removedFiles = 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (force) {
        this.db.exec('DELETE FROM cas_extractions')
      }
      const getCasStmt = this.db.prepare(
        'SELECT payload_json FROM cas_extractions WHERE content_hash = ?',
      )
      const putCasStmt = this.db.prepare(
        'INSERT OR REPLACE INTO cas_extractions(content_hash, payload_json) VALUES (?, ?)',
      )
      const upsertFileStmt = this.db.prepare(`
        INSERT INTO files(rel_path, content_hash, mtime_ms, byte_size, lang, token_estimate, is_hub, summary, headings, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          mtime_ms = excluded.mtime_ms,
          byte_size = excluded.byte_size,
          lang = excluded.lang,
          token_estimate = excluded.token_estimate,
          is_hub = excluded.is_hub,
          summary = excluded.summary,
          headings = excluded.headings,
          indexed_at = excluded.indexed_at
        RETURNING file_id
      `)

      const delSymbolsByFile = this.db.prepare('DELETE FROM symbols WHERE file_id = ?')
      const delEdgesByFile = this.db.prepare('DELETE FROM raw_edges WHERE src_file_id = ?')
      const delRoutesByFile = this.db.prepare('DELETE FROM routes WHERE file_id = ?')
      // FTS rows use rowid = sym_id / file_id: deleting by an UNINDEXED column scanned the whole
      // FTS table once per file (quadratic indexing). Must run before the symbols are deleted.
      const delFtsSymByFile = this.db.prepare(
        'DELETE FROM fts_symbols WHERE rowid IN (SELECT sym_id FROM symbols WHERE file_id = ?)',
      )
      const delFtsFileById = this.db.prepare('DELETE FROM fts_files WHERE rowid = ?')

      const insertSymStmt = this.db.prepare(`
        INSERT INTO symbols(
          file_id, rel_path, name, qualified_name, kind, exported,
          start_line, end_line, signature, body_hash, token_estimate, doc_summary, slice_text, is_hub,
          scope, parent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING sym_id
      `)
      const insertFtsSymStmt = this.db.prepare(`
        INSERT INTO fts_symbols(rowid, sym_id, file_id, rel_path, name, signature, doc_summary, slice_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFtsFileStmt = this.db.prepare(`
        INSERT INTO fts_files(rowid, file_id, rel_path, headings, summary, body_text)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      const insertEdgeStmt = this.db.prepare(`
        INSERT INTO raw_edges(src_file_id, src_sym_name, dst_name, dst_path_hint, kind, weight)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      const delRefNamesByFile = this.db.prepare('DELETE FROM ref_names WHERE file_id = ?')
      const insertRefNameStmt = this.db.prepare('INSERT OR IGNORE INTO ref_names(name, file_id) VALUES (?, ?)')
      const insertRouteStmt = this.db.prepare(`
        INSERT INTO routes(file_id, rel_path, symbol_name, direction, method, path_pattern, framework)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const fp of fingerprints) {
        seenPaths.add(fp.relPath)
        const prev = existingByPath.get(fp.relPath)
        if (!force && prev && prev.mtime_ms === fp.mtimeMs && prev.byte_size === fp.byteSize) {
          continue
        }

        const scanned = this.firewall.readAndHash(fp)
        if (!scanned) continue

        if (!force && prev && prev.content_hash === scanned.contentHash) {
          this.db
            .prepare('UPDATE files SET mtime_ms = ?, byte_size = ?, indexed_at = ? WHERE file_id = ?')
            .run(fp.mtimeMs, fp.byteSize, now, prev.file_id)
          continue
        }

        let extraction: ExtractionResult
        const casKey = this.casKey(scanned.contentHash, scanned.relPath)
        const cachedCas = getCasStmt.get(casKey) as { payload_json: string } | undefined
        if (cachedCas) {
          extraction = JSON.parse(cachedCas.payload_json) as ExtractionResult
        } else {
          extraction = this.extractor.extract(scanned)
          putCasStmt.run(casKey, JSON.stringify(extraction))
        }

        const fileRow = upsertFileStmt.get(
          scanned.relPath,
          scanned.contentHash,
          scanned.mtimeMs,
          scanned.byteSize,
          scanned.lang,
          scanned.tokenEstimate,
          extraction.isHub ? 1 : 0,
          extraction.summary,
          extraction.headings,
          now,
        ) as { file_id: number }

        const fileId = fileRow.file_id

        // Record previous signatures in symbol_history for Contract Drift detection — only when the
        // content changed: a forced re-extraction of an unchanged file must not reset the baseline.
        if (prev && prev.content_hash !== scanned.contentHash) {
          const oldSyms = this.db
            .prepare('SELECT qualified_name, signature, body_hash FROM symbols WHERE file_id = ?')
            .all(fileId) as Array<{ qualified_name: string; signature: string; body_hash: string }>
          const upsertHist = this.db.prepare(`
            INSERT OR REPLACE INTO symbol_history(qualified_name, prev_signature, prev_body_hash, updated_at)
            VALUES (?, ?, ?, ?)
          `)
          for (const os of oldSyms) {
            upsertHist.run(os.qualified_name, os.signature, os.body_hash, now)
          }
        }

        delFtsSymByFile.run(fileId)
        delFtsFileById.run(fileId)
        delSymbolsByFile.run(fileId)
        delEdgesByFile.run(fileId)
        delRoutesByFile.run(fileId)
        delRefNamesByFile.run(fileId)

        insertFtsFileStmt.run(
          fileId,
          String(fileId),
          scanned.relPath.replace(/[/_.-]+/g, ' ') + ' ' + scanned.relPath,
          extraction.headings,
          extraction.summary,
          scanned.content.slice(0, 24_000),
        )

        for (const sym of extraction.symbols) {
          const symRow = insertSymStmt.get(
            fileId,
            scanned.relPath,
            sym.name,
            sym.qualifiedName,
            sym.kind,
            sym.exported ? 1 : 0,
            sym.startLine,
            sym.endLine,
            sym.signature,
            sym.bodyHash,
            sym.tokenEstimate,
            sym.docSummary,
            sym.sliceText,
            extraction.isHub ? 1 : 0,
            sym.scope ?? 'module',
            sym.parent ?? null,
          ) as { sym_id: number }

          insertFtsSymStmt.run(
            symRow.sym_id,
            String(symRow.sym_id),
            String(fileId),
            scanned.relPath.replace(/[/_.-]+/g, ' '),
            sym.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2') + ' ' + sym.name,
            sym.signature,
            sym.docSummary,
            sym.sliceText.slice(0, 6_000),
          )
        }

        for (const edge of extraction.edges) {
          insertEdgeStmt.run(
            fileId,
            edge.srcSymbolName,
            edge.dstName,
            edge.dstPathHint ?? null,
            edge.kind,
            edge.weight,
          )
        }

        for (const route of extraction.routes) {
          insertRouteStmt.run(
            fileId,
            scanned.relPath,
            route.symbolName,
            route.direction,
            route.method,
            route.pathPattern,
            route.framework,
          )
        }

        if (extraction.refs?.length) {
          const names = new Set<string>()
          for (const r of extraction.refs) names.add(r[0])
          for (const nm of names) insertRefNameStmt.run(nm, fileId)
        }

        updatedFiles++
        if (updatedFiles % SYNC_BATCH_FILES === 0) {
          this.db.exec('COMMIT')
          this.db.exec('BEGIN IMMEDIATE')
        }
      }

      // Remove deleted files
      for (const prev of existingRows) {
        if (!seenPaths.has(prev.rel_path)) {
          delFtsSymByFile.run(prev.file_id)
          delFtsFileById.run(prev.file_id)
          delSymbolsByFile.run(prev.file_id)
          delEdgesByFile.run(prev.file_id)
          delRoutesByFile.run(prev.file_id)
          delRefNamesByFile.run(prev.file_id)
          this.db.prepare('DELETE FROM files WHERE file_id = ?').run(prev.file_id)
          removedFiles++
        }
      }

      if (updatedFiles > 0 || removedFiles > 0 || force) {
        this.rebuildResolvedFileEdges()
        this.cachedGraph = null
      }

      const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      if (updatedFiles > 0 || removedFiles > 0 || force) {
        setMeta.run('last_indexed_at', new Date().toISOString())
      }
      if (force) setMeta.run('extractor_version', extractorVersion())
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    if (force) this.stampedVersion = extractorVersion()
    this.lastSyncAtIso = new Date().toISOString()
    if (updatedFiles > 0 || removedFiles > 0 || force) this.maybeCheckpointWal(true)
    this.lastSyncEpochMs = Date.now()
    const elapsedMs = Math.round((performance.now() - t0) * 100) / 100
    return {
      totalFiles: fingerprints.length,
      updatedFiles,
      removedFiles,
      elapsedMs,
    }
  }


  /** The payload carries path-qualified names, so identical files at two paths get two entries. */
  private casKey(contentHash: string, relPath: string): string {
    return `${extractorVersion()}:${relPath}:${contentHash}`
  }

  /**
   * Targeted freshness check for a single file (K4): if its mtime/size on disk differ from
   * the indexed row (or it is not indexed yet), bypass the throttle and resync now.
   */
  refreshFile(relPath: string): boolean {
    if (!relPath) return false
    const abs = join(this.repositoryPath, ...relPath.split('/'))
    let st: { mtimeMs: number; size: number } | null = null
    try {
      const s = statSync(abs)
      if (s.isDirectory()) return false
      st = { mtimeMs: Math.trunc(s.mtimeMs), size: s.size }
    } catch {
      st = null
    }
    const row = this.db
      .prepare('SELECT mtime_ms, byte_size FROM files WHERE lower(rel_path) = ?')
      .get(relPath.toLowerCase()) as { mtime_ms: number; byte_size: number } | undefined
    // A file the firewall would not admit is never indexed: not "stale" (that would force a walk per call).
    if (!row && st !== null && this.firewall.explainExclusion(this.repositoryPath, relPath) !== null) return false
    const stale = st === null ? Boolean(row) : !row || row.mtime_ms !== st.mtimeMs || row.byte_size !== st.size
    if (!stale) return false
    this.lastSyncEpochMs = 0
    this.sync(false)
    return true
  }

  /** Sync now, ignoring the throttle (before verifying locks or editing). */
  syncNow(): void {
    this.lastSyncEpochMs = 0
    this.sync(false)
  }

  /** Re-extracts one file even if a rewrite kept its mtime and size (edit_symbol). */
  reindexFile(relPath: string): void {
    this.reindexFiles([relPath])
  }

  /** Same for several files with a single sync (rename_symbol). */
  reindexFiles(relPaths: string[]): void {
    const stmt = this.db.prepare('UPDATE files SET mtime_ms = -1 WHERE rel_path = ?')
    for (const rel of relPaths) stmt.run(rel)
    this.syncNow()
  }

  /** Non-local symbols of a file that start at `line`, widest first. */
  symbolsStartingAt(relPath: string, line: number): Array<{ qualifiedName: string; startLine: number; endLine: number; hash: string }> {
    return this.db
      .prepare(
        `SELECT qualified_name AS qualifiedName, start_line AS startLine, end_line AS endLine, body_hash AS hash
         FROM symbols WHERE rel_path = ? AND start_line = ? AND scope != 'local'
         ORDER BY (end_line - start_line) DESC`,
      )
      .all(relPath, line) as Array<{ qualifiedName: string; startLine: number; endLine: number; hash: string }>
  }

  /** Current signature/body hash of a symbol by qualified name (with or without path) or name. */
  findSymbolBaseline(query: string): { signature: string; bodyHash: string; relPath: string; qualifiedName: string } | undefined {
    return this.db
      .prepare(
        `SELECT signature, body_hash AS bodyHash, rel_path AS relPath, qualified_name AS qualifiedName
         FROM symbols WHERE qualified_name = ? OR qualified_name LIKE '%#' || ? ESCAPE '\\' OR name = ?
         ORDER BY CASE WHEN qualified_name = ? THEN 0 WHEN name = ? THEN 2 ELSE 1 END LIMIT 1`,
      )
      .get(query, likeEscape(query), query, query, query) as
      | { signature: string; bodyHash: string; relPath: string; qualifiedName: string }
      | undefined
  }

  /** @deprecated locks live in the engine (telemetry.sqlite); kept for embedders of the old API. */
  lockSymbols(
    locks: Array<{ qualifiedName: string; relPath: string; mode: 'allow_body_only' | 'frozen' }>,
  ): number {
    this.sync(false)
    let locked = 0
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbol_locks (qualified_name, rel_path, lock_mode, baseline_signature, baseline_body_hash, locked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const l of locks) {
        const sym = this.db
          .prepare('SELECT signature, body_hash FROM symbols WHERE qualified_name = ? OR name = ?')
          .get(l.qualifiedName, l.qualifiedName) as
          | { signature: string; body_hash: string }
          | undefined
        if (sym) {
          stmt.run(l.qualifiedName, l.relPath, l.mode, sym.signature, sym.body_hash, now)
          locked++
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return locked
  }

  unlockAllSymbols(): void {
    this.db.exec('DELETE FROM symbol_locks')
  }

  verifySymbolLocks(): Array<{ qualifiedName: string; relPath: string; violation: string }> {
    this.lastSyncEpochMs = 0
    this.sync(false)
    const violations: Array<{ qualifiedName: string; relPath: string; violation: string }> = []
    try {
      const locks = this.db.prepare('SELECT * FROM symbol_locks').all() as Array<{
        qualified_name: string
        rel_path: string
        lock_mode: string
        baseline_signature: string
        baseline_body_hash: string
      }>
      for (const lock of locks) {
        const sym = this.db
          .prepare('SELECT signature, body_hash FROM symbols WHERE qualified_name = ? OR name = ?')
          .get(lock.qualified_name, lock.qualified_name) as
          | { signature: string; body_hash: string }
          | undefined
        if (!sym) {
          violations.push({
            qualifiedName: lock.qualified_name,
            relPath: lock.rel_path,
            violation: 'Symbol deleted',
          })
          continue
        }
        if (lock.lock_mode === 'frozen' && sym.body_hash !== lock.baseline_body_hash) {
          violations.push({
            qualifiedName: lock.qualified_name,
            relPath: lock.rel_path,
            violation: 'Frozen symbol body modified',
          })
        } else if (
          lock.lock_mode === 'allow_body_only' &&
          sym.signature !== lock.baseline_signature
        ) {
          violations.push({
            qualifiedName: lock.qualified_name,
            relPath: lock.rel_path,
            violation: 'Symbol signature modified (only body modifications were allowed)',
          })
        }
      }
    } catch {}
    return violations
  }

  scanRepoSlop(): SlopFinding[] {
    this.sync(false)
    const slops: SlopFinding[] = []
    try {
      // Only the extraction of each file's CURRENT content: the CAS also keeps payloads of
      // older versions, which used to resurface findings on lines already fixed.
      const rows = this.db
        .prepare(
          `SELECT f.rel_path AS relPath, c.payload_json AS payload
           FROM files f JOIN cas_extractions c ON c.content_hash = ? || f.rel_path || ':' || f.content_hash`,
        )
        .all(`${extractorVersion()}:`) as Array<{ relPath: string; payload: string }>
      for (const row of rows) {
        const ext = JSON.parse(row.payload) as ExtractionResult
        for (const f of ext.slopFindings ?? []) slops.push({ ...f, relPath: row.relPath })
      }
    } catch {}
    return slops;
  }

  private rebuildResolvedFileEdges(): void {
    this.db.exec('DELETE FROM resolved_edges')

    const files = this.db.prepare('SELECT file_id, rel_path FROM files').all() as Array<{
      file_id: number
      rel_path: string
    }>
    const symbols = this.db.prepare('SELECT file_id, name FROM symbols').all() as Array<{
      file_id: number
      name: string
    }>
    const rawEdges = this.db
      .prepare('SELECT src_file_id, dst_name, dst_path_hint, weight FROM raw_edges')
      .all() as Array<{
      src_file_id: number
      dst_name: string
      dst_path_hint: string | null
      weight: number
    }>

    const fileById = new Map<number, string>()
    const fileByBasename = new Map<string, number[]>()
    const fileByRelNoExt = new Map<string, number>()

    // Path suffixes with 2+ segments (`acme/invoice`), for module-style imports. `__init__.py`
    // and `mod.rs` also answer for their directory. -1 marks an ambiguous suffix.
    const fileBySuffix = new Map<string, number>()
    const dirBySuffix = new Map<string, number>()
    const dirIds = new Map<string, number>()
    const filesByDir = new Map<number, number[]>()
    const addSuffixes = (index: Map<string, number>, path: string, id: number) => {
      const parts = path.split('/')
      for (let i = parts.length - 2; i >= 0; i--) {
        const key = parts.slice(i).join('/')
        const cur = index.get(key)
        index.set(key, cur === undefined || cur === id ? id : -1)
      }
    }

    for (const f of files) {
      fileById.set(f.file_id, f.rel_path)
      const noExt = f.rel_path.replace(/\.\w+$/, '').toLowerCase()
      fileByRelNoExt.set(noExt, f.file_id)
      addSuffixes(fileBySuffix, noExt.replace(/\/(?:__init__|mod)$/, ''), f.file_id)
      const dir = posix.dirname(f.rel_path).toLowerCase()
      if (dir !== '.') {
        let dirId = dirIds.get(dir)
        if (dirId === undefined) {
          dirId = dirIds.size
          dirIds.set(dir, dirId)
          addSuffixes(dirBySuffix, dir, dirId)
        }
        const list = filesByDir.get(dirId) ?? []
        if (list.length < 12) list.push(f.file_id)
        filesByDir.set(dirId, list)
      }
      const base = (f.rel_path.split('/').pop() ?? f.rel_path).replace(/\.\w+$/, '').toLowerCase()
      const list = fileByBasename.get(base) ?? []
      list.push(f.file_id)
      fileByBasename.set(base, list)
    }

    const symbolOwners = new Map<string, number[]>()
    for (const s of symbols) {
      const key = s.name.toLowerCase()
      const list = symbolOwners.get(key) ?? []
      if (!list.includes(s.file_id)) list.push(s.file_id)
      symbolOwners.set(key, list)
    }

    const edgeAccumulator = new Map<string, { src: number; dst: number; weight: number }>()
    const addEdge = (src: number, dst: number, w: number, isImport = false) => {
      if (src === dst) return
      const key = `${src}:${dst}`
      const maxCap = isImport ? 10 : 0.75
      const cur = edgeAccumulator.get(key)
      if (cur) {
        cur.weight = isImport
          ? Math.min(10, Math.max(cur.weight, 1.5) + w)
          : Math.min(Math.max(cur.weight, maxCap), cur.weight + w)
      } else {
        edgeAccumulator.set(key, { src, dst, weight: Math.min(maxCap, w) })
      }
    }

    for (const e of rawEdges) {
      if (e.dst_path_hint) {
        const srcRel = fileById.get(e.src_file_id)
        if (srcRel && e.dst_path_hint.startsWith('.')) {
          const resolvedRel = posix
            .normalize(posix.join(posix.dirname(srcRel), e.dst_path_hint))
            .replace(/\.\w+$/, '')
            .toLowerCase()
          const exactRelId = fileByRelNoExt.get(resolvedRel)
          if (exactRelId) {
            addEdge(e.src_file_id, exactRelId, Math.max(1.5, e.weight * 1.5), true)
            continue
          }
        }
        // Module paths of the other languages: `com.acme.Invoice`, `a.b`, `crate::x::y`,
        // `App\Models\User`, `github.com/org/repo/pkg/util` -> path suffix of a file or package dir.
        const modPath = moduleHintToPath(e.dst_path_hint)
        if (modPath) {
          const fileHit = uniqueSuffix(fileBySuffix, modPath) ?? uniqueSuffix(fileBySuffix, posix.dirname(modPath))
          if (fileHit !== undefined) {
            addEdge(e.src_file_id, fileHit, Math.max(1.5, e.weight * 1.5), true)
            continue
          }
          const dirFiles = uniqueSuffix(dirBySuffix, modPath)
          if (dirFiles !== undefined) {
            for (const id of filesByDir.get(dirFiles) ?? []) addEdge(e.src_file_id, id, Math.max(1.2, e.weight), true)
            continue
          }
        }
        const cleanHint = e.dst_path_hint
          .replace(/^\.+\//, '')
          .replace(/\.\w+$/, '')
          .toLowerCase()
        const exactId = fileByRelNoExt.get(cleanHint)
        if (exactId) {
          addEdge(e.src_file_id, exactId, Math.max(1.5, e.weight * 1.5), true)
          continue
        }
        const baseHint = cleanHint.split('/').pop() ?? cleanHint
        const baseTargets = fileByBasename.get(baseHint)
        if (baseTargets && baseTargets.length === 1) {
          addEdge(e.src_file_id, baseTargets[0], Math.max(1.5, e.weight), true)
          continue
        }
      }

      const dstLower = e.dst_name.toLowerCase()
      const symTargets = symbolOwners.get(dstLower)
      if (symTargets && symTargets.length <= 8) {
        for (const dstId of symTargets) {
          addEdge(e.src_file_id, dstId, (e.weight * 0.4) / Math.sqrt(symTargets.length), false)
        }
      } else {
        const baseTargets = fileByBasename.get(dstLower)
        if (baseTargets && baseTargets.length <= 3) {
          for (const dstId of baseTargets) addEdge(e.src_file_id, dstId, e.weight * 0.35, false)
        }
      }
    }

    const insertResolved = this.db.prepare(
      'INSERT INTO resolved_edges(src_file_id, dst_file_id, weight) VALUES (?, ?, ?)',
    )
    for (const item of edgeAccumulator.values()) {
      insertResolved.run(item.src, item.dst, item.weight)
    }
  }

  getCsrGraph(): {
    graph: CsrGraph
    fileIdToIndex: Map<number, number>
    indexToFile: StoredFileRow[]
  } {
    const files = this.db
      .prepare(
        `SELECT
          file_id AS fileId, rel_path AS relPath, content_hash AS contentHash,
          mtime_ms AS mtimeMs, byte_size AS byteSize, lang,
          token_estimate AS tokenEstimate, is_hub AS isHub, summary
         FROM files ORDER BY file_id ASC`,
      )
      .all() as unknown as StoredFileRow[]

    const fileIdToIndex = new Map<number, number>()
    const hubFlags = new Uint8Array(files.length)
    for (let i = 0; i < files.length; i++) {
      fileIdToIndex.set(files[i].fileId, i)
      hubFlags[i] = files[i].isHub ? 1 : 0
    }

    if (!this.cachedGraph || this.cachedGraph.nodeCount !== files.length) {
      const resolved = this.db
        .prepare('SELECT src_file_id, dst_file_id, weight FROM resolved_edges')
        .all() as Array<{ src_file_id: number; dst_file_id: number; weight: number }>

      const csrEdges: CsrEdgeInput[] = []
      for (const r of resolved) {
        const u = fileIdToIndex.get(r.src_file_id)
        const v = fileIdToIndex.get(r.dst_file_id)
        if (u !== undefined && v !== undefined) {
          csrEdges.push({ srcNode: u, dstNode: v, weight: r.weight })
        }
      }
      this.cachedGraph = new CsrGraph(files.length, csrEdges, hubFlags)
      this.cachedGraph.symbols = files.map((f) => ({
        qualifiedName: f.relPath,
        relPath: f.relPath,
      }))
    }

    return {
      graph: this.cachedGraph,
      fileIdToIndex,
      indexToFile: files,
    }
  }

  matchesPathAndCorpus(
    relPath: string,
    lang: string,
    pathFilter?: string,
    corpusFilter?: string,
  ): boolean {
    const normRel = relPath.replace(/\\/g, '/').toLowerCase()
    if (pathFilter && pathFilter.trim()) {
      const cleanPath = pathFilter
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .trim()
        .toLowerCase()
      if (cleanPath && !normRel.startsWith(cleanPath) && !normRel.includes('/' + cleanPath) && !normRel.includes(cleanPath)) {
        return false
      }
    }

    if (corpusFilter && corpusFilter.trim()) {
      const cleanCorpus = corpusFilter.trim().toLowerCase()
      if (cleanCorpus !== 'all' && cleanCorpus !== 'content') {
        const l = lang.toLowerCase()
        if (cleanCorpus === 'docs' || cleanCorpus === 'doc' || cleanCorpus === 'markdown') {
          if (l !== 'markdown' && !normRel.endsWith('.md') && !normRel.endsWith('.mdx') && !normRel.endsWith('.txt')) {
            return false
          }
        } else if (cleanCorpus === 'sql' || cleanCorpus === 'schema' || cleanCorpus === 'db') {
          if (l !== 'sql' && l !== 'prisma' && !normRel.endsWith('.sql') && !normRel.endsWith('.prisma')) {
            return false
          }
        } else if (cleanCorpus === 'code') {
          if (!CODE_LANGUAGES.has(l)) {
            return false
          }
        }
      }
    }

    return true
  }

  computeAuthorityMultiplier(relPath: string, docSummary = '', sliceText = ''): number {
    const normRel = relPath.replace(/\\/g, '/').toLowerCase()
    const combinedMeta = `${docSummary} ${sliceText.slice(0, 600)}`
    if (
      normRel.startsWith('current/') ||
      normRel.includes('/current/') ||
      combinedMeta.includes('CURRENT_USER_CONFIRMED')
    ) {
      return 1.45
    }
    if (
      normRel.startsWith('legacy-') ||
      normRel.includes('/legacy-') ||
      combinedMeta.includes('LEGACY_IDEA')
    ) {
      return 0.85
    }
    return 1.0
  }

  search(query: string, limitOrOptions: number | SearchOptions = 15): SearchHit[] {
    this.sync(false)
    const opts: SearchOptions =
      typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions
    const limit = Math.max(1, opts.limit ?? 15)
    let pathFilter = opts.path
    if (pathFilter && pathFilter.trim()) {
      const resolved = this.resolveRepoPath(pathFilter)
      if (!resolved.ok) return []
      pathFilter = resolved.relPath || undefined
    }
    const corpusFilter = opts.corpus
    const queryLower = query.trim().toLowerCase()

    const terms = this.buildFtsQueryTerms(query)
    if (terms.length === 0) return []

    const ftsExpr = terms.join(' OR ')
    const hits: SearchHit[] = []
    const seenSymIds = new Set<number>()
    const seenFilesInHits = new Set<string>()

    try {
      const rows = this.db
        .prepare(
          `SELECT
            CAST(f.sym_id AS INTEGER) AS symId,
            s.rel_path AS relPath,
            fi.lang AS lang,
            s.name AS symbolName,
            s.qualified_name AS qualifiedName,
            s.kind AS kind,
            s.start_line AS startLine,
            s.end_line AS endLine,
            s.signature AS signature,
            s.doc_summary AS docSummary,
            s.slice_text AS sliceText,
            s.is_hub AS isHub,
            s.scope AS scope,
            bm25(fts_symbols, 0.0, 0.0, 3.0, 4.5, 2.5, 2.0, 1.0) AS rawBm25
           FROM fts_symbols f
           JOIN symbols s ON s.sym_id = CAST(f.sym_id AS INTEGER)
           JOIN files fi ON fi.file_id = s.file_id
           WHERE fts_symbols MATCH ?
           ORDER BY rawBm25 ASC
           LIMIT ?`,
        )
        .all(ftsExpr, Math.max(limit * 5, 60)) as Array<{
        symId: number
        relPath: string
        lang: string
        symbolName: string
        qualifiedName: string
        kind: string
        startLine: number
        endLine: number
        signature: string
        docSummary: string
        sliceText: string
        isHub: number
        scope: string
        rawBm25: number
      }>

      for (const r of rows) {
        if (seenSymIds.has(r.symId)) continue
        // Locals (consts inside functions, inner helpers) only surface for an exact-name query.
        if (r.scope === 'local' && r.symbolName.toLowerCase() !== queryLower) continue
        if (!this.matchesPathAndCorpus(r.relPath, r.lang, pathFilter, corpusFilter)) continue
        seenSymIds.add(r.symId)
        seenFilesInHits.add(r.relPath)
        let score = Math.abs(r.rawBm25)
        if (r.isHub) score *= 0.45
        score *= this.computeAuthorityMultiplier(r.relPath, r.docSummary, r.sliceText)
        hits.push({
          relPath: r.relPath,
          symbolName: r.symbolName,
          qualifiedName: r.qualifiedName,
          kind: r.kind,
          startLine: r.startLine,
          endLine: r.endLine,
          score: Math.round(score * 1000) / 1000,
          signature: r.signature,
          docSummary: r.docSummary,
        })
      }

      // Supplement with file-level body matches (e.g. large tables/documents where term is outside symbol headers)
      const fileRows = this.db
        .prepare(
          `SELECT
            CAST(ff.file_id AS INTEGER) AS fileId,
            fi.rel_path AS relPath,
            fi.lang AS lang,
            fi.summary AS summary,
            fi.headings AS headings,
            fi.is_hub AS isHub,
            bm25(fts_files, 0.0, 4.0, 3.5, 2.5, 1.2) AS rawBm25
           FROM fts_files ff
           JOIN files fi ON fi.file_id = CAST(ff.file_id AS INTEGER)
           WHERE fts_files MATCH ?
           ORDER BY rawBm25 ASC
           LIMIT ?`,
        )
        .all(ftsExpr, Math.max(limit * 3, 30)) as Array<{
        fileId: number
        relPath: string
        lang: string
        summary: string
        headings: string
        isHub: number
        rawBm25: number
      }>

      for (const fr of fileRows) {
        if (seenFilesInHits.has(fr.relPath)) continue
        if (!this.matchesPathAndCorpus(fr.relPath, fr.lang, pathFilter, corpusFilter)) continue
        seenFilesInHits.add(fr.relPath)
        let score = Math.abs(fr.rawBm25) * 0.9
        if (fr.isHub) score *= 0.45
        score *= this.computeAuthorityMultiplier(fr.relPath, fr.summary, fr.headings)
        const baseName = fr.relPath.split('/').pop() ?? fr.relPath
        hits.push({
          relPath: fr.relPath,
          symbolName: baseName,
          qualifiedName: `${fr.relPath}#file`,
          kind: 'section',
          startLine: 1,
          endLine: 1,
          score: Math.round(score * 1000) / 1000,
          signature: fr.headings || baseName,
          docSummary: fr.summary,
        })
      }
    } catch {
      // Fallback if FTS syntax encounters edge-case characters
    }

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  affectedTests(changedFiles: string[]): string[] {
    this.sync(false)
    const { graph, fileIdToIndex, indexToFile } = this.getCsrGraph()
    const normalizedInputs = changedFiles
      .map((f) => {
        const r = this.resolveRepoPath(f)
        return r.ok ? r.relPath : ''
      })
      .filter(Boolean)
      .map((f) => f.toLowerCase())

    const startNodes: number[] = []
    for (let i = 0; i < indexToFile.length; i++) {
      const relLower = indexToFile[i].relPath.toLowerCase()
      if (
        normalizedInputs.some(
          (inp) => relLower === inp || relLower.endsWith('/' + inp) || inp.endsWith('/' + relLower),
        )
      ) {
        startNodes.push(i)
      }
    }

    const reachable = graph.reverseReachable(startNodes, 6)
    const tests = new Set<string>()
    const isTestFile = (p: string) =>
      /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|^test_.*\.py$/i.test(
        p,
      )

    for (const nodeIdx of reachable.keys()) {
      const f = indexToFile[nodeIdx]
      if (f && isTestFile(f.relPath)) {
        tests.add(f.relPath)
      }
    }

    // Heuristic stem match: if src/adapters/client.ts changed, also match test/adapters.test.mjs
    for (const inp of normalizedInputs) {
      const stem = (inp.split('/').pop() ?? inp)
        .replace(/\.(?:test|spec)?\.?\w+$/, '')
        .toLowerCase()
      if (!stem) continue
      for (const f of indexToFile) {
        if (isTestFile(f.relPath) && f.relPath.toLowerCase().includes(stem)) {
          tests.add(f.relPath)
        }
      }
    }

    return [...tests].sort()
  }

  /**
   * Usages of one symbol across the repository. Confidence: `same_file`; `imported` when the
   * using file imports the target's file (resolved import edge or a named import); `name_only`
   * otherwise. Files that declare their own symbol with that name are skipped (shadowing).
   * Member symbols (`Class.method`) only count member accesses outside their own file.
   */
  findReferences(symbolQuery: string, opts: { path?: string; limit?: number; includeNameOnly?: boolean } = {}): ReferencesResult {
    this.sync(false)
    const matches = this.readSymbol(symbolQuery, { path: opts.path })
    if (matches.length === 0) return { ok: false, reason: `nenhum símbolo '${symbolQuery}' no índice de ${this.repositoryPath}` }
    const bareQuery = symbolQuery.trim().replace(/^.*#/, '')
    const exact = matches.filter((m) => m.qualifiedName.slice(m.relPath.length + 1) === bareQuery)
    const pool = exact.length > 0 ? exact : matches.filter((m) => m.scope !== 'local')
    if (pool.length !== 1) {
      return {
        ok: false,
        reason: `'${symbolQuery}' é ambíguo (${pool.length} candidatos): use caminho#Nome`,
        candidates: (pool.length ? pool : matches).map((m) => m.qualifiedName),
      }
    }
    const target = pool[0]
    const name = target.name
    const isMember = target.scope === 'member'
    const targetFile = this.db.prepare('SELECT file_id FROM files WHERE rel_path = ?').get(target.relPath) as { file_id: number } | undefined
    const targetFileId = targetFile?.file_id ?? -1

    const files = this.db
      .prepare(
        `SELECT f.file_id AS fileId, f.rel_path AS relPath, f.content_hash AS contentHash
         FROM ref_names r JOIN files f ON f.file_id = r.file_id WHERE r.name = ?`,
      )
      .all(name) as Array<{ fileId: number; relPath: string; contentHash: string }>
    const importsTarget = new Set<number>(
      (
        this.db
          .prepare(
            `SELECT src_file_id AS id FROM resolved_edges WHERE dst_file_id = ? AND weight >= 1.2
             UNION SELECT src_file_id AS id FROM raw_edges WHERE kind = 'imports' AND dst_name = ?`,
          )
          .all(targetFileId, name) as Array<{ id: number }>
      ).map((r) => r.id),
    )
    const declaresSameName = new Set<number>(
      (
        this.db.prepare("SELECT DISTINCT file_id AS id FROM symbols WHERE name = ? AND scope != 'local'").all(name) as Array<{ id: number }>
      ).map((r) => r.id),
    )
    const getCas = this.db.prepare('SELECT payload_json FROM cas_extractions WHERE content_hash = ?')
    const symbolsOf = this.db.prepare(
      "SELECT qualified_name AS q, rel_path AS p, start_line AS s, end_line AS e FROM symbols WHERE file_id = ? AND scope != 'local'",
    )

    const rank: Record<RefConfidence, number> = { same_file: 0, imported: 1, name_only: 2 }
    const hits: ReferenceHit[] = []
    const byConfidence: Record<RefConfidence, number> = { same_file: 0, imported: 0, name_only: 0 }
    for (const f of files) {
      const sameFile = f.fileId === targetFileId
      if (!sameFile && declaresSameName.has(f.fileId) && !isMember) continue
      const confidence: RefConfidence = sameFile ? 'same_file' : importsTarget.has(f.fileId) ? 'imported' : 'name_only'
      if (confidence === 'name_only' && opts.includeNameOnly === false) continue
      const row = getCas.get(this.casKey(f.contentHash, f.relPath)) as { payload_json: string } | undefined
      if (!row) continue
      const refs = (JSON.parse(row.payload_json) as ExtractionResult).refs ?? []
      for (const r of refs) {
        if (r[0] !== name) continue
        const kind = r[3]
        if (isMember && !sameFile && kind !== 'member' && kind !== 'member_call') continue
        hits.push({ relPath: f.relPath, line: r[1], col: r[2], kind, confidence, text: '' })
        byConfidence[confidence]++
      }
    }
    hits.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.relPath.localeCompare(b.relPath) || a.line - b.line || a.col - b.col)
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
    const shown = hits.slice(0, limit)
    // Line text and enclosing symbol, only for what is returned.
    const contentCache = new Map<string, string[]>()
    const symCache = new Map<string, Array<{ q: string; p: string; s: number; e: number }>>()
    for (const h of shown) {
      let lines = contentCache.get(h.relPath)
      if (!lines) {
        try {
          lines = readFileSync(join(this.repositoryPath, ...h.relPath.split('/')), 'utf8').split(/\r?\n/)
        } catch {
          lines = []
        }
        contentCache.set(h.relPath, lines)
      }
      h.text = (lines[h.line - 1] ?? '').trim().slice(0, 200)
      let syms = symCache.get(h.relPath)
      if (!syms) {
        const fid = files.find((f) => f.relPath === h.relPath)?.fileId ?? -1
        syms = symbolsOf.all(fid) as Array<{ q: string; p: string; s: number; e: number }>
        symCache.set(h.relPath, syms)
      }
      let best: { q: string; p: string; s: number; e: number } | undefined
      for (const sy of syms) if (sy.s <= h.line && sy.e >= h.line && (!best || sy.e - sy.s < best.e - best.s)) best = sy
      if (best) h.inSymbol = best.q.slice(best.p.length + 1)
    }
    return {
      ok: true,
      target: { qualifiedName: target.qualifiedName, relPath: target.relPath, startLine: target.startLine, kind: target.kind, scope: target.scope },
      total: hits.length,
      byConfidence,
      references: shown,
      truncated: hits.length > shown.length,
    }
  }

  /**
   * Orientation map without a query (Aider-style): code files ranked by PageRank over the
   * forward dependency graph (importer -> imported), optionally personalized to `focus` files,
   * each with its exported signatures, filled until the token budget.
   */
  repoMap(opts: { budget?: number; focus?: string[]; path?: string; includeTests?: boolean } = {}): RepoMapResult {
    this.sync(false)
    const budget = Math.max(200, Math.min(opts.budget ?? 1500, 20_000))
    const { graph, indexToFile } = this.getCsrGraph()
    const N = graph.nodeCount
    const isTest = (p: string) => /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.\w+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/i.test(p)
    const pathFilter = opts.path ? this.resolveRepoPath(opts.path) : null
    if (pathFilter && !pathFilter.ok) return { ok: false, reason: pathFilter.reason, markdown: '', files: [], tokens: 0 }
    const prefix = pathFilter?.ok ? pathFilter.relPath.toLowerCase() : ''
    const eligible = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      const f = indexToFile[i]
      const rel = f.relPath.toLowerCase()
      if (!CODE_LANGUAGES.has(f.lang)) continue
      if (!opts.includeTests && isTest(f.relPath)) continue
      if (prefix && rel !== prefix && !rel.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) continue
      eligible[i] = 1
    }
    const focusIdx = new Set<number>()
    for (const q of opts.focus ?? []) {
      const r = this.resolveRepoPath(q)
      if (!r.ok) continue
      const idx = indexToFile.findIndex((f) => f.relPath.toLowerCase() === r.relPath.toLowerCase())
      if (idx >= 0) focusIdx.add(idx)
    }
    // Teleport: focus files when given, otherwise every eligible file.
    const teleport = new Float64Array(N)
    let tSum = 0
    for (let i = 0; i < N; i++) {
      const w = focusIdx.size > 0 ? (focusIdx.has(i) ? 1 : 0) : eligible[i]
      teleport[i] = w
      tSum += w
    }
    if (tSum === 0) return { ok: true, markdown: '', files: [], tokens: 0, reason: 'nenhum arquivo de código no escopo' }
    for (let i = 0; i < N; i++) teleport[i] /= tSum
    let rank = Float64Array.from(teleport)
    const next = new Float64Array(N)
    const d = 0.85
    // Around focus files, their dependents matter too: reverse edges carry rank at half weight.
    const rev = focusIdx.size > 0 ? 0.5 : 0
    const outW = new Float64Array(N)
    for (let u = 0; u < N; u++) {
      for (let k = graph.rowPtr[u]; k < graph.rowPtr[u + 1]; k++) outW[u] += graph.weights[k]
      if (rev) for (let k = graph.reverseRowPtr[u]; k < graph.reverseRowPtr[u + 1]; k++) outW[u] += graph.reverseWeights[k] * rev
    }
    for (let iter = 0; iter < 30; iter++) {
      let dangling = 0
      next.fill(0)
      for (let u = 0; u < N; u++) {
        if (outW[u] <= 0) {
          dangling += rank[u]
          continue
        }
        const share = (d * rank[u]) / outW[u]
        for (let k = graph.rowPtr[u]; k < graph.rowPtr[u + 1]; k++) next[graph.colIdx[k]] += share * graph.weights[k]
        if (rev) for (let k = graph.reverseRowPtr[u]; k < graph.reverseRowPtr[u + 1]; k++) next[graph.reverseColIdx[k]] += share * graph.reverseWeights[k] * rev
      }
      for (let i = 0; i < N; i++) next[i] += ((1 - d) + d * dangling) * teleport[i]
      rank = Float64Array.from(next)
    }

    // Focus files lead (they are what the map is about), then everything else by rank.
    const order = [...rank.keys()]
      .filter((i) => eligible[i] || focusIdx.has(i))
      .sort((a, b) => Number(focusIdx.has(b)) - Number(focusIdx.has(a)) || rank[b] - rank[a])
    const symStmt = this.db.prepare(
      `SELECT name, kind, scope, parent, signature, start_line AS line FROM symbols
       WHERE file_id = ? AND scope != 'local' AND exported = 1 AND kind != 'section'
       ORDER BY start_line ASC`,
    )
    const tok = (s: string) => Math.ceil(s.length / 4) + 1
    const out: string[] = []
    const files: RepoMapResult['files'] = []
    let used = 0
    const MAX_SYMS = 14
    for (const i of order) {
      const f = indexToFile[i]
      const syms = symStmt.all(f.fileId) as Array<{ name: string; kind: string; scope: string; parent: string | null; signature: string; line: number }>
      const header = `${f.relPath}${focusIdx.has(i) ? '  (foco)' : ''}`
      const lines: string[] = []
      for (const s of syms.slice(0, MAX_SYMS)) {
        let sig = s.signature.replace(/\s+/g, ' ').trim()
        if (s.parent && sig.startsWith(`${s.parent}.`)) sig = sig.slice(s.parent.length + 1)
        if (s.parent && sig.includes(` ${s.parent}.`)) sig = sig.replace(` ${s.parent}.`, ' ')
        lines.push(`${s.scope === 'member' ? '    ' : '  '}${sig.length > 100 ? `${sig.slice(0, 99)}…` : sig}`)
      }
      if (syms.length > MAX_SYMS) lines.push(`  … +${syms.length - MAX_SYMS} símbolos (file_outline)`)
      const cost = tok(header) + lines.reduce((n, l) => n + tok(l), 0)
      if (used + cost > budget) {
        // the header alone still fits: list the file without signatures
        if (used + tok(header) <= budget && files.length > 0) {
          out.push(header)
          used += tok(header)
          files.push({ path: f.relPath, score: Number(rank[i].toFixed(5)), symbols: 0 })
          continue
        }
        if (files.length === 0) {
          out.push(header, ...lines.slice(0, Math.max(1, Math.floor((budget - tok(header)) / 12))))
          files.push({ path: f.relPath, score: Number(rank[i].toFixed(5)), symbols: syms.length })
        }
        break
      }
      out.push(header, ...lines)
      used += cost
      files.push({ path: f.relPath, score: Number(rank[i].toFixed(5)), symbols: syms.length })
    }
    const markdown = out.join('\n')
    return { ok: true, markdown, files, tokens: Math.ceil(markdown.length / 4), omittedFiles: Math.max(0, order.length - files.length) }
  }

  computeBlastRadius(targetSymbolOrPath: string): BlastRadiusReport {
    const t0 = performance.now()
    this.sync(false)
    const { graph, fileIdToIndex, indexToFile } = this.getCsrGraph()
    const lowerTarget = targetSymbolOrPath.toLowerCase()

    const matchingSymFiles = this.db
      .prepare(
        `SELECT DISTINCT file_id, rel_path, name, kind, start_line
         FROM symbols
         WHERE lower(name) = ? OR lower(rel_path) LIKE ? ESCAPE '\\'`,
      )
      .all(lowerTarget, `%${likeEscape(lowerTarget)}%`) as Array<{
      file_id: number
      rel_path: string
      name: string
      kind: string
      start_line: number
    }>

    const startNodes: number[] = []
    for (const m of matchingSymFiles) {
      const idx = fileIdToIndex.get(m.file_id)
      if (idx !== undefined) startNodes.push(idx)
    }

    const reachable = graph.reverseReachable(startNodes, 5)
    const transitiveFiles: string[] = []
    for (const [nodeIdx, depth] of reachable.entries()) {
      if (depth > 0 && indexToFile[nodeIdx]) {
        transitiveFiles.push(indexToFile[nodeIdx].relPath)
      }
    }

    const directCallerRows = this.db
      .prepare(
        `SELECT f.rel_path AS relPath, r.src_sym_name AS symbolName, r.kind AS kind
         FROM raw_edges r
         JOIN files f ON f.file_id = r.src_file_id
         WHERE lower(r.dst_name) = ?
         LIMIT 50`,
      )
      .all(lowerTarget) as Array<{ relPath: string; symbolName: string; kind: string }>

    const affectedTests = this.affectedTests([
      ...matchingSymFiles.map((m) => m.rel_path),
      ...transitiveFiles,
    ])

    const totalImpact = directCallerRows.length + transitiveFiles.length
    const riskLevel: BlastRadiusReport['riskLevel'] =
      totalImpact > 20 ? 'critical' : totalImpact > 8 ? 'high' : totalImpact > 2 ? 'medium' : 'low'

    return {
      repositoryPath: this.repositoryPath,
      target: targetSymbolOrPath,
      directCallers: directCallerRows.map((c) => ({
        repo: this.repositoryPath,
        relPath: c.relPath,
        symbolName: c.symbolName,
        kind: c.kind,
        line: 1,
      })),
      transitiveFiles: transitiveFiles.sort(),
      affectedTests,
      crossRepoImpacts: [],
      riskLevel,
      elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
    }
  }

  savePackSnapshot(etag: string, sliceEtags: Map<string, string>): void {
    try {
      const obj = Object.fromEntries(sliceEtags.entries())
      this.db
        .prepare(
          'INSERT OR REPLACE INTO pack_snapshots(etag, slice_etags_json, created_at) VALUES (?, ?, ?)',
        )
        .run(etag, JSON.stringify(obj), Date.now())
    } catch {}
  }

  loadPackSnapshot(etag: string): Map<string, string> | null {
    try {
      const row = this.db
        .prepare('SELECT slice_etags_json FROM pack_snapshots WHERE etag = ?')
        .get(etag) as { slice_etags_json: string } | undefined
      if (!row) return null
      const parsed = JSON.parse(row.slice_etags_json) as Record<string, string>
      return new Map(Object.entries(parsed))
    } catch {
      return null
    }
  }

  /** Finds the indexed row for a file argument (exact, then path-suffix, then substring). */
  private findFileRow(rel: string): {
    row?: { file_id: number; rel_path: string; token_estimate: number }
    others: string[]
  } {
    const norm = rel.toLowerCase()
    const exact = this.db
      .prepare('SELECT file_id, rel_path, token_estimate FROM files WHERE lower(rel_path) = ?')
      .get(norm) as { file_id: number; rel_path: string; token_estimate: number } | undefined
    if (exact) return { row: exact, others: [] }
    const suffix = this.db
      .prepare(
        `SELECT file_id, rel_path, token_estimate FROM files
         WHERE lower(rel_path) LIKE ? ESCAPE '\\' ORDER BY length(rel_path) ASC LIMIT 6`,
      )
      .all(`%/${likeEscape(norm)}`) as Array<{ file_id: number; rel_path: string; token_estimate: number }>
    if (suffix.length > 0) return { row: suffix[0], others: suffix.slice(1).map((r) => r.rel_path) }
    return { others: [] }
  }

  /** Similar indexed file paths, used when a file argument matches nothing. */
  private suggestFiles(rel: string, limit = 5): string[] {
    const base = (rel.split('/').pop() ?? rel).replace(/\.\w+$/, '').toLowerCase()
    if (!base) return []
    return (
      this.db
        .prepare("SELECT rel_path FROM files WHERE lower(rel_path) LIKE ? ESCAPE '\\' ORDER BY length(rel_path) ASC LIMIT ?")
        .all(`%${likeEscape(base)}%`, limit) as Array<{ rel_path: string }>
    ).map((r) => r.rel_path)
  }

  fileOutline(fileQuery: string, opts: { scope?: OutlineScope } = {}): FileOutlineResult {
    const scope: OutlineScope = opts.scope ?? 'topo'
    const resolved = this.resolveRepoPath(fileQuery)
    if (!resolved.ok) return { found: false, reason: resolved.reason, suggestions: [] }
    const rel = resolved.relPath
    if (!rel) return { found: false, reason: 'informe um arquivo, não a raiz do repositório', suggestions: [] }

    this.refreshFile(rel)
    this.sync(false)
    let match = this.findFileRow(rel)
    if (!match.row) {
      const why = this.firewall.explainExclusion(this.repositoryPath, rel)
      if (why === null) {
        // Admissible but missing: index right now instead of answering empty.
        this.lastSyncEpochMs = 0
        this.sync(false)
        match = this.findFileRow(rel)
      }
      if (!match.row) {
        return {
          found: false,
          relPath: rel,
          reason: why ? `arquivo não indexado: ${why}` : 'arquivo não indexado (não encontrado após reindexar)',
          suggestions: this.suggestFiles(rel),
        }
      }
    }
    const fileRow = match.row

    const all = this.db
      .prepare(
        `SELECT name, qualified_name AS qualifiedName, kind, scope, exported,
                start_line AS startLine, end_line AS endLine, signature, doc_summary AS docSummary
         FROM symbols
         WHERE file_id = ?
         ORDER BY start_line ASC, end_line DESC`,
      )
      .all(fileRow.file_id) as Array<Omit<OutlineSymbol, 'exported' | 'qualifiedName'> & { exported: number; qualifiedName: string }>

    const visible = all.filter((s) => {
      if (scope === 'tudo') return true
      if (scope === 'exportado') return s.exported === 1 && s.scope !== 'local'
      return s.scope !== 'local'
    })
    const symbols: OutlineSymbol[] = visible.map((s) => ({
      ...s,
      qualifiedName: s.qualifiedName.slice(s.qualifiedName.indexOf('#') + 1),
      exported: s.exported === 1,
    }))

    const outlineText = symbols.map((s) => `${s.signature} // L${s.startLine}-${s.endLine}`).join('\n')
    return {
      found: true,
      relPath: fileRow.rel_path,
      tokenEstimate: fileRow.token_estimate,
      outlineTokens: Math.max(1, Math.ceil(outlineText.length / 4)),
      scope,
      hiddenSymbols: all.length - visible.length,
      otherMatches: match.others.length ? match.others : undefined,
      reason: all.length === 0 ? 'arquivo indexado, mas sem declarações reconhecidas' : undefined,
      symbols,
    }
  }

  /**
   * Reads symbols by name. Accepts `name`, `Class.member`, `path#name` or `path:name`.
   * Exact name/qualified matches win; locals rank last.
   */
  readSymbol(symbolQuery: string, opts: { path?: string } = {}): SymbolSlice[] {
    let query = symbolQuery.trim()
    let pathFilter = opts.path
    const hashIdx = query.lastIndexOf('#')
    const colonIdx = query.lastIndexOf(':')
    const looksLikePath = (p: string) => /[\\/]/.test(p) || /\.\w{1,5}$/.test(p)
    if (hashIdx > 0 && looksLikePath(query.slice(0, hashIdx))) {
      pathFilter = pathFilter ?? query.slice(0, hashIdx)
      query = query.slice(hashIdx + 1)
    } else if (colonIdx > 1 && /\.\w+$/.test(query.slice(0, colonIdx))) {
      pathFilter = pathFilter ?? query.slice(0, colonIdx)
      query = query.slice(colonIdx + 1)
    }
    let relFilter = ''
    if (pathFilter) {
      const r = this.resolveRepoPath(pathFilter)
      if (!r.ok) return []
      relFilter = r.relPath.toLowerCase()
      this.refreshFile(r.relPath)
    }
    this.sync(false)

    const run = (): SymbolSlice[] => {
      const lower = query.toLowerCase()
      const rows = this.db
        .prepare(
          `SELECT
            rel_path AS relPath, name, qualified_name AS qualifiedName,
            kind, scope, start_line AS startLine, end_line AS endLine,
            signature, doc_summary AS docSummary,
            token_estimate AS tokens, slice_text AS sliceText, body_hash AS hash,
            CASE
              WHEN lower(qualified_name) LIKE '%#' || ? ESCAPE '\\' THEN 0
              WHEN lower(name) = ? THEN 1
              WHEN lower(qualified_name) LIKE '%.' || ? ESCAPE '\\' THEN 2
              ELSE 3
            END AS rank
           FROM symbols
           WHERE (lower(name) = ? OR lower(qualified_name) LIKE '%#' || ? ESCAPE '\\' OR lower(qualified_name) LIKE '%.' || ? ESCAPE '\\')
             AND (? = '' OR lower(rel_path) = ? OR lower(rel_path) LIKE '%/' || ? ESCAPE '\\' OR lower(rel_path) LIKE ? || '/%' ESCAPE '\\')
           ORDER BY rank ASC, CASE scope WHEN 'local' THEN 1 ELSE 0 END ASC, exported DESC, token_estimate ASC
           LIMIT 5`,
        )
        .all(likeEscape(lower), lower, likeEscape(lower), lower, likeEscape(lower), likeEscape(lower), relFilter, relFilter, likeEscape(relFilter), likeEscape(relFilter)) as Array<
        SymbolSlice & { rank: number }
      >
      return rows.map(({ rank: _rank, ...rest }) => rest)
    }

    let results = run()
    // Freshness: if any matched file changed on disk since indexing, resync and re-read.
    const stale = [...new Set(results.map((r) => r.relPath))].some((rp) => this.refreshFile(rp))
    if (stale) results = run()
    return results
  }

  /** Names close to a symbol query, used to explain an empty read_symbol. */
  similarSymbolNames(symbolQuery: string, limit = 8): string[] {
    const q = symbolQuery.replace(/^.*[#:]/, '').toLowerCase()
    const tail = q.split('.').pop() ?? q
    if (tail.length < 3) return []
    return (
      this.db
        .prepare(
          `SELECT DISTINCT substr(qualified_name, instr(qualified_name, '#') + 1) AS qn
           FROM symbols WHERE lower(name) LIKE ? ESCAPE '\\' AND scope != 'local'
           ORDER BY length(name) ASC LIMIT ?`,
        )
        .all(`%${likeEscape(tail.slice(0, Math.max(3, Math.min(tail.length, 12))))}%`, limit) as Array<{ qn: string }>
    ).map((r) => r.qn)
  }

  /**
   * Built-in text search over the indexed files (the "ripgrep" fallback used when the
   * symbol index has no answer). Scores lines by how many distinct terms they contain.
   */
  textSearch(
    terms: string[],
    opts: { path?: string; limit?: number; wholeWord?: boolean } = {},
  ): TextHit[] {
    const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    const cleanTerms = [...new Set(terms.map(fold).filter((t) => t.length >= 2))].slice(0, 12)
    if (cleanTerms.length === 0) return []
    const limit = opts.limit ?? 15
    let relFilter = ''
    if (opts.path) {
      const r = this.resolveRepoPath(opts.path)
      if (!r.ok) return []
      relFilter = r.relPath.toLowerCase()
    }
    const files = (
      this.db.prepare('SELECT rel_path FROM files ORDER BY rel_path ASC').all() as Array<{ rel_path: string }>
    )
      .map((r) => r.rel_path)
      .filter((rp) => !relFilter || rp.toLowerCase() === relFilter || rp.toLowerCase().startsWith(relFilter + '/'))
      .slice(0, 4000)
    const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regexes = cleanTerms.map((t) => new RegExp(opts.wholeWord ? `\\b${escape(t)}\\b` : escape(t)))
    const minTerms = cleanTerms.length === 1 ? 1 : Math.min(2, cleanTerms.length)
    const hits: TextHit[] = []
    let bytes = 0
    for (const rp of files) {
      if (bytes > 48 * 1024 * 1024) break
      let content: string
      try {
        content = readFileSync(join(this.repositoryPath, ...rp.split('/')), 'utf8')
      } catch {
        continue
      }
      bytes += content.length
      const pathFolded = fold(rp)
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const folded = fold(lines[i])
        let matched = 0
        for (let k = 0; k < regexes.length; k++) {
          if (regexes[k].test(folded) || regexes[k].test(pathFolded)) matched++
        }
        if (matched >= minTerms && regexes.some((re) => re.test(folded))) {
          hits.push({ relPath: rp, line: i + 1, text: lines[i].trim().slice(0, 220), matchedTerms: matched })
        }
      }
    }
    hits.sort((a, b) => b.matchedTerms - a.matchedTerms || a.relPath.localeCompare(b.relPath) || a.line - b.line)
    return hits.slice(0, limit)
  }

  /** Search with an explicit outcome: index hits, text fallback hits, or the reason for nothing. */
  searchDetailed(
    query: string,
    opts: SearchOptions = {},
  ): { results: SearchHit[]; total: number; via: 'indice' | 'busca_textual' | 'nenhum'; reason?: string; textHits?: TextHit[] } {
    if (opts.path && opts.path.trim()) {
      const r = this.resolveRepoPath(opts.path)
      if (!r.ok) return { results: [], total: 0, via: 'nenhum', reason: r.reason }
    }
    const results = this.search(query, opts)
    if (results.length > 0) return { results, total: results.length, via: 'indice' }

    const fileCount = (this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
    const terms = this.buildFtsQueryTerms(query).map((t) => t.replace(/^"|"\*$/g, ''))
    let reason: string
    if (fileCount === 0) reason = 'índice vazio: nenhum arquivo admitido neste repositório'
    else if (terms.length === 0) reason = 'consulta sem termos pesquisáveis (só palavras muito curtas ou stopwords)'
    else reason = 'nenhum símbolo ou documento do índice casou com a consulta'
    if (opts.path && opts.path.trim()) {
      const rel = (this.resolveRepoPath(opts.path) as { ok: true; relPath: string }).relPath.toLowerCase()
      const under = (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM files WHERE lower(rel_path) = ? OR lower(rel_path) LIKE ? ESCAPE '\\'")
          .get(rel, `${likeEscape(rel)}/%`) as { c: number }
      ).c
      if (under === 0) reason = `nenhum arquivo indexado sob '${rel}'`
    }
    const rawTerms = query
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_/.-]+/)
      .filter((t) => t.length >= 3)
    const textHits = this.textSearch(rawTerms, { path: opts.path, limit: opts.limit ?? 15 })
    if (textHits.length > 0) {
      return { results: [], total: textHits.length, via: 'busca_textual', reason: `${reason}; resultado via busca textual`, textHits }
    }
    return { results: [], total: 0, via: 'nenhum', reason }
  }

  callGraph(symbolName: string): {
    symbol: string
    callers: Array<{ relPath: string; callerSymbol: string; kind: string }>
    callees: Array<{ relPath: string; calleeSymbol: string; kind: string }>
  } {
    this.sync(false)
    const lower = symbolName.toLowerCase()
    const callers = this.db
      .prepare(
        `SELECT f.rel_path AS relPath, r.src_sym_name AS callerSymbol, r.kind AS kind
         FROM raw_edges r
         JOIN files f ON f.file_id = r.src_file_id
         WHERE lower(r.dst_name) = ?
         LIMIT 40`,
      )
      .all(lower) as Array<{ relPath: string; callerSymbol: string; kind: string }>

    const callees = this.db
      .prepare(
        `SELECT f.rel_path AS relPath, r.dst_name AS calleeSymbol, r.kind AS kind
         FROM raw_edges r
         JOIN files f ON f.file_id = r.src_file_id
         WHERE lower(r.src_sym_name) = ? OR lower(r.src_sym_name) LIKE ? ESCAPE '\\'
         LIMIT 40`,
      )
      .all(lower, `%.${likeEscape(lower)}`) as Array<{ relPath: string; calleeSymbol: string; kind: string }>

    return { symbol: symbolName, callers, callees }
  }

  diffImpact(windowMinutes = 60): {
    repositoryPath: string
    recentlyModifiedFiles: string[]
    contractDrifts: Array<{
      qualifiedName: string
      relPath: string
      prevSignature: string
      previousSignature: string
      currentSignature: string
      breaking: boolean
      affectedCallers: number
    }>
    affectedTests: string[]
  } {
    this.sync(false)
    const cutoff = Date.now() - windowMinutes * 60_000
    const recentFiles = (
      this.db
        .prepare('SELECT rel_path FROM files WHERE mtime_ms >= ? ORDER BY mtime_ms DESC LIMIT 30')
        .all(cutoff) as Array<{ rel_path: string }>
    ).map((r) => r.rel_path)

    const driftRows = this.db
      .prepare(
        `SELECT
          s.qualified_name AS qualifiedName,
          s.rel_path AS relPath,
          s.name AS symName,
          h.prev_signature AS previousSignature,
          s.signature AS currentSignature
         FROM symbols s
         JOIN symbol_history h ON h.qualified_name = s.qualified_name
         WHERE h.prev_signature != s.signature
           AND h.updated_at >= ?
           AND s.exported = 1
           AND s.scope != 'local'`,
      )
      .all(cutoff) as Array<{
      qualifiedName: string
      relPath: string
      symName: string
      previousSignature: string
      currentSignature: string
    }>

    // Contract drift is about exported API: test files never define one.
    const isTestPath = (p: string) =>
      /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|(?:^|\/)test_[^/]*\.py$/i.test(p)
    // A symbol that only gained `export` became public API; no existing caller breaks.
    const withoutExport = (sig: string) => sig.replace(/^\s*export\s+(?:default\s+)?/, '').replace(/\s+/g, ' ').trim()
    const contractDrifts = driftRows
      .filter((d) => !isTestPath(d.relPath))
      .filter((d) => withoutExport(d.previousSignature) !== withoutExport(d.currentSignature))
      .map((d) => {
      const callerCount = (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM raw_edges WHERE lower(dst_name) = ?')
          .get(d.symName.toLowerCase()) as { c: number }
      ).c
      return {
        qualifiedName: d.qualifiedName,
        relPath: d.relPath,
        prevSignature: d.previousSignature,
        previousSignature: d.previousSignature,
        currentSignature: d.currentSignature,
        breaking: true,
        affectedCallers: callerCount,
      }
    })

    const affectedTests = this.affectedTests(recentFiles)
    return {
      repositoryPath: this.repositoryPath,
      recentlyModifiedFiles: recentFiles,
      contractDrifts,
      affectedTests,
    }
  }

  getTopology(): {
    repositoryPath: string
    nodes: Array<{
      id: number
      relPath: string
      lang: string
      tokenEstimate: number
      isHub: boolean
      symbolCount: number
      inDegree: number
      outDegree: number
    }>
    edges: Array<{
      source: number
      target: number
      weight: number
    }>
  } {
    this.sync(false)
    const { graph, indexToFile } = this.getCsrGraph()
    const symCounts = new Map<number, number>()
    const symRows = this.db
      .prepare('SELECT file_id, COUNT(*) AS c FROM symbols GROUP BY file_id')
      .all() as Array<{ file_id: number; c: number }>
    for (const r of symRows) symCounts.set(r.file_id, r.c)

    const nodes = indexToFile.map((f, idx) => ({
      id: f.fileId,
      relPath: f.relPath,
      lang: f.lang,
      tokenEstimate: f.tokenEstimate,
      isHub: Boolean(f.isHub),
      symbolCount: symCounts.get(f.fileId) ?? 0,
      inDegree: graph.inDegree[idx] ?? 0,
      outDegree: graph.outDegree[idx] ?? 0,
    }))

    const edges = this.db
      .prepare('SELECT src_file_id AS source, dst_file_id AS target, weight FROM resolved_edges')
      .all() as Array<{ source: number; target: number; weight: number }>

    return {
      repositoryPath: this.repositoryPath,
      nodes,
      edges,
    }
  }

  buildFtsQueryTerms(raw: string): string[] {
    const PT_EN_STOPWORDS = new Set([
      'o',
      'a',
      'os',
      'as',
      'um',
      'uma',
      'de',
      'do',
      'da',
      'dos',
      'das',
      'em',
      'no',
      'na',
      'nos',
      'nas',
      'por',
      'para',
      'com',
      'sem',
      'como',
      'qual',
      'quais',
      'onde',
      'quem',
      'que',
      'se',
      'ao',
      'aos',
      'ou',
      'e',
      'sao',
      'esta',
      'estao',
      'foi',
      'ser',
      'tem',
      'ter',
      'mais',
      'menos',
      'muito',
      'sobre',
      'entre',
      'the',
      'and',
      'for',
      'with',
      'from',
      'that',
      'this',
      'what',
      'where',
      'which',
      'how',
      'are',
      'was',
      'were',
      'into',
    ])

    const normalized = raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()

    const rawDirect = raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean)

    const rawTokens = [...rawDirect, ...normalized.split(/[^a-z0-9_]+/).filter(Boolean)]
    const cleanTokens: string[] = []
    const seen = new Set<string>()

    for (const tok of rawTokens) {
      if (tok.length < 2 || PT_EN_STOPWORDS.has(tok)) continue
      if (seen.has(tok)) continue
      seen.add(tok)
      cleanTokens.push(`"${tok}"*`)
    }

    return cleanTokens.slice(0, 18)
  }

  health(): ShardHealth {
    this.sync(false)
    const fCount = (this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
    const sCount = (this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c
    const eCount = (
      this.db.prepare('SELECT COUNT(*) AS c FROM resolved_edges').get() as { c: number }
    ).c
    const rCount = (this.db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c
    const lastRow = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'")
      .get() as { value: string } | undefined

    let dbSizeBytes = 0
    let walSizeBytes = 0
    try {
      if (existsSync(this.shardPath)) dbSizeBytes = statSync(this.shardPath).size
      const walPath = `${this.shardPath}-wal`
      if (existsSync(walPath)) walSizeBytes = statSync(walPath).size
    } catch {}

    return {
      repositoryPath: this.repositoryPath,
      shardPath: this.shardPath,
      fileCount: fCount,
      symbolCount: sCount,
      edgeCount: eCount,
      routeCount: rCount,
      dbSizeBytes,
      walSizeBytes,
      lastIndexedAt: lastRow?.value ?? new Date().toISOString(),
      schemaVersion: SHARD_SCHEMA_VERSION,
      extractorVersion: extractorVersion(),
      indexAge: this.indexAgeSummary(),
    }
  }

  private indexAgeSummary(): NonNullable<ShardHealth['indexAge']> {
    const now = Date.now()
    const ageRows = this.db
      .prepare('SELECT rel_path AS relPath, indexed_at AS indexedAt FROM files ORDER BY indexed_at ASC LIMIT 5')
      .all() as Array<{ relPath: string; indexedAt: number }>
    const newest = this.db.prepare('SELECT MAX(indexed_at) AS m FROM files').get() as { m: number | null }
    return {
      lastSyncAt: this.lastSyncAtIso || null,
      newestFileIndexedAt: newest.m ? new Date(newest.m).toISOString() : null,
      oldestFiles: ageRows.map((r) => ({
        relPath: r.relPath,
        indexedAt: r.indexedAt ? new Date(r.indexedAt).toISOString() : null,
        ageSeconds: r.indexedAt ? Math.round((now - r.indexedAt) / 1000) : null,
      })),
    }
  }

  /** Index age of one file: when it was indexed and whether the disk copy is newer. */
  fileIndexAge(fileQuery: string): {
    relPath: string
    indexedAt: string | null
    ageSeconds: number | null
    staleOnDisk: boolean
    reason?: string
  } {
    const r = this.resolveRepoPath(fileQuery)
    if (!r.ok) return { relPath: fileQuery, indexedAt: null, ageSeconds: null, staleOnDisk: false, reason: r.reason }
    const row = this.db
      .prepare('SELECT rel_path, indexed_at, mtime_ms, byte_size FROM files WHERE lower(rel_path) = ?')
      .get(r.relPath.toLowerCase()) as
      | { rel_path: string; indexed_at: number; mtime_ms: number; byte_size: number }
      | undefined
    if (!row) {
      return {
        relPath: r.relPath,
        indexedAt: null,
        ageSeconds: null,
        staleOnDisk: false,
        reason: this.firewall.explainExclusion(this.repositoryPath, r.relPath) ?? 'arquivo ainda não indexado',
      }
    }
    let staleOnDisk = false
    try {
      const st = statSync(join(this.repositoryPath, ...row.rel_path.split('/')))
      staleOnDisk = Math.trunc(st.mtimeMs) !== row.mtime_ms || st.size !== row.byte_size
    } catch {
      staleOnDisk = true
    }
    return {
      relPath: row.rel_path,
      indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
      ageSeconds: row.indexed_at ? Math.round((Date.now() - row.indexed_at) / 1000) : null,
      staleOnDisk,
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {}
  }
}
