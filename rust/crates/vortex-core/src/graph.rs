//! Compressed Sparse Row (`CsrGraph`) dependency engine, Personalized PageRank (`ppr`),
//! Tarjan Strongly Connected Components (`tarjan_scc`), Architectural Layer Firewall,
//! Git co-change miner, `blast_radius`, `affected_tests`, `diff_impact`, and `repo_map`.
//!
//! Traceability: `@REQ-VORTEX-002`.

use crate::parser::AstParser;
use crate::storage::{is_test_path, VortexShard};
use crate::types::{
    ArchBoundaryRule, ArchViolation, BlastRadiusReport, CallGraphEndpoint, ContractDrift,
    CycleFinding, DiffImpactReport, RepoMapFileEntry, RepoMapResponse, SymbolRecord, TarjanReport,
    VortexResult,
};
use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::process::Command;

/// Default damping factor for Personalized PageRank.
pub const DEFAULT_PPR_DAMPING: f64 = 0.85;

/// Default power-iteration limit for Personalized PageRank.
pub const DEFAULT_PPR_ITERATIONS: usize = 45;

/// Contiguous Compressed Sparse Row directed graph over repository files/modules.
#[derive(Debug, Clone)]
pub struct CsrGraph {
    pub nodes: Vec<String>,
    node_to_idx: HashMap<String, usize>,
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
    pub weights: Vec<f32>,
    pub rev_offsets: Vec<u32>,
    pub rev_targets: Vec<u32>,
    pub rev_weights: Vec<f32>,
    pub in_degree: Vec<u32>,
    pub out_degree: Vec<u32>,
    pub is_hub: Vec<bool>,
}

impl CsrGraph {
    /// Builds a `CsrGraph` from an ordered node list and directed weighted edges `(from, to, weight)`.
    pub fn from_parts(nodes: Vec<String>, edges: &[(usize, usize, f32)]) -> Self {
        let n = nodes.len();
        let mut node_to_idx = HashMap::with_capacity(n);
        for (i, label) in nodes.iter().enumerate() {
            node_to_idx.insert(label.clone(), i);
        }

        let mut adj: Vec<BTreeMap<usize, f32>> = vec![BTreeMap::new(); n];
        let mut rev: Vec<BTreeMap<usize, f32>> = vec![BTreeMap::new(); n];

        for &(u, v, w) in edges {
            if u < n && v < n && u != v && w > 0.0 && w.is_finite() {
                let entry = adj[u].entry(v).or_insert(0.0);
                if w > *entry {
                    *entry = w;
                }
                let rentry = rev[v].entry(u).or_insert(0.0);
                if w > *rentry {
                    *rentry = w;
                }
            }
        }

        let mut offsets = Vec::with_capacity(n + 1);
        let mut targets = Vec::new();
        let mut weights = Vec::new();
        let mut out_degree = vec![0u32; n];
        offsets.push(0);
        for (u, map) in adj.iter().enumerate() {
            out_degree[u] = map.len() as u32;
            for (&v, &w) in map {
                targets.push(v as u32);
                weights.push(w);
            }
            offsets.push(targets.len() as u32);
        }

        let mut rev_offsets = Vec::with_capacity(n + 1);
        let mut rev_targets = Vec::new();
        let mut rev_weights = Vec::new();
        let mut in_degree = vec![0u32; n];
        rev_offsets.push(0);
        for (v, map) in rev.iter().enumerate() {
            in_degree[v] = map.len() as u32;
            for (&u, &w) in map {
                rev_targets.push(u as u32);
                rev_weights.push(w);
            }
            rev_offsets.push(rev_targets.len() as u32);
        }

        let hub_threshold = ((n as f64 * 0.25).ceil() as u32).max(12);
        let is_hub = in_degree
            .iter()
            .zip(out_degree.iter())
            .map(|(&ind, &outd)| ind >= hub_threshold || outd >= hub_threshold * 2)
            .collect();

        Self {
            nodes,
            node_to_idx,
            offsets,
            targets,
            weights,
            rev_offsets,
            rev_targets,
            rev_weights,
            in_degree,
            out_degree,
            is_hub,
        }
    }

