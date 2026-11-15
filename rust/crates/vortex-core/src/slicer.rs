//! Compiler & test output `FailureSlicer`: parses `rustc`/`cargo`, `tsc`, `vitest`/`jest`/`node --test`,
//! `pytest`, and `go test`, deduplicates cascading diagnostics to root causes, enforces
//! `tokens_after <= max_tokens` (default `300`), and computes deterministic `signature_blake3`.
//!
//! Traceability: `@REQ-VORTEX-003`.

use crate::storage::VortexShard;
use crate::types::{FailureRootError, FailureSliceResult, VortexError, VortexResult};
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// Default token budget ceiling for `FailureSlicer::slice`.
pub const DEFAULT_FAILURE_MAX_TOKENS: usize = 300;

/// Maximum accepted raw stdout+stderr byte payload (8 MiB).
pub const MAX_RAW_FAILURE_BYTES: usize = 8 * 1024 * 1024;

struct DiagnosticRegexes {
    ansi: Regex,
    rustc_hdr: Regex,
    rustc_loc: Regex,
    rust_panic: Regex,
    tsc_paren: Regex,
    tsc_colon: Regex,
    pytest_summary: Regex,
    pytest_loc: Regex,
    go_fail: Regex,
    go_loc: Regex,
    js_err: Regex,
    js_frame: Regex,
    generic_loc: Regex,
    hex_addr: Regex,
    tmp_dir: Regex,
    iso_ts: Regex,
    duration_ms: Regex,
}

fn diag_regexes() -> &'static DiagnosticRegexes {
    static RE: OnceLock<DiagnosticRegexes> = OnceLock::new();
    RE.get_or_init(|| DiagnosticRegexes {
        ansi: Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").unwrap_or_else(|_| unreachable!()),
        rustc_hdr: Regex::new(r"^error(?:\[(E\d{4})\])?:\s+(.+)$")
            .unwrap_or_else(|_| unreachable!()),
        rustc_loc: Regex::new(r"^\s*-->\s+([^:\s]+):(\d+):(\d+)")
            .unwrap_or_else(|_| unreachable!()),
        rust_panic: Regex::new(
            r"thread\s+'([^']+)'\s+panicked\s+at\s+(?:'([^']+)',\s*)?([^:\s]+):(\d+):(\d+)",
        )
        .unwrap_or_else(|_| unreachable!()),
        tsc_paren: Regex::new(r"^([^\s(]+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$")
            .unwrap_or_else(|_| unreachable!()),
        tsc_colon: Regex::new(r"^([^\s:]+):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$")
            .unwrap_or_else(|_| unreachable!()),
        pytest_summary: Regex::new(r"^FAILED\s+([^\s:]+)::([^\s-]+?)(?:\s+-\s+(.+))?$")
            .unwrap_or_else(|_| unreachable!()),
        pytest_loc: Regex::new(r"^([^\s:]+\.py):(\d+):\s*(.+)$")
            .unwrap_or_else(|_| unreachable!()),
        go_fail: Regex::new(r"^---\s*FAIL:\s*([A-Za-z0-9_/]+)")
            .unwrap_or_else(|_| unreachable!()),
        go_loc: Regex::new(r"^\s*([^\s:]+\.go):(\d+)(?::(\d+))?:\s*(.+)$")
            .unwrap_or_else(|_| unreachable!()),
        js_err: Regex::new(
            r"^\s*(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error):\s*(.+)$",
        )
        .unwrap_or_else(|_| unreachable!()),
        js_frame: Regex::new(r"(?:\(|\bat\s+)([^\s():]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)")
            .unwrap_or_else(|_| unreachable!()),
        generic_loc: Regex::new(
            r"^([^\s:]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?error:\s*(.+)$",
        )
        .unwrap_or_else(|_| unreachable!()),
        hex_addr: Regex::new(r"0x[0-9a-fA-F]{6,}").unwrap_or_else(|_| unreachable!()),
        tmp_dir: Regex::new(r"/tmp/\.tmp[A-Za-z0-9_-]+/").unwrap_or_else(|_| unreachable!()),
        iso_ts: Regex::new(r"\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b")
            .unwrap_or_else(|_| unreachable!()),
        duration_ms: Regex::new(r"\(\d+(?:\.\d+)?(?:ms|s)\)").unwrap_or_else(|_| unreachable!()),
    })
}

