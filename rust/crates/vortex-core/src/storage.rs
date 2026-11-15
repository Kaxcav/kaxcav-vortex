//! SQLite WAL shard (`VortexShard`) with FTS5 BM25F ranking, parallel incremental `rayon` sync,
//! edge resolution, contract drift history, and symbol lock persistence.
//!
//! Traceability: `@REQ-VORTEX-001`, `@REQ-VORTEX-002`, `@REQ-VORTEX-004`.

use crate::kvxignore::KvxIgnore;
use crate::parser::{AstParser, ParsedFile};
use crate::types::{
    CallGraphEndpoint, CallGraphResponse, CoChangedFile, EdgeRecord, FileOutlineResponse,
    FindReferencesResponse, LockMode, OutlineScope, ReadSymbolMatch, ReadSymbolResponse,
    RefConfidence, ReferenceRecord, RouteRecord, SearchHit, SearchResponse, SearchVia, ShardHealth,
    SlopFinding, SymbolLock, SymbolRecord, VortexError, VortexResult,
};
use chrono::Utc;
use ignore::WalkBuilder;
use parking_lot::Mutex;
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Schema version of the `VortexShard` SQLite database.
pub const SHARD_SCHEMA_VERSION: u32 = 4;

/// Summary metrics emitted after an incremental or full `VortexShard::sync`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSummary {
    pub files_scanned: usize,
    pub files_updated: usize,
    pub files_unchanged: usize,
    pub files_pruned: usize,
    pub symbols_indexed: usize,
    pub edges_resolved: usize,
}

#[derive(Debug, Clone)]
struct CandidateDiskFile {
    rel_path: String,
    abs_path: PathBuf,
    ext: String,
    mtime_ms: i64,
    byte_size: u64,
    prev_hash: Option<String>,
}

enum WorkerOutcome {
    HashUnchanged {
        rel_path: String,
        mtime_ms: i64,
        byte_size: u64,
    },
    Parsed {
        rel_path: String,
        ext: String,
        mtime_ms: i64,
        byte_size: u64,
        content_hash: String,
        parsed: ParsedFile,
    },
    Skipped,
}

/// Historical exported contract row recorded when a file changes or is removed.
#[derive(Debug, Clone)]
pub struct HistoricalSymbolRow {
    pub file_path: String,
    pub qualified_name: String,
    pub exported: bool,
    pub signature: String,
    pub sig_hash: String,
    pub body_hash: String,
}

/// Thread-safe per-repository SQLite WAL index shard.
pub struct VortexShard {
    repo_id: String,
    repo_root: PathBuf,
    db_path: PathBuf,
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for VortexShard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VortexShard")
            .field("repo_id", &self.repo_id)
            .field("repo_root", &self.repo_root)
            .field("db_path", &self.db_path)
            .finish()
    }
}

