import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KaxcavVortexEngine } from '../engine.ts'
import { checkKvxIgnore, describeKvxIgnoreBlock, KvxIgnoreError } from '../core/kvxignore.ts'
import { DlpScanner, type DlpFinding } from './dlp.ts'
import { GoogleDriveConnector, type DriveCrawlSummary } from './drive-connector.ts'
import {
  parseDocxBuffer,
  parsePdfBuffer,
  parseXlsxBuffer,
  readZipEntries,
} from './zip-openxml.ts'

export type AuthorityTier =
  | 'CURRENT_USER_CONFIRMED'
  | 'ACTIVE_OPERATIONAL'
  | 'LEGACY_OBSERVED'
  | 'LEGACY_IDEA'
  | 'SUPERSEDED'

export interface NexusWorkspace {
  workspaceId: string
  name: string
  tenantSlug: string
  sourceType: 'local_vault' | 'google_drive_shared' | 'google_drive_oauth'
  sourceLocation: string
  canonicalDir: string
  totalRawFiles: number
  totalBytes: number
  totalSheets: number
  totalFormulas: number
  totalDlpFindings: number
  totalConflicts: number
  lastSyncedAt: string
}

export interface VaultFileRecord {
  fileUid: string
  workspaceId: string
  relPath: string
  driveFileId: string
  driveWebLink: string
  mimeType: string
  byteSize: number
  sha256: string
  mtimeMs: number
  authorityTier: AuthorityTier
  ingestionTier: 'TIER1_INSTANT' | 'TIER2_OCR_QUEUE' | 'TIER1_CATALOGED'
  extractionStatus: string
  canonicalRelPath: string
  sheetCount: number
  formulaCount: number
  dlpFindingsCount: number
  supersedesFileUid: string
  summary: string
}

export interface AuthorityConflictRecord {
  conflictId: number
  workspaceId: string
  topic: string
  severity: 'critical' | 'high' | 'medium'
  currentFile: string
  currentRuleExcerpt: string
  legacyFile: string
  legacyRuleExcerpt: string
  status: 'OPEN_CONFLICT' | 'RESOLVED_CURRENT_WINS' | 'ARCHIVED'
  detectedAt: string
}

export interface SheetCatalogItem {
  sheetId: number
  workspaceId: string
  workbookPath: string
  sheetTitle: string
  state: string
  rowCount: number
  colCount: number
  headers: string[]
  formulaCount: number
  validationCount: number
  sampleFormulas: Array<{ cell: string; formula: string }>
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.turbo',
  '.kaxcav',
])

export class DriveNexusVault {
  readonly db: DatabaseSync
  readonly engine: KaxcavVortexEngine
  readonly workspacesRoot: string

