import { createHash } from 'node:crypto'
import type {
  ContextFidelity,
  ContextPackResult,
  ContextRequest,
  FederationLink,
  PackedSlice,
  StoredSymbolRow,
} from '../core/types.ts'
import type { RepositoryShard } from '../storage/shard.ts'

interface PriorPackEntry {
  etag: string
  sliceEtags: Map<string, string>
  result: ContextPackResult
  createdAt: number
}

const INTENT_SYNONYMS: Array<{ pattern: RegExp; boosts: string[] }> = [
  {
    pattern: /\b(executiv[ao]|consolidad[ao]|resum[eo]|visao\s+geral|overview|dossier)\b/i,
    boosts: ['relatorio', 'executivo', 'consolidado', 'visao', 'arquitetura', 'resumo'],
  },
  {
    pattern: /\b(entidade|entidades|dominio|modelo|modelos|tabela|schema|prisma|banco)\b/i,
    boosts: ['entidades', 'dominio', 'model', 'schema', 'prisma', 'table', 'relacionamentos'],
  },
  {
    pattern: /\b(rota|rotas|endpoint|endpoints|api|controller|http|rest|webhook)\b/i,
    boosts: ['route', 'endpoint', 'api', 'controller', 'router', 'webhook', 'fluxos'],
  },
  {
    pattern: /\b(seguranca|vulnerabilidade|auditoria|auth|permissao|token|jwt|rbac|risco)\b/i,
    boosts: ['seguranca', 'auth', 'jwt', 'token', 'permissao', 'auditoria', 'vulnerabilidade'],
  },
  {
    pattern: /\b(integrac[aã]o|whatsapp|extern[oa]|fila|worker|job|cron|webhook)\b/i,
    boosts: ['integracoes', 'whatsapp', 'worker', 'queue', 'webhook', 'provider', 'adapter'],
  },
]

export class SubmodularPacker {
  private readonly sessionPacks = new Map<string, PriorPackEntry>()

