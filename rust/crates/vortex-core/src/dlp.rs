//! 15-category DLP secret & PII scanner (`DlpScanner`), placeholder filter, deterministic redactor,
//! and `.fabrica-dlp-allow.json` allowlist loader with mandatory `reason` enforcement.
//!
//! Traceability: `@REQ-VORTEX-005`.

use crate::types::{DlpCategory, DlpFinding, VortexError, VortexResult};
use globset::{GlobBuilder, GlobMatcher};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// Single allowlist entry loaded from `.fabrica-dlp-allow.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlpAllowEntry {
    pub rule: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct RawAllowFile {
    #[serde(alias = "entries", default)]
    allow: Vec<DlpAllowEntry>,
}

#[derive(Debug, Clone)]
struct CompiledAllowRule {
    rule: String,
    matchers: Vec<GlobMatcher>,
    reason: String,
}

/// Validated DLP allowlist policy for a repository.
#[derive(Debug, Clone, Default)]
pub struct DlpAllowlist {
    compiled: Vec<CompiledAllowRule>,
}

impl DlpAllowlist {
    /// Creates an allowlist with default test-fixture globs (`tests/**/fixtures/**`, `**/__fixtures__/**`).
    pub fn with_builtin_defaults() -> Self {
        let mut list = Self::default();
        let _ = list.add_entry(DlpAllowEntry {
            rule: "*".to_string(),
            paths: vec![
                "tests/**/fixtures/**".to_string(),
                "test/**/fixtures/**".to_string(),
                "**/__fixtures__/**".to_string(),
            ],
            reason: "Built-in synthetic test fixture directory".to_string(),
        });
        list
    }

    /// Loads `.fabrica-dlp-allow.json` from `repo_root`, rejecting any entry with an empty `reason`.
    pub fn load_from_repo(repo_root: &Path) -> VortexResult<Self> {
        let mut allowlist = Self::with_builtin_defaults();
        let file_path = repo_root.join(".fabrica-dlp-allow.json");
        if !file_path.is_file() {
            return Ok(allowlist);
        }
        let raw_text = fs::read_to_string(&file_path)?;
        let entries: Vec<DlpAllowEntry> = if raw_text.trim_start().starts_with('[') {
            serde_json::from_str(&raw_text)?
        } else {
            let wrapper: RawAllowFile = serde_json::from_str(&raw_text)?;
            wrapper.allow
        };

        for (idx, entry) in entries.into_iter().enumerate() {
            if entry.reason.trim().is_empty() {
                return Err(VortexError::InvalidInput(format!(
                    ".fabrica-dlp-allow.json entry #{idx} (rule '{}') is missing a mandatory non-empty 'reason'",
                    entry.rule
                )));
            }
            allowlist.add_entry(entry)?;
        }
        Ok(allowlist)
    }

    /// Adds a validated `DlpAllowEntry` (requires non-empty `reason` and at least one path glob).
    pub fn add_entry(&mut self, entry: DlpAllowEntry) -> VortexResult<()> {
        if entry.reason.trim().is_empty() {
            return Err(VortexError::InvalidInput(
                "DLP allowlist entry requires a non-empty 'reason'".to_string(),
            ));
        }
        if entry.paths.is_empty() {
            return Err(VortexError::InvalidInput(
                "DLP allowlist entry requires at least one path glob in 'paths'".to_string(),
            ));
        }
        let mut matchers = Vec::with_capacity(entry.paths.len());
        for p in &entry.paths {
            let gm = GlobBuilder::new(p)
                .literal_separator(true)
                .build()?
                .compile_matcher();
            matchers.push(gm);
        }
        self.compiled.push(CompiledAllowRule {
            rule: entry.rule.trim().to_ascii_lowercase(),
            matchers,
            reason: entry.reason,
        });
        Ok(())
    }

    /// Checks whether `(category, rel_path)` is explicitly allowed, returning the audit reason if so.
    pub fn is_allowed(&self, category: DlpCategory, rel_path: &str) -> Option<&str> {
        let norm_path = rel_path.replace('\\', "/");
        let norm_path = norm_path.trim_start_matches("./");
        let cat_name = category.as_str();
        for rule in &self.compiled {
            let rule_matches = rule.rule == "*" || rule.rule == cat_name;
            if rule_matches && rule.matchers.iter().any(|m| m.is_match(norm_path)) {
                return Some(rule.reason.as_str());
            }
        }
        None
    }
}

