import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * `.kvxignore`: paths no kvx tool may index or read (code tools and `nexus_*` alike).
 *
 * Sources, evaluated in order (last match wins, `!pattern` re-includes):
 *  1. global files: $KVX_IGNORE_FILE, ~/.kvx/kvxignore, ~/.kvxignore
 *  2. every `.kvxignore` found in the target path's ancestors (outermost first)
 *
 * Syntax is gitignore-like: `#` comments, `*`, `**`, `?`, trailing `/` for directories,
 * a pattern containing `/` is anchored to the ignore file's directory, otherwise it
 * matches a path segment at any depth. Global files also accept absolute paths
 * (e.g. `C:\kaxcav\projeto\reference\`).
 */

export const KVXIGNORE_FILENAME = '.kvxignore'

export interface KvxIgnoreVerdict {
  ignored: boolean
  source?: string
  line?: number
  pattern?: string
}

interface Rule {
  raw: string
  negate: boolean
  dirOnly: boolean
  anchored: boolean
  absolute: boolean
  regex: RegExp
  source: string
  line: number
  /** Normalized directory of the ignore file; empty for global relative rules. */
  baseDir: string
}

const IS_WIN = process.platform === 'win32'
const CACHE_TTL_MS = 2_000

const fileRuleCache = new Map<string, { checkedAt: number; mtimeMs: number; rules: Rule[] }>()
const dirHasIgnoreCache = new Map<string, { checkedAt: number; exists: boolean }>()

export function normalizeFsPath(p: string): string {
  let out = resolve(p).replace(/\\/g, '/')
  if (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out)) out = out.slice(0, -1)
  return IS_WIN ? out.toLowerCase() : out
}

export function globalIgnoreFiles(): string[] {
  const list: string[] = []
  if (process.env.KVX_IGNORE_FILE) list.push(process.env.KVX_IGNORE_FILE)
  list.push(join(homedir(), '.kvx', 'kvxignore'), join(homedir(), '.kvxignore'))
  return list
}

function globToRegexBody(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

function parseRules(source: string, text: string, baseDir: string, allowAbsolute: boolean): Rule[] {
  const rules: Rule[] = []
  const lines = text.split(/\r?\n/)
  for (let idx = 0; idx < lines.length; idx++) {
    let raw = lines[idx].trim()
    if (!raw || raw.startsWith('#')) continue
    const negate = raw.startsWith('!')
    if (negate) raw = raw.slice(1).trim()
    let pat = raw.replace(/\\/g, '/')
    const absolute = allowAbsolute && (/^[A-Za-z]:\//.test(pat) || (pat.startsWith('//') && !IS_WIN))
    const dirOnly = pat.endsWith('/')
    if (dirOnly) pat = pat.replace(/\/+$/, '')
    if (!pat) continue
    if (absolute) {
      pat = normalizeFsPath(pat)
    } else if (IS_WIN) {
      pat = pat.toLowerCase()
    }
    const anchored = absolute || pat.replace(/^\//, '').includes('/') || pat.startsWith('/')
    pat = absolute ? pat : pat.replace(/^\//, '')
    const body = globToRegexBody(pat)
    rules.push({
      raw: lines[idx].trim(),
      negate,
      dirOnly,
      anchored,
      absolute,
      regex: new RegExp(`^${body}$`),
      source,
      line: idx + 1,
      baseDir,
    })
  }
  return rules
}

function loadRuleFile(path: string, baseDir: string, allowAbsolute: boolean): Rule[] {
  const now = Date.now()
  const cached = fileRuleCache.get(path)
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.rules
  let mtimeMs = -1
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    fileRuleCache.set(path, { checkedAt: now, mtimeMs: -1, rules: [] })
    return []
  }
  if (cached && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now
    return cached.rules
  }
  let rules: Rule[] = []
  try {
    rules = parseRules(path, readFileSync(path, 'utf8'), baseDir, allowAbsolute)
  } catch {
    rules = []
  }
  fileRuleCache.set(path, { checkedAt: now, mtimeMs, rules })
  return rules
}

function dirHasIgnoreFile(dirNative: string): boolean {
  const now = Date.now()
  const cached = dirHasIgnoreCache.get(dirNative)
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.exists
  const exists = existsSync(join(dirNative, KVXIGNORE_FILENAME))
  dirHasIgnoreCache.set(dirNative, { checkedAt: now, exists })
  return exists
}

function collectRules(absNative: string): Rule[] {
  const rules: Rule[] = []
  for (const g of globalIgnoreFiles()) rules.push(...loadRuleFile(g, '', true))
  const ancestors: string[] = []
  let dir = dirname(resolve(absNative))
  for (let guard = 0; guard < 64; guard++) {
    ancestors.unshift(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // The target itself may be a directory holding a .kvxignore (e.g. a repo root).
  ancestors.push(resolve(absNative))
  for (const a of ancestors) {
    if (dirHasIgnoreFile(a)) {
      rules.push(...loadRuleFile(join(a, KVXIGNORE_FILENAME), normalizeFsPath(a), false))
    }
  }
  return rules
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

function ruleMatches(rule: Rule, candidate: string, candidateIsDir: boolean): boolean {
  if (rule.dirOnly && !candidateIsDir) return false
  if (rule.absolute) return rule.regex.test(candidate)
  if (rule.baseDir) {
    if (candidate !== rule.baseDir && !candidate.startsWith(rule.baseDir + '/')) return false
    const rel = candidate.slice(rule.baseDir.length + 1)
    if (!rel) return false
    return rule.anchored ? rule.regex.test(rel) : rule.regex.test(basenameOf(rel))
  }
  if (rule.anchored) {
    const parts = candidate.split('/')
    for (let k = 1; k < parts.length; k++) {
      if (rule.regex.test(parts.slice(k).join('/'))) return true
    }
    return false
  }
  return rule.regex.test(basenameOf(candidate))
}

/** Evaluates `.kvxignore` rules for an absolute path (file or directory). */
export function checkKvxIgnore(absPath: string, isDirectory?: boolean): KvxIgnoreVerdict {
  const rules = collectRules(absPath)
  if (rules.length === 0) return { ignored: false }
  const target = normalizeFsPath(absPath)
  let targetIsDir = isDirectory
  if (targetIsDir === undefined) {
    try {
      targetIsDir = statSync(absPath).isDirectory()
    } catch {
      targetIsDir = false
    }
  }
  // Outermost ancestor first, the target last. Each level gets its own verdict (last matching rule
  // for exactly that path). An ignored directory ignores everything below it — a `!negation`
  // deeper down cannot re-include (same as .gitignore, and what the indexer's directory pruning does).
  const chain: Array<{ path: string; isDir: boolean }> = []
  let cur = target
  for (let guard = 0; guard < 64; guard++) {
    const i = cur.lastIndexOf('/')
    if (i <= 0) break
    cur = cur.slice(0, i)
    if (/^[a-z]:$/i.test(cur)) break
    chain.unshift({ path: cur, isDir: true })
  }
  chain.push({ path: target, isDir: targetIsDir })
  for (const level of chain) {
    let verdict: KvxIgnoreVerdict = { ignored: false }
    for (const rule of rules) {
      if (ruleMatches(rule, level.path, level.isDir)) {
        verdict = rule.negate ? { ignored: false } : { ignored: true, source: rule.source, line: rule.line, pattern: rule.raw }
      }
    }
    if (verdict.ignored) return verdict
  }
  return { ignored: false }
}

export function describeKvxIgnoreBlock(absPath: string, verdict: KvxIgnoreVerdict): string {
  return `caminho bloqueado por .kvxignore: ${absPath} (regra '${verdict.pattern}' em ${verdict.source}:${verdict.line})`
}

/** Throws a explicit refusal when the path is blocked. */
export function assertNotKvxIgnored(absPath: string): void {
  const verdict = checkKvxIgnore(absPath)
  if (verdict.ignored) throw new KvxIgnoreError(describeKvxIgnoreBlock(absPath, verdict), verdict)
}

export class KvxIgnoreError extends Error {
  readonly verdict: KvxIgnoreVerdict
  constructor(message: string, verdict: KvxIgnoreVerdict) {
    super(message)
    this.name = 'KvxIgnoreError'
    this.verdict = verdict
  }
}
