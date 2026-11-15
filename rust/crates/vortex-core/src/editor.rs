//! AST-bounded surgical `SymbolEditor` and atomic `TwoPhaseRenamer` enforcing `.kvxignore`,
//! `expected_hash`, `symbol_locks` (`frozen` vs `allow_body_only`), BOM/CRLF preservation,
//! and native `tree-sitter` syntax verification.
//!
//! Traceability: `@REQ-VORTEX-004`.

use crate::kvxignore::KvxIgnore;
use crate::parser::AstParser;
use crate::storage::VortexShard;
use crate::types::{
    EditSymbolRequest, EditSymbolResult, LockMode, RefConfidence, RenameEditSite,
    RenameSymbolRequest, RenameSymbolResult, SymbolEditOp, SymbolLock, VortexError, VortexResult,
};
use regex::Regex;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
struct FileEncoding {
    has_bom: bool,
    crlf: bool,
    trailing_newline: bool,
    lines: Vec<String>,
}

impl FileEncoding {
    fn parse(raw: &str) -> Self {
        let (has_bom, body) = match raw.strip_prefix('\u{feff}') {
            Some(stripped) => (true, stripped),
            None => (false, raw),
        };
        let crlf = body.contains("\r\n");
        let normalized = if crlf {
            body.replace("\r\n", "\n")
        } else {
            body.to_string()
        };
        let trailing_newline = normalized.ends_with('\n');
        let lines: Vec<String> = normalized.lines().map(String::from).collect();
        Self {
            has_bom,
            crlf,
            trailing_newline,
            lines,
        }
    }

    fn render(&self, updated_lines: &[String]) -> String {
        let sep = if self.crlf { "\r\n" } else { "\n" };
        let mut out = String::new();
        if self.has_bom {
            out.push('\u{feff}');
        }
        out.push_str(&updated_lines.join(sep));
        if self.trailing_newline && !updated_lines.is_empty() {
            out.push_str(sep);
        }
        out
    }
}

/// AST-bounded surgical symbol editor (`replace`, `insert_before`, `insert_after`, `delete`).
#[derive(Debug, Clone, Default)]
pub struct SymbolEditor;

impl SymbolEditor {
    /// Creates a new `SymbolEditor`.
    pub fn new() -> Self {
        Self
    }

