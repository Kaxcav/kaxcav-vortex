//! Comprehensive unit, integration, and `proptest` property tests for `vortex-core`.

use proptest::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;
use vortex_core::{
    ArchBoundaryRule, AstParser, ContextFidelity, ContextRequest, CsrGraph, CustomInvariant,
    DlpCategory, DlpScanner, DriveNexusVault, EditSymbolRequest, FailureSlicer, KvxIgnore,
    LockMode, OutlineScope, RefConfidence, RenameSymbolRequest, SearchVia, SliceLevel,
    SubmodularPacker, SymbolEditOp, SymbolEditor, TwoPhaseRenamer, VortexEngine, VortexError,
    VortexShard,
};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[test]
fn multi_language_treesitter_and_lexical_extraction() {
    let parser = AstParser::new();
    assert_eq!(AstParser::supported_tree_sitter_languages().len(), 10);

    // 1. Rust
    let rs_src = r#"
use crate::db::Pool;

/// Handles order creation.
pub struct OrderService {
    pool: Pool,
}

impl OrderService {
    pub fn process(&self, amount: i64) -> bool {
        if amount > 0 && amount < 10_000 {
            true
        } else {
            false
        }
    }
}

pub fn build_router() {
    let app = Router::new().route("/api/orders", post(create_order));
}
"#;
    assert!(!AstParser::has_syntax_errors("rs", rs_src));
    assert!(AstParser::has_syntax_errors("rs", "pub fn broken( {"));
    let rs_parsed = parser.parse_file("src/orders.rs", "rs", rs_src);
    assert!(rs_parsed
        .symbols
        .iter()
        .any(|s| s.name == "OrderService" && s.kind == "struct" && s.exported));
    let method = rs_parsed
        .symbols
        .iter()
        .find(|s| s.qualified_name == "OrderService::process")
        .expect("Rust impl method should be qualified as OrderService::process");
    assert_eq!(method.kind, "method");
    assert!(method.complexity >= 3);
    assert!(rs_parsed
        .routes
        .iter()
        .any(|r| r.direction == "expose" && r.method == "POST" && r.route_path == "/api/orders"));

    // 2. TypeScript & TSX
    let ts_src = r#"
import { OrderDto } from "./dto";

export interface PaymentGateway {
    charge(dto: OrderDto): Promise<boolean>;
}

export class StripeGateway {
    async charge(dto: OrderDto): Promise<boolean> {
        const res = await fetch("/api/orders");
        return res.ok;
    }
}

export const registerRoutes = (app: Express) => {
    app.get("/api/health", healthHandler);
};
"#;
    assert!(!AstParser::has_syntax_errors("ts", ts_src));
    let ts_parsed = parser.parse_file("src/gateway.ts", "ts", ts_src);
    assert!(ts_parsed
        .symbols
        .iter()
        .any(|s| s.name == "PaymentGateway" && s.kind == "interface" && s.exported));
    assert!(ts_parsed
        .symbols
        .iter()
        .any(|s| s.qualified_name == "StripeGateway.charge" && s.kind == "method"));
    assert!(ts_parsed
        .symbols
        .iter()
        .any(|s| s.name == "registerRoutes" && s.kind == "function" && s.exported));
    assert!(ts_parsed
        .routes
        .iter()
        .any(|r| r.direction == "consume" && r.route_path == "/api/orders"));
    assert!(ts_parsed
        .routes
        .iter()
        .any(|r| r.direction == "expose" && r.route_path == "/api/health"));
    assert!(ts_parsed
        .references
        .iter()
        .any(|r| r.symbol_name == "OrderDto" && r.confidence == RefConfidence::Imported));

    let tsx_src = r#"export function Badge({ label }: { label: string }) { return <span>{label}</span>; }"#;
    assert!(!AstParser::has_syntax_errors("tsx", tsx_src));
    let tsx_parsed = parser.parse_file("src/Badge.tsx", "tsx", tsx_src);
    assert_eq!(tsx_parsed.symbols.len(), 1);

    // 3. JavaScript
    let js_src = r#"
const util = require("./util");
export function computeTotal(items) {
    let sum = 0;
    for (const x of items) { sum += x; }
    return sum;
}
"#;
    let js_parsed = parser.parse_file("src/math.js", "js", js_src);
    assert!(js_parsed.symbols.iter().any(|s| s.name == "computeTotal"));
    assert!(js_parsed.edges.iter().any(|e| e.raw_target == "./util"));

    // 4. Python
    let py_src = r#"
from services.auth import verify_token

class BillingController:
    def create_invoice(self, token: str):
        if verify_token(token):
            return True
        return False

@app.get("/api/invoices")
def list_invoices():
    return []
"#;
    assert!(!AstParser::has_syntax_errors("py", py_src));
    let py_parsed = parser.parse_file("app/billing.py", "py", py_src);
    assert!(py_parsed
        .symbols
        .iter()
        .any(|s| s.qualified_name == "BillingController.create_invoice"));
    assert!(py_parsed
        .routes
        .iter()
        .any(|r| r.direction == "expose" && r.route_path == "/api/invoices"));

    // 5. Go
    let go_src = r#"
package server

import "net/http"

type Hub struct {}

func (h *Hub) Broadcast(msg string) {}
func internalHelper() {}
"#;
    assert!(!AstParser::has_syntax_errors("go", go_src));
    let go_parsed = parser.parse_file("server/hub.go", "go", go_src);
    assert!(go_parsed
        .symbols
        .iter()
        .any(|s| s.qualified_name == "Hub.Broadcast" && s.exported));
    assert!(go_parsed
        .symbols
        .iter()
        .any(|s| s.name == "internalHelper" && !s.exported));

    // 6. Bash & JSON
    let sh_src = "source ./common.sh\nrun_pipeline() {\n  echo ok\n}\n";
    let sh_parsed = parser.parse_file("scripts/run.sh", "sh", sh_src);
    assert!(sh_parsed.symbols.iter().any(|s| s.name == "run_pipeline"));
    assert!(sh_parsed.edges.iter().any(|e| e.raw_target == "./common.sh"));

    let json_src = r#"{"name": "vortex", "version": "4.0.0"}"#;
    let json_parsed = parser.parse_file("package.json", "json", json_src);
    assert_eq!(json_parsed.symbols.len(), 2);

    // 7. Lexical formats (.sql, .md, .yaml, .toml, .c, .java)
    let sql_src = "CREATE TABLE accounts (id INT PRIMARY KEY);\nCREATE TABLE ledgers (acc_id INT REFERENCES accounts(id));";
    let sql_parsed = parser.parse_file("schema.sql", "sql", sql_src);
    assert_eq!(sql_parsed.symbols.len(), 2);
    assert!(sql_parsed.edges.iter().any(|e| e.kind == "sql_ref" && e.raw_target == "accounts"));

    let md_src = "# Overview\nSee [Spec](./spec.md)\n## Details\nBody\n";
    let md_parsed = parser.parse_file("README.md", "md", md_src);
    assert_eq!(md_parsed.symbols.len(), 2);
    assert!(md_parsed.edges.iter().any(|e| e.raw_target == "./spec.md"));

    let toml_parsed = parser.parse_file("cfg.toml", "toml", "[server]\nport = 8080\n");
    assert_eq!(toml_parsed.symbols[0].name, "server");

    let yaml_parsed = parser.parse_file("cfg.yaml", "yaml", "service:\n  port: 8080\n");
    assert_eq!(yaml_parsed.symbols[0].name, "service");

    let java_parsed = parser.parse_file(
        "App.java",
        "java",
        "import java.util.List;\npublic class App {\n  public void start() {}\n}\n",
    );
    assert!(java_parsed.symbols.iter().any(|s| s.name == "App"));
}

#[test]
fn kvxignore_and_yaml_policy_refusal() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(".kvxignore"),
        "secrets/**\n*.bak\n!secrets/public.txt\n",
    )
    .unwrap();
    fs::write(
        dir.path().join(".kvx.yaml"),
        "ignore:\n  - generated/**\nmaxFileBytes: 65536\n",
    )
    .unwrap();

    let policy = KvxIgnore::load(dir.path()).unwrap();
    assert_eq!(policy.max_file_bytes(), 65536);
    assert!(policy.check_not_ignored(Path::new("node_modules/pkg/index.js")).is_err());
    assert!(policy.check_not_ignored(Path::new(".fabrica/worktrees/w1/lib.rs")).is_err());
    assert!(policy.check_not_ignored(Path::new("secrets/private.key")).is_err());
    assert!(policy.check_not_ignored(Path::new("secrets/public.txt")).is_ok());
    assert!(policy.check_not_ignored(Path::new("generated/proto.rs")).is_err());
    assert!(policy.check_not_ignored(Path::new("src/main.rs")).is_ok());
}

