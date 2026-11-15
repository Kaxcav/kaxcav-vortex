//! Multi-language native `tree-sitter` AST & structured lexical parser, HTTP route extractor,
//! syntax verifier, and anti-slop AST analyzer.
//!
//! Traceability: `@REQ-VORTEX-001`.

use crate::types::{
    EdgeRecord, RefConfidence, ReferenceRecord, RouteRecord, SlopFinding, SymbolRecord,
};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Language, Node, Parser};

/// Complete extraction output for a single source file.
#[derive(Debug, Clone, Default)]
pub struct ParsedFile {
    pub symbols: Vec<SymbolRecord>,
    pub references: Vec<ReferenceRecord>,
    pub edges: Vec<EdgeRecord>,
    pub routes: Vec<RouteRecord>,
    pub has_syntax_errors: bool,
    pub syntax_error_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TsGrammar {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Bash,
    Json,
    C,
    Java,
}

impl TsGrammar {
    fn from_ext(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "go" => Some(Self::Go),
            "sh" | "bash" | "zsh" => Some(Self::Bash),
            "json" => Some(Self::Json),
            "c" | "h" => Some(Self::C),
            "java" => Some(Self::Java),
            _ => None,
        }
    }

    fn language(self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Bash => tree_sitter_bash::LANGUAGE.into(),
            Self::Json => tree_sitter_json::LANGUAGE.into(),
            Self::C => tree_sitter_c::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
        }
    }
}

struct AstExtractCtx<'a> {
    rel_path: &'a str,
    source: &'a str,
    lines: &'a [&'a str],
    out: &'a mut ParsedFile,
    decl_spans: &'a mut HashSet<(usize, usize)>,
    imported_names: &'a mut HashSet<String>,
    has_wildcard: &'a mut bool,
}

struct RefWalkCtx<'a> {
    rel_path: &'a str,
    source: &'a str,
    lines: &'a [&'a str],
    symbols: &'a [SymbolRecord],
    decl_spans: &'a HashSet<(usize, usize)>,
    same_file_names: &'a HashSet<String>,
    imported_names: &'a HashSet<String>,
    has_wildcard: bool,
    noise: &'a HashSet<&'static str>,
}

#[derive(Clone, Copy)]
struct JavaScope<'a> {
    enclosing_class: Option<&'a str>,
    route_prefix: &'a str,
}

/// Stateless, thread-safe multi-language AST and structured lexical extractor.
#[derive(Debug, Clone, Default)]
pub struct AstParser;

impl AstParser {
    /// Creates a new `AstParser` instance.
    pub fn new() -> Self {
        Self
    }

    /// Lists all native `tree-sitter` language identifiers compiled into `vortex-core`.
    pub fn supported_tree_sitter_languages() -> Vec<String> {
        vec![
            "rust".to_string(),
            "typescript".to_string(),
            "tsx".to_string(),
            "javascript".to_string(),
            "python".to_string(),
            "go".to_string(),
            "bash".to_string(),
            "json".to_string(),
            "c".to_string(),
            "java".to_string(),
        ]
    }

    /// Returns `true` if `ext` is supported by either `tree-sitter` or structured lexical extraction.
    pub fn is_supported_extension(ext: &str) -> bool {
        let lower = ext.to_ascii_lowercase();
        TsGrammar::from_ext(&lower).is_some()
            || matches!(
                lower.as_str(),
                "sql" | "md" | "mdx" | "yaml" | "yml" | "toml" | "cpp" | "hpp" | "cc" | "cxx"
            )
    }

    /// Parses `source` and returns `true` when `tree-sitter` detects any `ERROR` or `MISSING` node.
    pub fn has_syntax_errors(ext: &str, source: &str) -> bool {
        Self::syntax_error_count(ext, source)
            .map(|c| c > 0)
            .unwrap_or(false)
    }

    /// Returns `(line_1based, col_1based, node_kind)` of the first `ERROR` or `MISSING` AST node, if any.
    pub fn first_syntax_error(ext: &str, source: &str) -> Option<(usize, usize, String)> {
        let clean_src = source.strip_prefix('\u{feff}').unwrap_or(source);
        let grammar = TsGrammar::from_ext(ext)?;
        let mut parser = Parser::new();
        parser.set_language(&grammar.language()).ok()?;
        let tree = parser.parse(clean_src, None)?;
        let root = tree.root_node();
        if !root.has_error() {
            return None;
        }
        find_first_error_node(root)
    }

    /// Counts `ERROR` and `MISSING` AST nodes for `tree-sitter`-backed extensions (`None` if lexical).
    pub fn syntax_error_count(ext: &str, source: &str) -> Option<usize> {
        let clean_src = source.strip_prefix('\u{feff}').unwrap_or(source);
        let grammar = TsGrammar::from_ext(ext)?;
        let mut parser = Parser::new();
        if parser.set_language(&grammar.language()).is_err() {
            return Some(1);
        }
        let tree = match parser.parse(clean_src, None) {
            Some(t) => t,
            None => return Some(1),
        };
        let root = tree.root_node();
        if !root.has_error() {
            return Some(0);
        }
        Some(count_error_nodes(root).max(1))
    }

    /// Extracts symbols, references, dependency edges, HTTP routes, and syntax status from `source`.
    pub fn parse_file(&self, rel_path: &str, ext: &str, source: &str) -> ParsedFile {
        let clean_src = source.strip_prefix('\u{feff}').unwrap_or(source);
        let lower_ext = ext.to_ascii_lowercase();
        if let Some(grammar) = TsGrammar::from_ext(&lower_ext) {
            return self.parse_with_tree_sitter(rel_path, grammar, clean_src);
        }
        self.parse_lexical(rel_path, &lower_ext, clean_src)
    }

    /// Locates the 1-based `(line, col)` of a symbol's declaration identifier within `start_line..=end_line`,
    /// skipping attributes, decorators, annotations, string literals, and comments.
    pub fn find_decl_identifier_site(
        ext: &str,
        full_source: &str,
        start_line_1based: usize,
        end_line_1based: usize,
        ident: &str,
    ) -> Option<(usize, usize)> {
        let clean_src = full_source.strip_prefix('\u{feff}').unwrap_or(full_source);
        if let Some(grammar) = TsGrammar::from_ext(ext) {
            let mut parser = Parser::new();
            if parser.set_language(&grammar.language()).is_ok() {
                if let Some(tree) = parser.parse(clean_src, None) {
                    if let Some(hit) = find_decl_ident_in_ast(
                        tree.root_node(),
                        clean_src,
                        start_line_1based,
                        end_line_1based,
                        ident,
                    ) {
                        return Some(hit);
                    }
                }
            }
        }
        for ln in start_line_1based..=end_line_1based {
            let cols = Self::find_identifier_columns_on_line(ext, clean_src, ln, ident);
            if let Some(&first_col) = cols.first() {
                return Some((ln, first_col));
            }
        }
        None
    }

    /// Returns sorted 1-based byte columns of exact identifier tokens matching `ident` on
    /// `target_line_1based`, strictly excluding string/char literals and comments.
    pub fn find_identifier_columns_on_line(
        ext: &str,
        full_source: &str,
        target_line_1based: usize,
        ident: &str,
    ) -> Vec<usize> {
        if target_line_1based == 0 || ident.is_empty() {
            return Vec::new();
        }
        let clean_src = full_source.strip_prefix('\u{feff}').unwrap_or(full_source);
        if let Some(grammar) = TsGrammar::from_ext(ext) {
            let mut parser = Parser::new();
            if parser.set_language(&grammar.language()).is_ok() {
                if let Some(tree) = parser.parse(clean_src, None) {
                    let mut cols = Vec::new();
                    collect_line_ident_cols_ast(
                        tree.root_node(),
                        clean_src,
                        target_line_1based,
                        ident,
                        &mut cols,
                    );
                    cols.sort_unstable();
                    cols.dedup();
                    return cols;
                }
            }
        }

        let Some(line_str) = clean_src.lines().nth(target_line_1based - 1) else {
            return Vec::new();
        };
        scan_line_ident_cols_lexical(line_str, ident)
    }

    /// Scans `source` for anti-slop violations (`empty_catch`, `explicit_any`, `ts_ignore`,
    /// `panic_stub`, and `unfinished_marker`).
    pub fn scan_slop(rel_path: &str, ext: &str, source: &str) -> Vec<SlopFinding> {
        let lower_ext = ext.to_ascii_lowercase();
        if matches!(
            lower_ext.as_str(),
            "md" | "mdx" | "json" | "yaml" | "yml" | "toml" | "sql"
        ) {
            return Vec::new();
        }

        let lines: Vec<&str> = source.lines().collect();
        let mut findings = Vec::new();

        if let Some(grammar) = TsGrammar::from_ext(&lower_ext) {
            let mut parser = Parser::new();
            if parser.set_language(&grammar.language()).is_ok() {
                if let Some(tree) = parser.parse(source, None) {
                    scan_slop_ast(
                        tree.root_node(),
                        rel_path,
                        grammar,
                        source,
                        &lines,
                        &mut findings,
                    );
                    findings.sort_by_key(|f| (f.line, f.col));
                    findings.dedup_by(|a, b| a.line == b.line && a.kind == b.kind);
                    return findings;
                }
            }
        }

        scan_slop_lexical(rel_path, &lower_ext, &lines, &mut findings);
        findings.sort_by_key(|f| (f.line, f.col));
        findings.dedup_by(|a, b| a.line == b.line && a.kind == b.kind);
        findings
    }