impl VortexShard {
    /// Opens or initializes a SQLite WAL shard for `repo_root` at `db_path`.
    pub fn open(repo_id: impl Into<String>, repo_root: &Path, db_path: &Path) -> VortexResult<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let canonical_root = repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.to_path_buf());
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 15000;
             PRAGMA temp_store = MEMORY;",
        )?;

        let shard = Self {
            repo_id: repo_id.into(),
            repo_root: canonical_root,
            db_path: db_path.to_path_buf(),
            conn: Mutex::new(conn),
        };
        shard.init_schema()?;
        Ok(shard)
    }

    /// Repository identifier assigned to this shard.
    pub fn repo_id(&self) -> &str {
        &self.repo_id
    }

    /// Canonical filesystem root of the indexed repository.
    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    /// Filesystem path to the underlying `.sqlite` shard file.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Loads the current `.kvxignore` + `.kvx.yaml` policy for this repository.
    pub fn load_ignore(&self) -> VortexResult<KvxIgnore> {
        KvxIgnore::load(&self.repo_root)
    }

    fn init_schema(&self) -> VortexResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                ext TEXT NOT NULL,
                mtime_ms INTEGER NOT NULL,
                byte_size INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                indexed_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS symbols (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                file_path TEXT NOT NULL,
                name TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                signature TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                exported INTEGER NOT NULL,
                complexity INTEGER NOT NULL,
                sig_hash TEXT NOT NULL,
                body_hash TEXT NOT NULL,
                docstring TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qualified_name);
            CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);

            CREATE TABLE IF NOT EXISTS edges (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                from_path TEXT NOT NULL,
                raw_target TEXT NOT NULL,
                resolved_path TEXT,
                kind TEXT NOT NULL,
                symbol_name TEXT,
                weight REAL NOT NULL,
                line INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_path);
            CREATE INDEX IF NOT EXISTS idx_edges_resolved ON edges(resolved_path);

            CREATE TABLE IF NOT EXISTS refs (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                file_path TEXT NOT NULL,
                symbol_name TEXT NOT NULL,
                line INTEGER NOT NULL,
                col INTEGER NOT NULL,
                in_symbol TEXT,
                confidence TEXT NOT NULL,
                context_line TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_name);
            CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_path);

            CREATE TABLE IF NOT EXISTS routes (
                id INTEGER PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                file_path TEXT NOT NULL,
                direction TEXT NOT NULL,
                method TEXT NOT NULL,
                route_path TEXT NOT NULL,
                handler_name TEXT,
                line INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_routes_path ON routes(route_path);

            CREATE TABLE IF NOT EXISTS cochange_pairs (
                file_a TEXT NOT NULL,
                file_b TEXT NOT NULL,
                co_commits INTEGER NOT NULL,
                confidence REAL NOT NULL,
                PRIMARY KEY (file_a, file_b)
            );

            CREATE TABLE IF NOT EXISTS symbol_history (
                id INTEGER PRIMARY KEY,
                file_path TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                exported INTEGER NOT NULL,
                signature TEXT NOT NULL,
                sig_hash TEXT NOT NULL,
                body_hash TEXT NOT NULL,
                recorded_at_ms INTEGER NOT NULL,
                UNIQUE(file_path, qualified_name)
            );

            CREATE TABLE IF NOT EXISTS symbol_locks (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                mode TEXT NOT NULL,
                sig_hash TEXT NOT NULL,
                body_hash TEXT NOT NULL,
                owner TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                UNIQUE(file_path, qualified_name)
            );

            CREATE TABLE IF NOT EXISTS pack_snapshots (
                etag TEXT PRIMARY KEY,
                created_at_ms INTEGER NOT NULL,
                symbol_hashes_json TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
                symbol_id UNINDEXED,
                file_path,
                name,
                qualified_name,
                signature,
                docstring,
                tokenize = 'unicode61 remove_diacritics 2'
            );",
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SHARD_SCHEMA_VERSION.to_string()],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('repo_root', ?1)",
            params![self.repo_root.to_string_lossy().to_string()],
        )?;
        Ok(())
    }

    /// Incrementally synchronizes the repository into SQLite WAL using `ignore::WalkBuilder` + `rayon`.
    pub fn sync(&self, force: bool) -> VortexResult<SyncSummary> {
        let kvxignore = self.load_ignore()?;
        let max_bytes = kvxignore.max_file_bytes();

        let existing_files: HashMap<String, (i64, i64, u64, String)> = {
            let conn = self.conn.lock();
            let mut stmt =
                conn.prepare("SELECT id, path, mtime_ms, byte_size, content_hash FROM files")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    (
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?.max(0) as u64,
                        r.get::<_, String>(4)?,
                    ),
                ))
            })?;
            let mut map = HashMap::new();
            for item in rows {
                let (p, tup) = item?;
                map.insert(p, tup);
            }
            map
        };

        let ignore_for_walk = kvxignore.clone();
        let root_for_walk = self.repo_root.clone();
        let mut walker = WalkBuilder::new(&self.repo_root);
        walker
            .follow_links(false)
            .hidden(false)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(true)
            .filter_entry(move |entry| {
                if entry.path() == root_for_walk {
                    return true;
                }
                if entry.path_is_symlink() {
                    return false;
                }
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                if is_dir && entry.path().join(".git").is_file() {
                    return false;
                }
                ignore_for_walk.match_ignored(entry.path(), is_dir).is_none()
            });

        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut to_process: Vec<CandidateDiskFile> = Vec::new();
        let mut files_unchanged = 0usize;

        for entry_res in walker.build() {
            let Ok(entry) = entry_res else {
                continue;
            };
            if entry.path_is_symlink() {
                continue;
            }
            let is_file = entry.file_type().map(|ft| ft.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let Ok((rel_path, abs_path)) = kvxignore.resolve_contained_path(entry.path()) else {
                continue;
            };
            let ext = abs_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !AstParser::is_supported_extension(&ext) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let byte_size = meta.len();
            if byte_size > max_bytes {
                continue;
            }
            let mtime_ms = file_mtime_ms(&meta);
            seen_paths.insert(rel_path.clone());

            if !force {
                if let Some(&(_, old_mtime, old_size, ref old_hash)) = existing_files.get(&rel_path)
                {
                    if old_mtime == mtime_ms && old_size == byte_size {
                        files_unchanged += 1;
                        continue;
                    }
                    to_process.push(CandidateDiskFile {
                        rel_path,
                        abs_path,
                        ext,
                        mtime_ms,
                        byte_size,
                        prev_hash: Some(old_hash.clone()),
                    });
                    continue;
                }
            }

            let prev_hash = existing_files.get(&rel_path).map(|t| t.3.clone());
            to_process.push(CandidateDiskFile {
                rel_path,
                abs_path,
                ext,
                mtime_ms,
                byte_size,
                prev_hash,
            });
        }

        let outcomes: Vec<WorkerOutcome> = to_process
            .into_par_iter()
            .map(|cand| {
                let Ok(bytes) = fs::read(&cand.abs_path) else {
                    return WorkerOutcome::Skipped;
                };
                if KvxIgnore::is_binary_bytes(&bytes) {
                    return WorkerOutcome::Skipped;
                }
                let Ok(source) = String::from_utf8(bytes) else {
                    return WorkerOutcome::Skipped;
                };
                let content_hash = blake3::hash(source.as_bytes()).to_hex().to_string();
                if !force && cand.prev_hash.as_deref() == Some(content_hash.as_str()) {
                    return WorkerOutcome::HashUnchanged {
                        rel_path: cand.rel_path,
                        mtime_ms: cand.mtime_ms,
                        byte_size: cand.byte_size,
                    };
                }
                if KvxIgnore::is_minified_source(&cand.ext, &source) {
                    return WorkerOutcome::Skipped;
                }
                let parser = AstParser::new();
                let parsed = parser.parse_file(&cand.rel_path, &cand.ext, &source);
                WorkerOutcome::Parsed {
                    rel_path: cand.rel_path,
                    ext: cand.ext,
                    mtime_ms: cand.mtime_ms,
                    byte_size: cand.byte_size,
                    content_hash,
                    parsed,
                }
            })
            .collect();

        let now_ms = Utc::now().timestamp_millis();
        let mut files_updated = 0usize;
        let mut files_pruned = 0usize;

        {
            let mut conn = self.conn.lock();
            let tx = conn.transaction()?;

            for (old_path, &(old_file_id, _, _, _)) in &existing_files {
                if !seen_paths.contains(old_path) {
                    snapshot_file_history(&tx, old_file_id, now_ms)?;
                    delete_fts_for_file(&tx, old_file_id)?;
                    tx.execute("DELETE FROM files WHERE id = ?1", params![old_file_id])?;
                    files_pruned += 1;
                }
            }

            for outcome in outcomes {
                match outcome {
                    WorkerOutcome::HashUnchanged {
                        rel_path,
                        mtime_ms,
                        byte_size,
                    } => {
                        tx.execute(
                            "UPDATE files SET mtime_ms = ?1, byte_size = ?2 WHERE path = ?3",
                            params![mtime_ms, byte_size as i64, rel_path],
                        )?;
                        files_unchanged += 1;
                    }
                    WorkerOutcome::Parsed {
                        rel_path,
                        ext,
                        mtime_ms,
                        byte_size,
                        content_hash,
                        parsed,
                    } => {
                        upsert_parsed_file_in_tx(
                            &tx,
                            &UpsertFileInput {
                                rel_path: &rel_path,
                                ext: &ext,
                                mtime_ms,
                                byte_size,
                                content_hash: &content_hash,
                                now_ms,
                                parsed: &parsed,
                            },
                        )?;
                        files_updated += 1;
                    }
                    WorkerOutcome::Skipped => {}
                }
            }

            let edges_resolved =
                if files_updated > 0 || files_pruned > 0 || existing_files.is_empty() {
                    resolve_all_edges_in_tx(&tx)?
                } else {
                    count_table(&tx, "edges WHERE resolved_path IS NOT NULL")?
                };

            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync_ms', ?1)",
                params![now_ms.to_string()],
            )?;
            tx.commit()?;

            let symbols_indexed = count_table(&conn, "symbols")?;
            self.maybe_checkpoint_wal(&conn);

            Ok(SyncSummary {
                files_scanned: seen_paths.len(),
                files_updated,
                files_unchanged,
                files_pruned,
                symbols_indexed,
                edges_resolved,
            })
        }
    }

    /// Re-parses and updates a single repository-relative file after an atomic edit or rename.
    pub fn reindex_file(&self, rel_path: &str) -> VortexResult<()> {
        let kvxignore = self.load_ignore()?;
        let (norm, abs) = kvxignore.resolve_contained_path(Path::new(rel_path))?;
        let now_ms = Utc::now().timestamp_millis();

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        if !abs.is_file() {
            if let Some(fid) = tx
                .query_row(
                    "SELECT id FROM files WHERE path = ?1",
                    params![norm],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
            {
                snapshot_file_history(&tx, fid, now_ms)?;
                delete_fts_for_file(&tx, fid)?;
                tx.execute("DELETE FROM files WHERE id = ?1", params![fid])?;
            }
            resolve_all_edges_in_tx(&tx)?;
            tx.commit()?;
            return Ok(());
        }

        let meta = fs::metadata(&abs)?;
        let mtime_ms = file_mtime_ms(&meta);
        let byte_size = meta.len();
        let source = fs::read_to_string(&abs)?;
        let content_hash = blake3::hash(source.as_bytes()).to_hex().to_string();
        let ext = abs
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let parsed = AstParser::new().parse_file(&norm, &ext, &source);

        upsert_parsed_file_in_tx(
            &tx,
            &UpsertFileInput {
                rel_path: &norm,
                ext: &ext,
                mtime_ms,
                byte_size,
                content_hash: &content_hash,
                now_ms,
                parsed: &parsed,
            },
        )?;
        resolve_all_edges_in_tx(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Searches symbols via FTS5 BM25F with automatic textual fallback and guaranteed non-empty explanation.
    pub fn search(&self, query: &str, limit: usize) -> VortexResult<SearchResponse> {
        let cap = limit.clamp(1, 200);
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(SearchResponse {
                query: query.to_string(),
                via: SearchVia::Nenhum,
                reason: "Search query is empty; provide at least one identifier or keyword."
                    .to_string(),
                total: 0,
                hits: Vec::new(),
            });
        }

        let fts_hits = self.fts_symbol_search(trimmed, cap)?;
        if !fts_hits.is_empty() {
            let total = fts_hits.len();
            return Ok(SearchResponse {
                query: query.to_string(),
                via: SearchVia::Indice,
                reason: format!("Matched {total} symbol(s) in FTS5 BM25F AST index."),
                total,
                hits: fts_hits,
            });
        }

        let (text_hits, files_count) = self.textual_fallback_search(trimmed, cap)?;
        if !text_hits.is_empty() {
            let total = text_hits.len();
            return Ok(SearchResponse {
                query: query.to_string(),
                via: SearchVia::BuscaTextual,
                reason: format!(
                    "No FTS5 declaration matched '{trimmed}'; fell back to textual scan across {files_count} indexed file(s) and found {total} occurrence(s)."
                ),
                total,
                hits: text_hits,
            });
        }

        let reason = if files_count == 0 {
            format!(
                "Shard '{}' currently has 0 indexed files; run sync first or check .kvxignore.",
                self.repo_id
            )
        } else {
            format!(
                "No symbol declarations in FTS5 index and no textual occurrences across {files_count} indexed file(s) matched '{trimmed}'."
            )
        };

        Ok(SearchResponse {
            query: query.to_string(),
            via: SearchVia::Nenhum,
            reason,
            total: 0,
            hits: Vec::new(),
        })
    }

    fn fts_symbol_search(&self, query: &str, limit: usize) -> VortexResult<Vec<SearchHit>> {
        let tokens: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }

        let fts_expr = tokens
            .iter()
            .map(|t| format!("\"{t}\"*"))
            .collect::<Vec<_>>()
            .join(" OR ");

        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT s.file_path, s.name, s.qualified_name, s.kind, s.signature,
                    s.start_line, s.end_line, s.exported,
                    bm25(fts_symbols, 0.0, 2.0, 10.0, 8.0, 4.0, 1.5) AS raw_bm25
             FROM fts_symbols
             JOIN symbols s ON s.id = CAST(fts_symbols.symbol_id AS INTEGER)
             WHERE fts_symbols MATCH ?1
             ORDER BY raw_bm25 ASC
             LIMIT ?2",
        )?;

        let q_lower = query.to_ascii_lowercase();
        let rows = stmt.query_map(params![fts_expr, (limit * 2) as i64], |r| {
            let file_path: String = r.get(0)?;
            let name: String = r.get(1)?;
            let qualified_name: String = r.get(2)?;
            let kind: String = r.get(3)?;
            let signature: String = r.get(4)?;
            let start_line = r.get::<_, i64>(5)?.max(1) as usize;
            let end_line = r.get::<_, i64>(6)?.max(1) as usize;
            let exported = r.get::<_, i64>(7)? != 0;
            let raw_bm25: f64 = r.get(8)?;

            let mut score = (-raw_bm25).max(0.01);
            if name.eq_ignore_ascii_case(&q_lower) || qualified_name.eq_ignore_ascii_case(&q_lower)
            {
                score *= 2.5;
            } else if name.to_ascii_lowercase().starts_with(&q_lower) {
                score *= 1.5;
            }
            if exported {
                score *= 1.2;
            }
            if is_test_path(&file_path) {
                score *= 0.65;
            }

            Ok(SearchHit {
                file_path,
                name,
                qualified_name,
                kind,
                signature,
                start_line,
                end_line,
                exported,
                score,
                snippet: None,
            })
        })?;

        let mut hits = Vec::new();
        for item in rows {
            hits.push(item?);
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit);
        Ok(hits)
    }

    fn textual_fallback_search(
        &self,
        query: &str,
        limit: usize,
    ) -> VortexResult<(Vec<SearchHit>, usize)> {
        let kvxignore = self.load_ignore()?;
        let files: Vec<String> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare("SELECT path FROM files ORDER BY path ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut list = Vec::new();
            for item in rows {
                list.push(item?);
            }
            list
        };
        let total_files = files.len();
        let needle = query.to_ascii_lowercase();
        let mut hits = Vec::new();

        for rel in &files {
            if hits.len() >= limit {
                break;
            }
            let Ok((_, abs)) = kvxignore.resolve_contained_path(Path::new(rel)) else {
                continue;
            };
            let Ok(content) = fs::read_to_string(&abs) else {
                continue;
            };
            for (idx, line_str) in content.lines().enumerate() {
                if line_str.to_ascii_lowercase().contains(&needle) {
                    let line_no = idx + 1;
                    let snippet: String = line_str.trim().chars().take(180).collect();
                    hits.push(SearchHit {
                        file_path: rel.clone(),
                        name: query.to_string(),
                        qualified_name: format!("{rel}:{line_no}"),
                        kind: "text_match".to_string(),
                        signature: snippet.clone(),
                        start_line: line_no,
                        end_line: line_no,
                        exported: false,
                        score: 1.0,
                        snippet: Some(snippet),
                    });
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
        }
        Ok((hits, total_files))
    }

    /// Returns a structured symbol outline for `file_query` filtered by `OutlineScope`.
    pub fn file_outline(
        &self,
        file_query: &str,
        scope: OutlineScope,
    ) -> VortexResult<FileOutlineResponse> {
        let kvxignore = self.load_ignore()?;
        let resolved_path = self.resolve_indexed_file_path(file_query, &kvxignore)?;
        kvxignore.check_not_ignored(Path::new(&resolved_path))?;

        let (indexed_hash, all_syms) = {
            let conn = self.conn.lock();
            let indexed_hash: Option<String> = conn
                .query_row(
                    "SELECT content_hash FROM files WHERE path = ?1",
                    params![resolved_path],
                    |r| r.get(0),
                )
                .optional()?;
            let syms = query_symbols_where(
                &conn,
                "WHERE file_path = ?1 ORDER BY start_line ASC, id ASC",
                params![resolved_path],
            )?;
            (indexed_hash, syms)
        };

        let fresh = self.check_file_fresh(&resolved_path, indexed_hash.as_deref());
        let total_symbols = all_syms.len();
        let filtered: Vec<SymbolRecord> = all_syms
            .into_iter()
            .filter(|s| match scope {
                OutlineScope::Tudo => true,
                OutlineScope::Exportado => s.exported,
                OutlineScope::Topo => !s.qualified_name.contains("::") && !s.qualified_name.contains('.'),
            })
            .collect();

        Ok(FileOutlineResponse {
            file_path: resolved_path,
            scope,
            fresh,
            total_symbols,
            symbols: filtered,
        })
    }

    /// Reads the exact declaration source slice(s) of a symbol by name or `path#QualifiedName`.
    pub fn read_symbol(
        &self,
        symbol_query: &str,
        file_hint: Option<&str>,
    ) -> VortexResult<ReadSymbolResponse> {
        let kvxignore = self.load_ignore()?;
        let (parsed_file_hint, sym_part) = if let Some((fp, sp)) = symbol_query.split_once('#') {
            (Some(fp.trim()), sp.trim())
        } else {
            (file_hint, symbol_query.trim())
        };

        let validated_fh = match parsed_file_hint {
            Some(fh) => {
                let (norm_fh, _) = kvxignore.resolve_contained_path(Path::new(fh))?;
                Some(norm_fh)
            }
            None => None,
        };

        let alt_colon = sym_part.replace('.', "::");
        let alt_dot = sym_part.replace("::", ".");

        let candidates = {
            let conn = self.conn.lock();
            let mut list = query_symbols_where(
                &conn,
                "WHERE name = ?1 OR qualified_name = ?1 OR qualified_name = ?2 OR qualified_name = ?3
                 ORDER BY exported DESC, start_line ASC",
                params![sym_part, alt_colon, alt_dot],
            )?;
            if let Some(ref norm_fh) = validated_fh {
                let slash_suffix = format!("/{norm_fh}");
                list.retain(|s| s.file_path == *norm_fh || s.file_path.ends_with(&slash_suffix));
            }
            list
        };

        if candidates.is_empty() {
            let similar = self
                .fts_symbol_search(sym_part, 5)?
                .into_iter()
                .map(|h| format!("{}#{}", h.file_path, h.qualified_name))
                .collect::<Vec<_>>();
            return Ok(ReadSymbolResponse {
                query: symbol_query.to_string(),
                found: false,
                fresh: true,
                reason: format!("Symbol '{sym_part}' was not found in shard '{}'.", self.repo_id),
                matches: Vec::new(),
                similar_symbols: similar,
            });
        }

        let mut matches = Vec::new();
        let mut all_fresh = true;
        for sym in candidates {
            let Ok((_, abs)) = kvxignore.resolve_contained_path(Path::new(&sym.file_path)) else {
                continue;
            };
            let Ok(full_text) = fs::read_to_string(&abs) else {
                all_fresh = false;
                continue;
            };
            let clean_full = full_text.strip_prefix('\u{feff}').unwrap_or(&full_text);
            let lines: Vec<&str> = clean_full.lines().collect();
            let start = sym.start_line.saturating_sub(1).min(lines.len());
            let end = sym.end_line.min(lines.len()).max(start);
            let slice = lines[start..end].join("\n");
            let live_hash = blake3::hash(slice.as_bytes()).to_hex().to_string();
            if live_hash != sym.body_hash {
                all_fresh = false;
            }
            let tokens = slice.len().div_ceil(4);
            matches.push(ReadSymbolMatch {
                symbol: sym,
                source: slice,
                tokens,
            });
        }

        let found = !matches.is_empty();
        Ok(ReadSymbolResponse {
            query: symbol_query.to_string(),
            found,
            fresh: all_fresh,
            reason: if found {
                format!("Resolved {} declaration(s) for '{sym_part}'.", matches.len())
            } else {
                format!("Declarations for '{sym_part}' could not be read from disk.")
            },
            matches,
            similar_symbols: Vec::new(),
        })
    }

    /// Finds identifier references across the shard with provenance confidence filtering.
    pub fn find_references(
        &self,
        symbol_query: &str,
        file_hint: Option<&str>,
        limit: usize,
        include_name_only: bool,
    ) -> VortexResult<FindReferencesResponse> {
        let cap = limit.clamp(1, 500);
        let (_, clean_q) = symbol_query
            .split_once('#')
            .unwrap_or(("", symbol_query.trim()));
        let bare_name = clean_q
            .rsplit("::")
            .next()
            .and_then(|s| s.rsplit('.').next())
            .unwrap_or(clean_q);

        let conn = self.conn.lock();
        let target_sym = {
            let mut syms = query_symbols_where(
                &conn,
                "WHERE qualified_name = ?1 OR name = ?2 ORDER BY exported DESC LIMIT 10",
                params![clean_q, bare_name],
            )?;
            if let Some(fh) = file_hint {
                syms.retain(|s| s.file_path == fh || s.file_path.ends_with(fh));
            }
            syms.into_iter().next()
        };

        let importers_of_target: HashSet<String> = if let Some(ref tsym) = target_sym {
            let mut stmt =
                conn.prepare("SELECT DISTINCT from_path FROM edges WHERE resolved_path = ?1")?;
            let rows = stmt.query_map(params![tsym.file_path], |r| r.get::<_, String>(0))?;
            let mut set = HashSet::new();
            for item in rows {
                set.insert(item?);
            }
            set
        } else {
            HashSet::new()
        };

        let mut stmt = conn.prepare(
            "SELECT file_path, symbol_name, line, col, in_symbol, confidence, context_line
             FROM refs
             WHERE symbol_name = ?1
             ORDER BY file_path ASC, line ASC, col ASC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![bare_name, (cap * 3) as i64], |r| {
            let file_path: String = r.get(0)?;
            let symbol_name: String = r.get(1)?;
            let line = r.get::<_, i64>(2)?.max(1) as usize;
            let col = r.get::<_, i64>(3)?.max(1) as usize;
            let in_symbol: Option<String> = r.get(4)?;
            let conf_str: String = r.get(5)?;
            let context_line: Option<String> = r.get(6)?;

            let mut confidence = match conf_str.as_str() {
                "same_file" => RefConfidence::SameFile,
                "imported" => RefConfidence::Imported,
                _ => RefConfidence::NameOnly,
            };
            if let Some(ref tsym) = target_sym {
                if file_path == tsym.file_path {
                    confidence = RefConfidence::SameFile;
                } else if importers_of_target.contains(&file_path) {
                    confidence = RefConfidence::Imported;
                }
            }

            Ok(ReferenceRecord {
                file_path,
                symbol_name,
                line,
                col,
                in_symbol,
                confidence,
                context_line,
            })
        })?;

        let mut refs = Vec::new();
        for item in rows {
            let rec = item?;
            if !include_name_only && rec.confidence == RefConfidence::NameOnly {
                continue;
            }
            refs.push(rec);
            if refs.len() >= cap {
                break;
            }
        }

        Ok(FindReferencesResponse {
            query: symbol_query.to_string(),
            target_file: target_sym.as_ref().map(|s| s.file_path.clone()),
            target_qualified_name: target_sym.as_ref().map(|s| s.qualified_name.clone()),
            total: refs.len(),
            references: refs,
        })
    }

    /// Computes incoming callers and outgoing callees around `symbol_name`.
    pub fn call_graph(&self, symbol_name: &str) -> VortexResult<CallGraphResponse> {
        let bare = symbol_name
            .rsplit("::")
            .next()
            .and_then(|s| s.rsplit('.').next())
            .unwrap_or(symbol_name);

        let definitions = {
            let conn = self.conn.lock();
            query_symbols_where(
                &conn,
                "WHERE name = ?1 OR qualified_name = ?2 ORDER BY exported DESC, file_path ASC",
                params![bare, symbol_name],
            )?
        };

        let refs_in = self.find_references(symbol_name, None, 100, false)?;
        let callers: Vec<CallGraphEndpoint> = refs_in
            .references
            .into_iter()
            .map(|r| CallGraphEndpoint {
                file_path: r.file_path.clone(),
                symbol: r.in_symbol.unwrap_or_else(|| "<module>".to_string()),
                line: r.line,
                confidence: r.confidence,
            })
            .collect();

        let mut callees = Vec::new();
        if !definitions.is_empty() {
            let conn = self.conn.lock();
            let all_declared: HashSet<String> = {
                let mut stmt = conn.prepare("SELECT DISTINCT name FROM symbols")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut s = HashSet::new();
                for item in rows {
                    s.insert(item?);
                }
                s
            };

            let mut stmt = conn.prepare(
                "SELECT file_path, symbol_name, line, confidence
                 FROM refs
                 WHERE file_path = ?1 AND line >= ?2 AND line <= ?3
                 ORDER BY line ASC",
            )?;
            for def in &definitions {
                let rows = stmt.query_map(
                    params![def.file_path, def.start_line as i64, def.end_line as i64],
                    |r| {
                        let fp: String = r.get(0)?;
                        let sn: String = r.get(1)?;
                        let ln = r.get::<_, i64>(2)?.max(1) as usize;
                        let cf: String = r.get(3)?;
                        let confidence = match cf.as_str() {
                            "same_file" => RefConfidence::SameFile,
                            "imported" => RefConfidence::Imported,
                            _ => RefConfidence::NameOnly,
                        };
                        Ok((fp, sn, ln, confidence))
                    },
                )?;
                for item in rows {
                    let (fp, sn, ln, confidence) = item?;
                    if sn != def.name && all_declared.contains(&sn) {
                        callees.push(CallGraphEndpoint {
                            file_path: fp,
                            symbol: sn,
                            line: ln,
                            confidence,
                        });
                    }
                }
            }
        }
        callees.dedup_by(|a, b| a.file_path == b.file_path && a.symbol == b.symbol && a.line == b.line);

        Ok(CallGraphResponse {
            symbol: symbol_name.to_string(),
            definitions,
            callers,
            callees,
        })
    }

    /// Pins a symbol contract lock (`Frozen` or `AllowBodyOnly`) inside `symbol_locks`.
    pub fn lock_symbol(
        &self,
        symbol_query: &str,
        file_hint: Option<&str>,
        mode: LockMode,
        owner: &str,
        reason: &str,
    ) -> VortexResult<SymbolLock> {
        let read = self.read_symbol(symbol_query, file_hint)?;
        if read.matches.is_empty() {
            return Err(VortexError::SymbolNotFound(symbol_query.to_string()));
        }
        if read.matches.len() > 1 {
            return Err(VortexError::AmbiguousSymbol {
                symbol: symbol_query.to_string(),
                candidates: read
                    .matches
                    .iter()
                    .map(|m| format!("{}#{}", m.symbol.file_path, m.symbol.qualified_name))
                    .collect(),
            });
        }
        let sym = &read.matches[0].symbol;
        let lock = SymbolLock {
            id: uuid::Uuid::new_v4().to_string(),
            file_path: sym.file_path.clone(),
            qualified_name: sym.qualified_name.clone(),
            mode,
            sig_hash: sym.sig_hash.clone(),
            body_hash: sym.body_hash.clone(),
            owner: owner.to_string(),
            reason: reason.to_string(),
            created_at_ms: Utc::now().timestamp_millis(),
        };
        let mode_str = match mode {
            LockMode::Frozen => "frozen",
            LockMode::AllowBodyOnly => "allow_body_only",
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO symbol_locks
             (id, file_path, qualified_name, mode, sig_hash, body_hash, owner, reason, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                lock.id,
                lock.file_path,
                lock.qualified_name,
                mode_str,
                lock.sig_hash,
                lock.body_hash,
                lock.owner,
                lock.reason,
                lock.created_at_ms
            ],
        )?;
        Ok(lock)
    }

    /// Removes a symbol contract lock by lock ID or `qualified_name`.
    pub fn unlock_symbol(&self, id_or_symbol: &str) -> VortexResult<usize> {
        let conn = self.conn.lock();
        let affected = conn.execute(
            "DELETE FROM symbol_locks WHERE id = ?1 OR qualified_name = ?1",
            params![id_or_symbol],
        )?;
        Ok(affected)
    }

    /// Lists all active `SymbolLock` records in the shard.
    pub fn list_locks(&self) -> VortexResult<Vec<SymbolLock>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, qualified_name, mode, sig_hash, body_hash, owner, reason, created_at_ms
             FROM symbol_locks ORDER BY file_path ASC, qualified_name ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let mode_raw: String = r.get(3)?;
            let mode = if mode_raw == "allow_body_only" {
                LockMode::AllowBodyOnly
            } else {
                LockMode::Frozen
            };
            Ok(SymbolLock {
                id: r.get(0)?,
                file_path: r.get(1)?,
                qualified_name: r.get(2)?,
                mode,
                sig_hash: r.get(4)?,
                body_hash: r.get(5)?,
                owner: r.get(6)?,
                reason: r.get(7)?,
                created_at_ms: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Runs `AstParser::scan_slop` in parallel across all indexed repository files.
    pub fn scan_slop(&self) -> VortexResult<Vec<SlopFinding>> {
        let kvxignore = self.load_ignore()?;
        let files = self.all_files()?;
        let mut findings: Vec<SlopFinding> = files
            .into_par_iter()
            .flat_map(|(rel, ext)| {
                let Ok((_, abs)) = kvxignore.resolve_contained_path(Path::new(&rel)) else {
                    return Vec::new();
                };
                let Ok(src) = fs::read_to_string(&abs) else {
                    return Vec::new();
                };
                AstParser::scan_slop(&rel, &ext, &src)
            })
            .collect();
        findings.sort_by(|a, b| (&a.file_path, a.line, a.col).cmp(&(&b.file_path, b.line, b.col)));
        Ok(findings)
    }

    /// Returns `(path, ext)` for every indexed file in deterministic order.
    pub fn all_files(&self) -> VortexResult<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path, ext FROM files ORDER BY path ASC")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Returns all indexed `SymbolRecord`s ordered by `(file_path, start_line)`.
    pub fn all_symbols(&self) -> VortexResult<Vec<SymbolRecord>> {
        let conn = self.conn.lock();
        query_symbols_where(&conn, "ORDER BY file_path ASC, start_line ASC, id ASC", [])
    }

    /// Returns all `EdgeRecord`s (both resolved and unresolved) stored in this shard.
    pub fn all_edges(&self) -> VortexResult<Vec<EdgeRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT from_path, raw_target, resolved_path, kind, symbol_name, weight, line
             FROM edges ORDER BY from_path ASC, line ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(EdgeRecord {
                from_path: r.get(0)?,
                raw_target: r.get(1)?,
                resolved_path: r.get(2)?,
                kind: r.get(3)?,
                symbol_name: r.get(4)?,
                weight: r.get::<_, f64>(5)? as f32,
                line: r.get::<_, i64>(6)?.max(1) as usize,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Returns all extracted HTTP/RPC `RouteRecord`s stored in this shard.
    pub fn all_routes(&self) -> VortexResult<Vec<RouteRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT file_path, direction, method, route_path, handler_name, line
             FROM routes ORDER BY file_path ASC, line ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RouteRecord {
                file_path: r.get(0)?,
                direction: r.get(1)?,
                method: r.get(2)?,
                route_path: r.get(3)?,
                handler_name: r.get(4)?,
                line: r.get::<_, i64>(5)?.max(1) as usize,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Replaces Git co-change pairs mined by `graph::mine_git_cochange`.
    pub fn replace_cochange_pairs(
        &self,
        pairs: &[(String, String, usize, f64)],
    ) -> VortexResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM cochange_pairs", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO cochange_pairs (file_a, file_b, co_commits, confidence)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (a, b, commits, conf) in pairs {
                stmt.execute(params![a, b, *commits as i64, *conf])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Queries top co-changed files coupled to `target_files`.
    pub fn cochange_for_files(&self, target_files: &[String]) -> VortexResult<Vec<CoChangedFile>> {
        if target_files.is_empty() {
            return Ok(Vec::new());
        }
        let target_set: HashSet<&str> = target_files.iter().map(String::as_str).collect();
        let conn = self.conn.lock();
        let mut agg: BTreeMap<String, (usize, f64)> = BTreeMap::new();
        let mut stmt = conn.prepare(
            "SELECT file_a, file_b, co_commits, confidence
             FROM cochange_pairs
             WHERE file_a = ?1 OR file_b = ?1",
        )?;
        for tf in target_files {
            let rows = stmt.query_map(params![tf], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?.max(0) as usize,
                    r.get::<_, f64>(3)?,
                ))
            })?;
            for item in rows {
                let (a, b, commits, conf) = item?;
                let other = if a == *tf { b } else { a };
                if target_set.contains(other.as_str()) {
                    continue;
                }
                let entry = agg.entry(other).or_insert((0, 0.0));
                entry.0 = entry.0.max(commits);
                entry.1 = entry.1.max(conf);
            }
        }
        let mut list: Vec<CoChangedFile> = agg
            .into_iter()
            .map(|(file_path, (co_commits, confidence))| CoChangedFile {
                file_path,
                co_commits,
                confidence,
            })
            .collect();
        list.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.co_commits.cmp(&a.co_commits))
        });
        list.truncate(25);
        Ok(list)
    }

    /// Reads historical exported symbol snapshots recorded for `file_path`.
    pub fn symbol_history_for_file(
        &self,
        file_path: &str,
    ) -> VortexResult<Vec<HistoricalSymbolRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT file_path, qualified_name, exported, signature, sig_hash, body_hash
             FROM symbol_history WHERE file_path = ?1",
        )?;
        let rows = stmt.query_map(params![file_path], |r| {
            Ok(HistoricalSymbolRow {
                file_path: r.get(0)?,
                qualified_name: r.get(1)?,
                exported: r.get::<_, i64>(2)? != 0,
                signature: r.get(3)?,
                sig_hash: r.get(4)?,
                body_hash: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Saves a `ContextPack` ETag snapshot (`key -> body_hash`) for `delta_from` diffing.
    pub fn save_pack_snapshot(
        &self,
        etag: &str,
        symbol_hashes: &BTreeMap<String, String>,
    ) -> VortexResult<()> {
        let json = serde_json::to_string(symbol_hashes)?;
        let now_ms = Utc::now().timestamp_millis();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO pack_snapshots (etag, created_at_ms, symbol_hashes_json)
             VALUES (?1, ?2, ?3)",
            params![etag, now_ms, json],
        )?;
        conn.execute(
            "DELETE FROM pack_snapshots WHERE etag NOT IN (
                SELECT etag FROM pack_snapshots ORDER BY created_at_ms DESC LIMIT 64
             )",
            [],
        )?;
        Ok(())
    }

    /// Loads a previously persisted `ContextPack` ETag snapshot.
    pub fn load_pack_snapshot(
        &self,
        etag: &str,
    ) -> VortexResult<Option<BTreeMap<String, String>>> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT symbol_hashes_json FROM pack_snapshots WHERE etag = ?1",
                params![etag],
                |r| r.get(0),
            )
            .optional()?;
        match raw {
            Some(s) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// Computes live diagnostic metrics for this shard.
    pub fn health(&self) -> VortexResult<ShardHealth> {
        let conn = self.conn.lock();
        let files_indexed = count_table(&conn, "files")?;
        let symbols_indexed = count_table(&conn, "symbols")?;
        let edges_indexed = count_table(&conn, "edges")?;
        let resolved_edges_indexed = count_table(&conn, "edges WHERE resolved_path IS NOT NULL")?;
        let refs_indexed = count_table(&conn, "refs")?;
        let routes_indexed = count_table(&conn, "routes")?;
        let cochange_pairs = count_table(&conn, "cochange_pairs")?;
        let active_locks = count_table(&conn, "symbol_locks")?;
        let last_sync_ms = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'last_sync_ms'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);

        let db_bytes = fs::metadata(&self.db_path).map(|m| m.len()).unwrap_or(0);
        let wal_path = PathBuf::from(format!("{}-wal", self.db_path.to_string_lossy()));
        let wal_bytes = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

        Ok(ShardHealth {
            repo_id: self.repo_id.clone(),
            repo_root: self.repo_root.to_string_lossy().to_string(),
            db_path: self.db_path.to_string_lossy().to_string(),
            schema_version: SHARD_SCHEMA_VERSION,
            files_indexed,
            symbols_indexed,
            edges_indexed,
            resolved_edges_indexed,
            refs_indexed,
            routes_indexed,
            cochange_pairs,
            active_locks,
            wal_bytes,
            db_bytes,
            last_sync_ms,
            healthy: self.repo_root.is_dir(),
        })
    }

    /// Resolves a user-supplied file query (exact relative path or unique suffix) to an indexed path.
    pub fn resolve_indexed_file_path(
        &self,
        file_query: &str,
        kvxignore: &KvxIgnore,
    ) -> VortexResult<String> {
        let norm = kvxignore.validate_safe_rel_path(Path::new(file_query))?;
        kvxignore.check_not_ignored(Path::new(&norm))?;
        kvxignore.verify_containment(&norm)?;
        let conn = self.conn.lock();
        if conn
            .query_row(
                "SELECT 1 FROM files WHERE path = ?1",
                params![norm],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Ok(norm);
        }
        let suffix_pat = format!("%/{norm}");
        let mut stmt = conn.prepare(
            "SELECT path FROM files WHERE path = ?1 OR path LIKE ?2 ORDER BY LENGTH(path) ASC LIMIT 5",
        )?;
        let rows = stmt.query_map(params![norm, suffix_pat], |r| r.get::<_, String>(0))?;
        let mut matches = Vec::new();
        for item in rows {
            matches.push(item?);
        }
        match matches.len() {
            1 => {
                let matched = matches.remove(0);
                let (safe_matched, _) = kvxignore.resolve_contained_path(Path::new(&matched))?;
                Ok(safe_matched)
            }
            0 => Err(VortexError::SymbolNotFound(format!(
                "File '{file_query}' is not indexed in shard '{}'",
                self.repo_id
            ))),
            _ => Err(VortexError::AmbiguousSymbol {
                symbol: file_query.to_string(),
                candidates: matches,
            }),
        }
    }

    fn check_file_fresh(&self, rel_path: &str, indexed_hash: Option<&str>) -> bool {
        let Some(expected) = indexed_hash else {
            return false;
        };
        let Ok(kvxignore) = self.load_ignore() else {
            return false;
        };
        let Ok((_, abs)) = kvxignore.resolve_contained_path(Path::new(rel_path)) else {
            return false;
        };
        let Ok(bytes) = fs::read(&abs) else {
            return false;
        };
        let live = blake3::hash(&bytes).to_hex();
        live.as_str() == expected
    }

    fn maybe_checkpoint_wal(&self, conn: &Connection) {
        let wal_path = PathBuf::from(format!("{}-wal", self.db_path.to_string_lossy()));
        let wal_len = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        if wal_len > 16 * 1024 * 1024 {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        }
    }
}