/// Deterministic failure log compressor and root-error deduplicator.
#[derive(Debug, Clone, Default)]
pub struct FailureSlicer;

impl FailureSlicer {
    /// Creates a new `FailureSlicer`.
    pub fn new() -> Self {
        Self
    }

    /// Parses raw compiler/test output into root errors bounded to `<= max_tokens` (default `300`).
    pub fn slice(
        raw_output: &str,
        max_tokens: Option<usize>,
        shard: Option<&VortexShard>,
    ) -> VortexResult<FailureSliceResult> {
        if raw_output.len() > MAX_RAW_FAILURE_BYTES {
            return Err(VortexError::InvalidInput(format!(
                "raw_output size ({} bytes) exceeds 8 MiB ceiling ({} bytes)",
                raw_output.len(),
                MAX_RAW_FAILURE_BYTES
            )));
        }

        let budget = max_tokens.unwrap_or(DEFAULT_FAILURE_MAX_TOKENS).max(1);
        let re = diag_regexes();
        let clean_text = re.ansi.replace_all(raw_output, "");
        let tokens_before = estimate_tokens(&clean_text);

        if clean_text.trim().is_empty() {
            let empty_sig = blake3::hash(b"empty-failure").to_hex().to_string();
            return Ok(FailureSliceResult {
                root_errors: Vec::new(),
                signature_blake3: empty_sig,
                tokens_before: 0,
                tokens_after: 0,
                deduplicated_count: 0,
                summary: String::new(),
            });
        }

        let raw_errors = extract_all_diagnostics(&clean_text, re);
        let (mut deduped, deduplicated_count) = deduplicate_root_errors(raw_errors, re);

        if let Some(sh) = shard {
            for err in deduped.iter_mut().take(4) {
                if let (Some(ref fp), Some(line_no)) = (&err.file_path, err.line) {
                    err.symbol_snippet = lookup_compact_snippet(sh, fp, line_no);
                }
            }
        }

        let signature_blake3 = compute_normalized_signature(&deduped, &clean_text, re);
        let (fitted_errors, summary, tokens_after) = fit_within_token_budget(deduped, budget);

        Ok(FailureSliceResult {
            root_errors: fitted_errors,
            signature_blake3,
            tokens_before,
            tokens_after,
            deduplicated_count,
            summary,
        })
    }
}

fn estimate_tokens(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        s.len().div_ceil(4)
    }
}