struct CategoryRule {
    category: DlpCategory,
    severity: &'static str,
    regex: Regex,
    secret_group: usize,
}

fn compiled_dlp_rules() -> &'static Vec<CategoryRule> {
    static RULES: OnceLock<Vec<CategoryRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            CategoryRule {
                category: DlpCategory::AppsheetAccessKey,
                severity: "critical",
                regex: Regex::new(r"\b(V2-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::AppsheetAppId,
                severity: "high",
                regex: Regex::new(r"api\.appsheet\.com/api/v2/apps/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::GoogleApiKey,
                severity: "high",
                regex: Regex::new(r"\b(AIza[0-9A-Za-z_-]{31,45})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::GoogleOauthToken,
                severity: "critical",
                regex: Regex::new(r"\b(ya29\.[0-9A-Za-z._-]{24,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::DriveResourceId,
                severity: "medium",
                regex: Regex::new(r#"(?i)\b(?:DRIVE_FOLDER_ID|GOOGLE_DRIVE_FOLDER_ID|TEMPLATE_DOC_ID|SPREADSHEET_ID)\s*[:=]\s*['"]([A-Za-z0-9_-]{25,60})['"]"#).unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::PrivateKeyPem,
                severity: "critical",
                regex: Regex::new(r"(-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----)").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::AnthropicKey,
                severity: "critical",
                regex: Regex::new(r"\b(sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::OpenaiKey,
                severity: "critical",
                regex: Regex::new(r"\b(sk-(?:proj|live|svcacct)-[A-Za-z0-9_-]{20,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::GithubPat,
                severity: "critical",
                regex: Regex::new(r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::AwsKey,
                severity: "critical",
                regex: Regex::new(r"\b((?:AKIA|ASIA)[0-9A-Z]{16})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::SlackToken,
                severity: "critical",
                regex: Regex::new(r"\b(xox[baprs]-[0-9A-Za-z-]{12,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::JwtToken,
                severity: "high",
                regex: Regex::new(r"\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::DbUri,
                severity: "critical",
                regex: Regex::new(r#"((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss)://[^:\s/'"]+:[^@\s'"]+@[^\s'"]+)"#).unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::PiiCpfCnpj,
                severity: "high",
                regex: Regex::new(r"\b(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})\b").unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
            CategoryRule {
                category: DlpCategory::GenericSecret,
                severity: "high",
                regex: Regex::new(r#"(?i)\b(?:api_key|client_secret|access_token|refresh_token|secret_key|password|passwd|applicationAccessKey)\s*[:=]\s*['"]([^'"\s]{12,})['"]"#).unwrap_or_else(|_| unreachable!()),
                secret_group: 1,
            },
        ]
    })
}

fn pem_block_regexes() -> &'static (Regex, Regex) {
    static PEM_RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    PEM_RE.get_or_init(|| {
        let begin_re =
            Regex::new(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----")
                .unwrap_or_else(|_| unreachable!());
        let end_re = Regex::new(r"-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----")
            .unwrap_or_else(|_| unreachable!());
        (begin_re, end_re)
    })
}

/// 15-category Data Loss Prevention scanner and deterministic text redactor.
#[derive(Debug, Clone)]
pub struct DlpScanner {
    allowlist: DlpAllowlist,
}

impl Default for DlpScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl DlpScanner {
    /// Creates a `DlpScanner` with default built-in fixture exclusions.
    pub fn new() -> Self {
        Self {
            allowlist: DlpAllowlist::with_builtin_defaults(),
        }
    }

    /// Creates a `DlpScanner` configured with `.fabrica-dlp-allow.json` from `repo_root`.
    pub fn from_repo(repo_root: &Path) -> VortexResult<Self> {
        let allowlist = DlpAllowlist::load_from_repo(repo_root)?;
        Ok(Self { allowlist })
    }

    /// Creates a `DlpScanner` from a pre-built `DlpAllowlist`.
    pub fn with_allowlist(allowlist: DlpAllowlist) -> Self {
        Self { allowlist }
    }

    /// Returns all 15 supported `DlpCategory` variants.
    pub fn categories() -> &'static [DlpCategory; 15] {
        &DlpCategory::ALL
    }

    /// Scans `text` attributed to `file_path`, returning sanitized `DlpFinding` records.
    pub fn scan_text(&self, file_path: &str, text: &str) -> Vec<DlpFinding> {
        self.scan_and_redact(file_path, text).1
    }

    /// Redacts all detected secrets in `text` with `[REDACTED:<category>]`, returning `(sanitized_text, findings)`.
    pub fn scan_and_redact(&self, file_path: &str, text: &str) -> (String, Vec<DlpFinding>) {
        if text.is_empty() {
            return (String::new(), Vec::new());
        }

        let is_firebase_web_client = text.contains("authDomain")
            && text.contains("initializeApp")
            && !text.contains("private_key");

        let mut findings = Vec::new();
        let pem_allowed = self
            .allowlist
            .is_allowed(DlpCategory::PrivateKeyPem, file_path)
            .is_some();

        let mut output = String::with_capacity(text.len());
        let (pem_begin_re, pem_end_re) = pem_block_regexes();
        let mut cursor = 0usize;

        while cursor < text.len() {
            if pem_allowed {
                let (sanitized_rest, rest_findings) =
                    self.scan_non_pem_segment(file_path, &text[cursor..], text, cursor, is_firebase_web_client);
                output.push_str(&sanitized_rest);
                findings.extend(rest_findings);
                break;
            }

            let Some(begin_m) = pem_begin_re.find(&text[cursor..]) else {
                let (sanitized_rest, rest_findings) =
                    self.scan_non_pem_segment(file_path, &text[cursor..], text, cursor, is_firebase_web_client);
                output.push_str(&sanitized_rest);
                findings.extend(rest_findings);
                break;
            };

            let abs_start = cursor + begin_m.start();
            let after_begin = cursor + begin_m.end();

            if abs_start > cursor {
                let (sanitized_before, before_findings) = self.scan_non_pem_segment(
                    file_path,
                    &text[cursor..abs_start],
                    text,
                    cursor,
                    is_firebase_web_client,
                );
                output.push_str(&sanitized_before);
                findings.extend(before_findings);
            }

            let next_begin_rel = pem_begin_re.find(&text[after_begin..]).map(|m| m.start());
            let end_rel = pem_end_re.find(&text[after_begin..]);

            let block_end = match (end_rel, next_begin_rel) {
                (Some(em), Some(nb)) if em.start() < nb => after_begin + em.end(),
                (Some(em), None) => after_begin + em.end(),
                _ => find_unclosed_pem_end(text, after_begin),
            };

            let secret_block = &text[abs_start..block_end];
            if is_placeholder_pem_block(secret_block) {
                output.push_str(secret_block);
            } else {
                let (line_no, col_no) = line_and_col_at_byte(text, abs_start);
                let mut hasher = Sha256::new();
                hasher.update(secret_block.as_bytes());
                let value_sha256 = hex::encode(hasher.finalize());
                let prefix: String = secret_block.chars().take(4).collect();
                let tag = format!("[REDACTED:{}]", DlpCategory::PrivateKeyPem.as_str());
                findings.push(DlpFinding {
                    category: DlpCategory::PrivateKeyPem,
                    severity: "critical".to_string(),
                    file_path: file_path.to_string(),
                    line: line_no,
                    col: col_no,
                    redacted_preview: format!("{prefix}...{tag}"),
                    value_sha256,
                });
                output.push_str(&tag);
            }

            cursor = block_end;
        }

        findings.sort_by_key(|f| (f.line, f.col));
        (output, findings)
    }

    fn scan_non_pem_segment(
        &self,
        file_path: &str,
        segment: &str,
        full_text: &str,
        segment_start_byte: usize,
        is_firebase_web_client: bool,
    ) -> (String, Vec<DlpFinding>) {
        if segment.is_empty() {
            return (String::new(), Vec::new());
        }

        let rules = compiled_dlp_rules();
        let mut seg_findings = Vec::new();
        let mut sanitized_lines = Vec::new();
        let mut line_byte_offset = segment_start_byte;

        for raw_line in segment.split('\n') {
            let (line_no, base_col_1based) = line_and_col_at_byte(full_text, line_byte_offset);
            line_byte_offset = line_byte_offset.saturating_add(raw_line.len() + 1);

            let mut spans_to_redact: Vec<(usize, usize, DlpCategory, &'static str, String)> =
                Vec::new();

            for rule in rules {
                if rule.category == DlpCategory::PrivateKeyPem {
                    continue;
                }
                if self.allowlist.is_allowed(rule.category, file_path).is_some() {
                    continue;
                }
                if rule.category == DlpCategory::GoogleApiKey && is_firebase_web_client {
                    continue;
                }

                for cap in rule.regex.captures_iter(raw_line) {
                    let Some(m) = cap.get(rule.secret_group) else {
                        continue;
                    };
                    let val = m.as_str();
                    if is_placeholder_secret(rule.category, val) {
                        continue;
                    }
                    let overlaps = spans_to_redact
                        .iter()
                        .any(|&(s, e, _, _, _)| m.start() < e && m.end() > s);
                    if overlaps {
                        continue;
                    }
                    spans_to_redact.push((
                        m.start(),
                        m.end(),
                        rule.category,
                        rule.severity,
                        val.to_string(),
                    ));
                }
            }

            if spans_to_redact.is_empty() {
                sanitized_lines.push(raw_line.to_string());
                continue;
            }

            spans_to_redact.sort_by_key(|t| t.0);
            for (start_b, _, category, severity, ref secret_val) in &spans_to_redact {
                let mut hasher = Sha256::new();
                hasher.update(secret_val.as_bytes());
                let value_sha256 = hex::encode(hasher.finalize());
                let prefix: String = secret_val.chars().take(4).collect();
                let redacted_preview = format!("{prefix}...[REDACTED:{}]", category.as_str());

                seg_findings.push(DlpFinding {
                    category: *category,
                    severity: (*severity).to_string(),
                    file_path: file_path.to_string(),
                    line: line_no,
                    col: base_col_1based + start_b,
                    redacted_preview,
                    value_sha256,
                });
            }

            let mut edited = raw_line.to_string();
            for (start_b, end_b, category, _, _) in spans_to_redact.into_iter().rev() {
                let tag = format!("[REDACTED:{}]", category.as_str());
                edited.replace_range(start_b..end_b, &tag);
            }
            sanitized_lines.push(edited);
        }

        (sanitized_lines.join("\n"), seg_findings)
    }

    /// Convenience helper returning only the DLP-redacted string for `text`.
    pub fn redact_text(&self, text: &str) -> String {
        self.scan_and_redact("<memory>", text).0
    }
}

fn line_and_col_at_byte(full_text: &str, byte_offset: usize) -> (usize, usize) {
    let clamped = byte_offset.min(full_text.len());
    let prefix = &full_text[..clamped];
    let line_no = 1 + prefix.bytes().filter(|&b| b == b'\n').count();
    let col_no = match prefix.rfind('\n') {
        Some(nl_idx) => clamped - nl_idx,
        None => clamped + 1,
    };
    (line_no, col_no)
}

fn find_unclosed_pem_end(text: &str, after_begin: usize) -> usize {
    let rest = &text[after_begin..];
    let first_nl = match rest.find('\n') {
        Some(idx) => idx,
        None => {
            // Single-line escaped or inline unclosed PEM: consume PEM/Base64/escaped-\n bytes up to quote or end
            let mut consumed = 0usize;
            for ch in rest.chars() {
                if ch == '"' || ch == '\'' || ch == '`' {
                    break;
                }
                consumed += ch.len_utf8();
            }
            return after_begin + consumed;
        }
    };

    let same_line_tail = &rest[..first_nl];
    if same_line_tail.contains('"') || same_line_tail.contains('\'') {
        let mut consumed = 0usize;
        for ch in same_line_tail.chars() {
            if ch == '"' || ch == '\'' {
                break;
            }
            consumed += ch.len_utf8();
        }
        return after_begin + consumed;
    }

    let mut offset = after_begin + first_nl + 1;
    let mut in_armor_headers = true;
    let mut saw_body_line = false;

    while offset < text.len() {
        let remaining = &text[offset..];
        let (line_slice, next_offset) = match remaining.find('\n') {
            Some(nl) => (&remaining[..nl], offset + nl + 1),
            None => (remaining, text.len()),
        };
        let trimmed = line_slice.trim();

        if trimmed.is_empty() {
            if in_armor_headers && !saw_body_line {
                in_armor_headers = false;
                offset = next_offset;
                continue;
            }
            break;
        }

        if in_armor_headers && trimmed.contains(':') && !trimmed.contains(' ')
            || trimmed.starts_with("Proc-Type:")
            || trimmed.starts_with("DEK-Info:")
            || trimmed.starts_with("Comment:")
            || trimmed.starts_with("Version:")
        {
            offset = next_offset;
            continue;
        }

        in_armor_headers = false;
        let is_b64_line = trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-'));
        if is_b64_line {
            saw_body_line = true;
            // Preserve trailing newline separator rather than eating structural markdown line breaks
            offset += line_slice.len();
            if next_offset < text.len() {
                let peek_rem = &text[next_offset..];
                let peek_line = match peek_rem.find('\n') {
                    Some(nl) => peek_rem[..nl].trim(),
                    None => peek_rem.trim(),
                };
                if !peek_line.is_empty()
                    && peek_line
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-'))
                {
                    offset = next_offset;
                    continue;
                }
            }
            break;
        } else {
            break;
        }
    }

    offset
}

fn is_placeholder_pem_block(secret_block: &str) -> bool {
    let trimmed = secret_block.trim();
    if trimmed.is_empty() || trimmed.starts_with("[REDACTED:") {
        return true;
    }
    // Strip BEGIN/END markers to inspect the interior payload
    let interior: String = trimmed
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.starts_with("-----BEGIN ") && !t.starts_with("-----END ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let clean_interior = interior.trim();
    if !clean_interior.is_empty() && clean_interior.len() < 48 {
        let up = clean_interior.to_ascii_uppercase();
        if clean_interior == "..."
            || (clean_interior.starts_with('<') && clean_interior.ends_with('>'))
            || up.contains("PLACEHOLDER")
            || up.contains("EXAMPLE")
            || up.contains("REDACTED")
            || up.contains("INSERT_HERE")
            || up.contains("YOUR_")
        {
            return true;
        }
    }
    false
}

fn is_placeholder_secret(category: DlpCategory, raw_val: &str) -> bool {
    let trimmed = raw_val.trim();
    if trimmed.is_empty() {
        return true;
    }
    if (trimmed.starts_with('<') && trimmed.ends_with('>'))
        || (trimmed.starts_with("${") && trimmed.ends_with('}'))
        || (trimmed.starts_with("{{") && trimmed.ends_with("}}"))
        || trimmed.starts_with("[REDACTED:")
    {
        return true;
    }

    let upper = trimmed.to_ascii_uppercase();
    for marker in [
        "EXAMPLE",
        "PLACEHOLDER",
        "YOUR_",
        "CHANGEME",
        "REDACTED",
        "DUMMY",
        "INSERT_HERE",
    ] {
        if upper.contains(marker) {
            return true;
        }
    }

    if category != DlpCategory::PrivateKeyPem
        && trimmed
            .chars()
            .all(|c| matches!(c, 'x' | 'X' | '*' | '#' | '0' | '.' | '_' | '-' | '/'))
    {
        return true;
    }

    if category == DlpCategory::PiiCpfCnpj {
        let digits: Vec<char> = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Some(&first) = digits.first() {
            if digits.iter().all(|&d| d == first) {
                return true;
            }
        }
    }

    if category == DlpCategory::DbUri {
        if let Some(after_scheme) = trimmed.split("://").nth(1) {
            if let Some((creds, _)) = after_scheme.split_once('@') {
                if let Some((_, pass)) = creds.split_once(':') {
                    let up_pass = pass.to_ascii_uppercase();
                    if pass.is_empty()
                        || pass.starts_with("${")
                        || pass.starts_with('<')
                        || up_pass == "PASSWORD"
                        || up_pass == "EXAMPLE"
                        || pass.chars().all(|c| c == '*' || c == 'x' || c == 'X')
                    {
                        return true;
                    }
                }
            }
        }
    }

    false
}
