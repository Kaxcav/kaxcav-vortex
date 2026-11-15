//! Core serializable data structures and error types for `vortex-core`.
//!
//! Traceability: `@REQ-VORTEX-001`, `@REQ-VORTEX-002`, `@REQ-VORTEX-003`, `@REQ-VORTEX-004`, `@REQ-VORTEX-005`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

/// Unified error type for all `vortex-core` operations.
#[derive(Debug, Error)]
pub enum VortexError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("YAML serialization error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("Regular expression error: {0}")]
    Regex(#[from] regex::Error),

    #[error("Glob pattern error: {0}")]
    Glob(#[from] globset::Error),

    #[error("ZIP archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("XML parse error: {0}")]
    Xml(#[from] quick_xml::Error),

    #[error("CSV parse error: {0}")]
    Csv(#[from] csv::Error),

    #[error("HTTP transport error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Path refused by .kvxignore policy: {path} ({reason})")]
    KvxIgnored { path: String, reason: String },

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Symbol not found: {0}")]
    SymbolNotFound(String),

    #[error("Ambiguous symbol '{symbol}'; candidates: {candidates:?}")]
    AmbiguousSymbol {
        symbol: String,
        candidates: Vec<String>,
    },

    #[error("Expected hash mismatch for '{symbol}': expected {expected}, actual {actual}")]
    HashMismatch {
        symbol: String,
        expected: String,
        actual: String,
    },

    #[error("Symbol lock violation on '{symbol}' ({mode:?}): {reason}")]
    LockViolation {
        symbol: String,
        mode: LockMode,
        reason: String,
    },

    #[error("Syntax verification failed in '{path}': {detail}")]
    SyntaxError { path: String, detail: String },

    #[error("Stale rename plan token: expected {expected}, actual {actual}")]
    StalePlanToken { expected: String, actual: String },

    #[error("Repository not registered or accessible: {0}")]
    RepoNotFound(String),
}

/// Canonical result alias for `vortex-core`.
pub type VortexResult<T> = Result<T, VortexError>;

/// Fidelity mode requested for `SubmodularPacker` context packs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ContextFidelity {
    #[serde(alias = "Full", alias = "FULL")]
    Full,
    #[default]
    #[serde(alias = "Graded", alias = "GRADED")]
    Graded,
    #[serde(alias = "Compact", alias = "COMPACT")]
    Compact,
}

/// Per-slice compression level emitted inside a `ContextPack`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum SliceLevel {
    #[serde(rename = "L0_DELTA", alias = "l0_delta")]
    L0Delta,
    #[serde(rename = "L1_OUTLINE", alias = "L1_SKELETON", alias = "l1_outline")]
    L1Outline,
    #[serde(rename = "L2_CONTRACT", alias = "l2_contract")]
    L2Contract,
    #[serde(rename = "L3_FULL", alias = "L3_FOCAL", alias = "l3_full")]
    L3Full,
}

/// Visibility filter for `file_outline`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutlineScope {
    #[default]
    #[serde(alias = "Topo", alias = "TOPO", alias = "top")]
    Topo,
    #[serde(alias = "Exportado", alias = "EXPORTADO", alias = "exported")]
    Exportado,
    #[serde(alias = "Tudo", alias = "TUDO", alias = "all")]
    Tudo,
}

/// Confidence tier of an identifier usage site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefConfidence {
    SameFile,
    Imported,
    NameOnly,
}

/// Resolution channel used by `search` (never silent on empty results).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchVia {
    Indice,
    BuscaTextual,
    Nenhum,
}

/// Extracted AST/lexical declaration record stored in `VortexShard`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub name: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    pub kind: String,
    pub signature: String,
    #[serde(alias = "start_line")]
    pub start_line: usize,
    #[serde(alias = "end_line")]
    pub end_line: usize,
    pub exported: bool,
    pub complexity: usize,
    #[serde(alias = "sig_hash")]
    pub sig_hash: String,
    #[serde(alias = "body_hash")]
    pub body_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docstring: Option<String>,
}

/// Symbol identifier reference record with provenance confidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRecord {
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "symbol_name")]
    pub symbol_name: String,
    pub line: usize,
    pub col: usize,
    #[serde(alias = "in_symbol", skip_serializing_if = "Option::is_none")]
    pub in_symbol: Option<String>,
    pub confidence: RefConfidence,
    #[serde(alias = "context_line", skip_serializing_if = "Option::is_none")]
    pub context_line: Option<String>,
}