  pack(
    shard: RepositoryShard,
    req: ContextRequest,
    federationLinks: FederationLink[] = [],
  ): ContextPackResult {
    const t0 = performance.now()
    shard.sync(false)

    const budget = Math.max(400, Math.min(16_000, req.tokenBudget ?? 2_000))
    const fidelity: ContextFidelity = req.fidelity ?? 'graded'
    const { graph, fileIdToIndex, indexToFile } = shard.getCsrGraph()

    // Stage 1: Multi-Signal Seed Scoring (BM25F + Exact Token Match + Intent Expansion)
    const expandedQuery = this.expandIntentQuery(req.task)
    const ftsTerms = shard.buildFtsQueryTerms(expandedQuery)
    const rawKeywords = this.extractKeywords(req.task)

    const fileSeedScores = new Map<number, number>()
    const symBoostById = new Map<number, number>()

    if (ftsTerms.length > 0) {
      const ftsExpr = ftsTerms.join(' OR ')

      try {
        const fileHits = shard.db
          .prepare(
            `SELECT
              CAST(file_id AS INTEGER) AS fileId,
              bm25(fts_files, 0.0, 4.5, 4.0, 3.0, 1.0) AS score
             FROM fts_files
             WHERE fts_files MATCH ?
             ORDER BY score ASC
             LIMIT 60`,
          )
          .all(ftsExpr) as Array<{ fileId: number; score: number }>

        for (const h of fileHits) {
          const nodeIdx = fileIdToIndex.get(h.fileId)
          if (nodeIdx !== undefined) {
            const fRow = indexToFile[nodeIdx]
            const hubDamp = fRow.isHub ? 0.28 : 1.0
            const prev = fileSeedScores.get(nodeIdx) ?? 0
            fileSeedScores.set(nodeIdx, prev + Math.abs(h.score) * 2.2 * hubDamp)
          }
        }
      } catch {}

      try {
        const symHits = shard.db
          .prepare(
            `SELECT
              CAST(sym_id AS INTEGER) AS symId,
              CAST(file_id AS INTEGER) AS fileId,
              bm25(fts_symbols, 0.0, 0.0, 3.0, 5.0, 3.0, 2.5, 1.0) AS score
             FROM fts_symbols
             WHERE fts_symbols MATCH ?
             ORDER BY score ASC
             LIMIT 100`,
          )
          .all(ftsExpr) as Array<{ symId: number; fileId: number; score: number }>

        for (const sh of symHits) {
          const val = Math.abs(sh.score)
          symBoostById.set(sh.symId, (symBoostById.get(sh.symId) ?? 0) + val * 2.5)
          const nodeIdx = fileIdToIndex.get(sh.fileId)
          if (nodeIdx !== undefined) {
            const fRow = indexToFile[nodeIdx]
            const hubDamp = fRow.isHub ? 0.3 : 1.0
            fileSeedScores.set(
              nodeIdx,
              (fileSeedScores.get(nodeIdx) ?? 0) + val * 1.6 * hubDamp,
            )
          }
        }
      } catch {}
    }

    // Exact path & filename lexical boost
    for (let i = 0; i < indexToFile.length; i++) {
      const f = indexToFile[i]
      const relLower = f.relPath.toLowerCase()
      const baseLower = (relLower.split('/').pop() ?? relLower).replace(/\.\w+$/, '')
      let exactHits = 0
      for (const kw of rawKeywords) {
        if (baseLower === kw) {
          exactHits += 4.5
        } else if (baseLower.includes(kw)) {
          exactHits += 2.2
        } else if (relLower.includes(kw)) {
          exactHits += 1.0
        }
      }
      if (exactHits > 0) {
        const hubDamp = f.isHub ? 0.32 : 1.0
        fileSeedScores.set(i, (fileSeedScores.get(i) ?? 0) + exactHits * 3.0 * hubDamp)
      }

      // Worktree Recency Gravity: files modified in the last 30 minutes get an automatic boost
      if (Date.now() - f.mtimeMs < 30 * 60_000 && !f.isHub) {
        const prev = fileSeedScores.get(i) ?? 0
        if (prev > 0) {
          fileSeedScores.set(i, prev * 1.35)
        }
      }
    }

    // Fallback seed if query had zero lexical overlap: pick top non-hub entrypoints
    if (fileSeedScores.size === 0 && indexToFile.length > 0) {
      for (let i = 0; i < Math.min(indexToFile.length, 15); i++) {
        if (!indexToFile[i].isHub) {
          fileSeedScores.set(i, 1.0)
        }
      }
    }

    // Stage 2: Query-Anchored Personalized PageRank with Hub Dampening (PPR-HD)
    const pprScores = graph.personalizedPageRank(fileSeedScores, {
      alpha: 0.25,
      iterations: 10,
      hubPenalty: 0.3,
    })

    const combinedFileScores: Array<{ fileId: number; nodeIdx: number; score: number }> = []
    for (let i = 0; i < indexToFile.length; i++) {
      const f = indexToFile[i]
      const seed = fileSeedScores.get(i) ?? 0
      const ppr = pprScores[i] * 100
      const hubFactor = f.isHub ? 0.35 : 1.0
      const finalScore = (seed * 0.65 + ppr * 0.35) * hubFactor
      if (finalScore > 0.001) {
        combinedFileScores.push({ fileId: f.fileId, nodeIdx: i, score: finalScore })
      }
    }
    combinedFileScores.sort((a, b) => b.score - a.score)

    const topFiles = combinedFileScores.slice(0, 24)
    if (topFiles.length === 0 && indexToFile.length > 0) {
      for (let i = 0; i < Math.min(8, indexToFile.length); i++) {
        topFiles.push({ fileId: indexToFile[i].fileId, nodeIdx: i, score: 1.0 / (i + 1) })
      }
    }

    // Stage 3: Submodular Greedy Context Packing with L0–L3 Fidelity Slicing
    const fileScoreMap = new Map(topFiles.map((tf) => [tf.fileId, tf.score]))
    const fileRankMap = new Map(topFiles.map((tf, idx) => [tf.fileId, idx]))
    const candidateFileIds = topFiles.map((tf) => tf.fileId)

    const placeholders = candidateFileIds.map(() => '?').join(',')
    const symbolRows =
      candidateFileIds.length > 0
        ? (shard.db
            .prepare(
              `SELECT
                sym_id AS symId, file_id AS fileId, rel_path AS relPath,
                name, qualified_name AS qualifiedName, kind, exported,
                start_line AS startLine, end_line AS endLine, signature,
                body_hash AS bodyHash, token_estimate AS tokenEstimate,
                doc_summary AS docSummary, slice_text AS sliceText, is_hub AS isHub
               FROM symbols
               WHERE file_id IN (${placeholders})`,
            )
            .all(...candidateFileIds) as unknown as StoredSymbolRow[])
        : []

    const priorDeltaMap = req.deltaFrom
      ? (this.sessionPacks.get(req.deltaFrom)?.sliceEtags ?? shard.loadPackSnapshot(req.deltaFrom))
      : null

    const scoredCandidates = symbolRows.map((sym) => {
      const fScore = fileScoreMap.get(sym.fileId) ?? 0.1
      const fRank = fileRankMap.get(sym.fileId) ?? 99
      const sBoost = symBoostById.get(sym.symId) ?? 0

      let kwBonus = 0
      const lowerName = sym.name.toLowerCase()
      const lowerSig = sym.signature.toLowerCase()
      for (const kw of rawKeywords) {
        if (lowerName === kw) kwBonus += 6.0
        else if (lowerName.includes(kw)) kwBonus += 2.8
        else if (lowerSig.includes(kw)) kwBonus += 1.2
      }

      const rankBonus = fRank < 3 ? 1.35 : fRank < 7 ? 1.0 : 0.65
      const rawScore = (fScore * 1.4 + sBoost + kwBonus) * rankBonus
      return { sym, fRank, score: rawScore }
    })

    scoredCandidates.sort((a, b) => b.score - a.score)

    const packedSlices: PackedSlice[] = []
    const sliceEtags = new Map<string, string>()
    const filesIncludedCount = new Map<string, number>()
    let usedTokens = 0
    let tokensSaved = 0

    for (let idx = 0; idx < scoredCandidates.length; idx++) {
      if (usedTokens >= budget * 0.96) break
      const { sym, fRank, score } = scoredCandidates[idx]
      const countInFile = filesIncludedCount.get(sym.relPath) ?? 0
      if (countInFile >= 5) continue

      // Marginal utility decay for symbols in the same file (Submodular diversity)
      const diversityDiscount = 1 / (1 + countInFile * 0.45)
      const effectiveScore = score * diversityDiscount
      if (effectiveScore <= 0.01 && packedSlices.length >= 4) continue

      const sliceEtag = `${sym.bodyHash}`
      sliceEtags.set(sym.qualifiedName, sliceEtag)

      let fidelityLevel: PackedSlice['fidelityLevel']
      let renderedContent: string

      // Check L0 Delta deduplication first (works both in-memory and across separate CLI processes via SQLite!)
      if (priorDeltaMap && priorDeltaMap.get(sym.qualifiedName) === sliceEtag) {
        fidelityLevel = 'L0_DELTA'
        renderedContent = `// [L0_DELTA unchanged etag:${sliceEtag}] ${sym.signature} (lines ${sym.startLine}-${sym.endLine})`
      } else if (fidelity === 'compact') {
        fidelityLevel = 'L1_SKELETON'
        renderedContent = sym.docSummary
          ? `// ${sym.docSummary}\n${sym.signature}`
          : sym.signature
      } else if (fidelity === 'full' || (fRank < 4 && idx < 6)) {
        fidelityLevel = 'L3_FOCAL'
        renderedContent = sym.sliceText
      } else if (idx < 16) {
        fidelityLevel = 'L2_CONTRACT'
        renderedContent = sym.docSummary
          ? `/** ${sym.docSummary} */\n${sym.signature} { /* ... lines ${sym.startLine}-${sym.endLine} ... */ }`
          : `${sym.signature} { /* ... lines ${sym.startLine}-${sym.endLine} ... */ }`
      } else {
        fidelityLevel = 'L1_SKELETON'
        renderedContent = sym.signature
      }

      const sliceTokens = Math.max(4, Math.ceil(renderedContent.length / 4))
      if (usedTokens + sliceTokens > budget) {
        // Degrade L3 -> L2 if full body doesn't fit remaining token budget
        if (fidelityLevel === 'L3_FOCAL') {
          const contractText = sym.docSummary
            ? `/** ${sym.docSummary} */\n${sym.signature} { /* ... lines ${sym.startLine}-${sym.endLine} ... */ }`
            : `${sym.signature}`
          const contractTokens = Math.max(4, Math.ceil(contractText.length / 4))
          if (usedTokens + contractTokens <= budget) {
            fidelityLevel = 'L2_CONTRACT'
            renderedContent = contractText
            usedTokens += contractTokens
            tokensSaved += Math.max(0, sym.tokenEstimate - contractTokens)
            filesIncludedCount.set(sym.relPath, countInFile + 1)
            packedSlices.push({
              relPath: sym.relPath,
              symbolName: sym.name,
              qualifiedName: sym.qualifiedName,
              kind: sym.kind,
              fidelityLevel,
              startLine: sym.startLine,
              endLine: sym.endLine,
              score: Math.round(effectiveScore * 100) / 100,
              tokens: contractTokens,
              etag: sliceEtag,
              content: renderedContent,
            })
          }
        }
        continue
      }

      usedTokens += sliceTokens
      tokensSaved += Math.max(0, sym.tokenEstimate - sliceTokens)
      filesIncludedCount.set(sym.relPath, countInFile + 1)

      packedSlices.push({
        relPath: sym.relPath,
        symbolName: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        fidelityLevel,
        startLine: sym.startLine,
        endLine: sym.endLine,
        score: Math.round(effectiveScore * 100) / 100,
        tokens: sliceTokens,
        etag: sliceEtag,
        content: renderedContent,
      })
    }

    const packHashPayload = packedSlices.map((s) => `${s.qualifiedName}:${s.etag}:${s.fidelityLevel}`).join('|')
    const packEtag =
      'kvx-' + createHash('sha256').update(packHashPayload).digest('hex').slice(0, 16)

    // Stage 4: ETag Short-Circuit (--if-none-match, persisted in SQLite across CLI calls)
    if (
      req.ifNoneMatch &&
      (req.ifNoneMatch === packEtag || shard.loadPackSnapshot(req.ifNoneMatch) !== null && req.ifNoneMatch === packEtag)
    ) {
      shard.savePackSnapshot(packEtag, sliceEtags)
      const elapsedMs = Math.round((performance.now() - t0) * 100) / 100
      return {
        etag: packEtag,
        freshness: 'fresh',
        exact: true,
        unchanged: true,
        repositoryPath: shard.repositoryPath,
        task: req.task,
        fidelity,
        tokenBudget: budget,
        tokenCount: 0,
        tokensSaved: usedTokens + tokensSaved,
        elapsedMs,
        files: [],
        slices: [],
        federationLinks,
        markdown: `<!-- kvx:unchanged etag=${packEtag} -->`,
      }
    }

    shard.savePackSnapshot(packEtag, sliceEtags)

    // Group file summary list ordered by highest slice score
    const fileAgg = new Map<
      string,
      { path: string; etag: string; score: number; fidelityLevel: string; tokens: number }
    >()
    for (const s of packedSlices) {
      const cur = fileAgg.get(s.relPath)
      if (!cur) {
        fileAgg.set(s.relPath, {
          path: s.relPath,
          etag: s.etag,
          score: s.score,
          fidelityLevel: s.fidelityLevel,
          tokens: s.tokens,
        })
      } else {
        cur.score = Math.max(cur.score, s.score)
        cur.tokens += s.tokens
      }
    }

    const filesList = [...fileAgg.values()].sort((a, b) => b.score - a.score)
    const markdown = this.renderMarkdownPack(
      shard.repositoryPath,
      req.task,
      packEtag,
      fidelity,
      usedTokens,
      tokensSaved,
      filesList,
      packedSlices,
      federationLinks,
    )

    const elapsedMs = Math.round((performance.now() - t0) * 100) / 100
    const result: ContextPackResult = {
      etag: packEtag,
      freshness: 'fresh',
      exact: true,
      unchanged: false,
      repositoryPath: shard.repositoryPath,
      task: req.task,
      fidelity,
      tokenBudget: budget,
      tokenCount: usedTokens,
      tokensSaved,
      elapsedMs,
      files: filesList,
      slices: packedSlices,
      federationLinks,
      markdown,
    }

    this.sessionPacks.set(packEtag, {
      etag: packEtag,
      sliceEtags,
      result,
      createdAt: Date.now(),
    })

    return result
  }