#[test]
fn incremental_sync_fts5_search_fallback_and_contract_drift() {
    let repo = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();

    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::create_dir_all(repo.path().join("tests")).unwrap();
    fs::write(repo.path().join(".kvxignore"), "ignored/**\n").unwrap();
    fs::create_dir_all(repo.path().join("ignored")).unwrap();
    fs::write(repo.path().join("ignored/skip.rs"), "pub fn skipped() {}\n").unwrap();

    fs::write(
        repo.path().join("src/lib.rs"),
        "pub mod calc;\npub use crate::calc::compute_invoice_tax;\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("src/calc.rs"),
        r#"/// Computes invoice tax in basis points.
pub fn compute_invoice_tax(subtotal: u64) -> u64 {
    let magic_phrase = "RARE_LITERAL_SENTINEL_9942";
    let _ = magic_phrase;
    subtotal / 10
}
"#,
    )
    .unwrap();
    fs::write(
        repo.path().join("tests/calc_test.rs"),
        "use crate::calc::compute_invoice_tax;\nfn test_tax() { let _ = compute_invoice_tax(100); }\n",
    )
    .unwrap();

    let engine = VortexEngine::for_repo(repo.path(), store.path()).unwrap();

    // Second sync with zero file changes skips re-parsing
    let sync2 = engine.sync_repo(None, false).unwrap();
    assert_eq!(sync2.files_updated, 0);
    assert_eq!(sync2.files_unchanged, 3);

    // 1. FTS5 search
    let fts_res = engine.search(None, "compute_invoice_tax", 10).unwrap();
    assert_eq!(fts_res.via, SearchVia::Indice);
    assert!(!fts_res.hits.is_empty());
    assert_eq!(fts_res.hits[0].name, "compute_invoice_tax");

    // 2. Textual fallback search
    let txt_res = engine.search(None, "RARE_LITERAL_SENTINEL_9942", 10).unwrap();
    assert_eq!(txt_res.via, SearchVia::BuscaTextual);
    assert_eq!(txt_res.hits.len(), 1);
    assert_eq!(txt_res.hits[0].file_path, "src/calc.rs");

    // 3. Empty search is NEVER silent
    let none_res = engine
        .search(None, "NON_EXISTENT_QUANTUM_WIDGET_XYZ", 10)
        .unwrap();
    assert_eq!(none_res.via, SearchVia::Nenhum);
    assert!(none_res.hits.is_empty());
    assert!(!none_res.reason.trim().is_empty());

    // 4. Refusal on .kvxignore
    let ignored_err = engine
        .file_outline(None, "ignored/skip.rs", OutlineScope::Tudo)
        .unwrap_err();
    assert!(matches!(ignored_err, VortexError::KvxIgnored { .. }));

    // 5. Modify exported contract signature -> diff_impact detects contract drift before & after sync!
    fs::write(
        repo.path().join("src/calc.rs"),
        "pub fn compute_invoice_tax(subtotal: u64, rate_bps: u64) -> u64 {\n    subtotal * rate_bps / 10_000\n}\n",
    )
    .unwrap();

    let changed = vec!["src/calc.rs".to_string()];
    let drift_live = engine.diff_impact(None, Some(&changed)).unwrap();
    assert_eq!(drift_live.contract_drifts.len(), 1);
    assert_eq!(drift_live.contract_drifts[0].change_kind, "signature_changed");
    assert!(drift_live.impacted_files.contains(&"src/lib.rs".to_string()));
    assert!(drift_live
        .affected_tests
        .contains(&"tests/calc_test.rs".to_string()));

    // Sync records previous signature in symbol_history, so diff_impact still reports drift!
    engine.sync_repo(None, true).unwrap();
    let drift_after_sync = engine.diff_impact(None, Some(&changed)).unwrap();
    assert_eq!(drift_after_sync.contract_drifts.len(), 1);
    assert_eq!(
        drift_after_sync.contract_drifts[0].change_kind,
        "signature_changed"
    );
}

#[test]
fn tarjan_cycles_arch_firewall_git_cochange_and_federation() {
    // 1. Tarjan SCC cycle detection on CsrGraph
    let nodes = vec![
        "a.rs".to_string(),
        "b.rs".to_string(),
        "c.rs".to_string(),
        "leaf.rs".to_string(),
    ];
    let edges = vec![(0, 1, 1.0), (1, 2, 1.0), (2, 0, 1.0), (2, 3, 1.0)];
    let csr = CsrGraph::from_parts(nodes, &edges);
    let tarjan = csr.tarjan_scc();
    assert_eq!(tarjan.cycles.len(), 1);
    assert_eq!(tarjan.cycles[0].size, 3);
    assert_eq!(
        tarjan.cycles[0].members,
        vec!["a.rs".to_string(), "b.rs".to_string(), "c.rs".to_string()]
    );

    // 2. Architecture Layer Firewall + Git Co-change mining
    let repo_a = TempDir::new().unwrap();
    let repo_b = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();

    fs::create_dir_all(repo_a.path().join("src/ui")).unwrap();
    fs::create_dir_all(repo_a.path().join("src/db")).unwrap();
    fs::create_dir_all(repo_a.path().join("src/api")).unwrap();

    fs::write(
        repo_a.path().join("src/db/pool.ts"),
        "export function queryDb() { return []; }\n",
    )
    .unwrap();
    fs::write(
        repo_a.path().join("src/ui/View.tsx"),
        "import { queryDb } from '../db/pool';\nexport function View() { return queryDb(); }\n",
    )
    .unwrap();
    fs::write(
        repo_a.path().join("src/api/server.ts"),
        "export interface SharedInvoice { id: string; }\nexport function mount(app: any) { app.get('/api/invoices/:id', getInv); }\n",
    )
    .unwrap();

    // Initialize real Git repo with 2 co-changing commits
    let _ = Command::new("git")
        .arg("init")
        .current_dir(repo_a.path())
        .output();
    let _ = Command::new("git")
        .args(["config", "user.email", "test@kaxcav.com"])
        .current_dir(repo_a.path())
        .output();
    let _ = Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(repo_a.path())
        .output();
    let _ = Command::new("git")
        .args(["add", "."])
        .current_dir(repo_a.path())
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(repo_a.path())
        .output();

    fs::write(
        repo_a.path().join("src/db/pool.ts"),
        "export function queryDb() { return [1]; }\n",
    )
    .unwrap();
    fs::write(
        repo_a.path().join("src/api/server.ts"),
        "export interface SharedInvoice { id: string; total: number; }\nexport function mount(app: any) { app.get('/api/invoices/:id', getInv); }\n",
    )
    .unwrap();
    let _ = Command::new("git")
        .args(["add", "."])
        .current_dir(repo_a.path())
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", "cochange db and api"])
        .current_dir(repo_a.path())
        .output();

    // Frontend repo B consuming GET /api/invoices/42 and declaring SharedInvoice
    fs::create_dir_all(repo_b.path().join("src")).unwrap();
    fs::write(
        repo_b.path().join("src/client.ts"),
        "export interface SharedInvoice { id: string; total: number; }\nexport async function loadInvoice() { return axios.get('/api/invoices/42'); }\n",
    )
    .unwrap();

    let engine = VortexEngine::new(Some(store.path().to_path_buf())).unwrap();
    engine.add_repo(Some("backend"), repo_a.path(), true).unwrap();
    engine
        .add_repo(Some("frontend"), repo_b.path(), true)
        .unwrap();

    let violations = engine
        .check_architecture(
            Some("backend"),
            &[ArchBoundaryRule {
                id: "custom-no-api-to-ui".to_string(),
                from_glob: "src/api/**".to_string(),
                forbid_to_glob: "src/ui/**".to_string(),
                reason: "API cannot depend on UI".to_string(),
            }],
        )
        .unwrap();
    assert!(
        violations
            .iter()
            .any(|v| v.rule_id == "builtin-ui-no-db" && v.from_file == "src/ui/View.tsx"),
        "Built-in ui -> db firewall must catch src/ui/View.tsx importing src/db/pool.ts"
    );

    let br = engine
        .blast_radius(Some("backend"), "src/db/pool.ts", 4)
        .unwrap();
    assert!(br
        .direct_dependents
        .contains(&"src/ui/View.tsx".to_string()));
    assert!(br
        .co_changed
        .iter()
        .any(|c| c.file_path == "src/api/server.ts"));

    let links = engine.federate().unwrap();
    assert!(links.iter().any(|l| l.kind == "http_route"
        && l.source_repo == "frontend"
        && l.target_repo == "backend"));
    assert!(links
        .iter()
        .any(|l| l.kind == "shared_contract" && l.source_symbol == "SharedInvoice"));
}

#[test]
fn submodular_packer_etag_delta_and_reuse_enforcer() {
    let repo = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join("src/crypto.rs"),
        r#"/// Computes canonical blake3 digest for payloads.
pub fn compute_digest(payload: &[u8]) -> String {
    blake3::hash(payload).to_hex().to_string()
}

/// Verifies payload digest equality.
pub fn verify_digest(payload: &[u8], expected: &str) -> bool {
    compute_digest(payload) == expected
}
"#,
    )
    .unwrap();
    fs::write(
        repo.path().join("src/auth.rs"),
        r#"use crate::crypto::verify_digest;
pub fn authenticate_request(body: &[u8], sig: &str) -> bool {
    verify_digest(body, sig)
}
"#,
    )
    .unwrap();

    let engine = VortexEngine::for_repo(repo.path(), store.path()).unwrap();
    let pack1 = engine
        .context(&ContextRequest {
            task: "verify_digest authenticate_request".to_string(),
            token_budget: Some(600),
            fidelity: Some(ContextFidelity::Graded),
            ..Default::default()
        })
        .unwrap();

    assert!(pack1.token_count <= 600);
    assert!(!pack1.unchanged);
    assert!(!pack1.slices.is_empty());
    assert!(!pack1.reusable_symbols.is_empty());

    // ETag conditional short-circuit
    let pack_cached = engine
        .context(&ContextRequest {
            task: "verify_digest authenticate_request".to_string(),
            token_budget: Some(600),
            fidelity: Some(ContextFidelity::Graded),
            if_none_match: Some(pack1.etag.clone()),
            ..Default::default()
        })
        .unwrap();
    assert!(pack_cached.unchanged);
    assert_eq!(pack_cached.token_count, 0);

    // Delta mode emits L0_DELTA for unchanged symbols
    let pack_delta = engine
        .context(&ContextRequest {
            task: "verify_digest authenticate_request".to_string(),
            token_budget: Some(600),
            fidelity: Some(ContextFidelity::Graded),
            delta_from: Some(pack1.etag.clone()),
            ..Default::default()
        })
        .unwrap();
    assert!(pack_delta
        .slices
        .iter()
        .all(|s| s.level == SliceLevel::L0Delta));
}