/// Directed dependency or call edge between files/symbols.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRecord {
    #[serde(alias = "from_path")]
    pub from_path: String,
    #[serde(alias = "raw_target")]
    pub raw_target: String,
    #[serde(alias = "resolved_path", skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    pub kind: String,
    #[serde(alias = "symbol_name", skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    pub weight: f32,
    pub line: usize,
}

/// Exposed or consumed HTTP/RPC route endpoint extracted from source code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRecord {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub direction: String,
    pub method: String,
    #[serde(alias = "route_path")]
    pub route_path: String,
    #[serde(alias = "handler_name", skip_serializing_if = "Option::is_none")]
    pub handler_name: Option<String>,
    pub line: usize,
}

/// Diagnostic health metrics of a single repository SQLite WAL shard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardHealth {
    #[serde(alias = "repo_id")]
    pub repo_id: String,
    #[serde(alias = "repo_root")]
    pub repo_root: String,
    #[serde(alias = "db_path")]
    pub db_path: String,
    #[serde(alias = "schema_version")]
    pub schema_version: u32,
    #[serde(alias = "files_indexed")]
    pub files_indexed: usize,
    #[serde(alias = "symbols_indexed")]
    pub symbols_indexed: usize,
    #[serde(alias = "edges_indexed")]
    pub edges_indexed: usize,
    #[serde(alias = "resolved_edges_indexed")]
    pub resolved_edges_indexed: usize,
    #[serde(alias = "refs_indexed")]
    pub refs_indexed: usize,
    #[serde(alias = "routes_indexed")]
    pub routes_indexed: usize,
    #[serde(alias = "cochange_pairs")]
    pub cochange_pairs: usize,
    #[serde(alias = "active_locks")]
    pub active_locks: usize,
    #[serde(alias = "wal_bytes")]
    pub wal_bytes: u64,
    #[serde(alias = "db_bytes")]
    pub db_bytes: u64,
    #[serde(alias = "last_sync_ms")]
    pub last_sync_ms: i64,
    pub healthy: bool,
}

/// Global status snapshot across all registered shards, parsers, and telemetry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VortexStatus {
    pub version: String,
    #[serde(alias = "storage_root")]
    pub storage_root: String,
    pub shards: Vec<ShardHealth>,
    #[serde(alias = "federation_edges")]
    pub federation_edges: usize,
    #[serde(alias = "tree_sitter_languages")]
    pub tree_sitter_languages: Vec<String>,
    #[serde(alias = "telemetry_events")]
    pub telemetry_events: usize,
    #[serde(alias = "total_tokens_saved")]
    pub total_tokens_saved: u64,
    pub healthy: bool,
}

/// Request payload for `SubmodularPacker` L0-L3 context compilation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRequest {
    pub task: String,
    #[serde(alias = "repo_id", default)]
    pub repo_id: Option<String>,
    #[serde(alias = "entry_files", default)]
    pub entry_files: Vec<String>,
    #[serde(alias = "token_budget", alias = "budget_tokens", default)]
    pub token_budget: Option<usize>,
    #[serde(default)]
    pub fidelity: Option<ContextFidelity>,
    #[serde(alias = "if_none_match", default)]
    pub if_none_match: Option<String>,
    #[serde(alias = "delta_from", default)]
    pub delta_from: Option<String>,
}

/// Individual code or contract slice packed into a `ContextPack`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSlice {
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "symbol_name", skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    #[serde(alias = "qualified_name", skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
    pub kind: String,
    pub level: SliceLevel,
    #[serde(alias = "start_line")]
    pub start_line: usize,
    #[serde(alias = "end_line")]
    pub end_line: usize,
    pub score: f64,
    pub tokens: usize,
    #[serde(alias = "body_hash")]
    pub body_hash: String,
    pub content: String,
}

/// Reusable existing symbol surfaced by `ReuseEnforcer` to prevent duplicate helpers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReusableSymbolHint {
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    pub kind: String,
    pub signature: String,
    pub line: usize,
    pub reason: String,
}

