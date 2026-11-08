/**
 * Adapters for competing code-intelligence MCP servers. Each one starts the server over stdio,
 * builds its index the way that tool documents, calls its own outline / read-symbol /
 * references tools and normalizes the answers to the harness shape. Tasks a tool does not
 * offer throw `Unsupported` (the harness counts them as not answered, never as wrong).
 *
 * Executables are looked up where their installers put them on Windows; override with
 * BENCH_<NAME>_CMD (e.g. BENCH_SERENA_CMD) when they live elsewhere.
 */

import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { McpStdioClient } from './mcp-stdio.ts';

export class Unsupported extends Error {}

type Sym = { name: string; qualifiedName?: string; startLine?: number; endLine?: number };
type Ref = { relPath: string; line: number; confidence?: string };
type Match = { startLine: number; endLine: number } | null;

const tok = (x: unknown) => Math.max(1, Math.ceil((typeof x === 'string' ? x : JSON.stringify(x)).length / 4));
const textOf = (res: any): string => (res?.content ?? []).map((c: any) => c.text ?? '').join('\n');
const slash = (p: string) => p.replace(/\\/g, '/');
const home = os.homedir();
const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
const exe = (name: string, fallback: string) => process.env[`BENCH_${name.toUpperCase()}_CMD`] ?? fallback;