fn file_mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn count_table(conn: &Connection, table_clause: &str) -> VortexResult<usize> {
    let sql = format!("SELECT COUNT(*) FROM {table_clause}");
    let c: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
    Ok(c.max(0) as usize)
}

fn snapshot_file_history(conn: &Connection, file_id: i64, now_ms: i64) -> VortexResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO symbol_history
         (file_path, qualified_name, exported, signature, sig_hash, body_hash, recorded_at_ms)
         SELECT file_path, qualified_name, exported, signature, sig_hash, body_hash, ?2
         FROM symbols
         WHERE file_id = ?1 AND exported != 0",
        params![file_id, now_ms],
    )?;
    Ok(())
}

fn delete_fts_for_file(conn: &Connection, file_id: i64) -> VortexResult<()> {
    conn.execute(
        "DELETE FROM fts_symbols WHERE CAST(symbol_id AS INTEGER) IN (
            SELECT id FROM symbols WHERE file_id = ?1
         )",
        params![file_id],
    )?;
    Ok(())
}

struct UpsertFileInput<'a> {
    rel_path: &'a str,
    ext: &'a str,
    mtime_ms: i64,
    byte_size: u64,
    content_hash: &'a str,
    now_ms: i64,
    parsed: &'a ParsedFile,
}