    /// Executes or dry-runs a surgical symbol edit on `shard`.
    pub fn edit_symbol(
        shard: &VortexShard,
        req: &EditSymbolRequest,
        extra_locks: &[SymbolLock],
    ) -> VortexResult<EditSymbolResult> {
        let kvxignore = shard.load_ignore()?;
        validate_request_hints(&kvxignore, &req.symbol, req.file_path.as_deref())?;

        let lookup = shard.read_symbol(&req.symbol, req.file_path.as_deref())?;
        if lookup.matches.is_empty() {
            return Err(VortexError::SymbolNotFound(req.symbol.clone()));
        }
        if lookup.matches.len() > 1 {
            return Err(VortexError::AmbiguousSymbol {
                symbol: req.symbol.clone(),
                candidates: lookup
                    .matches
                    .iter()
                    .map(|m| format!("{}#{}", m.symbol.file_path, m.symbol.qualified_name))
                    .collect(),
            });
        }

        let target_sym = &lookup.matches[0].symbol;
        let (safe_rel, abs_path) =
            ensure_regular_contained_file(&kvxignore, Path::new(&target_sym.file_path))?;
        let raw_disk = fs::read_to_string(&abs_path)?;
        let enc = FileEncoding::parse(&raw_disk);

        if target_sym.start_line == 0
            || target_sym.end_line > enc.lines.len()
            || target_sym.start_line > target_sym.end_line
        {
            return Err(VortexError::InvalidInput(format!(
                "Indexed symbol '{}' span L{}-L{} is out of bounds for '{}' ({} lines); run sync first",
                target_sym.qualified_name,
                target_sym.start_line,
                target_sym.end_line,
                safe_rel,
                enc.lines.len()
            )));
        }

        let start_idx = target_sym.start_line - 1;
        let end_idx = target_sym.end_line;
        let disk_slice = enc.lines[start_idx..end_idx].join("\n");
        let live_body_hash = blake3::hash(disk_slice.as_bytes()).to_hex().to_string();

        if live_body_hash != target_sym.body_hash {
            return Err(VortexError::HashMismatch {
                symbol: target_sym.qualified_name.clone(),
                expected: target_sym.body_hash.clone(),
                actual: live_body_hash,
            });
        }

        if let Some(ref exp_hash) = req.expected_hash {
            if !exp_hash.is_empty() && exp_hash != &live_body_hash {
                return Err(VortexError::HashMismatch {
                    symbol: target_sym.qualified_name.clone(),
                    expected: exp_hash.clone(),
                    actual: live_body_hash,
                });
            }
        }

        let mut all_locks = shard.list_locks()?;
        all_locks.extend_from_slice(extra_locks);

        let ext = abs_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let mut allow_body_only_lock: Option<&SymbolLock> = None;
        for lock in &all_locks {
            if lock.file_path != target_sym.file_path {
                continue;
            }
            if lock.qualified_name == target_sym.qualified_name {
                match lock.mode {
                    LockMode::Frozen => {
                        return Err(VortexError::LockViolation {
                            symbol: target_sym.qualified_name.clone(),
                            mode: LockMode::Frozen,
                            reason: format!(
                                "Symbol '{}' is frozen by '{}': {}",
                                target_sym.qualified_name, lock.owner, lock.reason
                            ),
                        });
                    }
                    LockMode::AllowBodyOnly => match req.op {
                        SymbolEditOp::Replace => {
                            allow_body_only_lock = Some(lock);
                        }
                        SymbolEditOp::Delete
                        | SymbolEditOp::InsertBefore
                        | SymbolEditOp::InsertAfter => {
                            return Err(VortexError::LockViolation {
                                symbol: target_sym.qualified_name.clone(),
                                mode: LockMode::AllowBodyOnly,
                                reason: format!(
                                    "Only body replacement is permitted under allow_body_only lock ({})",
                                    lock.reason
                                ),
                            });
                        }
                    },
                }
            } else if lock.mode == LockMode::Frozen {
                if let Ok(lock_lookup) = shard.read_symbol(&lock.qualified_name, Some(&safe_rel)) {
                    if let Some(m) = lock_lookup.matches.first() {
                        if m.symbol.start_line <= target_sym.start_line
                            && m.symbol.end_line >= target_sym.end_line
                        {
                            return Err(VortexError::LockViolation {
                                symbol: target_sym.qualified_name.clone(),
                                mode: LockMode::Frozen,
                                reason: format!(
                                    "Enclosing symbol '{}' is frozen by '{}': {}",
                                    lock.qualified_name, lock.owner, lock.reason
                                ),
                            });
                        }
                    }
                }
            }
        }

        let new_code_norm = req.new_code.replace("\r\n", "\n");
        let new_lines: Vec<String> = if new_code_norm.is_empty() {
            Vec::new()
        } else {
            new_code_norm.lines().map(String::from).collect()
        };

        let mut updated_lines = Vec::with_capacity(enc.lines.len() + new_lines.len());
        let (new_start_line, new_end_line) = match req.op {
            SymbolEditOp::Replace => {
                updated_lines.extend_from_slice(&enc.lines[..start_idx]);
                let s_ln = updated_lines.len() + 1;
                updated_lines.extend(new_lines.iter().cloned());
                let e_ln = updated_lines.len().max(s_ln);
                updated_lines.extend_from_slice(&enc.lines[end_idx..]);
                (s_ln, e_ln)
            }
            SymbolEditOp::InsertBefore => {
                updated_lines.extend_from_slice(&enc.lines[..start_idx]);
                let s_ln = updated_lines.len() + 1;
                updated_lines.extend(new_lines.iter().cloned());
                let e_ln = updated_lines.len().max(s_ln);
                updated_lines.extend_from_slice(&enc.lines[start_idx..]);
                (s_ln, e_ln)
            }
            SymbolEditOp::InsertAfter => {
                updated_lines.extend_from_slice(&enc.lines[..end_idx]);
                let s_ln = updated_lines.len() + 1;
                updated_lines.extend(new_lines.iter().cloned());
                let e_ln = updated_lines.len().max(s_ln);
                updated_lines.extend_from_slice(&enc.lines[end_idx..]);
                (s_ln, e_ln)
            }
            SymbolEditOp::Delete => {
                updated_lines.extend_from_slice(&enc.lines[..start_idx]);
                updated_lines.extend_from_slice(&enc.lines[end_idx..]);
                (target_sym.start_line, target_sym.start_line)
            }
        };

        let rendered_full = enc.render(&updated_lines);
        let syntax_check_body = rendered_full
            .strip_prefix('\u{feff}')
            .unwrap_or(&rendered_full);
        let before_body = raw_disk.strip_prefix('\u{feff}').unwrap_or(&raw_disk);

        let before_errs = AstParser::syntax_error_count(&ext, before_body).unwrap_or(0);
        let after_errs = AstParser::syntax_error_count(&ext, syntax_check_body).unwrap_or(0);
        let syntax_valid = after_errs == 0;

        if after_errs > before_errs && (!req.allow_syntax_errors || allow_body_only_lock.is_some())
        {
            return Err(VortexError::SyntaxError {
                path: safe_rel,
                detail: format!(
                    "Edit introduced {} tree-sitter syntax error(s) (before: {}, after: {})",
                    after_errs - before_errs,
                    before_errs,
                    after_errs
                ),
            });
        }

        if let Some(lock) = allow_body_only_lock {
            verify_allow_body_only_preservation(
                &safe_rel,
                &ext,
                before_body,
                syntax_check_body,
                &target_sym.qualified_name,
                lock,
            )?;
        }

        let new_slice_text = new_lines.join("\n");
        let new_body_hash = blake3::hash(new_slice_text.as_bytes()).to_hex().to_string();
        let preview_diff = build_compact_diff(
            &safe_rel,
            target_sym.start_line,
            &enc.lines[start_idx..end_idx],
            &new_lines,
            req.op,
        );

        if !req.dry_run {
            let (_, verified_abs) =
                ensure_regular_contained_file(&kvxignore, Path::new(&safe_rel))?;
            atomic_write_preserving_perms(&verified_abs, rendered_full.as_bytes())?;
            shard.reindex_file(&safe_rel)?;
        }

        Ok(EditSymbolResult {
            applied: !req.dry_run,
            dry_run: req.dry_run,
            file_path: safe_rel,
            qualified_name: target_sym.qualified_name.clone(),
            op: req.op,
            old_body_hash: live_body_hash,
            new_body_hash,
            start_line: new_start_line,
            end_line: new_end_line,
            syntax_valid,
            preview_diff,
        })
    }
}

