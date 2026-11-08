/**
 * In-process adapter for kaxcav-vortex engine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KaxcavVortexEngine } from '../../src/engine.ts';
import { VortexMcpServer } from '../../src/mcp/server.ts';

export interface KvxOutlineSymbol {
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
}

export interface KvxReferenceItem {
  relPath: string;
  line: number;
  confidence: string;
}

export class KvxAdapter {
  storageRoot: string;
  engine: KaxcavVortexEngine;
  repoPath: string;
  indexMs: number;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-bench-'));
    this.engine = new KaxcavVortexEngine(this.storageRoot);

    const t0 = performance.now();
    this.engine.addRepo(this.repoPath);
    this.indexMs = performance.now() - t0;
  }

  outline(rel: string): { symbols: KvxOutlineSymbol[]; tokens: number } {
    const raw = this.engine.fileOutline(this.repoPath, rel, { scope: 'tudo' });
    const rawSymbols = raw.symbols ?? [];
    const symbols: KvxOutlineSymbol[] = rawSymbols
      .filter((s: any) => s.scope !== 'local')
      .map((s: any) => ({
        name: s.name,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
      }));
    const tokens = Math.max(1, Math.ceil(JSON.stringify(symbols).length / 4));
    return { symbols, tokens };
  }

  /**
   * Two declarations with the same qualified name (static + instance member, overloads) are
   * `Name` and `Name~2` in kvx; with the ground-truth start line, pick the right one.
   */
  private resolveQualified(rel: string, qualified: string, startLine?: number): string {
    if (startLine === undefined) return qualified;
    const outline = this.engine.fileOutline(this.repoPath, rel, { scope: 'tudo' });
    const twins = (outline.symbols ?? []).filter(
      (s: any) => s.scope !== 'local' && String(s.qualifiedName).replace(/~\d+$/, '') === qualified,
    );
    if (twins.length < 2) return qualified;
    const best = twins.reduce((a: any, b: any) => (Math.abs(b.startLine - startLine) < Math.abs(a.startLine - startLine) ? b : a));
    return String(best.qualifiedName);
  }

  readSymbol(rel: string, qualified: string, startLine?: number): {
    match: { startLine: number; endLine: number; sliceText: string } | null;
    tokens: number;
  } {
    const slices = this.engine.readSymbol(this.repoPath, `${rel}#${this.resolveQualified(rel, qualified, startLine)}`);
    const first = slices && slices.length > 0
      ? { startLine: slices[0].startLine, endLine: slices[0].endLine, sliceText: slices[0].sliceText }
      : null;
    const tokens = Math.max(1, Math.ceil(JSON.stringify(first).length / 4));
    return { match: first, tokens };
  }

  references(rel: string, qualified: string, startLine?: number): {
    ok: boolean;
    references: KvxReferenceItem[];
    confidentReferences: KvxReferenceItem[];
    tokens: number;
  } {
    const res = this.engine.findReferences(this.repoPath, `${rel}#${this.resolveQualified(rel, qualified, startLine)}`, { limit: 1000 });
    const rawRefs = res.references ?? [];
    const references: KvxReferenceItem[] = rawRefs.map((r: any) => ({
      relPath: r.relPath.replace(/\\/g, '/'),
      line: r.line,
      confidence: r.confidence,
    }));
    const confidentReferences = references.filter((r) => r.confidence !== 'name_only');
    const tokens = Math.max(1, Math.ceil(JSON.stringify(res).length / 4));
    return {
      ok: Boolean(res.ok),
      references,
      confidentReferences,
      tokens,
    };
  }

  importers(rel: string): { transitiveFiles: string[]; tokens: number } {
    const report = this.engine.blastRadius(this.repoPath, rel);
    const transitiveFiles = (report.transitiveFiles ?? []).map((f: string) => f.replace(/\\/g, '/'));
    const tokens = Math.max(1, Math.ceil(JSON.stringify(transitiveFiles).length / 4));
    return { transitiveFiles, tokens };
  }

  schemaTokens(): { fullTokens: number; roTokens: number } {
    const s1 = new VortexMcpServer(this.engine, () => {});
    const r1 = s1.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const fullTokens = Math.max(1, Math.ceil(JSON.stringify(r1).length / 4));

    const s2 = new VortexMcpServer(this.engine, () => {}, { readOnly: true });
    const r2 = s2.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const roTokens = Math.max(1, Math.ceil(JSON.stringify(r2).length / 4));

    return { fullTokens, roTokens };
  }

  close(): void {
    try {
      this.engine.close();
    } catch {}
    try {
      fs.rmSync(this.storageRoot, { recursive: true, force: true });
    } catch {}
  }
}
