/**
 * Naive "grep + read whole file" baseline adapter.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class BaselineAdapter {
  repoPath: string;
  roots: string[];

  constructor(repoPath: string, roots: string[] = ['src']) {
    this.repoPath = path.resolve(repoPath);
    this.roots = roots;
  }

  outline(rel: string): { content: string; tokens: number; recall: number } {
    const abs = path.resolve(this.repoPath, rel);
    const content = fs.readFileSync(abs, 'utf8');
    const tokens = Math.max(1, Math.ceil(content.length / 4));
    return { content, tokens, recall: 1.0 };
  }

  readSymbol(rel: string, _qualified?: string): { content: string; tokens: number } {
    const abs = path.resolve(this.repoPath, rel);
    const content = fs.readFileSync(abs, 'utf8');
    const tokens = Math.max(1, Math.ceil(content.length / 4));
    return { content, tokens };
  }

  references(name: string): { references: Array<{ file: string; line: number }>; tokens: number } {
    // Run git grep -n -w <name> restricted to roots
    const args = ['grep', '-n', '-w', '-e', name, '--', ...this.roots];
    const res = spawnSync('git', args, {
      cwd: this.repoPath,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = res.stdout ?? '';
    const tokens = Math.max(1, Math.ceil(stdout.length / 4));
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const references: Array<{ file: string; line: number }> = [];

    for (const l of lines) {
      const colon1 = l.indexOf(':');
      if (colon1 === -1) continue;
      const colon2 = l.indexOf(':', colon1 + 1);
      if (colon2 === -1) continue;
      const file = l.slice(0, colon1).replace(/\\/g, '/');
      const lineNum = parseInt(l.slice(colon1 + 1, colon2), 10);
      if (!isNaN(lineNum)) {
        references.push({ file, line: lineNum });
      }
    }

    return { references, tokens };
  }

  importers(_rel: string): null {
    return null; // Not supported
  }
}