/// Atomic two-phase cross-file identifier renamer (`plan` -> `plan_token` -> verified `apply`).
#[derive(Debug, Clone, Default)]
pub struct TwoPhaseRenamer;

impl TwoPhaseRenamer {
    /// Creates a new `TwoPhaseRenamer`.
    pub fn new() -> Self {
        Self
    }

    /// Executes Phase 1 (`plan_token == None`) or Phase 2 (`plan_token == Some(...)`) symbol rename.
    pub fn rename_symbol(
        shard: &VortexShard,
        req: &RenameSymbolRequest,
        extra_locks: &[SymbolLock],
    ) -> VortexResult<RenameSymbolResult> {
        validate_identifier(&req.new_name)?;

        let kvxignore = shard.load_ignore()?;
        validate_request_hints(&kvxignore, &req.symbol, req.file_path.as_deref())?;

        let lookup = shard.read_symbol(&req.symbol, req.file_path.as_deref())?;
        if lookup.matches.is_empty() {
            return Err(VortexError::SymbolNotFound(req.symbol.clone()));
        }
        if lookup.matches.len() > 1 {
            return Err(VortexError::AmbiguousSymbol {
                symbol: req.symbol.clone(),
                candidates: lookup
                    .matches
                    .iter()
                    .map(|m| format!("{}#{}", m.symbol.file_path, m.symbol.qualified_name))
                    .collect(),
            });
        }

        let target_sym = &lookup.matches[0].symbol;
        let (target_safe_rel, target_abs_path) =
            ensure_regular_contained_file(&kvxignore, Path::new(&target_sym.file_path))?;

        let old_name = target_sym.name.clone();
        if old_name == req.new_name {
            return Err(VortexError::InvalidInput(format!(
                "new_name '{}' is identical to current symbol name",
                req.new_name
            )));
        }

        let mut all_locks = shard.list_locks()?;
        all_locks.extend_from_slice(extra_locks);
        for lock in &all_locks {
            if lock.file_path == target_sym.file_path
                && lock.qualified_name == target_sym.qualified_name
            {
                return Err(VortexError::LockViolation {
                    symbol: target_sym.qualified_name.clone(),
                    mode: lock.mode,
                    reason: format!(
                        "Cannot rename locked symbol '{}' (owner: {})",
                        target_sym.qualified_name, lock.owner
                    ),
                });
            }
        }

        let target_raw_disk = fs::read_to_string(&target_abs_path)?;
        let target_enc = FileEncoding::parse(&target_raw_disk);
        let target_norm_body = target_enc.lines.join("\n");
        let target_ext = target_abs_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let decl_site = AstParser::find_decl_identifier_site(
            &target_ext,
            &target_norm_body,
            target_sym.start_line,
            target_sym.end_line,
            &old_name,
        )
        .or_else(|| {
            for ln in target_sym.start_line..=target_sym.end_line {
                let cols = AstParser::find_identifier_columns_on_line(
                    &target_ext,
                    &target_norm_body,
                    ln,
                    &old_name,
                );
                if let Some(&first_col) = cols.first() {
                    return Some((ln, first_col));
                }
            }
            None
        });

        let all_refs = shard.find_references(
            &target_sym.qualified_name,
            Some(&target_safe_rel),
            500,
            true,
        )?;

        let mut sites_by_file: BTreeMap<String, Vec<(usize, Option<usize>, RefConfidence)>> =
            BTreeMap::new();
        if let Some((decl_ln, decl_col)) = decl_site {
            sites_by_file
                .entry(target_safe_rel.clone())
                .or_default()
                .push((decl_ln, Some(decl_col), RefConfidence::SameFile));
        } else {
            sites_by_file
                .entry(target_safe_rel.clone())
                .or_default()
                .push((target_sym.start_line, None, RefConfidence::SameFile));
        }

        let mut skipped_name_only = Vec::new();
        for r in all_refs.references {
            if r.confidence == RefConfidence::NameOnly && !req.include_name_only {
                skipped_name_only.push(RenameEditSite {
                    file_path: r.file_path,
                    line: r.line,
                    col: r.col,
                    confidence: r.confidence,
                    preview: r.context_line.unwrap_or_default(),
                });
                continue;
            }
            sites_by_file
                .entry(r.file_path)
                .or_default()
                .push((r.line, Some(r.col), r.confidence));
        }

        let mut prepared_writes: Vec<(String, PathBuf, String)> = Vec::new();
        let mut edit_sites_report: Vec<RenameEditSite> = Vec::new();
        let mut token_material = format!(
            "rename:{}:{}:{}:",
            old_name, req.new_name, req.include_name_only
        );

        for (file_path, mut raw_sites) in sites_by_file {
            let (safe_rel, abs_path) =
                ensure_regular_contained_file(&kvxignore, Path::new(&file_path))?;
            let raw_disk = fs::read_to_string(&abs_path)?;
            let pre_hash = blake3::hash(raw_disk.as_bytes()).to_hex().to_string();
            token_material.push_str(&safe_rel);
            token_material.push('@');
            token_material.push_str(&pre_hash);
            token_material.push(';');

            let mut enc = FileEncoding::parse(&raw_disk);
            let normalized_body = enc.lines.join("\n");
            let ext = abs_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();

            if safe_rel != target_safe_rel {
                for (idx, line_txt) in enc.lines.iter().enumerate() {
                    if !line_txt.contains(&old_name) {
                        continue;
                    }
                    let trimmed_ln = line_txt.trim_start();
                    if trimmed_ln.starts_with("use ")
                        || trimmed_ln.starts_with("pub use ")
                        || trimmed_ln.starts_with("import ")
                        || trimmed_ln.starts_with("from ")
                    {
                        let ln_1based = idx + 1;
                        let import_cols = AstParser::find_identifier_columns_on_line(
                            &ext,
                            &normalized_body,
                            ln_1based,
                            &old_name,
                        );
                        for ic in import_cols {
                            raw_sites.push((ln_1based, Some(ic), RefConfidence::Imported));
                        }
                    }
                }
            }

            for lock in &all_locks {
                if lock.file_path == safe_rel && lock.mode == LockMode::Frozen {
                    if let Ok(lock_sym) = shard.read_symbol(&lock.qualified_name, Some(&safe_rel)) {
                        if let Some(m) = lock_sym.matches.first() {
                            let s_ln = m.symbol.start_line;
                            let e_ln = m.symbol.end_line;
                            if raw_sites
                                .iter()
                                .any(|&(ln, _, _)| ln >= s_ln && ln <= e_ln)
                            {
                                return Err(VortexError::LockViolation {
                                    symbol: lock.qualified_name.clone(),
                                    mode: LockMode::Frozen,
                                    reason: format!(
                                        "Rename touches frozen symbol '{}' in '{}'",
                                        lock.qualified_name, safe_rel
                                    ),
                                });
                            }
                        }
                    }
                }
            }

            let mut by_line: HashMap<usize, Vec<(Option<usize>, RefConfidence)>> = HashMap::new();
            raw_sites.sort_by_key(|&(ln, col, _)| (ln, col.unwrap_or(0)));
            for (ln, col_opt, conf) in raw_sites {
                by_line.entry(ln).or_default().push((col_opt, conf));
            }

            let mut sorted_lines: Vec<usize> = by_line.keys().copied().collect();
            sorted_lines.sort_unstable();

            let mut changed_in_file = false;
            for ln in sorted_lines {
                if ln == 0 || ln > enc.lines.len() {
                    continue;
                }
                let line_str = enc.lines[ln - 1].clone();
                let entries = by_line.get(&ln).cloned().unwrap_or_default();
                let safe_cols = AstParser::find_identifier_columns_on_line(
                    &ext,
                    &normalized_body,
                    ln,
                    &old_name,
                );

                let mut byte_spans: Vec<(usize, usize, RefConfidence)> = Vec::new();
                for (col_opt, conf) in entries {
                    if let Some(col_1based) = col_opt {
                        let start_b = col_1based.saturating_sub(1);
                        let end_b = start_b.saturating_add(old_name.len());
                        if safe_cols.contains(&col_1based)
                            && end_b <= line_str.len()
                            && line_str.is_char_boundary(start_b)
                            && line_str.is_char_boundary(end_b)
                            && line_str.get(start_b..end_b) == Some(old_name.as_str())
                        {
                            byte_spans.push((start_b, end_b, conf));
                            continue;
                        }
                    }
                    for &c1 in &safe_cols {
                        let sb = c1.saturating_sub(1);
                        let eb = sb.saturating_add(old_name.len());
                        byte_spans.push((sb, eb, conf));
                    }
                }

                byte_spans.sort_by_key(|&(s, e, _)| (s, e));
                let mut valid_spans: Vec<(usize, usize, RefConfidence)> =
                    Vec::with_capacity(byte_spans.len());
                let mut prev_end = 0usize;
                for (start_b, end_b, conf) in byte_spans {
                    if start_b < prev_end
                        || start_b >= end_b
                        || end_b > line_str.len()
                        || !line_str.is_char_boundary(start_b)
                        || !line_str.is_char_boundary(end_b)
                        || line_str.get(start_b..end_b) != Some(old_name.as_str())
                    {
                        continue;
                    }
                    prev_end = end_b;
                    valid_spans.push((start_b, end_b, conf));
                }

                if valid_spans.is_empty() {
                    continue;
                }

                let mut updated_line = line_str.clone();
                for &(start_b, end_b, conf) in valid_spans.iter().rev() {
                    updated_line.replace_range(start_b..end_b, &req.new_name);
                    edit_sites_report.push(RenameEditSite {
                        file_path: safe_rel.clone(),
                        line: ln,
                        col: start_b + 1,
                        confidence: conf,
                        preview: updated_line.trim().chars().take(160).collect(),
                    });
                }
                enc.lines[ln - 1] = updated_line;
                changed_in_file = true;
            }

            if !changed_in_file {
                continue;
            }

            let rendered_full = enc.render(&enc.lines);
            let before_body = raw_disk.strip_prefix('\u{feff}').unwrap_or(&raw_disk);
            let after_body = rendered_full
                .strip_prefix('\u{feff}')
                .unwrap_or(&rendered_full);
            let before_errs = AstParser::syntax_error_count(&ext, before_body).unwrap_or(0);
            let after_errs = AstParser::syntax_error_count(&ext, after_body).unwrap_or(0);

            if after_errs > before_errs && !req.allow_syntax_errors {
                return Err(VortexError::SyntaxError {
                    path: safe_rel,
                    detail: format!(
                        "Rename to '{}' introduced tree-sitter syntax errors",
                        req.new_name
                    ),
                });
            }

            prepared_writes.push((safe_rel, abs_path, rendered_full));
        }

        edit_sites_report
            .sort_by(|a, b| (&a.file_path, a.line, a.col).cmp(&(&b.file_path, b.line, b.col)));
        let computed_token = format!(
            "ren-{}",
            &blake3::hash(token_material.as_bytes()).to_hex()[..16]
        );
        let files_touched: Vec<String> =
            prepared_writes.iter().map(|(p, _, _)| p.clone()).collect();

        let Some(ref provided_token) = req.plan_token else {
            return Ok(RenameSymbolResult {
                phase: "planned".to_string(),
                applied: false,
                old_name,
                new_name: req.new_name.clone(),
                plan_token: computed_token,
                files_touched,
                edits: edit_sites_report,
                skipped_name_only,
            });
        };

        if provided_token != &computed_token {
            return Err(VortexError::StalePlanToken {
                expected: provided_token.clone(),
                actual: computed_token,
            });
        }

        let mut staged_tmps: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(prepared_writes.len());
        for (rel_path, _, rendered) in &prepared_writes {
            let (_, verified_abs) = ensure_regular_contained_file(&kvxignore, Path::new(rel_path))?;
            let tmp_path = stage_temp_file_preserving_perms(&verified_abs, rendered.as_bytes())?;
            staged_tmps.push((tmp_path, verified_abs));
        }

        for (tmp_path, abs_path) in staged_tmps {
            fs::rename(&tmp_path, &abs_path)?;
        }

        for (rel_path, _, _) in &prepared_writes {
            shard.reindex_file(rel_path)?;
        }

        Ok(RenameSymbolResult {
            phase: "applied".to_string(),
            applied: true,
            old_name,
            new_name: req.new_name.clone(),
            plan_token: computed_token,
            files_touched,
            edits: edit_sites_report,
            skipped_name_only,
        })
    }
}