fn extract_all_diagnostics(text: &str, re: &DiagnosticRegexes) -> Vec<FailureRootError> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<FailureRootError> = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let line = lines[i].trim_end();

        if let Some(cap) = re.rustc_hdr.captures(line.trim_start()) {
            let code = cap.get(1).map(|m| m.as_str().to_string());
            let msg = cap.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            if !msg.starts_with("aborting due to") && !msg.starts_with("could not compile") {
                let mut fp = None;
                let mut ln = None;
                let mut col = None;
                for lookahead in 1..=5 {
                    if let Some(next_line) = lines.get(i + lookahead) {
                        if let Some(lcap) = re.rustc_loc.captures(next_line) {
                            fp = lcap.get(1).map(|m| m.as_str().to_string());
                            ln = lcap.get(2).and_then(|m| m.as_str().parse().ok());
                            col = lcap.get(3).and_then(|m| m.as_str().parse().ok());
                            break;
                        }
                    }
                }
                out.push(FailureRootError {
                    tool: "rustc".to_string(),
                    code,
                    file_path: fp,
                    line: ln,
                    col,
                    message: msg,
                    symbol_snippet: None,
                });
            }
            i += 1;
            continue;
        }

        if let Some(cap) = re.rust_panic.captures(line) {
            let thread_name = cap.get(1).map(|m| m.as_str()).unwrap_or("test");
            let inline_msg = cap.get(2).map(|m| m.as_str().to_string());
            let fp = cap.get(3).map(|m| m.as_str().to_string());
            let ln = cap.get(4).and_then(|m| m.as_str().parse().ok());
            let col = cap.get(5).and_then(|m| m.as_str().parse().ok());
            let msg = inline_msg.unwrap_or_else(|| {
                lines
                    .get(i + 1)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && !s.starts_with("note:"))
                    .unwrap_or_else(|| format!("thread '{thread_name}' panicked"))
            });
            out.push(FailureRootError {
                tool: "rustc".to_string(),
                code: Some("PANIC".to_string()),
                file_path: fp,
                line: ln,
                col,
                message: msg,
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re
            .tsc_paren
            .captures(line.trim_start())
            .or_else(|| re.tsc_colon.captures(line.trim_start()))
        {
            out.push(FailureRootError {
                tool: "tsc".to_string(),
                code: cap.get(4).map(|m| m.as_str().to_string()),
                file_path: cap.get(1).map(|m| m.as_str().to_string()),
                line: cap.get(2).and_then(|m| m.as_str().parse().ok()),
                col: cap.get(3).and_then(|m| m.as_str().parse().ok()),
                message: cap.get(5).map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re.pytest_summary.captures(line.trim_start()) {
            let fp = cap.get(1).map(|m| m.as_str().to_string());
            let test_fn = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            let detail = cap
                .get(3)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_else(|| format!("Test {test_fn} failed"));
            out.push(FailureRootError {
                tool: "pytest".to_string(),
                code: Some("PYTEST_FAIL".to_string()),
                file_path: fp,
                line: None,
                col: None,
                message: format!("{test_fn}: {detail}"),
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re.pytest_loc.captures(line.trim_start()) {
            let fp = cap.get(1).map(|m| m.as_str().to_string());
            let ln = cap.get(2).and_then(|m| m.as_str().parse().ok());
            let mut detail = cap.get(3).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            if i > 0 {
                let prev = lines[i - 1].trim_start();
                if let Some(e_msg) = prev.strip_prefix("E ") {
                    detail = format!("{} ({})", e_msg.trim(), detail);
                }
            }
            out.push(FailureRootError {
                tool: "pytest".to_string(),
                code: None,
                file_path: fp,
                line: ln,
                col: None,
                message: detail,
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re.go_fail.captures(line.trim_start()) {
            let test_name = cap.get(1).map(|m| m.as_str()).unwrap_or("Test");
            let mut fp = None;
            let mut ln = None;
            let mut msg = format!("Go test {test_name} failed");
            for lookahead in 1..=4 {
                if let Some(nl) = lines.get(i + lookahead) {
                    if let Some(gcap) = re.go_loc.captures(nl) {
                        fp = gcap.get(1).map(|m| m.as_str().to_string());
                        ln = gcap.get(2).and_then(|m| m.as_str().parse().ok());
                        if let Some(m) = gcap.get(4) {
                            msg = m.as_str().trim().to_string();
                        }
                        break;
                    }
                }
            }
            out.push(FailureRootError {
                tool: "go_test".to_string(),
                code: Some("GO_FAIL".to_string()),
                file_path: fp,
                line: ln,
                col: None,
                message: msg,
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re.go_loc.captures(line) {
            let fp_str = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            if !fp_str.contains("/go/src/runtime/") {
                out.push(FailureRootError {
                    tool: "go_test".to_string(),
                    code: None,
                    file_path: Some(fp_str.to_string()),
                    line: cap.get(2).and_then(|m| m.as_str().parse().ok()),
                    col: cap.get(3).and_then(|m| m.as_str().parse().ok()),
                    message: cap.get(4).map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
                    symbol_snippet: None,
                });
                i += 1;
                continue;
            }
        }

        if let Some(cap) = re.js_err.captures(line) {
            let msg = cap.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            let mut fp = None;
            let mut ln = None;
            let mut col = None;
            for lookahead in 1..=8 {
                if let Some(nl) = lines.get(i + lookahead) {
                    if nl.contains("node_modules") {
                        continue;
                    }
                    if let Some(fcap) = re.js_frame.captures(nl) {
                        fp = fcap.get(1).map(|m| m.as_str().to_string());
                        ln = fcap.get(2).and_then(|m| m.as_str().parse().ok());
                        col = fcap.get(3).and_then(|m| m.as_str().parse().ok());
                        break;
                    }
                }
            }
            out.push(FailureRootError {
                tool: "vitest".to_string(),
                code: None,
                file_path: fp,
                line: ln,
                col,
                message: msg,
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        if let Some(cap) = re.generic_loc.captures(line.trim_start()) {
            out.push(FailureRootError {
                tool: "generic".to_string(),
                code: None,
                file_path: cap.get(1).map(|m| m.as_str().to_string()),
                line: cap.get(2).and_then(|m| m.as_str().parse().ok()),
                col: cap.get(3).and_then(|m| m.as_str().parse().ok()),
                message: cap.get(4).map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
                symbol_snippet: None,
            });
            i += 1;
            continue;
        }

        i += 1;
    }

    if out.is_empty() {
        for raw_line in &lines {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            if lower.contains("error")
                || lower.contains("fail")
                || lower.contains("panic")
                || lower.contains("exception")
            {
                out.push(FailureRootError {
                    tool: "generic".to_string(),
                    code: None,
                    file_path: None,
                    line: None,
                    col: None,
                    message: trimmed.chars().take(240).collect(),
                    symbol_snippet: None,
                });
                if out.len() >= 5 {
                    break;
                }
            }
        }
    }

    if out.is_empty() {
        if let Some(first_non_empty) = lines.iter().map(|l| l.trim()).find(|l| !l.is_empty()) {
            out.push(FailureRootError {
                tool: "generic".to_string(),
                code: None,
                file_path: None,
                line: None,
                col: None,
                message: first_non_empty.chars().take(240).collect(),
                symbol_snippet: None,
            });
        }
    }

    out
}

fn normalize_for_dedup(raw: &str, re: &DiagnosticRegexes) -> String {
    let s1 = re.hex_addr.replace_all(raw, "0xADDR");
    let s2 = re.tmp_dir.replace_all(&s1, "/tmp/TMP/");
    let s3 = re.iso_ts.replace_all(&s2, "TS");
    let s4 = re.duration_ms.replace_all(&s3, "");
    s4.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn deduplicate_root_errors(
    raw_errors: Vec<FailureRootError>,
    re: &DiagnosticRegexes,
) -> (Vec<FailureRootError>, usize) {
    let mut seen_msg_keys: HashSet<(String, String, String)> = HashSet::new();
    let mut seen_file_lines: HashSet<(String, usize)> = HashSet::new();
    let mut unique = Vec::new();
    let mut dropped = 0usize;

    for err in raw_errors {
        let norm_file = err
            .file_path
            .as_deref()
            .map(|p| p.replace('\\', "/"))
            .unwrap_or_default();
        let norm_code = err.code.clone().unwrap_or_default();
        let norm_msg = normalize_for_dedup(&err.message, re);

        if let Some(line_no) = err.line {
            if !norm_file.is_empty() && !seen_file_lines.insert((norm_file.clone(), line_no)) {
                dropped += 1;
                continue;
            }
        }

        if !seen_msg_keys.insert((norm_file, norm_code, norm_msg)) {
            dropped += 1;
            continue;
        }

        unique.push(err);
    }

    (unique, dropped)
}

fn compute_normalized_signature(
    deduped: &[FailureRootError],
    fallback_text: &str,
    re: &DiagnosticRegexes,
) -> String {
    let mut canonical = String::new();
    if deduped.is_empty() {
        canonical.push_str(&normalize_for_dedup(fallback_text, re));
    } else {
        for err in deduped.iter().take(5) {
            let file_norm = err
                .file_path
                .as_deref()
                .map(|p| {
                    let slash = p.replace('\\', "/");
                    re.tmp_dir.replace_all(&slash, "").to_string()
                })
                .unwrap_or_default();
            canonical.push_str(&err.tool);
            canonical.push('|');
            canonical.push_str(err.code.as_deref().unwrap_or(""));
            canonical.push('|');
            canonical.push_str(&file_norm);
            canonical.push('|');
            canonical.push_str(&normalize_for_dedup(&err.message, re));
            canonical.push('\n');
        }
    }
    blake3::hash(canonical.as_bytes()).to_hex().to_string()
}

fn lookup_compact_snippet(shard: &VortexShard, raw_path: &str, line_no: usize) -> Option<String> {
    let ignore = shard.load_ignore().ok()?;
    let rel = shard.resolve_indexed_file_path(raw_path, &ignore).ok()?;
    let (_, abs) = ignore.resolve_contained_path(Path::new(&rel)).ok()?;
    let content = fs::read_to_string(abs).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    if line_no == 0 || line_no > lines.len() {
        return None;
    }
    let start = line_no.saturating_sub(2);
    let end = (line_no + 1).min(lines.len());
    let mut snippet = String::new();
    for (idx, l) in lines[start..end].iter().enumerate() {
        let cur_ln = start + idx + 1;
        let marker = if cur_ln == line_no { ">" } else { " " };
        let clipped: String = l.chars().take(100).collect();
        snippet.push_str(&format!("{marker}{cur_ln}: {clipped}\n"));
    }
    Some(snippet.trim_end().to_string())
}

fn format_error_entry(err: &FailureRootError, include_snippet: bool) -> String {
    let loc = match (&err.file_path, err.line, err.col) {
        (Some(fp), Some(l), Some(c)) => format!("{fp}:{l}:{c}"),
        (Some(fp), Some(l), None) => format!("{fp}:{l}"),
        (Some(fp), None, _) => fp.clone(),
        _ => err.tool.clone(),
    };
    let code_str = err
        .code
        .as_deref()
        .map(|c| format!("[{c}] "))
        .unwrap_or_default();
    let mut line = format!("{loc} {code_str}{}", err.message);
    if include_snippet {
        if let Some(ref snip) = err.symbol_snippet {
            line.push('\n');
            line.push_str(snip);
        }
    }
    line
}

fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    let mut end = s.len().min(max_bytes);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn fit_within_token_budget(
    mut errors: Vec<FailureRootError>,
    budget_tokens: usize,
) -> (Vec<FailureRootError>, String, usize) {
    if errors.is_empty() {
        return (Vec::new(), String::new(), 0);
    }

    let max_bytes = budget_tokens.saturating_mul(4);
    let mut chosen: Vec<FailureRootError> = Vec::new();
    let mut summary = String::new();

    for (idx, mut err) in errors.drain(..).enumerate() {
        let with_snip = format_error_entry(&err, true);
        let sep = if summary.is_empty() { "" } else { "\n" };
        let candidate_full = format!("{summary}{sep}{with_snip}");
        if estimate_tokens(&candidate_full) <= budget_tokens {
            summary = candidate_full;
            chosen.push(err);
            continue;
        }

        err.symbol_snippet = None;
        let without_snip = format_error_entry(&err, false);
        let candidate_compact = format!("{summary}{sep}{without_snip}");
        if estimate_tokens(&candidate_compact) <= budget_tokens {
            summary = candidate_compact;
            chosen.push(err);
            continue;
        }

        if idx == 0 {
            let prefix_bytes = without_snip.len().saturating_sub(err.message.len());
            if prefix_bytes < max_bytes {
                let avail_msg_bytes = max_bytes - prefix_bytes;
                err.message = truncate_utf8_bytes(&err.message, avail_msg_bytes).to_string();
                let rebuilt = format_error_entry(&err, false);
                summary = truncate_utf8_bytes(&rebuilt, max_bytes).to_string();
            } else {
                err.message = truncate_utf8_bytes(&err.message, max_bytes).to_string();
                summary = truncate_utf8_bytes(&without_snip, max_bytes).to_string();
            }
            chosen.push(err);
        }
        break;
    }

    let final_tokens = estimate_tokens(&summary);
    (chosen, summary, final_tokens)
}
