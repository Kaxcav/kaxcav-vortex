import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ContextFidelity } from '../core/types.ts'
import { DriveAppServer } from '../drive-app/server.ts'
import { KaxcavVortexEngine, KAXCAV_VORTEX_VERSION } from '../engine.ts'
import { VortexMcpServer } from '../mcp/server.ts'
import { initTreeSitter } from '../parser/treesitter.ts'
import { VortexDashboardServer } from '../ui/server.ts'

function parseFlags(argv: string[]): {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
} {
  const command = argv[0] ?? 'status'
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  let afterDoubleDash = false

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (afterDoubleDash) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

async function runBenchmark(engine: KaxcavVortexEngine): Promise<void> {
  const configuredRepos = engine.loadConfiguredRepos()
  const genericBenchmarks: Record<string, unknown> = {}

  for (const repoDir of configuredRepos) {
    if (!existsSync(repoDir)) continue
    const t0 = performance.now()
    const shard = engine.getOrOpenShard(repoDir)
    const syncStats = shard.sync(true)
    const pack = engine.context({
      repositoryPath: repoDir,
      task: 'architecture core engine router service',
      tokenBudget: 1800,
      fidelity: 'graded',
    })
    const packCached = engine.context({
      repositoryPath: repoDir,
      task: 'architecture core engine router service',
      tokenBudget: 1800,
      fidelity: 'graded',
      ifNoneMatch: pack.etag,
    })
    genericBenchmarks[repoDir] = {
      filesIndexed: syncStats.totalFiles,
      indexSyncMs: syncStats.elapsedMs,
      contextLatencyMs: pack.elapsedMs,
      etagCacheHitLatencyMs: packCached.elapsedMs,
      tokensUsed: pack.tokenCount,
      tokensSavedByGradedSlicing: pack.tokensSaved,
      topFiles: pack.files.slice(0, 5).map((f) => f.path),
      totalElapsedMs: Math.round((performance.now() - t0) * 100) / 100,
    }
  }

  const fedRepos = configuredRepos.filter((d) => existsSync(d))
  const fedLinks = engine.federate(fedRepos)
  const mem = process.memoryUsage()

  const report = {
    engine: `kaxcav-vortex v${KAXCAV_VORTEX_VERSION}`,
    timestamp: new Date().toISOString(),
    benchmarks: {
      configuredWorkspaces: genericBenchmarks,
      multiRepoFederation: {
        reposFederated: fedRepos,
        crossRepoLinksDiscovered: fedLinks.length,
        sampleLinks: fedLinks.slice(0, 6),
      },
    },
    memory: {
      heapUsedMB: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
      rssMB: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
    },
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const { command, positional, flags } = parseFlags(argv)

  if (command === 'version' || flags.version || flags.v) {
    process.stdout.write(`kaxcav-vortex v${KAXCAV_VORTEX_VERSION}\n`)
    return 0
  }

  if (command === 'help' || flags.help || flags.h) {
    process.stdout.write(
      [
        `Kaxcav Vortex v${KAXCAV_VORTEX_VERSION} : Multi-Repo Code Intelligence & Context Engine`,
        '',
        'Usage:',
        '  kvx status [--json]                               Show shard health, WAL size & token telemetry',
        '  kvx init [repo-path]                              Initialize .kvx.yaml & register repository',
        '  kvx repo <add|rm|list> [repo-path]                Manage registered multi-repo workspaces',
        '  kvx context --index <path> --task "<query>"       Build surgical L0-L3 context pack',
        '              [--token-budget 1800] [--fidelity graded|full|compact]',
        '              [--if-none-match <etag>] [--delta-from <etag>] [--federate]',
        '  kvx search --index <path> "<query>" [--limit 15]  Hybrid BM25F + AST symbol search',
        '  kvx outline --index <path> <file>                 Extract L1 structural skeleton (~40 tokens)',
        '  kvx symbol --index <path> <symbol>                Read exact source slice of a single symbol',
        '  kvx callers --index <path> <symbol>               Inspect incoming callers & outgoing callees',
        '  kvx affected --index <path> -- <files...>         List test suites affected by file edits',
        '  kvx blast-radius --index <path> <target>          Compute direct callers, tests & cross-repo impact',
        '  kvx diff-impact --index <path> [--minutes 60]     Detect breaking signature Contract Drift',
        '  kvx federate [--repos <p1,p2,...>]                Discover cross-repo REST/model/symbol links',
        '  kvx dashboard [--port 7788]                       Launch Web Workbench UI on 127.0.0.1:7788',
        '  kvx serve --mcp [--read-only]                     Start JSON-RPC 2.0 MCP server over stdio (--read-only: kaxcav-vortex-ro, code tools only)',
        '  kvx bench                                         Run performance & accuracy benchmark suite',
        '',
      ].join('\n'),
    )
    return 0
  }

  // Before the engine opens any shard: the extractor version depends on the optional layer.
  await initTreeSitter()
  const engine = new KaxcavVortexEngine()

  try {
    switch (command) {
      case 'status': {
        const repo = (flags.index ?? flags.repo) as string | undefined
        const status = engine.status(repo ? [resolve(repo)] : undefined)
        if (flags.json) {
          process.stdout.write(JSON.stringify(status, null, 2) + '\n')
        } else {
          process.stdout.write(
            `Kaxcav Vortex v${status.version} | State: ${status.startup_phase} | Heap: ${(status.heap_alloc_bytes / 1048576).toFixed(1)} MB | Shards: ${status.shards.length}\n`,
          )
          for (const s of status.shards) {
            process.stdout.write(
              `  - ${s.repositoryPath}: ${s.fileCount} files, ${s.symbolCount} symbols, ${s.edgeCount} edges (DB: ${(s.dbSizeBytes / 1024).toFixed(0)} KB, WAL: ${(s.walSizeBytes / 1024).toFixed(0)} KB)\n`,
            )
          }
        }
        return 0
      }

      case 'init': {
        const targetRepo = resolve(positional[0] ?? String(flags.index ?? flags.repo ?? process.cwd()))
        const kvxYaml = join(targetRepo, '.kvx.yaml')
        if (!existsSync(kvxYaml)) {
          writeFileSync(
            kvxYaml,
            [
              'index:',
              '  max_file_size: 524288',
              '  exclude:',
              '    - "**/.git/**"',
              '    - "**/.kaxcav/**"',
              '    - "**/node_modules/**"',
              '    - "**/dist/**"',
              '    - "**/build/**"',
              '    - "**/coverage/**"',
              '    - "**/test-results/**"',
              '',
            ].join('\n'),
            'utf8',
          )
        }
        const health = engine.addRepo(targetRepo)
        process.stdout.write(
          JSON.stringify({ initialized: targetRepo, config: kvxYaml, shard: health }, null, 2) + '\n',
        )
        return 0
      }

      case 'repo': {
        const action = positional[0] ?? 'list'
        const target = positional[1] ? resolve(positional[1]) : resolve(process.cwd())
        if (action === 'add') {
          const health = engine.addRepo(target)
          process.stdout.write(JSON.stringify({ added: health }, null, 2) + '\n')
          return 0
        }
        if (action === 'rm' || action === 'remove') {
          const removed = engine.removeRepo(target)
          process.stdout.write(JSON.stringify({ removed, path: target }, null, 2) + '\n')
          return 0
        }
        const repos = engine.loadConfiguredRepos()
        process.stdout.write(JSON.stringify({ repos }, null, 2) + '\n')
        return 0
      }

      case 'context': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const task = String(flags.task ?? positional.join(' ') ?? 'architecture overview')
        const budget = Number(flags['token-budget'] ?? flags.budget ?? 2000)
        const fidelity = ((flags.fidelity as string) ?? 'graded') as ContextFidelity
        const format = ((flags.format as string) ?? (flags.json ? 'json' : 'markdown')) as
          | 'markdown'
          | 'json'
        const ifNoneMatch = flags['if-none-match'] ? String(flags['if-none-match']) : undefined
        const deltaFrom = flags['delta-from'] ? String(flags['delta-from']) : undefined

        const pack = engine.context({
          repositoryPath: repoPath,
          task,
          tokenBudget: budget,
          fidelity,
          format,
          ifNoneMatch,
          deltaFrom,
          includeFederation: Boolean(flags.federate),
          path: flags.path ? String(flags.path) : undefined,
          corpus: flags.corpus ? String(flags.corpus) : undefined,
        })

        if (format === 'json') {
          process.stdout.write(JSON.stringify(pack, null, 2) + '\n')
        } else {
          process.stdout.write(pack.markdown + '\n')
        }
        return 0
      }

      case 'search': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const query = String(flags.query ?? positional.join(' '))
        const limit = Number(flags.limit ?? 15)
        const path = flags.path ? String(flags.path) : undefined
        const corpus = flags.corpus ? String(flags.corpus) : undefined
        const hits = engine.search(repoPath, query, { limit, path, corpus })
        if (flags.json) {
          process.stdout.write(JSON.stringify(hits, null, 2) + '\n')
        } else {
          for (const h of hits) {
            process.stdout.write(
              `${h.relPath}:${h.startLine}-${h.endLine} [${h.kind}] ${h.symbolName} (score=${h.score})\n`,
            )
          }
        }
        return 0
      }

      case 'affected': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const tests = engine.affected(repoPath, positional)
        if (flags.json) {
          process.stdout.write(JSON.stringify({ tests, affected: tests }, null, 2) + '\n')
        } else {
          for (const t of tests) process.stdout.write(t + '\n')
        }
        return 0
      }

      case 'blast-radius':
      case 'blast': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const target = String(flags.target ?? flags.symbol ?? positional[0] ?? '')
        const report = engine.blastRadius(repoPath, target)
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
        return 0
      }

      case 'outline': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const file = String(flags.file ?? positional[0] ?? '')
        const scope = flags.escopo ? (String(flags.escopo) as 'topo' | 'exportado' | 'tudo') : undefined
        const res = engine.fileOutline(repoPath, file, { scope })
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
        return 0
      }

      case 'symbol': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const sym = String(flags.symbol ?? positional[0] ?? '')
        const res = engine.readSymbolDetailed(repoPath, sym, { path: flags.path ? String(flags.path) : undefined })
        process.stdout.write(JSON.stringify(res.matches.length > 0 ? res.matches : res, null, 2) + '\n')
        return res.matches.length > 0 ? 0 : 1
      }

      case 'callers': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const sym = String(flags.symbol ?? positional[0] ?? '')
        const res = engine.callGraph(repoPath, sym)
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
        return 0
      }

      case 'diff-impact': {
        const repoPath = resolve(String(flags.index ?? flags.repo ?? process.cwd()))
        const mins = Number(flags.minutes ?? 60)
        const res = engine.diffImpact(repoPath, mins)
        process.stdout.write(JSON.stringify(res, null, 2) + '\n')
        return 0
      }

      case 'federate': {
        const reposRaw = flags.repos ? String(flags.repos).split(',') : positional
        const links = engine.federate(reposRaw.length ? reposRaw : undefined)
        process.stdout.write(JSON.stringify({ count: links.length, links }, null, 2) + '\n')
        return 0
      }

      case 'token-audit': {
        const status = engine.status()
        process.stdout.write(JSON.stringify(status.telemetry, null, 2) + '\n')
        return 0
      }

      case 'serve':
      case 'mcp': {
        // --read-only: server `kaxcav-vortex-ro` with only the code-reading tools (no nexus_*)
        const mcp = new VortexMcpServer(engine, undefined, { readOnly: Boolean(flags['read-only']) })
        mcp.startStdio()
        return await new Promise<number>(() => {})
      }

      case 'daemon': {
        const sub = positional[0] ?? 'status'
        const status = engine.status()
        process.stdout.write(
          JSON.stringify({ daemon: sub, status: 'ready', pid: status.pid, version: status.version }) +
            '\n',
        )
        return 0
      }

      case 'bench': {
        await runBenchmark(engine)
        return 0
      }

      case 'dashboard':
      case 'ui': {
        const port = Number(flags.port ?? 7788)
        const dash = new VortexDashboardServer(engine)
        const info = await dash.start(port)
        process.stdout.write(`Kaxcav Vortex Workbench listening at ${info.url}\n`)
        return await new Promise<number>(() => {})
      }

      case 'drive':
      case 'drive-app': {
        const port = Number(flags.port ?? 4777)
        const driveApp = new DriveAppServer(engine)
        const info = await driveApp.start(port)
        process.stdout.write(`Drive Nexus app listening at ${info.url}\n`)
        return await new Promise<number>(() => {})
      }

      case 'nexus': {
        const sub = positional[0] ?? 'list'
        if (sub === 'ingest') {
          const sourceDir = resolve(String(flags.source ?? flags.dir ?? positional[1] ?? process.cwd()))
          const name = String(flags.name ?? positional[2] ?? 'Drive Nexus Vault')
          const res = engine.nexus.ingestDirectory({
            name,
            sourceDir,
            tenantSlug: flags.tenant ? String(flags.tenant) : undefined,
          })
          process.stdout.write(JSON.stringify(res, null, 2) + '\n')
          return 0
        }
        if (sub === 'drive-sync') {
          const folder = String(flags.folder ?? positional[1] ?? '')
          const name = String(flags.name ?? positional[2] ?? 'Google Drive Sync')
          const res = await engine.nexus.syncGoogleDriveWorkspace({
            name,
            folderIdOrUrl: folder,
            accessToken: flags.token ? String(flags.token) : undefined,
            apiKey: flags['api-key'] ? String(flags['api-key']) : undefined,
            maxFiles: flags.max ? Number(flags.max) : 120,
          })
          process.stdout.write(JSON.stringify(res, null, 2) + '\n')
          return 0
        }
        const workspaces = engine.nexus.listWorkspaces()
        process.stdout.write(JSON.stringify({ workspaces }, null, 2) + '\n')
        return 0
      }

      default: {
        process.stderr.write(`Unknown command: ${command}\n`)
        return 1
      }
    }
  } finally {
    if (
      command !== 'serve' &&
      command !== 'mcp' &&
      command !== 'dashboard' &&
      command !== 'ui' &&
      command !== 'drive' &&
      command !== 'drive-app'
    ) {
      engine.close()
    }
  }
}

if (import.meta.main) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n')
      process.exit(1)
    },
  )
}
