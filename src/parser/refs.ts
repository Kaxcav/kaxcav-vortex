/**
 * Identifier usages ("references") for find_references / rename. Each usage is a compact
 * tuple [name, line, col, kind] (1-based line and column). Declaration sites are dropped.
 */

export type RefKind = 'call' | 'member_call' | 'member' | 'import' | 'jsx' | 'other'
export type RefTuple = [name: string, line: number, col: number, kind: RefKind]

/** Above this many usages a file is generated/minified noise: keep the first ones only. */
export const MAX_REFS_PER_FILE = 20_000

const KEYWORDS = new Set(
  (
    'if else for while do switch case break continue return function class const let var new this super import export from default ' +
    'extends implements interface type enum async await yield try catch finally throw typeof instanceof in of void delete null ' +
    'undefined true false as satisfies keyof readonly public private protected static abstract declare namespace module get set ' +
    'constructor string number boolean any unknown never object symbol bigint is infer override accessor ' +
    // other languages (fallback collector)
    'def self cls None True False and or not elif pass lambda with global nonlocal raise except assert del print ' +
    'func package struct map chan go defer select range nil fallthrough ' +
    'fn impl trait pub mut use crate mod match loop where move ref dyn unsafe extern ' +
    'end then begin rescue ensure unless until elsif require require_relative puts ' +
    'echo local fi esac done param foreach process ' +
    'int long short byte char float double bool void final throws native synchronized volatile transient strictfp ' +
    'using internal sealed override virtual readonly out params base lock event operator implicit explicit unchecked checked ' +
    'auto register sizeof template typename std'
  ).split(' '),
)

const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

/**
 * Same-length copy of JS/TS (and C-like) source where strings, comments, regex literals and
 * template text become spaces; newlines are kept and `${...}` stays code. Columns survive.
 */
export function blankNonCode(src: string): string {
  const out = src.split('')
  const n = src.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  const tmplStack: number[] = []
  let depth = 0
  let prev = '' // last significant token: a punctuation char or a whole word

  // Template text from `start` until the closing backtick (returns index after it) or `${`.
  const scanTemplate = (start: number): number => {
    let j = start
    while (j < n) {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (src[j] === '`') {
        blank(start, j + 1)
        return j + 1
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(start, j + 2)
        tmplStack.push(depth)
        depth++
        prev = '{'
        return j + 2
      }
      j++
    }
    blank(start, n)
    return n
  }

  let i = 0
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      const e = src.indexOf('\n', i)
      const end = e === -1 ? n : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && next === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e === -1 ? n : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i, j + 1)
      i = j + 1
      prev = 'x'
      continue
    }
    if (c === '`') {
      i = scanTemplate(i + 1)
      blank(i - 1, i)
      prev = 'x'
      continue
    }
    if (c === '/') {
      const wordPrev = /^[\w$]+$/.test(prev)
      const regexOk = prev === '' || (wordPrev ? REGEX_AFTER_WORDS.has(prev) : !/[)\]}]/.test(prev))
      if (regexOk) {
        let j = i + 1
        let inClass = false
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') {
            j += 2
            continue
          }
          if (src[j] === '[') inClass = true
          else if (src[j] === ']') inClass = false
          else if (src[j] === '/' && !inClass) break
          j++
        }
        if (j < n && src[j] === '/') {
          j++
          while (j < n && /[a-z]/i.test(src[j])) j++
          blank(i, j)
          i = j
          prev = 'x'
          continue
        }
      }
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1] === depth) {
        tmplStack.pop()
        out[i] = ' '
        i = scanTemplate(i + 1)
        prev = 'x'
        continue
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i
      while (j < n && /[\w$]/.test(src[j])) j++
      prev = src.slice(i, j)
      i = j
      continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}

/** Same-length copy for `#`-comment languages (Python, Ruby, shell, PowerShell): strings and comments blanked. */
export function blankHashComments(src: string): string {
  const out = src.split('')
  const n = src.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '#') {
      const e = src.indexOf('\n', i)
      const end = e === -1 ? n : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i)
      if (triple) {
        const e = src.indexOf(c.repeat(3), i + 3)
        const end = e === -1 ? n : e + 3
        blank(i, end)
        i = end
        continue
      }
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i, j + 1)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

const HASH_LANGS = new Set(['python', 'ruby', 'bash', 'powershell'])

