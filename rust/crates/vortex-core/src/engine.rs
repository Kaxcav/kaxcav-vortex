//! Thread-safe `VortexEngine` orchestrating multi-repo `VortexShard`s, `SubmodularPacker`,
//! `FailureSlicer`, `SymbolEditor`, `TwoPhaseRenamer`, `MultiRepoFederator`, `DlpScanner`,
//! `DriveNexusVault`, and persistent SQLite telemetry.
//!
//! Traceability: `@REQ-VORTEX-001`..`@REQ-VORTEX-005`.

use crate::dlp::DlpScanner;
use crate::editor::{SymbolEditor, TwoPhaseRenamer};
use crate::federation::MultiRepoFederator;
use crate::graph::{self, CsrGraph};
use crate::nexus::DriveNexusVault;
use crate::packer::SubmodularPacker;
use crate::parser::AstParser;
use crate::slicer::FailureSlicer;
use crate::storage::{SyncSummary, VortexShard};
use crate::types::{
    ArchBoundaryRule, ArchViolation, BlastRadiusReport, CallGraphResponse, ContextPack,
    ContextRequest, DiffImpactReport, DlpFinding, EditSymbolRequest, EditSymbolResult,
    FailureSliceResult, FederationLink, FileOutlineResponse, FindReferencesResponse, LockMode,
    OutlineScope, ReadSymbolResponse, RenameSymbolRequest, RenameSymbolResult, RepoMapResponse,
    SearchResponse, ShardHealth, SlopFinding, SymbolLock, TarjanReport, VortexError, VortexResult,
    VortexStatus,
};
use crate::KAXCAV_VORTEX_VERSION;
use chrono::Utc;
use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalJsonConfig {
    #[serde(default)]
    repos: Vec<String>,
}

/// Primary thread-safe (`Send + Sync`) facade for the Kaxcav Vortex native Rust engine.
pub struct VortexEngine {
    storage_root: PathBuf,
    shards: DashMap<String, Arc<VortexShard>>,
    default_repo_id: RwLock<Option<String>>,
    federation_cache: RwLock<Vec<FederationLink>>,
    telemetry_conn: Mutex<Connection>,
    packer: SubmodularPacker,
    nexus: Arc<DriveNexusVault>,
}

impl std::fmt::Debug for VortexEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VortexEngine")
            .field("storage_root", &self.storage_root)
            .field("shard_count", &self.shards.len())
            .finish()
    }
}

impl VortexEngine {
    /// Initializes a `VortexEngine` storing shards, telemetry, and Nexus twins under `storage_root`
    /// (defaults to `$KVX_STORAGE_ROOT` or `~/.kvx` if `None`).
    pub fn new(storage_root: Option<PathBuf>) -> VortexResult<Self> {
        let root = match storage_root {
            Some(p) => p,
            None => default_storage_root(),
        };
        fs::create_dir_all(root.join("shards"))?;
        let telemetry_path = root.join("telemetry.sqlite");
        let tconn = Connection::open(&telemetry_path)?;
        tconn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 15000;
             CREATE TABLE IF NOT EXISTS registered_repos (
                 repo_id TEXT PRIMARY KEY,
                 repo_root TEXT NOT NULL,
                 added_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS telemetry_events (
                 id INTEGER PRIMARY KEY,
                 tool_name TEXT NOT NULL,
                 repo_id TEXT,
                 tokens_saved INTEGER NOT NULL DEFAULT 0,
                 created_at_ms INTEGER NOT NULL
             );",
        )?;

        let nexus = Arc::new(DriveNexusVault::open(&root.join("nexus"))?);

        let engine = Self {
            storage_root: root,
            shards: DashMap::new(),
            default_repo_id: RwLock::new(None),
            federation_cache: RwLock::new(Vec::new()),
            telemetry_conn: Mutex::new(tconn),
            packer: SubmodularPacker::new(),
            nexus,
        };
        engine.restore_registered_repos()?;
        Ok(engine)
    }