    /// Materializes a `CsrGraph` from all indexed files and resolved edges in a `VortexShard`.
    pub fn from_shard(shard: &VortexShard) -> VortexResult<Self> {
        let files = shard.all_files()?;
        let nodes: Vec<String> = files.into_iter().map(|(p, _)| p).collect();
        let mut idx_map = HashMap::with_capacity(nodes.len());
        for (i, p) in nodes.iter().enumerate() {
            idx_map.insert(p.clone(), i);
        }

        let raw_edges = shard.all_edges()?;
        let mut triples = Vec::with_capacity(raw_edges.len());
        for e in raw_edges {
            if let Some(ref target_path) = e.resolved_path {
                if let (Some(&u), Some(&v)) = (idx_map.get(&e.from_path), idx_map.get(target_path))
                {
                    triples.push((u, v, e.weight.max(0.1)));
                }
            }
        }
        Ok(Self::from_parts(nodes, &triples))
    }

    /// Number of vertices in the graph.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Number of deduplicated directed edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.targets.len()
    }

    /// Looks up the dense CSR vertex index for a file path.
    pub fn index_of(&self, node_name: &str) -> Option<usize> {
        self.node_to_idx.get(node_name).copied()
    }

    /// Returns outgoing neighbor indices for vertex `u`.
    pub fn neighbors(&self, u: usize) -> &[u32] {
        if u >= self.nodes.len() {
            return &[];
        }
        let start = self.offsets[u] as usize;
        let end = self.offsets[u + 1] as usize;
        &self.targets[start..end]
    }

    /// Returns incoming (reverse) neighbor indices for vertex `v`.
    pub fn reverse_neighbors(&self, v: usize) -> &[u32] {
        if v >= self.nodes.len() {
            return &[];
        }
        let start = self.rev_offsets[v] as usize;
        let end = self.rev_offsets[v + 1] as usize;
        &self.rev_targets[start..end]
    }

    /// Runs Personalized PageRank (`damping = 0.85` typically) normalized so `sum(scores) ~= 1.0`.
    pub fn ppr(&self, seeds: &[(usize, f64)], damping: f64, iterations: usize) -> Vec<f64> {
        let n = self.nodes.len();
        if n == 0 {
            return Vec::new();
        }
        let d = if damping.is_finite() {
            damping.clamp(0.0, 0.999)
        } else {
            DEFAULT_PPR_DAMPING
        };
        let iters = iterations.clamp(1, 200);

        let mut teleport = vec![0.0f64; n];
        let mut seed_sum = 0.0f64;
        for &(idx, w) in seeds {
            if idx < n && w.is_finite() && w > 0.0 {
                teleport[idx] += w;
                seed_sum += w;
            }
        }
        if seed_sum > 0.0 {
            for val in &mut teleport {
                *val /= seed_sum;
            }
        } else {
            let uniform = 1.0 / (n as f64);
            teleport.fill(uniform);
        }

        let mut out_weight_sum = vec![0.0f64; n];
        for (u, sum_slot) in out_weight_sum.iter_mut().enumerate() {
            let start = self.offsets[u] as usize;
            let end = self.offsets[u + 1] as usize;
            let mut s = 0.0f64;
            for &w in &self.weights[start..end] {
                let wf = f64::from(w);
                if wf > 0.0 && wf.is_finite() {
                    s += wf;
                }
            }
            *sum_slot = s;
        }

        let mut rank = teleport.clone();
        let mut next = vec![0.0f64; n];

        for _ in 0..iters {
            let mut dangling_mass = 0.0f64;
            for u in 0..n {
                if out_weight_sum[u] <= 0.0 {
                    dangling_mass += rank[u];
                }
            }

            let base_factor = (1.0 - d) + d * dangling_mass;
            for i in 0..n {
                next[i] = base_factor * teleport[i];
            }

            for u in 0..n {
                let ow = out_weight_sum[u];
                if ow <= 0.0 {
                    continue;
                }
                let share_base = d * rank[u] / ow;
                let start = self.offsets[u] as usize;
                let end = self.offsets[u + 1] as usize;
                for idx in start..end {
                    let v = self.targets[idx] as usize;
                    let w = f64::from(self.weights[idx]).max(0.0);
                    next[v] += share_base * w;
                }
            }

            let mut l1_diff = 0.0f64;
            for i in 0..n {
                l1_diff += (next[i] - rank[i]).abs();
            }
            std::mem::swap(&mut rank, &mut next);
            if l1_diff < 1e-11 {
                break;
            }
        }

        let total: f64 = rank.iter().sum();
        if total > 0.0 && total.is_finite() {
            for val in &mut rank {
                *val /= total;
            }
        } else {
            let uniform = 1.0 / (n as f64);
            rank.fill(uniform);
        }
        rank
    }

    /// Convenience Personalized PageRank with `DEFAULT_PPR_DAMPING` (`0.85`).
    pub fn ppr_default(&self, seeds: &[(usize, f64)]) -> Vec<f64> {
        self.ppr(seeds, DEFAULT_PPR_DAMPING, DEFAULT_PPR_ITERATIONS)
    }

    /// Iterative Tarjan Strongly Connected Components algorithm finding all non-trivial cycles (`size > 1`).
    pub fn tarjan_scc(&self) -> TarjanReport {
        let n = self.nodes.len();
        let mut index_counter = 0u32;
        let mut indices: Vec<Option<u32>> = vec![None; n];
        let mut lowlink: Vec<u32> = vec![0; n];
        let mut on_stack: Vec<bool> = vec![false; n];
        let mut stack: Vec<usize> = Vec::new();
        let mut scc_count = 0usize;
        let mut raw_cycles: Vec<Vec<usize>> = Vec::new();

        for start_node in 0..n {
            if indices[start_node].is_some() {
                continue;
            }
            let mut call_stack: Vec<(usize, usize)> = Vec::new();
            indices[start_node] = Some(index_counter);
            lowlink[start_node] = index_counter;
            index_counter += 1;
            stack.push(start_node);
            on_stack[start_node] = true;
            call_stack.push((start_node, self.offsets[start_node] as usize));

            while let Some((u, edge_pos)) = call_stack.last_mut() {
                let u_val = *u;
                let end_edge = self.offsets[u_val + 1] as usize;
                if *edge_pos < end_edge {
                    let v = self.targets[*edge_pos] as usize;
                    *edge_pos += 1;
                    if indices[v].is_none() {
                        indices[v] = Some(index_counter);
                        lowlink[v] = index_counter;
                        index_counter += 1;
                        stack.push(v);
                        on_stack[v] = true;
                        call_stack.push((v, self.offsets[v] as usize));
                    } else if on_stack[v] {
                        if let Some(v_idx) = indices[v] {
                            lowlink[u_val] = lowlink[u_val].min(v_idx);
                        }
                    }
                } else {
                    call_stack.pop();
                    if let Some(&(parent, _)) = call_stack.last() {
                        lowlink[parent] = lowlink[parent].min(lowlink[u_val]);
                    }
                    if Some(lowlink[u_val]) == indices[u_val] {
                        scc_count += 1;
                        let mut comp = Vec::new();
                        while let Some(w) = stack.pop() {
                            on_stack[w] = false;
                            comp.push(w);
                            if w == u_val {
                                break;
                            }
                        }
                        if comp.len() > 1 {
                            raw_cycles.push(comp);
                        }
                    }
                }
            }
        }

        let mut cycles: Vec<CycleFinding> = raw_cycles
            .into_iter()
            .map(|comp| {
                let comp_set: HashSet<usize> = comp.iter().copied().collect();
                let mut members: Vec<String> =
                    comp.iter().map(|&idx| self.nodes[idx].clone()).collect();
                members.sort();

                let mut sample_edges = Vec::new();
                for &u in &comp {
                    for &v_u32 in self.neighbors(u) {
                        let v = v_u32 as usize;
                        if comp_set.contains(&v) && sample_edges.len() < 12 {
                            sample_edges.push((self.nodes[u].clone(), self.nodes[v].clone()));
                        }
                    }
                }
                sample_edges.sort();

                CycleFinding {
                    cycle_id: 0,
                    size: members.len(),
                    members,
                    sample_edges,
                }
            })
            .collect();

        cycles.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.members.cmp(&b.members)));
        for (idx, c) in cycles.iter_mut().enumerate() {
            c.cycle_id = idx + 1;
        }

        TarjanReport {
            node_count: n,
            edge_count: self.targets.len(),
            scc_count,
            cycles,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum StringOrVec {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Deserialize)]