/// Token-budgeted L0-L3 context pack with ETag delta support and reuse hints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPack {
    #[serde(alias = "repo_id")]
    pub repo_id: String,
    pub task: String,
    pub fidelity: ContextFidelity,
    #[serde(alias = "budget_tokens")]
    pub budget_tokens: usize,
    #[serde(alias = "token_count")]
    pub token_count: usize,
    #[serde(alias = "estimated_raw_tokens")]
    pub estimated_raw_tokens: usize,
    #[serde(alias = "savings_ratio")]
    pub savings_ratio: f64,
    pub etag: String,
    pub unchanged: bool,
    #[serde(alias = "delta_base", skip_serializing_if = "Option::is_none")]
    pub delta_base: Option<String>,
    pub slices: Vec<ContextSlice>,
    #[serde(alias = "reusable_symbols")]
    pub reusable_symbols: Vec<ReusableSymbolHint>,
    pub markdown: String,
}

/// Ranked symbol or text hit returned by `search`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub name: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    pub kind: String,
    pub signature: String,
    #[serde(alias = "start_line")]
    pub start_line: usize,
    #[serde(alias = "end_line")]
    pub end_line: usize,
    pub exported: bool,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// Search response guaranteed never to be silently empty (`via` + `reason` always set).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    pub via: SearchVia,
    pub reason: String,
    pub total: usize,
    pub hits: Vec<SearchHit>,
}

/// Structured outline of symbols declared inside a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOutlineResponse {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub scope: OutlineScope,
    pub fresh: bool,
    #[serde(alias = "total_symbols")]
    pub total_symbols: usize,
    pub symbols: Vec<SymbolRecord>,
}

/// Matched symbol declaration body returned by `read_symbol`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSymbolMatch {
    pub symbol: SymbolRecord,
    pub source: String,
    pub tokens: usize,
}

/// Detailed response for `read_symbol` with freshness and fallback hints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSymbolResponse {
    pub query: String,
    pub found: bool,
    pub fresh: bool,
    pub reason: String,
    pub matches: Vec<ReadSymbolMatch>,
    #[serde(alias = "similar_symbols")]
    pub similar_symbols: Vec<String>,
}

/// Per-file exported contract summary inside `RepoMapResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapFileEntry {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub rank: f64,
    pub signatures: Vec<String>,
}

/// PageRank-ordered structural map of repository files and exported contracts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapResponse {
    #[serde(alias = "repo_id")]
    pub repo_id: String,
    #[serde(alias = "budget_tokens")]
    pub budget_tokens: usize,
    #[serde(alias = "token_count")]
    pub token_count: usize,
    #[serde(alias = "files_included")]
    pub files_included: usize,
    #[serde(alias = "total_files")]
    pub total_files: usize,
    pub entries: Vec<RepoMapFileEntry>,
    pub markdown: String,
}

/// Provenance-graded reference search response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindReferencesResponse {
    pub query: String,
    #[serde(alias = "target_file", skip_serializing_if = "Option::is_none")]
    pub target_file: Option<String>,
    #[serde(
        alias = "target_qualified_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_qualified_name: Option<String>,
    pub total: usize,
    pub references: Vec<ReferenceRecord>,
}

/// Caller or callee entry inside a `CallGraphResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGraphEndpoint {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub symbol: String,
    pub line: usize,
    pub confidence: RefConfidence,
}

/// Bidirectional call graph around a symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGraphResponse {
    pub symbol: String,
    pub definitions: Vec<SymbolRecord>,
    pub callers: Vec<CallGraphEndpoint>,
    pub callees: Vec<CallGraphEndpoint>,
}

/// File coupled to a target file via Git commit history co-change mining.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoChangedFile {
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "co_commits")]
    pub co_commits: usize,
    pub confidence: f64,
}

/// Impact analysis report combining AST dependents, call sites, tests, and Git co-change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlastRadiusReport {
    pub target: String,
    #[serde(alias = "resolved_files")]
    pub resolved_files: Vec<String>,
    #[serde(alias = "direct_dependents")]
    pub direct_dependents: Vec<String>,
    #[serde(alias = "transitive_dependents")]
    pub transitive_dependents: Vec<String>,
    #[serde(alias = "affected_tests")]
    pub affected_tests: Vec<String>,
    pub callers: Vec<CallGraphEndpoint>,
    #[serde(alias = "co_changed")]
    pub co_changed: Vec<CoChangedFile>,
    #[serde(alias = "risk_level")]
    pub risk_level: String,
}

