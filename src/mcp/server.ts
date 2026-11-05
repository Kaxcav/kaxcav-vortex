import { createInterface } from 'node:readline'
import { KaxcavVortexEngine, KAXCAV_VORTEX_VERSION } from '../engine.ts'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export class VortexMcpServer {
  private readonly engine: KaxcavVortexEngine
  private readonly writeLine: (line: string) => void

  constructor(
    engine = new KaxcavVortexEngine(),
    writeLine: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  ) {
    this.engine = engine
    this.writeLine = writeLine
  }

  startStdio(): void {
    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    })

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('Content-Length:')) return
      try {
        const msg = JSON.parse(trimmed) as JsonRpcRequest
        this.handleRequest(msg)
      } catch {
        // Ignore non-JSON framing lines
      }
    })
  }

  public handleRequest(req: JsonRpcRequest): Record<string, unknown> | null {
    const { id, method, params = {} } = req

    try {
      switch (method) {
        case 'initialize': {
          return this.respond(id, {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: 'kaxcav-vortex',
              version: KAXCAV_VORTEX_VERSION,
            },
            capabilities: {
              tools: {},
            },
          })
        }

        case 'notifications/initialized':
          return null

        case 'tools/list': {
          return this.respond(id, {
            tools: [
              {
                name: 'context',
                description:
                  'Build a surgical, token-budgeted context pack (L0-L3 fidelity + PPR-HD graph ranking + ETag delta deduplication).',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string', description: 'Absolute repository path' },
                    task: { type: 'string', description: 'Task or question description' },
                    budget: { type: 'number', description: 'Token budget (default 2000)' },
                    fidelity: {
                      type: 'string',
                      enum: ['full', 'graded', 'compact'],
                      description: 'Slice fidelity mode',
                    },
                    if_none_match: { type: 'string', description: 'Previous pack ETag' },
                    delta_from: { type: 'string', description: 'Prior pack ETag for delta mode' },
                  },
                  required: ['repo', 'task'],
                },
              },
              {
                name: 'search',
                description: 'Hybrid BM25F + AST symbol search in a repository shard.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    query: { type: 'string' },
                    limit: { type: 'number' },
                  },
                  required: ['query'],
                },
              },
              {
                name: 'search_symbols',
                description: 'Polyglot symbol and document search tool across repository shards.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    query: { type: 'string' },
                    corpus: { type: 'string' },
                    path: { type: 'string' },
                    limit: { type: 'number' },
                  },
                  required: ['query'],
                },
              },
              {
                name: 'affected',
                description: 'Compute affected test files for modified source files.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    files: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['repo', 'files'],
                },
              },
              {
                name: 'blast_radius',
                description:
                  'Compute direct callers, transitive impact files, affected tests, and cross-repo impacts.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    target: { type: 'string' },
                  },
                  required: ['repo', 'target'],
                },
              },
              {
                name: 'index_health',
                description: 'Return shard health, memory usage, and token savings telemetry.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                  },
                },
              },
              {
                name: 'file_outline',
                description:
                  'Return the complete structural symbol skeleton of a file in ~40 tokens without reading the full file body.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    file: { type: 'string' },
                  },
                  required: ['file'],
                },
              },
              {
                name: 'read_symbol',
                description:
                  'Read the exact source slice and signature of a single symbol/function/method without loading the entire file.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    symbol: { type: 'string' },
                  },
                  required: ['symbol'],
                },
              },
              {
                name: 'call_graph',
                description: 'Return direct callers and callees of a symbol.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    symbol: { type: 'string' },
                  },
                  required: ['symbol'],
                },
              },
              {
                name: 'diff_impact',
                description:
                  'Analyze recently modified files, detect breaking signature/contract drift, and list affected callers and tests.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    repo: { type: 'string' },
                    window_minutes: { type: 'number' },
                  },
                },
              },
            ],
          })
        }

        case 'tools/call': {
          const toolName = String(params.name ?? '')
          const args = (params.arguments ?? {}) as Record<string, unknown>
          return this.handleToolCall(id, toolName, args)
        }

        default:
          return this.respondError(id, -32601, `Method not found: ${method}`)
      }
    } catch (err) {
      return this.respondError(id, -32603, err instanceof Error ? err.message : String(err))
    }
  }

  private handleToolCall(
    id: string | number | null | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (name) {
      case 'context': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const task = String(args.task ?? '')
        const budget = Number(args.budget ?? args.token_budget ?? 2000)
        const fidelity = (args.fidelity as 'full' | 'graded' | 'compact') ?? 'graded'
        const pack = this.engine.context({
          repositoryPath: repo,
          task,
          tokenBudget: budget,
          fidelity,
          ifNoneMatch: args.if_none_match ? String(args.if_none_match) : undefined,
          deltaFrom: args.delta_from ? String(args.delta_from) : undefined,
        })
        return this.respond(id, {
          content: [{ type: 'text', text: pack.markdown }],
          meta: {
            etag: pack.etag,
            tokens: pack.tokenCount,
            tokensSaved: pack.tokensSaved,
            elapsedMs: pack.elapsedMs,
          },
        })
      }

      case 'search':
      case 'search_symbols': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const query = String(args.query ?? '')
        const limit = Number(args.limit ?? 15)
        const hits = this.engine.search(repo, query, limit)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify({ results: hits, total: hits.length }, null, 2) }],
          structuredContent: { results: hits, total: hits.length },
        })
      }

      case 'affected': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const files = Array.isArray(args.files) ? args.files.map(String) : []
        const tests = this.engine.affected(repo, files)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify({ tests }, null, 2) }],
        })
      }

      case 'blast_radius': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const target = String(args.target ?? '')
        const report = this.engine.blastRadius(repo, target)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        })
      }

      case 'index_health': {
        const repos = args.repo ? [String(args.repo)] : undefined
        const status = this.engine.status(repos)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        })
      }

      case 'file_outline': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const file = String(args.file ?? args.path ?? '')
        const outline = this.engine.fileOutline(repo, file)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(outline, null, 2) }],
        })
      }

      case 'read_symbol': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const symbol = String(args.symbol ?? args.name ?? '')
        const matches = this.engine.readSymbol(repo, symbol)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }],
        })
      }

      case 'call_graph': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const symbol = String(args.symbol ?? args.name ?? '')
        const cg = this.engine.callGraph(repo, symbol)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(cg, null, 2) }],
        })
      }

      case 'diff_impact': {
        const repo = String(args.repo ?? args.index ?? process.cwd())
        const mins = Number(args.window_minutes ?? 60)
        const impact = this.engine.diffImpact(repo, mins)
        return this.respond(id, {
          content: [{ type: 'text', text: JSON.stringify(impact, null, 2) }],
        })
      }

      default:
        return this.respondError(id, -32602, `Unknown tool: ${name}`)
    }
  }

  private respond(
    id: string | number | null | undefined,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload = { jsonrpc: '2.0', id: id ?? null, result }
    if (id !== undefined) {
      this.writeLine(JSON.stringify(payload))
    }
    return payload
  }

  private respondError(
    id: string | number | null | undefined,
    code: number,
    message: string,
  ): Record<string, unknown> {
    const payload = { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
    if (id !== undefined) {
      this.writeLine(JSON.stringify(payload))
    }
    return payload
  }
}
