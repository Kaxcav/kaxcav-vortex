import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { MAX_REFS_PER_FILE, type RefKind, type RefTuple } from './refs.ts'
import type {
  ExtractedEdge,
  ExtractedRoute,
  ExtractedSymbol,
  ExtractionResult,
  ScannedFile,
  SupportedLanguage,
  SymbolKind,
  SymbolScope,
} from '../core/types.ts'

/**
 * Optional tree-sitter layer (WASM, no native binaries) on top of the optional dependency
 * `@vscode/tree-sitter-wasm`. When the package is not installed (or KVX_TREE_SITTER=0) the
 * engine keeps working with the built-in extractors; this module only reports why.
 *
 * TS/JS stay on the built-in scope-aware scanner (routes, scopes, tested ranges); tree-sitter
 * takes Python and Go (better than the regex extractors) and adds Java, C#, C/C++, Rust, Ruby,
 * PHP, Bash and PowerShell.
 */

// ---------------------------------------------------------------- minimal runtime typings

interface TsPoint {
  row: number
  column: number
}
interface TsNode {
  type: string
  text: string
  isNamed: boolean
  startIndex: number
  endIndex: number
  startPosition: TsPoint
  endPosition: TsPoint
  parent: TsNode | null
  namedChildren: Array<TsNode | null>
  children: Array<TsNode | null>
  hasError: boolean
  isError: boolean
  isMissing: boolean
  childForFieldName(name: string): TsNode | null
}
interface TsTree {
  rootNode: TsNode
  delete(): void
}
interface TsParser {
  setLanguage(language: unknown): unknown
  parse(source: string): TsTree | null
}
interface TsModule {
  Parser: { init(opts?: { locateFile: (file: string, folder: string) => string }): Promise<void>; new (): TsParser }
  Language: { load(input: string | Uint8Array): Promise<unknown> }
}

// ---------------------------------------------------------------- language specs

type NameOf = (node: TsNode) => string | null

interface DeclSpec {
  kind: SymbolKind
  /** Members declared inside are qualified by this declaration's name. */
  container?: boolean
  /**
   * Namespace-like container (C#/C++ namespace, Ruby module, Rust mod): qualifies loose
   * functions inside it, but a class declared inside starts its own qualification
   * (`Svc.Run`, not `App.Core.Svc.Run`).
   */
  namespace?: boolean
  /** Emits no symbol of its own; only qualifies its members (Rust `impl Point`). */
  transparent?: boolean
  /** Function-like: declarations inside its body are locals. */
  callable?: boolean
  name?: NameOf
  /** For containers named by another declaration (Rust `impl Point`, Go receivers). */
  owner?: NameOf
}

interface LangSpec {
  wasm: string
  decls: Record<string, DeclSpec>
  /** Node types that are transparent wrappers whose range should include decorators. */
  wrappers?: Record<string, string>
  imports?: Record<string, (node: TsNode) => { module: string; names: string[] } | null>
  calls?: Record<string, NameOf>
  exported: (node: TsNode, name: string, scope: SymbolScope) => boolean
}

