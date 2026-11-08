/**
 * Generic MCP stdio client and adapter.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface CompetitorToolDef {
  tool: string;
  args: Record<string, any>;
}

export interface CompetitorConfig {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  cwd?: string;
  note?: string;
  tools: {
    outline?: CompetitorToolDef;
    readSymbol?: CompetitorToolDef;
    references?: CompetitorToolDef;
  };
}

export class McpStdioClient {
  config: CompetitorConfig;
  repoPath: string;
  child: ChildProcess | null = null;
  private reqId = 0;
  private pending = new Map<number | string, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private rl: readline.Interface | null = null;
  private tempKvxHome: string | null = null;
  private stderrBuf = '';

  constructor(config: CompetitorConfig, repoPath: string) {
    this.config = config;
    this.repoPath = path.resolve(repoPath);
  }

  async start(benchDir: string): Promise<void> {
    const cwd = this.config.cwd ? path.resolve(benchDir, this.config.cwd) : benchDir;
    this.tempKvxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kvx-mcp-bench-'));

    this.child = spawn(this.config.command, this.config.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KVX_HOME: this.tempKvxHome,
      },
    });

    this.child.stderr?.on('data', (chunk) => {
      this.stderrBuf += chunk.toString();
    });

    this.child.on('exit', (code, signal) => {
      const err = new Error(
        `MCP process '${this.config.name}' exited with code ${code} signal ${signal}. Stderr: ${this.stderrBuf}`
      );
      for (const [, h] of this.pending) {
        h.reject(err);
      }
      this.pending.clear();
    });

    this.rl = readline.createInterface({
      input: this.child.stdout!,
      terminal: false,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Content-Length:')) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message || `RPC Error ${msg.error.code}`));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    this.child.on('error', (err) => {
      for (const [, h] of this.pending) {
        h.reject(err);
      }
      this.pending.clear();
    });

    // Initialize MCP protocol
    await this.callMethod('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bench-mcp-client', version: '1.0.0' },
    });

    // Send initialized notification
    this.child.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }) + '\n'
    );
  }

  callMethod(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new Error('MCP client is not running'));
    }
    const id = ++this.reqId;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP method ${method} timed out after ${timeoutMs}ms. Stderr: ${this.stderrBuf}`
          )
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child!.stdin!.write(JSON.stringify(payload) + '\n');
    });
  }

  async toolsList(): Promise<any> {
    return this.callMethod('tools/list', {});
  }

  async schemaTokens(): Promise<number> {
    const list = await this.toolsList();
    return Math.max(1, Math.ceil(JSON.stringify(list).length / 4));
  }

  private resolveArgs(
    templateArgs: Record<string, any>,
    vars: { file: string; absFile: string; symbol: string; name: string }
  ): Record<string, any> {
    const resolved: Record<string, any> = {};
    for (const [k, v] of Object.entries(templateArgs)) {
      if (typeof v === 'string') {
        resolved[k] = v
          .replace(/\{repo\}/g, this.repoPath)
          .replace(/\{file\}/g, vars.file)
          .replace(/\{absFile\}/g, vars.absFile)
          .replace(/\{symbol\}/g, vars.symbol)
          .replace(/\{name\}/g, vars.name);
      } else {
        resolved[k] = v;
      }
    }
    return resolved;
  }

  async outline(rel: string): Promise<{ symbols: any[]; tokens: number }> {
    const toolDef = this.config.tools.outline;
    if (!toolDef) throw new Error(`Competitor ${this.config.name} does not define outline tool`);

    const absFile = path.resolve(this.repoPath, rel);
    const args = this.resolveArgs(toolDef.args, { file: rel, absFile, symbol: '', name: '' });
    const raw = await this.callMethod('tools/call', { name: toolDef.tool, arguments: args });
    const tokens = Math.max(1, Math.ceil(JSON.stringify(raw).length / 4));

    let parsed: any = raw;
    if (raw?.content?.[0]?.text) {
      try {
        parsed = JSON.parse(raw.content[0].text);
      } catch {}
    }
    const rawSymbols = parsed.symbols ?? (Array.isArray(parsed) ? parsed : []);
    const symbols = rawSymbols
      .filter((s: any) => s.scope !== 'local')
      .map((s: any) => ({
        name: s.name,
        qualifiedName: s.qualifiedName ?? s.name,
        startLine: s.startLine,
        endLine: s.endLine,
      }));

    return { symbols, tokens };
  }

  async readSymbol(rel: string, qualified: string): Promise<{
    match: { startLine: number; endLine: number; sliceText?: string } | null;
    tokens: number;
  }> {
    const toolDef = this.config.tools.readSymbol;
    if (!toolDef) throw new Error(`Competitor ${this.config.name} does not define readSymbol tool`);

    const absFile = path.resolve(this.repoPath, rel);
    const bareName = qualified.split('.').pop() ?? qualified;
    const args = this.resolveArgs(toolDef.args, { file: rel, absFile, symbol: qualified, name: bareName });
    const raw = await this.callMethod('tools/call', { name: toolDef.tool, arguments: args });
    const tokens = Math.max(1, Math.ceil(JSON.stringify(raw).length / 4));

    let parsed: any = raw;
    if (raw?.content?.[0]?.text) {
      try {
        parsed = JSON.parse(raw.content[0].text);
      } catch {}
    }

    let match: any = null;
    if (Array.isArray(parsed) && parsed.length > 0) {
      match = { startLine: parsed[0].startLine, endLine: parsed[0].endLine, sliceText: parsed[0].sliceText };
    } else if (parsed && typeof parsed.startLine === 'number') {
      match = { startLine: parsed.startLine, endLine: parsed.endLine, sliceText: parsed.sliceText };
    } else if (parsed?.matches?.[0]) {
      match = {
        startLine: parsed.matches[0].startLine,
        endLine: parsed.matches[0].endLine,
        sliceText: parsed.matches[0].sliceText,
      };
    }

    return { match, tokens };
  }

  async references(rel: string, qualified: string): Promise<{
    ok: boolean;
    references: Array<{ relPath: string; line: number; confidence?: string }>;
    confidentReferences: Array<{ relPath: string; line: number; confidence?: string }>;
    tokens: number;
  }> {
    const toolDef = this.config.tools.references;
    if (!toolDef) throw new Error(`Competitor ${this.config.name} does not define references tool`);

    const absFile = path.resolve(this.repoPath, rel);
    const bareName = qualified.split('.').pop() ?? qualified;
    const args = this.resolveArgs(toolDef.args, { file: rel, absFile, symbol: qualified, name: bareName });
    const raw = await this.callMethod('tools/call', { name: toolDef.tool, arguments: args });
    const tokens = Math.max(1, Math.ceil(JSON.stringify(raw).length / 4));

    let parsed: any = raw;
    if (raw?.content?.[0]?.text) {
      try {
        parsed = JSON.parse(raw.content[0].text);
      } catch {}
    }

    const rawRefs = parsed?.references ?? (Array.isArray(parsed) ? parsed : []);
    const references = rawRefs.map((r: any) => ({
      relPath: (r.relPath ?? r.file ?? '').replace(/\\/g, '/'),
      line: r.line,
      confidence: r.confidence,
    }));
    const confidentReferences = references.filter((r: any) => r.confidence !== 'name_only');

    return {
      ok: Boolean(parsed?.ok ?? true),
      references,
      confidentReferences,
      tokens,
    };
  }

  close(): void {
    if (this.rl) {
      try {
        this.rl.close();
      } catch {}
    }
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {}
      try {
        this.child.kill();
      } catch {}
    }
    if (this.tempKvxHome) {
      try {
        fs.rmSync(this.tempKvxHome, { recursive: true, force: true });
      } catch {}
    }
  }
}
