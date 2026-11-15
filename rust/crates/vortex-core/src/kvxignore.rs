//! `.kvxignore` and `.kvx.yaml` policy loader and admission refusal firewall.
//!
//! Traceability: `@REQ-VORTEX-001`, `@REQ-VORTEX-004`.

use crate::types::{ArchBoundaryRule, VortexError, VortexResult};
use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

/// Default maximum source file size admitted into the AST index (512 KiB).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 512 * 1024;

/// Default directory and artifact segments excluded from indexing and editing.
pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &[
    ".git",
    ".git/**",
    "node_modules",
    "node_modules/**",
    "target",
    "target/**",
    "dist",
    "dist/**",
    ".fabrica/worktrees",
    ".fabrica/worktrees/**",
    ".claude/worktrees",
    ".claude/worktrees/**",
    ".next",
    ".next/**",
    "__pycache__",
    "__pycache__/**",
    ".venv",
    ".venv/**",
    "*.sqlite",
    "*.sqlite-wal",
    "*.sqlite-shm",
    "*.min.js",
    "*.min.css",
];

/// Refusal error emitted when a read/edit targets a path blocked by `.kvxignore` or `.kvx.yaml`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Path '{path}' refused by .kvxignore rule '{rule}' ({source_file})")]
pub struct KvxIgnoreError {
    pub path: String,
    pub rule: String,
    pub source_file: String,
}

impl From<KvxIgnoreError> for VortexError {
    fn from(err: KvxIgnoreError) -> Self {
        VortexError::KvxIgnored {
            path: err.path,
            reason: format!("matched '{}' in {}", err.rule, err.source_file),
        }
    }
}

/// Optional `.kvx.yaml` repository configuration file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvxYamlConfig {
    #[serde(alias = "repo_id", default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub ignore: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(alias = "max_file_bytes", default)]
    pub max_file_bytes: Option<u64>,
    #[serde(alias = "layer_rules", default)]
    pub layer_rules: Vec<ArchBoundaryRule>,
}

#[derive(Debug, Clone)]
struct CompiledIgnoreRule {
    raw: String,
    negated: bool,
    dir_only: bool,
    source_file: String,
    matcher: GlobMatcher,
    sub_matcher: Option<GlobMatcher>,
}

/// Evaluates `.kvxignore`, `.kvx.yaml`, and built-in exclude globs against repo-relative paths.
#[derive(Debug, Clone)]
pub struct KvxIgnore {
    repo_root: PathBuf,
    rules: Vec<CompiledIgnoreRule>,
    config: KvxYamlConfig,
    max_file_bytes: u64,
}

impl KvxIgnore {
    /// Loads default excludes, optional global ignore files, `.kvx.yaml`, and `.kvxignore` from `repo_root`.
    pub fn load(repo_root: &Path) -> VortexResult<Self> {
        let canonical_root = repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.to_path_buf());
        let mut rules = Vec::new();

        for &pat in DEFAULT_EXCLUDE_PATTERNS {
            Self::push_rule(&mut rules, pat, "built-in-defaults")?;
        }

        if let Ok(env_ignore) = std::env::var("KVX_IGNORE_FILE") {
            let p = PathBuf::from(&env_ignore);
            if p.is_file() {
                Self::load_ignore_file(&mut rules, &p, &env_ignore)?;
            }
        }

        let mut config = KvxYamlConfig::default();
        for yaml_name in [".kvx.yaml", ".kvx.yml", "kvx.yaml"] {
            let yaml_path = canonical_root.join(yaml_name);
            if yaml_path.is_file() {
                let raw_yaml = fs::read_to_string(&yaml_path)?;
                if !raw_yaml.trim().is_empty() {
                    let parsed: KvxYamlConfig = serde_yaml::from_str(&raw_yaml)?;
                    for pat in parsed.ignore.iter().chain(parsed.exclude.iter()) {
                        Self::push_rule(&mut rules, pat, yaml_name)?;
                    }
                    config = parsed;
                    break;
                }
            }
        }

        let kvxignore_path = canonical_root.join(".kvxignore");
        if kvxignore_path.is_file() {
            Self::load_ignore_file(&mut rules, &kvxignore_path, ".kvxignore")?;
        }

