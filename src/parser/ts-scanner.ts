/**
 * Scope-aware TypeScript/JavaScript declaration scanner (zero dependencies).
 *
 * Replaces the line-by-line regex extraction for TS/JS. It tokenizes the source
 * (strings, template literals with nested `${}`, regex literals, comments) and walks
 * the token stream as a statement skimmer, so that:
 *  - every declaration ends at the token that really closes it (brace, bracket,
 *    semicolon or ASI newline), never at a fixed window or the next symbol;
 *  - class members (methods, getters/setters, fields, `#private`, arrow properties)
 *    are indexed with a qualified name `Class.member`, at any class size;
 *  - each declaration carries its scope: `module` (top level), `member` (class
 *    member) or `local` (inside a function body).
 */

export type TsScope = 'module' | 'member' | 'local'

export type TsDeclKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'const'
  | 'route'

export interface TsDeclaration {
  name: string
  /** Name qualified by its container, e.g. `CloudApp.finalizeUploadCopy`. */
  qualifiedSuffix: string
  kind: TsDeclKind
  scope: TsScope
  exported: boolean
  parent?: string
  startLine: number
  endLine: number
  signature: string
  /** Class heritage, for `extends` / `implements` edges. */
  extendsName?: string
  implementsNames?: string[]
  routeMethod?: string
  routePath?: string
  /** Whether the declaration is a callable (function, method, arrow const, route). */
  callable: boolean
}

export interface TsImport {
  names: string[]
  modulePath: string
}

export interface TsScanResult {
  declarations: TsDeclaration[]
  imports: TsImport[]
}

type TokType = 'id' | 'str' | 'tpl' | 'num' | 're' | 'p'

interface Tok {
  t: TokType
  v: string
  s: number
  e: number
  line: number
  endLine: number
  nl: boolean
}

const PUNCT_3 = new Set(['===', '!==', '...', '**=', '<<=', '>>=', '&&=', '||=', '??='])
const PUNCT_2 = new Set([
  '=>', '==', '!=', '?.', '??', '&&', '||', '++', '--', '**',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
])

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
])

/** Tokens that, ending a line, force the statement to continue on the next line. */
const CONTINUE_AFTER_PUNCT = new Set([
  '=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '<', '?', '?.', ':', ',', '.', '...',
  '=>', '&&', '||', '??', '==', '===', '!=', '!==',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&=', '||=', '??=', '(', '[', '{',
])
const CONTINUE_AFTER_KEYWORD = new Set([
  'extends', 'in', 'of', 'instanceof', 'typeof', 'keyof', 'new', 'as', 'satisfies',
  'is', 'infer', 'await', 'delete', 'readonly', 'unique', 'asserts',
])
/** Tokens that, starting a line, continue the previous statement. */
const CONTINUE_BEFORE_PUNCT = new Set([
  '.', '?.', '?', ':', '=>', ',', '=', '==', '===', '!=', '!==', '+', '-', '*', '/', '%',
  '**', '&&', '||', '??', '|', '&', '^', '<', '>', '(', '[',
])
const CONTINUE_BEFORE_KEYWORD = new Set(['as', 'satisfies', 'instanceof', 'in', 'extends', 'of'])

const TYPE_LITERAL_PREV = new Set([':', '|', '&', '=>', ',', '(', '<', '[', '?', '='])
const TYPE_LITERAL_PREV_KEYWORDS = new Set(['keyof', 'typeof', 'readonly', 'is', 'extends', 'infer'])

const CLASS_MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override',
  'declare', 'async', 'accessor', 'get', 'set',
])
const MEMBER_NAME_FOLLOWERS = new Set(['(', '=', ':', ';', '?', '!', '<', '}', ','])

const ROUTE_RECEIVERS = new Set(['app', 'router', 'server', 'fastify', 'instance', 'api_router', 'routes'])
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'])

function isIdStart(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 35 || c > 127
  )
}
function isIdPart(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57)
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

class Tokenizer {
  private readonly src: string
  private readonly lineStarts: number[]
  readonly toks: Tok[] = []