fn validate_request_hints(
    kvxignore: &KvxIgnore,
    symbol_query: &str,
    file_hint: Option<&str>,
) -> VortexResult<()> {
    if let Some(fh) = file_hint {
        let trimmed = fh.trim();
        if !trimmed.is_empty() {
            kvxignore.resolve_contained_path(Path::new(trimmed))?;
        }
    }
    if let Some((fp, _)) = symbol_query.split_once('#') {
        let trimmed_fp = fp.trim();
        if !trimmed_fp.is_empty() {
            kvxignore.resolve_contained_path(Path::new(trimmed_fp))?;
        }
    }
    Ok(())
}

fn ensure_regular_contained_file(
    kvxignore: &KvxIgnore,
    rel_or_abs: &Path,
) -> VortexResult<(String, PathBuf)> {
    let (safe_rel, abs_path) = kvxignore.resolve_contained_path(rel_or_abs)?;
    let sym_meta = fs::symlink_metadata(&abs_path)?;
    if sym_meta.file_type().is_symlink() {
        return Err(VortexError::InvalidInput(format!(
            "Refusing to mutate symbolic link '{}' directly",
            safe_rel
        )));
    }
    let canon = abs_path.canonicalize()?;
    if !canon.starts_with(kvxignore.repo_root()) {
        return Err(VortexError::InvalidInput(format!(
            "Target '{}' canonicalizes outside repository root '{}'",
            safe_rel,
            kvxignore.repo_root().display()
        )));
    }
    Ok((safe_rel, canon))
}