/// Exported contract drift detected between previous and current symbol history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractDrift {
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    #[serde(alias = "change_kind")]
    pub change_kind: String,
    #[serde(alias = "old_signature", skip_serializing_if = "Option::is_none")]
    pub old_signature: Option<String>,
    #[serde(alias = "new_signature", skip_serializing_if = "Option::is_none")]
    pub new_signature: Option<String>,
}

/// Impact report for a working-tree diff or list of modified files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffImpactReport {
    #[serde(alias = "changed_files")]
    pub changed_files: Vec<String>,
    #[serde(alias = "contract_drifts")]
    pub contract_drifts: Vec<ContractDrift>,
    #[serde(alias = "impacted_files")]
    pub impacted_files: Vec<String>,
    #[serde(alias = "affected_tests")]
    pub affected_tests: Vec<String>,
    #[serde(alias = "unindexed_files")]
    pub unindexed_files: Vec<String>,
    pub summary: String,
}

/// Cross-repository contract or HTTP route link discovered by `federate`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationLink {
    #[serde(alias = "source_repo")]
    pub source_repo: String,
    #[serde(alias = "source_file")]
    pub source_file: String,
    #[serde(alias = "source_symbol")]
    pub source_symbol: String,
    #[serde(alias = "target_repo")]
    pub target_repo: String,
    #[serde(alias = "target_file")]
    pub target_file: String,
    #[serde(alias = "target_symbol")]
    pub target_symbol: String,
    pub kind: String,
    pub detail: String,
    pub confidence: f64,
}

/// Anti-slop AST/lexical finding (`empty_catch`, `explicit_any`, `ts_ignore`, `panic_stub`, `unfinished_marker`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlopFinding {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub line: usize,
    pub col: usize,
    pub kind: String,
    pub severity: String,
    pub snippet: String,
    pub message: String,
}

/// Declarative architectural boundary rule (`from_glob` must not depend on `forbid_to_glob`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchBoundaryRule {
    pub id: String,
    #[serde(alias = "from_glob", alias = "from")]
    pub from_glob: String,
    #[serde(alias = "forbid_to_glob", alias = "forbid_to", alias = "forbidTo")]
    pub forbid_to_glob: String,
    pub reason: String,
}

/// Detected architectural layer firewall violation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchViolation {
    #[serde(alias = "rule_id")]
    pub rule_id: String,
    #[serde(alias = "from_file")]
    pub from_file: String,
    #[serde(alias = "to_file")]
    pub to_file: String,
    #[serde(alias = "raw_import")]
    pub raw_import: String,
    pub line: usize,
    pub reason: String,
}

/// Non-trivial Strongly Connected Component (dependency cycle) found by Tarjan's algorithm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleFinding {
    #[serde(alias = "cycle_id")]
    pub cycle_id: usize,
    pub size: usize,
    pub members: Vec<String>,
    #[serde(alias = "sample_edges")]
    pub sample_edges: Vec<(String, String)>,
}

/// Summary report of Tarjan SCC cycle analysis over a `CsrGraph`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TarjanReport {
    #[serde(alias = "node_count")]
    pub node_count: usize,
    #[serde(alias = "edge_count")]
    pub edge_count: usize,
    #[serde(alias = "scc_count")]
    pub scc_count: usize,
    pub cycles: Vec<CycleFinding>,
}

/// Protection level of a symbol contract lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockMode {
    #[serde(alias = "FROZEN")]
    Frozen,
    #[serde(alias = "allowBodyOnly", alias = "ALLOW_BODY_ONLY")]
    AllowBodyOnly,
}

/// Contract lock pinning a symbol's signature or entire body against unauthorized edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolLock {
    pub id: String,
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    pub mode: LockMode,
    #[serde(alias = "sig_hash")]
    pub sig_hash: String,
    #[serde(alias = "body_hash")]
    pub body_hash: String,
    pub owner: String,
    pub reason: String,
    #[serde(alias = "created_at_ms")]
    pub created_at_ms: i64,
}

/// AST-bounded surgical edit operation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolEditOp {
    #[serde(alias = "REPLACE")]
    Replace,
    #[serde(alias = "insertBefore", alias = "INSERT_BEFORE")]
    InsertBefore,
    #[serde(alias = "insertAfter", alias = "INSERT_AFTER")]
    InsertAfter,
    #[serde(alias = "DELETE")]
    Delete,
}