  constructor(src: string) {
    this.src = src
    this.lineStarts = [0]
    for (let i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) this.lineStarts.push(i + 1)
    }
  }

  lineOf(offset: number): number {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  private push(t: TokType, s: number, e: number): void {
    const line = this.lineOf(s)
    const endLine = e > s ? this.lineOf(e - 1) : line
    const prev = this.toks[this.toks.length - 1]
    this.toks.push({ t, v: this.src.slice(s, e), s, e, line, endLine, nl: prev ? line > prev.endLine : false })
  }

  private regexAllowed(): boolean {
    const prev = this.toks[this.toks.length - 1]
    if (!prev) return true
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 're') return false
    if (prev.t === 'id') return REGEX_PREFIX_KEYWORDS.has(prev.v)
    return !(
      prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '<' ||
      prev.v === '>' || prev.v === '++' || prev.v === '--'
    )
  }

  /** Skips a template literal starting at the backtick; returns the index after it. */
  private skipTemplate(start: number): number {
    const src = this.src
    let j = start + 1
    while (j < src.length) {
      const c = src[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '`') return j + 1
      if (c === '$' && src[j + 1] === '{') {
        j = this.skipCodeUntilCloseBrace(j + 2)
        continue
      }
      j++
    }
    return src.length
  }

  /**
   * Inside `${ ... }`: skips balanced code and returns the index after the closing brace.
   * Regex literals are recognized (`${s.replace(/"/g, '""')}` must not open a string).
   */
  private skipCodeUntilCloseBrace(start: number): number {
    const src = this.src
    let depth = 0
    let j = start
    let prevSig = '('
    let prevWord = ''
    while (j < src.length) {
      const c = src[j]
      const code = src.charCodeAt(j)
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        j++
        continue
      }
      if (c === '/' && src[j + 1] === '/' && !this.isUrlSlashes(j)) {
        const nl = src.indexOf('\n', j)
        j = nl === -1 ? src.length : nl
        continue
      }
      if (c === '/' && src[j + 1] === '*') {
        const end = src.indexOf('*/', j + 2)
        j = end === -1 ? src.length : end + 2
        continue
      }
      if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || REGEX_PREFIX_KEYWORDS.has(prevWord))) {
        const end = this.tryRegex(j)
        if (end !== null) {
          j = end
          prevSig = 'a'
          prevWord = ''
          continue
        }
      }
      if (c === '"' || c === "'") {
        j = this.skipQuoted(j, c) ?? j + 1
        prevSig = 'a'
        prevWord = ''
        continue
      }
      if (c === '`') {
        j = this.skipTemplate(j)
        prevSig = 'a'
        prevWord = ''
        continue
      }
      if (isIdStart(code)) {
        let k = j + 1
        while (k < src.length && isIdPart(src.charCodeAt(k))) k++
        prevWord = src.slice(j, k)
        prevSig = 'a'
        j = k
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        if (depth === 0) return j + 1
        depth--
      }
      prevSig = c
      prevWord = ''
      j++
    }
    return src.length
  }

  /** `https://` / `file://` in JSX text or template code: the `//` is not a comment. */
  private isUrlSlashes(i: number): boolean {
    return i > 1 && this.src[i - 1] === ':' && /[A-Za-z]{2,10}$/.test(this.src.slice(Math.max(0, i - 11), i - 1))
  }

  /** Returns the index after a closed quoted string, or null when it is unterminated on its line. */
  private skipQuoted(start: number, quote: string): number | null {
    const src = this.src
    let j = start + 1
    while (j < src.length) {
      const c = src[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === quote) return j + 1
      if (c === '\n') return null
      j++
    }
    return null
  }

  private tryRegex(start: number): number | null {
    const src = this.src
    let j = start + 1
    let inClass = false
    while (j < src.length) {
      const c = src[j]
      if (c === '\n') return null
      if (c === '\\') {
        j += 2
        continue
      }
      if (inClass) {
        if (c === ']') inClass = false
      } else if (c === '[') {
        inClass = true
      } else if (c === '/') {
        j++
        while (j < src.length && /[a-z]/i.test(src[j])) j++
        return j
      }
      j++
    }
    return null
  }

  run(): Tok[] {
    const src = this.src
    const n = src.length
    let i = 0
    if (src.startsWith('#!')) {
      const nl = src.indexOf('\n')
      i = nl === -1 ? n : nl
    }
    while (i < n) {
      const code = src.charCodeAt(i)
      const ch = src[i]
      if (code === 10 || code === 32 || code === 9 || code === 13 || code === 0xfeff || code === 0xa0 || code === 11 || code === 12) {
        i++
        continue
      }
      if (ch === '/' && src[i + 1] === '/' && !this.isUrlSlashes(i)) {
        const nl = src.indexOf('\n', i)
        i = nl === -1 ? n : nl
        continue
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        i = end === -1 ? n : end + 2
        continue
      }
      if (ch === '"' || ch === "'") {
        const end = this.skipQuoted(i, ch)
        if (end === null) {
          // Unterminated on its line (e.g. an apostrophe in JSX text): ignore the quote.
          i++
          continue
        }
        this.push('str', i, end)
        i = end
        continue
      }
      if (ch === '`') {
        const end = this.skipTemplate(i)
        this.push('tpl', i, end)
        i = end
        continue
      }
      if (isIdStart(code)) {
        let j = i + 1
        while (j < n && isIdPart(src.charCodeAt(j))) j++
        this.push('id', i, j)
        i = j
        continue
      }
      if (isDigit(code) || (ch === '.' && isDigit(src.charCodeAt(i + 1)))) {
        let j = i + 1
        while (j < n) {
          const c = src[j]
          if (/[0-9a-zA-Z_.]/.test(c)) j++
          else if ((c === '+' || c === '-') && /[eE]/.test(src[j - 1]) && !/^0[xX]/.test(src.slice(i, j))) j++
          else break
        }
        this.push('num', i, j)
        i = j
        continue
      }
      if (ch === '/' && this.regexAllowed()) {
        const end = this.tryRegex(i)
        if (end !== null) {
          this.push('re', i, end)
          i = end
          continue
        }
      }
      const three = src.slice(i, i + 3)
      if (PUNCT_3.has(three)) {
        this.push('p', i, i + 3)
        i += 3
        continue
      }
      const two = src.slice(i, i + 2)
      if (PUNCT_2.has(two) && !(two === '?.' && isDigit(src.charCodeAt(i + 2)))) {
        this.push('p', i, i + 2)
        i += 2
        continue
      }
      this.push('p', i, i + 1)
      i++
    }
    return this.toks
  }
}

interface ParseCtx {
  scope: 'module' | 'local'
  parent?: string
}

export class TsDeclarationScanner {
  private readonly src: string
  private readonly toks: Tok[]
  private readonly match: Int32Array
  private readonly decls: TsDeclaration[] = []
  private readonly imports: TsImport[] = []

  constructor(src: string) {
    this.src = src
    this.toks = new Tokenizer(src).run()
    this.match = this.computeMatches()
  }