  private expandIntentQuery(task: string): string {
    const extras: string[] = []
    for (const rule of INTENT_SYNONYMS) {
      if (rule.pattern.test(task)) {
        extras.push(...rule.boosts)
      }
    }
    return extras.length > 0 ? `${task} ${extras.join(' ')}` : task
  }

  private extractKeywords(task: string): string[] {
    return task
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3)
  }

  private renderMarkdownPack(
    repoPath: string,
    task: string,
    etag: string,
    fidelity: ContextFidelity,
    usedTokens: number,
    tokensSaved: number,
    files: ContextPackResult['files'],
    slices: PackedSlice[],
    federationLinks: FederationLink[],
  ): string {
    const out: string[] = []
    out.push(
      `# Kaxcav Vortex Context Pack (\`${etag}\`)`,
      `> **Repo:** \`${repoPath}\` | **Fidelity:** \`${fidelity}\` | **Tokens:** \`${usedTokens}\` *(Saved: \`${tokensSaved}\` tokens)*`,
      `> **Task:** ${task}`,
      '',
      '## Ranked Files',
    )

    for (const f of files) {
      out.push(`- \`${f.path}\` (${f.fidelityLevel}, score: ${f.score}, ~${f.tokens} tok)`)
    }

    if (federationLinks.length > 0) {
      out.push('', '## Cross-Repo Federation Links')
      for (const link of federationLinks.slice(0, 8)) {
        out.push(
          `- **[${link.linkKind}]** \`${link.sourceFile}#${link.sourceSymbol}\` -> \`${link.targetRepo}/${link.targetFile}#${link.targetSymbol}\` (${link.detail})`,
        )
      }
    }

    out.push('', '## Surgical Code & Knowledge Slices')
    for (const s of slices) {
      out.push(
        '',
        `### \`${s.relPath}\` :: \`${s.symbolName}\` [${s.fidelityLevel}] (L${s.startLine}-L${s.endLine})`,
        '```',
        s.content,
        '```',
      )
    }

    return out.join('\n')
  }
}