#[test]
fn failure_slicer_multi_ecosystem_dedup_and_deterministic_signature() {
    let repo = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join("src/math.rs"),
        "pub fn add(a: i32, b: i32) -> i32 {\n    let bad: String = 42;\n    a + b\n}\n",
    )
    .unwrap();
    let shard = VortexShard::open("demo", repo.path(), &store.path().join("s.sqlite")).unwrap();
    shard.sync(false).unwrap();

    let mut noisy_rustc = String::from(
        "\x1b[31merror[E0308]\x1b[0m: mismatched types\n  --> src/math.rs:2:23\n   |\n2  |     let bad: String = 42;\n   |                       ^^ expected `String`, found integer\n",
    );
    // Repeat cascading duplicate errors + stack noise
    for _ in 0..30 {
        noisy_rustc.push_str(
            "error[E0308]: mismatched types\n  --> src/math.rs:2:23\nnote: noisy trace at /tmp/.tmpAbCd12/run 2026-11-14T23:00:01Z 0x7fff1234abcd (12.4ms)\n",
        );
    }

    let sliced1 = FailureSlicer::slice(&noisy_rustc, None, Some(&shard)).unwrap();
    assert!(sliced1.tokens_after <= 300);
    assert!(sliced1.deduplicated_count >= 29);
    assert_eq!(sliced1.root_errors.len(), 1);
    assert_eq!(sliced1.root_errors[0].code.as_deref(), Some("E0308"));
    assert!(sliced1.root_errors[0].symbol_snippet.is_some());

    // Volatile timestamps/tmp/hex must NOT change signature_blake3
    let noisy_rustc_run2 = noisy_rustc
        .replace("/tmp/.tmpAbCd12/", "/tmp/.tmpZzYy99/")
        .replace("2026-11-14T23:00:01Z", "2026-11-15T04:55:19Z")
        .replace("0x7fff1234abcd", "0x7fff99990000");
    let sliced2 = FailureSlicer::slice(&noisy_rustc_run2, None, Some(&shard)).unwrap();
    assert_eq!(sliced1.signature_blake3, sliced2.signature_blake3);

    // Check tsc, vitest, pytest, go test parsers
    let multi_log = r#"
src/app.ts(14,5): error TS2322: Type 'number' is not assignable to type 'string'.
AssertionError: expected 200 to equal 404
    at Object.<anonymous> (src/api.test.ts:28:12)
FAILED tests/test_auth.py::test_login - AssertionError: invalid token
--- FAIL: TestConsensus (0.03s)
    consensus_test.go:55: quorum not reached
"#;
    let multi_res = FailureSlicer::slice(multi_log, Some(300), None).unwrap();
    assert!(multi_res.tokens_after <= 300);
    let tools: HashSet<&str> = multi_res
        .root_errors
        .iter()
        .map(|e| e.tool.as_str())
        .collect();
    assert!(tools.contains("tsc"));
    assert!(tools.contains("vitest"));
    assert!(tools.contains("pytest"));
    assert!(tools.contains("go_test"));

    // >8 MiB guard
    let huge = "x".repeat(8 * 1024 * 1024 + 16);
    assert!(matches!(
        FailureSlicer::slice(&huge, None, None),
        Err(VortexError::InvalidInput(_))
    ));
}

#[test]
fn symbol_editor_guards_crlf_bom_locks_and_two_phase_rename() {
    let repo = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();

    // Write file with UTF-8 BOM + CRLF line endings
    let initial_lib = "\u{feff}pub fn calculate_fee(amount: u64) -> u64 {\r\n    amount / 20\r\n}\r\n\r\npub fn frozen_fn() -> u32 {\r\n    7\r\n}\r\n";
    fs::write(repo.path().join("src/lib.rs"), initial_lib).unwrap();
    fs::write(
        repo.path().join("src/caller.rs"),
        "use crate::calculate_fee;\npub fn checkout() -> u64 {\n    calculate_fee(500)\n}\n",
    )
    .unwrap();

    let shard = VortexShard::open("edit-repo", repo.path(), &store.path().join("e.sqlite")).unwrap();
    shard.sync(false).unwrap();

    let sym = shard
        .read_symbol("calculate_fee", Some("src/lib.rs"))
        .unwrap()
        .matches
        .remove(0)
        .symbol;

    // 1. Stale expected_hash is refused
    let bad_hash_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn calculate_fee(amount: u64) -> u64 {\n    amount / 10\n}".to_string(),
            expected_hash: Some("0000deadbeef".to_string()),
            allow_syntax_errors: false,
            dry_run: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(bad_hash_err, VortexError::HashMismatch { .. }));

    // 2. Syntax error introduction is refused and disk remains untouched
    let syn_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn calculate_fee(amount: u64) -> {".to_string(),
            expected_hash: Some(sym.body_hash.clone()),
            allow_syntax_errors: false,
            dry_run: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(syn_err, VortexError::SyntaxError { .. }));
    assert_eq!(
        fs::read_to_string(repo.path().join("src/lib.rs")).unwrap(),
        initial_lib
    );

    // 3. Lock enforcement: Frozen vs AllowBodyOnly
    shard
        .lock_symbol(
            "frozen_fn",
            Some("src/lib.rs"),
            LockMode::Frozen,
            "architect",
            "immutable ABI",
        )
        .unwrap();
    let frozen_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "frozen_fn".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn frozen_fn() -> u32 {\n    99\n}".to_string(),
            expected_hash: None,
            allow_syntax_errors: false,
            dry_run: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(frozen_err, VortexError::LockViolation { .. }));

    shard
        .lock_symbol(
            "calculate_fee",
            Some("src/lib.rs"),
            LockMode::AllowBodyOnly,
            "lead",
            "pin contract signature",
        )
        .unwrap();

    // Signature change under AllowBodyOnly -> refused!
    let sig_lock_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn calculate_fee(amount: u64, extra: u64) -> u64 {\n    amount + extra\n}"
                .to_string(),
            expected_hash: Some(sym.body_hash.clone()),
            allow_syntax_errors: false,
            dry_run: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(sig_lock_err, VortexError::LockViolation { .. }));

    // Body-only change under AllowBodyOnly -> succeeds AND preserves UTF-8 BOM + CRLF!
    let ok_edit = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn calculate_fee(amount: u64) -> u64 {\n    amount / 10\n}".to_string(),
            expected_hash: Some(sym.body_hash),
            allow_syntax_errors: false,
            dry_run: false,
        },
        &[],
    )
    .unwrap();
    assert!(ok_edit.applied);
    let disk_after = fs::read_to_string(repo.path().join("src/lib.rs")).unwrap();
    assert!(disk_after.starts_with('\u{feff}'));
    assert!(disk_after.contains("\r\n"));
    assert!(disk_after.contains("amount / 10"));

    // Unlock calculate_fee and run TwoPhaseRenamer round-trip
    shard.unlock_symbol("calculate_fee").unwrap();

    let phase1 = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            new_name: "compute_platform_fee".to_string(),
            plan_token: None,
            include_name_only: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    assert_eq!(phase1.phase, "planned");
    assert!(!phase1.applied);
    assert_eq!(phase1.files_touched.len(), 2);

    // Tamper with caller.rs -> Phase 2 must reject stale plan_token!
    let caller_orig = fs::read_to_string(repo.path().join("src/caller.rs")).unwrap();
    fs::write(
        repo.path().join("src/caller.rs"),
        format!("{caller_orig}\n// concurrent modification\n"),
    )
    .unwrap();
    let stale_err = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            new_name: "compute_platform_fee".to_string(),
            plan_token: Some(phase1.plan_token.clone()),
            include_name_only: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(stale_err, VortexError::StalePlanToken { .. }));

    // Restore caller.rs -> Phase 2 succeeds atomically!
    fs::write(repo.path().join("src/caller.rs"), caller_orig).unwrap();
    let phase2 = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "calculate_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            new_name: "compute_platform_fee".to_string(),
            plan_token: Some(phase1.plan_token),
            include_name_only: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    assert!(phase2.applied);
    assert!(fs::read_to_string(repo.path().join("src/caller.rs"))
        .unwrap()
        .contains("compute_platform_fee(500)"));
    assert!(shard
        .read_symbol("compute_platform_fee", Some("src/lib.rs"))
        .unwrap()
        .found);
}