  static scan(src: string): TsScanResult {
    const scanner = new TsDeclarationScanner(src)
    return scanner.run()
  }

  run(): TsScanResult {
    this.parseBlock(0, this.toks.length, { scope: 'module' })
    this.scanRoutes()
    this.scanDynamicImports()
    this.decls.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
    return { declarations: this.decls, imports: this.imports }
  }

  // ---------------------------------------------------------------- helpers

  private computeMatches(): Int32Array {
    const m = new Int32Array(this.toks.length).fill(-1)
    const stack: number[] = []
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    for (let i = 0; i < this.toks.length; i++) {
      const t = this.toks[i]
      if (t.t !== 'p') continue
      if (t.v === '(' || t.v === '[' || t.v === '{') {
        stack.push(i)
      } else if (t.v === ')' || t.v === ']' || t.v === '}') {
        const want = pairs[t.v]
        let k = stack.length - 1
        while (k >= 0 && this.toks[stack[k]].v !== want) k--
        if (k < 0) continue
        const open = stack[k]
        stack.length = k
        m[open] = i
        m[i] = open
      }
    }
    return m
  }

  private isP(i: number, v: string): boolean {
    const t = this.toks[i]
    return t !== undefined && t.t === 'p' && t.v === v
  }

  private isId(i: number, v?: string): boolean {
    const t = this.toks[i]
    return t !== undefined && t.t === 'id' && (v === undefined || t.v === v)
  }

  private isOpen(i: number): boolean {
    const t = this.toks[i]
    return t !== undefined && t.t === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')
  }

  private isClose(i: number): boolean {
    const t = this.toks[i]
    return t !== undefined && t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')
  }

  /** Skips a `<...>` generic list starting at `i`; returns the index of the closing `>`. */
  private skipAngles(i: number, limit: number): number {
    let depth = 0
    let j = i
    let guard = 0
    while (j < limit && guard++ < 2000) {
      const t = this.toks[j]
      if (t.t === 'p') {
        if (t.v === '<') depth++
        else if (t.v === '>') {
          depth--
          if (depth === 0) return j
        } else if (t.v === ';') return i
        else if (this.isOpen(j) && this.match[j] > j) {
          j = this.match[j]
        } else if (this.isClose(j)) return i
      }
      j++
    }
    return i
  }

  private continues(prev: Tok, next: Tok): boolean {
    if (prev.t === 'p' && CONTINUE_AFTER_PUNCT.has(prev.v)) return true
    if (prev.t === 'id' && CONTINUE_AFTER_KEYWORD.has(prev.v)) return true
    if (next.t === 'p' && CONTINUE_BEFORE_PUNCT.has(next.v)) return true
    if (next.t === 'id' && CONTINUE_BEFORE_KEYWORD.has(next.v)) return true
    if (next.t === 'tpl') return true
    return false
  }

  /**
   * Returns the index of the last token of the statement starting at `i`
   * (bounded by `limit`, exclusive). Ends at `;`, at the enclosing block's close,
   * or at a newline where automatic semicolon insertion applies.
   * With `stopAtComma`, also ends before a top-level `,` that starts a new declarator.
   */
  private statementEnd(i: number, limit: number, stopAtComma = false): number {
    let j = i
    while (j < limit) {
      const t = this.toks[j]
      if (j > i && t.nl && !this.continues(this.toks[j - 1], t)) return j - 1
      if (t.t === 'p') {
        if (t.v === ';') return j
        if (this.isClose(j)) return j - 1
        if (stopAtComma && t.v === ',' && this.startsDeclarator(j + 1, limit)) return j - 1
        if (this.isOpen(j)) {
          const m = this.match[j]
          if (m > j && m < limit) {
            j = m + 1
            continue
          }
        }
      }
      j++
    }
    return limit - 1
  }

  /** True when tokens at `i` look like `name =`, `name :`, `name,` or a destructuring declarator. */
  private startsDeclarator(i: number, limit: number): boolean {
    if (i >= limit) return false
    if (this.isP(i, '{') || this.isP(i, '[')) {
      const m = this.match[i]
      return m > i && this.isP(m + 1, '=')
    }
    if (!this.isId(i)) return false
    const n = this.toks[i + 1]
    if (!n || n.nl) return true
    return n.t === 'p' && (n.v === '=' || n.v === ':' || n.v === ',' || n.v === ';' || n.v === '!')
  }

  /** From just after a parameter list, finds the body `{` (skipping return type literals). */
  private findBodyBrace(j: number, limit: number): number {
    let prev = this.toks[j - 1]
    let k = j
    while (k < limit) {
      const t = this.toks[k]
      if (k > j && t.nl && prev && !this.continues(prev, t) && !(t.t === 'p' && t.v === '{')) return -1
      if (t.t === 'p') {
        if (t.v === '{') {
          const typeLiteral =
            (prev.t === 'p' && TYPE_LITERAL_PREV.has(prev.v)) ||
            (prev.t === 'id' && TYPE_LITERAL_PREV_KEYWORDS.has(prev.v))
          if (!typeLiteral) return k
          const m = this.match[k]
          if (m <= k) return -1
          k = m
          prev = this.toks[k]
          k++
          continue
        }
        // `=>` here belongs to a function-typed return annotation: `(): () => void {`
        if (t.v === ';' || this.isClose(k)) return -1
        if (t.v === '<') {
          const close = this.skipAngles(k, limit)
          if (close > k) {
            k = close
            prev = this.toks[k]
            k++
            continue
          }
        }
        if ((t.v === '(' || t.v === '[') && this.match[k] > k) {
          k = this.match[k]
          prev = this.toks[k]
          k++
          continue
        }
      }
      prev = t
      k++
    }
    return -1
  }