    fn parse_with_tree_sitter(
        &self,
        rel_path: &str,
        grammar: TsGrammar,
        source: &str,
    ) -> ParsedFile {
        let mut out = ParsedFile::default();
        let mut parser = Parser::new();
        if parser.set_language(&grammar.language()).is_err() {
            out.has_syntax_errors = true;
            out.syntax_error_count = 1;
            return out;
        }
        let Some(tree) = parser.parse(source, None) else {
            out.has_syntax_errors = true;
            out.syntax_error_count = 1;
            return out;
        };

        let root = tree.root_node();
        if root.has_error() {
            out.has_syntax_errors = true;
            out.syntax_error_count = count_error_nodes(root).max(1);
        }

        let lines: Vec<&str> = source.lines().collect();
        let mut decl_name_spans: HashSet<(usize, usize)> = HashSet::new();
        let mut imported_names: HashSet<String> = HashSet::new();
        let mut has_wildcard_import = false;

        {
            let mut ctx = AstExtractCtx {
                rel_path,
                source,
                lines: &lines,
                out: &mut out,
                decl_spans: &mut decl_name_spans,
                imported_names: &mut imported_names,
                has_wildcard: &mut has_wildcard_import,
            };

            match grammar {
                TsGrammar::Rust => extract_rust_ast(root, &mut ctx, None),
                TsGrammar::TypeScript | TsGrammar::Tsx | TsGrammar::JavaScript => {
                    extract_ts_js_ast(root, &mut ctx, None, false);
                }
                TsGrammar::Python => extract_python_ast(root, &mut ctx, None),
                TsGrammar::Go => extract_go_ast(root, &mut ctx),
                TsGrammar::Bash => extract_bash_ast(root, &mut ctx),
                TsGrammar::Json => extract_json_ast(root, rel_path, source, ctx.out),
                TsGrammar::C => extract_c_ast(root, &mut ctx),
                TsGrammar::Java => extract_java_ast(
                    root,
                    &mut ctx,
                    JavaScope {
                        enclosing_class: None,
                        route_prefix: "",
                    },
                ),
            }
        }

        if grammar != TsGrammar::Json {
            extract_http_routes_lexical(rel_path, source, &lines, &mut out.routes);
            out.routes.sort_by(|a, b| {
                (a.line, &a.method, &a.route_path).cmp(&(b.line, &b.method, &b.route_path))
            });
            out.routes.dedup_by(|a, b| {
                a.line == b.line
                    && a.method == b.method
                    && a.route_path == b.route_path
                    && a.direction == b.direction
            });

            let same_file_names: HashSet<String> =
                out.symbols.iter().map(|s| s.name.clone()).collect();
            let ref_ctx = RefWalkCtx {
                rel_path,
                source,
                lines: &lines,
                symbols: &out.symbols,
                decl_spans: &decl_name_spans,
                same_file_names: &same_file_names,
                imported_names: &imported_names,
                has_wildcard: has_wildcard_import,
                noise: noise_identifiers(),
            };
            collect_identifier_references(root, &ref_ctx, &mut out.references);
        }

        out
    }

    fn parse_lexical(&self, rel_path: &str, ext: &str, source: &str) -> ParsedFile {
        let mut out = ParsedFile::default();
        let lines: Vec<&str> = source.lines().collect();
        match ext {
            "sql" => extract_sql_lexical(rel_path, &lines, &mut out),
            "md" | "mdx" => extract_markdown_lexical(rel_path, &lines, &mut out),
            "yaml" | "yml" => extract_yaml_lexical(rel_path, &lines, &mut out),
            "toml" => extract_toml_lexical(rel_path, &lines, &mut out),
            "cpp" | "hpp" | "cc" | "cxx" => extract_cpp_lexical(rel_path, &lines, &mut out),
            _ => {}
        }
        out
    }
}

fn is_literal_or_comment_kind(kind: &str) -> bool {
    matches!(
        kind,
        "comment"
            | "line_comment"
            | "block_comment"
            | "string"
            | "string_literal"
            | "raw_string_literal"
            | "char_literal"
            | "character_literal"
            | "interpreted_string_literal"
            | "string_fragment"
            | "string_content"
    )
}

fn is_identifier_node_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "property_identifier"
            | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern"
            | "word"
    )
}

fn find_decl_ident_in_ast(
    node: Node<'_>,
    source: &str,
    start_line_1based: usize,
    end_line_1based: usize,
    ident: &str,
) -> Option<(usize, usize)> {
    let kind = node.kind();
    if is_literal_or_comment_kind(kind)
        || matches!(
            kind,
            "attribute_item" | "decorator" | "annotation" | "marker_annotation" | "modifiers"
        )
    {
        return None;
    }

    let node_start_ln = node.start_position().row + 1;
    let node_end_ln = node.end_position().row + 1;
    if node_end_ln < start_line_1based || node_start_ln > end_line_1based {
        return None;
    }

    if is_identifier_node_kind(kind)
        && node_start_ln >= start_line_1based
        && node_start_ln <= end_line_1based
        && node_text(node, source) == ident
    {
        return Some((node_start_ln, node.start_position().column + 1));
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(found) =
            find_decl_ident_in_ast(child, source, start_line_1based, end_line_1based, ident)
        {
            return Some(found);
        }
    }
    None
}

fn collect_line_ident_cols_ast(
    node: Node<'_>,
    source: &str,
    target_line_1based: usize,
    ident: &str,
    cols: &mut Vec<usize>,
) {
    let kind = node.kind();
    if is_literal_or_comment_kind(kind) {
        return;
    }
    let start_ln = node.start_position().row + 1;
    let end_ln = node.end_position().row + 1;
    if end_ln < target_line_1based || start_ln > target_line_1based {
        return;
    }

    if is_identifier_node_kind(kind) && start_ln == target_line_1based {
        if node_text(node, source) == ident {
            cols.push(node.start_position().column + 1);
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_line_ident_cols_ast(child, source, target_line_1based, ident, cols);
    }
}

fn scan_line_ident_cols_lexical(line_str: &str, ident: &str) -> Vec<usize> {
    let bytes = line_str.as_bytes();
    let mut cols = Vec::new();
    let mut i = 0usize;
    let mut in_quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = in_quote {
            if b == b'\\' {
                i = (i + 2).min(bytes.len());
                continue;
            }
            if b == q {
                in_quote = None;
            }
            i += 1;
            continue;
        }

        if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
            break;
        }
        if b == b'-' && bytes.get(i + 1) == Some(&b'-') {
            break;
        }
        if b == b'#' && bytes.get(i + 1) != Some(&b'[') {
            break;
        }
        if b == b'"' || b == b'\'' || b == b'`' {
            in_quote = Some(b);
            i += 1;
            continue;
        }

        let is_ident_start = b.is_ascii_alphabetic() || b == b'_' || b == b'$';
        if is_ident_start {
            let start = i;
            i += 1;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
            {
                i += 1;
            }
            if line_str.get(start..i) == Some(ident) {
                cols.push(start + 1);
            }
            continue;
        }

        i += 1;
    }

    cols
}

fn find_first_error_node(node: Node<'_>) -> Option<(usize, usize, String)> {
    if node.is_error() || node.is_missing() {
        let pos = node.start_position();
        return Some((pos.row + 1, pos.column + 1, node.kind().to_string()));
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.has_error() || child.is_error() || child.is_missing() {
            if let Some(found) = find_first_error_node(child) {
                return Some(found);
            }
        }
    }
    None
}

fn count_error_nodes(node: Node<'_>) -> usize {
    let mut total = usize::from(node.is_error() || node.is_missing());
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.has_error() || child.is_error() || child.is_missing() {
            total += count_error_nodes(child);
        }
    }
    total
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    source.get(node.byte_range()).unwrap_or("")
}

fn hash_hex(input: &str) -> String {
    blake3::hash(input.as_bytes()).to_hex().to_string()
}

fn format_signature_header(header: &str) -> String {
    let collapsed = header.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(';').trim();
    if trimmed.chars().count() > 220 {
        let mut s: String = trimmed.chars().take(220).collect();
        s.push_str("...");
        s
    } else {
        trimmed.to_string()
    }
}

fn clean_signature(raw_node_text: &str) -> String {
    let before_brace = match raw_node_text.find('{') {
        Some(idx) => &raw_node_text[..idx],
        None => raw_node_text.lines().next().unwrap_or(raw_node_text),
    };
    format_signature_header(before_brace)
}

