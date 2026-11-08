# Kaxcav-Vortex Benchmark Harness

A reproducible, dependency-light benchmark harness measuring `kaxcav-vortex` against compiler-verified Ground Truth (TypeScript 5.9.3 Language Service) and a naive whole-file baseline (`git grep` + read entire file).

---

## How to Run

From the repository root (`C:\MULTI-KAXCAV\kaxcav-vortex`):

```bash
# 1. Run unit and integration tests
node --test --experimental-strip-types --no-warnings bench/bench.test.ts

# 2. Quick benchmark against kvx repository
node --experimental-strip-types --no-warnings bench/run.ts --repo kvx --quick

# 3. Quick benchmark against zod repository (if cloned in bench/.cache/repos/zod)
node --experimental-strip-types --no-warnings bench/run.ts --repo zod --quick

# Full benchmark run across all tools and repos
node --experimental-strip-types --no-warnings bench/run.ts --repo all
```

Options:
- `--repo kvx|zod|all`: target repository to benchmark (configured in `bench/repos.json`).
- `--tools kvx,baseline,kvx-mcp`: comma-separated list of adapters to run (default: `kvx,baseline,kvx-mcp`).
- `--quick`: use smaller deterministic sample sizes for rapid validation.

If the `zod` repository directory (`bench/.cache/repos/zod`) is not present on disk, clone it with:
```bash
git clone https://github.com/colinhacks/zod.git bench/.cache/repos/zod && git -C bench/.cache/repos/zod checkout 19c40d2072288b4cafec851e9d056a72a88e5973
```

---

## Benchmark Tasks

### T1: File Outline
- **Goal**: Measures how accurately and concisely symbols are outlined per file.
- **Metric**: Recall against module-level declarations and class members extracted by TypeScript AST (matching by declaration `name` and `|startLine diff| <= 1`).
- **Cost**: Estimated token cost of the outline response.

### T2: Read Symbol
- **Goal**: Measures symbol slicing precision and token savings compared to full-file reads.
- **Metric**: Exact range match rate (`startLine` and `endLine` identical to ground truth) and within-1-line match rate.
- **Cost**: Sliced symbol tokens vs reading the entire file.

### T3: Find References
- **Goal**: Evaluates symbol usage resolution across the codebase.
- **Metric**: Precision, Recall, and F1 score over `file:line` sets:
  - (a) All returned references.
  - (b) High-confidence references (excluding `confidence === 'name_only'`).
  - Baseline `git grep -n -w <name>` (excluding the declaration line).
- **Cost**: Token cost of the references response.

### T4: Importers (Blast Radius)
- **Goal**: Evaluates reverse dependency analysis.
- **Metric**: Precision, Recall, and F1 of transitive importers (BFS depth $\le$ 5) against the ground-truth module resolution graph.
- **Baseline**: Not supported (`n/a`).

### T5: Schema Cost
- **Goal**: Evaluates context overhead introduced by MCP tools declaration schemas.
- **Metric**: Characters of `tools/list` response divided by 4 for the full server, read-only server, and competitors.

---

## How Ground Truth is Computed

Ground truth is computed dynamically using the official TypeScript Compiler API (`bench/node_modules/typescript`):

1. **`ts.LanguageService`**: An in-memory language service is created over the repository's source files with `Bundler` module resolution, `ES2022` target, and `allowImportingTsExtensions: true`.
2. **Declarations**: AST traversal identifies module-level functions, classes, interfaces, type aliases, enums, variable declarators, and class members (methods, properties, getters/setters). `startLine` starts at the node's first non-trivia token (including decorators and `export`), skipping leading JSDoc comments.
3. **References**: `languageService.findReferences` is called at the exact declaration name token position. The definition entry itself is excluded, and results are deduplicated by `file:line`.
4. **Importers**: `ts.preProcessFile` identifies module specifiers, which are resolved using `ts.resolveModuleName`. A reverse import graph is constructed, and transitive importers are found via BFS up to depth 5.

---

## Competitors Configuration (`bench/competitors.json`)

The harness includes a generic MCP stdio client (`bench/adapters/mcp-stdio.ts`) that spawns any MCP-compatible binary and communicates over newline-delimited JSON-RPC on stdin/stdout.

To add or enable a competitor in `bench/competitors.json`:

```json
{
  "name": "serena",
  "enabled": true,
  "command": "serena",
  "args": ["serve"],
  "tools": {
    "outline": { "tool": "get_symbols_overview", "args": { "repo": "{repo}", "file": "{file}" } },
    "readSymbol": { "tool": "find_symbol", "args": { "name": "{symbol}" } },
    "references": { "tool": "find_referencing_symbols", "args": { "name": "{symbol}" } }
  }
}
```

Placeholders available for arguments:
- `{repo}`: Absolute path to the repository under test.
- `{file}`: Relative path to the file.
- `{absFile}`: Absolute path to the file.
- `{symbol}`: Qualified symbol name (`Class.method` or module symbol).
- `{name}`: Base symbol name without qualifiers.

*Note*: Verify the tool names and argument schema against the competitor's `tools/list` output before enabling.

### Built-in competitor adapters (`bench/adapters/competitors.ts`)

Each response format is different, so the main competitors have dedicated adapters that build
their own index first and call their own tools for each task:

| `--tools` name | Install (not done by the harness) | Index step | Outline / read symbol / references |
|---|---|---|---|
| `serena` | `uv tool install -p 3.13 serena-agent` | lazy (language server) | `get_symbols_overview` (names only, no lines) / `find_symbol` / `find_referencing_symbols` |
| `jcodemunch` | `uv tool install jcodemunch-mcp` | `order(index_folder)` | `get_file_outline` / `get_symbol_source` / `check_references` (via `order`) |
| `codebase-memory` | official `install.ps1 --skip-config` | `index_repository` | `get_file_outline` / `get_code_snippet` / Cypher `query_graph` (no references tool) |
| `symforge` | `npm i -g symforge` | `index_folder` | `get_file_context` (full outline) / `get_symbol` / `find_references` |
| `gitnexus` | `npm i -g gitnexus` | `gitnexus analyze --index-only` | n/a / `context` / n/a (callers without lines) |

Rules: a task a tool does not offer is reported as n/a; any other error counts as an empty
(wrong) answer; every tool is started with its working directory inside the benchmarked repo,
so their index folders never land in this checkout. Benchmark a disposable copy of a repo
(see `kvx-snap` in `repos.json`: a `git archive` of this repo made its own git repo), because
several tools write index folders into the repo they analyze. Executables are looked up where
their installers put them on Windows; override with `BENCH_<NAME>_CMD`.

Some of these tools are licensed for non-commercial use only: check each license before
running or publishing a comparison.

---

## Limitations

1. **Token Cost Approximation**: Token counts are approximated as `Math.ceil(chars / 4)`. Real BPE/tiktoken counts may differ by 5-15% depending on whitespace and punctuation.
2. **Ground Truth Scope**: Ground truth is currently implemented for TypeScript and TSX files using the TypeScript Compiler API. Other languages (Go, Python, SQL) are indexed by `kaxcav-vortex` but are not yet evaluated in this harness.
3. **Naive Baseline**: The baseline uses `git grep -n -w`, which is purely lexical and lacks semantic understanding of variable scopes or imports.
