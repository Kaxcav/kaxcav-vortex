import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AdmissionFirewall } from '../core/firewall.ts'
import type {
  BlastRadiusReport,
  ExtractionResult,
  SearchHit,
  ShardHealth,
  StoredFileRow,
  StoredSymbolRow,
} from '../core/types.ts'
import { CsrGraph, type CsrEdgeInput } from '../graph/csr.ts'
import { PolyglotExtractor } from '../parser/extractor.ts'

export class RepositoryShard {
  readonly repositoryPath: string
  readonly shardPath: string
  readonly db: DatabaseSync
  private readonly firewall: AdmissionFirewall
  private readonly extractor: PolyglotExtractor
  private cachedGraph: CsrGraph | null = null
  private lastSyncEpochMs = 0

  constructor(repositoryPath: string, storageRoot: string) {
    this.repositoryPath = resolve(repositoryPath)
    mkdirSync(storageRoot, { recursive: true })
    const slug = this.computeRepoSlug(this.repositoryPath)
    this.shardPath = join(storageRoot, `shard-${slug}.sqlite`)
    this.db = new DatabaseSync(this.shardPath)
    this.firewall = new AdmissionFirewall(this.repositoryPath)
    this.extractor = new PolyglotExtractor()
    this.initializeSchema()
  }