fn extract_ast_signature(node: Node<'_>, source: &str, fallback_norm_body: &str) -> String {
    if let Some(body_node) = node.child_by_field_name("body") {
        if body_node.start_byte() > node.start_byte() {
            if let Some(hdr) = source.get(node.start_byte()..body_node.start_byte()) {
                let formatted = format_signature_header(hdr);
                if !formatted.is_empty() {
                    return formatted;
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declarator" {
            if let Some(val) = child.child_by_field_name("value") {
                if let Some(body_node) = val.child_by_field_name("body") {
                    if body_node.start_byte() > node.start_byte() {
                        if let Some(hdr) = source.get(node.start_byte()..body_node.start_byte()) {
                            let formatted = format_signature_header(hdr);
                            if !formatted.is_empty() {
                                return formatted;
                            }
                        }
                    }
                }
            }
        }
    }
    clean_signature(fallback_norm_body)
}

fn compute_complexity(node: Node<'_>, source: &str) -> usize {
    fn walk_branches(n: Node<'_>, src: &str) -> usize {
        let k = n.kind();
        let mut c = usize::from(matches!(
            k,
            "if_expression"
                | "if_statement"
                | "elif_clause"
                | "match_arm"
                | "switch_case"
                | "case_clause"
                | "case_statement"
                | "switch_block_statement_group"
                | "switch_rule"
                | "for_expression"
                | "for_statement"
                | "for_in_statement"
                | "enhanced_for_statement"
                | "while_expression"
                | "while_statement"
                | "do_statement"
                | "loop_expression"
                | "catch_clause"
                | "except_clause"
                | "conditional_expression"
                | "ternary_expression"
                | "try_expression"
        ));
        if k == "binary_expression" || k == "boolean_operator" {
            if let Some(op) = n.child_by_field_name("operator") {
                let op_txt = node_text(op, src);
                if op_txt == "&&" || op_txt == "||" || op_txt == "and" || op_txt == "or" {
                    c += 1;
                }
            }
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            c += walk_branches(child, src);
        }
        c
    }
    1 + walk_branches(node, source)
}

fn preceding_doc_comment(start_line_1based: usize, lines: &[&str]) -> Option<String> {
    if start_line_1based <= 1 {
        return None;
    }
    let mut collected = Vec::new();
    let mut idx = start_line_1based - 1;
    while idx > 0 {
        idx -= 1;
        let trimmed = lines.get(idx).copied().unwrap_or("").trim();
        if trimmed.starts_with("///")
            || trimmed.starts_with("//!")
            || trimmed.starts_with("* ")
            || trimmed.starts_with("/**")
            || trimmed.starts_with("*/")
        {
            let cleaned = trimmed
                .trim_start_matches("///")
                .trim_start_matches("//!")
                .trim_start_matches("/**")
                .trim_end_matches("*/")
                .trim_start_matches('*')
                .trim();
            if !cleaned.is_empty() {
                collected.push(cleaned.to_string());
            }
        } else if trimmed.starts_with("#[") || trimmed.starts_with('@') {
            continue;
        } else {
            break;
        }
    }
    if collected.is_empty() {
        None
    } else {
        collected.reverse();
        Some(collected.join(" "))
    }
}

fn build_symbol(
    ctx: &AstExtractCtx<'_>,
    name: String,
    qualified_name: String,
    kind: &str,
    node: Node<'_>,
    exported: bool,
) -> SymbolRecord {
    let raw_body = node_text(node, ctx.source);
    let norm_body = if raw_body.contains("\r\n") {
        raw_body.replace("\r\n", "\n")
    } else {
        raw_body.to_string()
    };
    let signature = extract_ast_signature(node, ctx.source, &norm_body);
    let start_line = node.start_position().row + 1;
    let end_pos = node.end_position();
    let raw_end_line = if end_pos.column == 0 && end_pos.row > node.start_position().row {
        end_pos.row
    } else {
        end_pos.row + 1
    };
    let end_line = raw_end_line.max(start_line);
    let body_for_hash = if !ctx.lines.is_empty() && start_line <= ctx.lines.len() {
        let s_idx = start_line - 1;
        let e_idx = end_line.min(ctx.lines.len()).max(s_idx);
        ctx.lines[s_idx..e_idx].join("\n")
    } else {
        norm_body
    };
    SymbolRecord {
        id: None,
        file_path: ctx.rel_path.to_string(),
        name,
        qualified_name,
        kind: kind.to_string(),
        sig_hash: hash_hex(&signature),
        body_hash: hash_hex(&body_for_hash),
        signature,
        start_line,
        end_line,
        exported,
        complexity: compute_complexity(node, ctx.source),
        docstring: preceding_doc_comment(start_line, ctx.lines),
    }
}

fn extract_rust_ast(node: Node<'_>, ctx: &mut AstExtractCtx<'_>, enclosing_impl: Option<&str>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        let is_pub = child
            .children(&mut child.walk())
            .any(|c| c.kind() == "visibility_modifier");

        match kind {
            "function_item" | "function_signature_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let (qname, sym_kind) = match enclosing_impl {
                        Some(owner) => (format!("{owner}::{name}"), "method"),
                        None => (name.clone(), "function"),
                    };
                    let sym = build_symbol(ctx, name, qname, sym_kind, child, is_pub);
                    ctx.out.symbols.push(sym);
                }
                if let Some(body) = child.child_by_field_name("body") {
                    extract_rust_inner_imports(body, ctx);
                }
            }
            "struct_item" | "enum_item" | "trait_item" | "type_item" | "const_item"
            | "static_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym_kind = match kind {
                        "struct_item" => "struct",
                        "enum_item" => "enum",
                        "trait_item" => "trait",
                        "type_item" => "type",
                        _ => "const",
                    };
                    let sym = build_symbol(ctx, name.clone(), name.clone(), sym_kind, child, is_pub);
                    ctx.out.symbols.push(sym);
                    if kind == "trait_item" {
                        if let Some(body) = child.child_by_field_name("body") {
                            extract_rust_ast(body, ctx, Some(&name));
                        }
                    }
                }
            }
            "macro_definition" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym = build_symbol(ctx, name.clone(), name, "macro", child, true);
                    ctx.out.symbols.push(sym);
                }
            }
            "impl_item" => {
                let type_name = child
                    .child_by_field_name("type")
                    .map(|t| {
                        let type_txt = node_text(t, ctx.source);
                        type_txt
                            .split('<')
                            .next()
                            .unwrap_or(type_txt)
                            .trim()
                            .to_string()
                    })
                    .unwrap_or_else(|| "Impl".to_string());
                if let Some(trait_node) = child.child_by_field_name("trait") {
                    let trait_raw = node_text(trait_node, ctx.source)
                        .split('<')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !trait_raw.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: trait_raw.clone(),
                            resolved_path: None,
                            kind: "implements".to_string(),
                            symbol_name: Some(trait_raw),
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }
                if let Some(body) = child.child_by_field_name("body") {
                    extract_rust_ast(body, ctx, Some(&type_name));
                }
            }
            "mod_item" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym = build_symbol(ctx, name.clone(), name.clone(), "module", child, is_pub);
                    ctx.out.symbols.push(sym);
                    if let Some(body) = child.child_by_field_name("body") {
                        extract_rust_ast(body, ctx, enclosing_impl);
                    } else {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: format!("mod::{name}"),
                            resolved_path: None,
                            kind: "import".to_string(),
                            symbol_name: Some(name),
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }
            }
            "use_declaration" => {
                record_rust_use_decl(child, is_pub, ctx);
            }
            "extern_crate_declaration" => {
                record_rust_extern_crate(child, is_pub, ctx);
            }
            _ => {}
        }
    }
}

fn extract_rust_inner_imports(node: Node<'_>, ctx: &mut AstExtractCtx<'_>) {
    let kind = node.kind();
    if kind == "use_declaration" {
        let is_pub = node
            .children(&mut node.walk())
            .any(|c| c.kind() == "visibility_modifier");
        record_rust_use_decl(node, is_pub, ctx);
        return;
    }
    if kind == "extern_crate_declaration" {
        let is_pub = node
            .children(&mut node.walk())
            .any(|c| c.kind() == "visibility_modifier");
        record_rust_extern_crate(node, is_pub, ctx);
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_rust_inner_imports(child, ctx);
    }
}

fn record_rust_use_decl(node: Node<'_>, is_pub: bool, ctx: &mut AstExtractCtx<'_>) {
    let mut cleaned = node_text(node, ctx.source).trim();
    if let Some(after_vis) = cleaned.strip_prefix("pub") {
        let rest = after_vis.trim_start();
        if let Some(after_paren) = rest.strip_prefix('(') {
            if let Some(close_idx) = after_paren.find(')') {
                cleaned = after_paren[close_idx + 1..].trim_start();
            }
        } else {
            cleaned = rest;
        }
    }
    let raw_use = cleaned
        .trim_start_matches("use")
        .trim()
        .trim_end_matches(';')
        .trim()
        .trim_start_matches("::")
        .to_string();
    if raw_use.is_empty() {
        return;
    }
    if raw_use.contains('*') {
        *ctx.has_wildcard = true;
    }
    parse_rust_use_symbols(&raw_use, ctx.imported_names);
    ctx.out.edges.push(EdgeRecord {
        from_path: ctx.rel_path.to_string(),
        raw_target: raw_use,
        resolved_path: None,
        kind: if is_pub { "export_from" } else { "import" }.to_string(),
        symbol_name: None,
        weight: 1.0,
        line: node.start_position().row + 1,
    });
}

fn record_rust_extern_crate(node: Node<'_>, is_pub: bool, ctx: &mut AstExtractCtx<'_>) {
    let decl_txt = node_text(node, ctx.source)
        .trim()
        .trim_start_matches("pub")
        .trim()
        .trim_start_matches("extern")
        .trim()
        .trim_start_matches("crate")
        .trim()
        .trim_end_matches(';')
        .trim();
    if decl_txt.is_empty() || decl_txt == "self" {
        return;
    }
    let (crate_name, alias_opt) = match decl_txt.split_once(" as ") {
        Some((c, a)) => (c.trim(), Some(a.trim())),
        None => (decl_txt, None),
    };
    if crate_name.is_empty() {
        return;
    }
    let imported_ident = alias_opt.unwrap_or(crate_name);
    if imported_ident != "_" && !imported_ident.is_empty() {
        ctx.imported_names.insert(imported_ident.to_string());
    }
    ctx.out.edges.push(EdgeRecord {
        from_path: ctx.rel_path.to_string(),
        raw_target: crate_name.to_string(),
        resolved_path: None,
        kind: if is_pub { "export_from" } else { "import" }.to_string(),
        symbol_name: None,
        weight: 1.0,
        line: node.start_position().row + 1,
    });
}

fn parse_rust_use_symbols(raw_use: &str, imported_names: &mut HashSet<String>) {
    if let Some(brace_start) = raw_use.find('{') {
        if let Some(brace_end) = raw_use.rfind('}') {
            let inner = &raw_use[brace_start + 1..brace_end];
            for item in inner.split(',') {
                let part = item.trim();
                if part.is_empty() || part == "self" || part == "*" {
                    continue;
                }
                let ident = if let Some((_, alias)) = part.split_once(" as ") {
                    alias.trim()
                } else {
                    part.rsplit("::").next().unwrap_or(part).trim()
                };
                if !ident.is_empty() {
                    imported_names.insert(ident.to_string());
                }
            }
            return;
        }
    }
    let last = if let Some((_, alias)) = raw_use.split_once(" as ") {
        alias.trim()
    } else {
        raw_use.rsplit("::").next().unwrap_or(raw_use).trim()
    };
    if !last.is_empty() && last != "*" && last != "self" {
        imported_names.insert(last.to_string());
    }
}

