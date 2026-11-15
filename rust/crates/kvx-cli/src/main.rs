//! Standalone `kvx` CLI & Full 13-Tool Read-Only MCP Server over `vortex-core`.

use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use vortex_core::{ContextRequest, OutlineScope, VortexEngine, KAXCAV_VORTEX_VERSION};

const MAX_MCP_FRAME_BYTES: usize = 16 * 1024 * 1024;
const READ_ONLY_TOOL_NAMES: [&str; 13] = [
    "context",
    "search",
    "search_symbols",
    "affected",
    "blast_radius",
    "index_health",
    "file_outline",
    "read_symbol",
    "repo_map",
    "find_references",
    "call_graph",
    "diff_impact",
    "vortex_slice_failure",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum StdioFraming {
    NewlineDelimited,
    ContentLength,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("status");

    if cmd == "version" || args.iter().any(|a| a == "--version" || a == "-v") {
        println!("kaxcav-vortex v{KAXCAV_VORTEX_VERSION}");
        return;
    }
    if cmd == "help" || args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Kaxcav Vortex v{KAXCAV_VORTEX_VERSION} — Standalone Rust CLI (status, init, repo, context, search, outline, symbol, callers, affected, blast-radius, diff-impact, federate, mcp)");
        return;
    }

    let engine = match VortexEngine::new(None) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Error initializing VortexEngine: {e}");
            std::process::exit(1);
        }
    };
    let _ = engine.load_configured_repos(false);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    if cmd == "mcp" || args.iter().any(|a| a == "--mcp") {
        run_ro_mcp_stdio(&engine, &cwd);
        return;
    }

    match cmd {
        "status" => match engine.status() {
            Ok(st) => println!("{}", serde_json::to_string_pretty(&st).unwrap_or_default()),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        "init" => {
            let target = args.get(1).map(PathBuf::from).unwrap_or(cwd);
            match engine.add_repo(None, &target, true).and_then(|s| s.health()) {
                Ok(h) => println!("{}", serde_json::to_string_pretty(&h).unwrap_or_default()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        "search" => {
            let _ = engine.add_repo(None, &cwd, true);
            let q = args.get(1).map(String::as_str).unwrap_or("");
            match engine.search(None, q, 20) {
                Ok(res) => println!("{}", serde_json::to_string_pretty(&res).unwrap_or_default()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        "context" => {
            let _ = engine.add_repo(None, &cwd, true);
            let task = args.get(1).cloned().unwrap_or_else(|| "repository overview".to_string());
            let req = ContextRequest {
                task,
                repo_id: None,
                entry_files: Vec::new(),
                token_budget: Some(2_000),
                fidelity: None,
                if_none_match: None,
                delta_from: None,
            };
            match engine.context(&req) {
                Ok(pack) => println!("{}", pack.markdown),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        "outline" => {
            let _ = engine.add_repo(None, &cwd, true);
            let file = args.get(1).map(String::as_str).unwrap_or("");
            match engine.file_outline(None, file, OutlineScope::Tudo) {
                Ok(res) => println!("{}", serde_json::to_string_pretty(&res).unwrap_or_default()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            let _ = engine.add_repo(None, &cwd, true);
            if let Ok(st) = engine.status() {
                println!("{}", serde_json::to_string_pretty(&st).unwrap_or_default());
            }
        }
    }
}

fn strip_ascii_case_prefix<'a>(s: &'a str, prefix_lower: &str) -> Option<&'a str> {
    let head = s.get(..prefix_lower.len())?;
    if head.eq_ignore_ascii_case(prefix_lower) {
        s.get(prefix_lower.len()..)
    } else {
        None
    }
}

fn read_next_stdio_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<(Vec<u8>, StdioFraming)>> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(len_part) = strip_ascii_case_prefix(trimmed, "content-length:") {
            let content_len = len_part.trim().parse::<usize>().map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Invalid Content-Length '{trimmed}': {e}"),
                )
            })?;
            if content_len > MAX_MCP_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Content-Length {content_len} exceeds 16 MiB limit"),
                ));
            }
            let mut hdr_line = String::new();
            loop {
                hdr_line.clear();
                let hn = reader.read_line(&mut hdr_line)?;
                if hn == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "EOF inside MCP Content-Length header block",
                    ));
                }
                if hdr_line.trim().is_empty() {
                    break;
                }
            }
            let mut body = vec![0u8; content_len];
            reader.read_exact(&mut body)?;
            return Ok(Some((body, StdioFraming::ContentLength)));
        }
        if strip_ascii_case_prefix(trimmed, "content-type:").is_some() {
            continue;
        }
        return Ok(Some((
            trimmed.as_bytes().to_vec(),
            StdioFraming::NewlineDelimited,
        )));
    }
}

