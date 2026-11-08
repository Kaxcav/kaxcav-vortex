import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { KaxcavVortexEngine, KAXCAV_VORTEX_VERSION } from '../engine.ts'
import { KvxIgnoreError } from '../core/kvxignore.ts'
import type { OutlineScope } from '../storage/shard.ts'
import type { SymbolEditOp } from '../edit/symbol-editor.ts'

/** Booleans from MCP clients may arrive as strings: only true/"true"/1 count. */
const flag = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRecord = Record<string, unknown>

interface ToolDef {
  name: string
  description: string
  inputSchema: JsonRecord
  /** K8 — part of the read-only server: reads only the indexed repository code. */
  readOnly?: boolean
}

const str = { type: 'string' }
const num = { type: 'number' }

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'context',
    readOnly: true,
    description:
      'Build a surgical, token-budgeted context pack (L0-L3 fidelity + PPR-HD graph ranking + ETag delta deduplication).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Absolute repository path' },
        task: { type: 'string', description: 'Task or question description' },
        budget: { type: 'number', description: 'Token budget (default 2000)' },
        fidelity: { type: 'string', enum: ['full', 'graded', 'compact'] },
        path: str,
        corpus: str,
        if_none_match: str,
        delta_from: str,
      },
      required: ['repo', 'task'],
    },
  },
  {
    name: 'search',
    readOnly: true,
    description:
      'Hybrid BM25F + AST symbol search. `path` accepts absolute or repo-relative paths. Never answers a bare empty list: returns `via` (indice | busca_textual | nenhum), the reason, and text-search hits when the index has none. Local symbols only appear for an exact-name query.',
    inputSchema: { type: 'object', properties: { repo: str, query: str, path: str, corpus: str, limit: num }, required: ['query'] },
  },
  {
    name: 'search_symbols',
    readOnly: true,
    description: 'Same as `search` (polyglot symbol and document search), with explicit reason and text fallback.',
    inputSchema: { type: 'object', properties: { repo: str, query: str, corpus: str, path: str, limit: num }, required: ['query'] },
  },
  {
    name: 'affected',
    readOnly: true,
    description: 'Compute affected test files for modified source files.',
    inputSchema: { type: 'object', properties: { repo: str, files: { type: 'array', items: str } }, required: ['repo', 'files'] },
  },
  {
    name: 'blast_radius',
    readOnly: true,
    description: 'Compute direct callers, transitive impact files, affected tests, and cross-repo impacts.',
    inputSchema: { type: 'object', properties: { repo: str, target: str }, required: ['repo', 'target'] },
  },
  {
    name: 'index_health',
    readOnly: true,
    description:
      'Shard health (files, symbols, DB and WAL size, index age per file), memory and token savings. With `file`, returns that file\'s index age and whether the disk copy is newer.',
    inputSchema: { type: 'object', properties: { repo: str, file: str } },
  },
  {
    name: 'file_outline',
    readOnly: true,
    description:
      'Structural skeleton of a file with real line ranges (from the declaration\'s closing token). `escopo`: topo (default: module declarations + class members, no locals), exportado, tudo. Absolute or relative path. If the file is not indexed, returns `found:false` with the reason and similar files.',
    inputSchema: {
      type: 'object',
      properties: { repo: str, file: str, escopo: { type: 'string', enum: ['topo', 'exportado', 'tudo'] } },
      required: ['file'],
    },
  },
  {
    name: 'read_symbol',
    readOnly: true,
    description:
      'Exact source slice of a symbol. Accepts `name`, `Class.method`, `path#name`; optional `path` narrows the file. Class methods, getters and fields are indexed. When nothing matches, returns the reason, similar names and text-search occurrences.',
    inputSchema: { type: 'object', properties: { repo: str, symbol: str, path: str }, required: ['symbol'] },
  },
  {
    name: 'repo_map',
    readOnly: true,
    description:
      'Orientation map with no query: code files ranked by dependency PageRank (what the rest of the code depends on comes first), each with its exported signatures, within `budget` tokens (default 1500). `focus` (files) personalizes the ranking around them; `path` limits to a folder; tests are left out unless `include_tests`.',
    inputSchema: {
      type: 'object',
      properties: { repo: str, budget: num, focus: { type: 'array', items: str }, path: str, include_tests: { type: 'boolean' } },
    },
  },
  {
    name: 'find_references',
    readOnly: true,
    description:
      'Every usage of ONE symbol (definition excluded): file, line, column, kind (call | member_call | member | import | jsx | other), enclosing symbol and the line text. Confidence: same_file, imported (the file imports the target), name_only (same name, no import link). Ambiguous names return candidates: use `path#Name`. `include_name_only:false` keeps only linked usages.',
    inputSchema: {
      type: 'object',
      properties: { repo: str, symbol: str, path: str, limit: num, include_name_only: { type: 'boolean' } },
      required: ['symbol'],
    },
  },
  {
    name: 'call_graph',
    readOnly: true,
    description: 'Return direct callers and callees of a symbol.',
    inputSchema: { type: 'object', properties: { repo: str, symbol: str }, required: ['symbol'] },
  },
  {
    name: 'diff_impact',
    readOnly: true,
    description:
      'Recently modified files, breaking contract drift of EXPORTED symbols (no locals, no tests) changed in the window, affected callers and tests.',
    inputSchema: { type: 'object', properties: { repo: str, window_minutes: num } },
  },
  {
    name: 'edit_symbol',
    description:
      "Edits ONE symbol by whole lines: op replace | insert_before | insert_after | delete. Use `path#Class.method` when the name is ambiguous (the refusal lists the candidates). Pass `expected_hash` (the `hash` from read_symbol) to refuse if the symbol changed since you read it. Refuses .kvxignore'd files, edits that would break symbol locks (kvx or Fábrica) and, with tree-sitter installed, edits that add syntax errors. Writes atomically, keeps BOM/line endings and reindexes the file; `dry_run` previews without writing. Not available on the read-only server.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: str,
        symbol: str,
        path: str,
        op: { type: 'string', enum: ['replace', 'insert_before', 'insert_after', 'delete'] },
        text: { type: 'string', description: 'Whole lines (with their indentation). Not used by delete.' },
        expected_hash: str,
        dry_run: { type: 'boolean' },
        allow_syntax_errors: { type: 'boolean' },
      },
      required: ['symbol', 'op'],
    },
  },
  {
    name: 'nexus_ingest_vault',
    description:
      'Zero-Data-Loss ingestion of a directory or Google Drive mirror (.xlsx, .docx, .pdf, .zip, AppsScript .json, .csv, .sql, .md) with DLP secret redaction and authority conflict detection. Paths blocked by .kvxignore are refused.',
    inputSchema: { type: 'object', properties: { name: str, source_dir: str, tenant_slug: str }, required: ['name', 'source_dir'] },
  },
  {
    name: 'nexus_query_sheet',
    description: 'Query spreadsheet tabs, columns, formulas, validations, and tabular rows extracted by Drive Nexus.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: str, sheet_title: str, column_filter: str, limit: num },
      required: ['workspace_id'],
    },
  },
  {
    name: 'nexus_audit_dlp',
    description: 'Return forensic DLP secret/credential redactions and Authority Conflict Radar for a Drive Nexus workspace.',
    inputSchema: { type: 'object', properties: { workspace_id: str }, required: ['workspace_id'] },
  },
]