const field = (f: string): NameOf => (n) => n.childForFieldName(f)?.text ?? null
const lastIdent = (text: string): string | null => {
  const m = /([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*[!?]?\s*$/.exec(text.replace(/\(.*$/s, '').trim())
  return m ? m[1] : null
}
const calleeFrom =
  (f: string): NameOf =>
  (n) => {
    const fn = n.childForFieldName(f)
    return fn ? lastIdent(fn.text) : null
  }
const firstNamedOfType = (n: TsNode, types: string[]): TsNode | null => {
  for (const c of n.namedChildren) if (c && types.includes(c.type)) return c
  return null
}
const findDeep = (n: TsNode, types: string[], depth = 4): TsNode | null => {
  if (depth < 0) return null
  for (const c of n.namedChildren) {
    if (!c) continue
    if (types.includes(c.type)) return c
    const d = findDeep(c, types, depth - 1)
    if (d) return d
  }
  return null
}
/** Visibility keywords are read only from the declaration head (before its name). */
const notPrivate = (n: TsNode) => {
  const nameNode = n.childForFieldName('name')
  const head = nameNode ? n.text.slice(0, Math.max(0, nameNode.startIndex - n.startIndex)) : n.text.split('\n')[0]
  return !/\b(?:private|protected|internal)\b/.test(head)
}
const unquote = (s: string) => s.replace(/^["'`<]|["'`>]$/g, '')

const SPECS: Partial<Record<SupportedLanguage, LangSpec>> = {
  python: {
    wasm: 'tree-sitter-python.wasm',
    decls: {
      class_definition: { kind: 'class', container: true },
      function_definition: { kind: 'function', callable: true },
    },
    wrappers: { decorated_definition: 'definition' },
    imports: {
      import_statement: (n) => ({ module: n.childForFieldName('name')?.text ?? n.text.replace(/^import\s+/, ''), names: [] }),
      import_from_statement: (n) => {
        const mod = n.childForFieldName('module_name')?.text ?? ''
        const names = n.namedChildren.filter((c): c is TsNode => !!c && c.type === 'dotted_name' && c.text !== mod).map((c) => c.text)
        return { module: mod, names }
      },
    },
    calls: { call: calleeFrom('function') },
    exported: (_n, name) => !name.startsWith('_'),
  },
  go: {
    wasm: 'tree-sitter-go.wasm',
    decls: {
      function_declaration: { kind: 'function', callable: true },
      method_declaration: {
        kind: 'method',
        callable: true,
        owner: (n) => {
          const recv = n.childForFieldName('receiver')
          const t = recv ? findDeep(recv, ['type_identifier']) : null
          return t?.text ?? null
        },
      },
      type_spec: {
        kind: 'type',
        name: field('name'),
      },
      const_spec: { kind: 'const', name: field('name') },
    },
    imports: {
      import_spec: (n) => {
        const p = unquote(n.childForFieldName('path')?.text ?? '')
        return p ? { module: p, names: [] } : null
      },
    },
    calls: { call_expression: calleeFrom('function') },
    exported: (_n, name) => /^[A-Z]/.test(name),
  },
  java: {
    wasm: 'tree-sitter-java.wasm',
    decls: {
      class_declaration: { kind: 'class', container: true },
      interface_declaration: { kind: 'interface', container: true },
      enum_declaration: { kind: 'enum', container: true },
      record_declaration: { kind: 'class', container: true },
      annotation_type_declaration: { kind: 'interface', container: true },
      method_declaration: { kind: 'method', callable: true },
      constructor_declaration: { kind: 'method', callable: true },
      field_declaration: { kind: 'property', name: (n) => findDeep(n, ['variable_declarator'], 1)?.childForFieldName('name')?.text ?? null },
    },
    imports: {
      import_declaration: (n) => {
        const t = n.text.replace(/^import\s+(?:static\s+)?/, '').replace(/[;\s]+$/, '')
        return { module: t, names: [t.split('.').pop() ?? t] }
      },
    },
    calls: { method_invocation: field('name'), object_creation_expression: (n) => lastIdent(n.childForFieldName('type')?.text ?? '') },
    exported: (n) => notPrivate(n),
  },
  csharp: {
    wasm: 'tree-sitter-c-sharp.wasm',
    decls: {
      namespace_declaration: { kind: 'namespace', container: true, namespace: true },
      file_scoped_namespace_declaration: { kind: 'namespace', container: true, namespace: true },
      class_declaration: { kind: 'class', container: true },
      struct_declaration: { kind: 'class', container: true },
      record_declaration: { kind: 'class', container: true },
      interface_declaration: { kind: 'interface', container: true },
      enum_declaration: { kind: 'enum', container: true },
      method_declaration: { kind: 'method', callable: true },
      constructor_declaration: { kind: 'method', callable: true },
      property_declaration: { kind: 'property' },
      field_declaration: { kind: 'property', name: (n) => findDeep(n, ['variable_declarator'], 3)?.namedChildren.find((c) => c?.type === 'identifier')?.text ?? findDeep(n, ['identifier'], 3)?.text ?? null },
    },
    imports: {
      using_directive: (n) => {
        const t = n.text.replace(/^(?:global\s+)?using\s+(?:static\s+)?/, '').replace(/[;\s]+$/, '')
        return { module: t, names: [] }
      },
    },
    calls: { invocation_expression: calleeFrom('function'), object_creation_expression: (n) => lastIdent(n.childForFieldName('type')?.text ?? '') },
    exported: (n) => notPrivate(n),
  },
  cpp: {
    wasm: 'tree-sitter-cpp.wasm',
    decls: {
      namespace_definition: { kind: 'namespace', container: true, namespace: true },
      class_specifier: { kind: 'class', container: true },
      struct_specifier: { kind: 'class', container: true },
      enum_specifier: { kind: 'enum' },
      function_definition: {
        kind: 'function',
        callable: true,
        name: (n) => {
          const d = n.childForFieldName('declarator')
          const fd = d ? (d.type === 'function_declarator' ? d : findDeep(d, ['function_declarator'], 3)) : null
          const target = fd?.childForFieldName('declarator')
          return target ? (lastIdent(target.text.split('::').pop() ?? target.text) ?? null) : null
        },
        owner: (n) => {
          const d = n.childForFieldName('declarator')
          const fd = d ? (d.type === 'function_declarator' ? d : findDeep(d, ['function_declarator'], 3)) : null
          const target = fd?.childForFieldName('declarator')
          if (target?.type === 'qualified_identifier') {
            const parts = target.text.split('::')
            return parts.length > 1 ? parts[parts.length - 2] : null
          }
          return null
        },
      },
    },
    imports: {
      preproc_include: (n) => {
        const p = unquote(n.childForFieldName('path')?.text ?? '')
        const stem = p.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
        return p ? { module: p, names: stem ? [stem] : [] } : null
      },
    },
    calls: { call_expression: calleeFrom('function') },
    exported: () => true,
  },
  rust: {
    wasm: 'tree-sitter-rust.wasm',
    decls: {
      struct_item: { kind: 'class' },
      enum_item: { kind: 'enum' },
      trait_item: { kind: 'interface', container: true },
      impl_item: { kind: 'class', container: true, transparent: true, name: (n) => lastIdent(n.childForFieldName('type')?.text ?? '') },
      mod_item: { kind: 'namespace', container: true, namespace: true },
      function_item: { kind: 'function', callable: true },
      function_signature_item: { kind: 'method' },
      const_item: { kind: 'const' },
      static_item: { kind: 'const' },
      type_item: { kind: 'type' },
      macro_definition: { kind: 'function' },
    },
    imports: {
      use_declaration: (n) => {
        const arg = n.childForFieldName('argument')?.text ?? n.text.replace(/^(?:pub\s+)?use\s+/, '').replace(/;$/, '')
        return { module: arg, names: [lastIdent(arg.replace(/::\{.*$/, '')) ?? arg] }
      },
    },
    calls: { call_expression: calleeFrom('function'), macro_invocation: (n) => lastIdent(n.childForFieldName('macro')?.text ?? '') },
    // Trait items are as public as the trait itself.
    exported: (n) => n.namedChildren.some((c) => c?.type === 'visibility_modifier') || n.parent?.parent?.type === 'trait_item',
  },
  ruby: {
    wasm: 'tree-sitter-ruby.wasm',
    decls: {
      module: { kind: 'namespace', container: true, namespace: true },
      class: { kind: 'class', container: true },
      method: { kind: 'method', callable: true },
      singleton_method: { kind: 'method', callable: true, name: (n) => n.childForFieldName('name')?.text ?? null },
    },
    imports: {
      call: (n) => {
        const m = n.childForFieldName('method')?.text
        if (m !== 'require' && m !== 'require_relative') return null
        const arg = findDeep(n, ['string_content'], 3)?.text
        return arg ? { module: m === 'require_relative' ? `./${arg}` : arg, names: [] } : null
      },
    },
    calls: { call: (n) => n.childForFieldName('method')?.text ?? null },
    exported: (_n, name) => !name.startsWith('_'),
  },
  php: {
    wasm: 'tree-sitter-php.wasm',
    decls: {
      class_declaration: { kind: 'class', container: true },
      interface_declaration: { kind: 'interface', container: true },
      trait_declaration: { kind: 'interface', container: true },
      enum_declaration: { kind: 'enum', container: true },
      method_declaration: { kind: 'method', callable: true },
      function_definition: { kind: 'function', callable: true },
      property_declaration: { kind: 'property', name: (n) => findDeep(n, ['property_element'], 1)?.childForFieldName('name')?.text?.replace(/^\$/, '') ?? null },
    },
    imports: {
      namespace_use_clause: (n) => {
        const t = n.text.replace(/\s+as\s+\w+$/, '')
        return { module: t, names: [t.split('\\').pop() ?? t] }
      },
    },
    calls: {
      function_call_expression: calleeFrom('function'),
      member_call_expression: field('name'),
      scoped_call_expression: field('name'),
      object_creation_expression: (n) => lastIdent(n.namedChildren.find((c) => c?.type === 'name' || c?.type === 'qualified_name')?.text ?? ''),
    },
    exported: (n) => notPrivate(n),
  },
  bash: {
    wasm: 'tree-sitter-bash.wasm',
    decls: { function_definition: { kind: 'function', callable: true } },
    calls: { command: (n) => n.childForFieldName('name')?.text ?? null },
    exported: () => true,
  },
  powershell: {
    wasm: 'tree-sitter-powershell.wasm',
    decls: {
      function_statement: { kind: 'function', callable: true, name: (n) => firstNamedOfType(n, ['function_name'])?.text ?? null },
      class_statement: { kind: 'class', container: true, name: (n) => firstNamedOfType(n, ['simple_name'])?.text ?? null },
      class_method_definition: { kind: 'method', callable: true, name: (n) => firstNamedOfType(n, ['simple_name'])?.text ?? null },
      class_property_definition: { kind: 'property', name: (n) => firstNamedOfType(n, ['variable'])?.text?.replace(/^\$/, '') ?? null },
    },
    calls: { command: (n) => firstNamedOfType(n, ['command_name'])?.text ?? null },
    exported: () => true,
  },
}

export const TREE_SITTER_LANGS: ReadonlySet<string> = new Set(Object.keys(SPECS))

// ---------------------------------------------------------------- usages (refs)

/** Identifier-like leaves recorded as usages. */
const REF_TYPES = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'namespace_identifier',
  'constant',
  'name',
  'simple_name',
  'command_name',
  'variable_name',
])
/** Fields holding the receiver of a member access / method call. */
const RECEIVER_FIELDS = ['object', 'operand', 'receiver', 'value', 'argument', 'expression', 'scope', 'path']
/** Fields holding the member name of an access. */
const MEMBER_FIELDS = ['field', 'attribute', 'property', 'method', 'name']
const ACCESS_TYPES = new Set([
  'attribute',
  'selector_expression',
  'field_access',
  'member_access_expression',
  'nullsafe_member_access_expression',
  'field_expression',
  'scoped_identifier',
  'qualified_identifier',
  'member_expression',
  'member_call_expression',
  'nullsafe_member_call_expression',
  'scoped_call_expression',
  'method_invocation',
  'scoped_type_identifier',
])
const sameNode = (a: TsNode | null, b: TsNode) => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex

function refKindOf(node: TsNode, spec: LangSpec): RefKind {
  const p = node.parent
  if (!p) return 'other'
  const isCall = !!spec.calls?.[p.type]
  if (!isCall && !ACCESS_TYPES.has(p.type)) return 'other'
  if (RECEIVER_FIELDS.some((f) => sameNode(p.childForFieldName(f), node))) return 'other'
  const hasReceiver = RECEIVER_FIELDS.some((f) => p.childForFieldName(f) !== null)
  if (hasReceiver && MEMBER_FIELDS.some((f) => sameNode(p.childForFieldName(f), node))) {
    if (isCall) return 'member_call'
    const gp = p.parent
    if (gp && spec.calls?.[gp.type] && (sameNode(gp.childForFieldName('function'), p) || sameNode(gp.childForFieldName('name'), p))) return 'member_call'
    return 'member'
  }
  return isCall ? 'call' : 'other'
}

// ---------------------------------------------------------------- runtime state

interface RuntimeState {
  ready: boolean
  reason?: string
  parsers: Map<string, TsParser>
  /** TS/TSX/JS grammars: syntax validation of edits only (extraction stays on the own scanner). */
  validators: Map<string, TsParser>
  version?: string
}

const VALIDATION_GRAMMARS: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
}

const state: RuntimeState = { ready: false, reason: 'não inicializado', parsers: new Map(), validators: new Map() }

/** Loads the WASM runtime and every grammar once. Never throws: reports why it is off. */
export async function initTreeSitter(): Promise<{ ready: boolean; languages: string[]; reason?: string; ms: number }> {
  const t0 = performance.now()
  if (state.ready) return { ready: true, languages: [...state.parsers.keys()], ms: 0 }
  if (process.env.KVX_TREE_SITTER === '0') {
    state.reason = 'desligado por KVX_TREE_SITTER=0'
    return { ready: false, languages: [], reason: state.reason, ms: 0 }
  }
  let mod: TsModule
  let wasmDir: string
  try {
    const require = createRequire(import.meta.url)
    const main = require.resolve('@vscode/tree-sitter-wasm')
    wasmDir = dirname(main)
    mod = require('@vscode/tree-sitter-wasm') as TsModule
    state.version = (require('@vscode/tree-sitter-wasm/package.json') as { version?: string }).version
  } catch {
    state.reason = 'pacote opcional @vscode/tree-sitter-wasm não instalado (rode `npm install` no kvx)'
    return { ready: false, languages: [], reason: state.reason, ms: Math.round(performance.now() - t0) }
  }
  try {
    await mod.Parser.init({ locateFile: (file: string) => join(wasmDir, file) })
    for (const [lang, spec] of Object.entries(SPECS)) {
      const wasmPath = join(wasmDir, spec!.wasm)
      if (!existsSync(wasmPath)) continue
      const language = await mod.Language.load(wasmPath)
      const parser = new mod.Parser()
      parser.setLanguage(language)
      state.parsers.set(lang, parser)
    }
    for (const [key, wasm] of Object.entries(VALIDATION_GRAMMARS)) {
      const wasmPath = join(wasmDir, wasm)
      if (!existsSync(wasmPath)) continue
      const parser = new mod.Parser()
      parser.setLanguage(await mod.Language.load(wasmPath))
      state.validators.set(key, parser)
    }
    state.ready = state.parsers.size > 0
    state.reason = state.ready ? undefined : 'nenhuma gramática .wasm encontrada'
  } catch (err) {
    state.ready = false
    state.reason = `falha ao carregar o tree-sitter: ${err instanceof Error ? err.message : String(err)}`
  }
  return { ready: state.ready, languages: [...state.parsers.keys()], reason: state.reason, ms: Math.round(performance.now() - t0) }
}

export function treeSitterStatus(): { ready: boolean; languages: string[]; reason?: string; version?: string } {
  return { ready: state.ready, languages: [...state.parsers.keys()], reason: state.reason, version: state.version }
}

export function treeSitterHandles(lang: string): boolean {
  return state.ready && state.parsers.has(lang)
}

/**
 * Number of syntax errors (ERROR/MISSING nodes) in `content`, or null when no grammar covers
 * the file. Used to refuse edits that break a file that parsed before.
 */
export function syntaxErrorCount(lang: string, relPath: string, content: string): number | null {
  if (!state.ready) return null
  const lower = relPath.toLowerCase()
  const parser =
    lang === 'typescript'
      ? state.validators.get(lower.endsWith('.tsx') ? 'tsx' : 'typescript')
      : lang === 'javascript'
        ? state.validators.get('javascript')
        : state.parsers.get(lang)
  if (!parser) return null
  let tree: TsTree | null = null
  try {
    tree = parser.parse(content)
    if (!tree) return null
    let errors = 0
    const walk = (n: TsNode) => {
      if (n.isError || n.isMissing) {
        errors++
        return
      }
      if (!n.hasError) return
      for (const c of n.children) if (c) walk(c)
    }
    walk(tree.rootNode)
    return errors
  } catch {
    return null
  } finally {
    try {
      tree?.delete()
    } catch {
      // released with the parser
    }
  }
}

// ---------------------------------------------------------------- extraction

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

function signatureOf(node: TsNode, src: string, lang: string): string {
  const body = node.childForFieldName('body')
  const end = body && body.startIndex > node.startIndex ? body.startIndex : Math.min(node.endIndex, node.startIndex + 400)
  let sig = src.slice(node.startIndex, end)
  if (!body) sig = sig.split('\n')[0]
  sig = sig.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim()
  if (lang === 'go' && node.type === 'type_spec') sig = `type ${sig}`
  if (lang === 'go' && node.type === 'const_spec') sig = `const ${sig}`
  return sig.slice(0, 320)
}

const HASH_COMMENT_LANGS: ReadonlySet<string> = new Set(['python', 'ruby', 'bash', 'powershell'])

/** Comment block right above the declaration, with the comment syntax of the language. */
function leadingDoc(lines: string[], lineIdx: number, lang: string): string {
  const hashLang = HASH_COMMENT_LANGS.has(lang)
  const isComment = (t: string) =>
    hashLang ? (t.startsWith('#') && !t.startsWith('#!')) || t.startsWith('<#') || t.endsWith('#>') : /^(?:\/\/|\/\*|\*)/.test(t)
  // Decorators / attributes between the doc and the declaration: `@x`, `[Attr]`, `#[derive]`.
  const isAttribute = (t: string) => /^@|^\[/.test(t) || (!hashLang && t.startsWith('#['))
  const docs: string[] = []
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 12); i--) {
    const t = lines[i]?.trim() ?? ''
    if (isComment(t)) {
      const cleaned = t
        .replace(/^(?:\/\/[/!]?|\/\*+!?|\*+(?!\/)|<#|#+)\s*/, '')
        .replace(/\s*(?:\*+\/|#>)\s*$/, '')
        .trim()
      if (cleaned && !/^@(?:param|returns?|throws)\b/.test(cleaned)) docs.unshift(cleaned)
    } else if (t === '' && docs.length === 0) {
      continue
    } else if (isAttribute(t) && docs.length === 0) {
      continue
    } else break
  }
  return docs.join(' ').slice(0, 280)
}

/** Python docstring: the first statement of the body when it is a string literal. */
function pythonDocstring(node: TsNode): string {
  const first = node.childForFieldName('body')?.namedChildren[0]
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null
  if (!str || str.type !== 'string') return ''
  const text = str.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '')
  return text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 280)
}

/** Extracts symbols/edges with tree-sitter, or returns null when the language is not handled. */
export function treeSitterExtract(file: ScannedFile): ExtractionResult | null {
  const spec = SPECS[file.lang]
  const parser = state.parsers.get(file.lang)
  if (!spec || !parser) return null
  let tree: TsTree | null = null
  try {
    tree = parser.parse(file.content)
    if (!tree) return null
    const src = file.content
    const lines = src.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    const routes: ExtractedRoute[] = []
    const seenQualified = new Map<string, number>()
    const callSeen = new Set<string>()
    const refs: RefTuple[] = []
    const pushRef = (n: TsNode, kind: RefKind) => {
      if (refs.length >= MAX_REFS_PER_FILE) return
      const name = src.slice(n.startIndex, n.endIndex)
      if (name.length < 2 || name.length > 80) return
      refs.push([name.replace(/^\$/, ''), n.startPosition.row + 1, n.startPosition.column + 1, kind])
    }
    const collectImportRefs = (n: TsNode) => {
      if (REF_TYPES.has(n.type)) pushRef(n, 'import')
      for (const c of n.namedChildren) if (c) collectImportRefs(c)
    }

    type Parent = { name: string; ns: boolean } | undefined
    const visit = (node: TsNode, parent: Parent, scope: SymbolScope, owner: string | undefined, rangeNode?: TsNode): void => {
      // Imports
      const imp = spec.imports?.[node.type]?.(node)
      if (imp && imp.module) {
        const names = imp.names.filter(Boolean)
        if (names.length === 0) {
          edges.push({ srcSymbolName: '__file__', dstName: imp.module.split(/[./\\:]+/).filter(Boolean).pop() ?? imp.module, dstPathHint: imp.module, kind: 'imports', weight: 1.0 })
        } else {
          for (const n of names) edges.push({ srcSymbolName: '__file__', dstName: n, dstPathHint: imp.module, kind: 'imports', weight: 1.2 })
        }
        // An import holds no declarations: its identifiers are import usages.
        collectImportRefs(node)
        return
      }
      if (REF_TYPES.has(node.type)) pushRef(node, refKindOf(node, spec))
      // Calls (attributed to the enclosing callable)
      const callFn = spec.calls?.[node.type]
      if (callFn && owner) {
        const callee = callFn(node)
        if (callee && callee.length >= 3 && callee !== owner.split('.').pop()) {
          const key = `${owner}>${callee}`
          if (!callSeen.has(key)) {
            callSeen.add(key)
            edges.push({ srcSymbolName: owner, dstName: callee, kind: 'calls', weight: 1.0 })
          }
        }
      }
      // Wrappers (decorators): the wrapped definition's range starts at the decorator
      const wrapField = spec.wrappers?.[node.type]
      if (wrapField) {
        const inner = node.childForFieldName(wrapField) ?? node.namedChildren.find((c) => c && spec.decls[c.type]) ?? null
        if (inner) {
          // decorators/attributes are usages too (`@login_required`, `@app.get`)
          for (const c of node.namedChildren) if (c && !sameNode(c, inner)) visit(c, parent, scope, owner)
          visit(inner, parent, scope, owner, node)
          return
        }
      }

      const decl = spec.decls[node.type]
      if (decl) {
        const declOwner = decl.owner?.(node) ?? null
        const name = (decl.name ?? field('name'))(node)
        if (name && decl.transparent) {
          // `impl Point { fn new }` -> Point.new, without a second `Point` symbol.
          for (const c of node.namedChildren) if (c) visit(c, { name, ns: false }, scope, owner)
          return
        }
        if (name) {
          // A class inside a namespace starts its own qualification; loose functions keep it.
          const inherited = decl.container && !decl.namespace && parent?.ns ? undefined : parent?.name
          const effectiveParent = declOwner ?? inherited
          const symScope: SymbolScope = scope === 'local' ? 'local' : effectiveParent ? 'member' : 'module'
          const kind: SymbolKind = decl.kind === 'function' && effectiveParent && symScope === 'member' ? 'method' : decl.kind
          const base = effectiveParent ? `${effectiveParent}.${name}` : name
          const n = (seenQualified.get(base) ?? 0) + 1
          seenQualified.set(base, n)
          const qualified = n === 1 ? base : `${base}~${n}`
          const r = rangeNode ?? node
          const startLine = r.startPosition.row + 1
          const endLine = Math.max(startLine, r.endPosition.row + (r.endPosition.column === 0 && r.endPosition.row > r.startPosition.row ? 0 : 1))
          const sliceText = lines.slice(startLine - 1, endLine).join('\n')
          const goTypeKind: SymbolKind | null =
            file.lang === 'go' && node.type === 'type_spec'
              ? node.childForFieldName('type')?.type === 'interface_type'
                ? 'interface'
                : node.childForFieldName('type')?.type === 'struct_type'
                  ? 'class'
                  : 'type'
              : null
          symbols.push({
            name,
            qualifiedName: `${file.relPath}#${qualified}`,
            kind: goTypeKind ?? kind,
            exported: symScope !== 'local' && spec.exported(node, name, symScope),
            scope: symScope,
            parent: effectiveParent,
            startLine,
            endLine,
            signature: signatureOf(node, src, file.lang),
            bodyHash: hash(sliceText),
            tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
            docSummary: (file.lang === 'python' ? pythonDocstring(node) : '') || leadingDoc(lines, startLine - 1, file.lang),
            sliceText,
          })
          const childParent: Parent = decl.container ? { name: qualified.replace(/~\d+$/, ''), ns: !!decl.namespace } : parent
          const childScope: SymbolScope = decl.callable ? 'local' : scope
          const childOwner = decl.callable && symScope !== 'local' ? qualified : owner
          for (const c of node.namedChildren) if (c) visit(c, childParent, childScope, childOwner)
          return
        }
      }
      for (const c of node.namedChildren) if (c) visit(c, parent, scope, owner)
    }

    visit(tree.rootNode, undefined, 'module', undefined)

    const topLevel = symbols.filter((s) => s.scope === 'module')
    return {
      isHub: topLevel.length > 35 || edges.length > 45,
      summary: (topLevel.length > 0 ? topLevel : symbols)
        .slice(0, 8)
        .map((s) => `${s.kind} ${s.name}`)
        .join(', '),
      headings: symbols.filter((s) => s.scope !== 'local').map((s) => s.name).join(' '),
      symbols,
      edges,
      routes,
      refs,
    }
  } catch {
    return null
  } finally {
    try {
      tree?.delete()
    } catch {
      // the WASM heap is released with the parser
    }
  }
}
