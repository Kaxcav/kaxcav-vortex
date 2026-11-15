//! `DriveNexusVault`: OpenXML `.xlsx`/`.docx`, `.csv`, `.sql`, `.md`, `.json` ingestion engine
//! with 15-category DLP redaction, SHA-256 exact duplicate & version stem collision detector,
//! custom authority invariants, `query_sheet`, `audit_dlp`, and Google Drive v2beta/v3 connector.
//!
//! Traceability: `@REQ-VORTEX-005`.

use crate::dlp::DlpScanner;
use crate::types::{
    CustomInvariant, DlpCategory, DlpFinding, NexusAuditReport, NexusAuthorityConflict,
    NexusIngestResult, NexusSheetQueryResult, NexusWorkspace, VortexError, VortexResult,
};
use chrono::Utc;
use ignore::WalkBuilder;
use parking_lot::Mutex;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use rayon::prelude::*;
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{params, Connection};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use zip::ZipArchive;

#[derive(Debug, Clone)]
struct ExtractedSheet {
    sheet_name: String,
    hidden: bool,
    headers: Vec<String>,
    rows: Vec<BTreeMap<String, String>>,
    formulas: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct VaultFileRow {
    rel_path: String,
    ext: String,
    byte_size: u64,
    sha256: String,
    tier: String,
    twin_rel_path: Option<String>,
}

/// SQLite-backed corporate document & spreadsheet vault with DLP redaction and authority radar.
pub struct DriveNexusVault {
    vault_root: PathBuf,
    db_path: PathBuf,
    conn: Mutex<Connection>,
    scanner: DlpScanner,
}

impl std::fmt::Debug for DriveNexusVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DriveNexusVault")
            .field("vault_root", &self.vault_root)
            .field("db_path", &self.db_path)
            .finish()
    }
}

impl DriveNexusVault {
    /// Opens or creates `nexus-vault.sqlite` inside `vault_root`.
    pub fn open(vault_root: &Path) -> VortexResult<Self> {
        fs::create_dir_all(vault_root)?;
        let db_path = vault_root.join("nexus-vault.sqlite");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 15000;",
        )?;