fn extract_ts_js_ast(
    node: Node<'_>,
    ctx: &mut AstExtractCtx<'_>,
    enclosing_class: Option<&str>,
    parent_exported: bool,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        match kind {
            "export_statement" => {
                if let Some(src_node) = child.child_by_field_name("source") {
                    let target = unquote(node_text(src_node, ctx.source));
                    if !target.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: target,
                            resolved_path: None,
                            kind: "export_from".to_string(),
                            symbol_name: None,
                            weight: 1.1,
                            line: child.start_position().row + 1,
                        });
                    }
                }
                extract_ts_js_ast(child, ctx, enclosing_class, true);
            }
            "import_statement" => {
                let stmt_txt = node_text(child, ctx.source);
                if stmt_txt.contains("* as ") {
                    *ctx.has_wildcard = true;
                }
                collect_ts_imported_identifiers(
                    child,
                    ctx.source,
                    ctx.decl_spans,
                    ctx.imported_names,
                );
                if let Some(src_node) = child.child_by_field_name("source") {
                    let target = unquote(node_text(src_node, ctx.source));
                    if !target.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: target,
                            resolved_path: None,
                            kind: "import".to_string(),
                            symbol_name: None,
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }
            }
            "function_declaration" | "generator_function_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym = build_symbol(ctx, name.clone(), name, "function", child, parent_exported);
                    ctx.out.symbols.push(sym);
                }
            }
            "class_declaration" | "abstract_class_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym = build_symbol(
                        ctx,
                        name.clone(),
                        name.clone(),
                        "class",
                        child,
                        parent_exported,
                    );
                    ctx.out.symbols.push(sym);
                    if let Some(body) = child.child_by_field_name("body") {
                        extract_ts_js_ast(body, ctx, Some(&name), parent_exported);
                    }
                }
            }
            "method_definition" | "abstract_method_signature" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let qname = match enclosing_class {
                        Some(cls) => format!("{cls}.{name}"),
                        None => name.clone(),
                    };
                    let sym = build_symbol(ctx, name, qname, "method", child, parent_exported);
                    ctx.out.symbols.push(sym);
                }
            }
            "interface_declaration" | "type_alias_declaration" | "enum_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym_kind = match kind {
                        "interface_declaration" => "interface",
                        "enum_declaration" => "enum",
                        _ => "type",
                    };
                    let sym =
                        build_symbol(ctx, name.clone(), name, sym_kind, child, parent_exported);
                    ctx.out.symbols.push(sym);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut dcursor = child.walk();
                for decl in child.children(&mut dcursor) {
                    if decl.kind() == "variable_declarator" {
                        if let Some(name_node) = decl.child_by_field_name("name") {
                            if name_node.kind() == "identifier" {
                                ctx.decl_spans
                                    .insert((name_node.start_byte(), name_node.end_byte()));
                                let name = node_text(name_node, ctx.source).to_string();
                                let val_kind = decl
                                    .child_by_field_name("value")
                                    .map(|v| v.kind())
                                    .unwrap_or("");
                                let sym_kind = if val_kind == "arrow_function"
                                    || val_kind == "function_expression"
                                {
                                    "function"
                                } else {
                                    "const"
                                };
                                if let Some(val_node) = decl.child_by_field_name("value") {
                                    extract_require_call(
                                        val_node,
                                        ctx.rel_path,
                                        ctx.source,
                                        ctx.out,
                                    );
                                }
                                let sym = build_symbol(
                                    ctx,
                                    name.clone(),
                                    name,
                                    sym_kind,
                                    child,
                                    parent_exported,
                                );
                                ctx.out.symbols.push(sym);
                            }
                        }
                    }
                }
            }
            "expression_statement" => {
                extract_require_call(child, ctx.rel_path, ctx.source, ctx.out);
            }
            _ => {}
        }
    }
}

fn collect_ts_imported_identifiers(
    node: Node<'_>,
    source: &str,
    decl_spans: &mut HashSet<(usize, usize)>,
    imported_names: &mut HashSet<String>,
) {
    let kind = node.kind();
    if kind == "import_specifier" {
        if let Some(alias) = node.child_by_field_name("alias") {
            decl_spans.insert((alias.start_byte(), alias.end_byte()));
            imported_names.insert(node_text(alias, source).to_string());
        } else if let Some(name) = node.child_by_field_name("name") {
            decl_spans.insert((name.start_byte(), name.end_byte()));
            imported_names.insert(node_text(name, source).to_string());
        }
        return;
    }
    if kind == "identifier" && node.parent().map(|p| p.kind()) == Some("import_clause") {
        decl_spans.insert((node.start_byte(), node.end_byte()));
        imported_names.insert(node_text(node, source).to_string());
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_ts_imported_identifiers(child, source, decl_spans, imported_names);
    }
}