fn verify_allow_body_only_preservation(
    file_path: &str,
    ext: &str,
    before_body: &str,
    after_body: &str,
    target_qualified_name: &str,
    lock: &SymbolLock,
) -> VortexResult<()> {
    let parser = AstParser::new();
    let before_parsed = parser.parse_file(file_path, ext, before_body);
    let after_parsed = parser.parse_file(file_path, ext, after_body);

    if after_parsed.symbols.len() != before_parsed.symbols.len() {
        return Err(VortexError::LockViolation {
            symbol: target_qualified_name.to_string(),
            mode: LockMode::AllowBodyOnly,
            reason: format!(
                "Symbol declaration count changed ({} -> {}) under allow_body_only lock ({})",
                before_parsed.symbols.len(),
                after_parsed.symbols.len(),
                lock.reason
            ),
        });
    }

    let mut matched_target = false;
    for (b_sym, a_sym) in before_parsed.symbols.iter().zip(after_parsed.symbols.iter()) {
        if b_sym.qualified_name == target_qualified_name {
            matched_target = true;
        }
        if b_sym.qualified_name != a_sym.qualified_name
            || b_sym.name != a_sym.name
            || b_sym.kind != a_sym.kind
            || b_sym.exported != a_sym.exported
            || b_sym.signature != a_sym.signature
            || b_sym.sig_hash != a_sym.sig_hash
        {
            return Err(VortexError::LockViolation {
                symbol: target_qualified_name.to_string(),
                mode: LockMode::AllowBodyOnly,
                reason: format!(
                    "Signature or contract modification on '{}' ('{}' -> '{}') forbidden by allow_body_only lock ({})",
                    b_sym.qualified_name, b_sym.signature, a_sym.signature, lock.reason
                ),
            });
        }
    }

    if !matched_target {
        return Err(VortexError::LockViolation {
            symbol: target_qualified_name.to_string(),
            mode: LockMode::AllowBodyOnly,
            reason: format!(
                "Target symbol '{}' missing after allow_body_only edit ({})",
                target_qualified_name, lock.reason
            ),
        });
    }

    Ok(())
}