/** Minimal CSV parser (quotes, doubled quotes, newlines inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export abstract class CompetitorAdapter {
  readonly name: string;
  readonly repoPath: string;
  readonly client: McpStdioClient;
  indexMs = 0;
  /** true when outline() returns no line numbers (recall is then measured by name only). */
  outlineWithoutLines = false;
  /** Build the index before the MCP server starts (tools that index from a CLI). */
  protected prepareBeforeStart = false;

  constructor(name: string, command: string, args: string[], repoPath: string) {
    this.name = name;
    this.repoPath = path.resolve(repoPath);
    // cwd inside the benchmarked repo: tools that keep per-project state in the working
    // directory (e.g. SymForge's .symforge/) must never write into the harness checkout.
    this.client = new McpStdioClient({ name, enabled: true, command, args, cwd: this.repoPath, tools: {} }, this.repoPath);
  }

  protected async call(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<{ raw: any; text: string }> {
    const raw = await this.client.callMethod('tools/call', { name: tool, arguments: args }, timeoutMs);
    const text = textOf(raw);
    if (raw?.isError) throw new Error(`${this.name}.${tool}: ${text.slice(0, 300)}`);
    return { raw, text };
  }

  protected relOf(p: string): string {
    const n = slash(p);
    const root = slash(this.repoPath);
    return n.toLowerCase().startsWith(root.toLowerCase() + '/') ? n.slice(root.length + 1) : n.replace(/^\.\//, '');
  }

  async start(benchDir: string): Promise<void> {
    if (!this.prepareBeforeStart) await this.client.start(benchDir);
    const t0 = performance.now();
    await this.prepare();
    this.indexMs = Math.round(performance.now() - t0);
    if (this.prepareBeforeStart) await this.client.start(benchDir);
  }

  protected async prepare(): Promise<void> {}
  schemaTokens(): Promise<number> {
    return this.client.schemaTokens();
  }
  close(): void {
    this.client.close();
  }

  abstract outline(rel: string): Promise<{ symbols: Sym[]; tokens: number }>;
  abstract readSymbol(rel: string, qualified: string, startLine?: number): Promise<{ match: Match; tokens: number }>;
  abstract references(
    rel: string,
    qualified: string,
    startLine?: number,
  ): Promise<{ ok: boolean; references: Ref[]; confidentReferences: Ref[]; tokens: number }>;

  protected refsResult(refs: Ref[], text: string) {
    const seen = new Set<string>();
    const references = refs.filter((r) => {
      const k = `${r.relPath}:${r.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ok: true, references, confidentReferences: references, tokens: tok(text) };
  }
}

// ---------------------------------------------------------------------------- Serena (LSP)

class SerenaAdapter extends CompetitorAdapter {
  constructor(repo: string) {
    super(
      'serena',
      exe('serena', path.join(home, '.local', 'bin', 'serena.exe')),
      ['start-mcp-server', '--project', path.resolve(repo), '--agent-interface', 'tools', '--enable-web-dashboard', 'False'],
      repo,
    );
    this.outlineWithoutLines = true;
  }

  async outline(rel: string) {
    const { text } = await this.call('get_symbols_overview', { relative_path: rel, depth: 1 });
    const symbols: Sym[] = [];
    const walk = (node: unknown) => {
      if (typeof node === 'string') symbols.push({ name: node });
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          // {"Function": [...]} groups by kind; {"name": {"Method": [...]}} is a symbol with children
          if (/^[A-Z][A-Za-z]*$/.test(k) && Array.isArray(v)) walk(v);
          else {
            symbols.push({ name: k });
            walk(v);
          }
        }
      }
    };
    walk(JSON.parse(text));
    return { symbols, tokens: tok(text) };
  }

  async readSymbol(rel: string, qualified: string) {
    const namePath = qualified.replace(/\./g, '/');
    const { text } = await this.call('find_symbol', { name_path_pattern: namePath, relative_path: rel, include_body: true });
    const arr = JSON.parse(text) as Array<{ name_path: string; body_location?: { start_line: number; end_line: number } }>;
    const hit = arr.find((e) => e.name_path === namePath) ?? arr[0];
    // LSP lines are 0-based
    const match = hit?.body_location ? { startLine: hit.body_location.start_line + 1, endLine: hit.body_location.end_line + 1 } : null;
    return { match, tokens: tok(text) };
  }

  async references(rel: string, qualified: string) {
    const { text } = await this.call('find_referencing_symbols', { name_path: qualified.replace(/\./g, '/'), relative_path: rel });
    const refs: Ref[] = [];
    const byFile = JSON.parse(text) as Record<string, Record<string, Array<{ content_around_reference?: string }>>>;
    for (const [file, groups] of Object.entries(byFile)) {
      for (const entries of Object.values(groups)) {
        for (const e of entries) {
          for (const m of (e.content_around_reference ?? '').matchAll(/^\s*>\s*(\d+):/gm)) {
            refs.push({ relPath: slash(file), line: Number(m[1]) + 1 });
          }
        }
      }
    }
    return this.refsResult(refs, text);
  }
}

// ---------------------------------------------------------------------------- jCodeMunch

class JCodeMunchAdapter extends CompetitorAdapter {
  private repoId = '';
  private outlines = new Map<string, Array<{ id: string; name: string; line: number; end: number }>>();

  constructor(repo: string) {
    super('jcodemunch', exe('jcodemunch', path.join(home, '.local', 'bin', 'jcodemunch-mcp.exe')), ['serve'], repo);
  }

  protected async prepare() {
    const { text } = await this.call('order', { action: 'index_folder', args: { path: this.repoPath }, allow_state_change: true }, 1_800_000);
    this.repoId = JSON.parse(text).repo;
  }

  /** `#MUNCH/1` outline: `@n=id` aliases, then `s,id,name,kind,signature,line,end_line,parent,summary` rows. */
  private parseOutline(text: string) {
    const aliases = new Map<string, string>();
    for (const m of text.matchAll(/^(@\d+)=(.+)$/gm)) aliases.set(m[1], m[2].trim());
    const start = text.search(/^s,/m);
    const rows = start >= 0 ? parseCsv(text.slice(start)) : [];
    return rows
      .filter((r) => r[0] === 's' && r.length >= 7)
      .map((r) => ({ id: aliases.get(r[1]) ?? r[1], name: r[2], line: Number(r[5]), end: Number(r[6]) }));
  }

  async outline(rel: string) {
    const { text } = await this.call('order', { action: 'get_file_outline', args: { repo: this.repoId, file_path: rel } });
    const rows = this.parseOutline(text);
    this.outlines.set(rel, rows);
    return { symbols: rows.map((r) => ({ name: r.name, startLine: r.line, endLine: r.end })), tokens: tok(text) };
  }

  async readSymbol(rel: string, qualified: string) {
    // The symbol id needs the kind (`file::Name#function`): resolved from the file outline
    // (not counted in tokens: an agent would get it from a previous search/outline).
    if (!this.outlines.has(rel)) await this.outline(rel);
    const rows = this.outlines.get(rel) ?? [];
    const id = rows.find((r) => r.id.split('::')[1]?.replace(/#.*$/, '') === qualified)?.id;
    if (!id) return { match: null, tokens: 1 };
    const { text } = await this.call('order', { action: 'get_symbol_source', args: { repo: this.repoId, symbol_id: id } });
    const j = JSON.parse(text);
    return { match: typeof j.line === 'number' ? { startLine: j.line, endLine: j.end_line } : null, tokens: tok(text) };
  }

  async references(_rel: string, qualified: string) {
    const name = qualified.split('.').pop() ?? qualified;
    const { text } = await this.call('order', { action: 'check_references', args: { repo: this.repoId, identifier: name } });
    const j = JSON.parse(text);
    const refs: Ref[] = [];
    for (const f of j.content_references ?? []) for (const m of f.matches ?? []) refs.push({ relPath: slash(f.file), line: m.line });
    return this.refsResult(refs, text);
  }
}

// ---------------------------------------------------------------------------- codebase-memory-mcp

class CodebaseMemoryAdapter extends CompetitorAdapter {
  private project = '';

  constructor(repo: string) {
    super('codebase-memory', exe('cbm', path.join(localAppData, 'Programs', 'codebase-memory-mcp', 'codebase-memory-mcp.exe')), [], repo);
  }

  protected async prepare() {
    const { text } = await this.call('index_repository', { repo_path: this.repoPath }, 1_800_000);
    this.project = JSON.parse(text).project;
  }

  async outline(rel: string) {
    // pages of at most 200 rows (the tool's limit)
    let all = '';
    const symbols: Sym[] = [];
    for (let offset = 0; offset < 10_000; offset += 200) {
      const { text } = await this.call('get_file_outline', { project: this.project, file_path: rel, format: 'json', limit: 200, offset });
      all += text;
      const rows = (JSON.parse(text) as { rows?: string[][] }).rows ?? [];
      for (const r of rows) {
        const [a, b] = String(r[2] ?? '').split('-').map(Number);
        symbols.push({ name: r[0], startLine: a, endLine: b });
      }
      if (rows.length < 200) break;
    }
    return { symbols, tokens: tok(all) };
  }

  async readSymbol(rel: string, qualified: string) {
    let text = '';
    for (const qn of [qualified, qualified.split('.').pop() ?? qualified]) {
      try {
        text = (await this.call('get_code_snippet', { project: this.project, qualified_name: qn, format: 'json' })).text;
        const j = JSON.parse(text);
        if (j.file_path && !slash(j.file_path).toLowerCase().endsWith(rel.toLowerCase())) continue;
        if (typeof j.start_line === 'number') return { match: { startLine: j.start_line, endLine: j.end_line }, tokens: tok(text) };
      } catch {
        // try the bare name
      }
    }
    return { match: null, tokens: tok(text || '{}') };
  }

  async references(rel: string, qualified: string) {
    // No references tool: the documented way is a Cypher query over the graph edges.
    const name = (qualified.split('.').pop() ?? qualified).replace(/'/g, "\\'");
    const query = `MATCH (a)-[r]->(b) WHERE b.name = '${name}' AND b.file_path = '${rel.replace(/'/g, "\\'")}' RETURN a.file_path, type(r), r`;
    const { text } = await this.call('query_graph', { project: this.project, query, format: 'json', max_rows: 1000 });
    const j = JSON.parse(text) as { rows?: unknown[][] };
    const refs: Ref[] = [];
    for (const row of j.rows ?? []) {
      if (row[1] === 'DEFINES' || row[1] === 'CONTAINS') continue;
      try {
        const r = typeof row[2] === 'string' ? JSON.parse(row[2]) : (row[2] as { line?: number });
        if (typeof r?.line === 'number') refs.push({ relPath: slash(String(row[0])), line: r.line });
      } catch {
        // edge without a line
      }
    }
    return this.refsResult(refs, text);
  }
}

// ---------------------------------------------------------------------------- SymForge

class SymForgeAdapter extends CompetitorAdapter {
  constructor(repo: string) {
    super('symforge', 'node', [exe('symforge', path.join(appData, 'npm', 'node_modules', 'symforge', 'bin', 'symforge.js'))], repo);
  }

  protected async prepare() {
    await this.call('index_folder', { path: this.repoPath }, 1_800_000);
  }

  async outline(rel: string) {
    // The default answer is budget-limited (large files lose symbols): ask for the full outline.
    const { text } = await this.call('get_file_context', { path: rel, sections: ['outline'], max_tokens: 40000 });
    const symbols: Sym[] = [];
    for (const m of text.matchAll(/^\s*(?:[a-z]+)\s+(\S+)\s+L(\d+)-(\d+)\s*$/gm)) symbols.push({ name: m[1], startLine: Number(m[2]), endLine: Number(m[3]) });
    return { symbols, tokens: tok(text) };
  }

  async readSymbol(rel: string, qualified: string) {
    // full body, like every other tool here (the default budget cuts large symbols)
    const { text } = await this.call('get_symbol', { path: rel, name: qualified, max_tokens: 40000 });
    const m = /\[[^\]]*lines (\d+)-(\d+)/.exec(text);
    return { match: m ? { startLine: Number(m[1]), endLine: Number(m[2]) } : null, tokens: tok(text) };
  }

  async references(rel: string, qualified: string) {
    const { text } = await this.call('find_references', { name: qualified.split('.').pop() ?? qualified, path: rel, limit: 1000 });
    const refs: Ref[] = [];
    const anchors = /reference anchors ([^\n]+)/.exec(text)?.[1] ?? '';
    for (const m of anchors.matchAll(/`([^`]+):(\d+)`/g)) refs.push({ relPath: slash(m[1]), line: Number(m[2]) });
    return this.refsResult(refs, text);
  }
}

// ---------------------------------------------------------------------------- GitNexus

class GitNexusAdapter extends CompetitorAdapter {
  private readonly cli: string;

  constructor(repo: string) {
    const cli = exe('gitnexus', path.join(appData, 'npm', 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js'));
    super('gitnexus', 'node', [cli, 'mcp'], repo);
    this.cli = cli;
    this.prepareBeforeStart = true;
  }

  protected async prepare() {
    // `--index-only`: without it, analyze also writes AGENTS.md / CLAUDE.md / hooks into the repo.
    const r = spawnSync('node', [this.cli, 'analyze', '--index-only', this.repoPath], {
      encoding: 'utf8',
      env: { ...process.env, SCARF_ANALYTICS: 'false' },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`gitnexus analyze failed: ${(r.stderr || r.stdout).slice(-400)}`);
  }

  async outline(): Promise<{ symbols: Sym[]; tokens: number }> {
    throw new Unsupported('gitnexus has no file outline tool');
  }

  async readSymbol(rel: string, qualified: string) {
    const name = qualified.split('.').pop() ?? qualified;
    const { text } = await this.call('context', { name, file_path: rel, include_content: true });
    // the JSON is followed by a "---\n**Next:**" hint block
    const s = JSON.parse(text.split(/\n---\n/)[0])?.symbol;
    return { match: s && typeof s.startLine === 'number' ? { startLine: s.startLine, endLine: s.endLine } : null, tokens: tok(text) };
  }

  async references(): Promise<{ ok: boolean; references: Ref[]; confidentReferences: Ref[]; tokens: number }> {
    throw new Unsupported('gitnexus returns callers without line numbers');
  }
}

export const COMPETITORS: Record<string, (repo: string) => CompetitorAdapter> = {
  serena: (repo) => new SerenaAdapter(repo),
  jcodemunch: (repo) => new JCodeMunchAdapter(repo),
  'codebase-memory': (repo) => new CodebaseMemoryAdapter(repo),
  symforge: (repo) => new SymForgeAdapter(repo),
  gitnexus: (repo) => new GitNexusAdapter(repo),
};