        let vault = Self {
            vault_root: vault_root.to_path_buf(),
            db_path,
            conn: Mutex::new(conn),
            scanner: DlpScanner::new(),
        };
        vault.init_schema()?;
        Ok(vault)
    }

    /// Filesystem path to `nexus-vault.sqlite`.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn init_schema(&self) -> VortexResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspaces (
                workspace_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL,
                drive_folder_id TEXT,
                created_at_ms INTEGER NOT NULL,
                last_ingest_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vault_files (
                id INTEGER PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                ext TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                tier TEXT NOT NULL,
                twin_rel_path TEXT,
                ingested_at_ms INTEGER NOT NULL,
                UNIQUE(workspace_id, rel_path)
            );

            CREATE TABLE IF NOT EXISTS sheets (
                id INTEGER PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                workbook_path TEXT NOT NULL,
                sheet_name TEXT NOT NULL,
                hidden INTEGER NOT NULL,
                headers_json TEXT NOT NULL,
                rows_json TEXT NOT NULL,
                formulas_json TEXT NOT NULL,
                total_rows INTEGER NOT NULL,
                UNIQUE(workspace_id, workbook_path, sheet_name)
            );

            CREATE TABLE IF NOT EXISTS dlp_findings (
                id INTEGER PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                category TEXT NOT NULL,
                severity TEXT NOT NULL,
                file_path TEXT NOT NULL,
                line INTEGER NOT NULL,
                col INTEGER NOT NULL,
                redacted_preview TEXT NOT NULL,
                value_sha256 TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS authority_conflicts (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                severity TEXT NOT NULL,
                primary_path TEXT NOT NULL,
                conflicting_path TEXT NOT NULL,
                description TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS custom_invariants (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                canonical_pattern TEXT NOT NULL,
                forbidden_pattern TEXT NOT NULL,
                severity TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    /// Registers a custom authority invariant checked during `ingest_directory`.
    pub fn register_invariant(&self, inv: &CustomInvariant) -> VortexResult<()> {
        let ws_id = validate_workspace_id(&inv.workspace_id)?;
        Regex::new(&inv.canonical_pattern)?;
        Regex::new(&inv.forbidden_pattern)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO custom_invariants
             (id, workspace_id, title, canonical_pattern, forbidden_pattern, severity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                inv.id,
                ws_id,
                inv.title,
                inv.canonical_pattern,
                inv.forbidden_pattern,
                inv.severity
            ],
        )?;
        Ok(())
    }

    /// Lists all registered `NexusWorkspace`s in deterministic order.
    pub fn list_workspaces(&self) -> VortexResult<Vec<NexusWorkspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT w.workspace_id, w.name, w.root_path, w.drive_folder_id, w.created_at_ms, w.last_ingest_ms,
                    (SELECT COUNT(*) FROM vault_files vf WHERE vf.workspace_id = w.workspace_id)
             FROM workspaces w
             ORDER BY w.workspace_id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(NexusWorkspace {
                workspace_id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                drive_folder_id: r.get(3)?,
                created_at_ms: r.get(4)?,
                last_ingest_ms: r.get(5)?,
                files_total: r.get::<_, i64>(6)?.max(0) as usize,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Ingests all documents and spreadsheets under `dir_path` into `workspace_id` with DLP redaction.
    pub fn ingest_directory(
        &self,
        workspace_id: &str,
        dir_path: &Path,
        drive_folder_id: Option<&str>,
    ) -> VortexResult<NexusIngestResult> {
        let ws_id = validate_workspace_id(workspace_id)?;

        if !dir_path.is_dir() {
            return Err(VortexError::InvalidInput(format!(
                "Nexus source directory '{}' does not exist",
                dir_path.display()
            )));
        }
        if fs::symlink_metadata(dir_path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(VortexError::InvalidInput(format!(
                "Nexus source directory '{}' must not be a symbolic link",
                dir_path.display()
            )));
        }

        let canonical_dir = dir_path.canonicalize()?;
        fs::create_dir_all(&self.vault_root)?;
        let canon_vault = self.vault_root.canonicalize()?;
        let twins_root = canon_vault.join("twins");
        fs::create_dir_all(&twins_root)?;
        let canon_twins_root = twins_root.canonicalize()?;
        let twins_dir = resolve_contained_dir(&canon_twins_root, ws_id)?;

        let scanner = DlpScanner::from_repo(&canonical_dir).unwrap_or_else(|_| self.scanner.clone());
        let now_ms = Utc::now().timestamp_millis();

        let mut walker = WalkBuilder::new(&canonical_dir);
        walker.hidden(true).git_ignore(false).follow_links(false);

        let mut candidate_paths: Vec<(String, PathBuf, String)> = Vec::new();
        for entry_res in walker.build() {
            let Ok(entry) = entry_res else {
                continue;
            };
            if entry.path_is_symlink() {
                continue;
            }
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let abs = entry.path().to_path_buf();
            let Ok(canon_abs) = abs.canonicalize() else {
                continue;
            };
            if !canon_abs.starts_with(&canonical_dir) {
                continue;
            }
            let Ok(stripped) = canon_abs.strip_prefix(&canonical_dir) else {
                continue;
            };
            let raw_rel = stripped.to_string_lossy().replace('\\', "/");
            let Ok(rel) = validate_clean_relative_subpath(&raw_rel) else {
                continue;
            };
            if rel.starts_with(".git/")
                || rel.contains("/node_modules/")
                || rel.contains("/target/")
            {
                continue;
            }
            let ext = canon_abs
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            candidate_paths.push((rel, canon_abs, ext));
        }

        candidate_paths.sort_by(|a, b| a.0.cmp(&b.0));
        let files_scanned = candidate_paths.len();

        let mut files_ingested = 0usize;
        let mut sheets_indexed = 0usize;
        let mut twins_written = 0usize;
        let mut all_dlp_findings: Vec<DlpFinding> = Vec::new();
        let mut twin_contents: HashMap<String, String> = HashMap::new();

        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;

            let ws_name = canonical_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(workspace_id)
                .to_string();

            tx.execute(
                "INSERT INTO workspaces (workspace_id, name, root_path, drive_folder_id, created_at_ms, last_ingest_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                    root_path = excluded.root_path,
                    drive_folder_id = COALESCE(excluded.drive_folder_id, workspaces.drive_folder_id),
                    last_ingest_ms = excluded.last_ingest_ms",
                params![
                    workspace_id,
                    ws_name,
                    canonical_dir.to_string_lossy().to_string(),
                    drive_folder_id,
                    now_ms
                ],
            )?;

            tx.execute(
                "DELETE FROM vault_files WHERE workspace_id = ?1",
                params![workspace_id],
            )?;
            tx.execute(
                "DELETE FROM sheets WHERE workspace_id = ?1",
                params![workspace_id],
            )?;
            tx.execute(
                "DELETE FROM dlp_findings WHERE workspace_id = ?1",
                params![workspace_id],
            )?;
            tx.execute(
                "DELETE FROM authority_conflicts WHERE workspace_id = ?1",
                params![workspace_id],
            )?;

            for (rel_path, abs_path, ext) in &candidate_paths {
                let Ok(bytes) = fs::read(abs_path) else {
                    continue;
                };
                let byte_size = bytes.len() as u64;
                let mut sha = Sha256::new();
                sha.update(&bytes);
                let sha256_hex = hex::encode(sha.finalize());
                let tier = classify_authority_tier(rel_path);

                let mut raw_twin_md: Option<String> = None;
                let mut workbook_sheets: Vec<ExtractedSheet> = Vec::new();

                match ext.as_str() {
                    "xlsx" => {
                        if let Ok(parsed_sheets) = parse_xlsx_bytes(&bytes) {
                            let mut md = format!("# Workbook: {rel_path}\n\n");
                            for mut sh in parsed_sheets {
                                let mut sanitized_headers = Vec::with_capacity(sh.headers.len());
                                for h in &sh.headers {
                                    let (clean_h, f) = scanner.scan_and_redact(rel_path, h);
                                    all_dlp_findings.extend(f);
                                    sanitized_headers.push(clean_h);
                                }
                                sh.headers = sanitized_headers;

                                for row in &mut sh.rows {
                                    let keys: Vec<String> = row.keys().cloned().collect();
                                    for k in keys {
                                        if let Some(val) = row.get(&k).cloned() {
                                            let (clean_v, f) =
                                                scanner.scan_and_redact(rel_path, &val);
                                            all_dlp_findings.extend(f);
                                            row.insert(k, clean_v);
                                        }
                                    }
                                }

                                let f_keys: Vec<String> = sh.formulas.keys().cloned().collect();
                                for fk in f_keys {
                                    if let Some(fval) = sh.formulas.get(&fk).cloned() {
                                        let (clean_f, f) =
                                            scanner.scan_and_redact(rel_path, &fval);
                                        all_dlp_findings.extend(f);
                                        sh.formulas.insert(fk, clean_f);
                                    }
                                }

                                md.push_str(&render_sheet_markdown(&sh));
                                workbook_sheets.push(sh);
                            }
                            raw_twin_md = Some(md);
                        }
                    }
                    "docx" => {
                        if let Ok(doc_text) = parse_docx_bytes(&bytes) {
                            let (clean_doc, f) = scanner.scan_and_redact(rel_path, &doc_text);
                            all_dlp_findings.extend(f);
                            raw_twin_md = Some(format!("# Document: {rel_path}\n\n{clean_doc}\n"));
                        }
                    }
                    "csv" => {
                        if let Ok(text) = String::from_utf8(bytes.clone()) {
                            let (clean_csv, f) = scanner.scan_and_redact(rel_path, &text);
                            all_dlp_findings.extend(f);
                            if let Ok(sh) = parse_csv_text(&clean_csv) {
                                let md = render_sheet_markdown(&sh);
                                workbook_sheets.push(sh);
                                raw_twin_md = Some(format!("# CSV: {rel_path}\n\n{md}"));
                            }
                        }
                    }
                    "sql" | "md" | "json" | "yaml" | "yml" | "txt" | "toml" => {
                        if let Ok(text) = String::from_utf8(bytes.clone()) {
                            let (clean_txt, f) = scanner.scan_and_redact(rel_path, &text);
                            all_dlp_findings.extend(f);
                            raw_twin_md = Some(clean_txt);
                        }
                    }
                    _ => {}
                }

                let mut twin_rel_stored: Option<String> = None;
                if let Some(twin_text) = raw_twin_md {
                    let twin_rel = format!("{rel_path}.md");
                    let twin_abs = resolve_contained_subpath(&twins_dir, &twin_rel)?;
                    fs::write(&twin_abs, twin_text.as_bytes())?;
                    twin_contents.insert(rel_path.clone(), twin_text);
                    twin_rel_stored = Some(twin_rel);
                    twins_written += 1;
                }

                for sh in workbook_sheets {
                    let headers_json = serde_json::to_string(&sh.headers)?;
                    let rows_json = serde_json::to_string(&sh.rows)?;
                    let formulas_json = serde_json::to_string(&sh.formulas)?;
                    tx.execute(
                        "INSERT OR REPLACE INTO sheets
                         (workspace_id, workbook_path, sheet_name, hidden, headers_json, rows_json, formulas_json, total_rows)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            workspace_id,
                            rel_path,
                            sh.sheet_name,
                            i64::from(sh.hidden),
                            headers_json,
                            rows_json,
                            formulas_json,
                            sh.rows.len() as i64
                        ],
                    )?;
                    sheets_indexed += 1;
                }

                tx.execute(
                    "INSERT OR REPLACE INTO vault_files
                     (workspace_id, rel_path, ext, byte_size, sha256, tier, twin_rel_path, ingested_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        workspace_id,
                        rel_path,
                        ext,
                        byte_size as i64,
                        sha256_hex,
                        tier,
                        twin_rel_stored,
                        now_ms
                    ],
                )?;
                files_ingested += 1;
            }

            {
                let mut f_stmt = tx.prepare_cached(
                    "INSERT INTO dlp_findings
                     (workspace_id, category, severity, file_path, line, col, redacted_preview, value_sha256)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?;
                for f in &all_dlp_findings {
                    f_stmt.execute(params![
                        workspace_id,
                        f.category.as_str(),
                        f.severity,
                        f.file_path,
                        f.line as i64,
                        f.col as i64,
                        f.redacted_preview,
                        f.value_sha256
                    ])?;
                }
            }

            let (conflicts, duplicates_detected, version_collisions) =
                detect_workspace_conflicts_in_tx(&tx, workspace_id, &twin_contents)?;

            {
                let mut c_stmt = tx.prepare_cached(
                    "INSERT INTO authority_conflicts
                     (id, workspace_id, kind, severity, primary_path, conflicting_path, description)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?;
                for c in &conflicts {
                    c_stmt.execute(params![
                        c.id,
                        c.workspace_id,
                        c.kind,
                        c.severity,
                        c.primary_path,
                        c.conflicting_path,
                        c.description
                    ])?;
                }
            }

            tx.commit()?;

            Ok(NexusIngestResult {
                workspace_id: workspace_id.to_string(),
                files_scanned,
                files_ingested,
                sheets_indexed,
                twins_written,
                dlp_redactions: all_dlp_findings.len(),
                duplicates_detected,
                version_collisions,
                conflicts,
            })
        }
    }

    /// Queries ingested `.xlsx` and `.csv` sheets inside `workspace_id`.
    pub fn query_sheet(
        &self,
        workspace_id: &str,
        workbook_filter: Option<&str>,
        sheet_filter: Option<&str>,
        row_query: Option<&str>,
        limit_rows: usize,
    ) -> VortexResult<Vec<NexusSheetQueryResult>> {
        let ws_id = validate_workspace_id(workspace_id)?;
        let cap = limit_rows.clamp(1, 1000);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT workbook_path, sheet_name, headers_json, rows_json, formulas_json, total_rows
             FROM sheets
             WHERE workspace_id = ?1
             ORDER BY workbook_path ASC, id ASC",
        )?;

        let rows = stmt.query_map(params![ws_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?.max(0) as usize,
            ))
        })?;

        let wb_q = workbook_filter.map(|s| s.to_ascii_lowercase());
        let sh_q = sheet_filter.map(|s| s.to_ascii_lowercase());
        let row_q = row_query.map(|s| s.to_ascii_lowercase());

        let mut results = Vec::new();
        for item in rows {
            let (wb_path, sh_name, headers_j, rows_j, formulas_j, total_rows) = item?;
            if let Some(ref wq) = wb_q {
                if !wb_path.to_ascii_lowercase().contains(wq) {
                    continue;
                }
            }
            if let Some(ref sq) = sh_q {
                if !sh_name.to_ascii_lowercase().contains(sq) {
                    continue;
                }
            }
            let headers: Vec<String> = serde_json::from_str(&headers_j)?;
            let mut parsed_rows: Vec<BTreeMap<String, String>> = serde_json::from_str(&rows_j)?;
            let formulas: BTreeMap<String, String> = serde_json::from_str(&formulas_j)?;

            if let Some(ref rq) = row_q {
                parsed_rows.retain(|map| {
                    map.values()
                        .any(|v| v.to_ascii_lowercase().contains(rq.as_str()))
                });
            }
            parsed_rows.truncate(cap);

            results.push(NexusSheetQueryResult {
                workspace_id: workspace_id.to_string(),
                workbook_path: wb_path,
                sheet_name: sh_name,
                headers,
                total_rows,
                rows: parsed_rows,
                formulas,
            });
        }

        Ok(results)
    }

    /// Generates a DLP and authority conflict audit report for `workspace_id`.
    pub fn audit_dlp(&self, workspace_id: &str) -> VortexResult<NexusAuditReport> {
        let ws_id = validate_workspace_id(workspace_id)?;
        let conn = self.conn.lock();
        let mut f_stmt = conn.prepare(
            "SELECT category, severity, file_path, line, col, redacted_preview, value_sha256
             FROM dlp_findings
             WHERE workspace_id = ?1
             ORDER BY file_path ASC, line ASC",
        )?;
        let f_rows = f_stmt.query_map(params![ws_id], |r| {
            let cat_str: String = r.get(0)?;
            Ok(DlpFinding {
                category: parse_dlp_category(&cat_str),
                severity: r.get(1)?,
                file_path: r.get(2)?,
                line: r.get::<_, i64>(3)?.max(1) as usize,
                col: r.get::<_, i64>(4)?.max(1) as usize,
                redacted_preview: r.get(5)?,
                value_sha256: r.get(6)?,
            })
        })?;

        let mut findings = Vec::new();
        let mut by_category: BTreeMap<String, usize> = BTreeMap::new();
        for item in f_rows {
            let f = item?;
            *by_category.entry(f.category.as_str().to_string()).or_insert(0) += 1;
            findings.push(f);
        }

        let mut c_stmt = conn.prepare(
            "SELECT id, workspace_id, kind, severity, primary_path, conflicting_path, description
             FROM authority_conflicts
             WHERE workspace_id = ?1
             ORDER BY kind ASC, primary_path ASC",
        )?;
        let c_rows = c_stmt.query_map(params![workspace_id], |r| {
            Ok(NexusAuthorityConflict {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                kind: r.get(2)?,
                severity: r.get(3)?,
                primary_path: r.get(4)?,
                conflicting_path: r.get(5)?,
                description: r.get(6)?,
            })
        })?;
        let mut conflicts = Vec::new();
        for item in c_rows {
            conflicts.push(item?);
        }

        let total_findings = findings.len();
        Ok(NexusAuditReport {
            workspace_id: workspace_id.to_string(),
            total_findings,
            by_category,
            findings,
            clean: total_findings == 0 && conflicts.is_empty(),
            conflicts,
        })
    }

    /// Sanitizes a Google Drive item title and joins it under `prefix`, rejecting Drive-Slip
    /// traversal segments (`"."`, `".."`, NUL bytes, or empty sanitized names).
    pub fn sanitize_drive_item_path(prefix: &str, raw_title: &str) -> VortexResult<String> {
        let safe_seg = sanitize_drive_segment(raw_title)?;
        let candidate = if prefix.is_empty() {
            safe_seg
        } else {
            let clean_prefix = validate_clean_relative_subpath(prefix)?;
            format!("{clean_prefix}/{safe_seg}")
        };
        validate_clean_relative_subpath(&candidate)
    }

    /// Synchronizes a Google Drive folder (via v3 OAuth or v2beta shared folder key) into `dest_dir`
    /// with parallel downloads and immediately ingests it into `DriveNexusVault`.
    pub fn sync_drive_folder(
        &self,
        workspace_id: &str,
        folder_id_or_url: &str,
        dest_dir: &Path,
        auth_token_or_key: Option<&str>,
    ) -> VortexResult<NexusIngestResult> {
        let ws_id = validate_workspace_id(workspace_id)?;
        let folder_id = extract_drive_folder_id(folder_id_or_url)?;
        if fs::symlink_metadata(dest_dir)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(VortexError::InvalidInput(format!(
                "Drive sync destination '{}' must not be a symbolic link",
                dest_dir.display()
            )));
        }
        fs::create_dir_all(dest_dir)?;
        let canon_dest = dest_dir.canonicalize()?;

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("KaxcavVortex/4.0")
            .build()?;

        let is_oauth = auth_token_or_key
            .map(|t| t.starts_with("ya29.") || t.starts_with("Bearer "))
            .unwrap_or(false);

        let web_key = if is_oauth {
            None
        } else if let Some(explicit_k) = auth_token_or_key.filter(|k| !k.trim().is_empty()) {
            Some(explicit_k.trim().to_string())
        } else if let Ok(env_keys) = std::env::var("KVX_DRIVE_WEB_KEYS") {
            env_keys
                .split(',')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(String::from)
        } else {
            discover_drive_web_key(&client, &folder_id)?
        };

        let remote_files = crawl_drive_folder_bfs(
            &client,
            &folder_id,
            is_oauth,
            auth_token_or_key,
            web_key.as_deref(),
        )?;

        remote_files
            .par_iter()
            .try_for_each(|item| -> VortexResult<()> {
                let target_path = resolve_contained_subpath(&canon_dest, &item.rel_path)?;
                let bytes = download_drive_item(
                    &client,
                    item,
                    is_oauth,
                    auth_token_or_key,
                    web_key.as_deref(),
                )?;
                fs::write(&target_path, bytes)?;
                Ok(())
            })?;

        self.ingest_directory(ws_id, &canon_dest, Some(&folder_id))
    }
}

