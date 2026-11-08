/**
 * CLI benchmark harness for kaxcav-vortex.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings bench/run.ts --repo kvx|zod|all [--tools kvx,baseline,kvx-mcp] [--quick]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GroundTruth, type GroundTruthDeclaration } from './ground-truth.ts';
import { deterministicSample, computeMetrics, percentile, type SetMetrics } from './sample.ts';
import { KvxAdapter } from './adapters/kvx.ts';
import { BaselineAdapter } from './adapters/baseline.ts';
import { McpStdioClient, type CompetitorConfig } from './adapters/mcp-stdio.ts';

const __filename = fileURLToPath(import.meta.url);
const benchDir = path.dirname(__filename);

interface RepoConfig {
  name: string;
  path: string;
  commit?: string;
  roots: string[];
}

function parseCliArgs() {
  const argv = process.argv.slice(2);
  let repo = 'kvx';
  let tools = 'kvx,baseline,kvx-mcp';
  let quick = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) {
      repo = argv[i + 1];
      i++;
    } else if (argv[i] === '--tools' && argv[i + 1]) {
      tools = argv[i + 1];
      i++;
    } else if (argv[i] === '--quick') {
      quick = true;
    }
  }

  const enabledTools = tools.split(',').map((t) => t.trim()).filter(Boolean);
  return { repo, enabledTools, quick };
}

function getRepoCommit(repoAbs: string, fallbackCommit?: string): string {
  if (fallbackCommit) return fallbackCommit;
  try {
    const headPath = path.join(repoAbs, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return 'unknown';
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref:')) {
      const refPart = head.slice(4).trim();
      const refPath = path.join(repoAbs, '.git', ...refPart.split('/'));
      if (fs.existsSync(refPath)) {
        return fs.readFileSync(refPath, 'utf8').trim();
      }
      const packedRefs = path.join(repoAbs, '.git', 'packed-refs');
      if (fs.existsSync(packedRefs)) {
        const lines = fs.readFileSync(packedRefs, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line.includes(refPart)) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] && parts[0].length === 40) return parts[0];
          }
        }
      }
    } else if (head.length === 40) {
      return head;
    }
  } catch {}
  return 'unknown';
}

async function runBenchmarkForRepo(
  repoConfig: RepoConfig,
  enabledTools: string[],
  quick: boolean
): Promise<{ reportMd: string; fullResult: any }> {
  const repoAbs = path.resolve(benchDir, repoConfig.path);
  const repoCommit = getRepoCommit(repoAbs, repoConfig.commit);

  // Initialize Ground Truth
  const gt = new GroundTruth(repoAbs, repoConfig.roots);
  const sourceRels = gt.sourceFiles.map((f) => path.relative(repoAbs, f).replace(/\\/g, '/'));
  // Fairness: the ground truth only analyzes files under `roots`, so every tool's answer is
  // compared inside that same universe (a hit in test/ or bench/ is neither right nor wrong).
  const universe = new Set(sourceRels);
  const inUniverse = (key: string) => universe.has(key.replace(/:\d+$/, ''));

  // Initialize adapters
  let kvx: KvxAdapter | null = null;
  let baseline: BaselineAdapter | null = null;
  const mcpClients = new Map<string, McpStdioClient>();

  let kvxIndexMs = 0;
  if (enabledTools.includes('kvx')) {
    kvx = new KvxAdapter(repoAbs);
    kvxIndexMs = Math.round(kvx.indexMs * 100) / 100;
  }

  if (enabledTools.includes('baseline')) {
    baseline = new BaselineAdapter(repoAbs, repoConfig.roots);
  }

  // Competitors from competitors.json
  const compFile = path.join(benchDir, 'competitors.json');
  if (fs.existsSync(compFile)) {
    const competitors: CompetitorConfig[] = JSON.parse(fs.readFileSync(compFile, 'utf8'));
    for (const comp of competitors) {
      if (comp.enabled && enabledTools.includes(comp.name)) {
        const client = new McpStdioClient(comp, repoAbs);
        await client.start(benchDir);
        mcpClients.set(comp.name, client);
      }
    }
  }

  const sampleSizes = {
    t1: quick ? 6 : 20,
    t2: quick ? 8 : 30,
    t3: quick ? 6 : 20,
    t4: quick ? 5 : 15,
  };

  // -------------------------------------------------------------------------
  // T1: File Outline
  // -------------------------------------------------------------------------
  const candidateFilesForT1: string[] = [];
  const declCache = new Map<string, GroundTruthDeclaration[]>();

  for (const rel of sourceRels) {
    try {
      const decls = gt.declarations(rel);
      declCache.set(rel, decls);
      if (decls.length >= 3) {
        candidateFilesForT1.push(rel);
      }
    } catch {
      // Skip files that fail AST parsing
    }
  }

  const sampledFilesT1 = deterministicSample(candidateFilesForT1, sampleSizes.t1, (f) => f, 20261108);

  const t1Metrics: Record<
    string,
    { recalls: number[]; tokens: number[]; latencies: number[]; skipped: number }
  > = {};
  const activeT1Tools = [
    ...(kvx ? ['kvx'] : []),
    ...(baseline ? ['baseline'] : []),
    ...Array.from(mcpClients.keys()),
  ];

  for (const tool of activeT1Tools) {
    t1Metrics[tool] = { recalls: [], tokens: [], latencies: [], skipped: 0 };
  }

  for (const file of sampledFilesT1) {
    let gtDecls = declCache.get(file);
    if (!gtDecls) {
      try {
        gtDecls = gt.declarations(file);
        declCache.set(file, gtDecls);
      } catch {
        for (const t of activeT1Tools) t1Metrics[t].skipped++;
        continue;
      }
    }

    if (gtDecls.length === 0) continue;

    // Evaluate kvx
    if (kvx) {
      const t0 = performance.now();
      try {
        const out = kvx.outline(file);
        const lat = performance.now() - t0;
        let matched = 0;
        for (const g of gtDecls) {
          if (out.symbols.some((s) => s.name === g.name && Math.abs(s.startLine - g.startLine) <= 1)) {
            matched++;
          }
        }
        t1Metrics['kvx'].recalls.push(matched / gtDecls.length);
        t1Metrics['kvx'].tokens.push(out.tokens);
        t1Metrics['kvx'].latencies.push(lat);
      } catch {
        t1Metrics['kvx'].skipped++;
      }
    }

    // Evaluate baseline
    if (baseline) {
      const t0 = performance.now();
      try {
        const out = baseline.outline(file);
        const lat = performance.now() - t0;
        t1Metrics['baseline'].recalls.push(out.recall);
        t1Metrics['baseline'].tokens.push(out.tokens);
        t1Metrics['baseline'].latencies.push(lat);
      } catch {
        t1Metrics['baseline'].skipped++;
      }
    }

    // Evaluate MCP clients
    for (const [name, client] of mcpClients) {
      const t0 = performance.now();
      try {
        const out = await client.outline(file);
        const lat = performance.now() - t0;
        let matched = 0;
        for (const g of gtDecls) {
          if (out.symbols.some((s: any) => s.name === g.name && Math.abs(s.startLine - g.startLine) <= 1)) {
            matched++;
          }
        }
        t1Metrics[name].recalls.push(matched / gtDecls.length);
        t1Metrics[name].tokens.push(out.tokens);
        t1Metrics[name].latencies.push(lat);
      } catch {
        t1Metrics[name].skipped++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // T2: Read Symbol
  // -------------------------------------------------------------------------
  interface T2Candidate {
    file: string;
    name: string;
    qualified: string;
    kind: string;
    startLine: number;
    endLine: number;
  }

  const candidateSymbolsForT2: T2Candidate[] = [];
  for (const rel of sourceRels) {
    const decls = declCache.get(rel) ?? [];
    for (const d of decls) {
      if (d.kind === 'function' || d.kind === 'class' || d.kind === 'method') {
        candidateSymbolsForT2.push({
          file: rel,
          name: d.name,
          qualified: d.qualified,
          kind: d.kind,
          startLine: d.startLine,
          endLine: d.endLine,
        });
      }
    }
  }

  const sampledSymbolsT2 = deterministicSample(
    candidateSymbolsForT2,
    sampleSizes.t2,
    (s) => `${s.file}#${s.qualified}`,
    20261108
  );

  const t2Metrics: Record<
    string,
    { exactMatches: number; within1Matches: number; tokens: number[]; latencies: number[]; total: number; skipped: number }
  > = {};
  for (const tool of activeT1Tools) {
    t2Metrics[tool] = { exactMatches: 0, within1Matches: 0, tokens: [], latencies: [], total: 0, skipped: 0 };
  }

  for (const sym of sampledSymbolsT2) {
    // kvx
    if (kvx) {
      const t0 = performance.now();
      try {
        const res = kvx.readSymbol(sym.file, sym.qualified, sym.startLine);
        const lat = performance.now() - t0;
        t2Metrics['kvx'].total++;
        t2Metrics['kvx'].tokens.push(res.tokens);
        t2Metrics['kvx'].latencies.push(lat);
        if (res.match) {
          if (res.match.startLine === sym.startLine && res.match.endLine === sym.endLine) {
            t2Metrics['kvx'].exactMatches++;
          }
          if (
            Math.abs(res.match.startLine - sym.startLine) <= 1 &&
            Math.abs(res.match.endLine - sym.endLine) <= 1
          ) {
            t2Metrics['kvx'].within1Matches++;
          }
        }
      } catch {
        t2Metrics['kvx'].skipped++;
      }
    }

    // baseline
    if (baseline) {
      const t0 = performance.now();
      try {
        const res = baseline.readSymbol(sym.file, sym.qualified);
        const lat = performance.now() - t0;
        t2Metrics['baseline'].total++;
        t2Metrics['baseline'].tokens.push(res.tokens);
        t2Metrics['baseline'].latencies.push(lat);
      } catch {
        t2Metrics['baseline'].skipped++;
      }
    }

    // MCP clients
    for (const [name, client] of mcpClients) {
      const t0 = performance.now();
      try {
        const res = await client.readSymbol(sym.file, sym.qualified);
        const lat = performance.now() - t0;
        t2Metrics[name].total++;
        t2Metrics[name].tokens.push(res.tokens);
        t2Metrics[name].latencies.push(lat);
        if (res.match) {
          if (res.match.startLine === sym.startLine && res.match.endLine === sym.endLine) {
            t2Metrics[name].exactMatches++;
          }
          if (
            Math.abs(res.match.startLine - sym.startLine) <= 1 &&
            Math.abs(res.match.endLine - sym.endLine) <= 1
          ) {
            t2Metrics[name].within1Matches++;
          }
        }
      } catch {
        t2Metrics[name].skipped++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // T3: References
  // -------------------------------------------------------------------------
  interface T3Candidate {
    file: string;
    name: string;
    qualified: string;
    startLine: number;
    gtReferences: Array<{ file: string; line: number }>;
  }

  const candidateSymbolsForT3: T3Candidate[] = [];
  for (const rel of sourceRels) {
    const decls = declCache.get(rel) ?? [];
    const seenQualified = new Set<string>();
    for (const d of decls) {
      if (d.exported) {
        if (seenQualified.has(d.qualified)) continue;
        seenQualified.add(d.qualified);
        try {
          // Declaration merging (`type X` + `const X` in one file): name-based tools answer for
          // the name, so the ground truth is the union of the references of every merged part.
          const merged = decls.filter((o) => o.qualified === d.qualified && o.kind !== 'method' && d.kind !== 'method');
          const parts = merged.length > 1 ? merged : [d];
          const byKey = new Map<string, { file: string; line: number }>();
          for (const part of parts) {
            for (const r of gt.references(rel, part.name, part.startLine)) byKey.set(`${r.file}:${r.line}`, r);
          }
          // a merged part's own declaration line is not a usage of the other part
          for (const part of parts) byKey.delete(`${rel}:${part.startLine}`);
          const refs = [...byKey.values()];
          if (refs.length >= 1) {
            candidateSymbolsForT3.push({
              file: rel,
              name: d.name,
              qualified: d.qualified,
              startLine: d.startLine,
              gtReferences: refs,
            });
          }
        } catch {}
      }
    }
  }

  const sampledSymbolsT3 = deterministicSample(
    candidateSymbolsForT3,
    sampleSizes.t3,
    (s) => `${s.file}#${s.qualified}`,
    20261108
  );

  const t3Metrics: Record<
    string,
    {
      allMetrics: SetMetrics[];
      confMetrics: SetMetrics[];
      tokens: number[];
      latencies: number[];
      skipped: number;
    }
  > = {};
  for (const tool of activeT1Tools) {
    t3Metrics[tool] = { allMetrics: [], confMetrics: [], tokens: [], latencies: [], skipped: 0 };
  }

  for (const sym of sampledSymbolsT3) {
    const gtSet = new Set(sym.gtReferences.map((r) => `${r.file}:${r.line}`));

    // kvx
    if (kvx) {
      const t0 = performance.now();
      try {
        const res = kvx.references(sym.file, sym.qualified, sym.startLine);
        const lat = performance.now() - t0;
        const allSet = new Set(res.references.map((r) => `${r.relPath}:${r.line}`).filter(inUniverse));
        const confSet = new Set(res.confidentReferences.map((r) => `${r.relPath}:${r.line}`).filter(inUniverse));

        t3Metrics['kvx'].allMetrics.push(computeMetrics(allSet, gtSet));
        t3Metrics['kvx'].confMetrics.push(computeMetrics(confSet, gtSet));
        t3Metrics['kvx'].tokens.push(res.tokens);
        t3Metrics['kvx'].latencies.push(lat);
      } catch {
        t3Metrics['kvx'].skipped++;
      }
    }

    // baseline
    if (baseline) {
      const t0 = performance.now();
      try {
        const res = baseline.references(sym.name);
        const lat = performance.now() - t0;
        // Exclude definition line
        const baseSet = new Set(
          res.references
            .filter((r) => !(r.file === sym.file && r.line === sym.startLine))
            .map((r) => `${r.file}:${r.line}`)
        );
        const metrics = computeMetrics(baseSet, gtSet);
        t3Metrics['baseline'].allMetrics.push(metrics);
        t3Metrics['baseline'].confMetrics.push(metrics);
        t3Metrics['baseline'].tokens.push(res.tokens);
        t3Metrics['baseline'].latencies.push(lat);
      } catch {
        t3Metrics['baseline'].skipped++;
      }
    }

    // MCP clients
    for (const [name, client] of mcpClients) {
      const t0 = performance.now();
      try {
        const res = await client.references(sym.file, sym.qualified);
        const lat = performance.now() - t0;
        const allSet = new Set(res.references.map((r) => `${r.relPath}:${r.line}`).filter(inUniverse));
        const confSet = new Set(res.confidentReferences.map((r) => `${r.relPath}:${r.line}`).filter(inUniverse));

        t3Metrics[name].allMetrics.push(computeMetrics(allSet, gtSet));
        t3Metrics[name].confMetrics.push(computeMetrics(confSet, gtSet));
        t3Metrics[name].tokens.push(res.tokens);
        t3Metrics[name].latencies.push(lat);
      } catch {
        t3Metrics[name].skipped++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // T4: Importers
  // -------------------------------------------------------------------------
  const candidateFilesForT4: Array<{ file: string; gtImporters: string[] }> = [];
  for (const rel of sourceRels) {
    try {
      const imps = gt.importers(rel);
      if (imps.length >= 1) {
        candidateFilesForT4.push({ file: rel, gtImporters: imps });
      }
    } catch {}
  }

  const sampledFilesT4 = deterministicSample(
    candidateFilesForT4,
    sampleSizes.t4,
    (item) => item.file,
    20261108
  );

  const t4Metrics: Record<
    string,
    { metrics: SetMetrics[]; tokens: number[]; latencies: number[]; skipped: number }
  > = {
    kvx: { metrics: [], tokens: [], latencies: [], skipped: 0 },
  };

  for (const item of sampledFilesT4) {
    const gtSet = new Set(item.gtImporters);
    if (kvx) {
      const t0 = performance.now();
      try {
        const res = kvx.importers(item.file);
        const lat = performance.now() - t0;
        const toolSet = new Set(res.transitiveFiles.filter(inUniverse));
        t4Metrics['kvx'].metrics.push(computeMetrics(toolSet, gtSet));
        t4Metrics['kvx'].tokens.push(res.tokens);
        t4Metrics['kvx'].latencies.push(lat);
      } catch {
        t4Metrics['kvx'].skipped++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // T5: Schema Cost
  // -------------------------------------------------------------------------
  const t5Metrics: Record<string, number> = {};
  if (kvx) {
    const s = kvx.schemaTokens();
    t5Metrics['kvx-full'] = s.fullTokens;
    t5Metrics['kvx-ro'] = s.roTokens;
  }
  for (const [name, client] of mcpClients) {
    try {
      t5Metrics[name] = await client.schemaTokens();
    } catch {}
  }

  // Teardown adapters
  if (kvx) kvx.close();
  for (const client of mcpClients.values()) {
    client.close();
  }

  // -------------------------------------------------------------------------
  // Build Reports (Markdown & JSON)
  // -------------------------------------------------------------------------
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  // Markdown Summary
  const mdLines: string[] = [];
  mdLines.push(`# Benchmark Results: ${repoConfig.name}`);
  mdLines.push('');
  mdLines.push(`- **Commit**: \`${repoCommit}\``);
  mdLines.push(`- **Date**: ${new Date().toISOString().slice(0, 10)}`);
  if (kvx) {
    mdLines.push(`- **Kvx Index Time**: ${kvxIndexMs} ms`);
  }
  mdLines.push(`- **Mode**: ${quick ? 'Quick (--quick)' : 'Full'}`);
  mdLines.push('');

  mdLines.push('## T1: Outline Recall & Cost');
  mdLines.push('| Tool | Recall | Avg Tokens | Latency p50 (ms) | Latency p95 (ms) |');
  mdLines.push('|---|---|---|---|---|');
  for (const tool of activeT1Tools) {
    const m = t1Metrics[tool];
    const recStr = (avg(m.recalls) * 100).toFixed(1) + '%';
    const tokStr = Math.round(avg(m.tokens)).toString();
    const p50 = percentile(m.latencies, 50).toFixed(1);
    const p95 = percentile(m.latencies, 95).toFixed(1);
    mdLines.push(`| ${tool} | ${recStr} | ${tokStr} | ${p50} | ${p95} |`);
  }
  mdLines.push('');

  mdLines.push('## T2: Read Symbol Accuracy & Cost');
  mdLines.push('| Tool | Exact Range | Within 1 Line | Avg Tokens | Savings vs Baseline | Latency p50 (ms) | Latency p95 (ms) |');
  mdLines.push('|---|---|---|---|---|---|---|');
  const baseAvgTokens = baseline && t2Metrics['baseline']?.tokens.length ? avg(t2Metrics['baseline'].tokens) : 0;
  for (const tool of activeT1Tools) {
    const m = t2Metrics[tool];
    const exactStr = m.total ? ((m.exactMatches / m.total) * 100).toFixed(1) + '%' : '0.0%';
    const within1Str = m.total ? ((m.within1Matches / m.total) * 100).toFixed(1) + '%' : '0.0%';
    const avgTok = avg(m.tokens);
    const tokStr = Math.round(avgTok).toString();
    const savingsStr =
      tool === 'baseline' || baseAvgTokens === 0
        ? '0.0%'
        : (((baseAvgTokens - avgTok) / baseAvgTokens) * 100).toFixed(1) + '%';
    const p50 = percentile(m.latencies, 50).toFixed(1);
    const p95 = percentile(m.latencies, 95).toFixed(1);
    mdLines.push(`| ${tool} | ${exactStr} | ${within1Str} | ${tokStr} | ${savingsStr} | ${p50} | ${p95} |`);
  }
  mdLines.push('');

  mdLines.push('## T3: References Quality & Cost');
  mdLines.push('| Tool | Subset | Precision | Recall | F1 | Avg Tokens | Latency p50 (ms) | Latency p95 (ms) |');
  mdLines.push('|---|---|---|---|---|---|---|---|');
  for (const tool of activeT1Tools) {
    const m = t3Metrics[tool];
    const tokStr = Math.round(avg(m.tokens)).toString();
    const p50 = percentile(m.latencies, 50).toFixed(1);
    const p95 = percentile(m.latencies, 95).toFixed(1);

    if (tool === 'baseline') {
      const p = (avg(m.allMetrics.map((x) => x.precision)) * 100).toFixed(1) + '%';
      const r = (avg(m.allMetrics.map((x) => x.recall)) * 100).toFixed(1) + '%';
      const f1 = (avg(m.allMetrics.map((x) => x.f1)) * 100).toFixed(1) + '%';
      mdLines.push(`| baseline | git grep | ${p} | ${r} | ${f1} | ${tokStr} | ${p50} | ${p95} |`);
    } else {
      const pAll = (avg(m.allMetrics.map((x) => x.precision)) * 100).toFixed(1) + '%';
      const rAll = (avg(m.allMetrics.map((x) => x.recall)) * 100).toFixed(1) + '%';
      const f1All = (avg(m.allMetrics.map((x) => x.f1)) * 100).toFixed(1) + '%';
      mdLines.push(`| ${tool} | all | ${pAll} | ${rAll} | ${f1All} | ${tokStr} | ${p50} | ${p95} |`);

      const pConf = (avg(m.confMetrics.map((x) => x.precision)) * 100).toFixed(1) + '%';
      const rConf = (avg(m.confMetrics.map((x) => x.recall)) * 100).toFixed(1) + '%';
      const f1Conf = (avg(m.confMetrics.map((x) => x.f1)) * 100).toFixed(1) + '%';
      mdLines.push(`| ${tool} | confident (no name_only) | ${pConf} | ${rConf} | ${f1Conf} | ${tokStr} | ${p50} | ${p95} |`);
    }
  }
  mdLines.push('');

  mdLines.push('## T4: Transitive Importers (Blast Radius)');
  mdLines.push('| Tool | Precision | Recall | F1 | Avg Tokens | Latency p50 (ms) | Latency p95 (ms) |');
  mdLines.push('|---|---|---|---|---|---|---|');
  if (kvx) {
    const m = t4Metrics['kvx'];
    const p = (avg(m.metrics.map((x) => x.precision)) * 100).toFixed(1) + '%';
    const r = (avg(m.metrics.map((x) => x.recall)) * 100).toFixed(1) + '%';
    const f1 = (avg(m.metrics.map((x) => x.f1)) * 100).toFixed(1) + '%';
    const tok = Math.round(avg(m.tokens)).toString();
    const p50 = percentile(m.latencies, 50).toFixed(1);
    const p95 = percentile(m.latencies, 95).toFixed(1);
    mdLines.push(`| kvx | ${p} | ${r} | ${f1} | ${tok} | ${p50} | ${p95} |`);
  }
  if (baseline) {
    mdLines.push(`| baseline | n/a | n/a | n/a | n/a | n/a | n/a |`);
  }
  mdLines.push('');

  mdLines.push('## T5: MCP Schema Cost');
  mdLines.push('| Server / Tool | Schema Tokens (chars/4) |');
  mdLines.push('|---|---|');
  for (const [k, v] of Object.entries(t5Metrics)) {
    mdLines.push(`| ${k} | ${v} |`);
  }
  mdLines.push('');

  mdLines.push('## Method');
  mdLines.push('- **Ground Truth**: TypeScript 5.9.3 Language Service, with the repository tsconfig.json when present.');
  mdLines.push('- **Fairness**: answers are compared only inside the ground-truth universe (files under the configured roots); for declaration-merged names (a type and a value with the same name in one file) the reference ground truth is the union of both.');
  mdLines.push('- **Token Cost**: Approximated as `Math.ceil(chars / 4)`.');
  mdLines.push('- **PRNG Seed**: `20261108` (Mulberry32).');
  mdLines.push(`- **Sample Sizes**: T1=${sampledFilesT1.length}, T2=${sampledSymbolsT2.length}, T3=${sampledSymbolsT3.length}, T4=${sampledFilesT4.length}.`);
  mdLines.push(`- **Repo Commit**: \`${repoCommit}\`.`);
  mdLines.push('');

  const reportMd = mdLines.join('\n');

  const fullResult = {
    repo: repoConfig.name,
    commit: repoCommit,
    date: new Date().toISOString().slice(0, 10),
    indexMs: kvxIndexMs,
    sampleSizes,
    t1: t1Metrics,
    t2: t2Metrics,
    t3: t3Metrics,
    t4: t4Metrics,
    t5: t5Metrics,
  };

  return { reportMd, fullResult };
}

async function main(): Promise<void> {
  const { repo: requestedRepo, enabledTools, quick } = parseCliArgs();

  const reposJsonPath = path.join(benchDir, 'repos.json');
  if (!fs.existsSync(reposJsonPath)) {
    console.error(`repos.json not found at ${reposJsonPath}`);
    process.exit(1);
  }

  const allRepos: RepoConfig[] = JSON.parse(fs.readFileSync(reposJsonPath, 'utf8'));
  const targetRepos =
    requestedRepo === 'all'
      ? allRepos
      : allRepos.filter((r) => r.name.toLowerCase() === requestedRepo.toLowerCase());

  if (targetRepos.length === 0) {
    console.error(`Repository '${requestedRepo}' not found in repos.json`);
    process.exit(1);
  }

  const resultsDir = path.join(benchDir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);

  for (const r of targetRepos) {
    const repoAbs = path.resolve(benchDir, r.path);
    if (!fs.existsSync(repoAbs)) {
      if (r.name === 'zod') {
        const commit = r.commit || '19c40d2072288b4cafec851e9d056a72a88e5973';
        console.log(`Skipping zod: repository directory ${r.path} is missing.`);
        console.log(`To clone it, run:`);
        console.log(`git clone https://github.com/colinhacks/zod.git bench/.cache/repos/zod && git -C bench/.cache/repos/zod checkout ${commit}`);
        continue;
      }
      console.warn(`Skipping ${r.name}: path ${r.path} does not exist`);
      continue;
    }

    const { reportMd, fullResult } = await runBenchmarkForRepo(r, enabledTools, quick);

    const jsonPath = path.join(resultsDir, `${r.name}-${today}.json`);
    const mdPath = path.join(resultsDir, `${r.name}-${today}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(fullResult, null, 2), 'utf8');
    fs.writeFileSync(mdPath, reportMd, 'utf8');

    // Print summary to stdout
    process.stdout.write(reportMd + '\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