#[test]
fn dlp_all_15_categories_placeholders_and_allowlist_reason_guard() {
    assert_eq!(DlpScanner::categories().len(), 15);

    // Construct synthetic test tokens dynamically so static scanners never flag test source
    let samples: Vec<(DlpCategory, String)> = vec![
        (
            DlpCategory::AppsheetAccessKey,
            format!("key = V2-{}-abcde-12345-fghij-67890-klmno-12345-pqrst", "98765"),
        ),
        (
            DlpCategory::AppsheetAppId,
            "url = https://api.appsheet.com/api/v2/apps/123e4567-e89b-12d3-a456-426614174000/tables".to_string(),
        ),
        (
            DlpCategory::GoogleApiKey,
            format!("gcp = {}{}", "AIzaSy", "D9a8B7c6D5e4F3g2H1i0J9k8L7m6N5o4P"),
        ),
        (
            DlpCategory::GoogleOauthToken,
            format!("tok = {}{}", "ya29.", "a0AfH6SMBx9y8z7w6v5u4t3s2r1q0p9o8n"),
        ),
        (
            DlpCategory::DriveResourceId,
            "DRIVE_FOLDER_ID = \"1AbCdEfGhIjKlMnOpQrStUvWxYz012345\"".to_string(),
        ),
        (
            DlpCategory::GenericSecret,
            "client_secret = \"super_confidential_prod_val_99\"".to_string(),
        ),
        (
            DlpCategory::PrivateKeyPem,
            format!("-----BEGIN {}PRIVATE KEY-----", "RSA "),
        ),
        (
            DlpCategory::PiiCpfCnpj,
            "cpf = 123.456.789-01".to_string(),
        ),
        (
            DlpCategory::AnthropicKey,
            format!("ant = {}{}", "sk-ant-api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz1234"),
        ),
        (
            DlpCategory::OpenaiKey,
            format!("oai = {}{}", "sk-proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz123456"),
        ),
        (
            DlpCategory::GithubPat,
            format!("gh = {}{}", "ghp_", "1234567890abcdefghijklmnopqrstuvwx"),
        ),
        (
            DlpCategory::AwsKey,
            format!("aws = {}{}", "AKIA", "IOSFODNN7REALKEY"),
        ),
        (
            DlpCategory::JwtToken,
            format!(
                "jwt = {}.{}.{}",
                "eyJhbGciOiJIUzI1NiJ9",
                "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
                "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
            ),
        ),
        (
            DlpCategory::DbUri,
            "postgres://admin:S3cr3tP4ss!@db.internal.local:5432/prod".to_string(),
        ),
        (
            DlpCategory::SlackToken,
            format!("slack = {}{}", "xoxb-", "123456789012-abcdefABCDEF1234"),
        ),
    ];

    let scanner = DlpScanner::new();
    for (expected_cat, payload) in &samples {
        let (redacted, findings) = scanner.scan_and_redact("src/config.ts", payload);
        assert!(
            findings.iter().any(|f| f.category == *expected_cat),
            "Expected DLP category {:?} to fire on '{}', got {:?}",
            expected_cat,
            payload,
            findings
        );
        assert!(redacted.contains(&format!("[REDACTED:{}]", expected_cat.as_str())));
    }

    // Placeholders must produce 0 findings
    let placeholders = r#"
client_secret = "<YOUR_CLIENT_SECRET>"
client_secret = "${ENV_SECRET_VALUE}"
cpf = 000.000.000-00
postgres://user:${DB_PASS}@localhost:5432/app
"#;
    assert!(scanner.scan_text("src/example.env", placeholders).is_empty());

    // Allowlist mandatory reason validation
    let repo_bad = TempDir::new().unwrap();
    fs::write(
        repo_bad.path().join(".fabrica-dlp-allow.json"),
        r#"{"allow": [{"rule": "aws_key", "paths": ["legacy/**"], "reason": "   "}]}"#,
    )
    .unwrap();
    assert!(DlpScanner::from_repo(repo_bad.path()).is_err());

    let repo_ok = TempDir::new().unwrap();
    fs::write(
        repo_ok.path().join(".fabrica-dlp-allow.json"),
        r#"{"allow": [{"rule": "aws_key", "paths": ["legacy/**"], "reason": "Rotated sandbox ID documented in ADR-09"}]}"#,
    )
    .unwrap();
    let allowed_scanner = DlpScanner::from_repo(repo_ok.path()).unwrap();
    let aws_line = format!("aws = {}{}", "AKIA", "IOSFODNN7REALKEY");
    assert!(allowed_scanner
        .scan_text("legacy/old.txt", &aws_line)
        .is_empty());
    assert_eq!(
        allowed_scanner
            .scan_text("src/prod.txt", &aws_line)
            .len(),
        1
    );
}

#[test]
fn drive_nexus_xlsx_docx_dlp_and_duplicate_version_collision_detection() {
    let ws_dir = TempDir::new().unwrap();
    let vault_dir = TempDir::new().unwrap();

    let secret_aws = format!("{}{}", "AKIA", "IOSFODNN7REALKEY");
    let xlsx_v1 = build_synthetic_xlsx(&[
        ("Item", "Amount", "Notes"),
        ("Server", "1200", &format!("Key {secret_aws}")),
        ("Storage", "300", "Clean row"),
    ]);
    let xlsx_v2 = build_synthetic_xlsx(&[
        ("Item", "Amount", "Notes"),
        ("Server", "1500", "Updated price"),
    ]);
    let docx_bytes = build_synthetic_docx("SLA Fee Rate: 15% canonical contract policy");

    fs::create_dir_all(ws_dir.path().join("backup")).unwrap();
    fs::write(ws_dir.path().join("pricing.xlsx"), &xlsx_v1).unwrap();
    // Exact SHA-256 duplicate in another folder
    fs::write(ws_dir.path().join("backup/pricing_mirror.xlsx"), &xlsx_v1).unwrap();
    // Version collision (same stem `pricing` + `.xlsx`, different SHA-256)
    fs::write(ws_dir.path().join("pricing (1).xlsx"), &xlsx_v2).unwrap();
    // Canonical .docx + legacy conflicting .md
    fs::write(ws_dir.path().join("policy.docx"), &docx_bytes).unwrap();
    fs::write(
        ws_dir.path().join("backup/legacy_policy.md"),
        "Old SLA Fee Rate: 8% obsolete rule\n",
    )
    .unwrap();

    let vault = DriveNexusVault::open(vault_dir.path()).unwrap();
    vault
        .register_invariant(&CustomInvariant {
            id: "inv-sla-rate".to_string(),
            workspace_id: "fin-ws".to_string(),
            title: "Canonical 15% SLA fee".to_string(),
            canonical_pattern: r"15%".to_string(),
            forbidden_pattern: r"8%".to_string(),
            severity: "high".to_string(),
        })
        .unwrap();

    let res = vault
        .ingest_directory("fin-ws", ws_dir.path(), Some("folder_abc123"))
        .unwrap();

    assert_eq!(res.files_ingested, 5);
    assert!(res.sheets_indexed >= 3);
    assert!(res.dlp_redactions >= 2);
    assert!(res.duplicates_detected >= 1);
    assert!(res.version_collisions >= 1);
    assert!(res.conflicts.iter().any(|c| c.kind == "exact_duplicate"));
    assert!(res.conflicts.iter().any(|c| c.kind == "version_collision"));
    assert!(res.conflicts.iter().any(|c| c.kind == "invariant_violation"));

    let sheets = vault
        .query_sheet("fin-ws", Some("pricing.xlsx"), Some("Budget"), None, 50)
        .unwrap();
    assert_eq!(sheets.len(), 1);
    assert_eq!(sheets[0].headers, vec!["Item", "Amount", "Notes"]);
    assert_eq!(sheets[0].total_rows, 3);
    assert_eq!(
        sheets[0].formulas.get("B4").map(String::as_str),
        Some("=SUM(B2:B3)")
    );
    // Secret inside sheet cell must be redacted!
    let notes_cell = sheets[0].rows[0].get("Notes").unwrap();
    assert!(notes_cell.contains("[REDACTED:aws_key]"));
    assert!(!notes_cell.contains(&secret_aws));

    let audit = vault.audit_dlp("fin-ws").unwrap();
    assert!(!audit.clean);
    assert!(audit.total_findings >= 2);
    assert_eq!(vault.list_workspaces().unwrap().len(), 1);
}

#[test]
fn anti_slop_positive_detection_and_zero_slop_self_scan_over_vortex_core_src() {
    // 1. Verify scan_slop catches every slop category on synthetic bad code
    let bad_ts = format!(
        "// {} suppress error\n// {}: finish later\nexport function run(x: any) {{\n  try {{ work(); }} catch (e) {{}}\n}}\n",
        ["@ts-", "ignore"].concat(),
        ["TO", "DO"].concat()
    );
    let ts_slop = AstParser::scan_slop("src/bad.ts", "ts", &bad_ts);
    let kinds: HashSet<&str> = ts_slop.iter().map(|f| f.kind.as_str()).collect();
    assert!(kinds.contains("ts_ignore"));
    assert!(kinds.contains("unfinished_marker"));
    assert!(kinds.contains("explicit_any"));
    assert!(kinds.contains("empty_catch"));

    let bad_rs = format!("pub fn stub() {{ {}!() }}\n", ["to", "do"].concat());
    let rs_slop = AstParser::scan_slop("src/stub.rs", "rs", &bad_rs);
    assert!(rs_slop.iter().any(|f| f.kind == "panic_stub"));

    // 2. Self-scan over crates/vortex-core/src MUST return 0 slop findings and 0 syntax errors!
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");
    let store = TempDir::new().unwrap();
    let shard = VortexShard::open("vortex-core-self", &src_dir, &store.path().join("self.sqlite"))
        .unwrap();
    let sync = shard.sync(true).unwrap();
    assert!(
        sync.files_updated >= 12,
        "Expected all vortex-core/src/*.rs modules to be indexed, got {}",
        sync.files_updated
    );

    let self_slop = shard.scan_slop().unwrap();
    assert!(
        self_slop.is_empty(),
        "Expected ZERO slop findings in crates/vortex-core/src, but found: {self_slop:#?}"
    );

    for entry in fs::read_dir(&src_dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) == Some("rs") {
            let code = fs::read_to_string(&p).unwrap();
            let err_loc = AstParser::first_syntax_error("rs", &code);
            assert!(
                err_loc.is_none(),
                "Syntax error in {}: {:?}",
                p.display(),
                err_loc
            );
        }
    }
}

#[test]
fn engine_end_to_end_status_repomap_callgraph_insert_delete_and_json_shapes() {
    let repo = TempDir::new().unwrap();
    let store = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join("src/service.rs"),
        r#"pub fn helper_step(x: u32) -> u32 {
    x + 1
}

pub fn execute_workflow(input: u32) -> u32 {
    helper_step(input) * 2
}