export const READ_ONLY_TOOL_NAMES: readonly string[] = TOOL_DEFS.filter((t) => t.readOnly).map((t) => t.name)

export interface McpServerOptions {
  /** K8 — expose only the read-only code tools (server name `kaxcav-vortex-ro`, no nexus_*). */
  readOnly?: boolean
}

export class VortexMcpServer {
  private readonly engine: KaxcavVortexEngine
  private readonly writeLine: (line: string) => void
  private readonly readOnly: boolean

  constructor(
    engine = new KaxcavVortexEngine(),
    writeLine: (line: string) => void = (line) => process.stdout.write(line + '\n'),
    options: McpServerOptions = {},
  ) {
    this.engine = engine
    this.writeLine = writeLine
    this.readOnly = Boolean(options.readOnly)
  }

  startStdio(): void {
    const rl = createInterface({ input: process.stdin, terminal: false })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('Content-Length:')) return
      let msg: JsonRpcRequest
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest
      } catch {
        return // non-JSON framing line
      }
      this.handleRequest(msg)
    })
  }

  public handleRequest(req: JsonRpcRequest): JsonRecord | null {
    const { id, method, params = {} } = req
    try {
      switch (method) {
        case 'initialize':
          return this.respond(id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: this.readOnly ? 'kaxcav-vortex-ro' : 'kaxcav-vortex', version: KAXCAV_VORTEX_VERSION },
            capabilities: { tools: {} },
          })
        case 'notifications/initialized':
          return null
        case 'tools/list':
          return this.respond(id, {
            tools: TOOL_DEFS.filter((t) => !this.readOnly || t.readOnly).map(({ readOnly: _ro, ...t }) => t),
          })
        case 'tools/call': {
          const toolName = String(params.name ?? '')
          const args = (params.arguments ?? {}) as JsonRecord
          if (this.readOnly && !READ_ONLY_TOOL_NAMES.includes(toolName)) {
            return this.respondError(id, -32602, `Ferramenta '${toolName}' não está disponível no servidor só de leitura`)
          }
          return this.handleToolCall(id, toolName, args)
        }
        default:
          return this.respondError(id, -32601, `Method not found: ${method}`)
      }
    } catch (err) {
      if (err instanceof KvxIgnoreError) {
        return this.respond(id, { content: [{ type: 'text', text: `Recusado: ${err.message}` }], isError: true })
      }
      return this.respondError(id, -32603, err instanceof Error ? err.message : String(err))
    }
  }

  private text(id: string | number | null | undefined, payload: unknown, extra: JsonRecord = {}): JsonRecord {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    return this.respond(id, { content: [{ type: 'text', text }], ...extra })
  }

  private repoArg(args: JsonRecord): string {
    return String(args.repo ?? args.index ?? process.cwd())
  }

  private handleToolCall(id: string | number | null | undefined, name: string, args: JsonRecord): JsonRecord {
    switch (name) {
      case 'context': {
        const repo = this.repoArg(args)
        if (args.path) {
          const p = String(args.path)
          this.engine.assertPathAllowed(/^(?:[A-Za-z]:[\\/]|\/)/.test(p) ? p : resolve(repo, p))
        }
        const pack = this.engine.context({
          repositoryPath: repo,
          task: String(args.task ?? ''),
          tokenBudget: Number(args.budget ?? args.token_budget ?? 2000),
          fidelity: (args.fidelity as 'full' | 'graded' | 'compact') ?? 'graded',
          path: args.path ? String(args.path) : undefined,
          corpus: args.corpus ? String(args.corpus) : undefined,
          ifNoneMatch: args.if_none_match ? String(args.if_none_match) : undefined,
          deltaFrom: args.delta_from ? String(args.delta_from) : undefined,
        })
        return this.respond(id, {
          content: [{ type: 'text', text: pack.markdown }],
          meta: { etag: pack.etag, tokens: pack.tokenCount, tokensSaved: pack.tokensSaved, elapsedMs: pack.elapsedMs },
        })
      }
      case 'search':
      case 'search_symbols': {
        const res = this.engine.searchDetailed(this.repoArg(args), String(args.query ?? ''), {
          limit: Number(args.limit ?? 15),
          path: args.path ? String(args.path) : undefined,
          corpus: args.corpus ? String(args.corpus) : undefined,
        })
        return this.text(id, res, { structuredContent: res })
      }
      case 'affected': {
        const files = Array.isArray(args.files) ? args.files.map(String) : []
        return this.text(id, { tests: this.engine.affected(this.repoArg(args), files) })
      }
      case 'blast_radius':
        return this.text(id, this.engine.blastRadius(this.repoArg(args), String(args.target ?? '')))
      case 'index_health':
        if (args.file) return this.text(id, this.engine.fileIndexAge(this.repoArg(args), String(args.file)))
        return this.text(id, this.engine.status(args.repo ? [String(args.repo)] : undefined))
      case 'file_outline': {
        const scope = (args.escopo ?? args.scope) as OutlineScope | undefined
        return this.text(id, this.engine.fileOutline(this.repoArg(args), String(args.file ?? args.path ?? ''), { scope }))
      }
      case 'read_symbol': {
        const res = this.engine.readSymbolDetailed(this.repoArg(args), String(args.symbol ?? args.name ?? ''), {
          path: args.path ? String(args.path) : undefined,
        })
        return this.text(id, res.matches.length > 0 ? res.matches : res)
      }
      case 'repo_map': {
        const res = this.engine.repoMap(this.repoArg(args), {
          budget: args.budget ? Number(args.budget) : undefined,
          focus: Array.isArray(args.focus) ? args.focus.map(String) : undefined,
          path: args.path ? String(args.path) : undefined,
          includeTests: flag(args.include_tests),
        })
        if (!res.ok) return this.text(id, res, { isError: true })
        return this.respond(id, {
          content: [{ type: 'text', text: res.markdown || res.reason || '' }],
          meta: { tokens: res.tokens, files: res.files.length, omittedFiles: res.omittedFiles },
        })
      }
      case 'find_references': {
        const res = this.engine.findReferences(this.repoArg(args), String(args.symbol ?? args.name ?? ''), {
          path: args.path ? String(args.path) : undefined,
          limit: args.limit ? Number(args.limit) : undefined,
          includeNameOnly: args.include_name_only === undefined ? undefined : flag(args.include_name_only),
        })
        return this.text(id, res, res.ok ? {} : { isError: true })
      }
      case 'call_graph':
        return this.text(id, this.engine.callGraph(this.repoArg(args), String(args.symbol ?? args.name ?? '')))
      case 'diff_impact':
        return this.text(id, this.engine.diffImpact(this.repoArg(args), Number(args.window_minutes ?? 60)))
      case 'edit_symbol': {
        const res = this.engine.editSymbol(this.repoArg(args), {
          symbol: String(args.symbol ?? args.name ?? ''),
          path: args.path ? String(args.path) : undefined,
          op: String(args.op ?? '') as SymbolEditOp,
          text: typeof args.text === 'string' ? args.text : undefined,
          expectedHash: args.expected_hash ? String(args.expected_hash) : undefined,
          dryRun: flag(args.dry_run),
          allowSyntaxErrors: flag(args.allow_syntax_errors),
        })
        return this.text(id, res, res.ok ? {} : { isError: true })
      }
      case 'nexus_ingest_vault': {
        const sourceDir = resolve(String(args.source_dir ?? process.cwd()))
        this.engine.assertPathAllowed(sourceDir)
        return this.text(
          id,
          this.engine.nexus.ingestDirectory({
            name: String(args.name ?? 'Enterprise Drive Vault'),
            sourceDir,
            tenantSlug: args.tenant_slug ? String(args.tenant_slug) : undefined,
          }),
        )
      }
      case 'nexus_query_sheet':
        return this.text(
          id,
          this.engine.nexus.querySheetRows({
            workspaceId: String(args.workspace_id ?? ''),
            sheetTitle: args.sheet_title ? String(args.sheet_title) : undefined,
            columnFilter: args.column_filter ? String(args.column_filter) : undefined,
            limit: args.limit ? Number(args.limit) : 50,
          }),
        )
      case 'nexus_audit_dlp': {
        const workspaceId = String(args.workspace_id ?? '')
        return this.text(id, {
          dlpFindings: this.engine.nexus.listDlpFindings(workspaceId),
          authorityConflicts: this.engine.nexus.listAuthorityConflicts(workspaceId),
        })
      }
      default:
        return this.respondError(id, -32602, `Unknown tool: ${name}`)
    }
  }

  private respond(id: string | number | null | undefined, result: JsonRecord): JsonRecord {
    const payload = { jsonrpc: '2.0', id: id ?? null, result }
    if (id !== undefined) this.writeLine(JSON.stringify(payload))
    return payload
  }

  private respondError(id: string | number | null | undefined, code: number, message: string): JsonRecord {
    const payload = { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
    if (id !== undefined) this.writeLine(JSON.stringify(payload))
    return payload
  }
}
