//! Multi-repository contract & HTTP route federation engine.
//!
//! Traceability: `@REQ-VORTEX-002`.

use crate::storage::VortexShard;
use crate::types::{FederationLink, RouteRecord, SymbolRecord, VortexResult};
use std::collections::HashMap;

/// Discovers cross-repository HTTP route, SQL table, and exported type links across shards.
#[derive(Debug, Clone, Default)]
pub struct MultiRepoFederator;

impl MultiRepoFederator {
    /// Creates a new `MultiRepoFederator`.
    pub fn new() -> Self {
        Self
    }

    /// Computes cross-repository `FederationLink`s across two or more `VortexShard`s.
    pub fn federate(shards: &[&VortexShard]) -> VortexResult<Vec<FederationLink>> {
        if shards.len() < 2 {
            return Ok(Vec::new());
        }

        let mut routes_by_repo: Vec<(&str, Vec<RouteRecord>)> = Vec::with_capacity(shards.len());
        let mut syms_by_repo: Vec<(&str, Vec<SymbolRecord>)> = Vec::with_capacity(shards.len());

        for shard in shards {
            routes_by_repo.push((shard.repo_id(), shard.all_routes()?));
            syms_by_repo.push((shard.repo_id(), shard.all_symbols()?));
        }

        let mut links = Vec::new();

        for (i, (consumer_repo, consumer_routes)) in routes_by_repo.iter().enumerate() {
            for (j, (provider_repo, provider_routes)) in routes_by_repo.iter().enumerate() {
                if i == j {
                    continue;
                }
                for cr in consumer_routes.iter().filter(|r| r.direction == "consume") {
                    for pr in provider_routes.iter().filter(|r| r.direction == "expose") {
                        let method_ok = pr.method == "ALL"
                            || pr.method == "ANY"
                            || cr.method == pr.method;
                        if method_ok && route_paths_match(&pr.route_path, &cr.route_path) {
                            links.push(FederationLink {
                                source_repo: (*consumer_repo).to_string(),
                                source_file: cr.file_path.clone(),
                                source_symbol: format!("{} {}", cr.method, cr.route_path),
                                target_repo: (*provider_repo).to_string(),
                                target_file: pr.file_path.clone(),
                                target_symbol: pr
                                    .handler_name
                                    .clone()
                                    .unwrap_or_else(|| format!("{} {}", pr.method, pr.route_path)),
                                kind: "http_route".to_string(),
                                detail: format!(
                                    "{} {} -> {}",
                                    cr.method, cr.route_path, pr.route_path
                                ),
                                confidence: if cr.route_path == pr.route_path {
                                    0.96
                                } else {
                                    0.85
                                },
                            });
                        }
                    }
                }
            }
        }

        let mut exported_contracts: HashMap<String, Vec<(&str, &SymbolRecord)>> = HashMap::new();
        for (repo_id, syms) in &syms_by_repo {
            for sym in syms {
                if sym.exported
                    && matches!(
                        sym.kind.as_str(),
                        "interface" | "type" | "struct" | "enum" | "trait" | "table"
                    )
                    && sym.name.len() >= 4
                {
                    exported_contracts
                        .entry(sym.name.clone())
                        .or_default()
                        .push((repo_id, sym));
                }
            }
        }

        for (contract_name, occurrences) in exported_contracts {
            if occurrences.len() < 2 || occurrences.len() > 8 {
                continue;
            }
            for a_idx in 0..occurrences.len() {
                for b_idx in (a_idx + 1)..occurrences.len() {
                    let (repo_a, sym_a) = occurrences[a_idx];
                    let (repo_b, sym_b) = occurrences[b_idx];
                    if repo_a == repo_b {
                        continue;
                    }
                    let kind = if sym_a.kind == "table" || sym_b.kind == "table" {
                        "sql_table"
                    } else {
                        "shared_contract"
                    };
                    links.push(FederationLink {
                        source_repo: repo_a.to_string(),
                        source_file: sym_a.file_path.clone(),
                        source_symbol: sym_a.qualified_name.clone(),
                        target_repo: repo_b.to_string(),
                        target_file: sym_b.file_path.clone(),
                        target_symbol: sym_b.qualified_name.clone(),
                        kind: kind.to_string(),
                        detail: format!("Shared {kind} '{contract_name}'"),
                        confidence: 0.78,
                    });
                }
            }
        }

        links.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.source_repo.cmp(&b.source_repo))
                .then_with(|| a.source_file.cmp(&b.source_file))
        });
        links.dedup_by(|a, b| {
            a.source_repo == b.source_repo
                && a.source_file == b.source_file
                && a.target_repo == b.target_repo
                && a.target_file == b.target_file
                && a.detail == b.detail
        });
        Ok(links)
    }
}

fn route_paths_match(exposed: &str, consumed: &str) -> bool {
    let clean_exp = exposed.split('?').next().unwrap_or(exposed).trim_matches('/');
    let clean_con = consumed
        .split('?')
        .next()
        .unwrap_or(consumed)
        .trim_matches('/');
    if clean_exp == clean_con {
        return true;
    }
    let exp_segs: Vec<&str> = clean_exp.split('/').filter(|s| !s.is_empty()).collect();
    let con_segs: Vec<&str> = clean_con.split('/').filter(|s| !s.is_empty()).collect();
    if exp_segs.len() != con_segs.len() {
        return false;
    }
    exp_segs.iter().zip(con_segs.iter()).all(|(&e, &c)| {
        e == c
            || e.starts_with(':')
            || (e.starts_with('{') && e.ends_with('}'))
            || (c.starts_with("${") && c.ends_with('}'))
            || e == "*"
    })
}