struct FlexibleLayerRule {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    layer: Option<String>,
    #[serde(alias = "from", alias = "glob", alias = "fromGlob")]
    from_glob: String,
    #[serde(
        alias = "forbid",
        alias = "forbid_to",
        alias = "forbidTo",
        alias = "forbidToGlob"
    )]
    forbid_to_glob: StringOrVec,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AdrFrontmatter {
    #[serde(alias = "id", default)]
    adr_id: Option<String>,
    #[serde(alias = "layerRules", default)]
    layer_rules: Vec<FlexibleLayerRule>,
}

struct CompiledBoundaryMatcher {
    primary: GlobMatcher,
    subtree: Option<GlobMatcher>,
}

impl CompiledBoundaryMatcher {
    fn compile(pattern: &str) -> VortexResult<Self> {
        let primary = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()?
            .compile_matcher();
        let trimmed = pattern.trim_end_matches('/');
        let subtree = if !trimmed.is_empty()
            && !trimmed.ends_with("/**")
            && !trimmed.starts_with('{')
        {
            GlobBuilder::new(&format!("{trimmed}/**"))
                .literal_separator(true)
                .build()
                .ok()
                .map(|g| g.compile_matcher())
        } else {
            None
        };
        Ok(Self { primary, subtree })
    }

    fn is_match(&self, candidate: &str) -> bool {
        self.primary.is_match(candidate)
            || self
                .subtree
                .as_ref()
                .map(|m| m.is_match(candidate))
                .unwrap_or(false)
    }
}