fn private_unused() -> u32 {
    0
}
"#,
    )
    .unwrap();

    let engine = VortexEngine::for_repo(repo.path(), store.path()).unwrap();

    // OutlineScope::Exportado excludes private_unused
    let exported_outline = engine
        .file_outline(None, "src/service.rs", OutlineScope::Exportado)
        .unwrap();
    assert_eq!(exported_outline.symbols.len(), 2);
    assert!(exported_outline.fresh);

    // Call graph & find_references
    let cg = engine.call_graph(None, "helper_step").unwrap();
    assert_eq!(cg.definitions.len(), 1);
    assert!(cg.callers.iter().any(|c| c.symbol == "execute_workflow"));

    let refs = engine
        .find_references(None, "helper_step", Some("src/service.rs"), 20, false)
        .unwrap();
    assert_eq!(refs.total, 1);
    assert_eq!(refs.references[0].confidence, RefConfidence::SameFile);

    // RepoMap within strict budget
    let rmap = engine.repo_map(None, 250).unwrap();
    assert!(rmap.token_count <= 250);
    assert_eq!(rmap.files_included, 1);

    // InsertAfter + Delete via VortexEngine::edit_symbol
    let ins_res = engine
        .edit_symbol(
            None,
            &EditSymbolRequest {
                symbol: "helper_step".to_string(),
                file_path: Some("src/service.rs".to_string()),
                op: SymbolEditOp::InsertAfter,
                new_code: "\npub fn inserted_fn() -> bool {\n    true\n}".to_string(),
                expected_hash: None,
                allow_syntax_errors: false,
                dry_run: false,
            },
        )
        .unwrap();
    assert!(ins_res.applied);
    assert!(engine
        .read_symbol(None, "inserted_fn", Some("src/service.rs"))
        .unwrap()
        .found);

    let del_res = engine
        .edit_symbol(
            None,
            &EditSymbolRequest {
                symbol: "private_unused".to_string(),
                file_path: Some("src/service.rs".to_string()),
                op: SymbolEditOp::Delete,
                new_code: String::new(),
                expected_hash: None,
                allow_syntax_errors: false,
                dry_run: false,
            },
        )
        .unwrap();
    assert!(del_res.applied);
    assert!(!engine
        .read_symbol(None, "private_unused", Some("src/service.rs"))
        .unwrap()
        .found);

    // Status, index_health, slice_failure, JSON serialization check
    let health = engine.index_health(None).unwrap();
    assert!(health.healthy);
    assert!(health.symbols_indexed >= 3);

    let status = engine.status().unwrap();
    assert!(status.healthy);
    assert_eq!(status.shards.len(), 1);
    assert!(status.telemetry_events >= 1);

    let sliced = engine
        .slice_failure(
            "error[E0425]: cannot find value `missing` in this scope\n  --> src/service.rs:2:5\n",
            Some(120),
            None,
        )
        .unwrap();
    assert!(sliced.tokens_after <= 120);
    let sliced_json = serde_json::to_value(&sliced).unwrap();
    assert!(sliced_json.get("root_errors").is_some());
    assert!(sliced_json.get("signature_blake3").is_some());
    assert!(sliced_json.get("tokens_before").is_some());
    assert!(sliced_json.get("tokens_after").is_some());

    // CSV ingestion via engine.nexus()
    let csv_ws = TempDir::new().unwrap();
    fs::write(
        csv_ws.path().join("metrics.csv"),
        "service;latency_ms\nvortex;4\n",
    )
    .unwrap();
    let csv_ingest = engine
        .nexus()
        .ingest_directory("csv-ws", csv_ws.path(), None)
        .unwrap();
    assert_eq!(csv_ingest.sheets_indexed, 1);
    let csv_q = engine
        .nexus()
        .query_sheet("csv-ws", Some("metrics.csv"), None, Some("vortex"), 10)
        .unwrap();
    assert_eq!(csv_q[0].rows[0].get("latency_ms").map(String::as_str), Some("4"));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn prop_ppr_scores_sum_to_one(
        node_count in 1usize..28,
        raw_edges in prop::collection::vec((0usize..28, 0usize..28, 0.1f32..5.0f32), 0..80),
        raw_seeds in prop::collection::vec((0usize..28, 0.1f64..10.0f64), 1..10),
        damping in 0.05f64..0.95f64,
    ) {
        let nodes: Vec<String> = (0..node_count).map(|i| format!("n{i}.rs")).collect();
        let edges: Vec<(usize, usize, f32)> = raw_edges
            .into_iter()
            .map(|(u, v, w)| (u % node_count, v % node_count, w))
            .collect();
        let seeds: Vec<(usize, f64)> = raw_seeds
            .into_iter()
            .map(|(idx, w)| (idx % node_count, w))
            .collect();

        let graph = CsrGraph::from_parts(nodes, &edges);
        let ranks = graph.ppr(&seeds, damping, 40);
        prop_assert_eq!(ranks.len(), node_count);
        let sum: f64 = ranks.iter().sum();
        prop_assert!((sum - 1.0).abs() < 1e-6, "PPR sum {} deviated from 1.0", sum);
        prop_assert!(ranks.iter().all(|&r| r >= 0.0 && r.is_finite()));
    }

    #[test]
    fn prop_submodular_packer_never_exceeds_budget(budget in 16usize..1500usize) {
        let repo = TempDir::new().unwrap();
        let store = TempDir::new().unwrap();
        fs::create_dir_all(repo.path().join("src")).unwrap();
        fs::write(
            repo.path().join("src/a.rs"),
            "pub fn alpha_handler(x: usize) -> usize {\n    x.saturating_add(1)\n}\npub fn beta_handler(y: usize) -> usize {\n    alpha_handler(y) * 2\n}\n",
        ).unwrap();
        fs::write(
            repo.path().join("src/b.rs"),
            "use crate::a::beta_handler;\npub fn gamma_entry(z: usize) -> usize {\n    beta_handler(z) + 10\n}\n",
        ).unwrap();

        let shard = VortexShard::open("prop", repo.path(), &store.path().join("p.sqlite")).unwrap();
        shard.sync(false).unwrap();

        let pack = SubmodularPacker::new().pack(&shard, &ContextRequest {
            task: "alpha_handler gamma_entry".to_string(),
            token_budget: Some(budget),
            fidelity: Some(ContextFidelity::Graded),
            ..Default::default()
        }).unwrap();

        prop_assert_eq!(pack.budget_tokens, budget);
        prop_assert!(pack.token_count <= budget, "Pack tokens {} > budget {}", pack.token_count, budget);
    }

    #[test]
    fn prop_failure_slicer_respects_max_tokens(
        repeat_n in 1usize..25,
        max_toks in 12usize..350usize,
    ) {
        let mut raw = String::new();
        for i in 0..repeat_n {
            raw.push_str(&format!(
                "error[E0425]: cannot find value `var_{}` in this scope\n  --> src/mod_{}.rs:{}:9\n",
                i % 4,
                i % 3,
                10 + (i % 5)
            ));
        }
        let res = FailureSlicer::slice(&raw, Some(max_toks), None).unwrap();
        prop_assert!(
            res.tokens_after <= max_toks,
            "FailureSlicer tokens_after {} exceeded max_tokens {}",
            res.tokens_after,
            max_toks
        );
        prop_assert!(!res.root_errors.is_empty());
        prop_assert_eq!(res.signature_blake3.len(), 64);
    }
}

fn build_synthetic_xlsx(rows: &[(&str, &str, &str)]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default();

        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zip.write_all(rels_xml.as_bytes()).unwrap();

        let wb_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Budget" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"#;
        zip.start_file("xl/workbook.xml", opts).unwrap();
        zip.write_all(wb_xml.as_bytes()).unwrap();

        let mut shared: Vec<String> = Vec::new();
        let mut sheet_rows_xml = String::new();
        for (r_idx, (c1, c2, c3)) in rows.iter().enumerate() {
            let row_num = r_idx + 1;
            let idx1 = shared.len();
            shared.push(xml_escape(c1));
            let idx3 = shared.len();
            shared.push(xml_escape(c3));

            let c2_cell = if r_idx == 0 {
                let idx2 = shared.len();
                shared.push(xml_escape(c2));
                format!(r#"<c r="B{row_num}" t="s"><v>{idx2}</v></c>"#)
            } else {
                format!(r#"<c r="B{row_num}"><v>{c2}</v></c>"#)
            };

            sheet_rows_xml.push_str(&format!(
                r#"<row r="{row_num}"><c r="A{row_num}" t="s"><v>{idx1}</v></c>{c2_cell}<c r="C{row_num}" t="s"><v>{idx3}</v></c></row>"#
            ));
        }
        let total_row = rows.len() + 1;
        sheet_rows_xml.push_str(&format!(
            r#"<row r="{total_row}"><c r="B{total_row}"><f>SUM(B2:B3)</f><v>1500</v></c></row>"#
        ));

        let mut sst_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
        );
        for s in &shared {
            sst_xml.push_str(&format!("<si><t>{s}</t></si>"));
        }
        sst_xml.push_str("</sst>");
        zip.start_file("xl/sharedStrings.xml", opts).unwrap();
        zip.write_all(sst_xml.as_bytes()).unwrap();

        let ws_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_rows_xml}</sheetData></worksheet>"#
        );
        zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zip.write_all(ws_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    cursor.into_inner()
}

fn build_synthetic_docx(paragraph: &str) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default();
        let doc_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{}</w:t></w:r></w:p>
  </w:body>