/// Request payload for `SymbolEditor::edit_symbol`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSymbolRequest {
    pub symbol: String,
    #[serde(alias = "file_path", default)]
    pub file_path: Option<String>,
    pub op: SymbolEditOp,
    #[serde(alias = "new_code", default)]
    pub new_code: String,
    #[serde(alias = "expected_hash", default)]
    pub expected_hash: Option<String>,
    #[serde(alias = "allow_syntax_errors", default)]
    pub allow_syntax_errors: bool,
    #[serde(alias = "dry_run", default)]
    pub dry_run: bool,
}

/// Result returned by `SymbolEditor::edit_symbol`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSymbolResult {
    pub applied: bool,
    #[serde(alias = "dry_run")]
    pub dry_run: bool,
    #[serde(alias = "file_path")]
    pub file_path: String,
    #[serde(alias = "qualified_name")]
    pub qualified_name: String,
    pub op: SymbolEditOp,
    #[serde(alias = "old_body_hash")]
    pub old_body_hash: String,
    #[serde(alias = "new_body_hash")]
    pub new_body_hash: String,
    #[serde(alias = "start_line")]
    pub start_line: usize,
    #[serde(alias = "end_line")]
    pub end_line: usize,
    #[serde(alias = "syntax_valid")]
    pub syntax_valid: bool,
    #[serde(alias = "preview_diff")]
    pub preview_diff: String,
}

/// Request payload for two-phase `TwoPhaseRenamer::rename_symbol`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSymbolRequest {
    pub symbol: String,
    #[serde(alias = "file_path", default)]
    pub file_path: Option<String>,
    #[serde(alias = "new_name")]
    pub new_name: String,
    #[serde(alias = "plan_token", default)]
    pub plan_token: Option<String>,
    #[serde(alias = "include_name_only", default)]
    pub include_name_only: bool,
    #[serde(alias = "allow_syntax_errors", default)]
    pub allow_syntax_errors: bool,
}

/// Planned or applied identifier rename site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEditSite {
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub line: usize,
    pub col: usize,
    pub confidence: RefConfidence,
    pub preview: String,
}

/// Two-phase rename plan / execution result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSymbolResult {
    pub phase: String,
    pub applied: bool,
    #[serde(alias = "old_name")]
    pub old_name: String,
    #[serde(alias = "new_name")]
    pub new_name: String,
    #[serde(alias = "plan_token")]
    pub plan_token: String,
    #[serde(alias = "files_touched")]
    pub files_touched: Vec<String>,
    pub edits: Vec<RenameEditSite>,
    #[serde(alias = "skipped_name_only")]
    pub skipped_name_only: Vec<RenameEditSite>,
}

/// Deduplicated root compiler or test error extracted by `FailureSlicer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureRootError {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(alias = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col: Option<usize>,
    pub message: String,
    #[serde(alias = "symbolSnippet", skip_serializing_if = "Option::is_none")]
    pub symbol_snippet: Option<String>,
}

/// Compact `<= max_tokens` failure digest with deterministic `signature_blake3` for `DoomLoopBreaker`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureSliceResult {
    #[serde(alias = "rootErrors")]
    pub root_errors: Vec<FailureRootError>,
    #[serde(alias = "signatureBlake3")]
    pub signature_blake3: String,
    #[serde(alias = "tokensBefore")]
    pub tokens_before: usize,
    #[serde(alias = "tokensAfter")]
    pub tokens_after: usize,
    #[serde(alias = "deduplicatedCount")]
    pub deduplicated_count: usize,
    pub summary: String,
}

/// All 15 secret and PII credential categories detected by `DlpScanner`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DlpCategory {
    AppsheetAccessKey,
    AppsheetAppId,
    GoogleApiKey,
    GoogleOauthToken,
    DriveResourceId,
    GenericSecret,
    PrivateKeyPem,
    PiiCpfCnpj,
    AnthropicKey,
    OpenaiKey,
    GithubPat,
    AwsKey,
    JwtToken,
    DbUri,
    SlackToken,
}