/// Built-in architectural boundary rules (`ui -> db/infra` firewall).
pub fn default_architecture_rules() -> Vec<ArchBoundaryRule> {
    vec![
        ArchBoundaryRule {
            id: "builtin-ui-no-db".to_string(),
            from_glob: "{ui/**,**/ui/**,components/**,**/components/**,pages/**,**/pages/**,views/**,**/views/**}".to_string(),
            forbid_to_glob: "{db/**,**/db/**,database/**,**/database/**,infra/**,**/infra/**,migrations/**,**/migrations/**,prisma/**,**/prisma/**}".to_string(),
            reason: "UI presentation layer must not directly import database or infrastructure modules".to_string(),
        },
        ArchBoundaryRule {
            id: "builtin-ui-no-raw-sql-driver".to_string(),
            from_glob: "{ui/**,**/ui/**,components/**,**/components/**,pages/**,**/pages/**}".to_string(),
            forbid_to_glob: "{rusqlite,rusqlite::**,sqlx,sqlx::**,postgres,mysql,better-sqlite3,@prisma/client}".to_string(),
            reason: "UI presentation layer must not directly import database drivers".to_string(),
        },
    ]
}

fn derive_layer_label(explicit_layer: Option<&str>, from_glob: &str) -> String {
    if let Some(l) = explicit_layer.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return l.to_string();
    }
    let cleaned = from_glob
        .trim()
        .trim_end_matches("/**")
        .trim_end_matches("/*")
        .trim_end_matches('/');
    cleaned
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("layer")
        .to_string()
}

fn derive_adr_id_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("ADR");
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 2
        && parts[0].eq_ignore_ascii_case("adr")
        && parts[1].chars().all(|c| c.is_ascii_digit())
    {
        return format!("ADR-{}", parts[1]);
    }
    stem.to_string()
}

/// Loads and validates `layer_rules` declared inside YAML frontmatter of `docs/cmmi/adr/*.md`,
/// returning a typed `VortexError` if any ADR frontmatter contains malformed YAML.
pub fn try_load_adr_layer_rules(repo_root: &Path) -> VortexResult<Vec<ArchBoundaryRule>> {
    let adr_dir = repo_root.join("docs/cmmi/adr");
    if !adr_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut md_paths = Vec::new();
    for entry_res in fs::read_dir(&adr_dir)? {
        let entry = entry_res?;
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("md") {
            md_paths.push(p);
        }
    }
    md_paths.sort();

    let mut rules = Vec::new();
    for p in md_paths {
        let content = fs::read_to_string(&p)?;
        let Some(rest) = content
            .strip_prefix("---\n")
            .or_else(|| content.strip_prefix("---\r\n"))
        else {
            continue;
        };
        let end_opt = if rest.starts_with("---") {
            Some(0)
        } else {
            rest.find("\n---")
        };
        let Some(end_idx) = end_opt else {
            continue;
        };
        let yaml_block = rest[..end_idx].trim_end_matches('\r');
        let parsed: AdrFrontmatter = serde_yaml::from_str(yaml_block)?;
        let adr_id = parsed
            .adr_id
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| derive_adr_id_from_path(&p));

        for flex in parsed.layer_rules {
            let layer_label = derive_layer_label(flex.layer.as_deref(), &flex.from_glob);
            let targets = match flex.forbid_to_glob {
                StringOrVec::One(single) => vec![single],
                StringOrVec::Many(many) => many,
            };
            let multi = targets.len() > 1;
            for (idx, forbid_pat) in targets.into_iter().enumerate() {
                let rule_id = match flex
                    .id
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    Some(explicit) if multi => format!("{explicit}->{idx}"),
                    Some(explicit) => explicit.to_string(),
                    None => format!("{adr_id}:{layer_label}->{idx}"),
                };
                let reason = flex
                    .reason
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| {
                        format!(
                            "Layer '{layer_label}' ({}) must not depend on '{forbid_pat}' ({adr_id})",
                            flex.from_glob
                        )
                    });
                rules.push(ArchBoundaryRule {
                    id: rule_id,
                    from_glob: flex.from_glob.clone(),
                    forbid_to_glob: forbid_pat,
                    reason,
                });
            }
        }
    }
    Ok(rules)
}