</w:document>"#,
            xml_escape(paragraph)
        );
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(doc_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    cursor.into_inner()
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[test]
fn security_path_traversal_and_symlink_containment_refusal() {
    use std::os::unix::fs::symlink;
    use vortex_core::SymbolLock;

    // 1. DriveNexusVault workspace_id traversal & Drive-Slip sanitization
    let vault_tmp = TempDir::new().unwrap();
    let src_docs = TempDir::new().unwrap();
    let outside_secret_dir = TempDir::new().unwrap();
    fs::write(
        outside_secret_dir.path().join("top_secret.md"),
        "# Confidential Outside File\n",
    )
    .unwrap();
    fs::write(src_docs.path().join("legit.md"), "# Public Spec\n").unwrap();
    symlink(
        outside_secret_dir.path().join("top_secret.md"),
        src_docs.path().join("escaped_link.md"),
    )
    .unwrap();

    let vault = DriveNexusVault::open(&vault_tmp.path().join("vault")).unwrap();
    for bad_ws in ["", ".", "..", "../escape", "nested/ws", "nested\\ws", ".hidden", "bad..ws"] {
        let err = vault
            .ingest_directory(bad_ws, src_docs.path(), None)
            .unwrap_err();
        assert!(
            matches!(err, VortexError::InvalidInput(_)),
            "Expected InvalidInput for workspace_id '{bad_ws}', got {err:?}"
        );
        let sync_err = vault
            .sync_drive_folder(bad_ws, "1AbCdEfGhIjKlMnOpQrStUvWxYz", src_docs.path(), Some("dummy_key"))
            .unwrap_err();
        assert!(matches!(sync_err, VortexError::InvalidInput(_)));
    }

    // Drive-Slip folder/file title sanitization
    for malicious_title in ["", ".", "..", "...", "../../etc/passwd", "..\\..\\win.ini", "sub/../escape", "bad\0name"] {
        let res = DriveNexusVault::sanitize_drive_item_path("FolderA", malicious_title);
        assert!(
            res.is_err(),
            "Drive-Slip guard should reject malicious title '{malicious_title}', got {res:?}"
        );
    }
    let clean_drive_rel =
        DriveNexusVault::sanitize_drive_item_path("Finance", "Q1/Q2 Budget.xlsx").unwrap();
    assert_eq!(clean_drive_rel, "Finance/Q1_Q2 Budget.xlsx");

    // Ingesting src_docs must skip symlink pointing outside src_docs
    let ingest_ok = vault
        .ingest_directory("safe-ws", src_docs.path(), None)
        .unwrap();
    assert_eq!(ingest_ok.files_ingested, 1);
    assert!(!vault_tmp
        .path()
        .join("vault/twins/safe-ws/escaped_link.md.md")
        .exists());

    // 2. VortexShard, SymbolEditor, and TwoPhaseRenamer containment & .kvxignore guards
    let repo = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let outside_rs = outside.path().join("outside.rs");
    let outside_initial = "pub fn outside_fn() -> i32 {\n    42\n}\n";
    fs::write(&outside_rs, outside_initial).unwrap();

    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::create_dir_all(repo.path().join("blocked")).unwrap();
    fs::write(
        repo.path().join("src/safe.rs"),
        "pub fn safe_calc(v: i32) -> i32 {\n    v + 1\n}\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("src/swapped.rs"),
        "pub fn swapped_target() -> i32 {\n    10\n}\n",
    )
    .unwrap();
    let blocked_initial = "pub fn blocked_fn() -> i32 {\n    99\n}\n";
    fs::write(repo.path().join("blocked/secret.rs"), blocked_initial).unwrap();

    // Index BEFORE adding .kvxignore and BEFORE swapping src/swapped.rs into a symlink
    // to prove editor & renamer enforce live .kvxignore and symlink containment even on stale DB rows!
    symlink(&outside_rs, repo.path().join("src/link_out.rs")).unwrap();

    let shard_dir = TempDir::new().unwrap();
    let shard = VortexShard::open("sec-repo", repo.path(), &shard_dir.path().join("sec.sqlite")).unwrap();
    shard.sync(true).unwrap();

    // Symlink must NOT have been indexed during sync
    let link_lookup = shard.read_symbol("outside_fn", None).unwrap();
    assert!(!link_lookup.found);

    // Now lock down blocked/** via .kvxignore and replace src/swapped.rs with an outside symlink
    fs::write(repo.path().join(".kvxignore"), "blocked/**\n").unwrap();
    fs::remove_file(repo.path().join("src/swapped.rs")).unwrap();
    symlink(&outside_rs, repo.path().join("src/swapped.rs")).unwrap();

    // VortexShard::reindex_file must refuse ../outside.rs, symlink src/link_out.rs, and .kvxignore blocked/secret.rs
    assert!(matches!(
        shard.reindex_file("../outside.rs").unwrap_err(),
        VortexError::InvalidInput(_)
    ));
    assert!(matches!(
        shard.reindex_file("src/link_out.rs").unwrap_err(),
        VortexError::InvalidInput(_)
    ));
    assert!(matches!(
        shard.reindex_file("blocked/secret.rs").unwrap_err(),
        VortexError::KvxIgnored { .. }
    ));

    let no_locks: &[SymbolLock] = &[];

    // SymbolEditor::edit_symbol refusals
    let trav_edit = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "safe_calc".to_string(),
            file_path: Some("../outside.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn safe_calc() {}".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(trav_edit, VortexError::InvalidInput(_)));

    let kvx_edit = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "blocked_fn".to_string(),
            file_path: Some("blocked/secret.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn blocked_fn() -> i32 { 0 }".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(kvx_edit, VortexError::KvxIgnored { .. }));

    let sym_escape_edit = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "swapped_target".to_string(),
            file_path: Some("src/swapped.rs".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "pub fn swapped_target() -> i32 { 0 }".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(
        sym_escape_edit,
        VortexError::InvalidInput(_) | VortexError::SymbolNotFound(_)
    ));

    // TwoPhaseRenamer::rename_symbol refusals
    let trav_ren = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "../outside.rs#outside_fn".to_string(),
            file_path: None,
            new_name: "pwned_fn".to_string(),
            plan_token: None,
            include_name_only: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(trav_ren, VortexError::InvalidInput(_)));

    let kvx_ren = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "blocked_fn".to_string(),
            file_path: Some("blocked/secret.rs".to_string()),
            new_name: "renamed_blocked".to_string(),
            plan_token: None,
            include_name_only: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(kvx_ren, VortexError::KvxIgnored { .. }));

    let sym_escape_ren = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "swapped_target".to_string(),
            file_path: Some("src/swapped.rs".to_string()),
            new_name: "hijacked_target".to_string(),
            plan_token: None,
            include_name_only: false,
            allow_syntax_errors: false,
        },
        no_locks,
    )
    .unwrap_err();
    assert!(matches!(
        sym_escape_ren,
        VortexError::InvalidInput(_) | VortexError::SymbolNotFound(_)
    ));

    // Verify neither outside.rs nor blocked/secret.rs was modified
    assert_eq!(fs::read_to_string(&outside_rs).unwrap(), outside_initial);
    assert_eq!(
        fs::read_to_string(repo.path().join("blocked/secret.rs")).unwrap(),
        blocked_initial
    );
}