  private computeRepoSlug(repoPath: string): string {
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
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA journal_size_limit = 33554432;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 67108864;

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
        headings TEXT NOT NULL DEFAULT ''
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
        is_hub INTEGER NOT NULL DEFAULT 0
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
    if (!force && this.lastSyncEpochMs > 0 && now - this.lastSyncEpochMs < 2_500) {
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
      const getCasStmt = this.db.prepare(
        'SELECT payload_json FROM cas_extractions WHERE content_hash = ?',
      )
      const putCasStmt = this.db.prepare(
        'INSERT OR REPLACE INTO cas_extractions(content_hash, payload_json) VALUES (?, ?)',
      )
      const upsertFileStmt = this.db.prepare(`
        INSERT INTO files(rel_path, content_hash, mtime_ms, byte_size, lang, token_estimate, is_hub, summary, headings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          mtime_ms = excluded.mtime_ms,
          byte_size = excluded.byte_size,
          lang = excluded.lang,
          token_estimate = excluded.token_estimate,
          is_hub = excluded.is_hub,
          summary = excluded.summary,
          headings = excluded.headings
        RETURNING file_id
      `)

      const delSymbolsByFile = this.db.prepare('DELETE FROM symbols WHERE file_id = ?')
      const delEdgesByFile = this.db.prepare('DELETE FROM raw_edges WHERE src_file_id = ?')
      const delRoutesByFile = this.db.prepare('DELETE FROM routes WHERE file_id = ?')
      const delFtsSymByFile = this.db.prepare('DELETE FROM fts_symbols WHERE file_id = ?')
      const delFtsFileById = this.db.prepare('DELETE FROM fts_files WHERE file_id = ?')

      const insertSymStmt = this.db.prepare(`
        INSERT INTO symbols(
          file_id, rel_path, name, qualified_name, kind, exported,
          start_line, end_line, signature, body_hash, token_estimate, doc_summary, slice_text, is_hub
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING sym_id
      `)
      const insertFtsSymStmt = this.db.prepare(`
        INSERT INTO fts_symbols(sym_id, file_id, rel_path, name, signature, doc_summary, slice_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFtsFileStmt = this.db.prepare(`
        INSERT INTO fts_files(file_id, rel_path, headings, summary, body_text)
        VALUES (?, ?, ?, ?, ?)
      `)
      const insertEdgeStmt = this.db.prepare(`
        INSERT INTO raw_edges(src_file_id, src_sym_name, dst_name, dst_path_hint, kind, weight)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
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
            .prepare('UPDATE files SET mtime_ms = ?, byte_size = ? WHERE file_id = ?')
            .run(fp.mtimeMs, fp.byteSize, prev.file_id)
          continue
        }

        let extraction: ExtractionResult
        const cachedCas = getCasStmt.get(scanned.contentHash) as { payload_json: string } | undefined
        if (cachedCas) {
          extraction = JSON.parse(cachedCas.payload_json) as ExtractionResult
        } else {
          extraction = this.extractor.extract(scanned)
          putCasStmt.run(scanned.contentHash, JSON.stringify(extraction))
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
        ) as { file_id: number }

        const fileId = fileRow.file_id

        // Record previous signatures in symbol_history for Contract Drift detection
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

        delSymbolsByFile.run(fileId)
        delEdgesByFile.run(fileId)
        delRoutesByFile.run(fileId)
        delFtsSymByFile.run(String(fileId))
        delFtsFileById.run(String(fileId))

        insertFtsFileStmt.run(
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
          ) as { sym_id: number }

          insertFtsSymStmt.run(
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

        updatedFiles++
      }

      // Remove deleted files
      for (const prev of existingRows) {
        if (!seenPaths.has(prev.rel_path)) {
          delSymbolsByFile.run(prev.file_id)
          delEdgesByFile.run(prev.file_id)
          delRoutesByFile.run(prev.file_id)
          delFtsSymByFile.run(String(prev.file_id))
          delFtsFileById.run(String(prev.file_id))
          this.db.prepare('DELETE FROM files WHERE file_id = ?').run(prev.file_id)
          removedFiles++
        }
      }

      if (updatedFiles > 0 || removedFiles > 0 || force) {
        this.rebuildResolvedFileEdges()
        this.cachedGraph = null
      }

      this.db
        .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
        .run('last_indexed_at', new Date().toISOString())
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.lastSyncEpochMs = Date.now()
    const elapsedMs = Math.round((performance.now() - t0) * 100) / 100
    return {
      totalFiles: fingerprints.length,
      updatedFiles,
      removedFiles,
      elapsedMs,
    }
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

    const fileByBasename = new Map<string, number[]>()
    const fileByRelNoExt = new Map<string, number>()

    for (const f of files) {
      const noExt = f.rel_path.replace(/\.\w+$/, '').toLowerCase()
      fileByRelNoExt.set(noExt, f.file_id)
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
    const addEdge = (src: number, dst: number, w: number) => {
      if (src === dst) return
      const key = `${src}:${dst}`
      const cur = edgeAccumulator.get(key)
      if (cur) {
        cur.weight = Math.min(10, cur.weight + w)
      } else {
        edgeAccumulator.set(key, { src, dst, weight: w })
      }
    }

    for (const e of rawEdges) {
      if (e.dst_path_hint) {
        const cleanHint = e.dst_path_hint
          .replace(/^\.+\//, '')
          .replace(/\.\w+$/, '')
          .toLowerCase()
        const exactId = fileByRelNoExt.get(cleanHint)
        if (exactId) {
          addEdge(e.src_file_id, exactId, e.weight * 1.5)
          continue
        }
        const baseHint = cleanHint.split('/').pop() ?? cleanHint
        const baseTargets = fileByBasename.get(baseHint)
        if (baseTargets) {
          for (const dstId of baseTargets) addEdge(e.src_file_id, dstId, e.weight)
          continue
        }
      }

      const dstLower = e.dst_name.toLowerCase()
      const symTargets = symbolOwners.get(dstLower)
      if (symTargets && symTargets.length <= 8) {
        for (const dstId of symTargets) {
          addEdge(e.src_file_id, dstId, e.weight / Math.sqrt(symTargets.length))
        }
      } else {
        const baseTargets = fileByBasename.get(dstLower)
        if (baseTargets) {
          for (const dstId of baseTargets) addEdge(e.src_file_id, dstId, e.weight)
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
    }

    return {
      graph: this.cachedGraph,
      fileIdToIndex,
      indexToFile: files,
    }
  }

  search(query: string, limit = 15): SearchHit[] {
    this.sync(false)
    const terms = this.buildFtsQueryTerms(query)
    if (terms.length === 0) return []

    const ftsExpr = terms.join(' OR ')
    const hits: SearchHit[] = []
    const seenSymIds = new Set<number>()

    try {
      const rows = this.db
        .prepare(
          `SELECT
            CAST(f.sym_id AS INTEGER) AS symId,
            s.rel_path AS relPath,
            s.name AS symbolName,
            s.qualified_name AS qualifiedName,
            s.kind AS kind,
            s.start_line AS startLine,
            s.end_line AS endLine,
            s.signature AS signature,
            s.doc_summary AS docSummary,
            s.is_hub AS isHub,
            bm25(fts_symbols, 0.0, 0.0, 3.0, 4.5, 2.5, 2.0, 1.0) AS rawBm25
           FROM fts_symbols f
           JOIN symbols s ON s.sym_id = CAST(f.sym_id AS INTEGER)
           WHERE fts_symbols MATCH ?
           ORDER BY rawBm25 ASC
           LIMIT ?`,
        )
        .all(ftsExpr, limit * 3) as Array<{
        symId: number
        relPath: string
        symbolName: string
        qualifiedName: string
        kind: string
        startLine: number
        endLine: number
        signature: string
        docSummary: string
        isHub: number
        rawBm25: number
      }>

      for (const r of rows) {
        if (seenSymIds.has(r.symId)) continue
        seenSymIds.add(r.symId)
        let score = Math.abs(r.rawBm25)
        if (r.isHub) score *= 0.45
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
    } catch {
      // Fallback to LIKE search if special characters in query
    }

    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  affectedTests(changedFiles: string[]): string[] {
    this.sync(false)
    const { graph, fileIdToIndex, indexToFile } = this.getCsrGraph()
    const normalizedInputs = changedFiles.map((f) =>
      f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(),
    )

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

  computeBlastRadius(targetSymbolOrPath: string): BlastRadiusReport {
    const t0 = performance.now()
    this.sync(false)
    const { graph, fileIdToIndex, indexToFile } = this.getCsrGraph()
    const lowerTarget = targetSymbolOrPath.toLowerCase()

    const matchingSymFiles = this.db
      .prepare(
        `SELECT DISTINCT file_id, rel_path, name, kind, start_line
         FROM symbols
         WHERE lower(name) = ? OR lower(rel_path) LIKE ?`,
      )
      .all(lowerTarget, `%${lowerTarget}%`) as Array<{
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

  fileOutline(fileQuery: string): {
    relPath: string
    tokenEstimate: number
    outlineTokens: number
    symbols: Array<{
      name: string
      kind: string
      startLine: number
      endLine: number
      signature: string
      docSummary: string
    }>
  } | null {
    this.sync(false)
    const norm = fileQuery.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    const fileRow = this.db
      .prepare(
        `SELECT file_id, rel_path, token_estimate
         FROM files
         WHERE lower(rel_path) = ? OR lower(rel_path) LIKE ?
         ORDER BY length(rel_path) ASC
         LIMIT 1`,
      )
      .get(norm, `%${norm}`) as
      | { file_id: number; rel_path: string; token_estimate: number }
      | undefined

    if (!fileRow) return null

    const syms = this.db
      .prepare(
        `SELECT name, kind, start_line AS startLine, end_line AS endLine, signature, doc_summary AS docSummary
         FROM symbols
         WHERE file_id = ?
         ORDER BY start_line ASC`,
      )
      .all(fileRow.file_id) as Array<{
      name: string
      kind: string
      startLine: number
      endLine: number
      signature: string
      docSummary: string
    }>

    const outlineText = syms.map((s) => `${s.signature} // L${s.startLine}-${s.endLine}`).join('\n')
    return {
      relPath: fileRow.rel_path,
      tokenEstimate: fileRow.token_estimate,
      outlineTokens: Math.max(1, Math.ceil(outlineText.length / 4)),
      symbols: syms,
    }
  }

  readSymbol(symbolQuery: string): Array<{
    relPath: string
    name: string
    qualifiedName: string
    kind: string
    startLine: number
    endLine: number
    signature: string
    docSummary: string
    tokens: number
    sliceText: string
  }> {
    this.sync(false)
    const lower = symbolQuery.toLowerCase()
    return this.db
      .prepare(
        `SELECT
          rel_path AS relPath, name, qualified_name AS qualifiedName,
          kind, start_line AS startLine, end_line AS endLine,
          signature, doc_summary AS docSummary,
          token_estimate AS tokens, slice_text AS sliceText
         FROM symbols
         WHERE lower(name) = ? OR lower(qualified_name) LIKE ?
         ORDER BY exported DESC, token_estimate ASC
         LIMIT 5`,
      )
      .all(lower, `%${lower}%`) as Array<{
      relPath: string
      name: string
      qualifiedName: string
      kind: string
      startLine: number
      endLine: number
      signature: string
      docSummary: string
      tokens: number
      sliceText: string
    }>
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
         WHERE lower(r.src_sym_name) = ? OR lower(r.src_sym_name) LIKE ?
         LIMIT 40`,
      )
      .all(lower, `%.${lower}`) as Array<{ relPath: string; calleeSymbol: string; kind: string }>

    return { symbol: symbolName, callers, callees }
  }

  diffImpact(windowMinutes = 60): {
    repositoryPath: string
    recentlyModifiedFiles: string[]
    contractDrifts: Array<{
      qualifiedName: string
      previousSignature: string
      currentSignature: string
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
          s.name AS symName,
          h.prev_signature AS previousSignature,
          s.signature AS currentSignature
         FROM symbols s
         JOIN symbol_history h ON h.qualified_name = s.qualified_name
         WHERE h.prev_signature != s.signature`,
      )
      .all() as Array<{
      qualifiedName: string
      symName: string
      previousSignature: string
      currentSignature: string
    }>

    const contractDrifts = driftRows.map((d) => {
      const callerCount = (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM raw_edges WHERE lower(dst_name) = ?')
          .get(d.symName.toLowerCase()) as { c: number }
      ).c
      return {
        qualifiedName: d.qualifiedName,
        previousSignature: d.previousSignature,
        currentSignature: d.currentSignature,
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
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()

    const rawTokens = normalized.split(/[^a-z0-9_]+/).filter(Boolean)
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
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {}
  }
}