  private text(fromTok: number, toTokExclusiveStart: number): string {
    const s = this.toks[fromTok].s
    const e = toTokExclusiveStart
    return this.src
      .slice(s, e)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private firstLineText(fromTok: number, lastTok: number, max = 180): string {
    const s = this.toks[fromTok].s
    const e = this.toks[lastTok].e
    const raw = this.src.slice(s, e)
    const nl = raw.indexOf('\n')
    return (nl === -1 ? raw : raw.slice(0, nl)).replace(/\s+/g, ' ').trim().slice(0, max)
  }

  private skipDecorator(i: number): number {
    let j = i + 1
    if (this.isId(j)) j++
    while (this.isP(j, '.') && this.isId(j + 1)) j += 2
    if (this.isP(j, '(') && this.match[j] > j) j = this.match[j] + 1
    return j
  }

  private readonly suffixCounts = new Map<string, number>()

  /**
   * Qualified names are unique per file: a static and an instance member with the same
   * name (or a route registered twice) get a stable ordinal (`Class.name~2`), otherwise
   * they would share one history row and show up as false contract drift.
   */
  private add(d: Omit<TsDeclaration, 'qualifiedSuffix'> & { qualifiedSuffix?: string }): void {
    const base = d.qualifiedSuffix ?? (d.parent ? `${d.parent}.${d.name}` : d.name)
    const n = (this.suffixCounts.get(base) ?? 0) + 1
    this.suffixCounts.set(base, n)
    this.decls.push({ ...d, qualifiedSuffix: n === 1 ? base : `${base}~${n}` })
  }

  // ---------------------------------------------------------------- statements

  private parseBlock(start: number, end: number, ctx: ParseCtx): void {
    let i = start
    while (i < end) {
      const t = this.toks[i]
      if (t.t === 'p' && (t.v === ';' || this.isClose(i))) {
        i++
        continue
      }
      const next = this.parseStatement(i, end, ctx)
      i = next > i ? next : i + 1
    }
  }

  /** Parses one statement at `i`; returns the index after it. */
  private parseStatement(stmtStart: number, end: number, ctx: ParseCtx): number {
    let k = stmtStart
    while (this.isP(k, '@')) k = this.skipDecorator(k)
    let exported = false
    let isDefault = false
    let declared = false
    if (ctx.scope === 'module' && this.isId(k, 'export')) {
      exported = true
      k++
      if (this.isId(k, 'default')) {
        isDefault = true
        k++
      }
    }
    if (this.isId(k, 'declare')) {
      declared = true
      k++
    }
    if (this.isId(k, 'abstract') && this.isId(k + 1, 'class')) k++
    if (this.isId(k, 'async') && this.isId(k + 1, 'function') && !this.toks[k + 1].nl) k++

    const kw = this.toks[k]
    if (!kw) return end

    if (ctx.scope === 'module') {
      if (kw.t === 'id' && kw.v === 'import' && !this.isP(k + 1, '(') && !this.isP(k + 1, '.')) {
        const stEnd = this.statementEnd(k, end)
        this.recordImport(k, stEnd)
        return stEnd + 1
      }
      if (exported && !isDefault && kw.t === 'p' && (kw.v === '{' || kw.v === '*' || kw.v === '=')) {
        const stEnd = this.statementEnd(k, end)
        this.recordImport(k, stEnd)
        return stEnd + 1
      }
      if (exported && this.isId(k, 'type') && this.isP(k + 1, '{')) {
        const stEnd = this.statementEnd(k, end)
        this.recordImport(k, stEnd)
        return stEnd + 1
      }
    }

    if (kw.t === 'id') {
      switch (kw.v) {
        case 'function':
          return this.parseFunction(stmtStart, k, end, ctx, exported, isDefault, declared)
        case 'class':
          return this.parseClass(stmtStart, k, end, ctx, exported, isDefault)
        case 'interface':
          if (this.isId(k + 1)) return this.parseBraceDecl(stmtStart, k, end, ctx, exported, 'interface')
          break
        case 'enum':
          if (this.isId(k + 1)) return this.parseBraceDecl(stmtStart, k, end, ctx, exported, 'enum')
          break
        case 'type':
          if (this.isId(k + 1) && (this.isP(k + 2, '=') || this.isP(k + 2, '<'))) {
            return this.parseTypeAlias(stmtStart, k, end, ctx, exported)
          }
          break
        case 'const':
          if (this.isId(k + 1, 'enum')) return this.parseBraceDecl(stmtStart, k + 1, end, ctx, exported, 'enum')
          return this.parseVariable(stmtStart, k, end, ctx, exported)
        case 'let':
        case 'var':
          if (this.isId(k + 1) || this.isP(k + 1, '{') || this.isP(k + 1, '[')) {
            return this.parseVariable(stmtStart, k, end, ctx, exported)
          }
          break
        case 'namespace':
        case 'module':
        case 'global':
          if (this.isId(k + 1) || this.toks[k + 1]?.t === 'str' || this.isP(k + 1, '{')) {
            let j = k + 1
            while (j < end && !this.isP(j, '{') && !this.isP(j, ';') && !this.toks[j].nl) j++
            if (this.isP(j, '{') && this.match[j] > j) return this.match[j] + 1
          }
          break
      }
    }

    if (exported && isDefault && ctx.scope === 'module') {
      const stEnd = this.statementEnd(k, end)
      this.add({
        name: 'default',
        kind: 'const',
        scope: 'module',
        exported: true,
        startLine: this.toks[stmtStart].line,
        endLine: this.toks[stEnd].endLine,
        signature: this.firstLineText(stmtStart, stEnd),
        callable: false,
      })
      return stEnd + 1
    }

    return this.statementEnd(stmtStart, end) + 1
  }

  private recordImport(from: number, to: number): void {
    let modulePath = ''
    for (let j = to; j >= from; j--) {
      if (this.toks[j].t === 'str') {
        modulePath = this.toks[j].v.slice(1, -1)
        break
      }
    }
    if (!modulePath) return
    const names: string[] = []
    let j = from + 1
    if (this.isId(j, 'type')) j++
    while (j <= to) {
      const t = this.toks[j]
      if (t.t === 'id' && t.v === 'from') break
      if (t.t === 'id' && !['as', 'type', 'typeof'].includes(t.v)) {
        if (!this.isId(j - 1, 'as')) names.push(t.v)
      }
      j++
    }
    this.imports.push({ names, modulePath })
  }

  private scanDynamicImports(): void {
    for (let j = 0; j + 2 < this.toks.length; j++) {
      const t = this.toks[j]
      if (t.t !== 'id' || (t.v !== 'require' && t.v !== 'import')) continue
      if (!this.isP(j + 1, '(') || this.toks[j + 2].t !== 'str') continue
      if (this.isP(j - 1, '.')) continue
      this.imports.push({ names: [], modulePath: this.toks[j + 2].v.slice(1, -1) })
    }
  }

  private parseFunction(
    stmtStart: number,
    k: number,
    end: number,
    ctx: ParseCtx,
    exported: boolean,
    isDefault: boolean,
    declared: boolean,
  ): number {
    let j = k + 1
    if (this.isP(j, '*')) j++
    let name = isDefault ? 'default' : ''
    if (this.isId(j)) {
      name = this.toks[j].v
      j++
    }
    if (this.isP(j, '<')) j = this.skipAngles(j, end) + 1
    if (!name || !this.isP(j, '(') || this.match[j] <= j) return this.statementEnd(stmtStart, end) + 1
    const afterParams = this.match[j] + 1
    const body = this.findBodyBrace(afterParams, end)
    if (body === -1) {
      const stEnd = this.statementEnd(afterParams, end)
      if (declared && ctx.scope === 'module') {
        this.add({
          name,
          kind: 'function',
          scope: 'module',
          exported,
          startLine: this.toks[stmtStart].line,
          endLine: this.toks[stEnd].endLine,
          signature: this.text(stmtStart, this.toks[stEnd].e),
          callable: true,
        })
      }
      return stEnd + 1
    }
    const bodyEnd = this.match[body]
    // Unbalanced body brace: end the statement locally instead of abandoning the block.
    if (bodyEnd <= body) return this.statementEnd(stmtStart, end) + 1
    const scope: TsScope = ctx.scope === 'module' ? 'module' : 'local'
    this.add({
      name,
      kind: 'function',
      scope,
      exported: exported && scope === 'module',
      parent: scope === 'local' ? ctx.parent : undefined,
      startLine: this.toks[stmtStart].line,
      endLine: this.toks[bodyEnd].endLine,
      signature: this.text(stmtStart, this.toks[body].s),
      callable: true,
    })
    const qualified = scope === 'local' && ctx.parent ? `${ctx.parent}.${name}` : name
    this.parseBlock(body + 1, bodyEnd, { scope: 'local', parent: qualified })
    return bodyEnd + 1
  }

  private parseClass(
    stmtStart: number,
    k: number,
    end: number,
    ctx: ParseCtx,
    exported: boolean,
    isDefault: boolean,
  ): number {
    let j = k + 1
    let name = isDefault ? 'default' : ''
    if (this.isId(j) && this.toks[j].v !== 'extends' && this.toks[j].v !== 'implements') {
      name = this.toks[j].v
      j++
    }
    if (this.isP(j, '<')) j = this.skipAngles(j, end) + 1
    let extendsName: string | undefined
    const implementsNames: string[] = []
    let mode: 'none' | 'extends' | 'implements' = 'none'
    let current = ''
    const flush = () => {
      if (!current) return
      if (mode === 'extends' && !extendsName) extendsName = current
      else if (mode === 'implements') implementsNames.push(current)
      current = ''
    }
    while (j < end && !this.isP(j, '{')) {
      const t = this.toks[j]
      if (t.t === 'id' && (t.v === 'extends' || t.v === 'implements')) {
        flush()
        mode = t.v
      } else if (t.t === 'id') {
        current = current && this.isP(j - 1, '.') ? `${current}.${t.v}` : current || t.v
      } else if (t.t === 'p' && t.v === ',') {
        flush()
      } else if (t.t === 'p' && t.v === '<') {
        j = this.skipAngles(j, end)
      } else if (t.t === 'p' && t.v === '(' && this.match[j] > j) {
        j = this.match[j]
      } else if (t.t === 'p' && t.v === ';') {
        return j + 1
      }
      j++
    }
    flush()
    if (!this.isP(j, '{') || this.match[j] <= j) return this.statementEnd(stmtStart, end) + 1
    const bodyEnd = this.match[j]
    if (!name) return bodyEnd + 1
    const scope: TsScope = ctx.scope === 'module' ? 'module' : 'local'
    this.add({
      name,
      kind: 'class',
      scope,
      exported: exported && scope === 'module',
      parent: scope === 'local' ? ctx.parent : undefined,
      startLine: this.toks[stmtStart].line,
      endLine: this.toks[bodyEnd].endLine,
      signature: this.text(stmtStart, this.toks[j].s),
      extendsName,
      implementsNames: implementsNames.length ? implementsNames : undefined,
      callable: false,
    })
    if (scope === 'module') this.parseClassBody(j + 1, bodyEnd, name, exported)
    return bodyEnd + 1
  }

  private parseClassBody(start: number, end: number, className: string, classExported: boolean): void {
    let i = start
    let lastStart = -1
    while (i < end) {
      // Progress guard: a stray `)`/`]` (half-typed code) must never stall the loop.
      if (i <= lastStart) i = lastStart + 1
      if (i >= end) break
      lastStart = i
      const t = this.toks[i]
      if (t.t === 'p' && (t.v === ';' || t.v === ',' || this.isClose(i))) {
        i++
        continue
      }
      const memberStart = i
      let j = i
      while (this.isP(j, '@')) j = this.skipDecorator(j)
      const modifiers: string[] = []
      while (this.isId(j) && CLASS_MODIFIERS.has(this.toks[j].v)) {
        const nextTok = this.toks[j + 1]
        if (!nextTok || (nextTok.t === 'p' && MEMBER_NAME_FOLLOWERS.has(nextTok.v))) break
        if (nextTok.nl && (this.toks[j].v === 'get' || this.toks[j].v === 'set')) break
        modifiers.push(this.toks[j].v)
        j++
      }
      if (this.isId(j - 1, 'static') && this.isP(j, '{') && this.match[j] > j) {
        i = this.match[j] + 1
        continue
      }
      if (this.isP(j, '*')) j++
      let name = ''
      const nameIdx = j
      const nameTok = this.toks[j]
      if (!nameTok) break
      if (nameTok.t === 'id') {
        name = nameTok.v
        j++
      } else if (nameTok.t === 'str' || nameTok.t === 'num') {
        name = nameTok.v.replace(/^['"]|['"]$/g, '')
        j++
      } else if (nameTok.t === 'p' && nameTok.v === '[' && this.match[j] > j) {
        const close = this.match[j]
        const isIndexSignature = this.isId(j + 1) && this.isP(j + 2, ':')
        if (isIndexSignature) {
          i = this.statementEnd(memberStart, end) + 1
          continue
        }
        name = this.src.slice(nameTok.s, this.toks[close].e)
        j = close + 1
      } else {
        i = this.statementEnd(memberStart, end) + 1
        continue
      }
      if (this.isP(j, '?') || this.isP(j, '!')) j++
      if (this.isP(j, '<')) j = this.skipAngles(j, end) + 1

      const isPrivate = modifiers.includes('private') || name.startsWith('#')
      const accessor = modifiers.includes('get') ? 'get' : modifiers.includes('set') ? 'set' : ''
      const exported = classExported && !isPrivate

      if (this.isP(j, '(') && this.match[j] > j) {
        const afterParams = this.match[j] + 1
        const body = this.findBodyBrace(afterParams, end)
        if (body === -1) {
          const stEnd = this.statementEnd(afterParams, end)
          if (modifiers.includes('abstract')) {
            this.add({
              name,
              kind: 'method',
              scope: 'member',
              exported,
              parent: className,
              startLine: this.toks[memberStart].line,
              endLine: this.toks[stEnd].endLine,
              signature: this.memberSignature(memberStart, nameTok.s, this.toks[stEnd].e, className, modifiers),
              callable: true,
            })
          }
          i = stEnd + 1
          continue
        }
        const bodyEnd = this.match[body]
        if (bodyEnd <= body) {
          i = this.statementEnd(memberStart, end) + 1
          continue
        }
        this.add({
          name,
          kind: 'method',
          scope: 'member',
          exported,
          parent: className,
          qualifiedSuffix: accessor === 'set' ? `${className}.${name}=` : undefined,
          startLine: this.toks[memberStart].line,
          endLine: this.toks[bodyEnd].endLine,
          signature: this.memberSignature(memberStart, nameTok.s, this.toks[body].s, className, modifiers),
          callable: true,
        })
        this.parseBlock(body + 1, bodyEnd, { scope: 'local', parent: `${className}.${name}` })
        i = bodyEnd + 1
        continue
      }

      // Field / property (possibly an arrow-function property).
      const stEnd = this.statementEnd(memberStart, end)
      let eq = -1
      for (let q = j; q <= stEnd; q++) {
        if (this.isP(q, '=')) {
          eq = q
          break
        }
        if (this.isOpen(q) && this.match[q] > q) q = this.match[q]
        else if (this.isP(q, '<')) q = Math.max(q, this.skipAngles(q, stEnd + 1))
      }
      const fnInfo = eq !== -1 ? this.classifyInitializer(eq + 1, stEnd + 1) : null
      const sigEnd = fnInfo?.arrowTok !== undefined ? this.toks[fnInfo.arrowTok].e : -1
      this.add({
        name,
        kind: fnInfo ? 'method' : 'property',
        scope: 'member',
        exported,
        parent: className,
        startLine: this.toks[memberStart].line,
        endLine: this.toks[stEnd].endLine,
        signature:
          sigEnd > 0
            ? this.memberSignature(memberStart, nameTok.s, sigEnd, className, modifiers)
            : `${modifiers.length ? modifiers.join(' ') + ' ' : ''}${className}.${this.firstLineText(nameIdx, stEnd)}`,
        callable: Boolean(fnInfo),
      })
      i = stEnd + 1
    }
  }

  private memberSignature(
    memberStart: number,
    nameStart: number,
    endOffset: number,
    className: string,
    modifiers: string[],
  ): string {
    const rest = this.src
      .slice(nameStart, endOffset)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    void memberStart
    const mods = modifiers.length ? `${modifiers.join(' ')} ` : ''
    return `${mods}${className}.${rest}`.slice(0, 320)
  }

  /** Detects `async? (<T>)? (params) (: R)? =>`, `x =>`, `function`, `class` initializers. */
  private classifyInitializer(
    start: number,
    limit: number,
  ): { kind: 'arrow' | 'function' | 'class'; arrowTok?: number; bodyTok?: number } | null {
    let p = start
    if (this.isId(p, 'async') && !this.isP(p + 1, '=>')) p++
    if (this.isId(p, 'function')) {
      let q = p + 1
      if (this.isP(q, '*')) q++
      if (this.isId(q)) q++
      if (this.isP(q, '(') && this.match[q] > q) {
        const body = this.findBodyBrace(this.match[q] + 1, limit)
        return { kind: 'function', bodyTok: body === -1 ? undefined : body }
      }
      return { kind: 'function' }
    }
    if (this.isId(p, 'class')) return { kind: 'class' }
    if (this.isP(p, '<')) p = this.skipAngles(p, limit) + 1
    if (this.isId(p) && this.isP(p + 1, '=>')) {
      return { kind: 'arrow', arrowTok: p + 1, bodyTok: this.isP(p + 2, '{') ? p + 2 : undefined }
    }
    if (this.isP(p, '(') && this.match[p] > p && this.match[p] < limit) {
      let q = this.match[p] + 1
      if (this.isP(q, ':')) {
        let guard = 0
        while (q < limit && !this.isP(q, '=>') && guard++ < 400) {
          if (this.isOpen(q) && this.match[q] > q) q = this.match[q]
          else if (this.isP(q, '<')) q = Math.max(q, this.skipAngles(q, limit))
          else if (this.isP(q, ';') || this.isP(q, '=')) return null
          q++
        }
      }
      if (this.isP(q, '=>')) {
        return { kind: 'arrow', arrowTok: q, bodyTok: this.isP(q + 1, '{') ? q + 1 : undefined }
      }
    }
    return null
  }

  private parseBraceDecl(
    stmtStart: number,
    k: number,
    end: number,
    ctx: ParseCtx,
    exported: boolean,
    kind: 'interface' | 'enum',
  ): number {
    const name = this.toks[k + 1].v
    let j = k + 2
    while (j < end && !this.isP(j, '{')) {
      if (this.isP(j, '<')) j = this.skipAngles(j, end)
      else if (this.isP(j, ';')) return j + 1
      j++
    }
    if (!this.isP(j, '{') || this.match[j] <= j) return this.statementEnd(stmtStart, end) + 1
    const bodyEnd = this.match[j]
    if (ctx.scope === 'module') {
      this.add({
        name,
        kind,
        scope: 'module',
        exported,
        startLine: this.toks[stmtStart].line,
        endLine: this.toks[bodyEnd].endLine,
        signature: this.text(stmtStart, this.toks[j].s),
        callable: false,
      })
    }
    return bodyEnd + 1
  }

  private parseTypeAlias(stmtStart: number, k: number, end: number, ctx: ParseCtx, exported: boolean): number {
    const stEnd = this.statementEnd(k, end)
    if (ctx.scope === 'module') {
      const full = this.text(stmtStart, this.toks[stEnd].e)
      this.add({
        name: this.toks[k + 1].v,
        kind: 'type',
        scope: 'module',
        exported,
        startLine: this.toks[stmtStart].line,
        endLine: this.toks[stEnd].endLine,
        signature: full.length <= 220 ? full : this.firstLineText(stmtStart, stEnd, 220),
        callable: false,
      })
    }
    return stEnd + 1
  }

  private parseVariable(stmtStart: number, k: number, end: number, ctx: ParseCtx, exported: boolean): number {
    let j = k + 1
    let declStart = stmtStart
    let lastEnd = k
    while (j < end) {
      let name = ''
      let nameTok = j
      if ((this.isP(j, '{') || this.isP(j, '[')) && this.match[j] > j) {
        j = this.match[j] + 1
      } else if (this.isId(j)) {
        name = this.toks[j].v
        nameTok = j
        j++
      } else {
        break
      }
      // `let a, b` / `let b` + newline: the declarator is just the name; never scan into the next line.
      const nextTok = this.toks[j]
      const endsAtName =
        j >= end ||
        this.isP(j, ',') ||
        this.isP(j, ';') ||
        this.isClose(j) ||
        (nextTok !== undefined && nextTok.nl && !this.continues(this.toks[j - 1], nextTok))
      const declEnd = endsAtName ? j - 1 : this.statementEnd(j, end, true)
      let eq = -1
      for (let q = j; q <= declEnd; q++) {
        if (this.isP(q, '=')) {
          eq = q
          break
        }
        if (this.isOpen(q) && this.match[q] > q) q = this.match[q]
        else if (this.isP(q, '<')) q = Math.max(q, this.skipAngles(q, declEnd + 1))
      }
      const init = eq !== -1 ? this.classifyInitializer(eq + 1, declEnd + 1) : null
      const isRequire = eq !== -1 && this.isId(eq + 1, 'require') && this.isP(eq + 2, '(')
      const isFn = init !== null && init.kind !== 'class'
      const recordIt = name !== '' && !isRequire && (ctx.scope === 'module' || isFn || init?.kind === 'class')
      if (recordIt) {
        const scope: TsScope = ctx.scope === 'module' ? 'module' : 'local'
        let signature: string
        if (init?.arrowTok !== undefined) signature = this.text(declStart, this.toks[init.arrowTok].e)
        else if (init?.bodyTok !== undefined) signature = this.text(declStart, this.toks[init.bodyTok].s)
        else signature = this.firstLineText(declStart, declEnd)
        const kind = init?.kind === 'class' ? 'class' : isFn ? 'function' : 'const'
        this.add({
          name,
          kind,
          scope,
          exported: exported && scope === 'module',
          parent: scope === 'local' ? ctx.parent : undefined,
          startLine: this.toks[declStart].line,
          endLine: this.toks[declEnd].endLine,
          signature: signature.slice(0, 320),
          callable: isFn,
        })
        const qualified = scope === 'local' && ctx.parent ? `${ctx.parent}.${name}` : name
        if (init?.kind === 'class' && scope === 'module') {
          let b = eq + 2
          while (b <= declEnd && !this.isP(b, '{')) b++
          if (this.isP(b, '{') && this.match[b] > b) this.parseClassBody(b + 1, this.match[b], name, exported)
        } else if (init?.bodyTok !== undefined && this.match[init.bodyTok] > init.bodyTok) {
          this.parseBlock(init.bodyTok + 1, this.match[init.bodyTok], { scope: 'local', parent: qualified })
        }
      }
      void nameTok
      lastEnd = declEnd
      if (this.isP(declEnd + 1, ',')) {
        j = declEnd + 2
        declStart = j
        continue
      }
      break
    }
    const stEnd = this.isP(lastEnd + 1, ';') ? lastEnd + 1 : lastEnd
    return Math.max(stEnd + 1, k + 1)
  }

  // ---------------------------------------------------------------- routes

  private scanRoutes(): void {
    const toks = this.toks
    for (let j = 0; j + 4 < toks.length; j++) {
      const recv = toks[j]
      if (recv.t !== 'id' || !ROUTE_RECEIVERS.has(recv.v)) continue
      if (!this.isP(j + 1, '.') || !this.isId(j + 2) || !ROUTE_METHODS.has(toks[j + 2].v)) continue
      if (!this.isP(j + 3, '(') || this.match[j + 3] <= j + 3) continue
      const pathTok = toks[j + 4]
      if (pathTok.t !== 'str' && pathTok.t !== 'tpl') continue
      const routePath = pathTok.v.slice(1, -1)
      if (!routePath.startsWith('/') && routePath !== '*') continue
      if (pathTok.t === 'tpl' && routePath.includes('${')) continue
      let start = j
      while (this.isP(start - 1, '.') && (this.isId(start - 2) || this.isP(start - 2, ')'))) {
        if (this.isP(start - 2, ')')) break
        start -= 2
      }
      const close = this.match[j + 3]
      const method = toks[j + 2].v.toUpperCase()
      this.add({
        name: `${method} ${routePath}`,
        kind: 'route',
        scope: 'module',
        exported: true,
        startLine: toks[start].line,
        endLine: toks[close].endLine,
        signature: `${method} ${routePath}`,
        routeMethod: method,
        routePath,
        callable: true,
      })
      j = j + 4
    }
    this.scanManualRoutes()
  }

  /**
   * Hand-rolled routers: `method === 'GET' && pathname === '/api/v1/health'` (either order).
   * The route symbol spans the enclosing `if (...) { ... }` block when there is one.
   */
  private scanManualRoutes(): void {
    const toks = this.toks
    const seen = new Set(this.decls.filter((d) => d.kind === 'route').map((d) => `${d.name}@${d.startLine}`))
    const isPathStr = (k: number) => toks[k]?.t === 'str' && toks[k].v.length > 3 && toks[k].v[1] === '/'
    const isEq = (k: number) => this.isP(k, '===') || this.isP(k, '==')
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j]
      if (t.t !== 'str') continue
      const method = t.v.slice(1, -1)
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) continue
      let pathIdx = -1
      for (let k = j + 1; k < Math.min(toks.length, j + 16) && toks[k].line === t.line; k++) {
        if (isEq(k) && isPathStr(k + 1)) {
          pathIdx = k + 1
          break
        }
      }
      if (pathIdx === -1) {
        for (let k = j - 1; k >= Math.max(0, j - 16) && toks[k].line === t.line; k--) {
          if (isPathStr(k) && isEq(k - 1)) {
            pathIdx = k
            break
          }
        }
      }
      if (pathIdx === -1) continue
      const routePath = toks[pathIdx].v.slice(1, -1)
      let startLine = t.line
      let endLine = t.endLine
      for (let k = Math.min(j, pathIdx) - 1; k >= Math.max(0, j - 60); k--) {
        if (this.isClose(k) && this.match[k] >= 0 && this.match[k] < k) {
          k = this.match[k]
          continue
        }
        if (this.isP(k, '(') && this.match[k] > Math.max(j, pathIdx)) {
          const close = this.match[k]
          if (this.isId(k - 1, 'if') && this.isP(close + 1, '{') && this.match[close + 1] > close + 1) {
            startLine = toks[k - 1].line
            endLine = toks[this.match[close + 1]].endLine
          }
          break
        }
      }
      const name = `${method} ${routePath}`
      if (seen.has(`${name}@${startLine}`)) continue
      seen.add(`${name}@${startLine}`)
      this.add({
        name,
        kind: 'route',
        scope: 'module',
        exported: true,
        startLine,
        endLine,
        signature: name,
        routeMethod: method,
        routePath,
        callable: true,
      })
    }
  }
}