/// Loads `layer_rules` declared inside YAML frontmatter of `docs/cmmi/adr/*.md` if present.
pub fn load_adr_layer_rules(repo_root: &Path) -> Vec<ArchBoundaryRule> {
    match try_load_adr_layer_rules(repo_root) {
        Ok(rules) => rules,
        Err(err) => {
            tracing::warn!(
                repo_root = %repo_root.display(),
                error = %err,
                "Failed to load ADR YAML frontmatter layer_rules"
            );
            Vec::new()
        }
    }
}

/// Evaluates built-in `ui -> db/infra` rules plus `.kvx.yaml`, ADR frontmatter, and `custom_rules`.
pub fn check_architecture(
    shard: &VortexShard,
    custom_rules: &[ArchBoundaryRule],
) -> VortexResult<Vec<ArchViolation>> {
    let mut all_rules = default_architecture_rules();
    let ignore = shard.load_ignore()?;
    all_rules.extend(ignore.config().layer_rules.iter().cloned());
    all_rules.extend(try_load_adr_layer_rules(shard.repo_root())?);
    all_rules.extend(custom_rules.iter().cloned());

    let mut compiled: Vec<(
        ArchBoundaryRule,
        CompiledBoundaryMatcher,
        CompiledBoundaryMatcher,
    )> = Vec::new();
    for rule in all_rules {
        let from_m = CompiledBoundaryMatcher::compile(&rule.from_glob)?;
        let to_m = CompiledBoundaryMatcher::compile(&rule.forbid_to_glob)?;
        compiled.push((rule, from_m, to_m));
    }

    let edges = shard.all_edges()?;
    let mut violations = Vec::new();
    let mut seen: HashSet<(String, String, String, usize)> = HashSet::new();

    for edge in edges {
        let candidate_target = edge
            .resolved_path
            .as_deref()
            .unwrap_or(edge.raw_target.as_str());
        for (rule, from_m, to_m) in &compiled {
            if !from_m.is_match(&edge.from_path) {
                continue;
            }
            let hits_resolved = edge
                .resolved_path
                .as_deref()
                .map(|rp| to_m.is_match(rp))
                .unwrap_or(false);
            let hits_raw = to_m.is_match(&edge.raw_target);
            if hits_resolved || hits_raw {
                let key = (
                    rule.id.clone(),
                    edge.from_path.clone(),
                    candidate_target.to_string(),
                    edge.line,
                );
                if seen.insert(key) {
                    violations.push(ArchViolation {
                        rule_id: rule.id.clone(),
                        from_file: edge.from_path.clone(),
                        to_file: candidate_target.to_string(),
                        raw_import: edge.raw_target.clone(),
                        line: edge.line,
                        reason: rule.reason.clone(),
                    });
                }
            }
        }
    }

    violations.sort_by(|a, b| {
        (&a.from_file, a.line, &a.rule_id).cmp(&(&b.from_file, b.line, &b.rule_id))
    });
    Ok(violations)
}

/// Mines recent Git commit history (`git log --name-only`) to populate `cochange_pairs` in `shard`.
pub fn mine_git_cochange(shard: &VortexShard, max_commits: usize) -> VortexResult<usize> {
    let git_dir = shard.repo_root().join(".git");
    if !git_dir.exists() {
        return Ok(0);
    }
    let limit = max_commits.clamp(10, 1000).to_string();
    let output = Command::new("git")
        .arg("-C")
        .arg(shard.repo_root())
        .args([
            "log",
            "--no-merges",
            "--name-only",
            "--relative",
            "--format=%x1e",
            "-n",
            &limit,
        ])
        .output();

    let Ok(out) = output else {
        return Ok(0);
    };
    if !out.status.success() {
        return Ok(0);
    }

    let indexed_set: HashSet<String> = shard.all_files()?.into_iter().map(|(p, _)| p).collect();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut file_commits: HashMap<String, usize> = HashMap::new();
    let mut pair_commits: HashMap<(String, String), usize> = HashMap::new();

    for commit_block in stdout.split('\x1e') {
        let mut touched: Vec<String> = commit_block
            .lines()
            .map(|l| l.trim().replace('\\', "/"))
            .filter(|l| !l.is_empty() && indexed_set.contains(l))
            .collect();
        touched.sort();
        touched.dedup();
        if touched.len() < 2 || touched.len() > 40 {
            continue;
        }
        for f in &touched {
            *file_commits.entry(f.clone()).or_insert(0) += 1;
        }
        for i in 0..touched.len() {
            for j in (i + 1)..touched.len() {
                let key = (touched[i].clone(), touched[j].clone());
                *pair_commits.entry(key).or_insert(0) += 1;
            }
        }
    }

    let mut pairs_to_store = Vec::new();
    for ((a, b), co) in pair_commits {
        let fa = file_commits.get(&a).copied().unwrap_or(1).max(1);
        let fb = file_commits.get(&b).copied().unwrap_or(1).max(1);
        let denom = fa.min(fb) as f64;
        let confidence = ((co as f64) / denom).clamp(0.0, 1.0);
        if co >= 1 && confidence >= 0.25 {
            pairs_to_store.push((a, b, co, confidence));
        }
    }

    shard.replace_cochange_pairs(&pairs_to_store)?;
    Ok(pairs_to_store.len())
}