fn classify_authority_tier(rel_path: &str) -> &'static str {
    let lower = rel_path.to_ascii_lowercase();
    if lower.contains("legacy")
        || lower.contains("archive")
        || lower.contains("old/")
        || lower.contains("backup")
        || lower.contains("obsoleto")
        || lower.contains("deprecated")
    {
        "legacy"
    } else {
        "canonical"
    }
}

fn detect_workspace_conflicts_in_tx(
    conn: &Connection,
    workspace_id: &str,
    twin_contents: &HashMap<String, String>,
) -> VortexResult<(Vec<NexusAuthorityConflict>, usize, usize)> {
    let files: Vec<VaultFileRow> = {
        let mut stmt = conn.prepare(
            "SELECT rel_path, ext, byte_size, sha256, tier, twin_rel_path
             FROM vault_files
             WHERE workspace_id = ?1
             ORDER BY CASE WHEN tier = 'canonical' THEN 0 ELSE 1 END, rel_path ASC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(VaultFileRow {
                rel_path: r.get(0)?,
                ext: r.get(1)?,
                byte_size: r.get::<_, i64>(2)?.max(0) as u64,
                sha256: r.get(3)?,
                tier: r.get(4)?,
                twin_rel_path: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        out
    };

    let mut conflicts = Vec::new();
    let mut duplicates_detected = 0usize;
    let mut version_collisions = 0usize;

    let mut by_hash: BTreeMap<String, Vec<&VaultFileRow>> = BTreeMap::new();
    for f in &files {
        if f.byte_size > 0 && f.twin_rel_path.as_deref() != Some("") {
            by_hash.entry(f.sha256.clone()).or_default().push(f);
        }
    }

    for (sha, group) in by_hash {
        if group.len() > 1 {
            let primary = group[0];
            for dup in &group[1..] {
                duplicates_detected += 1;
                conflicts.push(NexusAuthorityConflict {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.to_string(),
                    kind: "exact_duplicate".to_string(),
                    severity: "medium".to_string(),
                    primary_path: primary.rel_path.clone(),
                    conflicting_path: dup.rel_path.clone(),
                    description: format!(
                        "Identical SHA-256 ({}) duplicated across '{}' and '{}'",
                        &sha[..12],
                        primary.rel_path,
                        dup.rel_path
                    ),
                });
            }
        }
    }

    let mut by_stem: BTreeMap<(String, String), Vec<&VaultFileRow>> = BTreeMap::new();
    for f in &files {
        let stem = normalize_version_stem(&f.rel_path);
        if stem.len() >= 3 {
            by_stem
                .entry((stem, f.ext.clone()))
                .or_default()
                .push(f);
        }
    }

    for ((stem, _), group) in by_stem {
        if group.len() < 2 {
            continue;
        }
        let primary = group[0];
        for other in &group[1..] {
            if other.sha256 != primary.sha256 {
                version_collisions += 1;
                conflicts.push(NexusAuthorityConflict {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.to_string(),
                    kind: "version_collision".to_string(),
                    severity: "high".to_string(),
                    primary_path: primary.rel_path.clone(),
                    conflicting_path: other.rel_path.clone(),
                    description: format!(
                        "Divergent versions of document stem '{}' ('{}' vs '{}') have different SHA-256 hashes",
                        stem, primary.rel_path, other.rel_path
                    ),
                });
            }
        }
    }

    let invariants: Vec<CustomInvariant> = {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, title, canonical_pattern, forbidden_pattern, severity
             FROM custom_invariants WHERE workspace_id = ?1",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(CustomInvariant {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                title: r.get(2)?,
                canonical_pattern: r.get(3)?,
                forbidden_pattern: r.get(4)?,
                severity: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        out
    };

    for inv in invariants {
        let Ok(canon_re) = Regex::new(&inv.canonical_pattern) else {
            continue;
        };
        let Ok(forbid_re) = Regex::new(&inv.forbidden_pattern) else {
            continue;
        };
        let canon_holder = files.iter().find(|f| {
            f.tier == "canonical"
                && twin_contents
                    .get(&f.rel_path)
                    .map(|txt| canon_re.is_match(txt))
                    .unwrap_or(false)
        });
        if let Some(primary) = canon_holder {
            for f in &files {
                if f.rel_path == primary.rel_path {
                    continue;
                }
                if let Some(txt) = twin_contents.get(&f.rel_path) {
                    if forbid_re.is_match(txt) {
                        conflicts.push(NexusAuthorityConflict {
                            id: uuid::Uuid::new_v4().to_string(),
                            workspace_id: workspace_id.to_string(),
                            kind: "invariant_violation".to_string(),
                            severity: inv.severity.clone(),
                            primary_path: primary.rel_path.clone(),
                            conflicting_path: f.rel_path.clone(),
                            description: format!(
                                "Custom invariant '{}' violated by '{}' (canonical authority: '{}')",
                                inv.title, f.rel_path, primary.rel_path
                            ),
                        });
                    }
                }
            }
        }
    }

    Ok((conflicts, duplicates_detected, version_collisions))
}

fn normalize_version_stem(rel_path: &str) -> String {
    static SUFFIX_RE: OnceLock<Regex> = OnceLock::new();
    let re = SUFFIX_RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:[\s_-]*(?:\(\d+\)|copia|copy|v\d+(?:\.\d+)?|rev\d+|final|old|backup|novo))+$",
        )
        .unwrap_or_else(|_| unreachable!())
    });

    let stem = Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    re.replace_all(stem.trim(), "")
        .trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .to_ascii_lowercase()
}