fn upsert_parsed_file_in_tx(conn: &Connection, input: &UpsertFileInput<'_>) -> VortexResult<()> {
    let rel_path = input.rel_path;
    let ext = input.ext;
    let mtime_ms = input.mtime_ms;
    let byte_size = input.byte_size;
    let content_hash = input.content_hash;
    let now_ms = input.now_ms;
    let parsed = input.parsed;

    let existing_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM files WHERE path = ?1",
            params![rel_path],
            |r| r.get(0),
        )
        .optional()?;

    let file_id = if let Some(fid) = existing_id {
        snapshot_file_history(conn, fid, now_ms)?;
        delete_fts_for_file(conn, fid)?;
        conn.execute("DELETE FROM symbols WHERE file_id = ?1", params![fid])?;
        conn.execute("DELETE FROM edges WHERE file_id = ?1", params![fid])?;
        conn.execute("DELETE FROM refs WHERE file_id = ?1", params![fid])?;
        conn.execute("DELETE FROM routes WHERE file_id = ?1", params![fid])?;
        conn.execute(
            "UPDATE files SET ext = ?1, mtime_ms = ?2, byte_size = ?3, content_hash = ?4, indexed_at_ms = ?5
             WHERE id = ?6",
            params![ext, mtime_ms, byte_size as i64, content_hash, now_ms, fid],
        )?;
        fid
    } else {
        conn.execute(
            "INSERT INTO files (path, ext, mtime_ms, byte_size, content_hash, indexed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![rel_path, ext, mtime_ms, byte_size as i64, content_hash, now_ms],
        )?;
        conn.last_insert_rowid()
    };

    {
        let mut sym_stmt = conn.prepare_cached(
            "INSERT INTO symbols
             (file_id, file_path, name, qualified_name, kind, signature, start_line, end_line,
              exported, complexity, sig_hash, body_hash, docstring)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        let mut fts_stmt = conn.prepare_cached(
            "INSERT INTO fts_symbols (symbol_id, file_path, name, qualified_name, signature, docstring)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;

        for s in &parsed.symbols {
            sym_stmt.execute(params![
                file_id,
                rel_path,
                s.name,
                s.qualified_name,
                s.kind,
                s.signature,
                s.start_line as i64,
                s.end_line as i64,
                i64::from(s.exported),
                s.complexity as i64,
                s.sig_hash,
                s.body_hash,
                s.docstring
            ])?;
            let sym_id = conn.last_insert_rowid();
            fts_stmt.execute(params![
                sym_id.to_string(),
                rel_path,
                s.name,
                s.qualified_name,
                s.signature,
                s.docstring.as_deref().unwrap_or("")
            ])?;
        }
    }

    {
        let mut edge_stmt = conn.prepare_cached(
            "INSERT INTO edges (file_id, from_path, raw_target, resolved_path, kind, symbol_name, weight, line)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)",
        )?;
        for e in &parsed.edges {
            edge_stmt.execute(params![
                file_id,
                rel_path,
                e.raw_target,
                e.kind,
                e.symbol_name,
                f64::from(e.weight),
                e.line as i64
            ])?;
        }
    }

    {
        let mut ref_stmt = conn.prepare_cached(
            "INSERT INTO refs (file_id, file_path, symbol_name, line, col, in_symbol, confidence, context_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for r in &parsed.references {
            let conf = match r.confidence {
                RefConfidence::SameFile => "same_file",
                RefConfidence::Imported => "imported",
                RefConfidence::NameOnly => "name_only",
            };
            ref_stmt.execute(params![
                file_id,
                rel_path,
                r.symbol_name,
                r.line as i64,
                r.col as i64,
                r.in_symbol,
                conf,
                r.context_line
            ])?;
        }
    }

    {
        let mut route_stmt = conn.prepare_cached(
            "INSERT INTO routes (file_id, file_path, direction, method, route_path, handler_name, line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for rt in &parsed.routes {
            route_stmt.execute(params![
                file_id,
                rel_path,
                rt.direction,
                rt.method,
                rt.route_path,
                rt.handler_name,
                rt.line as i64
            ])?;
        }
    }

    Ok(())
}

fn resolve_all_edges_in_tx(conn: &Connection) -> VortexResult<usize> {
    let all_paths: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT path FROM files")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for item in rows {
            set.insert(item?);
        }
        set
    };

    let sql_tables: HashMap<String, String> = {
        let mut stmt =
            conn.prepare("SELECT name, file_path FROM symbols WHERE kind = 'table'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = HashMap::new();
        for item in rows {
            let (tbl, fp) = item?;
            map.insert(tbl.to_ascii_lowercase(), fp);
        }
        map
    };

    let raw_edges: Vec<(i64, String, String, String)> = {
        let mut stmt = conn.prepare("SELECT id, from_path, raw_target, kind FROM edges")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut list = Vec::new();
        for item in rows {
            list.push(item?);
        }
        list
    };

    let mut upd = conn.prepare_cached("UPDATE edges SET resolved_path = ?1 WHERE id = ?2")?;
    let mut resolved_count = 0usize;
    for (edge_id, from_path, raw_target, kind) in raw_edges {
        let resolved = if kind == "sql_ref" {
            sql_tables
                .get(&raw_target.to_ascii_lowercase())
                .cloned()
        } else {
            resolve_import_target(&from_path, &raw_target, &all_paths)
        };
        if resolved.is_some() && resolved.as_deref() != Some(from_path.as_str()) {
            resolved_count += 1;
            upd.execute(params![resolved, edge_id])?;
        } else {
            upd.execute(params![Option::<String>::None, edge_id])?;
        }
    }
    Ok(resolved_count)
}