/// Computes AST + call-site + test + Git co-change blast radius for a file or symbol target.
pub fn blast_radius(
    shard: &VortexShard,
    target: &str,
    max_depth: usize,
) -> VortexResult<BlastRadiusReport> {
    let graph = CsrGraph::from_shard(shard)?;
    let depth_cap = max_depth.clamp(1, 16);

    let mut resolved_files: Vec<String> = Vec::new();
    let mut callers: Vec<CallGraphEndpoint> = Vec::new();

    if let Ok(ignore) = shard.load_ignore() {
        if let Ok(fp) = shard.resolve_indexed_file_path(target, &ignore) {
            resolved_files.push(fp);
        }
    }

    if resolved_files.is_empty() {
        let cg = shard.call_graph(target)?;
        for def in &cg.definitions {
            if !resolved_files.contains(&def.file_path) {
                resolved_files.push(def.file_path.clone());
            }
        }
        callers = cg.callers;
    } else {
        let outline = shard.file_outline(
            &resolved_files[0],
            crate::types::OutlineScope::Exportado,
        )?;
        for sym in outline.symbols.iter().take(12) {
            let cg = shard.call_graph(&sym.qualified_name)?;
            for c in cg.callers {
                if c.file_path != resolved_files[0] {
                    callers.push(c);
                }
            }
        }
        callers.dedup_by(|a, b| a.file_path == b.file_path && a.line == b.line);
    }

    let mut direct_set = BTreeSet::new();
    let mut transitive_set = BTreeSet::new();
    let seed_set: HashSet<String> = resolved_files.iter().cloned().collect();

    let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
    let mut visited: HashSet<usize> = HashSet::new();
    for rf in &resolved_files {
        if let Some(idx) = graph.index_of(rf) {
            visited.insert(idx);
            queue.push_back((idx, 0));
        }
    }

    while let Some((curr, dist)) = queue.pop_front() {
        if dist >= depth_cap {
            continue;
        }
        for &rev_nb in graph.reverse_neighbors(curr) {
            let nb = rev_nb as usize;
            let nb_path = &graph.nodes[nb];
            if !seed_set.contains(nb_path) {
                if dist == 0 {
                    direct_set.insert(nb_path.clone());
                }
                transitive_set.insert(nb_path.clone());
            }
            if visited.insert(nb) {
                queue.push_back((nb, dist + 1));
            }
        }
    }

    for c in &callers {
        if !seed_set.contains(&c.file_path) {
            direct_set.insert(c.file_path.clone());
            transitive_set.insert(c.file_path.clone());
        }
    }

    let mut affected_tests: Vec<String> = transitive_set
        .iter()
        .filter(|p| is_test_path(p))
        .cloned()
        .collect();

    if affected_tests.is_empty() && !resolved_files.is_empty() {
        let stems: Vec<String> = resolved_files
            .iter()
            .filter_map(|p| {
                Path::new(p)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
            })
            .filter(|s| s != "mod" && s != "lib" && s != "index")
            .collect();
        for node in &graph.nodes {
            if is_test_path(node) {
                let lower = node.to_ascii_lowercase();
                if stems.iter().any(|st| lower.contains(st)) {
                    affected_tests.push(node.clone());
                }
            }
        }
    }
    affected_tests.sort();
    affected_tests.dedup();

    if shard.health()?.cochange_pairs == 0 {
        let _ = mine_git_cochange(shard, 200);
    }
    let co_changed = shard.cochange_for_files(&resolved_files)?;

    let direct_dependents: Vec<String> = direct_set.into_iter().collect();
    let transitive_dependents: Vec<String> = transitive_set.into_iter().collect();
    let impact_n = transitive_dependents.len();
    let risk_level = if impact_n >= 20 {
        "critical"
    } else if impact_n >= 8 {
        "high"
    } else if impact_n >= 2 {
        "medium"
    } else {
        "low"
    }
    .to_string();

    Ok(BlastRadiusReport {
        target: target.to_string(),
        resolved_files,
        direct_dependents,
        transitive_dependents,
        affected_tests,
        callers,
        co_changed,
        risk_level,
    })
}

