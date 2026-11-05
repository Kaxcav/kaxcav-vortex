import type { FederationLink } from '../core/types.ts'
import type { RepositoryShard } from '../storage/shard.ts'

export class MultiRepoFederator {
  /**
   * Builds cross-repository contract links across all active shards:
   * 1. REST Route Exposition <-> HTTP Client Consumption
   * 2. Prisma/SQL Data Models <-> Service/Documentation references
   * 3. Shared Exported Classes/Interfaces/Adapters across repositories
   */
  discoverLinks(shards: RepositoryShard[]): FederationLink[] {
    if (shards.length < 2) return []

    const links: FederationLink[] = []
    const exposedRoutes: Array<{
      repo: string
      relPath: string
      symbolName: string
      method: string
      pathPattern: string
    }> = []
    const consumedRoutes: Array<{
      repo: string
      relPath: string
      symbolName: string
      method: string
      pathPattern: string
    }> = []
    const exportedSymbols: Array<{
      repo: string
      relPath: string
      name: string
      kind: string
    }> = []

    for (const shard of shards) {
      shard.sync(false)
      const routes = shard.db
        .prepare('SELECT rel_path, symbol_name, direction, method, path_pattern FROM routes')
        .all() as Array<{
        rel_path: string
        symbol_name: string
        direction: 'expose' | 'consume'
        method: string
        path_pattern: string
      }>

      for (const r of routes) {
        if (r.direction === 'expose') {
          exposedRoutes.push({
            repo: shard.repositoryPath,
            relPath: r.rel_path,
            symbolName: r.symbol_name,
            method: r.method,
            pathPattern: r.path_pattern,
          })
        } else {
          consumedRoutes.push({
            repo: shard.repositoryPath,
            relPath: r.rel_path,
            symbolName: r.symbol_name,
            method: r.method,
            pathPattern: r.path_pattern,
          })
        }
      }

      const syms = shard.db
        .prepare(
          `SELECT rel_path, name, kind
           FROM symbols
           WHERE exported = 1 AND kind IN ('class', 'interface', 'model', 'table')
           LIMIT 500`,
        )
        .all() as Array<{ rel_path: string; name: string; kind: string }>

      for (const s of syms) {
        if (s.name.length >= 4) {
          exportedSymbols.push({
            repo: shard.repositoryPath,
            relPath: s.rel_path,
            name: s.name,
            kind: s.kind,
          })
        }
      }
    }

    // 1. Match REST Routes across repos
    for (const consumer of consumedRoutes) {
      for (const exposer of exposedRoutes) {
        if (consumer.repo === exposer.repo) continue
        if (this.routeMatches(consumer.pathPattern, exposer.pathPattern)) {
          links.push({
            sourceRepo: consumer.repo,
            sourceFile: consumer.relPath,
            sourceSymbol: consumer.symbolName,
            targetRepo: exposer.repo,
            targetFile: exposer.relPath,
            targetSymbol: exposer.symbolName,
            linkKind: 'rest_route',
            detail: `${consumer.method} ${exposer.pathPattern}`,
            confidence: 0.95,
          })
        }
      }
    }

    // 2. Match Cross-Repo Symbol Mentions & Models
    const symbolsByName = new Map<
      string,
      Array<{ repo: string; relPath: string; name: string; kind: string }>
    >()
    for (const sym of exportedSymbols) {
      const key = sym.name.toLowerCase()
      const list = symbolsByName.get(key) ?? []
      list.push(sym)
      symbolsByName.set(key, list)
    }

    for (const shard of shards) {
      const edges = shard.db
        .prepare(
          `SELECT f.rel_path AS relPath, r.src_sym_name AS srcSym, r.dst_name AS dstName, r.kind AS kind
           FROM raw_edges r
           JOIN files f ON f.file_id = r.src_file_id
           WHERE r.kind IN ('mentions_symbol', 'imports', 'calls')`,
        )
        .all() as Array<{ relPath: string; srcSym: string; dstName: string; kind: string }>

      for (const e of edges) {
        const targets = symbolsByName.get(e.dstName.toLowerCase())
        if (!targets) continue
        for (const t of targets) {
          if (t.repo === shard.repositoryPath) continue
          links.push({
            sourceRepo: shard.repositoryPath,
            sourceFile: e.relPath,
            sourceSymbol: e.srcSym,
            targetRepo: t.repo,
            targetFile: t.relPath,
            targetSymbol: t.name,
            linkKind:
              t.kind === 'model' || t.kind === 'table'
                ? 'prisma_model'
                : e.kind === 'mentions_symbol'
                  ? 'doc_reference'
                  : 'shared_symbol',
            detail: `${e.kind} -> ${t.kind} ${t.name}`,
            confidence: e.kind === 'mentions_symbol' ? 0.82 : 0.9,
          })
        }
      }
    }

    // Deduplicate
    const unique = new Map<string, FederationLink>()
    for (const l of links) {
      const k = `${l.sourceRepo}:${l.sourceFile}:${l.targetRepo}:${l.targetFile}:${l.targetSymbol}`
      if (!unique.has(k)) unique.set(k, l)
    }

    return [...unique.values()].slice(0, 200)
  }

  private routeMatches(consumed: string, exposed: string): boolean {
    const normA = consumed.replace(/\/+$/, '').toLowerCase()
    const normB = exposed
      .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
      .replace(/\{[A-Za-z0-9_]+\}/g, '[^/]+')
      .replace(/\/+$/, '')
      .toLowerCase()
    try {
      return new RegExp(`^${normB}$`).test(normA)
    } catch {
      return normA === normB
    }
  }
}