fn write_stdio_frame<W: Write>(writer: &mut W, payload: &Value, framing: StdioFraming) -> io::Result<()> {
    let encoded = serde_json::to_vec(payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    match framing {
        StdioFraming::NewlineDelimited => {
            writer.write_all(&encoded)?;
            writer.write_all(b"\n")?;
        }
        StdioFraming::ContentLength => {
            let header = format!("Content-Length: {}\r\n\r\n", encoded.len());
            writer.write_all(header.as_bytes())?;
            writer.write_all(&encoded)?;
        }
    }
    writer.flush()
}

fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i32, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn build_ro_tool_catalog() -> Value {
    json!([
        {
            "name": "context",
            "description": "Compiles a submodular token-budgeted L0-L3 ContextPack for a task intent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "intent": { "type": "string" },
                    "budget_tokens": { "type": "integer" },
                    "repo": { "type": "string" },
                    "focal_files": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["intent"]
            }
        },
        {
            "name": "search",
            "description": "Searches AST symbols and text via FTS5 BM25F with guaranteed fallback.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer" },
                    "repo": { "type": "string" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "search_symbols",
            "description": "Searches indexed AST symbol declarations by name, signature, or qualified path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer" },
                    "repo": { "type": "string" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "affected",
            "description": "Lists test suites transitively affected by modified files or symbols.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "targets": { "type": "array", "items": { "type": "string" } },
                    "files": { "type": "array", "items": { "type": "string" } },
                    "repo": { "type": "string" }
                },
                "required": []
            }
        },
        {
            "name": "blast_radius",
            "description": "Computes AST dependents, call sites, affected tests, and Git co-change blast radius.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string" },
                    "max_depth": { "type": "integer" },
                    "repo": { "type": "string" }
                },
                "required": ["target"]
            }
        },
        {
            "name": "index_health",
            "description": "Returns SQLite WAL shard freshness, symbol/edge counts, and health diagnostics.",
            "inputSchema": {
                "type": "object",
                "properties": { "repo": { "type": "string" } },
                "required": []
            }
        },
        {
            "name": "file_outline",
            "description": "Returns structured AST declaration outline for a file without loading implementation bodies.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": { "type": "string" },
                    "scope": { "type": "string", "enum": ["all", "exported", "types", "functions"] },
                    "repo": { "type": "string" }
                },
                "required": ["file"]
            }
        },
        {
            "name": "read_symbol",
            "description": "Reads exact AST declaration slice(s) for a symbol with line boundaries.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "symbol": { "type": "string" },
                    "file": { "type": "string" },
                    "repo": { "type": "string" }
                },
                "required": ["symbol"]
            }
        },
        {
            "name": "repo_map",
            "description": "Generates a PageRank-ordered repository public contract map within token budget.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "budget_tokens": { "type": "integer" },
                    "repo": { "type": "string" }
                },
                "required": []
            }
        },
        {
            "name": "find_references",
            "description": "Finds provenance-graded references (same_file, imported, name_only) for a symbol.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "symbol": { "type": "string" },
                    "file": { "type": "string" },
                    "limit": { "type": "integer" },
                    "include_name_only": { "type": "boolean" },
                    "repo": { "type": "string" }
                },
                "required": ["symbol"]
            }
        },
        {
            "name": "call_graph",
            "description": "Computes incoming callers and outgoing callees around a symbol.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "symbol": { "type": "string" },
                    "repo": { "type": "string" }
                },
                "required": ["symbol"]
            }
        },
        {
            "name": "diff_impact",
            "description": "Analyzes exported contract drift and transitive impact across changed files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": { "type": "array", "items": { "type": "string" } },
                    "repo": { "type": "string" }
                },
                "required": []
            }
        },
        {
            "name": "vortex_slice_failure",
            "description": "Compresses verbose compiler/test logs into <=300 token root causes + BLAKE3 signature.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "raw_output": { "type": "string" },
                    "max_tokens": { "type": "integer" },
                    "repo": { "type": "string" }
                },
                "required": ["raw_output"]
            }
        }
    ])
}