fn validate_identifier(ident: &str) -> VortexResult<()> {
    static IDENT_RE: OnceLock<Regex> = OnceLock::new();
    let re = IDENT_RE.get_or_init(|| {
        Regex::new(r"^[A-Za-z_$][A-Za-z0-9_$]*$").unwrap_or_else(|_| unreachable!())
    });
    if !re.is_match(ident) {
        return Err(VortexError::InvalidInput(format!(
            "Invalid identifier '{}': must match [A-Za-z_$][A-Za-z0-9_$]*",
            ident
        )));
    }
    Ok(())
}

fn stage_temp_file_preserving_perms(target_path: &Path, bytes: &[u8]) -> VortexResult<PathBuf> {
    let parent = target_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp_name = format!(".{}.kvx-{}.tmp", file_name, uuid::Uuid::new_v4());
    let tmp_path = parent.join(tmp_name);
    fs::write(&tmp_path, bytes)?;
    if let Ok(meta) = fs::metadata(target_path) {
        let _ = fs::set_permissions(&tmp_path, meta.permissions());
    }
    Ok(tmp_path)
}

fn atomic_write_preserving_perms(target_path: &Path, bytes: &[u8]) -> VortexResult<()> {
    let tmp = stage_temp_file_preserving_perms(target_path, bytes)?;
    fs::rename(tmp, target_path)?;
    Ok(())
}

fn build_compact_diff(
    file_path: &str,
    start_line: usize,
    old_lines: &[String],
    new_lines: &[String],
    op: SymbolEditOp,
) -> String {
    let mut diff = format!("--- a/{file_path}\n+++ b/{file_path}\n@@ -{start_line} @@\n");
    if matches!(op, SymbolEditOp::Replace | SymbolEditOp::Delete) {
        for l in old_lines.iter().take(16) {
            diff.push_str("- ");
            diff.push_str(l);
            diff.push('\n');
        }
    }
    if !matches!(op, SymbolEditOp::Delete) {
        for l in new_lines.iter().take(16) {
            diff.push_str("+ ");
            diff.push_str(l);
            diff.push('\n');
        }
    }
    diff
}