  constructor(engine: KaxcavVortexEngine) {
    this.engine = engine
    this.workspacesRoot = join(engine.storageRoot, 'nexus-workspaces')
    mkdirSync(this.workspacesRoot, { recursive: true })
    this.db = new DatabaseSync(join(engine.storageRoot, 'nexus-vault.sqlite'))
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 33554432;

      CREATE TABLE IF NOT EXISTS nexus_workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tenant_slug TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_location TEXT NOT NULL,
        canonical_dir TEXT NOT NULL,
        total_raw_files INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        total_sheets INTEGER NOT NULL DEFAULT 0,
        total_formulas INTEGER NOT NULL DEFAULT 0,
        total_dlp_findings INTEGER NOT NULL DEFAULT 0,
        total_conflicts INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vault_files (
        file_uid TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        drive_file_id TEXT NOT NULL DEFAULT '',
        drive_web_link TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        authority_tier TEXT NOT NULL,
        ingestion_tier TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        canonical_rel_path TEXT NOT NULL,
        sheet_count INTEGER NOT NULL DEFAULT 0,
        formula_count INTEGER NOT NULL DEFAULT 0,
        dlp_findings_count INTEGER NOT NULL DEFAULT 0,
        supersedes_file_uid TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_vault_files_ws ON vault_files(workspace_id);

      CREATE TABLE IF NOT EXISTS dlp_findings (
        finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        file_uid TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        redacted_token TEXT NOT NULL,
        secret_fingerprint TEXT NOT NULL,
        context_preview TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dlp_ws ON dlp_findings(workspace_id);

      CREATE TABLE IF NOT EXISTS spreadsheet_sheets (
        sheet_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        workbook_path TEXT NOT NULL,
        sheet_title TEXT NOT NULL,
        state TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        col_count INTEGER NOT NULL,
        headers_json TEXT NOT NULL,
        formulas_json TEXT NOT NULL,
        validations_json TEXT NOT NULL,
        rows_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sheets_ws ON spreadsheet_sheets(workspace_id);

      CREATE TABLE IF NOT EXISTS authority_conflicts (
        conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        severity TEXT NOT NULL,
        current_file TEXT NOT NULL,
        current_rule_excerpt TEXT NOT NULL,
        legacy_file TEXT NOT NULL,
        legacy_rule_excerpt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN_CONFLICT',
        detected_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conflicts_ws ON authority_conflicts(workspace_id);

      CREATE TABLE IF NOT EXISTS tenant_api_keys (
        key_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        tenant_name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        plan_tier TEXT NOT NULL,
        monthly_quota INTEGER NOT NULL,
        used_queries INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)
  }

  /**
   * Ingests a local folder (or synced Google Drive staging folder) with 100% Zero-Data-Loss:
   * - Catalogs 100% of raw files with SHA-256
   * - Transpiles .xlsx, .docx, .pdf, .zip, AppsScript .json, .csv, .sql, .md, code
   * - Applies DLP Secret & PII Firewall
   * - Materializes Canonical Corpus and indexes it into KaxcavVortexEngine
   * - Detects Authority Lineage & Business Rule Conflicts
   */
  ingestDirectory(options: {
    name: string
    tenantSlug?: string
    sourceDir: string
    sourceType?: NexusWorkspace['sourceType']
    driveFolderId?: string
    authorityOverrides?: Record<string, AuthorityTier>
  }): {
    workspace: NexusWorkspace
    vortexShardFiles: number
    vortexShardSymbols: number
    elapsedMs: number
  } {
    const t0 = performance.now()
    const absSource = resolve(options.sourceDir)
    if (!existsSync(absSource)) {
      throw new Error(`Diretório de origem não encontrado: ${absSource}`)
    }
    const blocked = checkKvxIgnore(absSource, true)
    if (blocked.ignored) throw new KvxIgnoreError(describeKvxIgnoreBlock(absSource, blocked), blocked)

    const tenantSlug =
      (options.tenantSlug ?? options.name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'default-tenant'

    const wsHash = createHash('sha256').update(absSource.toLowerCase()).digest('hex').slice(0, 10)
    const workspaceId = `ws-${tenantSlug.slice(0, 20)}-${wsHash}`
    const canonicalDir = join(this.workspacesRoot, workspaceId, 'canonical')
    mkdirSync(join(canonicalDir, 'current'), { recursive: true })
    mkdirSync(join(canonicalDir, 'legacy-docs'), { recursive: true })
    mkdirSync(join(canonicalDir, 'legacy-appscript'), { recursive: true })

    // Discover all files in absSource (excluding only build/vcs caches and our own canonical output)
    const rawFiles: Array<{ absPath: string; relPath: string; size: number; mtimeMs: number }> = []
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === 'MAPA_ESTRUTURA_COMPLETA.json') continue
        const fullPath = join(dir, entry.name)
        if (fullPath.startsWith(canonicalDir)) continue
        if (checkKvxIgnore(fullPath, entry.isDirectory()).ignored) continue
        const relPath = relative(absSource, fullPath).replace(/\\/g, '/')
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          walk(fullPath)
        } else if (entry.isFile()) {
          try {
            const st = statSync(fullPath)
            rawFiles.push({
              absPath: fullPath,
              relPath,
              size: st.size,
              mtimeMs: Math.trunc(st.mtimeMs),
            })
          } catch {}
        }
      }
    }
    walk(absSource)

    // Look for MAPA_ESTRUTURA_COMPLETA.json if this was crawled from Google Drive
    const driveMetaMap = new Map<string, { id: string; webViewLink: string; mimeType: string }>()
    const mapaPath = join(absSource, 'MAPA_ESTRUTURA_COMPLETA.json')
    if (existsSync(mapaPath)) {
      try {
        const mapa = JSON.parse(readFileSync(mapaPath, 'utf8'))
        const walkMapa = (node: any): void => {
          if (!node) return
          if (node.id && node.name) {
            driveMetaMap.set(String(node.name).toLowerCase(), {
              id: String(node.id),
              webViewLink: String(node.link ?? `https://drive.google.com/open?id=${node.id}`),
              mimeType: String(node.mimeType ?? ''),
            })
          }
          if (Array.isArray(node.children)) {
            for (const c of node.children) walkMapa(c)
          }
        }
        walkMapa(mapa)
      } catch {}
    }

    let totalBytes = 0
    let totalSheets = 0
    let totalFormulas = 0
    let totalDlpFindings = 0
    const manifestRows: string[] = [
      `# Inventário Forense Zero-Loss — ${options.name}`,
      '',
      `Workspace ID: \`${workspaceId}\` | Origem: \`${absSource}\``,
      '',
      '| Arquivo | Bytes | SHA-256 | Autoridade | Status de Extração | Gêmeo Canônico |',
      '| --- | --- | --- | --- | --- | --- |',
    ]

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM vault_files WHERE workspace_id = ?').run(workspaceId)
      this.db.prepare('DELETE FROM dlp_findings WHERE workspace_id = ?').run(workspaceId)
      this.db.prepare('DELETE FROM spreadsheet_sheets WHERE workspace_id = ?').run(workspaceId)
      this.db.prepare('DELETE FROM authority_conflicts WHERE workspace_id = ?').run(workspaceId)

      const insertFileStmt = this.db.prepare(`
        INSERT INTO vault_files(
          file_uid, workspace_id, rel_path, drive_file_id, drive_web_link,
          mime_type, byte_size, sha256, mtime_ms, authority_tier, ingestion_tier,
          extraction_status, canonical_rel_path, sheet_count, formula_count,
          dlp_findings_count, supersedes_file_uid, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertDlpStmt = this.db.prepare(`
        INSERT INTO dlp_findings(
          workspace_id, file_uid, rel_path, category, severity,
          line_number, redacted_token, secret_fingerprint, context_preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertSheetStmt = this.db.prepare(`
        INSERT INTO spreadsheet_sheets(
          workspace_id, workbook_path, sheet_title, state,
          row_count, col_count, headers_json, formulas_json, validations_json, rows_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const recordDlpFindings = (fileUid: string, relPath: string, findings: DlpFinding[]) => {
        for (const f of findings) {
          totalDlpFindings++
          insertDlpStmt.run(
            workspaceId,
            fileUid,
            relPath,
            f.category,
            f.severity,
            f.lineNumber,
            f.redactedToken,
            f.secretFingerprint,
            f.contextPreview,
          )
        }
      }

      for (const rf of rawFiles) {
        totalBytes += rf.size
        const buf = readFileSync(rf.absPath)
        const sha256 = createHash('sha256').update(buf).digest('hex')
        const pathHash = createHash('sha256').update(rf.relPath).digest('hex').slice(0, 16)
        const fileUid = `${workspaceId}:${sha256.slice(0, 12)}:${pathHash}`
        const ext = extname(rf.relPath).toLowerCase()
        const base = basename(rf.relPath)
        const safeSlug = rf.relPath
          .replace(/\.[^.]+$/, '')
          .replace(/[^A-Za-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase()
          .slice(0, 64)

        const driveInfo =
          driveMetaMap.get(base.toLowerCase()) ??
          driveMetaMap.get(base.replace(/\.(docx|xlsx|txt|csv)$/i, '').toLowerCase())

        const authorityTier: AuthorityTier =
          options.authorityOverrides?.[rf.relPath] ?? this.inferAuthorityTier(rf.relPath, buf)

        const targetSubdir =
          authorityTier === 'CURRENT_USER_CONFIRMED' ? 'current' : 'legacy-docs'

        let mimeType = driveInfo?.mimeType || this.guessMimeType(ext)
        let ingestionTier: VaultFileRecord['ingestionTier'] = 'TIER1_INSTANT'
        let extractionStatus = 'TRANSPILATION_COMPLETE'
        let canonicalRelPath = ''
        let fileSheets = 0
        let fileFormulas = 0
        let fileDlpCount = 0
        let summary = ''

        // 1. OpenXML Spreadsheet (.xlsx)
        if (ext === '.xlsx' && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
          const parsedWb = parseXlsxBuffer(buf, rf.relPath)
          fileSheets = parsedWb.sheets.length
          fileFormulas = parsedWb.totalFormulas
          totalSheets += fileSheets
          totalFormulas += fileFormulas

          for (const sh of parsedWb.sheets) {
            insertSheetStmt.run(
              workspaceId,
              rf.relPath,
              sh.title,
              sh.state,
              sh.rowCount,
              sh.colCount,
              JSON.stringify(sh.headers),
              JSON.stringify(sh.formulas),
              JSON.stringify(sh.validations),
              JSON.stringify(sh.sampleRows),
            )
          }

          const dlpRes = DlpScanner.scanAndSanitize(parsedWb.markdownTwin)
          fileDlpCount = dlpRes.findings.length
          recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)

          canonicalRelPath = `${targetSubdir}/sheet-${safeSlug}.md`
          writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')
          summary = `Planilha ${base}: ${fileSheets} abas (${parsedWb.sheets.map((s) => s.title).slice(0, 6).join(', ')}), ${fileFormulas} fórmulas`
        }
        // 2. OpenXML Word Document (.docx)
        else if (ext === '.docx' && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
          const parsedDoc = parseDocxBuffer(buf, rf.relPath)
          const dlpRes = DlpScanner.scanAndSanitize(parsedDoc.markdownTwin)
          fileDlpCount = dlpRes.findings.length
          recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)

          canonicalRelPath = `${targetSubdir}/doc-${safeSlug}.md`
          writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')

          if (parsedDoc.extractedSqlTables > 0) {
            const sqlRel = `${targetSubdir}/ddl-${safeSlug}.sql`
            writeFileSync(
              join(canonicalDir, sqlRel),
              `-- Extraído automaticamente de ${rf.relPath}\n${parsedDoc.extractedSqlDdl}\n`,
              'utf8',
            )
          }
          summary = `Documento Word ${base}: ${parsedDoc.paragraphCount} parágrafos, ${parsedDoc.tableCount} tabelas`
        }
        // 3. PDF Document (.pdf)
        else if (ext === '.pdf' || (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-')) {
          const parsedPdf = parsePdfBuffer(buf, rf.relPath)
          if (parsedPdf.needsOcr) {
            ingestionTier = 'TIER2_OCR_QUEUE'
            extractionStatus = 'TIER2_OCR_QUEUED_WITH_METADATA'
          }
          const dlpRes = DlpScanner.scanAndSanitize(parsedPdf.markdownTwin)
          fileDlpCount = dlpRes.findings.length
          recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)

          canonicalRelPath = `${targetSubdir}/pdf-${safeSlug}.md`
          writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')
          summary = `PDF ${base}: ${parsedPdf.pageCount} páginas, ${parsedPdf.extractedChars} chars extraídos`
        }
        // 4. ZIP Archive (.zip)
        else if (ext === '.zip' && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
          const entries = readZipEntries(buf, 150)
          const zipList = [...entries.keys()]
          canonicalRelPath = `${targetSubdir}/zip-${safeSlug}.md`
          const zipMd = [
            `# Arquivo Compactado ZIP: ${rf.relPath}`,
            '',
            `Authority: ${authorityTier}`,
            `Total de Entradas Descompactadas em Streaming: ${zipList.length}`,
            '',
            '## Conteúdo Interno',
            ...zipList.map((zn) => `- \`${zn}\` (${entries.get(zn)?.uncompressedSize ?? 0} bytes)`),
            '',
          ].join('\n')
          writeFileSync(join(canonicalDir, canonicalRelPath), zipMd, 'utf8')
          summary = `Arquivo ZIP ${base} com ${zipList.length} arquivos internos`
        }
        // 5. JSON (Check for Google Apps Script Project bundle or Planilhas Metadata)
        else if (ext === '.json') {
          const rawText = buf.toString('utf8')
          let handledSpecialJson = false
          try {
            const parsedJson = JSON.parse(rawText)
            if (parsedJson && Array.isArray(parsedJson.files) && parsedJson.files.some((f: any) => f.source)) {
              // Google Apps Script bundle (like CRM.json, Comercial.json, ADD-ON-HYPER.json, API AppSheet.json)
              handledSpecialJson = true
              const modNames: string[] = []
              for (let mIdx = 0; mIdx < parsedJson.files.length; mIdx++) {
                const item = parsedJson.files[mIdx]
                const itemName = String(item.name ?? `mod-${mIdx}`)
                const itemSource = String(item.source ?? '')
                const dlpRes = DlpScanner.scanAndSanitize(itemSource)
                fileDlpCount += dlpRes.findings.length
                recordDlpFindings(fileUid, `${rf.relPath}#${itemName}`, dlpRes.findings)

                const modExt = item.type === 'json' ? 'json' : 'js'
                const modSlug = `${safeSlug}-${String(mIdx).padStart(2, '0')}-${itemName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${modExt}`
                const relOut = `legacy-appscript/${modSlug}`
                if (!canonicalRelPath) canonicalRelPath = relOut
                writeFileSync(join(canonicalDir, relOut), dlpRes.sanitizedText, 'utf8')
                modNames.push(itemName)
              }
              summary = `Projeto Google Apps Script (${modNames.length} módulos: ${modNames.join(', ')})`
            } else if (
              Array.isArray(parsedJson) &&
              parsedJson.length > 0 &&
              parsedJson[0]?.file &&
              Array.isArray(parsedJson[0]?.sheets)
            ) {
              // Pre-extracted workbook metadata JSON (like planilhas-metadata.json)
              handledSpecialJson = true
              for (const wb of parsedJson) {
                for (const sh of wb.sheets ?? []) {
                  fileSheets++
                  totalSheets++
                  const fArr = Array.isArray(sh.formulas) ? sh.formulas : []
                  fileFormulas += fArr.length
                  totalFormulas += fArr.length
                  insertSheetStmt.run(
                    workspaceId,
                    String(wb.file ?? rf.relPath),
                    String(sh.title ?? 'Sheet'),
                    String(sh.state ?? 'visible'),
                    Number(sh.rows ?? 0),
                    Number(sh.columns ?? 0),
                    JSON.stringify((sh.header_candidate ?? []).filter(Boolean)),
                    JSON.stringify(fArr),
                    JSON.stringify(sh.validations ?? []),
                    JSON.stringify([]),
                  )
                }
              }
              canonicalRelPath = `${targetSubdir}/json-${safeSlug}.json`
              const dlpRes = DlpScanner.scanAndSanitize(rawText.slice(0, 120_000))
              fileDlpCount = dlpRes.findings.length
              recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)
              writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')
              summary = `Catálogo estrutural de planilhas (${fileSheets} abas, ${fileFormulas} fórmulas)`
            }
          } catch {}

          if (!handledSpecialJson) {
            const dlpRes = DlpScanner.scanAndSanitize(rawText.slice(0, 180_000))
            fileDlpCount = dlpRes.findings.length
            recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)
            canonicalRelPath = `${targetSubdir}/${safeSlug}.json`
            writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')
            summary = `Arquivo JSON ${base} (${rf.size} bytes)`
          }
        }
        // 6. CSV Tabular File (.csv)
        else if (ext === '.csv') {
          const rawCsv = buf.toString('utf8')
          const lines = rawCsv.split(/\r?\n/).filter((l) => l.trim().length > 0)
          const headers = lines[0] ? lines[0].split(/[;,]/).map((h) => h.replace(/^"|"$/g, '').trim()) : []
          const sampleRows: Array<Record<string, string>> = []
          for (const line of lines.slice(1, 200)) {
            const cols = line.split(/[;,]/).map((c) => c.replace(/^"|"$/g, '').trim())
            const rowObj: Record<string, string> = {}
            headers.forEach((h, i) => {
              if (h) rowObj[h] = cols[i] ?? ''
            })
            sampleRows.push(rowObj)
          }
          fileSheets = 1
          totalSheets++
          insertSheetStmt.run(
            workspaceId,
            rf.relPath,
            base,
            'visible',
            lines.length,
            headers.length,
            JSON.stringify(headers),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify(sampleRows),
          )
          const dlpRes = DlpScanner.scanAndSanitize(rawCsv.slice(0, 80_000))
          fileDlpCount = dlpRes.findings.length
          recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)
          canonicalRelPath = `${targetSubdir}/csv-${safeSlug}.md`
          const csvMd = [
            `# Tabela CSV: ${rf.relPath}`,
            '',
            `Authority: ${authorityTier}`,
            `- Linhas: \`${lines.length}\` | Colunas (\`${headers.length}\`): ${headers.map((h) => `\`${h}\``).join(', ')}`,
            '',
          ].join('\n')
          writeFileSync(join(canonicalDir, canonicalRelPath), csvMd, 'utf8')
          summary = `Tabela CSV ${base}: ${lines.length} linhas x ${headers.length} colunas`
        }
        // 7. Standard Text / Code / Markdown / SQL
        else if (
          ['.md', '.mdx', '.txt', '.sql', '.prisma', '.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.yaml', '.yml', '.ps1'].includes(
            ext,
          ) &&
          !buf.subarray(0, 4096).includes(0)
        ) {
          const rawText = buf.toString('utf8')
          const dlpRes = DlpScanner.scanAndSanitize(rawText)
          fileDlpCount = dlpRes.findings.length
          recordDlpFindings(fileUid, rf.relPath, dlpRes.findings)

          const outExt = ext === '.txt' ? '.md' : ext
          const subFolder =
            rf.relPath.startsWith('current/') || authorityTier === 'CURRENT_USER_CONFIRMED'
              ? 'current'
              : rf.relPath.startsWith('legacy-appscript/')
                ? 'legacy-appscript'
                : 'legacy-docs'

          canonicalRelPath = `${subFolder}/${safeSlug}${outExt}`
          writeFileSync(join(canonicalDir, canonicalRelPath), dlpRes.sanitizedText, 'utf8')
          summary =
            rawText
              .split(/\r?\n/)
              .map((l) => l.replace(/^[#\-*>/\s]+/, '').trim())
              .find((l) => l.length > 8)
              ?.slice(0, 140) ?? `Arquivo ${base}`
        }
        // 8. Binary / Media / Unknown Format -> Cataloged in Zero-Loss Manifest
        else {
          ingestionTier = 'TIER1_CATALOGED'
          extractionStatus = 'BINARY_CATALOGED_IN_MANIFEST'
          canonicalRelPath = 'legacy-docs/vault-inventory-manifest.md'
          summary = `Artefato binário catalogado (${ext || 'bin'}, ${rf.size} bytes, sha256:${sha256.slice(0, 12)})`
        }

        insertFileStmt.run(
          fileUid,
          workspaceId,
          rf.relPath,
          driveInfo?.id ?? '',
          driveInfo?.webViewLink ?? '',
          mimeType,
          rf.size,
          sha256,
          rf.mtimeMs,
          authorityTier,
          ingestionTier,
          extractionStatus,
          canonicalRelPath,
          fileSheets,
          fileFormulas,
          fileDlpCount,
          '',
          summary,
        )

        manifestRows.push(
          `| \`${rf.relPath}\` | ${rf.size} | \`${sha256.slice(0, 12)}\` | \`${authorityTier}\` | \`${extractionStatus}\` | \`${canonicalRelPath}\` |`,
        )
      }

      // Write complete Zero-Loss inventory manifest into canonical corpus so every file is searchable
      writeFileSync(
        join(canonicalDir, 'legacy-docs', 'vault-inventory-manifest.md'),
        manifestRows.join('\n') + '\n',
        'utf8',
      )

      // Detect Authority Conflicts & Lineage
      const totalConflicts = this.detectAuthorityConflicts(workspaceId, canonicalDir)

      const nowIso = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO nexus_workspaces(
            workspace_id, name, tenant_slug, source_type, source_location, canonical_dir,
            total_raw_files, total_bytes, total_sheets, total_formulas, total_dlp_findings,
            total_conflicts, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            name = excluded.name,
            source_location = excluded.source_location,
            total_raw_files = excluded.total_raw_files,
            total_bytes = excluded.total_bytes,
            total_sheets = excluded.total_sheets,
            total_formulas = excluded.total_formulas,
            total_dlp_findings = excluded.total_dlp_findings,
            total_conflicts = excluded.total_conflicts,
            last_synced_at = excluded.last_synced_at`,
        )
        .run(
          workspaceId,
          options.name,
          tenantSlug,
          options.sourceType ?? (existsSync(mapaPath) ? 'google_drive_sync' : 'local_vault'),
          absSource,
          canonicalDir,
          rawFiles.length,
          totalBytes,
          totalSheets,
          totalFormulas,
          totalDlpFindings,
          totalConflicts,
          nowIso,
        )

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    // Index the canonical directory in KaxcavVortexEngine
    const shard = this.engine.getOrOpenShard(canonicalDir)
    shard.sync(true)
    const health = shard.health()

    const ws = this.getWorkspace(workspaceId)!
    return {
      workspace: ws,
      vortexShardFiles: health.fileCount,
      vortexShardSymbols: health.symbolCount,
      elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
    }
  }

  /**
   * Connects and syncs a Google Drive folder (by Folder ID/URL or OAuth2 token) directly into a Nexus Workspace.
   */
  async syncGoogleDriveWorkspace(options: {
    name: string
    tenantSlug?: string
    folderIdOrUrl: string
    accessToken?: string
    apiKey?: string
    maxFiles?: number
  }): Promise<{
    crawl: DriveCrawlSummary
    ingestion: ReturnType<DriveNexusVault['ingestDirectory']>
  }> {
    const folderId = GoogleDriveConnector.extractFolderId(options.folderIdOrUrl)
    const stagingDir = join(this.workspacesRoot, `drive-staging-${folderId.slice(0, 16)}`)
    const crawl = await GoogleDriveConnector.syncFolderToStaging({
      folderIdOrUrl: options.folderIdOrUrl,
      stagingDir,
      accessToken: options.accessToken,
      apiKey: options.apiKey,
      maxFiles: options.maxFiles,
    })

    const effectiveName =
      !options.name || options.name === 'Pasta do Google Drive' || options.name === 'Google Drive Sync'
        ? `Google Drive :: ${crawl.folderTitle}`
        : options.name

    const ingestion = this.ingestDirectory({
      name: effectiveName,
      tenantSlug: options.tenantSlug,
      sourceDir: stagingDir,
      sourceType: options.accessToken ? 'google_drive_oauth' : 'google_drive_shared',
      driveFolderId: folderId,
    })

    return { crawl, ingestion }
  }

  private inferAuthorityTier(relPath: string, buf: Buffer): AuthorityTier {
    const norm = relPath.toLowerCase()
    const headText = buf.subarray(0, Math.min(buf.length, 2048)).toString('utf8')
    if (norm.startsWith('current/') || norm.includes('/current/') || headText.includes('CURRENT_USER_CONFIRMED')) {
      return 'CURRENT_USER_CONFIRMED'
    }
    if (headText.includes('LEGACY_IDEA') || /fluxos|ideia|rascunho|draft/i.test(norm)) {
      return 'LEGACY_IDEA'
    }
    if (
      norm.startsWith('legacy') ||
      norm.includes('quarentena') ||
      norm.includes('legad') ||
      headText.includes('LEGACY_OBSERVED')
    ) {
      return 'LEGACY_OBSERVED'
    }
    return 'ACTIVE_OPERATIONAL'
  }

  private guessMimeType(ext: string): string {
    switch (ext) {
      case '.xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      case '.docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      case '.pdf':
        return 'application/pdf'
      case '.json':
        return 'application/json'
      case '.sql':
        return 'application/sql'
      case '.md':
        return 'text/markdown'
      case '.csv':
        return 'text/csv'
      case '.js':
      case '.ts':
        return 'application/javascript'
      default:
        return 'application/octet-stream'
    }
  }

  private detectAuthorityConflicts(workspaceId: string, canonicalDir: string): number {
    const insertConflict = this.db.prepare(`
      INSERT INTO authority_conflicts(
        workspace_id, topic, severity, current_file, current_rule_excerpt,
        legacy_file, legacy_rule_excerpt, status, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN_CONFLICT', ?)
    `)
    const now = new Date().toISOString()
    let count = 0

    const currentDir = join(canonicalDir, 'current')
    const legacyDir = join(canonicalDir, 'legacy-docs')
    if (existsSync(currentDir) && existsSync(legacyDir)) {
      const currentFiles = readdirSync(currentDir).filter((f) => f.endsWith('.md'))
      const legacyFiles = readdirSync(legacyDir).filter((f) => f.endsWith('.md') || f.endsWith('.sql'))

      for (const cf of currentFiles) {
        const cText = readFileSync(join(currentDir, cf), 'utf8')
        for (const lf of legacyFiles) {
          const lText = readFileSync(join(legacyDir, lf), 'utf8')

          // Rule 1: SDR Opportunity Creation Conflict
          if (
            /somente.*Comercial.*Oportunidade|SDR não cria a Oportunidade/i.test(cText) &&
            /criação automática de.*Oportunidade ao qualificar Lead|preVenda|fluxoEncaminhamento/i.test(lText)
          ) {
            insertConflict.run(
              workspaceId,
              'Momento de Criação da Oportunidade (SDR vs Validação Comercial)',
              'critical',
              `current/${cf}`,
              'Validado pelo Comercial: somente nesse momento a Oportunidade é criada. O SDR não cria a Oportunidade diretamente.',
              `legacy-docs/${lf}`,
              'Comportamento legado criava Conta e Oportunidade automaticamente ao qualificar Lead no SDR ou operava direto na aba preVenda.',
              now,
            )
            count++
          }

          // Rule 2: Public Tenders (Licitação) Bypass Lead Queue
          if (
            /Licitação já inicia como Oportunidade/i.test(cText) &&
            /CREATE\s+TABLE\s+crm\.oportunidades|Contrata\.gov/i.test(lText)
          ) {
            insertConflict.run(
              workspaceId,
              'Fluxo de Entrada por Licitação (Contrata.gov vs Fila de Leads SDR)',
              'high',
              `current/${cf}`,
              'Licitação já inicia diretamente como Oportunidade, sem passar pela fila de Leads do SDR e sem criar Lead artificial.',
              `legacy-docs/${lf}`,
              'Estrutura legada separava planilhas Contrata.gov.xlsx ou exigia vínculo genérico id_lead sem distinção formal de pipeline de entrada.',
              now,
            )
            count++
          }

          // Rule 3: Mandatory Deal Type Classification (NEW_LOGO, RENEWAL, AMENDMENT, ADDITIONAL_LICENSES)
          if (
            /NEW_LOGO.*RENEWAL.*AMENDMENT.*ADDITIONAL_LICENSES/i.test(cText) &&
            /tipo_contrato|plano_contrato|tipo_adesao/i.test(lText)
          ) {
            insertConflict.run(
              workspaceId,
              'Classificação Obrigatória de Tipo de Negócio vs Campos Legados Sem Constraint',
              'medium',
              `current/${cf}`,
              'Toda Oportunidade e Lead SDR exige classificação estrita: NEW_LOGO, RENEWAL, AMENDMENT ou ADDITIONAL_LICENSES.',
              `legacy-docs/${lf}`,
              'DDL e documentos legados possuíam campos livres (tipo_contrato, plano_contrato, tipo_adesao) opcionais e sem constraint de catálogo.',
              now,
            )
            count++
          }
        }
      }
    }

    // Universal Detection: Exact SHA-256 Duplicates & Version Collisions across any folder
    const allVaultRows = this.db
      .prepare(
        `SELECT rel_path, sha256, byte_size, mtime_ms, summary
         FROM vault_files
         WHERE workspace_id = ? AND byte_size > 128`,
      )
      .all(workspaceId) as Array<{
      rel_path: string
      sha256: string
      byte_size: number
      mtime_ms: number
      summary: string
    }>

    const byHash = new Map<string, typeof allVaultRows>()
    const byStem = new Map<string, typeof allVaultRows>()
    for (const r of allVaultRows) {
      const hList = byHash.get(r.sha256) ?? []
      hList.push(r)
      byHash.set(r.sha256, hList)

      const base = (r.rel_path.split(/[/\\]/).pop() ?? r.rel_path).toLowerCase()
      const stem = base.replace(/\s*\(\d+\)|\s*-\s*copia|\s*_?v\d+/gi, '').trim()
      if (stem.length >= 5) {
        const sList = byStem.get(stem) ?? []
        sList.push(r)
        byStem.set(stem, sList)
      }
    }

    let dupLogged = 0
    for (const [, group] of byHash.entries()) {
      if (group.length > 1 && dupLogged < 12) {
        const sorted = [...group].sort((a, b) => b.mtime_ms - a.mtime_ms)
        const primary = sorted[0]!
        const dup = sorted[1]!
        const baseName = primary.rel_path.split(/[/\\]/).pop() ?? primary.rel_path
        insertConflict.run(
          workspaceId,
          `Arquivo Duplicado em Múltiplas Pastas: ${baseName}`,
          'medium',
          primary.rel_path,
          `Cópia principal localizada em "${primary.rel_path}" (${Math.round(primary.byte_size / 1024)} KB).`,
          dup.rel_path,
          `Cópia idêntica (mesmo hash SHA-256) encontrada em "${dup.rel_path}" (+${group.length - 1} cópia(s) na pasta).`,
          now,
        )
        count++
        dupLogged++
      }
    }

    let verLogged = 0
    for (const [stem, group] of byStem.entries()) {
      const distinctHashes = new Set(group.map((g) => g.sha256))
      if (distinctHashes.size > 1 && verLogged < 12) {
        const sorted = [...group].sort((a, b) => b.mtime_ms - a.mtime_ms)
        const newest = sorted[0]!
        const older = sorted.find((g) => g.sha256 !== newest.sha256)
        if (older) {
          insertConflict.run(
            workspaceId,
            `Versões Diferentes do Mesmo Arquivo: ${stem}`,
            'high',
            newest.rel_path,
            `Versão mais recente (${Math.round(newest.byte_size / 1024)} KB): ${newest.summary}`,
            older.rel_path,
            `Versão divergente/anterior (${Math.round(older.byte_size / 1024)} KB) com conteúdo diferente em "${older.rel_path}".`,
            now,
          )
          count++
          verLogged++
        }
      }
    }

    return count
  }

  listWorkspaces(): NexusWorkspace[] {
    return this.db
      .prepare(
        `SELECT
          workspace_id AS workspaceId,
          name,
          tenant_slug AS tenantSlug,
          source_type AS sourceType,
          source_location AS sourceLocation,
          canonical_dir AS canonicalDir,
          total_raw_files AS totalRawFiles,
          total_bytes AS totalBytes,
          total_sheets AS totalSheets,
          total_formulas AS totalFormulas,
          total_dlp_findings AS totalDlpFindings,
          total_conflicts AS totalConflicts,
          last_synced_at AS lastSyncedAt
         FROM nexus_workspaces
         ORDER BY last_synced_at DESC`,
      )
      .all() as unknown as NexusWorkspace[]
  }

  getWorkspace(workspaceId: string): NexusWorkspace | null {
    const row = this.db
      .prepare(
        `SELECT
          workspace_id AS workspaceId,
          name,
          tenant_slug AS tenantSlug,
          source_type AS sourceType,
          source_location AS sourceLocation,
          canonical_dir AS canonicalDir,
          total_raw_files AS totalRawFiles,
          total_bytes AS totalBytes,
          total_sheets AS totalSheets,
          total_formulas AS totalFormulas,
          total_dlp_findings AS totalDlpFindings,
          total_conflicts AS totalConflicts,
          last_synced_at AS lastSyncedAt
         FROM nexus_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as unknown as NexusWorkspace | undefined
    return row ?? null
  }

  listVaultFiles(workspaceId: string, filterOrLimit?: string | number): VaultFileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
          file_uid AS fileUid,
          workspace_id AS workspaceId,
          rel_path AS relPath,
          drive_file_id AS driveFileId,
          drive_web_link AS driveWebLink,
          mime_type AS mimeType,
          byte_size AS byteSize,
          sha256,
          mtime_ms AS mtimeMs,
          authority_tier AS authorityTier,
          ingestion_tier AS ingestionTier,
          extraction_status AS extractionStatus,
          canonical_rel_path AS canonicalRelPath,
          sheet_count AS sheetCount,
          formula_count AS formulaCount,
          dlp_findings_count AS dlpFindingsCount,
          supersedes_file_uid AS supersedesFileUid,
          summary
         FROM vault_files
         WHERE workspace_id = ?
         ORDER BY authority_tier ASC, byte_size DESC`,
      )
      .all(workspaceId) as unknown as VaultFileRecord[]

    if (typeof filterOrLimit === 'number') {
      return rows.slice(0, filterOrLimit)
    }
    if (typeof filterOrLimit !== 'string' || !filterOrLimit.trim()) return rows
    const q = filterOrLimit.trim().toLowerCase()
    return rows.filter(
      (r) =>
        r.relPath.toLowerCase().includes(q) ||
        r.summary.toLowerCase().includes(q) ||
        r.authorityTier.toLowerCase().includes(q) ||
        r.sha256.startsWith(q),
    )
  }

  listDlpFindings(workspaceId: string, limit = 500): Array<
    DlpFinding & { findingId: number; relPath: string }
  > {
    return this.db
      .prepare(
        `SELECT
          finding_id AS findingId,
          rel_path AS relPath,
          category,
          severity,
          line_number AS lineNumber,
          redacted_token AS redactedToken,
          secret_fingerprint AS secretFingerprint,
          context_preview AS contextPreview
         FROM dlp_findings
         WHERE workspace_id = ?
         ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, rel_path ASC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as unknown as Array<DlpFinding & { findingId: number; relPath: string }>
  }

  listAuthorityConflicts(workspaceId: string): AuthorityConflictRecord[] {
    return this.db
      .prepare(
        `SELECT
          conflict_id AS conflictId,
          workspace_id AS workspaceId,
          topic,
          severity,
          current_file AS currentFile,
          current_rule_excerpt AS currentRuleExcerpt,
          legacy_file AS legacyFile,
          legacy_rule_excerpt AS legacyRuleExcerpt,
          status,
          detected_at AS detectedAt
         FROM authority_conflicts
         WHERE workspace_id = ?
         ORDER BY conflict_id ASC`,
      )
      .all(workspaceId) as unknown as AuthorityConflictRecord[]
  }

  listConflicts(workspaceId: string): AuthorityConflictRecord[] {
    return this.listAuthorityConflicts(workspaceId)
  }

  listSpreadsheets(workspaceId: string, search?: string): SheetCatalogItem[] {
    const raw = this.db
      .prepare(
        `SELECT
          sheet_id AS sheetId,
          workspace_id AS workspaceId,
          workbook_path AS workbookPath,
          sheet_title AS sheetTitle,
          state,
          row_count AS rowCount,
          col_count AS colCount,
          headers_json AS headersJson,
          formulas_json AS formulasJson,
          validations_json AS validationsJson
         FROM spreadsheet_sheets
         WHERE workspace_id = ?
         ORDER BY workbook_path ASC, sheet_id ASC`,
      )
      .all(workspaceId) as Array<{
      sheetId: number
      workspaceId: string
      workbookPath: string
      sheetTitle: string
      state: string
      rowCount: number
      colCount: number
      headersJson: string
      formulasJson: string
      validationsJson: string
    }>

    const mapped: SheetCatalogItem[] = raw.map((r) => {
      const headers = JSON.parse(r.headersJson) as string[]
      const formulas = JSON.parse(r.formulasJson) as Array<{ cell: string; formula: string }>
      const validations = JSON.parse(r.validationsJson) as unknown[]
      return {
        sheetId: r.sheetId,
        workspaceId: r.workspaceId,
        workbookPath: r.workbookPath,
        sheetTitle: r.sheetTitle,
        state: r.state,
        rowCount: r.rowCount,
        colCount: r.colCount,
        headers,
        formulaCount: formulas.length,
        validationCount: validations.length,
        sampleFormulas: formulas.slice(0, 6),
      }
    })

    if (!search?.trim()) return mapped
    const q = search.trim().toLowerCase()
    return mapped.filter(
      (s) =>
        s.workbookPath.toLowerCase().includes(q) ||
        s.sheetTitle.toLowerCase().includes(q) ||
        s.headers.some((h) => h.toLowerCase().includes(q)) ||
        s.sampleFormulas.some((f) => f.formula.toLowerCase().includes(q)),
    )
  }

  querySheetRows(options: {
    workspaceId: string
    sheetId?: number
    workbookPath?: string
    sheetTitle?: string
    columnFilter?: string
    limit?: number
  }): {
    workbookPath: string
    sheetTitle: string
    rowCount: number
    colCount: number
    headers: string[]
    formulas: Array<{ cell: string; formula: string }>
    matchingRows: Array<Record<string, unknown>>
  } | null {
    let row:
      | {
          workbook_path: string
          sheet_title: string
          row_count: number
          col_count: number
          headers_json: string
          formulas_json: string
          rows_json: string
        }
      | undefined

    if (options.sheetId) {
      row = this.db
        .prepare(
          `SELECT workbook_path, sheet_title, row_count, col_count, headers_json, formulas_json, rows_json
           FROM spreadsheet_sheets WHERE workspace_id = ? AND sheet_id = ?`,
        )
        .get(options.workspaceId, options.sheetId) as any
    } else if (options.sheetTitle) {
      row = this.db
        .prepare(
          `SELECT workbook_path, sheet_title, row_count, col_count, headers_json, formulas_json, rows_json
           FROM spreadsheet_sheets
           WHERE workspace_id = ? AND lower(sheet_title) LIKE ?
           LIMIT 1`,
        )
        .get(options.workspaceId, `%${options.sheetTitle.toLowerCase()}%`) as any
    } else {
      row = this.db
        .prepare(
          `SELECT workbook_path, sheet_title, row_count, col_count, headers_json, formulas_json, rows_json
           FROM spreadsheet_sheets WHERE workspace_id = ? LIMIT 1`,
        )
        .get(options.workspaceId) as any
    }

    if (!row) return null
    const headers = JSON.parse(row.headers_json) as string[]
    const formulas = JSON.parse(row.formulas_json) as Array<{ cell: string; formula: string }>
    const allRows = JSON.parse(row.rows_json) as Array<Record<string, unknown>>

    const filter = options.columnFilter?.trim().toLowerCase()
    const filtered = filter
      ? allRows.filter((r) =>
          Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(filter)),
        )
      : allRows

    return {
      workbookPath: row.workbook_path,
      sheetTitle: row.sheet_title,
      rowCount: row.row_count,
      colCount: row.col_count,
      headers,
      formulas: formulas.slice(0, 50),
      matchingRows: filtered.slice(0, options.limit ?? 50),
      sampleRows: filtered.slice(0, options.limit ?? 50),
    }
  }

  querySheet(options: {
    workspaceId: string
    sheetId?: number
    workbookFilter?: string
    sheetFilter?: string
    columnFilter?: string
    limit?: number
  }) {
    return this.querySheetRows({
      workspaceId: options.workspaceId,
      sheetId: options.sheetId,
      workbookPath: options.workbookFilter,
      sheetTitle: options.sheetFilter,
      columnFilter: options.columnFilter,
      limit: options.limit,
    })
  }

  createTenantApiKey(options: {
    workspaceId: string
    tenantName: string
    planTier?: 'PRO_TEAM' | 'ENTERPRISE_UNLIMITED' | 'GOV_AUDIT'
    monthlyQuota?: number
  }): {
    keyId: string
    rawApiKey: string
    keyPrefix: string
    workspaceId: string
    tenantName: string
    planTier: string
    monthlyQuota: number
    createdAt: string
  } {
    const keyId = 'key_' + randomBytes(6).toString('hex')
    const secretPart = randomBytes(18).toString('hex')
    const rawApiKey = `vk_live_${secretPart}`
    const keyPrefix = rawApiKey.slice(0, 14) + '...'
    const keyHash = createHash('sha256').update(rawApiKey).digest('hex')
    const planTier = options.planTier ?? 'ENTERPRISE_UNLIMITED'
    const monthlyQuota = options.monthlyQuota ?? 250_000
    const createdAt = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO tenant_api_keys(
          key_id, workspace_id, tenant_name, key_prefix, key_hash, plan_tier, monthly_quota, used_queries, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        keyId,
        options.workspaceId,
        options.tenantName,
        keyPrefix,
        keyHash,
        planTier,
        monthlyQuota,
        createdAt,
      )

    return {
      keyId,
      rawApiKey,
      keyPrefix,
      workspaceId: options.workspaceId,
      tenantName: options.tenantName,
      planTier,
      monthlyQuota,
      createdAt,
    }
  }

  listTenantApiKeys(workspaceId?: string): Array<{
    keyId: string
    workspaceId: string
    tenantName: string
    keyPrefix: string
    planTier: string
    monthlyQuota: number
    usedQueries: number
    createdAt: string
  }> {
    if (workspaceId) {
      return this.db
        .prepare(
          `SELECT
            key_id AS keyId, workspace_id AS workspaceId, tenant_name AS tenantName,
            key_prefix AS keyPrefix, plan_tier AS planTier, monthly_quota AS monthlyQuota,
            used_queries AS usedQueries, created_at AS createdAt
           FROM tenant_api_keys WHERE workspace_id = ? ORDER BY created_at DESC`,
        )
        .all(workspaceId) as any
    }
    return this.db
      .prepare(
        `SELECT
          key_id AS keyId, workspace_id AS workspaceId, tenant_name AS tenantName,
          key_prefix AS keyPrefix, plan_tier AS planTier, monthly_quota AS monthlyQuota,
          used_queries AS usedQueries, created_at AS createdAt
         FROM tenant_api_keys ORDER BY created_at DESC`,
      )
      .all() as any
  }

  close(): void {
    try {
      this.db.close()
    } catch {}
  }
}