fn resolve_import_target(
    from_path: &str,
    raw_target: &str,
    all_paths: &HashSet<String>,
) -> Option<String> {
    let from_dir = Path::new(from_path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    if let Some(mod_name) = raw_target.strip_prefix("mod::") {
        let stem = Path::new(from_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let base_dir = if stem == "lib" || stem == "main" || stem == "mod" {
            from_dir.clone()
        } else if from_dir.is_empty() {
            stem.to_string()
        } else {
            format!("{from_dir}/{stem}")
        };
        let c1 = join_clean(&base_dir, &format!("{mod_name}.rs"));
        if all_paths.contains(&c1) {
            return Some(c1);
        }
        let c2 = join_clean(&base_dir, &format!("{mod_name}/mod.rs"));
        if all_paths.contains(&c2) {
            return Some(c2);
        }
    }

    if raw_target.starts_with("crate::")
        || raw_target.starts_with("self::")
        || raw_target.starts_with("super::")
    {
        let crate_src_root = find_rust_src_root(from_path);
        let cleaned = raw_target.split('{').next().unwrap_or(raw_target).trim_end_matches("::");
        let segs: Vec<&str> = cleaned.split("::").collect();
        let base = if segs.first() == Some(&"crate") {
            crate_src_root
        } else if segs.first() == Some(&"super") {
            Path::new(&from_dir)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
        } else {
            from_dir.clone()
        };
        for take_n in (1..segs.len()).rev() {
            let rel_segs = segs[1..=take_n].join("/");
            let c1 = join_clean(&base, &format!("{rel_segs}.rs"));
            if all_paths.contains(&c1) {
                return Some(c1);
            }
            let c2 = join_clean(&base, &format!("{rel_segs}/mod.rs"));
            if all_paths.contains(&c2) {
                return Some(c2);
            }
        }
    }

    if from_path.ends_with(".rs")
        && !raw_target.starts_with("mod::")
        && !raw_target.starts_with("crate::")
        && !raw_target.starts_with("self::")
        && !raw_target.starts_with("super::")
        && !raw_target.starts_with('.')
        && !raw_target.starts_with('/')
    {
        let trimmed_rs = raw_target.trim().trim_start_matches("::");
        let head = trimmed_rs
            .split(['{', ' ', ';'])
            .next()
            .unwrap_or(trimmed_rs)
            .trim_end_matches("::");
        let segs: Vec<&str> = head.split("::").filter(|s| !s.is_empty()).collect();
        if let Some(&crate_ident) = segs.first() {
            if !matches!(
                crate_ident,
                "std" | "core" | "alloc" | "proc_macro" | "test"
            ) {
                let hyphen_name = crate_ident.replace('_', "-");
                let under_name = crate_ident.replace('-', "_");
                let crate_dirs = [
                    format!("crates/{hyphen_name}/src"),
                    format!("crates/{under_name}/src"),
                    format!("{hyphen_name}/src"),
                    format!("{under_name}/src"),
                ];

                for take_n in (1..segs.len()).rev() {
                    let rel_segs = segs[1..=take_n].join("/");
                    for cdir in &crate_dirs {
                        let c1 = join_clean(cdir, &format!("{rel_segs}.rs"));
                        if all_paths.contains(&c1) && c1 != from_path {
                            return Some(c1);
                        }
                        let c2 = join_clean(cdir, &format!("{rel_segs}/mod.rs"));
                        if all_paths.contains(&c2) && c2 != from_path {
                            return Some(c2);
                        }
                    }
                }

                for cdir in &crate_dirs {
                    let lib_candidate = format!("{cdir}/lib.rs");
                    if all_paths.contains(&lib_candidate) && lib_candidate != from_path {
                        return Some(lib_candidate);
                    }
                    let main_candidate = format!("{cdir}/main.rs");
                    if all_paths.contains(&main_candidate) && main_candidate != from_path {
                        return Some(main_candidate);
                    }
                }
            }
        }
    }

    if raw_target.starts_with("./")
        || raw_target.starts_with("../")
        || raw_target.starts_with('/')
        || raw_target.ends_with(".md")
        || raw_target.ends_with(".h")
    {
        let joined = if let Some(stripped) = raw_target.strip_prefix('/') {
            stripped.to_string()
        } else {
            join_clean(&from_dir, raw_target)
        };
        if let Some(hit) = probe_extensions(&joined, all_paths) {
            return Some(hit);
        }
        if raw_target.ends_with(".h") {
            if all_paths.contains(raw_target) {
                return Some(raw_target.to_string());
            }
            let inc_cand = format!("include/{raw_target}");
            if all_paths.contains(&inc_cand) {
                return Some(inc_cand);
            }
        }
        if let Some(js_stripped) = joined
            .strip_suffix(".js")
            .or_else(|| joined.strip_suffix(".mjs"))
        {
            if let Some(hit) = probe_extensions(js_stripped, all_paths) {
                return Some(hit);
            }
        }
    }

    if !raw_target.contains('/') && raw_target.contains('.') {
        let py_rel = raw_target.trim_start_matches('.').replace('.', "/");
        if let Some(hit) = probe_extensions(&py_rel, all_paths) {
            return Some(hit);
        }
        let src_py = format!("src/{py_rel}");
        if let Some(hit) = probe_extensions(&src_py, all_paths) {
            return Some(hit);
        }
        let java_rel = format!("src/main/java/{py_rel}");
        if let Some(hit) = probe_extensions(&java_rel, all_paths) {
            return Some(hit);
        }
    }

    if raw_target.contains('/') {
        if let Some(hit) = probe_extensions(raw_target, all_paths) {
            return Some(hit);
        }
    }

    None
}

fn find_rust_src_root(from_path: &str) -> String {
    if let Some(idx) = from_path.rfind("/src/") {
        return format!("{}/src", &from_path[..idx]);
    }
    if from_path.starts_with("src/") {
        return "src".to_string();
    }
    String::new()
}

fn join_clean(base: &str, rel: &str) -> String {
    let combined = if base.is_empty() {
        rel.to_string()
    } else {
        format!("{base}/{rel}")
    };
    let mut stack: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

fn probe_extensions(candidate_stem: &str, all_paths: &HashSet<String>) -> Option<String> {
    if all_paths.contains(candidate_stem) {
        return Some(candidate_stem.to_string());
    }
    for suffix in [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".rs",
        ".py",
        ".go",
        ".sh",
        ".h",
        ".hpp",
        ".c",
        ".cpp",
        ".java",
        ".md",
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/mod.rs",
        "/__init__.py",
    ] {
        let trial = format!("{candidate_stem}{suffix}");
        if all_paths.contains(&trial) {
            return Some(trial);
        }
    }
    None
}

fn query_symbols_where<P: rusqlite::Params>(
    conn: &Connection,
    where_and_order: &str,
    params: P,
) -> VortexResult<Vec<SymbolRecord>> {
    let sql = format!(
        "SELECT id, file_path, name, qualified_name, kind, signature,
                start_line, end_line, exported, complexity, sig_hash, body_hash, docstring
         FROM symbols {where_and_order}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok(SymbolRecord {
            id: Some(r.get(0)?),
            file_path: r.get(1)?,
            name: r.get(2)?,
            qualified_name: r.get(3)?,
            kind: r.get(4)?,
            signature: r.get(5)?,
            start_line: r.get::<_, i64>(6)?.max(1) as usize,
            end_line: r.get::<_, i64>(7)?.max(1) as usize,
            exported: r.get::<_, i64>(8)? != 0,
            complexity: r.get::<_, i64>(9)?.max(1) as usize,
            sig_hash: r.get(10)?,
            body_hash: r.get(11)?,
            docstring: r.get(12)?,
        })
    })?;
    let mut out = Vec::new();
    for item in rows {
        out.push(item?);
    }
    Ok(out)
}

/// Heuristic test file detector shared across ranking and blast-radius routines.
pub fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("tests/")
        || lower.starts_with("test/")
        || lower.contains("/tests/")
        || lower.contains("/__tests__/")
        || lower.ends_with(".test.ts")
        || lower.ends_with(".test.tsx")
        || lower.ends_with(".spec.ts")
        || lower.ends_with(".test.js")
        || lower.ends_with("_test.go")
        || lower.ends_with("_test.rs")
        || lower.ends_with("_tests.rs")
        || (lower.ends_with(".py")
            && Path::new(&lower)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("test_") || n.ends_with("_test.py"))
                .unwrap_or(false))
}
