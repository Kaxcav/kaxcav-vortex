//! Submodular L0-L3 token-budgeted context compiler (`SubmodularPacker`), `ETag` delta snapshots,
//! and `ReuseEnforcer` duplicate-utility guard.
//!
//! Traceability: `@REQ-VORTEX-003`.

use crate::graph::CsrGraph;
use crate::storage::{is_test_path, VortexShard};
use crate::types::{
    ContextFidelity, ContextPack, ContextRequest, ContextSlice, ReusableSymbolHint, SliceLevel,
    SymbolRecord, VortexResult,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

/// Default token budget when `ContextRequest.token_budget` is omitted.
pub const DEFAULT_CONTEXT_BUDGET_TOKENS: usize = 4000;

/// Submodular Personalized PageRank L0-L3 context compiler.
#[derive(Debug, Clone, Default)]
pub struct SubmodularPacker;

/// Identifies existing repository utilities matching task intent to prevent duplicate implementations.
#[derive(Debug, Clone, Default)]
pub struct ReuseEnforcer;

impl ReuseEnforcer {
    /// Finds existing exported symbols relevant to `task` that are not already focal L3 slices.
    pub fn find_reusable_symbols(
        shard: &VortexShard,
        task: &str,
        already_packed_keys: &HashSet<String>,
        limit: usize,
    ) -> VortexResult<Vec<ReusableSymbolHint>> {
        let cap = limit.clamp(1, 15);
        let search_res = shard.search(task, cap * 3)?;
        let mut hints = Vec::new();

        for hit in search_res.hits {
            if !hit.exported || is_test_path(&hit.file_path) || hit.kind == "text_match" {
                continue;
            }
            let key = format!("{}#{}", hit.file_path, hit.qualified_name);
            if already_packed_keys.contains(&key) && hints.len() >= 2 {
                continue;
            }
            hints.push(ReusableSymbolHint {
                file_path: hit.file_path,
                qualified_name: hit.qualified_name,
                kind: hit.kind,
                signature: hit.signature,
                line: hit.start_line,
                reason: "Existing exported symbol matches task keywords; reuse instead of duplicating.".to_string(),
            });
            if hints.len() >= cap {
                break;
            }
        }
        Ok(hints)
    }
}

impl SubmodularPacker {
    /// Creates a new `SubmodularPacker`.
    pub fn new() -> Self {
        Self
    }

    /// Compiles a token-budgeted `ContextPack` (`L0_DELTA`..`L3_FULL`) for `req`.
    pub fn pack(&self, shard: &VortexShard, req: &ContextRequest) -> VortexResult<ContextPack> {
        let budget_tokens = req
            .token_budget
            .unwrap_or(DEFAULT_CONTEXT_BUDGET_TOKENS)
            .max(1);
        let fidelity = req.fidelity.unwrap_or_default();

        let graph = CsrGraph::from_shard(shard)?;
        let search_res = shard.search(&req.task, 48)?;

        let mut file_seed_weights: HashMap<usize, f64> = HashMap::new();
        let mut sym_bonus: HashMap<String, f64> = HashMap::new();

        for entry_file in &req.entry_files {
            if let Ok(ignore) = shard.load_ignore() {
                if let Ok(resolved) = shard.resolve_indexed_file_path(entry_file, &ignore) {
                    if let Some(idx) = graph.index_of(&resolved) {
                        *file_seed_weights.entry(idx).or_insert(0.0) += 6.0;
                    }
                }
            }
        }

        for hit in &search_res.hits {
            if let Some(idx) = graph.index_of(&hit.file_path) {
                *file_seed_weights.entry(idx).or_insert(0.0) += hit.score.max(0.5);
            }
            let key = format!("{}#{}", hit.file_path, hit.qualified_name);
            let entry = sym_bonus.entry(key).or_insert(0.0);
            if hit.score > *entry {
                *entry = hit.score;
            }
        }

        let task_terms: Vec<String> = req
            .task
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| t.len() >= 3)
            .map(|t| t.to_ascii_lowercase())
            .collect();

        for (idx, path) in graph.nodes.iter().enumerate() {
            let lower_p = path.to_ascii_lowercase();
            for term in &task_terms {
                if lower_p.contains(term) {
                    *file_seed_weights.entry(idx).or_insert(0.0) += 1.5;
                }
            }
        }

        let seeds: Vec<(usize, f64)> = file_seed_weights.into_iter().collect();
        let ppr_scores = graph.ppr_default(&seeds);

        let all_symbols = shard.all_symbols()?;
        let mut candidates: Vec<(f64, SymbolRecord)> = Vec::with_capacity(all_symbols.len());
        let entry_set: HashSet<&str> = req.entry_files.iter().map(String::as_str).collect();

        for sym in all_symbols {
            let file_rank = graph
                .index_of(&sym.file_path)
                .and_then(|i| ppr_scores.get(i).copied())
                .unwrap_or(0.0);
            let key = format!("{}#{}", sym.file_path, sym.qualified_name);
            let fts_b = sym_bonus.get(&key).copied().unwrap_or(0.0);
            let exp_b = if sym.exported { 0.35 } else { 0.0 };
            let entry_b = if entry_set
                .iter()
                .any(|ef| sym.file_path == *ef || sym.file_path.ends_with(ef))
            {
                4.0
            } else {
                0.0
            };
            let hub_penalty = graph
                .index_of(&sym.file_path)
                .and_then(|i| graph.is_hub.get(i).copied())
                .map(|h| if h { 0.65 } else { 1.0 })
                .unwrap_or(1.0);
            let test_mult = if is_test_path(&sym.file_path) {
                0.55
            } else {
                1.0
            };

            let base_score =
                ((file_rank * 25.0) + fts_b + exp_b + entry_b) * hub_penalty * test_mult;
            candidates.push((base_score, sym));
        }

        candidates.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.file_path.cmp(&b.1.file_path))
                .then_with(|| a.1.start_line.cmp(&b.1.start_line))
        });

        let mut per_file_selected: HashMap<String, usize> = HashMap::new();
        let mut diversified: Vec<(f64, SymbolRecord)> = Vec::with_capacity(candidates.len());
        for (raw_score, sym) in candidates {
            let count_in_file = per_file_selected.entry(sym.file_path.clone()).or_insert(0);
            let discount = 1.0 / (1.0 + (*count_in_file as f64) * 0.45);
            *count_in_file += 1;
            diversified.push((raw_score * discount, sym));
        }
        diversified.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.file_path.cmp(&b.1.file_path))
        });

        let delta_snapshot = match req.delta_from.as_deref() {
            Some(base_etag) if !base_etag.is_empty() => shard.load_pack_snapshot(base_etag)?,
            _ => None,
        };

        let kvxignore = shard.load_ignore()?;
        let mut file_cache: HashMap<String, Vec<String>> = HashMap::new();
        let mut slices: Vec<ContextSlice> = Vec::new();
        let mut snapshot_hashes: BTreeMap<String, String> = BTreeMap::new();
        let mut packed_keys: HashSet<String> = HashSet::new();
        let mut used_tokens = 0usize;
        let mut estimated_raw_tokens = 0usize;

        for (score, sym) in diversified {
            if used_tokens >= budget_tokens {
                break;
            }
            if kvxignore.match_ignored(Path::new(&sym.file_path), false).is_some() {
                continue;
            }

            let lines = match file_cache.get(&sym.file_path) {
                Some(cached) => cached,
                None => {
                    let abs = shard.repo_root().join(&sym.file_path);
                    let Ok(raw) = fs::read_to_string(&abs) else {
                        continue;
                    };
                    let split: Vec<String> = raw.lines().map(String::from).collect();
                    file_cache.insert(sym.file_path.clone(), split);
                    file_cache
                        .get(&sym.file_path)
                        .unwrap_or_else(|| unreachable!())
                }
            };

            let start_idx = sym.start_line.saturating_sub(1).min(lines.len());
            let end_idx = sym.end_line.min(lines.len()).max(start_idx);
            let full_body = lines[start_idx..end_idx].join("\n");
            let raw_full_tokens = estimate_tokens(&full_body).max(1);

            let key = format!("{}#{}", sym.file_path, sym.qualified_name);
            let unchanged_in_delta = delta_snapshot
                .as_ref()
                .and_then(|snap| snap.get(&key))
                .map(|old_h| old_h == &sym.body_hash)
                .unwrap_or(false);

            let desired_level = if unchanged_in_delta {
                SliceLevel::L0Delta
            } else {
                match fidelity {
                    ContextFidelity::Full => SliceLevel::L3Full,
                    ContextFidelity::Compact => {
                        if slices.len() < 3 {
                            SliceLevel::L2Contract
                        } else {
                            SliceLevel::L1Outline
                        }
                    }
                    ContextFidelity::Graded => {
                        if used_tokens * 100 < budget_tokens * 45 {
                            SliceLevel::L3Full
                        } else if used_tokens * 100 < budget_tokens * 80 {
                            SliceLevel::L2Contract
                        } else {
                            SliceLevel::L1Outline
                        }
                    }
                }
            };

            let remaining = budget_tokens.saturating_sub(used_tokens);
            let Some((chosen_level, rendered, slice_tokens)) =
                render_fitting_slice(&sym, &full_body, desired_level, remaining)
            else {
                continue;
            };
            let current_md_bytes: usize = slices
                .iter()
                .map(|s: &ContextSlice| s.content.len() + usize::from(!s.content.ends_with('\n')))
                .sum();
            let next_md_bytes =
                current_md_bytes + rendered.len() + usize::from(!rendered.ends_with('\n'));
            if next_md_bytes.div_ceil(4) > budget_tokens {
                continue;
            }

            used_tokens = next_md_bytes.div_ceil(4);
            estimated_raw_tokens += lines.iter().map(|l| l.len() + 1).sum::<usize>().div_ceil(4).max(raw_full_tokens);
            snapshot_hashes.insert(key.clone(), sym.body_hash.clone());
            packed_keys.insert(key);

            slices.push(ContextSlice {
                file_path: sym.file_path,
                symbol_name: Some(sym.name),
                qualified_name: Some(sym.qualified_name),
                kind: sym.kind,
                level: chosen_level,
                start_line: sym.start_line,
                end_line: sym.end_line,
                score,
                tokens: slice_tokens,
                body_hash: sym.body_hash,
                content: rendered,
            });
        }

        let mut etag_material = format!("{}:{:?}:{}:", shard.repo_id(), fidelity, budget_tokens);
        for s in &slices {
            etag_material.push_str(&s.file_path);
            etag_material.push(':');
            etag_material.push_str(s.qualified_name.as_deref().unwrap_or(""));
            etag_material.push(':');
            etag_material.push_str(&s.body_hash);
            etag_material.push(';');
        }
        let etag = format!(
            "kvx-{}",
            &blake3::hash(etag_material.as_bytes()).to_hex()[..16]
        );

        shard.save_pack_snapshot(&etag, &snapshot_hashes)?;

        if req.if_none_match.as_deref() == Some(etag.as_str()) {
            return Ok(ContextPack {
                repo_id: shard.repo_id().to_string(),
                task: req.task.clone(),
                fidelity,
                budget_tokens,
                token_count: 0,
                estimated_raw_tokens,
                savings_ratio: 1.0,
                etag,
                unchanged: true,
                delta_base: req.delta_from.clone(),
                slices: Vec::new(),
                reusable_symbols: Vec::new(),
                markdown: String::new(),
            });
        }

        let reusable_symbols =
            ReuseEnforcer::find_reusable_symbols(shard, &req.task, &packed_keys, 6)?;

        let mut markdown = String::new();
        for s in &slices {
            markdown.push_str(&s.content);
            if !markdown.ends_with('\n') {
                markdown.push('\n');
            }
        }
        let final_tokens = estimate_tokens(&markdown);
        let savings_ratio = if estimated_raw_tokens > final_tokens && estimated_raw_tokens > 0 {
            1.0 - (final_tokens as f64 / estimated_raw_tokens as f64)
        } else {
            0.0
        };

        Ok(ContextPack {
            repo_id: shard.repo_id().to_string(),
            task: req.task.clone(),
            fidelity,
            budget_tokens,
            token_count: final_tokens,
            estimated_raw_tokens,
            savings_ratio,
            etag,
            unchanged: false,
            delta_base: req.delta_from.clone(),
            slices,
            reusable_symbols,
            markdown,
        })
    }
}

fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.len().div_ceil(4)
    }
}

fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    let mut end = s.len().min(max_bytes);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn render_fitting_slice(
    sym: &SymbolRecord,
    full_body: &str,
    desired: SliceLevel,
    remaining_budget: usize,
) -> Option<(SliceLevel, String, usize)> {
    if remaining_budget == 0 {
        return None;
    }

    let levels_to_try: &[SliceLevel] = match desired {
        SliceLevel::L0Delta => &[SliceLevel::L0Delta],
        SliceLevel::L3Full => &[
            SliceLevel::L3Full,
            SliceLevel::L2Contract,
            SliceLevel::L1Outline,
        ],
        SliceLevel::L2Contract => &[SliceLevel::L2Contract, SliceLevel::L1Outline],
        SliceLevel::L1Outline => &[SliceLevel::L1Outline],
    };

    for &lvl in levels_to_try {
        let rendered = match lvl {
            SliceLevel::L0Delta => format!(
                "// [L0_DELTA unchanged] {}#{} (L{}-L{})\n",
                sym.file_path, sym.qualified_name, sym.start_line, sym.end_line
            ),
            SliceLevel::L1Outline => format!(
                "// [L1_OUTLINE] {}#{} ({} L{}-L{})\n",
                sym.file_path, sym.qualified_name, sym.kind, sym.start_line, sym.end_line
            ),
            SliceLevel::L2Contract => match &sym.docstring {
                Some(doc) => format!(
                    "// [L2_CONTRACT] {} (L{}-L{})\n/// {}\n{};\n",
                    sym.file_path, sym.start_line, sym.end_line, doc, sym.signature
                ),
                None => format!(
                    "// [L2_CONTRACT] {} (L{}-L{})\n{};\n",
                    sym.file_path, sym.start_line, sym.end_line, sym.signature
                ),
            },
            SliceLevel::L3Full => format!(
                "// [L3_FULL] {}#{} (L{}-L{})\n{}\n",
                sym.file_path, sym.qualified_name, sym.start_line, sym.end_line, full_body
            ),
        };
        let toks = estimate_tokens(&rendered).max(1);
        if toks <= remaining_budget {
            return Some((lvl, rendered, toks));
        }
    }

    if remaining_budget >= 4 {
        let max_bytes = remaining_budget.saturating_mul(4);
        let compact = format!("// {}:{}\n", sym.file_path, sym.qualified_name);
        let clipped = truncate_utf8_bytes(&compact, max_bytes).to_string();
        let toks = estimate_tokens(&clipped).max(1);
        if !clipped.is_empty() && toks <= remaining_budget {
            return Some((SliceLevel::L1Outline, clipped, toks));
        }
    }

    None
}