fn parse_xlsx_bytes(bytes: &[u8]) -> VortexResult<Vec<ExtractedSheet>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;

    let shared_strings = match read_zip_entry_string(&mut archive, "xl/sharedStrings.xml") {
        Some(xml) => parse_shared_strings_xml(&xml)?,
        None => Vec::new(),
    };

    let rels_map = match read_zip_entry_string(&mut archive, "xl/_rels/workbook.xml.rels") {
        Some(xml) => parse_workbook_rels_xml(&xml)?,
        None => HashMap::new(),
    };

    let sheet_defs = match read_zip_entry_string(&mut archive, "xl/workbook.xml") {
        Some(xml) => parse_workbook_sheets_xml(&xml)?,
        None => vec![("Sheet1".to_string(), "rId1".to_string(), false)],
    };

    let mut extracted = Vec::new();
    for (idx, (sheet_name, rel_id, hidden)) in sheet_defs.into_iter().enumerate() {
        let target_rel = rels_map
            .get(&rel_id)
            .cloned()
            .unwrap_or_else(|| format!("worksheets/sheet{}.xml", idx + 1));
        let zip_entry_name = if target_rel.starts_with("xl/") {
            target_rel
        } else {
            format!("xl/{}", target_rel.trim_start_matches('/'))
        };

        if let Some(sheet_xml) = read_zip_entry_string(&mut archive, &zip_entry_name) {
            let parsed = parse_worksheet_xml(&sheet_name, hidden, &sheet_xml, &shared_strings)?;
            extracted.push(parsed);
        }
    }

    Ok(extracted)
}