/// Returns deduplicated test files impacted by `changed_targets`.
pub fn affected_tests(
    shard: &VortexShard,
    changed_targets: &[String],
) -> VortexResult<Vec<String>> {
    let mut tests = BTreeSet::new();
    for target in changed_targets {
        if is_test_path(target) {
            tests.insert(target.clone());
        }
        let report = blast_radius(shard, target, 6)?;
        for t in report.affected_tests {
            tests.insert(t);
        }
    }
    Ok(tests.into_iter().collect())
}

/// Analyzes exported contract drift and transitive impact across changed working-tree or synced files.
pub fn diff_impact(
    shard: &VortexShard,
    explicit_files: Option<&[String]>,
) -> VortexResult<DiffImpactReport> {
    let kvxignore = shard.load_ignore()?;
    let indexed_files: HashSet<String> = shard.all_files()?.into_iter().map(|(p, _)| p).collect();

    let mut changed_files: Vec<String> = match explicit_files {
        Some(list) if !list.is_empty() => list
            .iter()
            .map(|p| kvxignore.normalize_rel_path(Path::new(p)))
            .filter(|p| !p.is_empty())
            .collect(),
        _ => git_modified_files(shard.repo_root(), &kvxignore),
    };
    changed_files.sort();
    changed_files.dedup();

    let all_indexed_syms = shard.all_symbols()?;
    let mut syms_by_file: HashMap<String, Vec<SymbolRecord>> = HashMap::new();
    for s in all_indexed_syms {
        syms_by_file.entry(s.file_path.clone()).or_default().push(s);
    }

    let mut contract_drifts = Vec::new();
    let mut impacted_set = BTreeSet::new();
    let mut tests_set = BTreeSet::new();
    let mut unindexed_files = Vec::new();

    for rel in &changed_files {
        if !indexed_files.contains(rel) {
            unindexed_files.push(rel.clone());
        }

        let indexed_exported: BTreeMap<String, (String, String)> = syms_by_file
            .get(rel)
            .into_iter()
            .flatten()
            .filter(|s| s.exported)
            .map(|s| {
                (
                    s.qualified_name.clone(),
                    (s.signature.clone(), s.sig_hash.clone()),
                )
            })
            .collect();

        let abs = shard.repo_root().join(rel);
        let live_exported: Option<BTreeMap<String, (String, String)>> = if abs.is_file() {
            fs::read_to_string(&abs).ok().map(|src| {
                let ext = abs
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                AstParser::new()
                    .parse_file(rel, &ext, &src)
                    .symbols
                    .into_iter()
                    .filter(|s| s.exported)
                    .map(|s| (s.qualified_name, (s.signature, s.sig_hash)))
                    .collect()
            })
        } else {
            None
        };

        let mut file_drifts = Vec::new();
        if let Some(ref live_map) = live_exported {
            if *live_map != indexed_exported && !indexed_exported.is_empty() {
                diff_symbol_maps(rel, &indexed_exported, live_map, &mut file_drifts);
            }
        }

        if file_drifts.is_empty() {
            let hist = shard.symbol_history_for_file(rel)?;
            if !hist.is_empty() {
                let hist_map: BTreeMap<String, (String, String)> = hist
                    .into_iter()
                    .filter(|h| h.exported)
                    .map(|h| (h.qualified_name, (h.signature, h.sig_hash)))
                    .collect();
                let current_ref = live_exported.as_ref().unwrap_or(&indexed_exported);
                diff_symbol_maps(rel, &hist_map, current_ref, &mut file_drifts);
            }
        }

        contract_drifts.extend(file_drifts);

        if indexed_files.contains(rel) {
            let br = blast_radius(shard, rel, 5)?;
            for dep in br.transitive_dependents {
                impacted_set.insert(dep);
            }
            for t in br.affected_tests {
                tests_set.insert(t);
            }
        }
    }

    let impacted_files: Vec<String> = impacted_set.into_iter().collect();
    let affected_tests_list: Vec<String> = tests_set.into_iter().collect();
    let summary = format!(
        "{} changed file(s), {} contract drift(s), {} impacted dependent(s), {} affected test(s).",
        changed_files.len(),
        contract_drifts.len(),
        impacted_files.len(),
        affected_tests_list.len()
    );

    Ok(DiffImpactReport {
        changed_files,
        contract_drifts,
        impacted_files,
        affected_tests: affected_tests_list,
        unindexed_files,
        summary,
    })
}