fn extract_require_call(node: Node<'_>, rel_path: &str, source: &str, out: &mut ParsedFile) {
    if node.kind() == "call_expression" {
        if let Some(func) = node.child_by_field_name("function") {
            let fn_txt = node_text(func, source);
            if fn_txt == "require" || fn_txt == "import" {
                if let Some(args) = node.child_by_field_name("arguments") {
                    let mut ac = args.walk();
                    for arg in args.children(&mut ac) {
                        if arg.kind() == "string" {
                            let target = unquote(node_text(arg, source));
                            if !target.is_empty() {
                                out.edges.push(EdgeRecord {
                                    from_path: rel_path.to_string(),
                                    raw_target: target,
                                    resolved_path: None,
                                    kind: "import".to_string(),
                                    symbol_name: None,
                                    weight: 1.0,
                                    line: node.start_position().row + 1,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_require_call(child, rel_path, source, out);
    }
}

fn extract_python_ast(
    node: Node<'_>,
    ctx: &mut AstExtractCtx<'_>,
    enclosing_class: Option<&str>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        match kind {
            "decorated_definition" => {
                extract_python_ast(child, ctx, enclosing_class);
            }
            "function_definition" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let exported = !name.starts_with('_');
                    let (qname, sym_kind) = match enclosing_class {
                        Some(cls) => (format!("{cls}.{name}"), "method"),
                        None => (name.clone(), "function"),
                    };
                    let sym = build_symbol(ctx, name, qname, sym_kind, child, exported);
                    ctx.out.symbols.push(sym);
                }
            }
            "class_definition" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let exported = !name.starts_with('_');
                    let sym = build_symbol(ctx, name.clone(), name.clone(), "class", child, exported);
                    ctx.out.symbols.push(sym);
                    if let Some(body) = child.child_by_field_name("body") {
                        extract_python_ast(body, ctx, Some(&name));
                    }
                }
            }
            "import_statement" => {
                let imp_txt = node_text(child, ctx.source)
                    .trim_start_matches("import")
                    .trim()
                    .to_string();
                for part in imp_txt.split(',') {
                    let mod_name = part
                        .split(" as ")
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if let Some((_, alias)) = part.split_once(" as ") {
                        ctx.imported_names.insert(alias.trim().to_string());
                    } else if !mod_name.is_empty() {
                        ctx.imported_names.insert(
                            mod_name
                                .rsplit('.')
                                .next()
                                .unwrap_or(&mod_name)
                                .to_string(),
                        );
                    }
                    if !mod_name.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: mod_name,
                            resolved_path: None,
                            kind: "import".to_string(),
                            symbol_name: None,
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }
            }
            "import_from_statement" => {
                let imp_txt = node_text(child, ctx.source);
                if imp_txt.contains("import *") {
                    *ctx.has_wildcard = true;
                }
                if let Some(rest) = imp_txt.strip_prefix("from ") {
                    if let Some((mod_part, names_part)) = rest.split_once(" import ") {
                        let module = mod_part.trim().to_string();
                        for item in names_part.trim_matches(|c| c == '(' || c == ')').split(',') {
                            let sym = if let Some((_, alias)) = item.split_once(" as ") {
                                alias.trim()
                            } else {
                                item.trim()
                            };
                            if !sym.is_empty() && sym != "*" {
                                ctx.imported_names.insert(sym.to_string());
                            }
                        }
                        if !module.is_empty() {
                            ctx.out.edges.push(EdgeRecord {
                                from_path: ctx.rel_path.to_string(),
                                raw_target: module,
                                resolved_path: None,
                                kind: "import".to_string(),
                                symbol_name: None,
                                weight: 1.0,
                                line: child.start_position().row + 1,
                            });
                        }
                    }
                }
            }
            "expression_statement" if enclosing_class.is_none() => {
                let mut ec = child.walk();
                for sub in child.children(&mut ec) {
                    if sub.kind() == "assignment" {
                        if let Some(left) = sub.child_by_field_name("left") {
                            if left.kind() == "identifier" {
                                let name = node_text(left, ctx.source).to_string();
                                if name.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                                    ctx.decl_spans.insert((left.start_byte(), left.end_byte()));
                                    let sym =
                                        build_symbol(ctx, name.clone(), name, "const", child, true);
                                    ctx.out.symbols.push(sym);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn extract_go_ast(node: Node<'_>, ctx: &mut AstExtractCtx<'_>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let exported = name
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_uppercase())
                        .unwrap_or(false);
                    let sym = build_symbol(ctx, name.clone(), name, "function", child, exported);
                    ctx.out.symbols.push(sym);
                }
            }
            "method_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let recv = child
                        .child_by_field_name("receiver")
                        .map(|r| extract_go_receiver_type(node_text(r, ctx.source)))
                        .unwrap_or_else(|| "Receiver".to_string());
                    let exported = name
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_uppercase())
                        .unwrap_or(false);
                    let sym = build_symbol(
                        ctx,
                        name.clone(),
                        format!("{recv}.{name}"),
                        "method",
                        child,
                        exported,
                    );
                    ctx.out.symbols.push(sym);
                }
            }
            "type_declaration" => {
                let mut tc = child.walk();
                for spec in child.children(&mut tc) {
                    if spec.kind() == "type_spec" {
                        if let Some(name_node) = spec.child_by_field_name("name") {
                            ctx.decl_spans
                                .insert((name_node.start_byte(), name_node.end_byte()));
                            let name = node_text(name_node, ctx.source).to_string();
                            let exported = name
                                .chars()
                                .next()
                                .map(|c| c.is_ascii_uppercase())
                                .unwrap_or(false);
                            let sym_kind =
                                match spec.child_by_field_name("type").map(|t| t.kind()) {
                                    Some("struct_type") => "struct",
                                    Some("interface_type") => "interface",
                                    _ => "type",
                                };
                            let sym =
                                build_symbol(ctx, name.clone(), name, sym_kind, spec, exported);
                            ctx.out.symbols.push(sym);
                        }
                    }
                }
            }
            "import_declaration" => {
                collect_go_imports(
                    child,
                    ctx.rel_path,
                    ctx.source,
                    ctx.out,
                    ctx.imported_names,
                );
            }
            _ => {}
        }
    }
}

fn extract_go_receiver_type(raw_recv: &str) -> String {
    let trimmed = raw_recv.trim_matches(|c| c == '(' || c == ')').trim();
    let type_part = trimmed.split_whitespace().last().unwrap_or(trimmed);
    type_part
        .trim_start_matches('*')
        .split('[')
        .next()
        .unwrap_or("Receiver")
        .to_string()
}

fn collect_go_imports(
    node: Node<'_>,
    rel_path: &str,
    source: &str,
    out: &mut ParsedFile,
    imported_names: &mut HashSet<String>,
) {
    if node.kind() == "import_spec" {
        if let Some(path_node) = node.child_by_field_name("path") {
            let pkg_path = unquote(node_text(path_node, source));
            if let Some(name_node) = node.child_by_field_name("name") {
                imported_names.insert(node_text(name_node, source).to_string());
            } else if let Some(pkg) = pkg_path.rsplit('/').next() {
                imported_names.insert(pkg.to_string());
            }
            if !pkg_path.is_empty() {
                out.edges.push(EdgeRecord {
                    from_path: rel_path.to_string(),
                    raw_target: pkg_path,
                    resolved_path: None,
                    kind: "import".to_string(),
                    symbol_name: None,
                    weight: 1.0,
                    line: node.start_position().row + 1,
                });
            }
        }
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_go_imports(child, rel_path, source, out, imported_names);
    }
}

fn extract_bash_ast(node: Node<'_>, ctx: &mut AstExtractCtx<'_>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_definition" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let sym = build_symbol(ctx, name.clone(), name, "function", child, true);
                    ctx.out.symbols.push(sym);
                }
            }
            "command" => {
                if let Some(cmd_name) = child.child_by_field_name("name") {
                    let cmd_txt = node_text(cmd_name, ctx.source).trim();
                    if cmd_txt == "source" || cmd_txt == "." {
                        let full = node_text(child, ctx.source);
                        let arg = full
                            .split_whitespace()
                            .nth(1)
                            .map(unquote)
                            .unwrap_or_default();
                        if !arg.is_empty() {
                            ctx.out.edges.push(EdgeRecord {
                                from_path: ctx.rel_path.to_string(),
                                raw_target: arg,
                                resolved_path: None,
                                kind: "import".to_string(),
                                symbol_name: None,
                                weight: 1.0,
                                line: child.start_position().row + 1,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn extract_c_ast(node: Node<'_>, ctx: &mut AstExtractCtx<'_>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "preproc_if"
            | "preproc_ifdef"
            | "preproc_elif"
            | "preproc_else"
            | "declaration_list"
            | "linkage_specification" => {
                extract_c_ast(child, ctx);
            }
            "preproc_include" => {
                if let Some(path_node) = child.child_by_field_name("path") {
                    let raw_inc = node_text(path_node, ctx.source)
                        .trim()
                        .trim_matches(|c| c == '"' || c == '<' || c == '>')
                        .to_string();
                    if !raw_inc.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: raw_inc,
                            resolved_path: None,
                            kind: "import".to_string(),
                            symbol_name: None,
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }
            }
            "function_definition" => {
                let is_static = c_has_static_storage(child, ctx.source);
                if let Some(decl) = child.child_by_field_name("declarator") {
                    if let Some(ident_node) = find_c_function_ident(decl) {
                        ctx.decl_spans
                            .insert((ident_node.start_byte(), ident_node.end_byte()));
                        let name = node_text(ident_node, ctx.source).to_string();
                        let sym =
                            build_symbol(ctx, name.clone(), name, "function", child, !is_static);
                        ctx.out.symbols.push(sym);
                    }
                }
            }
            "declaration" => {
                let is_static = c_has_static_storage(child, ctx.source);
                if let Some(type_node) = child.child_by_field_name("type") {
                    extract_c_tag_specifier(type_node, child, ctx);
                }
                let mut dc = child.walk();
                for sub in child.children(&mut dc) {
                    if let Some(ident_node) = find_c_function_ident(sub) {
                        ctx.decl_spans
                            .insert((ident_node.start_byte(), ident_node.end_byte()));
                        let name = node_text(ident_node, ctx.source).to_string();
                        let sym =
                            build_symbol(ctx, name.clone(), name, "function", child, !is_static);
                        ctx.out.symbols.push(sym);
                    }
                }
            }
            "type_definition" => {
                if let Some(type_node) = child.child_by_field_name("type") {
                    extract_c_tag_specifier(type_node, child, ctx);
                }
                if let Some(decl) = child.child_by_field_name("declarator") {
                    if let Some(type_ident) = find_c_typedef_ident(decl) {
                        ctx.decl_spans
                            .insert((type_ident.start_byte(), type_ident.end_byte()));
                        let name = node_text(type_ident, ctx.source).to_string();
                        let already_same_tag = ctx
                            .out
                            .symbols
                            .last()
                            .map(|s| s.name == name && s.start_line == child.start_position().row + 1)
                            .unwrap_or(false);
                        if !already_same_tag {
                            let sym = build_symbol(ctx, name.clone(), name, "type", child, true);
                            ctx.out.symbols.push(sym);
                        }
                    }
                }
            }
            "struct_specifier" | "enum_specifier" | "union_specifier" => {
                extract_c_tag_specifier(child, child, ctx);
            }
            _ => {}
        }
    }
}

fn c_has_static_storage(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "storage_class_specifier" && node_text(child, source).trim() == "static"
        {
            return true;
        }
    }
    false
}

fn extract_c_tag_specifier(spec_node: Node<'_>, span_node: Node<'_>, ctx: &mut AstExtractCtx<'_>) {
    let sym_kind = match spec_node.kind() {
        "struct_specifier" | "union_specifier" => "struct",
        "enum_specifier" => "enum",
        _ => return,
    };
    if spec_node.child_by_field_name("body").is_none() {
        return;
    }
    if let Some(name_node) = spec_node.child_by_field_name("name") {
        ctx.decl_spans
            .insert((name_node.start_byte(), name_node.end_byte()));
        let name = node_text(name_node, ctx.source).to_string();
        let sym = build_symbol(ctx, name.clone(), name, sym_kind, span_node, true);
        ctx.out.symbols.push(sym);
    }
}

fn find_c_function_ident(node: Node<'_>) -> Option<Node<'_>> {
    match node.kind() {
        "function_declarator" => {
            let inner = node.child_by_field_name("declarator")?;
            unwrap_c_declarator_ident(inner)
        }
        "pointer_declarator" | "parenthesized_declarator" | "attributed_declarator" => {
            if let Some(inner) = node.child_by_field_name("declarator") {
                return find_c_function_ident(inner);
            }
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if let Some(found) = find_c_function_ident(child) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn unwrap_c_declarator_ident(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "identifier" || node.kind() == "field_identifier" {
        return Some(node);
    }
    if let Some(inner) = node.child_by_field_name("declarator") {
        return unwrap_c_declarator_ident(inner);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(found) = unwrap_c_declarator_ident(child) {
            return Some(found);
        }
    }
    None
}

fn find_c_typedef_ident(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "type_identifier" || node.kind() == "identifier" {
        return Some(node);
    }
    if let Some(inner) = node.child_by_field_name("declarator") {
        return find_c_typedef_ident(inner);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(found) = find_c_typedef_ident(child) {
            return Some(found);
        }
    }
    None
}

fn extract_java_ast(node: Node<'_>, ctx: &mut AstExtractCtx<'_>, scope: JavaScope<'_>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        match kind {
            "import_declaration" => {
                let imp_txt = node_text(child, ctx.source)
                    .trim()
                    .trim_start_matches("import")
                    .trim()
                    .trim_start_matches("static")
                    .trim()
                    .trim_end_matches(';')
                    .trim()
                    .to_string();
                if imp_txt.ends_with(".*") {
                    *ctx.has_wildcard = true;
                } else if let Some(short_name) = imp_txt.rsplit('.').next() {
                    if !short_name.is_empty() {
                        ctx.imported_names.insert(short_name.to_string());
                    }
                }
                if !imp_txt.is_empty() {
                    ctx.out.edges.push(EdgeRecord {
                        from_path: ctx.rel_path.to_string(),
                        raw_target: imp_txt,
                        resolved_path: None,
                        kind: "import".to_string(),
                        symbol_name: None,
                        weight: 1.0,
                        line: child.start_position().row + 1,
                    });
                }
            }
            "class_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration"
            | "annotation_type_declaration" => {
                let is_private = java_is_private(child, ctx.source);
                let class_prefix = java_extract_class_route_prefix(child, ctx.source)
                    .map(|p| join_http_route_paths(scope.route_prefix, &p))
                    .unwrap_or_else(|| scope.route_prefix.to_string());

                if let Some(super_node) = child.child_by_field_name("superclass") {
                    let sup_txt = node_text(super_node, ctx.source)
                        .trim_start_matches("extends")
                        .split('<')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !sup_txt.is_empty() {
                        ctx.out.edges.push(EdgeRecord {
                            from_path: ctx.rel_path.to_string(),
                            raw_target: sup_txt.clone(),
                            resolved_path: None,
                            kind: "extends".to_string(),
                            symbol_name: Some(sup_txt),
                            weight: 1.0,
                            line: child.start_position().row + 1,
                        });
                    }
                }

                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let qname = match scope.enclosing_class {
                        Some(outer) => format!("{outer}.{name}"),
                        None => name.clone(),
                    };
                    let sym_kind = match kind {
                        "interface_declaration" | "annotation_type_declaration" => "interface",
                        "enum_declaration" => "enum",
                        _ => "class",
                    };
                    let sym =
                        build_symbol(ctx, name.clone(), qname.clone(), sym_kind, child, !is_private);
                    ctx.out.symbols.push(sym);

                    if let Some(body) = child.child_by_field_name("body") {
                        extract_java_ast(
                            body,
                            ctx,
                            JavaScope {
                                enclosing_class: Some(&qname),
                                route_prefix: &class_prefix,
                            },
                        );
                    }
                }
            }
            "enum_body_declarations" => {
                extract_java_ast(child, ctx, scope);
            }
            "method_declaration" | "constructor_declaration" | "compact_constructor_declaration" => {
                let is_private = java_is_private(child, ctx.source);
                if let Some(name_node) = child.child_by_field_name("name") {
                    ctx.decl_spans
                        .insert((name_node.start_byte(), name_node.end_byte()));
                    let name = node_text(name_node, ctx.source).to_string();
                    let qname = match scope.enclosing_class {
                        Some(cls) => format!("{cls}.{name}"),
                        None => name.clone(),
                    };
                    java_extract_method_routes(
                        child,
                        ctx.rel_path,
                        ctx.source,
                        scope.route_prefix,
                        &qname,
                        &mut ctx.out.routes,
                    );
                    let sym = build_symbol(ctx, name, qname, "method", child, !is_private);
                    ctx.out.symbols.push(sym);
                }
            }
            _ => {}
        }
    }
}

fn java_is_private(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let txt = node_text(child, source);
            return txt
                .split_whitespace()
                .any(|tok| tok == "private");
        }
    }
    false
}

fn java_extract_class_route_prefix(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mc = child.walk();
            for ann in child.children(&mut mc) {
                if matches!(ann.kind(), "annotation" | "marker_annotation") {
                    let ann_name = ann
                        .child_by_field_name("name")
                        .map(|n| node_text(n, source))
                        .unwrap_or("")
                        .rsplit('.')
                        .next()
                        .unwrap_or("");
                    if ann_name == "RequestMapping" || ann_name == "Path" {
                        if let Some(p) = first_string_literal_in_node(ann, source) {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

fn java_extract_method_routes(
    method_node: Node<'_>,
    rel_path: &str,
    source: &str,
    class_prefix: &str,
    handler_qname: &str,
    routes_out: &mut Vec<RouteRecord>,
) {
    let mut jaxrs_verb: Option<(String, usize)> = None;
    let mut jaxrs_path: Option<String> = None;

    let mut cursor = method_node.walk();
    for child in method_node.children(&mut cursor) {
        if child.kind() != "modifiers" {
            continue;
        }
        let mut mc = child.walk();
        for ann in child.children(&mut mc) {
            if !matches!(ann.kind(), "annotation" | "marker_annotation") {
                continue;
            }
            let ann_name = ann
                .child_by_field_name("name")
                .map(|n| node_text(n, source))
                .unwrap_or("")
                .rsplit('.')
                .next()
                .unwrap_or("");
            let line = ann.start_position().row + 1;
            let spring_verb = match ann_name {
                "GetMapping" => Some("GET"),
                "PostMapping" => Some("POST"),
                "PutMapping" => Some("PUT"),
                "PatchMapping" => Some("PATCH"),
                "DeleteMapping" => Some("DELETE"),
                "RequestMapping" => {
                    let full_ann = node_text(ann, source);
                    if full_ann.contains("POST") {
                        Some("POST")
                    } else if full_ann.contains("PUT") {
                        Some("PUT")
                    } else if full_ann.contains("DELETE") {
                        Some("DELETE")
                    } else if full_ann.contains("PATCH") {
                        Some("PATCH")
                    } else {
                        Some("GET")
                    }
                }
                _ => None,
            };

            if let Some(verb) = spring_verb {
                let sub_path = first_string_literal_in_node(ann, source).unwrap_or_default();
                let full_route = join_http_route_paths(class_prefix, &sub_path);
                routes_out.push(RouteRecord {
                    file_path: rel_path.to_string(),
                    direction: "expose".to_string(),
                    method: verb.to_string(),
                    route_path: full_route,
                    handler_name: Some(handler_qname.to_string()),
                    line,
                });
            } else if matches!(ann_name, "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
                jaxrs_verb = Some((ann_name.to_string(), line));
            } else if ann_name == "Path" {
                jaxrs_path = first_string_literal_in_node(ann, source);
            }
        }
    }

    if let Some((verb, line)) = jaxrs_verb {
        let sub = jaxrs_path.unwrap_or_default();
        let full_route = join_http_route_paths(class_prefix, &sub);
        routes_out.push(RouteRecord {
            file_path: rel_path.to_string(),
            direction: "expose".to_string(),
            method: verb,
            route_path: full_route,
            handler_name: Some(handler_qname.to_string()),
            line,
        });
    }
}

fn first_string_literal_in_node(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() == "string_literal" {
        return Some(unquote(node_text(node, source)));
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(found) = first_string_literal_in_node(child, source) {
            return Some(found);
        }
    }
    None
}

fn join_http_route_paths(prefix: &str, sub: &str) -> String {
    let p = prefix.trim().trim_end_matches('/');
    let s = sub.trim().trim_start_matches('/');
    match (p.is_empty(), s.is_empty()) {
        (true, true) => "/".to_string(),
        (false, true) => {
            if p.starts_with('/') {
                p.to_string()
            } else {
                format!("/{p}")
            }
        }
        (true, false) => format!("/{s}"),
        (false, false) => {
            if p.starts_with('/') {
                format!("{p}/{s}")
            } else {
                format!("/{p}/{s}")
            }
        }
    }
}

fn extract_json_ast(node: Node<'_>, rel_path: &str, source: &str, out: &mut ParsedFile) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "object" {
            let mut oc = child.walk();
            for pair in child.children(&mut oc) {
                if pair.kind() == "pair" {
                    if let Some(key_node) = pair.child_by_field_name("key") {
                        let key = unquote(node_text(key_node, source));
                        if !key.is_empty() {
                            let start_line = pair.start_position().row + 1;
                            let end_line = (pair.end_position().row + 1).max(start_line);
                            let pair_txt = node_text(pair, source);
                            let sig = format!("\"{key}\"");
                            out.symbols.push(SymbolRecord {
                                id: None,
                                file_path: rel_path.to_string(),
                                name: key.clone(),
                                qualified_name: key,
                                kind: "property".to_string(),
                                sig_hash: hash_hex(&sig),
                                body_hash: hash_hex(pair_txt),
                                signature: sig,
                                start_line,
                                end_line,
                                exported: true,
                                complexity: 1,
                                docstring: None,
                            });
                        }
                    }
                }
            }
        }
    }
}

fn unquote(raw_str: &str) -> String {
    raw_str
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string()
}

fn noise_identifiers() -> &'static HashSet<&'static str> {
    static NOISE: OnceLock<HashSet<&'static str>> = OnceLock::new();
    NOISE.get_or_init(|| {
        [
            "self", "Self", "super", "crate", "this", "true", "false", "null", "undefined", "None",
            "Some", "Ok", "Err", "String", "str", "usize", "isize", "u8", "u16", "u32", "u64",
            "i8", "i16", "i32", "i64", "f32", "f64", "bool", "Vec", "Option", "Result", "Box",
            "Arc", "Rc", "int", "float", "double", "long", "short", "char", "string", "number",
            "boolean", "void", "any", "unknown", "never", "object", "console", "fmt", "err", "ctx",
            "req", "res", "System", "Override",
        ]
        .into_iter()
        .collect()
    })
}

fn collect_identifier_references(
    node: Node<'_>,
    ctx: &RefWalkCtx<'_>,
    refs_out: &mut Vec<ReferenceRecord>,
) {
    let kind = node.kind();
    if is_literal_or_comment_kind(kind)
        || matches!(
            kind,
            "import_statement"
                | "import_declaration"
                | "package_declaration"
                | "use_declaration"
                | "extern_crate_declaration"
                | "preproc_include"
        )
    {
        return;
    }
    if matches!(
        kind,
        "identifier" | "type_identifier" | "property_identifier" | "field_identifier"
    ) {
        let span = (node.start_byte(), node.end_byte());
        if !ctx.decl_spans.contains(&span) {
            let ident = node_text(node, ctx.source);
            if ident.len() >= 2 && !ctx.noise.contains(ident) {
                let line = node.start_position().row + 1;
                let col = node.start_position().column + 1;
                let enclosing = find_enclosing_symbol(ctx.symbols, line);
                let confidence = if ctx.same_file_names.contains(ident) {
                    RefConfidence::SameFile
                } else if ctx.imported_names.contains(ident) || ctx.has_wildcard {
                    RefConfidence::Imported
                } else {
                    RefConfidence::NameOnly
                } ;
                let context_line = ctx
                    .lines
                    .get(line.saturating_sub(1))
                    .map(|l| l.trim().chars().take(160).collect());
                refs_out.push(ReferenceRecord {
                    file_path: ctx.rel_path.to_string(),
                    symbol_name: ident.to_string(),
                    line,
                    col,
                    in_symbol: enclosing,
                    confidence,
                    context_line,
                });
            }
        }
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_identifier_references(child, ctx, refs_out);
    }
}

fn find_enclosing_symbol(symbols: &[SymbolRecord], line: usize) -> Option<String> {
    symbols
        .iter()
        .filter(|s| line >= s.start_line && line <= s.end_line)
        .min_by_key(|s| s.end_line.saturating_sub(s.start_line))
        .map(|s| s.qualified_name.clone())
}

struct RoutePatterns {
    express: Regex,
    axum: Regex,
    attr: Regex,
    fetch_call: Regex,
    http_client: Regex,
}

fn route_patterns() -> &'static RoutePatterns {
    static PATS: OnceLock<RoutePatterns> = OnceLock::new();
    PATS.get_or_init(|| {
        let express = Regex::new(
            r#"(?i)\b(?:app|router|server|fastify|r|mux)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`](/[^'"`\s]*)['"`](?:\s*,\s*([A-Za-z0-9_.:]+))?"#,
        )
        .unwrap_or_else(|_| unreachable!());
        let axum = Regex::new(
            r#"\.route\s*\(\s*"(/[^"\s]*)"\s*,\s*(get|post|put|patch|delete|any)\s*\(\s*([A-Za-z0-9_:]+)"#,
        )
        .unwrap_or_else(|_| unreachable!());
        let attr = Regex::new(
            r#"(?:#\[|@(?:app|router)\.)(get|post|put|patch|delete)\s*\(\s*['"](/[^'"\s]*)['"]"#,
        )
        .unwrap_or_else(|_| unreachable!());
        let fetch_call =
            Regex::new(r#"\bfetch\s*\(\s*['"`]((?:https?://[^'"`/]+)?/[^'"`\s]*)['"`]"#)
                .unwrap_or_else(|_| unreachable!());
        let http_client = Regex::new(
            r#"\b(?:axios|http|client|requests|httpx)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]((?:https?://[^'"`/]+)?/[^'"`\s]*)['"`]"#,
        )
        .unwrap_or_else(|_| unreachable!());
        RoutePatterns {
            express,
            axum,
            attr,
            fetch_call,
            http_client,
        }
    })
}

fn normalize_route_url(raw_url: &str) -> String {
    if let Some(after_scheme) = raw_url
        .strip_prefix("http://")
        .or_else(|| raw_url.strip_prefix("https://"))
    {
        if let Some(slash_idx) = after_scheme.find('/') {
            return after_scheme[slash_idx..].to_string();
        }
    }
    raw_url.to_string()
}

fn extract_http_routes_lexical(
    rel_path: &str,
    _source: &str,
    lines: &[&str],
    routes: &mut Vec<RouteRecord>,
) {
    let pats = route_patterns();
    for (idx, line_str) in lines.iter().enumerate() {
        let line_no = idx + 1;
        for cap in pats.express.captures_iter(line_str) {
            let method = cap
                .get(1)
                .map(|m| m.as_str().to_ascii_uppercase())
                .unwrap_or_default();
            let path = cap
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let handler = cap.get(3).map(|m| m.as_str().to_string());
            routes.push(RouteRecord {
                file_path: rel_path.to_string(),
                direction: "expose".to_string(),
                method,
                route_path: path,
                handler_name: handler,
                line: line_no,
            });
        }
        for cap in pats.axum.captures_iter(line_str) {
            let path = cap
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let method = cap
                .get(2)
                .map(|m| m.as_str().to_ascii_uppercase())
                .unwrap_or_default();
            let handler = cap.get(3).map(|m| m.as_str().to_string());
            routes.push(RouteRecord {
                file_path: rel_path.to_string(),
                direction: "expose".to_string(),
                method,
                route_path: path,
                handler_name: handler,
                line: line_no,
            });
        }
        for cap in pats.attr.captures_iter(line_str) {
            let method = cap
                .get(1)
                .map(|m| m.as_str().to_ascii_uppercase())
                .unwrap_or_default();
            let path = cap
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let next_handler = lines.get(idx + 1).and_then(|nl| {
                nl.trim()
                    .strip_prefix("pub async fn ")
                    .or_else(|| nl.trim().strip_prefix("async fn "))
                    .or_else(|| nl.trim().strip_prefix("pub fn "))
                    .or_else(|| nl.trim().strip_prefix("fn "))
                    .or_else(|| nl.trim().strip_prefix("async def "))
                    .or_else(|| nl.trim().strip_prefix("def "))
                    .and_then(|rest| rest.split('(').next())
                    .map(|s| s.trim().to_string())
            });
            routes.push(RouteRecord {
                file_path: rel_path.to_string(),
                direction: "expose".to_string(),
                method,
                route_path: path,
                handler_name: next_handler,
                line: line_no,
            });
        }
        for cap in pats.fetch_call.captures_iter(line_str) {
            let path = cap
                .get(1)
                .map(|m| normalize_route_url(m.as_str()))
                .unwrap_or_default();
            let method = if line_str.contains("POST") {
                "POST"
            } else if line_str.contains("DELETE") {
                "DELETE"
            } else if line_str.contains("PUT") {
                "PUT"
            } else {
                "GET"
            };
            routes.push(RouteRecord {
                file_path: rel_path.to_string(),
                direction: "consume".to_string(),
                method: method.to_string(),
                route_path: path,
                handler_name: None,
                line: line_no,
            });
        }
        for cap in pats.http_client.captures_iter(line_str) {
            let method = cap
                .get(1)
                .map(|m| m.as_str().to_ascii_uppercase())
                .unwrap_or_default();
            let path = cap
                .get(2)
                .map(|m| normalize_route_url(m.as_str()))
                .unwrap_or_default();
            routes.push(RouteRecord {
                file_path: rel_path.to_string(),
                direction: "consume".to_string(),
                method,
                route_path: path,
                handler_name: None,
                line: line_no,
            });
        }
    }
}

fn extract_sql_lexical(rel_path: &str, lines: &[&str], out: &mut ParsedFile) {
    static CREATE_RE: OnceLock<Regex> = OnceLock::new();
    static REF_RE: OnceLock<Regex> = OnceLock::new();
    let create_re = CREATE_RE.get_or_init(|| {
        Regex::new(
            r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_.\x22`]+)",
        )
        .unwrap_or_else(|_| unreachable!())
    });
    let ref_re = REF_RE.get_or_init(|| {
        Regex::new(r"(?i)\bREFERENCES\s+([A-Za-z0-9_.\x22`]+)")
            .unwrap_or_else(|_| unreachable!())
    });

    for (idx, &line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        if let Some(cap) = create_re.captures(line) {
            let kind_raw = cap
                .get(1)
                .map(|m| m.as_str().to_ascii_lowercase())
                .unwrap_or_else(|| "table".to_string());
            let name = cap
                .get(2)
                .map(|m| m.as_str().trim_matches(|c| c == '"' || c == '`').to_string())
                .unwrap_or_default();
            let mut end_line = line_no;
            while end_line < lines.len() && !lines[end_line - 1].contains(';') {
                end_line += 1;
            }
            let body = lines[line_no - 1..end_line].join("\n");
            let sig = line.trim().to_string();
            out.symbols.push(SymbolRecord {
                id: None,
                file_path: rel_path.to_string(),
                name: name.clone(),
                qualified_name: name,
                kind: kind_raw,
                sig_hash: hash_hex(&sig),
                body_hash: hash_hex(&body),
                signature: sig,
                start_line: line_no,
                end_line,
                exported: true,
                complexity: 1,
                docstring: None,
            });
        }
        for cap in ref_re.captures_iter(line) {
            let target_tbl = cap
                .get(1)
                .map(|m| m.as_str().trim_matches(|c| c == '"' || c == '`').to_string())
                .unwrap_or_default();
            if !target_tbl.is_empty() {
                out.edges.push(EdgeRecord {
                    from_path: rel_path.to_string(),
                    raw_target: target_tbl.clone(),
                    resolved_path: None,
                    kind: "sql_ref".to_string(),
                    symbol_name: Some(target_tbl),
                    weight: 0.8,
                    line: line_no,
                });
            }
        }
    }
}

fn extract_markdown_lexical(rel_path: &str, lines: &[&str], out: &mut ParsedFile) {
    static LINK_RE: OnceLock<Regex> = OnceLock::new();
    let link_re = LINK_RE
        .get_or_init(|| Regex::new(r"\[[^\]]+\]\(([^)#\s]+)\)").unwrap_or_else(|_| unreachable!()));

    let mut heading_indices: Vec<(usize, String, String)> = Vec::new();
    let mut in_fence = false;
    for (idx, &line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|&c| c == '#').count();
            if (1..=3).contains(&hashes) {
                let title = trimmed[hashes..].trim().to_string();
                if !title.is_empty() {
                    heading_indices.push((idx + 1, title, trimmed.to_string()));
                }
            }
        }
        for cap in link_re.captures_iter(line) {
            let href = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            if !href.is_empty()
                && !href.starts_with("http://")
                && !href.starts_with("https://")
                && !href.starts_with("mailto:")
            {
                out.edges.push(EdgeRecord {
                    from_path: rel_path.to_string(),
                    raw_target: href.to_string(),
                    resolved_path: None,
                    kind: "doc_link".to_string(),
                    symbol_name: None,
                    weight: 0.6,
                    line: idx + 1,
                });
            }
        }
    }

    for i in 0..heading_indices.len() {
        let (start_line, ref title, ref sig) = heading_indices[i];
        let end_line = if i + 1 < heading_indices.len() {
            heading_indices[i + 1].0.saturating_sub(1).max(start_line)
        } else {
            lines.len().max(start_line)
        };
        let body = lines[start_line - 1..end_line.min(lines.len())].join("\n");
        out.symbols.push(SymbolRecord {
            id: None,
            file_path: rel_path.to_string(),
            name: title.clone(),
            qualified_name: title.clone(),
            kind: "section".to_string(),
            sig_hash: hash_hex(sig),
            body_hash: hash_hex(&body),
            signature: sig.clone(),
            start_line,
            end_line,
            exported: true,
            complexity: 1,
            docstring: None,
        });
    }
}

fn extract_yaml_lexical(rel_path: &str, lines: &[&str], out: &mut ParsedFile) {
    let mut keys: Vec<(usize, String, String)> = Vec::new();
    for (idx, &line) in lines.iter().enumerate() {
        if line.starts_with(' ') || line.starts_with('\t') || line.trim().starts_with('#') {
            continue;
        }
        if let Some((k, _)) = line.split_once(':') {
            let key = unquote(k);
            if !key.is_empty() && !key.starts_with('-') {
                keys.push((idx + 1, key, line.trim().to_string()));
            }
        }
    }
    for i in 0..keys.len() {
        let (start_line, ref key, ref sig) = keys[i];
        let end_line = if i + 1 < keys.len() {
            keys[i + 1].0.saturating_sub(1).max(start_line)
        } else {
            lines.len().max(start_line)
        };
        let body = lines[start_line - 1..end_line.min(lines.len())].join("\n");
        out.symbols.push(SymbolRecord {
            id: None,
            file_path: rel_path.to_string(),
            name: key.clone(),
            qualified_name: key.clone(),
            kind: "property".to_string(),
            sig_hash: hash_hex(sig),
            body_hash: hash_hex(&body),
            signature: sig.clone(),
            start_line,
            end_line,
            exported: true,
            complexity: 1,
            docstring: None,
        });
    }
}

fn extract_toml_lexical(rel_path: &str, lines: &[&str], out: &mut ParsedFile) {
    let mut sections: Vec<(usize, String, String)> = Vec::new();
    for (idx, &line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let sec = trimmed
                .trim_matches(|c| c == '[' || c == ']')
                .trim()
                .to_string();
            if !sec.is_empty() {
                sections.push((idx + 1, sec, trimmed.to_string()));
            }
        } else if sections.is_empty() {
            if let Some((k, _)) = trimmed.split_once('=') {
                let key = unquote(k);
                if !key.is_empty() {
                    sections.push((idx + 1, key, trimmed.to_string()));
                }
            }
        }
    }
    for i in 0..sections.len() {
        let (start_line, ref name, ref sig) = sections[i];
        let end_line = if i + 1 < sections.len() {
            sections[i + 1].0.saturating_sub(1).max(start_line)
        } else {
            lines.len().max(start_line)
        };
        let body = lines[start_line - 1..end_line.min(lines.len())].join("\n");
        out.symbols.push(SymbolRecord {
            id: None,
            file_path: rel_path.to_string(),
            name: name.clone(),
            qualified_name: name.clone(),
            kind: "section".to_string(),
            sig_hash: hash_hex(sig),
            body_hash: hash_hex(&body),
            signature: sig.clone(),
            start_line,
            end_line,
            exported: true,
            complexity: 1,
            docstring: None,
        });
    }
}

fn extract_cpp_lexical(rel_path: &str, lines: &[&str], out: &mut ParsedFile) {
    static INCLUDE_RE: OnceLock<Regex> = OnceLock::new();
    static TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static FN_RE: OnceLock<Regex> = OnceLock::new();

    let include_re = INCLUDE_RE.get_or_init(|| {
        Regex::new(r#"^\s*#include\s*[<"]([^>"]+)[>"]"#).unwrap_or_else(|_| unreachable!())
    });
    let type_re = TYPE_RE.get_or_init(|| {
        Regex::new(r"^\s*(?:template\s*<[^>]*>\s*)?(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .unwrap_or_else(|_| unreachable!())
    });
    let fn_re = FN_RE.get_or_init(|| {
        Regex::new(
            r"^\s*(?:(?:static|virtual|inline|extern|constexpr|const)\s+)*[A-Za-z_][A-Za-z0-9_<>,:*&\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?",
        )
        .unwrap_or_else(|_| unreachable!())
    });

    let mut current_class: Option<String> = None;
    for (idx, &line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        if let Some(cap) = include_re.captures(line) {
            if let Some(inc) = cap.get(1) {
                out.edges.push(EdgeRecord {
                    from_path: rel_path.to_string(),
                    raw_target: inc.as_str().to_string(),
                    resolved_path: None,
                    kind: "import".to_string(),
                    symbol_name: None,
                    weight: 1.0,
                    line: line_no,
                });
            }
            continue;
        }
        if let Some(cap) = type_re.captures(line) {
            let kind_str = cap.get(1).map(|m| m.as_str()).unwrap_or("class");
            let name = cap
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let end_line = find_matching_brace_end(lines, idx);
            let body = lines[idx..end_line].join("\n");
            let sig = clean_signature(line);
            current_class = Some(name.clone());
            out.symbols.push(SymbolRecord {
                id: None,
                file_path: rel_path.to_string(),
                name: name.clone(),
                qualified_name: name,
                kind: kind_str.to_string(),
                sig_hash: hash_hex(&sig),
                body_hash: hash_hex(&body),
                signature: sig,
                start_line: line_no,
                end_line,
                exported: true,
                complexity: 1,
                docstring: None,
            });
            continue;
        }
        if let Some(cap) = fn_re.captures(line) {
            let name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            if !matches!(name, "if" | "for" | "while" | "switch" | "catch" | "return") {
                let end_line = find_matching_brace_end(lines, idx);
                let body = lines[idx..end_line].join("\n");
                let sig = clean_signature(line);
                let (qname, kind_str) = match &current_class {
                    Some(cls) => (format!("{cls}.{name}"), "method"),
                    None => (name.to_string(), "function"),
                };
                out.symbols.push(SymbolRecord {
                    id: None,
                    file_path: rel_path.to_string(),
                    name: name.to_string(),
                    qualified_name: qname,
                    kind: kind_str.to_string(),
                    sig_hash: hash_hex(&sig),
                    body_hash: hash_hex(&body),
                    signature: sig,
                    start_line: line_no,
                    end_line,
                    exported: !line.contains("private:"),
                    complexity: 1,
                    docstring: None,
                });
            }
        }
    }
}

fn find_matching_brace_end(lines: &[&str], start_idx: usize) -> usize {
    let mut depth = 0i32;
    let mut opened = false;
    for (offset, &l) in lines[start_idx..].iter().enumerate() {
        for ch in l.chars() {
            if ch == '{' {
                depth += 1;
                opened = true;
            } else if ch == '}' {
                depth -= 1;
                if opened && depth <= 0 {
                    return start_idx + offset + 1;
                }
            }
        }
        if !opened && l.trim_end().ends_with(';') {
            return start_idx + offset + 1;
        }
    }
    (start_idx + 1).min(lines.len())
}

struct SlopMatchers {
    comment_marker_re: Regex,
    ts_suppress_re: Regex,
    rust_stub_macros: HashMap<String, &'static str>,
}

fn slop_matchers() -> &'static SlopMatchers {
    static MATCHERS: OnceLock<SlopMatchers> = OnceLock::new();
    MATCHERS.get_or_init(|| {
        let m1 = ["TO", "DO"].concat();
        let m2 = ["FIX", "ME"].concat();
        let m3 = ["HA", "CK"].concat();
        let m4 = ["X", "XX"].concat();
        let comment_pat = format!(r"\b(?:{m1}|{m2}|{m3}|{m4})(?:\b|:|\()");
        let comment_marker_re = Regex::new(&comment_pat).unwrap_or_else(|_| unreachable!());

        let s1 = ["@ts-", "ignore"].concat();
        let s2 = ["@ts-", "nocheck"].concat();
        let ts_pat = format!(r"(?:{s1}|{s2})");
        let ts_suppress_re = Regex::new(&ts_pat).unwrap_or_else(|_| unreachable!());

        let mut rust_stub_macros = HashMap::new();
        rust_stub_macros.insert(["to", "do"].concat(), "unfinished stub macro");
        rust_stub_macros.insert(["unimple", "mented"].concat(), "unimplemented stub macro");

        SlopMatchers {
            comment_marker_re,
            ts_suppress_re,
            rust_stub_macros,
        }
    })
}

fn scan_slop_ast(
    node: Node<'_>,
    rel_path: &str,
    grammar: TsGrammar,
    source: &str,
    lines: &[&str],
    findings: &mut Vec<SlopFinding>,
) {
    let m = slop_matchers();
    let kind = node.kind();
    let line = node.start_position().row + 1;
    let col = node.start_position().column + 1;
    let line_snippet = || {
        lines
            .get(line.saturating_sub(1))
            .map(|s| s.trim().chars().take(140).collect::<String>())
            .unwrap_or_default()
    };

    if matches!(kind, "comment" | "line_comment" | "block_comment") {
        let txt = node_text(node, source);
        if m.ts_suppress_re.is_match(txt) {
            findings.push(SlopFinding {
                file_path: rel_path.to_string(),
                line,
                col,
                kind: "ts_ignore".to_string(),
                severity: "error".to_string(),
                snippet: line_snippet(),
                message: "TypeScript compiler suppression directive is forbidden".to_string(),
            });
        }
        if m.comment_marker_re.is_match(txt) {
            findings.push(SlopFinding {
                file_path: rel_path.to_string(),
                line,
                col,
                kind: "unfinished_marker".to_string(),
                severity: "warning".to_string(),
                snippet: line_snippet(),
                message: "Unfinished work comment marker detected".to_string(),
            });
        }
        return;
    }

    if kind == "catch_clause" {
        if let Some(body) = node.child_by_field_name("body") {
            let mut bc = body.walk();
            let has_statements = body.children(&mut bc).any(|c| {
                c.is_named() && !matches!(c.kind(), "comment" | "line_comment" | "block_comment")
            });
            if !has_statements {
                findings.push(SlopFinding {
                    file_path: rel_path.to_string(),
                    line,
                    col,
                    kind: "empty_catch".to_string(),
                    severity: "error".to_string(),
                    snippet: line_snippet(),
                    message: "Empty catch block silently swallows runtime errors".to_string(),
                });
            }
        }
    }

    if kind == "except_clause" && grammar == TsGrammar::Python {
        let mut ec = node.walk();
        let mut only_pass = false;
        for child in node.children(&mut ec) {
            if child.kind() == "block" {
                let mut bc = child.walk();
                let named: Vec<_> = child
                    .children(&mut bc)
                    .filter(|c| c.is_named() && c.kind() != "comment")
                    .collect();
                if named.len() == 1 && named[0].kind() == "pass_statement" {
                    only_pass = true;
                }
            }
        }
        if only_pass {
            findings.push(SlopFinding {
                file_path: rel_path.to_string(),
                line,
                col,
                kind: "empty_catch".to_string(),
                severity: "error".to_string(),
                snippet: line_snippet(),
                message: "Bare 'except: pass' block silently swallows exceptions".to_string(),
            });
        }
    }

    if matches!(grammar, TsGrammar::TypeScript | TsGrammar::Tsx)
        && !rel_path.ends_with(".d.ts")
        && kind == "predefined_type"
        && node_text(node, source) == "any"
    {
        findings.push(SlopFinding {
            file_path: rel_path.to_string(),
            line,
            col,
            kind: "explicit_any".to_string(),
            severity: "warning".to_string(),
            snippet: line_snippet(),
            message: "Explicit 'any' type weakens static type safety".to_string(),
        });
    }

    if grammar == TsGrammar::Rust && kind == "macro_invocation" {
        if let Some(mac) = node.child_by_field_name("macro") {
            let mac_name = node_text(mac, source).rsplit("::").next().unwrap_or("");
            if let Some(desc) = m.rust_stub_macros.get(mac_name) {
                findings.push(SlopFinding {
                    file_path: rel_path.to_string(),
                    line,
                    col,
                    kind: "panic_stub".to_string(),
                    severity: "error".to_string(),
                    snippet: line_snippet(),
                    message: format!("Rust {desc} detected in source"),
                });
            } else if mac_name == ["pan", "ic"].concat() {
                let full_mac = node_text(node, source).to_ascii_lowercase();
                let stub_phrase = ["not ", "implemented"].concat();
                if full_mac.contains(&stub_phrase) || full_mac.contains("stub") {
                    findings.push(SlopFinding {
                        file_path: rel_path.to_string(),
                        line,
                        col,
                        kind: "panic_stub".to_string(),
                        severity: "error".to_string(),
                        snippet: line_snippet(),
                        message: "Placeholder panic stub detected".to_string(),
                    });
                }
            }
        }
    }

    if grammar == TsGrammar::Python && kind == "raise_statement" {
        let txt = node_text(node, source);
        let py_stub = ["NotImple", "mentedError"].concat();
        if txt.contains(&py_stub) {
            findings.push(SlopFinding {
                file_path: rel_path.to_string(),
                line,
                col,
                kind: "panic_stub".to_string(),
                severity: "error".to_string(),
                snippet: line_snippet(),
                message: "Python NotImplementedError stub detected".to_string(),
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        scan_slop_ast(child, rel_path, grammar, source, lines, findings);
    }
}

fn scan_slop_lexical(
    rel_path: &str,
    _ext: &str,
    lines: &[&str],
    findings: &mut Vec<SlopFinding>,
) {
    let m = slop_matchers();
    static EMPTY_CATCH_RE: OnceLock<Regex> = OnceLock::new();
    let empty_catch_re = EMPTY_CATCH_RE.get_or_init(|| {
        Regex::new(r"\bcatch\s*\([^)]*\)\s*\{\s*\}").unwrap_or_else(|_| unreachable!())
    });

    for (idx, &line_str) in lines.iter().enumerate() {
        let line = idx + 1;
        if empty_catch_re.is_match(line_str) {
            findings.push(SlopFinding {
                file_path: rel_path.to_string(),
                line,
                col: 1,
                kind: "empty_catch".to_string(),
                severity: "error".to_string(),
                snippet: line_str.trim().chars().take(140).collect(),
                message: "Empty catch block silently swallows runtime errors".to_string(),
            });
        }
        if let Some(comment_idx) = line_str.find("//").or_else(|| line_str.find("/*")) {
            let comment_part = &line_str[comment_idx..];
            if m.ts_suppress_re.is_match(comment_part) {
                findings.push(SlopFinding {
                    file_path: rel_path.to_string(),
                    line,
                    col: comment_idx + 1,
                    kind: "ts_ignore".to_string(),
                    severity: "error".to_string(),
                    snippet: line_str.trim().chars().take(140).collect(),
                    message: "Compiler suppression directive is forbidden".to_string(),
                });
            }
            if m.comment_marker_re.is_match(comment_part) {
                findings.push(SlopFinding {
                    file_path: rel_path.to_string(),
                    line,
                    col: comment_idx + 1,
                    kind: "unfinished_marker".to_string(),
                    severity: "warning".to_string(),
                    snippet: line_str.trim().chars().take(140).collect(),
                    message: "Unfinished work comment marker detected".to_string(),
                });
            }
        }
    }
}