fn read_zip_entry_string(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    Some(content)
}

fn parse_shared_strings_xml(xml: &str) -> VortexResult<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    let mut strings = Vec::new();
    let mut in_si = false;
    let mut in_t = false;
    let mut current = String::new();

    loop {
        match reader.read_event()? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = true;
                    current.clear();
                }
                b"t" if in_si => {
                    in_t = true;
                }
                _ => {}
            },
            Event::Text(t) if in_si && in_t => {
                current.push_str(&t.unescape()?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"si" => {
                    in_si = false;
                    strings.push(current.clone());
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}

fn parse_workbook_rels_xml(xml: &str) -> VortexResult<HashMap<String, String>> {
    let mut reader = Reader::from_str(xml);
    let mut map = HashMap::new();
    loop {
        match reader.read_event()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                let mut id = None;
                let mut target = None;
                for attr in e.attributes().flatten() {
                    match attr.key.local_name().as_ref() {
                        b"Id" => id = Some(attr.unescape_value()?.into_owned()),
                        b"Target" => target = Some(attr.unescape_value()?.into_owned()),
                        _ => {}
                    }
                }
                if let (Some(i), Some(t)) = (id, target) {
                    map.insert(i, t);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(map)
}

fn parse_workbook_sheets_xml(xml: &str) -> VortexResult<Vec<(String, String, bool)>> {
    let mut reader = Reader::from_str(xml);
    let mut sheets = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sheet" => {
                let mut name = None;
                let mut r_id = None;
                let mut hidden = false;
                for attr in e.attributes().flatten() {
                    match attr.key.local_name().as_ref() {
                        b"name" => name = Some(attr.unescape_value()?.into_owned()),
                        b"id" => r_id = Some(attr.unescape_value()?.into_owned()),
                        b"state" => {
                            let st = attr.unescape_value()?;
                            hidden = st == "hidden" || st == "veryHidden";
                        }
                        _ => {}
                    }
                }
                if let Some(n) = name {
                    let rid = r_id.unwrap_or_else(|| format!("rId{}", sheets.len() + 1));
                    sheets.push((n, rid, hidden));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(sheets)
}

fn parse_worksheet_xml(
    sheet_name: &str,
    hidden: bool,
    xml: &str,
    shared_strings: &[String],
) -> VortexResult<ExtractedSheet> {
    let mut reader = Reader::from_str(xml);
    let mut grid_rows: Vec<Vec<String>> = Vec::new();
    let mut formulas: BTreeMap<String, String> = BTreeMap::new();

    let mut current_row: Vec<String> = Vec::new();
    let mut in_cell = false;
    let mut cell_ref = String::new();
    let mut cell_type = String::new();
    let mut cell_col_idx = 0usize;
    let mut in_v = false;
    let mut in_f = false;
    let mut in_inline_t = false;
    let mut v_buf = String::new();
    let mut f_buf = String::new();

    loop {
        match reader.read_event()? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"row" => {
                    current_row.clear();
                }
                b"c" => {
                    in_cell = true;
                    cell_ref.clear();
                    cell_type.clear();
                    v_buf.clear();
                    f_buf.clear();
                    for attr in e.attributes().flatten() {
                        match attr.key.local_name().as_ref() {
                            b"r" => cell_ref = attr.unescape_value()?.into_owned(),
                            b"t" => cell_type = attr.unescape_value()?.into_owned(),
                            _ => {}
                        }
                    }
                    cell_col_idx = excel_col_index(&cell_ref).unwrap_or(current_row.len());
                }
                b"v" if in_cell => in_v = true,
                b"f" if in_cell => in_f = true,
                b"t" if in_cell => in_inline_t = true,
                _ => {}
            },
            Event::Text(t) if in_cell => {
                let txt = t.unescape()?;
                if in_v || in_inline_t {
                    v_buf.push_str(&txt);
                } else if in_f {
                    f_buf.push_str(&txt);
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"v" => in_v = false,
                b"f" => in_f = false,
                b"t" => in_inline_t = false,
                b"c" => {
                    in_cell = false;
                    if !f_buf.trim().is_empty() && !cell_ref.is_empty() {
                        let formula_str = if f_buf.starts_with('=') {
                            f_buf.trim().to_string()
                        } else {
                            format!("={}", f_buf.trim())
                        };
                        formulas.insert(cell_ref.clone(), formula_str);
                    }
                    let resolved_val = if cell_type == "s" {
                        v_buf
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|idx| shared_strings.get(idx).cloned())
                            .unwrap_or_default()
                    } else if cell_type == "b" {
                        if v_buf.trim() == "1" {
                            "TRUE".to_string()
                        } else {
                            "FALSE".to_string()
                        }
                    } else {
                        v_buf.trim().to_string()
                    };

                    if current_row.len() <= cell_col_idx {
                        current_row.resize(cell_col_idx + 1, String::new());
                    }
                    current_row[cell_col_idx] = resolved_val;
                }
                b"row" if current_row.iter().any(|c| !c.trim().is_empty()) => {
                    grid_rows.push(current_row.clone());
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(grid_to_extracted_sheet(sheet_name, hidden, grid_rows, formulas))
}

fn excel_col_index(cell_ref: &str) -> Option<usize> {
    let letters: String = cell_ref
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    if letters.is_empty() {
        return None;
    }
    let mut col = 0usize;
    for ch in letters.chars() {
        let digit = (ch.to_ascii_uppercase() as u8).saturating_sub(b'A') as usize + 1;
        col = col * 26 + digit;
    }
    col.checked_sub(1)
}

fn grid_to_extracted_sheet(
    sheet_name: &str,
    hidden: bool,
    grid_rows: Vec<Vec<String>>,
    formulas: BTreeMap<String, String>,
) -> ExtractedSheet {
    if grid_rows.is_empty() {
        return ExtractedSheet {
            sheet_name: sheet_name.to_string(),
            hidden,
            headers: Vec::new(),
            rows: Vec::new(),
            formulas,
        };
    }

    let raw_headers = &grid_rows[0];
    let headers: Vec<String> = raw_headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let trimmed = h.trim();
            if trimmed.is_empty() {
                format!("col_{}", i + 1)
            } else {
                trimmed.to_string()
            }
        })
        .collect();

    let mut rows = Vec::with_capacity(grid_rows.len().saturating_sub(1));
    for data_row in grid_rows.into_iter().skip(1) {
        let mut map = BTreeMap::new();
        for (col_i, val) in data_row.into_iter().enumerate() {
            let header = headers
                .get(col_i)
                .cloned()
                .unwrap_or_else(|| format!("col_{}", col_i + 1));
            map.insert(header, val);
        }
        rows.push(map);
    }

    ExtractedSheet {
        sheet_name: sheet_name.to_string(),
        hidden,
        headers,
        rows,
        formulas,
    }
}

fn parse_docx_bytes(bytes: &[u8]) -> VortexResult<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let Some(xml) = read_zip_entry_string(&mut archive, "word/document.xml") else {
        return Ok(String::new());
    };
    let mut reader = Reader::from_str(&xml);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut para_buf = String::new();
    let mut in_t = false;

    loop {
        match reader.read_event()? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"p" => para_buf.clear(),
                b"t" => in_t = true,
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == b"tab" => {
                para_buf.push('\t');
            }
            Event::Text(t) if in_t => {
                para_buf.push_str(&t.unescape()?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"p" => {
                    let trimmed = para_buf.trim();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed.to_string());
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(paragraphs.join("\n\n"))
}

fn parse_csv_text(text: &str) -> VortexResult<ExtractedSheet> {
    let first_line = text.lines().next().unwrap_or("");
    let delim = if first_line.matches(';').count() > first_line.matches(',').count() {
        b';'
    } else {
        b','
    };
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .flexible(true)
        .has_headers(false)
        .from_reader(text.as_bytes());

    let mut grid = Vec::new();
    for rec in rdr.records() {
        let row: Vec<String> = rec?.iter().map(|s| s.trim().to_string()).collect();
        if row.iter().any(|c| !c.is_empty()) {
            grid.push(row);
        }
    }
    Ok(grid_to_extracted_sheet("CSV", false, grid, BTreeMap::new()))
}

fn render_sheet_markdown(sh: &ExtractedSheet) -> String {
    let mut md = format!(
        "## Sheet: {}{}\n\n",
        sh.sheet_name,
        if sh.hidden { " (hidden)" } else { "" }
    );
    if !sh.headers.is_empty() {
        md.push_str("| ");
        md.push_str(&sh.headers.join(" | "));
        md.push_str(" |\n| ");
        md.push_str(
            &sh.headers
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | "),
        );
        md.push_str(" |\n");
        for row in sh.rows.iter().take(50) {
            let vals: Vec<String> = sh
                .headers
                .iter()
                .map(|h| row.get(h).cloned().unwrap_or_default().replace('|', "\\|"))
                .collect();
            md.push_str("| ");
            md.push_str(&vals.join(" | "));
            md.push_str(" |\n");
        }
        md.push('\n');
    }
    if !sh.formulas.is_empty() {
        md.push_str("### Formulas\n");
        for (cell, expr) in sh.formulas.iter().take(30) {
            md.push_str(&format!("- `{cell}`: `{expr}`\n"));
        }
        md.push('\n');
    }
    md
}

fn parse_dlp_category(s: &str) -> DlpCategory {
    for c in DlpCategory::ALL {
        if c.as_str() == s {
            return c;
        }
    }
    DlpCategory::GenericSecret
}

#[derive(Debug, Clone)]
struct DriveDownloadItem {
    id: String,
    rel_path: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
struct DriveV3List {
    #[serde(default)]
    files: Vec<DriveV3Item>,
}

#[derive(Debug, Deserialize)]
struct DriveV3Item {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

#[derive(Debug, Deserialize)]
struct DriveV2List {
    #[serde(default)]
    items: Vec<DriveV2Item>,
}

#[derive(Debug, Deserialize)]
struct DriveV2Item {
    id: String,
    title: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

fn extract_drive_folder_id(raw: &str) -> VortexResult<String> {
    let trimmed = raw.trim();
    if let Some(idx) = trimmed.find("/folders/") {
        let after = &trimmed[idx + "/folders/".len()..];
        let id = after.split(['?', '/', '#']).next().unwrap_or("");
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    if trimmed.len() >= 10
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Ok(trimmed.to_string());
    }
    Err(VortexError::InvalidInput(format!(
        "Invalid Google Drive folder identifier or URL: '{raw}'"
    )))
}

fn discover_drive_web_key(client: &Client, folder_id: &str) -> VortexResult<Option<String>> {
    let url = format!("https://drive.google.com/drive/folders/{folder_id}");
    let Ok(resp) = client.get(&url).send() else {
        return Ok(None);
    };
    let Ok(html) = resp.text() else {
        return Ok(None);
    };
    static KEY_RE: OnceLock<Regex> = OnceLock::new();
    let re = KEY_RE
        .get_or_init(|| Regex::new(r"AIza[0-9A-Za-z_-]{35}").unwrap_or_else(|_| unreachable!()));
    Ok(re.find(&html).map(|m| m.as_str().to_string()))
}

fn crawl_drive_folder_bfs(
    client: &Client,
    root_folder_id: &str,
    is_oauth: bool,
    auth_token: Option<&str>,
    web_key: Option<&str>,
) -> VortexResult<Vec<DriveDownloadItem>> {
    let mut queue: VecDeque<(String, String)> = VecDeque::new();
    queue.push_back((root_folder_id.to_string(), String::new()));
    let mut out = Vec::new();

    while let Some((folder_id, prefix)) = queue.pop_front() {
        let children: Vec<(String, String, String)> = if is_oauth {
            let bearer = auth_token
                .unwrap_or_default()
                .trim_start_matches("Bearer ")
                .trim();
            let q = format!("'{folder_id}' in parents and trashed = false");
            let resp: DriveV3List = client
                .get("https://www.googleapis.com/drive/v3/files")
                .bearer_auth(bearer)
                .query(&[
                    ("q", q.as_str()),
                    ("fields", "files(id,name,mimeType)"),
                    ("pageSize", "200"),
                ])
                .send()?
                .error_for_status()?
                .json()?;
            resp.files
                .into_iter()
                .map(|f| (f.id, f.name, f.mime_type))
                .collect()
        } else {
            let key = web_key.ok_or_else(|| {
                VortexError::InvalidInput(
                    "Drive sync requires either an OAuth token, API key, or discoverable public folder web key"
                        .to_string(),
                )
            })?;
            let q = format!("'{folder_id}' in parents and trashed = false");
            let resp: DriveV2List = client
                .get("https://clients6.google.com/drive/v2beta/files")
                .query(&[("q", q.as_str()), ("key", key), ("maxResults", "200")])
                .send()?
                .error_for_status()?
                .json()?;
            resp.items
                .into_iter()
                .map(|f| (f.id, f.title, f.mime_type))
                .collect()
        };

        for (id, name, mime) in children {
            let rel = DriveNexusVault::sanitize_drive_item_path(&prefix, &name)?;
            if mime == "application/vnd.google-apps.folder" {
                queue.push_back((id, rel));
            } else {
                let final_rel = match mime.as_str() {
                    "application/vnd.google-apps.spreadsheet" if !rel.ends_with(".xlsx") => {
                        format!("{rel}.xlsx")
                    }
                    "application/vnd.google-apps.document" if !rel.ends_with(".docx") => {
                        format!("{rel}.docx")
                    }
                    _ => rel,
                };
                let verified_rel = validate_clean_relative_subpath(&final_rel)?;
                out.push(DriveDownloadItem {
                    id,
                    rel_path: verified_rel,
                    mime_type: mime,
                });
            }
        }
    }

    Ok(out)
}

fn validate_workspace_id(workspace_id: &str) -> VortexResult<&str> {
    if workspace_id.is_empty() || workspace_id.len() > 128 {
        return Err(VortexError::InvalidInput(format!(
            "Invalid Nexus workspace_id '{workspace_id}': must be 1..=128 ASCII identifier chars"
        )));
    }
    if workspace_id.trim() != workspace_id
        || workspace_id == "."
        || workspace_id == ".."
        || workspace_id.starts_with('.')
        || workspace_id.ends_with('.')
        || workspace_id.contains("..")
    {
        return Err(VortexError::InvalidInput(format!(
            "Invalid Nexus workspace_id '{workspace_id}': path traversal or dot boundary is forbidden"
        )));
    }
    if !workspace_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(VortexError::InvalidInput(format!(
            "Invalid Nexus workspace_id '{workspace_id}': only [A-Za-z0-9_.-] are allowed"
        )));
    }
    Ok(workspace_id)
}

fn sanitize_drive_segment(raw_title: &str) -> VortexResult<String> {
    if raw_title.contains('\0') {
        return Err(VortexError::InvalidInput(
            "Drive item title contains forbidden NUL byte".to_string(),
        ));
    }
    let trimmed = raw_title.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(VortexError::InvalidInput(format!(
            "Unsafe Drive item title '{raw_title}' rejected by Drive-Slip guard"
        )));
    }
    for part in trimmed.split(['/', '\\']) {
        if part.trim() == ".." {
            return Err(VortexError::InvalidInput(format!(
                "Drive-Slip path traversal segment '..' rejected in title '{raw_title}'"
            )));
        }
    }

    let mapped: String = trimmed
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();

    let cleaned = mapped
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err(VortexError::InvalidInput(format!(
            "Drive item title '{raw_title}' collapses to empty/dot segment after sanitization"
        )));
    }

    let mut comps = Path::new(&cleaned).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(cleaned),
        _ => Err(VortexError::InvalidInput(format!(
            "Sanitized Drive item title '{cleaned}' is not a single normal path segment"
        ))),
    }
}

fn validate_clean_relative_subpath(raw_rel: &str) -> VortexResult<String> {
    if raw_rel.contains('\0') {
        return Err(VortexError::InvalidInput(
            "Relative path contains forbidden NUL byte".to_string(),
        ));
    }
    let unified = raw_rel.replace('\\', "/");
    if unified.starts_with('/') {
        return Err(VortexError::InvalidInput(format!(
            "Absolute path '{raw_rel}' is forbidden in relative subpath"
        )));
    }
    let mut parts = Vec::new();
    for comp in Path::new(&unified).components() {
        match comp {
            Component::Normal(os) => {
                let s = os.to_str().ok_or_else(|| {
                    VortexError::InvalidInput("Non-UTF-8 path segment".to_string())
                })?;
                if s.is_empty() || s == "." || s == ".." {
                    return Err(VortexError::InvalidInput(format!(
                        "Unsafe path segment '{s}' in '{raw_rel}'"
                    )));
                }
                parts.push(s);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(VortexError::InvalidInput(format!(
                    "Forbidden path traversal component in '{raw_rel}'"
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(VortexError::InvalidInput(
            "Relative subpath must not be empty".to_string(),
        ));
    }
    Ok(parts.join("/"))
}

fn resolve_contained_dir(canon_base: &Path, child_rel: &str) -> VortexResult<PathBuf> {
    let clean_rel = validate_clean_relative_subpath(child_rel)?;
    let mut acc = canon_base.to_path_buf();
    for seg in clean_rel.split('/') {
        acc.push(seg);
        if let Ok(meta) = fs::symlink_metadata(&acc) {
            if meta.file_type().is_symlink() {
                return Err(VortexError::InvalidInput(format!(
                    "Refusing symlink directory segment '{}' inside '{}'",
                    clean_rel,
                    canon_base.display()
                )));
            }
        }
    }
    fs::create_dir_all(&acc)?;
    let canon_dir = acc.canonicalize()?;
    if !canon_dir.starts_with(canon_base) || canon_dir == canon_base {
        return Err(VortexError::InvalidInput(format!(
            "Directory '{}' escapes containment root '{}'",
            clean_rel,
            canon_base.display()
        )));
    }
    Ok(canon_dir)
}

fn resolve_contained_subpath(canon_base: &Path, raw_rel: &str) -> VortexResult<PathBuf> {
    let clean_rel = validate_clean_relative_subpath(raw_rel)?;
    let segments: Vec<&str> = clean_rel.split('/').collect();
    let mut acc = canon_base.to_path_buf();

    for (idx, seg) in segments.iter().enumerate() {
        acc.push(seg);
        let is_last = idx + 1 == segments.len();
        if let Ok(meta) = fs::symlink_metadata(&acc) {
            if meta.file_type().is_symlink() {
                return Err(VortexError::InvalidInput(format!(
                    "Refusing symlink path component '{}' inside '{}'",
                    clean_rel,
                    canon_base.display()
                )));
            }
            if !is_last && !meta.is_dir() {
                return Err(VortexError::InvalidInput(format!(
                    "Non-directory intermediate path component in '{}'",
                    clean_rel
                )));
            }
        } else if !is_last {
            fs::create_dir_all(&acc)?;
        }
    }

    let parent = acc.parent().ok_or_else(|| {
        VortexError::InvalidInput(format!("Missing parent directory for '{clean_rel}'"))
    })?;
    fs::create_dir_all(parent)?;
    let canon_parent = parent.canonicalize()?;
    if !canon_parent.starts_with(canon_base) {
        return Err(VortexError::InvalidInput(format!(
            "Target parent for '{}' escapes containment root '{}'",
            clean_rel,
            canon_base.display()
        )));
    }
    let file_name = acc.file_name().ok_or_else(|| {
        VortexError::InvalidInput(format!("Missing file name in '{clean_rel}'"))
    })?;
    Ok(canon_parent.join(file_name))
}

fn download_drive_item(
    client: &Client,
    item: &DriveDownloadItem,
    is_oauth: bool,
    auth_token: Option<&str>,
    web_key: Option<&str>,
) -> VortexResult<Vec<u8>> {
    let export_mime = match item.mime_type.as_str() {
        "application/vnd.google-apps.spreadsheet" => {
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        }
        "application/vnd.google-apps.document" => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        }
        _ => None,
    };

    let req = if let Some(exp) = export_mime {
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{}/export",
            item.id
        );
        let mut r = client.get(url).query(&[("mimeType", exp)]);
        if is_oauth {
            let bearer = auth_token
                .unwrap_or_default()
                .trim_start_matches("Bearer ")
                .trim();
            r = r.bearer_auth(bearer);
        } else if let Some(k) = web_key {
            r = r.query(&[("key", k)]);
        }
        r
    } else {
        let url = format!("https://www.googleapis.com/drive/v3/files/{}", item.id);
        let mut r = client.get(url).query(&[("alt", "media")]);
        if is_oauth {
            let bearer = auth_token
                .unwrap_or_default()
                .trim_start_matches("Bearer ")
                .trim();
            r = r.bearer_auth(bearer);
        } else if let Some(k) = web_key {
            r = r.query(&[("key", k)]);
        }
        r
    };

    let bytes = req.send()?.error_for_status()?.bytes()?;
    Ok(bytes.to_vec())
}