#[test]
fn dlp_multiline_private_key_pem_complete_body_redaction() {
    let rsa_b64_line1 = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqU9vN1xK8LzW2pR";
    let rsa_b64_line2 = "9fH3jV6mQ2cT8bY4nK7wX1zL5pD0sR3vG8hJ2kM6nB4qW9eT1yU7iO3pA5sD8fG0";
    let openssh_b64_line = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    let unclosed_ec_b64 = "MHcCAQEEIJT9k2L8vP3rW7xQ1mN5bK4jH6gF0dS2aZ8xC9vB1nM3oAoGCCqGSM49AwEH";
    let pat_secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

    let doc_with_keys = format!(
        "# Deployment Runbook\n\
         Primary RSA key:\n\
         -----BEGIN RSA PRIVATE KEY-----\n\
         Proc-Type: 4,ENCRYPTED\n\
         DEK-Info: AES-128-CBC,0123456789ABCDEF\n\
         \n\
         {rsa_b64_line1}\n\
         {rsa_b64_line2}\n\
         -----END RSA PRIVATE KEY-----\n\
         Secondary OpenSSH key:\n\
         -----BEGIN OPENSSH PRIVATE KEY-----\n\
         {openssh_b64_line}\n\
         -----END OPENSSH PRIVATE KEY-----\n\
         Truncated EC key paste:\n\
         -----BEGIN EC PRIVATE KEY-----\n\
         {unclosed_ec_b64}\n\
         \n\
         Follow-up token on line 18: {pat_secret}\n"
    );

    let scanner = DlpScanner::new();
    let (sanitized, findings) = scanner.scan_and_redact("ops/keys.md", &doc_with_keys);

    assert!(sanitized.contains("[REDACTED:private_key_pem]"));
    assert!(sanitized.contains("[REDACTED:github_pat]"));
    assert!(!sanitized.contains(rsa_b64_line1));
    assert!(!sanitized.contains(rsa_b64_line2));
    assert!(!sanitized.contains(openssh_b64_line));
    assert!(!sanitized.contains(unclosed_ec_b64));
    assert!(!sanitized.contains("BEGIN RSA PRIVATE KEY"));
    assert!(!sanitized.contains("END RSA PRIVATE KEY"));
    assert!(!sanitized.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(!sanitized.contains("END OPENSSH PRIVATE KEY"));
    assert!(!sanitized.contains("BEGIN EC PRIVATE KEY"));
    assert!(sanitized.contains("# Deployment Runbook"));
    assert!(sanitized.contains("Secondary OpenSSH key:"));

    let pem_findings: Vec<_> = findings
        .iter()
        .filter(|f| f.category == DlpCategory::PrivateKeyPem)
        .collect();
    assert_eq!(pem_findings.len(), 3);
    let pat_finding = findings
        .iter()
        .find(|f| f.category == DlpCategory::GithubPat)
        .expect("GitHub PAT after multi-line PEM blocks must be reported");
    assert_eq!(pat_finding.line, 18);

    // Verify Nexus Markdown twins also contain ZERO private key body bytes
    let nexus_src = TempDir::new().unwrap();
    let nexus_vault_dir = TempDir::new().unwrap();
    fs::write(nexus_src.path().join("runbook.md"), &doc_with_keys).unwrap();
    let docx_bytes = build_synthetic_docx(&doc_with_keys);
    fs::write(nexus_src.path().join("runbook.docx"), docx_bytes).unwrap();

    let vault = DriveNexusVault::open(&nexus_vault_dir.path().join("vault")).unwrap();
    let ingest = vault
        .ingest_directory("sec-audit", nexus_src.path(), None)
        .unwrap();
    assert!(ingest.dlp_redactions >= 6);

    for twin_name in ["runbook.md.md", "runbook.docx.md"] {
        let twin_path = nexus_vault_dir
            .path()
            .join("vault/twins/sec-audit")
            .join(twin_name);
        let twin_body = fs::read_to_string(&twin_path).unwrap();
        assert!(twin_body.contains("[REDACTED:private_key_pem]"));
        assert!(!twin_body.contains(rsa_b64_line1));
        assert!(!twin_body.contains(rsa_b64_line2));
        assert!(!twin_body.contains(openssh_b64_line));
        assert!(!twin_body.contains(unclosed_ec_b64));
        assert!(!twin_body.contains("END RSA PRIVATE KEY"));
    }
}

#[test]
fn adr_001_frontmatter_loading_and_cross_crate_rust_layer_firewall() {
    // 1. Load real docs/cmmi/adr/ADR-001-rust-cmmi-architecture.md from workspace root
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root");
    let real_adr_rules = vortex_core::graph::load_adr_layer_rules(workspace_root);
    assert!(
        real_adr_rules.len() >= 16,
        "Expected >= 16 expanded layer rules from ADR-001, got {}",
        real_adr_rules.len()
    );
    assert!(real_adr_rules.iter().any(|r| {
        r.from_glob == "crates/vortex-core/**" && r.forbid_to_glob == "crates/fabrica-cmmi/**"
    }));

    // 2. Simulate Rust workspace cross-crate violation + wildcard forbid ("crates/fabrica-*")
    let repo = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("docs/cmmi/adr")).unwrap();
    fs::create_dir_all(repo.path().join("crates/vortex-core/src")).unwrap();
    fs::create_dir_all(repo.path().join("crates/fabrica-cmmi/src")).unwrap();
    fs::create_dir_all(repo.path().join("crates/fabrica-agents/src")).unwrap();

    // Copy real ADR-001 and add a second ADR testing `layer:` + `glob:` + `forbid: ["crates/fabrica-*"]` without `id:`
    let real_adr_text =
        fs::read_to_string(workspace_root.join("docs/cmmi/adr/ADR-001-rust-cmmi-architecture.md"))
            .unwrap();
    fs::write(
        repo.path()
            .join("docs/cmmi/adr/ADR-001-rust-cmmi-architecture.md"),
        real_adr_text,
    )
    .unwrap();
    fs::write(
        repo.path().join("docs/cmmi/adr/ADR-002-extra.md"),
        "---\nlayer_rules:\n  - layer: vortex-core\n    glob: \"crates/vortex-core/**\"\n    forbid:\n      - \"crates/fabrica-*\"\n      - \"ui/**\"\n---\n# ADR-002\n",
    )
    .unwrap();

    fs::write(
        repo.path().join("crates/fabrica-cmmi/src/lib.rs"),
        "pub struct CmmiFsm;\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("crates/fabrica-agents/src/lib.rs"),
        "pub struct AgentRunner;\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("crates/vortex-core/src/bad.rs"),
        "use fabrica_cmmi::CmmiFsm;\nextern crate fabrica_agents;\n\npub fn illegal_coupling() {}\n",
    )
    .unwrap();

    let shard_dir = TempDir::new().unwrap();
    let shard = VortexShard::open(
        "adr-firewall-repo",
        repo.path(),
        &shard_dir.path().join("adr.sqlite"),
    )
    .unwrap();
    shard.sync(true).unwrap();

    let violations = vortex_core::graph::check_architecture(&shard, &[]).unwrap();
    assert!(
        violations.iter().any(|v| {
            v.from_file == "crates/vortex-core/src/bad.rs"
                && v.to_file == "crates/fabrica-cmmi/src/lib.rs"
                && v.rule_id.starts_with("ADR-001:")
        }),
        "Expected ADR-001 violation on `use fabrica_cmmi::CmmiFsm`, got {violations:?}"
    );
    assert!(
        violations.iter().any(|v| {
            v.from_file == "crates/vortex-core/src/bad.rs"
                && v.to_file == "crates/fabrica-agents/src/lib.rs"
                && v.rule_id.starts_with("ADR-002:vortex-core->")
        }),
        "Expected ADR-002 wildcard violation on `extern crate fabrica_agents`, got {violations:?}"
    );

    // 3. Malformed ADR YAML must propagate VortexError::Yaml via try_load_adr_layer_rules / check_architecture
    fs::write(
        repo.path().join("docs/cmmi/adr/ADR-999-broken.md"),
        "---\nlayer_rules: [unclosed_yaml\n---\n",
    )
    .unwrap();
    let yaml_err = vortex_core::graph::check_architecture(&shard, &[]).unwrap_err();
    assert!(matches!(yaml_err, VortexError::Yaml(_)));
}