    /// Convenience constructor opening `VortexEngine` directly on a single `repo_root` with custom `storage_root`.
    pub fn for_repo(repo_root: &Path, storage_root: &Path) -> VortexResult<Self> {
        let engine = Self::new(Some(storage_root.to_path_buf()))?;
        engine.add_repo(None, repo_root, true)?;
        Ok(engine)
    }

    /// Root directory containing `shards/`, `nexus/`, and `telemetry.sqlite`.
    pub fn storage_root(&self) -> &Path {
        &self.storage_root
    }

    /// Returns a shared handle to the `DriveNexusVault` subsystem.
    pub fn nexus(&self) -> &DriveNexusVault {
        &self.nexus
    }

    /// Registers a repository root, opens its SQLite WAL shard, and optionally runs an initial `sync`.
    pub fn add_repo(
        &self,
        explicit_id: Option<&str>,
        repo_root: &Path,
        sync_now: bool,
    ) -> VortexResult<Arc<VortexShard>> {
        if !repo_root.is_dir() {
            return Err(VortexError::RepoNotFound(
                repo_root.to_string_lossy().to_string(),
            ));
        }
        let canonical = repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.to_path_buf());
        let repo_id = explicit_id
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| derive_repo_id(&canonical));

        let shard_hash = &blake3::hash(canonical.to_string_lossy().as_bytes()).to_hex()[..12];
        let db_path = self
            .storage_root
            .join("shards")
            .join(format!("{repo_id}-{shard_hash}.sqlite"));

        let shard = Arc::new(VortexShard::open(&repo_id, &canonical, &db_path)?);
        if sync_now {
            shard.sync(false)?;
        }

        self.shards.insert(repo_id.clone(), Arc::clone(&shard));
        {
            let mut def = self.default_repo_id.write();
            if def.is_none() {
                *def = Some(repo_id.clone());
            }
        }
        {
            let conn = self.telemetry_conn.lock();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO registered_repos (repo_id, repo_root, added_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![
                    repo_id,
                    canonical.to_string_lossy().to_string(),
                    Utc::now().timestamp_millis()
                ],
            );
        }
        Ok(shard)
    }

    /// Unregisters a repository shard from memory and persistent registry.
    pub fn remove_repo(&self, repo_id: &str) -> VortexResult<bool> {
        let removed = self.shards.remove(repo_id).is_some();
        {
            let mut def = self.default_repo_id.write();
            if def.as_deref() == Some(repo_id) {
                *def = self.shards.iter().next().map(|e| e.key().clone());
            }
        }
        let conn = self.telemetry_conn.lock();
        conn.execute(
            "DELETE FROM registered_repos WHERE repo_id = ?1",
            params![repo_id],
        )?;
        Ok(removed)
    }

    /// Lists all active `(repo_id, repo_root)` pairs.
    pub fn list_repos(&self) -> Vec<(String, PathBuf)> {
        let mut out: Vec<(String, PathBuf)> = self
            .shards
            .iter()
            .map(|e| (e.key().clone(), e.value().repo_root().to_path_buf()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Loads repositories configured via `KVX_REPOS` or `KVX_LOCAL_CONFIG` (`~/.kvx/local.json`).
    pub fn load_configured_repos(&self, sync_now: bool) -> VortexResult<usize> {
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Ok(env_repos) = std::env::var("KVX_REPOS") {
            for part in env_repos.split([',', ':']) {
                let p = PathBuf::from(part.trim());
                if p.is_dir() {
                    paths.push(p);
                }
            }
        }
        let local_cfg_path = std::env::var("KVX_LOCAL_CONFIG")
            .map(PathBuf::from)
            .ok()
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".kvx/local.json"))
            });
        if let Some(cfg_p) = local_cfg_path {
            if cfg_p.is_file() {
                if let Ok(raw_text) = fs::read_to_string(&cfg_p) {
                    let parsed_res: Result<LocalJsonConfig, _> = serde_json::from_str(&raw_text);
                    if let Ok(parsed) = parsed_res {
                        for r in parsed.repos {
                            let p = PathBuf::from(r);
                            if p.is_dir() {
                                paths.push(p);
                            }
                        }
                    }
                }
            }
        }

        let mut added = 0usize;
        for p in paths {
            if self.add_repo(None, &p, sync_now).is_ok() {
                added += 1;
            }
        }
        Ok(added)
    }

    /// Resolves a shard by `repo_id` (or directory path), defaulting to the primary registered repo.
    pub fn resolve_shard(&self, repo_id_or_path: Option<&str>) -> VortexResult<Arc<VortexShard>> {
        if let Some(key) = repo_id_or_path.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if let Some(found) = self.shards.get(key) {
                return Ok(Arc::clone(found.value()));
            }
            let as_path = Path::new(key);
            if as_path.is_dir() {
                let canon = as_path
                    .canonicalize()
                    .unwrap_or_else(|_| as_path.to_path_buf());
                for entry in self.shards.iter() {
                    if entry.value().repo_root() == canon {
                        return Ok(Arc::clone(entry.value()));
                    }
                }
                return self.add_repo(None, &canon, true);
            }
            return Err(VortexError::RepoNotFound(key.to_string()));
        }

        if let Some(ref def_id) = *self.default_repo_id.read() {
            if let Some(found) = self.shards.get(def_id) {
                return Ok(Arc::clone(found.value()));
            }
        }
        if let Some(first) = self.shards.iter().next() {
            return Ok(Arc::clone(first.value()));
        }
        Err(VortexError::RepoNotFound(
            "No repository registered in VortexEngine".to_string(),
        ))
    }

    /// Incrementally synchronizes a repository shard (`force = true` forces full re-parse).
    pub fn sync_repo(&self, repo_id: Option<&str>, force: bool) -> VortexResult<SyncSummary> {
        let shard = self.resolve_shard(repo_id)?;
        let summary = shard.sync(force)?;
        self.record_telemetry("sync_repo", Some(shard.repo_id()), 0);
        Ok(summary)
    }

    /// Synchronizes all registered repository shards.
    pub fn sync_all(&self, force: bool) -> VortexResult<Vec<(String, SyncSummary)>> {
        let mut results = Vec::new();
        let shards: Vec<Arc<VortexShard>> =
            self.shards.iter().map(|e| Arc::clone(e.value())).collect();
        for s in shards {
            let sum = s.sync(force)?;
            results.push((s.repo_id().to_string(), sum));
        }
        results.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(results)
    }

    /// Compiles a token-budgeted L0-L3 `ContextPack` via `SubmodularPacker`.
    pub fn context(&self, req: &ContextRequest) -> VortexResult<ContextPack> {
        let shard = self.resolve_shard(req.repo_id.as_deref())?;
        let pack = self.packer.pack(&shard, req)?;
        let saved = pack
            .estimated_raw_tokens
            .saturating_sub(pack.token_count) as u64;
        self.record_telemetry("context", Some(shard.repo_id()), saved);
        Ok(pack)
    }

    /// Searches declarations via FTS5 BM25F with textual fallback (`via` + `reason` always populated).
    pub fn search(
        &self,
        repo_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> VortexResult<SearchResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = shard.search(query, limit)?;
        self.record_telemetry("search", Some(shard.repo_id()), 0);
        Ok(res)
    }

    /// Returns a structured `FileOutlineResponse` filtered by `OutlineScope`.
    pub fn file_outline(
        &self,
        repo_id: Option<&str>,
        file_query: &str,
        scope: OutlineScope,
    ) -> VortexResult<FileOutlineResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = shard.file_outline(file_query, scope)?;
        self.record_telemetry("file_outline", Some(shard.repo_id()), 150);
        Ok(res)
    }

    /// Reads exact declaration slice(s) for a symbol without loading surrounding file noise.
    pub fn read_symbol(
        &self,
        repo_id: Option<&str>,
        symbol_query: &str,
        file_hint: Option<&str>,
    ) -> VortexResult<ReadSymbolResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = shard.read_symbol(symbol_query, file_hint)?;
        self.record_telemetry("read_symbol", Some(shard.repo_id()), 250);
        Ok(res)
    }

    /// Builds a PageRank-ordered repository contract map within `budget_tokens`.
    pub fn repo_map(
        &self,
        repo_id: Option<&str>,
        budget_tokens: usize,
    ) -> VortexResult<RepoMapResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = graph::repo_map(&shard, budget_tokens)?;
        self.record_telemetry("repo_map", Some(shard.repo_id()), 300);
        Ok(res)
    }

    /// Finds provenance-graded references (`same_file`, `imported`, `name_only`) for `symbol_query`.
    pub fn find_references(
        &self,
        repo_id: Option<&str>,
        symbol_query: &str,
        file_hint: Option<&str>,
        limit: usize,
        include_name_only: bool,
    ) -> VortexResult<FindReferencesResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = shard.find_references(symbol_query, file_hint, limit, include_name_only)?;
        self.record_telemetry("find_references", Some(shard.repo_id()), 100);
        Ok(res)
    }

    /// Computes incoming callers and outgoing callees around `symbol_name`.
    pub fn call_graph(
        &self,
        repo_id: Option<&str>,
        symbol_name: &str,
    ) -> VortexResult<CallGraphResponse> {
        let shard = self.resolve_shard(repo_id)?;
        let res = shard.call_graph(symbol_name)?;
        self.record_telemetry("call_graph", Some(shard.repo_id()), 100);
        Ok(res)
    }

    /// Computes AST + call-site + test + Git co-change `BlastRadiusReport` for `target`.
    pub fn blast_radius(
        &self,
        repo_id: Option<&str>,
        target: &str,
        max_depth: usize,
    ) -> VortexResult<BlastRadiusReport> {
        let shard = self.resolve_shard(repo_id)?;
        let res = graph::blast_radius(&shard, target, max_depth)?;
        self.record_telemetry("blast_radius", Some(shard.repo_id()), 200);
        Ok(res)
    }

    /// Lists test files impacted by `changed_targets`.
    pub fn affected(
        &self,
        repo_id: Option<&str>,
        changed_targets: &[String],
    ) -> VortexResult<Vec<String>> {
        let shard = self.resolve_shard(repo_id)?;
        graph::affected_tests(&shard, changed_targets)
    }

    /// Detects exported contract drift and transitive impact across changed files.
    pub fn diff_impact(
        &self,
        repo_id: Option<&str>,
        changed_files: Option<&[String]>,
    ) -> VortexResult<DiffImpactReport> {
        let shard = self.resolve_shard(repo_id)?;
        graph::diff_impact(&shard, changed_files)
    }

    /// Runs Tarjan Strongly Connected Components cycle analysis on a shard's `CsrGraph`.
    pub fn tarjan_cycles(&self, repo_id: Option<&str>) -> VortexResult<TarjanReport> {
        let shard = self.resolve_shard(repo_id)?;
        let csr = CsrGraph::from_shard(&shard)?;
        Ok(csr.tarjan_scc())
    }

    /// Runs the Architectural Layer Firewall (`ui -> db/infra` + custom `layer_rules`).
    pub fn check_architecture(
        &self,
        repo_id: Option<&str>,
        custom_rules: &[ArchBoundaryRule],
    ) -> VortexResult<Vec<ArchViolation>> {
        let shard = self.resolve_shard(repo_id)?;
        graph::check_architecture(&shard, custom_rules)
    }

    /// Runs anti-slop AST verification across all indexed files in a repository shard.
    pub fn scan_slop(&self, repo_id: Option<&str>) -> VortexResult<Vec<SlopFinding>> {
        let shard = self.resolve_shard(repo_id)?;
        shard.scan_slop()
    }

    /// Compresses raw compiler/test output into `<= max_tokens` root errors + `signature_blake3`.
    pub fn slice_failure(
        &self,
        raw_output: &str,
        max_tokens: Option<usize>,
        repo_id: Option<&str>,
    ) -> VortexResult<FailureSliceResult> {
        let shard_opt = repo_id.and_then(|id| self.resolve_shard(Some(id)).ok()).or_else(|| {
            self.resolve_shard(None).ok()
        });
        let res = FailureSlicer::slice(raw_output, max_tokens, shard_opt.as_deref())?;
        let saved = res.tokens_before.saturating_sub(res.tokens_after) as u64;
        self.record_telemetry("slice_failure", repo_id, saved);
        Ok(res)
    }

    /// Discovers cross-repository HTTP route, SQL table, and contract links across all open shards.
    pub fn federate(&self) -> VortexResult<Vec<FederationLink>> {
        let arcs: Vec<Arc<VortexShard>> =
            self.shards.iter().map(|e| Arc::clone(e.value())).collect();
        let refs: Vec<&VortexShard> = arcs.iter().map(Arc::as_ref).collect();
        let links = MultiRepoFederator::federate(&refs)?;
        *self.federation_cache.write() = links.clone();
        Ok(links)
    }

    /// Pins a symbol contract lock (`Frozen` or `AllowBodyOnly`).
    pub fn lock_symbol(
        &self,
        repo_id: Option<&str>,
        symbol: &str,
        file_hint: Option<&str>,
        mode: LockMode,
        owner: &str,
        reason: &str,
    ) -> VortexResult<SymbolLock> {
        let shard = self.resolve_shard(repo_id)?;
        shard.lock_symbol(symbol, file_hint, mode, owner, reason)
    }

    /// Releases a symbol contract lock by lock ID or `qualified_name`.
    pub fn unlock_symbol(&self, repo_id: Option<&str>, id_or_symbol: &str) -> VortexResult<usize> {
        let shard = self.resolve_shard(repo_id)?;
        shard.unlock_symbol(id_or_symbol)
    }

    /// Lists active `SymbolLock`s on a shard.
    pub fn list_locks(&self, repo_id: Option<&str>) -> VortexResult<Vec<SymbolLock>> {
        let shard = self.resolve_shard(repo_id)?;
        shard.list_locks()
    }

    /// Performs an AST-bounded surgical edit (`replace`, `insert_before`, `insert_after`, `delete`).
    pub fn edit_symbol(
        &self,
        repo_id: Option<&str>,
        req: &EditSymbolRequest,
    ) -> VortexResult<EditSymbolResult> {
        let shard = self.resolve_shard(repo_id)?;
        let res = SymbolEditor::edit_symbol(&shard, req, &[])?;
        self.record_telemetry("edit_symbol", Some(shard.repo_id()), 200);
        Ok(res)
    }

    /// Performs Phase 1 (`plan_token: None`) or Phase 2 (`plan_token: Some(...)`) atomic symbol rename.
    pub fn rename_symbol(
        &self,
        repo_id: Option<&str>,
        req: &RenameSymbolRequest,
    ) -> VortexResult<RenameSymbolResult> {
        let shard = self.resolve_shard(repo_id)?;
        let res = TwoPhaseRenamer::rename_symbol(&shard, req, &[])?;
        self.record_telemetry("rename_symbol", Some(shard.repo_id()), 300);
        Ok(res)
    }

    /// Scans `text` with the 15-category `DlpScanner` (respecting `.fabrica-dlp-allow.json` if `repo_id` resolves).
    pub fn scan_dlp(
        &self,
        repo_id: Option<&str>,
        file_path: &str,
        text: &str,
    ) -> VortexResult<Vec<DlpFinding>> {
        let scanner = match self.resolve_shard(repo_id) {
            Ok(shard) => DlpScanner::from_repo(shard.repo_root())?,
            Err(_) => DlpScanner::new(),
        };
        Ok(scanner.scan_text(file_path, text))
    }

    /// Redacts detected secrets from `text` using `[REDACTED:<category>]`.
    pub fn redact_dlp(&self, text: &str) -> String {
        DlpScanner::new().redact_text(text)
    }

    /// Returns diagnostic `ShardHealth` for a single shard.
    pub fn index_health(&self, repo_id: Option<&str>) -> VortexResult<ShardHealth> {
        let shard = self.resolve_shard(repo_id)?;
        shard.health()
    }

    /// Returns global `VortexStatus` across all shards, grammars, federation links, and telemetry.
    pub fn status(&self) -> VortexResult<VortexStatus> {
        let mut shard_healths = Vec::new();
        for entry in self.shards.iter() {
            shard_healths.push(entry.value().health()?);
        }
        shard_healths.sort_by(|a, b| a.repo_id.cmp(&b.repo_id));

        let (telemetry_events, total_tokens_saved) = {
            let conn = self.telemetry_conn.lock();
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM telemetry_events",
                [],
                |r| r.get(0),
            )?;
            let saved: i64 = conn.query_row(
                "SELECT COALESCE(SUM(tokens_saved), 0) FROM telemetry_events",
                [],
                |r| r.get(0),
            )?;
            (count.max(0) as usize, saved.max(0) as u64)
        };

        let healthy = shard_healths.iter().all(|h| h.healthy);
        Ok(VortexStatus {
            version: KAXCAV_VORTEX_VERSION.to_string(),
            storage_root: self.storage_root.to_string_lossy().to_string(),
            shards: shard_healths,
            federation_edges: self.federation_cache.read().len(),
            tree_sitter_languages: AstParser::supported_tree_sitter_languages(),
            telemetry_events,
            total_tokens_saved,
            healthy,
        })
    }

    fn restore_registered_repos(&self) -> VortexResult<()> {
        let saved: Vec<(String, String)> = {
            let conn = self.telemetry_conn.lock();
            let mut stmt = conn.prepare(
                "SELECT repo_id, repo_root FROM registered_repos ORDER BY added_at_ms ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut list = Vec::new();
            for item in rows {
                list.push(item?);
            }
            list
        };

        for (repo_id, root_str) in saved {
            let p = PathBuf::from(&root_str);
            if p.is_dir() {
                let shard_hash = &blake3::hash(p.to_string_lossy().as_bytes()).to_hex()[..12];
                let db_path = self
                    .storage_root
                    .join("shards")
                    .join(format!("{repo_id}-{shard_hash}.sqlite"));
                if let Ok(shard) = VortexShard::open(&repo_id, &p, &db_path) {
                    self.shards.insert(repo_id.clone(), Arc::new(shard));
                    let mut def = self.default_repo_id.write();
                    if def.is_none() {
                        *def = Some(repo_id);
                    }
                }
            }
        }
        Ok(())
    }

    fn record_telemetry(&self, tool_name: &str, repo_id: Option<&str>, tokens_saved: u64) {
        let conn = self.telemetry_conn.lock();
        let _ = conn.execute(
            "INSERT INTO telemetry_events (tool_name, repo_id, tokens_saved, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                tool_name,
                repo_id,
                tokens_saved as i64,
                Utc::now().timestamp_millis()
            ],
        );
    }
}

fn default_storage_root() -> PathBuf {
    if let Ok(custom) = std::env::var("KVX_STORAGE_ROOT") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".kvx");
    }
    std::env::temp_dir().join("kaxcav-vortex")
}

fn derive_repo_id(repo_root: &Path) -> String {
    repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "repo".to_string())
}