/** Column-preserving code view of a file in its language's comment syntax. */
export function blankForLang(lang: string, src: string): string {
  return HASH_LANGS.has(lang) ? blankHashComments(src) : blankNonCode(src)
}

/**
 * Text collector (TS/JS, and the code languages tree-sitter does not cover in this run):
 * identifiers outside strings/comments, classified by their immediate context.
 */
export function collectTextRefs(content: string, lang: string): RefTuple[] {
  const code = HASH_LANGS.has(lang) ? blankHashComments(content) : blankNonCode(content)
  const lines = code.split('\n')
  const refs: RefTuple[] = []
  let inImport = false
  const idRe = lang === 'powershell' ? /[A-Za-z_][\w-]*/g : /[A-Za-z_$][\w$]*/g
  for (let li = 0; li < lines.length && refs.length < MAX_REFS_PER_FILE; li++) {
    const line = lines[li].replace(/\r$/, '')
    const trimmed = line.trimStart()
    const importLine =
      inImport ||
      /^(?:import|export\s+(?:\*|\{[^}]*\}|type\s*\{))[\s\S]*\bfrom\b|^import\b|^(?:from\s+\S+\s+)?import\b|^use\b|^#include\b|^using\b/.test(trimmed) ||
      /\brequire(?:_relative)?\s*\(/.test(line)
    if (/^import\b/.test(trimmed) && /\{[^}]*$/.test(trimmed)) inImport = true
    else if (inImport && /\}/.test(line)) inImport = false
    idRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = idRe.exec(line)) !== null) {
      const name = m[0]
      if (name.length < 2 || KEYWORDS.has(name) || /^\d/.test(name)) continue
      const before = line.slice(0, m.index)
      const after = line.slice(m.index + name.length).trimStart()
      const beforeTrim = before.trimEnd()
      // `key: value`, `key?: Type`, `(param: Type)`, `readonly field: T`: a name being declared
      // (object key, property signature, parameter), not a usage of a symbol with that name.
      if (
        /^\??:(?!:)/.test(after) &&
        (beforeTrim === '' || /[{,(;]$/.test(beforeTrim) || /\b(?:readonly|public|private|protected|static|declare|abstract|override)$/.test(beforeTrim))
      ) {
        continue
      }
      // TS overload / interface / abstract method signatures: `name(...): T;` with no body is a
      // declaration, not a call.
      if (
        /^\s*(?:(?:public|private|protected|static|abstract|declare|override|readonly|async|get|set)\s+)*$/.test(before) &&
        /^[\w$]+\s*\??\s*(?:<[^>]*>)?\s*\(.*\)\s*:\s*[^{=]*;\s*$/.test(line.slice(m.index))
      ) {
        continue
      }
      let kind: RefKind
      if (importLine) kind = 'import'
      else if (/(?:\?\.|\.|->|::)$/.test(beforeTrim)) kind = after.startsWith('(') ? 'member_call' : 'member'
      else if (/<\/?$/.test(before) && (/^[A-Z]/.test(name) || before.endsWith('</'))) kind = 'jsx'
      else if (after.startsWith('(') || /\bnew$/.test(beforeTrim)) kind = 'call'
      else kind = 'other'
      refs.push([name, li + 1, m.index + 1, kind])
    }
  }
  return refs
}

/**
 * Drops each declaration site: per symbol, the first usage of its name inside the declaration
 * head (start line, or a few lines below it for decorators/attributes/doc blocks).
 */
export function dropDeclarationSites(refs: RefTuple[], symbols: Array<{ name: string; startLine: number; endLine: number }>): RefTuple[] {
  const byName = new Map<string, number[]>()
  refs.forEach((r, i) => {
    const list = byName.get(r[0])
    if (list) list.push(i)
    else byName.set(r[0], [i])
  })
  const drop = new Set<number>()
  for (const s of symbols) {
    const idxs = byName.get(s.name)
    if (!idxs) continue
    const hi = Math.min(s.endLine, s.startLine + 6)
    for (const i of idxs) {
      const line = refs[i][1]
      if (line >= s.startLine && line <= hi && !drop.has(i)) {
        drop.add(i)
        break
      }
    }
  }
  return drop.size === 0 ? refs : refs.filter((_, i) => !drop.has(i))
}