#[test]
fn editor_frozen_insert_guard_allow_body_only_methods_and_serde_rename_safety() {
    let repo = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();

    // 1. Rust file with serde rename attribute + route string + frozen function
    fs::write(
        repo.path().join("src/lib.rs"),
        r#"#[derive(serde::Serialize)]
pub struct FeeDto {
    pub value: i64,
}

#[serde(rename = "legacy_fee")]
pub fn legacy_fee(amount: i64) -> i64 {
    let endpoint = "/api/legacy_fee"; // legacy_fee endpoint path
    let _ = endpoint;
    amount * 2
}

pub fn frozen_guard() -> i64 {
    100
}
"#,
    )
    .unwrap();
    fs::write(
        repo.path().join("src/caller.rs"),
        "use crate::legacy_fee;\n\npub fn run() -> i64 {\n    legacy_fee(21) + legacy_fee(1)\n}\n",
    )
    .unwrap();

    // 2. TypeScript class with indented method
    fs::write(
        repo.path().join("src/billing.ts"),
        "export class BillingService {\n  computeTotal(subtotal: number, taxRate: number): number {\n    return subtotal;\n  }\n}\n",
    )
    .unwrap();

    // 3. Python class with indented method
    fs::write(
        repo.path().join("src/calc.py"),
        "class Calculator:\n    def compute(self, x: int) -> dict:\n        return {\"val\": x}\n",
    )
    .unwrap();

    let shard_dir = TempDir::new().unwrap();
    let shard = VortexShard::open("lock-repo", repo.path(), &shard_dir.path().join("lock.sqlite")).unwrap();
    shard.sync(true).unwrap();

    // A. LockMode::Frozen must block Replace, Delete, InsertBefore, AND InsertAfter!
    shard
        .lock_symbol(
            "frozen_guard",
            Some("src/lib.rs"),
            LockMode::Frozen,
            "cmmi-architect",
            "Immutable safety invariant",
        )
        .unwrap();

    for op in [
        SymbolEditOp::Replace,
        SymbolEditOp::Delete,
        SymbolEditOp::InsertBefore,
        SymbolEditOp::InsertAfter,
    ] {
        let err = SymbolEditor::edit_symbol(
            &shard,
            &EditSymbolRequest {
                symbol: "frozen_guard".to_string(),
                file_path: Some("src/lib.rs".to_string()),
                op,
                new_code: "pub fn injected() {}".to_string(),
                expected_hash: None,
                dry_run: false,
                allow_syntax_errors: false,
            },
            &[],
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                VortexError::LockViolation {
                    mode: LockMode::Frozen,
                    ..
                }
            ),
            "Frozen lock must reject {op:?}, got {err:?}"
        );
    }

    // B. LockMode::AllowBodyOnly on TS class method & Python indented method
    shard
        .lock_symbol(
            "BillingService.computeTotal",
            Some("src/billing.ts"),
            LockMode::AllowBodyOnly,
            "lead",
            "Contract locked",
        )
        .unwrap();
    shard
        .lock_symbol(
            "Calculator.compute",
            Some("src/calc.py"),
            LockMode::AllowBodyOnly,
            "lead",
            "Python contract locked",
        )
        .unwrap();

    // B1. TS body-only edit succeeds
    let ts_ok = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "BillingService.computeTotal".to_string(),
            file_path: Some("src/billing.ts".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "  computeTotal(subtotal: number, taxRate: number): number {\n    const tax = subtotal * taxRate;\n    return subtotal + tax;\n  }".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    assert!(ts_ok.applied && ts_ok.syntax_valid);

    // B2. TS signature change rejected under AllowBodyOnly
    let ts_sig_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "BillingService.computeTotal".to_string(),
            file_path: Some("src/billing.ts".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "  computeTotal(subtotal: number): string {\n    return String(subtotal);\n  }".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(
        ts_sig_err,
        VortexError::LockViolation {
            mode: LockMode::AllowBodyOnly,
            ..
        }
    ));

    // B3. TS smuggled extra method rejected under AllowBodyOnly
    let ts_smuggle_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "BillingService.computeTotal".to_string(),
            file_path: Some("src/billing.ts".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "  computeTotal(subtotal: number, taxRate: number): number {\n    return subtotal;\n  }\n  backdoor(): number {\n    return 1;\n  }".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(
        ts_smuggle_err,
        VortexError::LockViolation {
            mode: LockMode::AllowBodyOnly,
            ..
        }
    ));

    // B4. InsertAfter on AllowBodyOnly rejected
    let ts_ins_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "BillingService.computeTotal".to_string(),
            file_path: Some("src/billing.ts".to_string()),
            op: SymbolEditOp::InsertAfter,
            new_code: "  extra(): void {}".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(
        ts_ins_err,
        VortexError::LockViolation {
            mode: LockMode::AllowBodyOnly,
            ..
        }
    ));

    // B5. Python indented method body edit (with dict braces inside body!) succeeds
    let py_ok = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "Calculator.compute".to_string(),
            file_path: Some("src/calc.py".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "    def compute(self, x: int) -> dict:\n        doubled = x * 2\n        return {\"val\": doubled, \"ok\": True}".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    assert!(py_ok.applied && py_ok.syntax_valid);

    // B6. Python smuggled top-level/method symbol rejected under AllowBodyOnly
    let py_smuggle_err = SymbolEditor::edit_symbol(
        &shard,
        &EditSymbolRequest {
            symbol: "Calculator.compute".to_string(),
            file_path: Some("src/calc.py".to_string()),
            op: SymbolEditOp::Replace,
            new_code: "    def compute(self, x: int) -> dict:\n        return {\"val\": x}\n\n    def smuggled(self) -> int:\n        return 0".to_string(),
            expected_hash: None,
            dry_run: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap_err();
    assert!(matches!(
        py_smuggle_err,
        VortexError::LockViolation {
            mode: LockMode::AllowBodyOnly,
            ..
        }
    ));

    // C. TwoPhaseRenamer preserves #[serde(rename = "legacy_fee")], route strings, and comments
    let plan = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "legacy_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            new_name: "standard_fee".to_string(),
            plan_token: None,
            include_name_only: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    let applied = TwoPhaseRenamer::rename_symbol(
        &shard,
        &RenameSymbolRequest {
            symbol: "legacy_fee".to_string(),
            file_path: Some("src/lib.rs".to_string()),
            new_name: "standard_fee".to_string(),
            plan_token: Some(plan.plan_token),
            include_name_only: false,
            allow_syntax_errors: false,
        },
        &[],
    )
    .unwrap();
    assert!(applied.applied);

    let updated_lib = fs::read_to_string(repo.path().join("src/lib.rs")).unwrap();
    assert!(updated_lib.contains("#[serde(rename = \"legacy_fee\")]"));
    assert!(updated_lib.contains("pub fn standard_fee(amount: i64) -> i64"));
    assert!(updated_lib.contains("\"/api/legacy_fee\""));
    assert!(updated_lib.contains("// legacy_fee endpoint path"));

    let updated_caller = fs::read_to_string(repo.path().join("src/caller.rs")).unwrap();
    assert!(updated_caller.contains("use crate::standard_fee;"));
    assert!(updated_caller.contains("standard_fee(21) + standard_fee(1)"));
}

#[test]
fn failure_slicer_6000_token_multibyte_utf8_strict_byte_budget() {
    // Build a > 6,000-token (> 28,000-byte) multi-byte UTF-8 compiler failure output
    let mut raw_log = String::with_capacity(32_000);
    raw_log.push_str(
        "error[E0308]: tipos incompatíveis na validação crítica 🚀🔥💥 — esperado `Resultado<Sessão, ErroCrítico>`, encontrado `Opção<文字データ>`\n",
    );
    raw_log.push_str(
        "  --> crates/módulo_de_execução_avançada/src/validador_semântico_utf8.rs:142:18\n",
    );
    for idx in 0..220 {
        raw_log.push_str(&format!(
            "error[E0425]: falha em cascata #{idx} na verificação de invariantes CMMI Nível 4 (ação: inspeção_automática_🚀_日本語_テスト_áéíóú_ãõç)\n  --> crates/sub_módulo/src/arquivo_{idx}.rs:{line}:9\n",
            line = idx + 10
        ));
    }
    assert!(
        raw_log.len().div_ceil(4) > 6_000,
        "Raw failure log must exceed 6,000 tokens, got {}",
        raw_log.len().div_ceil(4)
    );

    let sliced = FailureSlicer::slice(&raw_log, None, None).unwrap();
    assert!(sliced.tokens_before > 6_000);
    let actual_summary_tokens = if sliced.summary.is_empty() {
        0
    } else {
        sliced.summary.len().div_ceil(4)
    };
    assert_eq!(
        sliced.tokens_after, actual_summary_tokens,
        "tokens_after must equal truthful UTF-8 byte token estimate without .min() masking"
    );
    assert!(
        actual_summary_tokens <= 300,
        "Actual summary tokens ({actual_summary_tokens}, {} bytes) exceeded 300-token ceiling",
        sliced.summary.len()
    );

    // Also test ultra-tight budget (10 tokens = 40 UTF-8 bytes) where root_errors[0] path alone > 40 bytes
    let tight = FailureSlicer::slice(&raw_log, Some(10), None).unwrap();
    let tight_actual = tight.summary.len().div_ceil(4);
    assert_eq!(tight.tokens_after, tight_actual);
    assert!(tight_actual <= 10);

    // Also verify repo_map byte-safe truncation on multi-byte identifiers under tight cap
    let repo = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join("src/relatório_financeiro_avançado.rs"),
        "pub fn gerar_relatório_consolidado_trimestral(parâmetro_crítico: &str) -> usize { parâmetro_crítico.len() }\n",
    )
    .unwrap();
    let shard_dir = TempDir::new().unwrap();
    let shard = VortexShard::open("utf8-repo", repo.path(), &shard_dir.path().join("u.sqlite")).unwrap();
    shard.sync(true).unwrap();
    let rmap = vortex_core::graph::repo_map(&shard, 16).unwrap();
    assert_eq!(rmap.token_count, rmap.markdown.len().div_ceil(4));
    assert!(rmap.token_count <= 16);
}

#[test]
fn native_treesitter_c_and_java_ast_complexity_refs_and_routes() {
    let parser = AstParser::new();

    // 1. Native tree-sitter-c (.h with #ifndef guard + .c with complexity & call refs)
    let h_src = r#"
#ifndef AUDIO_DSP_H
#define AUDIO_DSP_H

typedef struct DspFrame {
    float left;
    float right;
} DspFrame;

int process_frame(DspFrame *frame, int gain_db);

#endif
"#;
    assert!(!AstParser::has_syntax_errors("h", h_src));
    assert!(AstParser::has_syntax_errors("c", "int broken( { return 0; "));
    let h_parsed = parser.parse_file("include/audio_dsp.h", "h", h_src);
    assert!(h_parsed
        .symbols
        .iter()
        .any(|s| s.name == "DspFrame" && (s.kind == "struct" || s.kind == "type") && s.exported));
    assert!(h_parsed
        .symbols
        .iter()
        .any(|s| s.name == "process_frame" && s.kind == "function" && s.exported));

    let c_src = r#"
#include "audio_dsp.h"

static float clamp_sample(float x) {
    if (x > 1.0f) {
        return 1.0f;
    } else if (x < -1.0f) {
        return -1.0f;
    }
    return x;
}

int process_frame(DspFrame *frame, int gain_db) {
    if (frame == 0 || gain_db < -60) {
        return -1;
    }
    for (int i = 0; i < 2 && gain_db > 0; i++) {
        frame->left = clamp_sample(frame->left);
    }
    return 0;
}
"#;
    assert!(!AstParser::has_syntax_errors("c", c_src));
    let c_parsed = parser.parse_file("src/audio_dsp.c", "c", c_src);
    let helper_sym = c_parsed
        .symbols
        .iter()
        .find(|s| s.name == "clamp_sample")
        .expect("static C function clamp_sample");
    assert!(!helper_sym.exported);
    assert!(helper_sym.complexity >= 3);

    let proc_sym = c_parsed
        .symbols
        .iter()
        .find(|s| s.name == "process_frame")
        .expect("exported C function process_frame");
    assert!(proc_sym.exported);
    assert!(proc_sym.complexity >= 5);
    assert!(c_parsed
        .edges
        .iter()
        .any(|e| e.raw_target == "audio_dsp.h" && e.kind == "import"));
    assert!(c_parsed
        .references
        .iter()
        .any(|r| r.symbol_name == "clamp_sample" && r.in_symbol.as_deref() == Some("process_frame")));

    // 2. Native tree-sitter-java (.java with @RestController/@RequestMapping/@GetMapping, complexity, refs, slop)
    let java_src = r#"
package com.kaxcav.billing;

import java.util.List;
import com.kaxcav.core.AuditLogger;

@RestController
@RequestMapping("/api/v1")
public class InvoiceController {

    @GetMapping("/invoices")
    public List<String> listInvoices(boolean includeArchived, int limit) {
        if (includeArchived && limit > 0) {
            for (int i = 0; i < limit; i++) {
                AuditLogger.record("invoice_read");
            }
        }
        try {
            AuditLogger.flush();
        } catch (Exception ignored) {
        }
        return List.of();
    }

    @PostMapping("/invoices")
    public String createInvoice(String payload) {
        return payload != null ? payload : "";
    }
}
"#;
    assert!(!AstParser::has_syntax_errors("java", java_src));
    assert!(AstParser::has_syntax_errors(
        "java",
        "public class Broken { public void f( { } }"
    ));

    let java_parsed = parser.parse_file("src/InvoiceController.java", "java", java_src);
    assert!(java_parsed
        .symbols
        .iter()
        .any(|s| s.name == "InvoiceController" && s.kind == "class" && s.exported));
    let list_method = java_parsed
        .symbols
        .iter()
        .find(|s| s.qualified_name == "InvoiceController.listInvoices")
        .expect("Java method InvoiceController.listInvoices");
    assert_eq!(list_method.kind, "method");
    assert!(list_method.exported);
    assert!(list_method.complexity >= 4);

    assert!(java_parsed
        .routes
        .iter()
        .any(|r| r.method == "GET" && r.route_path == "/api/v1/invoices"));
    assert!(java_parsed
        .routes
        .iter()
        .any(|r| r.method == "POST" && r.route_path == "/api/v1/invoices"));
    assert!(java_parsed
        .edges
        .iter()
        .any(|e| e.raw_target == "com.kaxcav.core.AuditLogger"));
    assert!(java_parsed.references.iter().any(|r| {
        r.symbol_name == "AuditLogger" && r.confidence == RefConfidence::Imported
    }));

    let java_slop = AstParser::scan_slop("src/InvoiceController.java", "java", java_src);
    assert!(java_slop.iter().any(|f| f.kind == "empty_catch"));
}