fn diff_symbol_maps(
    file_path: &str,
    old_map: &BTreeMap<String, (String, String)>,
    new_map: &BTreeMap<String, (String, String)>,
    out: &mut Vec<ContractDrift>,
) {
    for (qname, (old_sig, old_hash)) in old_map {
        match new_map.get(qname) {
            None => out.push(ContractDrift {
                file_path: file_path.to_string(),
                qualified_name: qname.clone(),
                change_kind: "symbol_removed".to_string(),
                old_signature: Some(old_sig.clone()),
                new_signature: None,
            }),
            Some((new_sig, new_hash)) if new_hash != old_hash => out.push(ContractDrift {
                file_path: file_path.to_string(),
                qualified_name: qname.clone(),
                change_kind: "signature_changed".to_string(),
                old_signature: Some(old_sig.clone()),
                new_signature: Some(new_sig.clone()),
            }),
            _ => {}
        }
    }
    for (qname, (new_sig, _)) in new_map {
        if !old_map.contains_key(qname) {
            out.push(ContractDrift {
                file_path: file_path.to_string(),
                qualified_name: qname.clone(),
                change_kind: "symbol_added".to_string(),
                old_signature: None,
                new_signature: Some(new_sig.clone()),
            });
        }
    }
}

fn git_modified_files(repo_root: &Path, kvxignore: &crate::kvxignore::KvxIgnore) -> Vec<String> {
    if !repo_root.join(".git").exists() {
        return Vec::new();
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["status", "--porcelain"])
        .output();
    let Ok(output) = out else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let path_part = line[3..].split(" -> ").last()?.trim();
            let norm = kvxignore.normalize_rel_path(Path::new(path_part));
            if norm.is_empty() || kvxignore.match_ignored(Path::new(&norm), false).is_some() {
                None
            } else {
                Some(norm)
            }
        })
        .collect()
}

/// Builds a PageRank-ordered repository map of exported contracts strictly within `budget_tokens`.
pub fn repo_map(shard: &VortexShard, budget_tokens: usize) -> VortexResult<RepoMapResponse> {
    let cap = if budget_tokens == 0 {
        1500
    } else {
        budget_tokens.min(32_000)
    };
    let graph = CsrGraph::from_shard(shard)?;
    let n = graph.node_count();

    let seeds: Vec<(usize, f64)> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, p)| (i, if is_test_path(p) { 0.2 } else { 1.0 }))
        .collect();
    let ranks = graph.ppr_default(&seeds);

    let all_syms = shard.all_symbols()?;
    let mut exported_by_file: HashMap<String, Vec<String>> = HashMap::new();
    for sym in all_syms {
        if sym.exported {
            exported_by_file
                .entry(sym.file_path)
                .or_default()
                .push(sym.signature);
        }
    }

    let mut order: Vec<(usize, f64)> = ranks.into_iter().enumerate().collect();
    order.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| graph.nodes[a.0].cmp(&graph.nodes[b.0]))
    });

    let mut entries = Vec::new();
    let mut md = String::new();
    let mut used_tokens = 0usize;

    for (idx, rank) in order {
        let path = &graph.nodes[idx];
        let sigs = exported_by_file.remove(path).unwrap_or_default();
        let mut block = format!("## {path} (rank {:.4})\n", rank);
        let mut included_sigs = Vec::new();
        for sig in sigs.into_iter().take(12) {
            block.push_str("  - ");
            block.push_str(&sig);
            block.push('\n');
            included_sigs.push(sig);
        }
        let block_tokens = block.len().div_ceil(4);
        if used_tokens + block_tokens > cap {
            if entries.is_empty() {
                let truncated = truncate_utf8_bytes(&block, cap.saturating_mul(4));
                md.push_str(truncated);
                entries.push(RepoMapFileEntry {
                    file_path: path.clone(),
                    rank,
                    signatures: Vec::new(),
                });
            }
            break;
        }
        used_tokens += block_tokens;
        md.push_str(&block);
        entries.push(RepoMapFileEntry {
            file_path: path.clone(),
            rank,
            signatures: included_sigs,
        });
    }

    let token_count = estimate_markdown_tokens(&md);

    Ok(RepoMapResponse {
        repo_id: shard.repo_id().to_string(),
        budget_tokens: cap,
        token_count,
        files_included: entries.len(),
        total_files: n,
        entries,
        markdown: md,
    })
}

fn estimate_markdown_tokens(text: &str) -> usize {
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