impl DlpCategory {
    /// Canonical snake_case identifier string for allowlist matching and redaction tags.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AppsheetAccessKey => "appsheet_access_key",
            Self::AppsheetAppId => "appsheet_app_id",
            Self::GoogleApiKey => "google_api_key",
            Self::GoogleOauthToken => "google_oauth_token",
            Self::DriveResourceId => "drive_resource_id",
            Self::GenericSecret => "generic_secret",
            Self::PrivateKeyPem => "private_key_pem",
            Self::PiiCpfCnpj => "pii_cpf_cnpj",
            Self::AnthropicKey => "anthropic_key",
            Self::OpenaiKey => "openai_key",
            Self::GithubPat => "github_pat",
            Self::AwsKey => "aws_key",
            Self::JwtToken => "jwt_token",
            Self::DbUri => "db_uri",
            Self::SlackToken => "slack_token",
        }
    }

    /// Complete list of all 15 supported DLP categories.
    pub const ALL: [DlpCategory; 15] = [
        Self::AppsheetAccessKey,
        Self::AppsheetAppId,
        Self::GoogleApiKey,
        Self::GoogleOauthToken,
        Self::DriveResourceId,
        Self::GenericSecret,
        Self::PrivateKeyPem,
        Self::PiiCpfCnpj,
        Self::AnthropicKey,
        Self::OpenaiKey,
        Self::GithubPat,
        Self::AwsKey,
        Self::JwtToken,
        Self::DbUri,
        Self::SlackToken,
    ];
}

/// Sanitized DLP finding (never stores the raw unredacted secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlpFinding {
    pub category: DlpCategory,
    pub severity: String,
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub line: usize,
    pub col: usize,
    #[serde(alias = "redacted_preview")]
    pub redacted_preview: String,
    #[serde(alias = "value_sha256")]
    pub value_sha256: String,
}

/// Isolated workspace registered inside `DriveNexusVault`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusWorkspace {
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    pub name: String,
    #[serde(alias = "root_path")]
    pub root_path: String,
    #[serde(alias = "drive_folder_id", skip_serializing_if = "Option::is_none")]
    pub drive_folder_id: Option<String>,
    #[serde(alias = "created_at_ms")]
    pub created_at_ms: i64,
    #[serde(alias = "last_ingest_ms")]
    pub last_ingest_ms: i64,
    #[serde(alias = "files_total")]
    pub files_total: usize,
}

/// Authority conflict or duplicate/version collision discovered inside a Nexus workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusAuthorityConflict {
    pub id: String,
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    pub kind: String,
    pub severity: String,
    #[serde(alias = "primary_path")]
    pub primary_path: String,
    #[serde(alias = "conflicting_path")]
    pub conflicting_path: String,
    pub description: String,
}

/// Custom regex/keyword invariant checked during Nexus authority conflict detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomInvariant {
    pub id: String,
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    pub title: String,
    #[serde(alias = "canonical_pattern")]
    pub canonical_pattern: String,
    #[serde(alias = "forbidden_pattern")]
    pub forbidden_pattern: String,
    pub severity: String,
}

/// Summary returned after ingesting a folder or Drive workspace into `DriveNexusVault`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusIngestResult {
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    #[serde(alias = "files_scanned")]
    pub files_scanned: usize,
    #[serde(alias = "files_ingested")]
    pub files_ingested: usize,
    #[serde(alias = "sheets_indexed")]
    pub sheets_indexed: usize,
    #[serde(alias = "twins_written")]
    pub twins_written: usize,
    #[serde(alias = "dlp_redactions")]
    pub dlp_redactions: usize,
    #[serde(alias = "duplicates_detected")]
    pub duplicates_detected: usize,
    #[serde(alias = "version_collisions")]
    pub version_collisions: usize,
    pub conflicts: Vec<NexusAuthorityConflict>,
}

/// Structured result of querying an ingested `.xlsx` or `.csv` sheet inside `DriveNexusVault`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusSheetQueryResult {
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    #[serde(alias = "workbook_path")]
    pub workbook_path: String,
    #[serde(alias = "sheet_name")]
    pub sheet_name: String,
    pub headers: Vec<String>,
    #[serde(alias = "total_rows")]
    pub total_rows: usize,
    pub rows: Vec<BTreeMap<String, String>>,
    pub formulas: BTreeMap<String, String>,
}

/// DLP and authority hygiene audit report for a `DriveNexusVault` workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusAuditReport {
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    #[serde(alias = "total_findings")]
    pub total_findings: usize,
    #[serde(alias = "by_category")]
    pub by_category: BTreeMap<String, usize>,
    pub findings: Vec<DlpFinding>,
    pub conflicts: Vec<NexusAuthorityConflict>,
    pub clean: bool,
}