fn str_arg<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = args.get(*k).and_then(Value::as_str) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn vec_str_arg(args: &Value, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = args.get(*k).and_then(Value::as_array) {
            return arr
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    Vec::new()
}

fn resolve_repo_id(engine: &VortexEngine, args: &Value, cwd: &Path) -> Option<String> {
    if let Some(explicit) = str_arg(
        args,
        &["repo", "repo_id", "repoId", "repo_path", "repoPath", "cwd"],
    ) {
        let p = PathBuf::from(explicit);
        if p.is_dir() {
            if let Ok(shard) = engine.add_repo(None, &p, true) {
                return Some(shard.repo_id().to_string());
            }
        }
        return Some(explicit.to_string());
    }
    if engine.list_repos().is_empty() && cwd.is_dir() {
        if let Ok(shard) = engine.add_repo(None, cwd, true) {
            return Some(shard.repo_id().to_string());
        }
    }
    None
}

fn execute_ro_tool(engine: &VortexEngine, cwd: &Path, name: &str, args: &Value) -> Result<Value, (i32, String)> {
    if !READ_ONLY_TOOL_NAMES.contains(&name) {
        return Err((
            -32602,
            format!("Tool '{name}' is forbidden in read-only server 'kaxcav-vortex-ro' (only 13 read-only tools allowed)"),
        ));
    }
    let repo_id = resolve_repo_id(engine, args, cwd);
    match name {
        "context" => {
            let intent = str_arg(args, &["intent", "query", "task"]).unwrap_or("repository overview");
            let budget = args
                .get("budget_tokens")
                .or_else(|| args.get("budgetTokens"))
                .or_else(|| args.get("budget"))
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(4_000);
            let req = ContextRequest {
                task: intent.to_string(),
                repo_id,
                entry_files: vec_str_arg(args, &["focal_files", "focalFiles", "entry_files", "files"]),
                token_budget: Some(budget),
                fidelity: None,
                if_none_match: str_arg(args, &["if_none_match"]).map(String::from),
                delta_from: str_arg(args, &["delta_from"]).map(String::from),
            };
            let pack = engine.context(&req).map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(pack).map_err(|e| (-32603, e.to_string()))
        }
        "search" | "search_symbols" => {
            let query = str_arg(args, &["query", "q", "symbol"])
                .ok_or_else(|| (-32602, "Missing required parameter 'query'".to_string()))?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(20);
            let res = engine
                .search(repo_id.as_deref(), query, limit)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "affected" => {
            let mut targets = vec_str_arg(args, &["targets", "files", "changed_files"]);
            if targets.is_empty() {
                if let Some(single) = str_arg(args, &["target", "file"]) {
                    targets.push(single.to_string());
                }
            }
            let tests = engine
                .affected(repo_id.as_deref(), &targets)
                .map_err(|e| (-32603, e.to_string()))?;
            Ok(json!({ "targets": targets, "affectedTests": tests, "count": tests.len() }))
        }
        "blast_radius" => {
            let target = str_arg(args, &["target", "symbol", "file"])
                .ok_or_else(|| (-32602, "Missing required parameter 'target'".to_string()))?;
            let depth = args
                .get("max_depth")
                .or_else(|| args.get("depth"))
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(3);
            let res = engine
                .blast_radius(repo_id.as_deref(), target, depth)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "index_health" => {
            if repo_id.is_some() {
                let h = engine
                    .index_health(repo_id.as_deref())
                    .map_err(|e| (-32603, e.to_string()))?;
                serde_json::to_value(h).map_err(|e| (-32603, e.to_string()))
            } else {
                let st = engine.status().map_err(|e| (-32603, e.to_string()))?;
                serde_json::to_value(st).map_err(|e| (-32603, e.to_string()))
            }
        }
        "file_outline" => {
            let file = str_arg(args, &["file", "path", "file_path", "filePath"])
                .ok_or_else(|| (-32602, "Missing required parameter 'file'".to_string()))?;
            let scope = match str_arg(args, &["scope"]).unwrap_or("all") {
                "exported" | "public" | "exportado" => OutlineScope::Exportado,
                "topo" | "top" => OutlineScope::Topo,
                _ => OutlineScope::Tudo,
            };
            let res = engine
                .file_outline(repo_id.as_deref(), file, scope)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "read_symbol" => {
            let symbol = str_arg(args, &["symbol", "name", "qualified_name", "query"])
                .ok_or_else(|| (-32602, "Missing required parameter 'symbol'".to_string()))?;
            let file_hint = str_arg(args, &["file", "path", "file_path"]);
            let res = engine
                .read_symbol(repo_id.as_deref(), symbol, file_hint)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "repo_map" => {
            let budget = args
                .get("budget_tokens")
                .or_else(|| args.get("budget"))
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(2_000);
            let res = engine
                .repo_map(repo_id.as_deref(), budget)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "find_references" => {
            let symbol = str_arg(args, &["symbol", "name", "query"])
                .ok_or_else(|| (-32602, "Missing required parameter 'symbol'".to_string()))?;
            let file_hint = str_arg(args, &["file", "path"]);
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| v as usize)
                .unwrap_or(50);
            let include_name_only = args
                .get("include_name_only")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let res = engine
                .find_references(repo_id.as_deref(), symbol, file_hint, limit, include_name_only)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "call_graph" => {
            let symbol = str_arg(args, &["symbol", "name", "query"])
                .ok_or_else(|| (-32602, "Missing required parameter 'symbol'".to_string()))?;
            let res = engine
                .call_graph(repo_id.as_deref(), symbol)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "diff_impact" => {
            let files = vec_str_arg(args, &["files", "changed_files"]);
            let opt_files = if files.is_empty() {
                None
            } else {
                Some(files.as_slice())
            };
            let res = engine
                .diff_impact(repo_id.as_deref(), opt_files)
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        "vortex_slice_failure" => {
            let raw_out = str_arg(args, &["raw_output", "log", "output", "text"]).unwrap_or("");
            let max_tokens = args
                .get("max_tokens")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let res = engine
                .slice_failure(raw_out, max_tokens, repo_id.as_deref())
                .map_err(|e| (-32603, e.to_string()))?;
            serde_json::to_value(res).map_err(|e| (-32603, e.to_string()))
        }
        other => Err((-32602, format!("Unknown or forbidden read-only tool '{other}'"))),
    }
}

fn run_ro_mcp_stdio(engine: &VortexEngine, cwd: &Path) {
    let _ = engine.add_repo(None, cwd, true);
    let mut reader = BufReader::new(io::stdin());
    let mut writer = io::stdout();

    while let Ok(Some((frame_bytes, framing))) = read_next_stdio_frame(&mut reader) {
        let msg: Value = match serde_json::from_slice(&frame_bytes) {
            Ok(v) => v,
            Err(e) => {
                let err_resp = jsonrpc_error(Value::Null, -32700, format!("Parse error: {e}"));
                if write_stdio_frame(&mut writer, &err_resp, framing).is_err() {
                    break;
                }
                continue;
            }
        };
        let Some(obj) = msg.as_object() else {
            let err_resp = jsonrpc_error(Value::Null, -32600, "Invalid Request: expected JSON object");
            if write_stdio_frame(&mut writer, &err_resp, framing).is_err() {
                break;
            }
            continue;
        };
        let has_id = obj.contains_key("id");
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        let method = obj.get("method").and_then(Value::as_str).unwrap_or("");
        let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));

        if !has_id || method.starts_with("notifications/") || method == "initialized" {
            continue;
        }

        let resp = match method {
            "initialize" => {
                let client_proto = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2024-11-05");
                let proto = match client_proto {
                    "2024-11-05" | "2025-03-26" | "2025-06-18" => client_proto,
                    _ => "2024-11-05",
                };
                jsonrpc_ok(
                    id,
                    json!({
                        "protocolVersion": proto,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "kaxcav-vortex-ro", "version": KAXCAV_VORTEX_VERSION }
                    }),
                )
            }
            "ping" => jsonrpc_ok(id, json!({})),
            "resources/list" => jsonrpc_ok(id, json!({ "resources": [] })),
            "prompts/list" => jsonrpc_ok(id, json!({ "prompts": [] })),
            "tools/list" => jsonrpc_ok(id, json!({ "tools": build_ro_tool_catalog() })),
            "tools/call" => {
                let Some(tool_name) = params
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    let err_resp = jsonrpc_error(id, -32602, "Missing required tool 'name' in tools/call");
                    if write_stdio_frame(&mut writer, &err_resp, framing).is_err() {
                        break;
                    }
                    continue;
                };
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                match execute_ro_tool(engine, cwd, tool_name, &args) {
                    Ok(val) => {
                        let text = serde_json::to_string(&val).unwrap_or_else(|_| val.to_string());
                        jsonrpc_ok(
                            id,
                            json!({
                                "content": [{ "type": "text", "text": text }],
                                "structuredContent": val,
                                "isError": false,
                            }),
                        )
                    }
                    Err((code, msg_err)) => jsonrpc_error(id, code, msg_err),
                }
            }
            other => jsonrpc_error(id, -32601, format!("Method not found: {other}")),
        };

        if write_stdio_frame(&mut writer, &resp, framing).is_err() {
            break;
        }
    }
}