        let max_file_bytes = config.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES);

        Ok(Self {
            repo_root: canonical_root,
            rules,
            config,
            max_file_bytes,
        })
    }

    /// Canonical repository root enforced by this containment policy.
    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    /// Returns parsed `.kvx.yaml` settings (including custom `layer_rules`).
    pub fn config(&self) -> &KvxYamlConfig {
        &self.config
    }

    /// Maximum allowed file size in bytes before admission firewall skips indexing.
    pub fn max_file_bytes(&self) -> u64 {
        self.max_file_bytes
    }

    /// Validates that `path` contains no `..`, root escapes, or NUL bytes and lies inside `repo_root`,
    /// returning a clean forward-slash relative path.
    pub fn validate_safe_rel_path(&self, path: &Path) -> VortexResult<String> {
        let raw_lossy = path.to_string_lossy();
        if raw_lossy.contains('\0') {
            return Err(VortexError::InvalidInput(
                "Path contains forbidden NUL byte".to_string(),
            ));
        }

        let unified = raw_lossy.replace('\\', "/");
        for comp in Path::new(&unified).components() {
            if matches!(comp, Component::ParentDir) {
                return Err(VortexError::InvalidInput(format!(
                    "Parent directory '..' traversal is forbidden: '{}'",
                    path.display()
                )));
            }
        }

        let rel_candidate = if Path::new(&unified).is_absolute() || path.is_absolute() {
            let abs_in = Path::new(path);
            if let Ok(stripped) = abs_in.strip_prefix(&self.repo_root) {
                stripped.to_path_buf()
            } else if let Ok(canon) = abs_in.canonicalize() {
                if let Ok(stripped) = canon.strip_prefix(&self.repo_root) {
                    stripped.to_path_buf()
                } else {
                    return Err(VortexError::InvalidInput(format!(
                        "Absolute path '{}' escapes repository root '{}'",
                        path.display(),
                        self.repo_root.display()
                    )));
                }
            } else {
                return Err(VortexError::InvalidInput(format!(
                    "Absolute path '{}' escapes repository root '{}'",
                    path.display(),
                    self.repo_root.display()
                )));
            }
        } else {
            PathBuf::from(&unified)
        };

        let rel_unified = rel_candidate.to_string_lossy().replace('\\', "/");
        let mut clean_segments: Vec<&str> = Vec::new();
        for comp in Path::new(&rel_unified).components() {
            match comp {
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(VortexError::InvalidInput(format!(
                        "Parent directory '..' traversal is forbidden: '{}'",
                        path.display()
                    )));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(VortexError::InvalidInput(format!(
                        "Root or drive prefix component is forbidden: '{}'",
                        path.display()
                    )));
                }
                Component::Normal(seg) => {
                    let s = seg.to_str().ok_or_else(|| {
                        VortexError::InvalidInput(format!(
                            "Non-UTF-8 path segment in '{}'",
                            path.display()
                        ))
                    })?;
                    if s == ".." {
                        return Err(VortexError::InvalidInput(format!(
                            "Parent directory '..' traversal is forbidden: '{}'",
                            path.display()
                        )));
                    }
                    if !s.is_empty() && s != "." {
                        clean_segments.push(s);
                    }
                }
            }
        }

        if clean_segments.is_empty() {
            return Err(VortexError::InvalidInput(
                "Relative file path must not be empty".to_string(),
            ));
        }

        Ok(clean_segments.join("/"))
    }

    /// Verifies that no symlink component along `safe_rel` escapes `self.repo_root`.
    pub fn verify_containment(&self, safe_rel: &str) -> VortexResult<PathBuf> {
        let valid_rel = self.validate_safe_rel_path(Path::new(safe_rel))?;
        let mut acc = self.repo_root.clone();
        for seg in valid_rel.split('/') {
            acc.push(seg);
            if let Ok(meta) = fs::symlink_metadata(&acc) {
                if meta.file_type().is_symlink() {
                    let canon = acc.canonicalize().map_err(|_| {
                        VortexError::InvalidInput(format!(
                            "Dangling or unresolvable symlink '{}' is forbidden",
                            valid_rel
                        ))
                    })?;
                    if !canon.starts_with(&self.repo_root) {
                        return Err(VortexError::InvalidInput(format!(
                            "Symlink '{}' resolves to '{}' outside repository root '{}'",
                            valid_rel,
                            canon.display(),
                            self.repo_root.display()
                        )));
                    }
                } else if let Ok(canon) = acc.canonicalize() {
                    if !canon.starts_with(&self.repo_root) {
                        return Err(VortexError::InvalidInput(format!(
                            "Path '{}' resolves outside repository root '{}'",
                            valid_rel,
                            self.repo_root.display()
                        )));
                    }
                }
            }
        }
        Ok(acc)
    }

    /// Validates relative path structure, enforces `.kvxignore`, and verifies symlink containment.
    pub fn resolve_contained_path(&self, raw_path: &Path) -> VortexResult<(String, PathBuf)> {
        let safe_rel = self.validate_safe_rel_path(raw_path)?;
        self.check_not_ignored(Path::new(&safe_rel))?;
        let abs = self.verify_containment(&safe_rel)?;
        Ok((safe_rel, abs))
    }

    /// Normalizes an absolute or relative path into a clean forward-slash path relative to `repo_root`.
    /// Returns an empty string if `path` is root-equivalent or attempts traversal outside `repo_root`.
    pub fn normalize_rel_path(&self, path: &Path) -> String {
        self.validate_safe_rel_path(path).unwrap_or_default()
    }

    /// Checks whether a relative or absolute path is ignored, returning the winning `(rule, source)` if excluded.
    pub fn match_ignored(&self, path: &Path, is_dir: bool) -> Option<(String, String)> {
        if path == self.repo_root {
            return None;
        }
        let Ok(rel) = self.validate_safe_rel_path(path) else {
            return Some((
                "path-containment-escape".to_string(),
                "security-firewall".to_string(),
            ));
        };
        let mut matched: Option<(String, String)> = None;
        for rule in &self.rules {
            if rule.dir_only && !is_dir && !rel.contains('/') {
                continue;
            }
            let hits_main = rule.matcher.is_match(&rel);
            let hits_sub = rule
                .sub_matcher
                .as_ref()
                .map(|m| m.is_match(&rel))
                .unwrap_or(false);
            if hits_main || hits_sub {
                if rule.negated {
                    matched = None;
                } else {
                    matched = Some((rule.raw.clone(), rule.source_file.clone()));
                }
            }
        }
        matched
    }

    /// Convenience predicate returning `true` when `path` is excluded.
    pub fn is_ignored(&self, path: &Path) -> bool {
        self.match_ignored(path, path.is_dir()).is_some()
    }

    /// Guard that returns `Err(KvxIgnoreError)` when `path` is excluded by policy or escapes `repo_root`.
    pub fn check_not_ignored(&self, path: &Path) -> Result<(), KvxIgnoreError> {
        let is_dir = path.is_dir();
        if let Some((rule, source_file)) = self.match_ignored(path, is_dir) {
            return Err(KvxIgnoreError {
                path: path.to_string_lossy().replace('\\', "/"),
                rule,
                source_file,
            });
        }
        Ok(())
    }

    /// Detects binary files via NUL byte inspection or magic headers in the first 4 KiB.
    pub fn is_binary_bytes(bytes: &[u8]) -> bool {
        let sample_len = bytes.len().min(4096);
        let sample = &bytes[..sample_len];
        if sample.contains(&0) {
            return true;
        }
        if sample.starts_with(b"\x7fELF")
            || sample.starts_with(b"MZ")
            || sample.starts_with(b"\x89PNG")
            || sample.starts_with(b"%PDF-")
            || sample.starts_with(b"PK\x03\x04")
        {
            return true;
        }
        false
    }

    /// Detects single-line minified JS/CSS/JSON bundles that would pollute AST token budgets.
    pub fn is_minified_source(ext: &str, text: &str) -> bool {
        if !matches!(ext, "js" | "mjs" | "cjs" | "css") {
            return false;
        }
        if text.len() < 2048 {
            return false;
        }
        let mut lines = 0usize;
        let mut max_line = 0usize;
        for line in text.lines() {
            lines += 1;
            if line.len() > max_line {
                max_line = line.len();
            }
        }
        lines <= 5 && max_line > 1400
    }

    fn load_ignore_file(
        rules: &mut Vec<CompiledIgnoreRule>,
        file_path: &Path,
        label: &str,
    ) -> VortexResult<()> {
        let content = fs::read_to_string(file_path)?;
        for raw_line in content.lines() {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            Self::push_rule(rules, trimmed, label)?;
        }
        Ok(())
    }

    fn push_rule(
        rules: &mut Vec<CompiledIgnoreRule>,
        raw_pattern: &str,
        source_file: &str,
    ) -> VortexResult<()> {
        let mut pat = raw_pattern.trim().replace('\\', "/");
        if pat.is_empty() || pat.starts_with('#') {
            return Ok(());
        }
        let negated = if let Some(rest) = pat.strip_prefix('!') {
            pat = rest.trim().to_string();
            true
        } else {
            false
        };
        if pat.is_empty() {
            return Ok(());
        }

        let dir_only = pat.ends_with('/');
        let clean = pat.trim_matches('/');
        if clean.is_empty() {
            return Ok(());
        }

        let anchored = pat.starts_with('/');
        let has_slash = clean.contains('/');

        let primary_glob = if anchored || has_slash {
            clean.to_string()
        } else {
            format!("**/{clean}")
        };

        let sub_glob = if dir_only || (!clean.ends_with("/**") && !clean.contains('*')) {
            Some(format!("{primary_glob}/**"))
        } else {
            None
        };

        let matcher = GlobBuilder::new(&primary_glob)
            .literal_separator(true)
            .build()?
            .compile_matcher();

        let sub_matcher = match sub_glob {
            Some(ref g) => Some(
                GlobBuilder::new(g)
                    .literal_separator(true)
                    .build()?
                    .compile_matcher(),
            ),
            None => None,
        };

        rules.push(CompiledIgnoreRule {
            raw: raw_pattern.trim().to_string(),
            negated,
            dir_only,
            source_file: source_file.to_string(),
            matcher,
            sub_matcher,
        });
        Ok(())
    }
}
