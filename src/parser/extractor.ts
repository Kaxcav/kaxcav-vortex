import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type {
  ExtractedEdge,
  ExtractedRoute,
  ExtractedSymbol,
  ExtractionResult,
  ScannedFile,
  SymbolKind,
} from '../core/types.ts'
import { CodeStateMachine } from './lexer.ts'
import { TsDeclarationScanner, type TsScanResult } from './ts-scanner.ts'

/**
 * Bump whenever extraction output changes, so cached extractions (CAS) and stored
 * symbols are rebuilt instead of mixing old and new ranges.
 */
export const EXTRACTOR_VERSION = 'x7-scope-ast'

const CODE_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'python', 'go', 'powershell'])

const JS_STOPWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'instanceof',
  'new',
  'delete',
  'void',
  'yield',
  'await',
  'async',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'const',
  'let',
  'var',
  'import',
  'export',
  'from',
  'require',
  'super',
  'this',
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Promise',
  'Map',
  'Set',
  'Error',
  'RegExp',
  'Date',
  'Buffer',
  'parseInt',
  'parseFloat',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
])

const HUB_FILENAME_REGEX =
  /^(mapa[-_]?geral|central[-_]?relacionamentos|index|indice|readme|sumario|catalogo|overview)/i

export class PolyglotExtractor {
  extract(file: ScannedFile): ExtractionResult {
    const res = this.extractByLanguage(file)
    // Slop markers are about code: a Markdown heading like `## TODO` is not a code placeholder.
    res.slopFindings = CODE_LANGS.has(file.lang) ? CodeStateMachine.scanSlop(file.relPath, file.content) : []
    for (const sym of res.symbols) {
      sym.complexity = this.computeComplexity(sym.sliceText)
      sym.scope ??= 'module'
    }
    return res
  }

  private extractByLanguage(file: ScannedFile): ExtractionResult {
    switch (file.lang) {
      case 'typescript':
      case 'javascript':
        return this.extractTsJs(file)
      case 'python':
        return this.extractPython(file)
      case 'go':
        return this.extractGo(file)
      case 'prisma':
      case 'sql':
        return this.extractDataSchema(file)
      case 'markdown':
        return this.extractMarkdown(file)
      default:
        return this.extractGeneric(file)
    }
  }

  private computeComplexity(text: string): number {
    const code = CodeStateMachine.stripStringsAndComments(text)
    const matches = code.match(/\b(if|else if|for|while|case|catch)\b|&&|\|\||\?/g)
    return 1 + (matches ? matches.length : 0)
  }

  private extractCallSitesFromPythonBlock(ownerSym: string, block: string, edges: ExtractedEdge[], routes: ExtractedRoute[]): void {
    const codeOnly = block.replace(/#.*/g, '')
    const seen = new Set<string>()
    const callRegex = /([A-Za-z_]\w*)\s*\(/g
    let match;
    while ((match = callRegex.exec(codeOnly)) !== null) {
      const callee = match[1]
      if (callee.length < 3 || callee === ownerSym) continue
      if (seen.has(callee)) continue
      seen.add(callee)
      edges.push({ srcSymbolName: ownerSym, dstName: callee, kind: 'calls', weight: 1.0 })
    }
    const fetchRegex = /\b(?:requests|httpx)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi
    let fMatch;
    while ((fMatch = fetchRegex.exec(block)) !== null) {
      routes.push({ symbolName: ownerSym, direction: 'consume', method: fMatch[1].toUpperCase(), pathPattern: fMatch[2], framework: 'python-http' })
      edges.push({ srcSymbolName: ownerSym, dstName: fMatch[2], kind: 'routes_to', weight: 2.0 })
    }
  }

  private extractCallSitesFromGoBlock(ownerSym: string, block: string, edges: ExtractedEdge[], routes: ExtractedRoute[]): void {
    const codeOnly = block.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')
    const seen = new Set<string>()
    const callRegex = /(?:\b[\w]+\.)?([A-Za-z_]\w*)\s*\(/g
    let match;
    while ((match = callRegex.exec(codeOnly)) !== null) {
      const callee = match[1]
      if (callee.length < 3 || callee === ownerSym || callee === 'if' || callee === 'for') continue
      if (seen.has(callee)) continue
      seen.add(callee)
      edges.push({ srcSymbolName: ownerSym, dstName: callee, kind: 'calls', weight: 1.0 })
    }
    const fetchRegex = /\b(?:http|client)\.(?:Get|Post|Put|Patch|Delete|Do)\s*\(\s*['"]([^'"]+)['"]/g
    let fMatch;
    while ((fMatch = fetchRegex.exec(block)) !== null) {
      routes.push({ symbolName: ownerSym, direction: 'consume', method: 'ANY', pathPattern: fMatch[1], framework: 'go-http' })
      edges.push({ srcSymbolName: ownerSym, dstName: fMatch[1], kind: 'routes_to', weight: 2.0 })
    }
  }

  
  private hashSlice(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
  }

  /** End line (1-based) of a SQL statement: the `;` closing the balanced `( ... )` of CREATE TABLE. */
  private findSqlStatementEnd(lines: string[], startIdx: number): number {
    let depth = 0
    let opened = false
    let quote = ''
    let inBlockComment = false
    for (let li = startIdx; li < lines.length; li++) {
      const line = lines[li]
      for (let c = 0; c < line.length; c++) {
        const ch = line[c]
        if (inBlockComment) {
          if (ch === '*' && line[c + 1] === '/') {
            inBlockComment = false
            c++
          }
          continue
        }
        if (quote) {
          if (ch === quote) quote = ''
          continue
        }
        if (ch === '/' && line[c + 1] === '*') {
          inBlockComment = true
          c++
          continue
        }
        if (ch === '-' && line[c + 1] === '-') break
        if (ch === "'" || ch === '"' || ch === '`') quote = ch
        else if (ch === '(') {
          depth++
          opened = true
        } else if (ch === ')') depth--
        else if (ch === ';' && depth <= 0) return li + 1
      }
      const nextLine = lines[li + 1] ?? ''
      if (opened && depth <= 0 && !/^\s*(?:;|WITH|WITHOUT|STRICT|ENGINE|PARTITION|INHERITS|TABLESPACE)/i.test(nextLine)) {
        return li + 1
      }
    }
    return Math.min(lines.length, startIdx + 1)
  }

  private findBlockEnd(lines: string[], startIdx: number, maxSpan = 220): number {
    return CodeStateMachine.findBalancedBlockEnd(lines, startIdx, maxSpan)
  }

  private extractSignature(lines: string[], startIdx: number): string {
    return CodeStateMachine.extractCleanSignature(lines, startIdx, 6)
  }

  private extractLeadingDoc(lines: string[], lineIdx: number): string {
    const docs: string[] = []
    for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 8); i--) {
      const trimmed = lines[i].trim()
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*/') ||
        trimmed.startsWith('#')
      ) {
        const cleaned = trimmed
          .replace(/^(\/\/+|\/\*+|\*+\/?|#+)\s*/, '')
          .trim()
        if (cleaned) docs.unshift(cleaned)
      } else if (trimmed === '') {
        if (docs.length > 0) break
      } else {
        break
      }
    }
    return docs.join(' ').slice(0, 280)
  }

  private extractTsJs(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    const routes: ExtractedRoute[] = []

    let scan: TsScanResult
    try {
      scan = TsDeclarationScanner.scan(file.content)
    } catch {
      return this.extractGeneric(file)
    }

    // 1. Imports, re-exports, require() and dynamic import()
    for (const imp of scan.imports) {
      if (imp.names.length === 0) {
        edges.push({
          srcSymbolName: '__file__',
          dstName: basename(imp.modulePath).replace(/\.\w+$/, ''),
          dstPathHint: imp.modulePath,
          kind: 'imports',
          weight: 1.0,
        })
        continue
      }
      for (const n of imp.names) {
        edges.push({
          srcSymbolName: '__file__',
          dstName: n,
          dstPathHint: imp.modulePath,
          kind: 'imports',
          weight: 1.2,
        })
      }
    }

    // 2. Declarations (module, class members, locals) and routes, with AST-accurate ranges
    for (const d of scan.declarations) {
      const sliceText = lines.slice(d.startLine - 1, d.endLine).join('\n')
      symbols.push({
        name: d.name,
        qualifiedName: `${file.relPath}#${d.qualifiedSuffix}`,
        kind: d.kind,
        exported: d.exported,
        scope: d.scope,
        parent: d.parent,
        startLine: d.startLine,
        endLine: d.endLine,
        signature: d.signature,
        bodyHash: this.hashSlice(sliceText),
        tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
        docSummary:
          d.kind === 'route'
            ? `HTTP Route ${d.routeMethod} ${d.routePath}`
            : this.extractLeadingDoc(lines, d.startLine - 1),
        sliceText,
      })

      if (d.extendsName) {
        edges.push({ srcSymbolName: d.name, dstName: d.extendsName, kind: 'extends', weight: 1.8 })
      }
      for (const impl of d.implementsNames ?? []) {
        edges.push({ srcSymbolName: d.name, dstName: impl, kind: 'implements', weight: 1.6 })
      }
      if (d.kind === 'route' && d.routeMethod && d.routePath) {
        routes.push({
          symbolName: d.name,
          direction: 'expose',
          method: d.routeMethod,
          pathPattern: d.routePath,
          framework: 'http-router',
        })
      }
      // Locals are already covered by their enclosing symbol's call sites.
      if (d.callable && d.scope !== 'local') {
        const owner = d.scope === 'member' ? d.qualifiedSuffix : d.name
        this.extractCallSitesFromBlock(owner, sliceText, edges, routes)
      }
    }

    if (symbols.length === 0) {
      // Test files (`import …; test(…)`) and barrels (`export * from`) declare nothing, but
      // their import edges are what `affected` / `blast_radius` follow.
      const generic = this.extractGeneric(file)
      return { ...generic, edges, routes }
    }

    const topLevel = symbols.filter((s) => s.scope === 'module')
    return {
      isHub: topLevel.length > 35 || edges.length > 45,
      summary: (topLevel.length > 0 ? topLevel : symbols)
        .slice(0, 8)
        .map((s) => `${s.kind} ${s.name}`)
        .join(', '),
      headings: symbols
        .filter((s) => s.scope !== 'local')
        .map((s) => s.name)
        .join(' '),
      symbols,
      edges,
      routes,
    }
  }

  private extractCallSitesFromBlock(
    ownerSym: string,
    block: string,
    edges: ExtractedEdge[],
    routes: ExtractedRoute[],
  ): void {
    const codeOnly = CodeStateMachine.stripStringsAndComments(block)
    const seen = new Set<string>()
    const callRegex = /(?:\bthis\.|\b[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\(/g
    let match: RegExpExecArray | null
    while ((match = callRegex.exec(codeOnly)) !== null) {
      const callee = match[1]
      if (!callee || callee.length < 3 || JS_STOPWORDS.has(callee) || callee === ownerSym) continue
      if (seen.has(callee)) continue
      seen.add(callee)
      edges.push({
        srcSymbolName: ownerSym,
        dstName: callee,
        kind: 'calls',
        weight: 1.0,
      })
    }

    const fetchRegex =
      /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|api\.(?:get|post|put|patch|delete))\s*\(\s*['"`](\/[A-Za-z0-9_\-/]+)['"`]/gi
    let fMatch: RegExpExecArray | null
    while ((fMatch = fetchRegex.exec(block)) !== null) {
      const pathPattern = fMatch[1]
      routes.push({
        symbolName: ownerSym,
        direction: 'consume',
        method: 'ANY',
        pathPattern,
        framework: 'http-client',
      })
      edges.push({
        srcSymbolName: ownerSym,
        dstName: pathPattern,
        kind: 'routes_to',
        weight: 2.0,
      })
    }
  }

  private extractPython(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    const routes: ExtractedRoute[] = []
    const classStack: Array<{ name: string; indent: number }> = []
    const qualifiedSeen = new Map<string, number>()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const imp = /^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+([\w.]+))/.exec(line)
      if (imp) {
        const mod = imp[1] ?? imp[3] ?? ''
        edges.push({
          srcSymbolName: '__file__',
          dstName: mod.split('.').pop() ?? mod,
          dstPathHint: mod,
          kind: 'imports',
          weight: 1.1,
        })
        continue
      }

      const decl = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(line)
      if (decl) {
        const indent = decl[1].length
        while (classStack.length > 0 && classStack[classStack.length - 1].indent >= indent) classStack.pop()
        const owner = classStack[classStack.length - 1]
        const isMethod = decl[2] === 'def' && owner !== undefined
        const kind: SymbolKind = decl[2] === 'class' ? 'class' : isMethod ? 'method' : 'function'
        const name = decl[3]
        let endIdx = i + 1
        let inTripleQuote = ''
        while (endIdx < lines.length) {
          const next = lines[endIdx]
          // A docstring/multi-line string may have content at column 0: it never ends the block.
          const triples = next.match(/"""|'''/g)
          if (inTripleQuote) {
            if (triples && triples.includes(inTripleQuote)) inTripleQuote = ''
            endIdx++
            continue
          }
          if (next.trim() !== '' && !next.trim().startsWith('#')) {
            const nextIndent = next.match(/^\s*/)?.[0].length ?? 0
            if (nextIndent <= indent) break
          }
          if (triples && triples.length % 2 === 1) inTripleQuote = triples[0]
          endIdx++
        }
        // Trailing blank lines and comments belong to whatever comes next, not to this def.
        while (endIdx > i + 1 && (lines[endIdx - 1].trim() === '' || lines[endIdx - 1].trim().startsWith('#'))) endIdx--
        if (decl[2] === 'class') classStack.push({ name, indent })
        const baseQualified = isMethod ? `${owner.name}.${name}` : name
        const seenCount = (qualifiedSeen.get(baseQualified) ?? 0) + 1
        qualifiedSeen.set(baseQualified, seenCount)
        const qualifiedSuffix = seenCount === 1 ? baseQualified : `${baseQualified}~${seenCount}`
        const sliceText = lines.slice(i, endIdx).join('\n')
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const decMatch =
            /^\s*@(?:app|router|bp)\.(get|post|put|patch|delete|all|route)\s*\(\s*['"]([^'"]+)['"]/i.exec(
              lines[j],
            )
          if (decMatch) {
            routes.push({
              symbolName: name,
              direction: 'expose',
              method: decMatch[1].toUpperCase(),
              pathPattern: decMatch[2],
              framework: 'python-router',
            })
            break
          }
        }
        this.extractCallSitesFromPythonBlock(isMethod ? baseQualified : name, sliceText, edges, routes)
        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${qualifiedSuffix}`,
          kind,
          exported: !name.startsWith('_'),
          scope: isMethod ? 'member' : 'module',
          parent: isMethod ? owner.name : undefined,
          startLine: i + 1,
          endLine: endIdx,
          signature: line.trim(),
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: this.extractLeadingDoc(lines, i),
          sliceText,
        })
      }
    }

    if (symbols.length === 0) return this.extractGeneric(file)
    return {
      isHub: symbols.length > 35,
      summary: symbols.map((s) => s.name).slice(0, 8).join(', '),
      headings: symbols.map((s) => s.name).join(' '),
      symbols,
      edges,
      routes,
    }
  }

  private extractGo(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    const routes: ExtractedRoute[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const routeMatch =
        /\b(?:http\.HandleFunc|[a-zA-Z0-9_]+\.(?:GET|POST|PUT|PATCH|DELETE|ALL))\s*\(\s*["`]([^"`]+)["`]/i.exec(
          line,
        )
      if (routeMatch) {
        let method = 'ANY'
        const m2 = line.match(/\.(GET|POST|PUT|PATCH|DELETE|ALL)\b/i)
        if (m2) method = m2[1].toUpperCase()
        routes.push({
          symbolName: `GoRoute ${method} ${routeMatch[1]}`,
          direction: 'expose',
          method,
          pathPattern: routeMatch[1],
          framework: 'go-router',
        })
      }
      const fn =
        /^\s*func\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(
          line,
        )
      if (fn) {
        const recv = fn[1]
        const name = fn[2]
        const qName = recv ? `${recv}.${name}` : name
        const endLine = this.findBlockEnd(lines, i, lines.length)
        const sliceText = lines.slice(i, endLine).join('\n')
        symbols.push({
          name: qName,
          qualifiedName: `${file.relPath}#${qName}`,
          kind: recv ? 'method' : 'function',
          exported: /^[A-Z]/.test(name),
          startLine: i + 1,
          endLine,
          signature: line.replace(/\{\s*$/, '').trim(),
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: this.extractLeadingDoc(lines, i),
          sliceText,
        })
        this.extractCallSitesFromGoBlock(qName, sliceText, edges, routes)
        continue
      }

      const typeMatch = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(line)
      if (typeMatch) {
        const name = typeMatch[1]
        const endLine = this.findBlockEnd(lines, i, lines.length)
        const sliceText = lines.slice(i, endLine).join('\n')
        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind: typeMatch[2] === 'interface' ? 'interface' : 'class',
          exported: /^[A-Z]/.test(name),
          startLine: i + 1,
          endLine,
          signature: line.replace(/\{\s*$/, '').trim(),
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: this.extractLeadingDoc(lines, i),
          sliceText,
        })
      }
    }

    if (symbols.length === 0) return this.extractGeneric(file)
    return {
      isHub: false,
      summary: symbols.map((s) => s.name).slice(0, 8).join(', '),
      headings: symbols.map((s) => s.name).join(' '),
      symbols,
      edges,
      routes,
    }
  }

  private extractDataSchema(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const prismaModel = /^\s*(model|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(line)
      if (prismaModel) {
        const kind: SymbolKind = prismaModel[1] === 'enum' ? 'enum' : 'model'
        const name = prismaModel[2]
        const endLine = this.findBlockEnd(lines, i, lines.length)
        const sliceText = lines.slice(i, endLine).join('\n')
        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind,
          exported: true,
          startLine: i + 1,
          endLine,
          signature: `${prismaModel[1]} ${name}`,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: `Database ${kind} ${name}`,
          sliceText,
        })
        continue
      }

      const sqlTable =
        /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`\w]+\.)?["`]?([A-Za-z_]\w*)["`]?/i.exec(
          line,
        )
      if (sqlTable) {
        const name = sqlTable[1]
        const endLine = this.findSqlStatementEnd(lines, i)
        const sliceText = lines.slice(i, endLine).join('\n')
        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind: 'table',
          exported: true,
          startLine: i + 1,
          endLine,
          signature: `CREATE TABLE ${name}`,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: `SQL Table ${name}`,
          sliceText,
        })
      }
    }

    if (symbols.length === 0) return this.extractGeneric(file)
    return {
      isHub: symbols.length > 25,
      summary: symbols.map((s) => s.name).slice(0, 10).join(', '),
      headings: symbols.map((s) => s.name).join(' '),
      symbols,
      edges,
      routes: [],
    }
  }

  private extractMarkdown(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    const headingIndices: Array<{ title: string; level: number; lineIdx: number }> = []

    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i])
      if (m) {
        headingIndices.push({
          level: m[1].length,
          title: m[2].replace(/[`*_~]/g, '').trim(),
          lineIdx: i,
        })
      }
    }

    const baseFileName = basename(file.relPath, '.md')
    if (headingIndices.length === 0) {
      const sliceText = lines.slice(0, Math.min(lines.length, 90)).join('\n')
      symbols.push({
        name: baseFileName,
        qualifiedName: `${file.relPath}#${baseFileName}`,
        kind: 'section',
        exported: true,
        startLine: 1,
        endLine: lines.length,
        signature: `# ${baseFileName}`,
        bodyHash: this.hashSlice(sliceText),
        tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
        docSummary: lines.slice(0, 6).join(' ').slice(0, 260),
        sliceText,
      })
    } else {
      // Capture document-level preamble/frontmatter (e.g. Authority, Escopo, Fonte) under H1
      const firstH2Idx = headingIndices.find((h) => h.level >= 2)?.lineIdx ?? Math.min(lines.length, 10)
      const docPreamble = lines
        .slice(0, Math.min(firstH2Idx, 12))
        .map((l) => l.replace(/[#*_`]/g, '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 220)

      for (let h = 0; h < headingIndices.length; h++) {
        const cur = headingIndices[h]
        const nextLineIdx =
          h + 1 < headingIndices.length ? headingIndices[h + 1].lineIdx : lines.length
        const spanLines = lines.slice(cur.lineIdx, Math.min(nextLineIdx, cur.lineIdx + 95))
        const sliceText = spanLines.join('\n')
        const bodyPreview = spanLines
          .slice(1, 10)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 240)

        const fullSummary =
          cur.lineIdx > 0 && docPreamble
            ? `[${docPreamble}] ${bodyPreview || cur.title}`.slice(0, 320)
            : bodyPreview || cur.title

        symbols.push({
          name: cur.title,
          qualifiedName: `${file.relPath}#${cur.title}`,
          kind: 'section',
          exported: true,
          startLine: cur.lineIdx + 1,
          endLine: nextLineIdx,
          signature: `${'#'.repeat(cur.level)} ${cur.title}`,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: fullSummary,
          sliceText,
        })
      }
    }

    // Extract markdown links & wikilinks
    const linkRegex = /\[([^\]]+)\]\(([^)#]+)(?:#[^)]+)?\)|\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
    let lMatch: RegExpExecArray | null
    const seenLinks = new Set<string>()
    while ((lMatch = linkRegex.exec(file.content)) !== null) {
      const target = (lMatch[2] ?? lMatch[3] ?? '').trim()
      if (!target || target.startsWith('http://') || target.startsWith('https://')) continue
      if (seenLinks.has(target)) continue
      seenLinks.add(target)
      edges.push({
        srcSymbolName: symbols[0]?.name ?? baseFileName,
        dstName: basename(target).replace(/\.\w+$/, ''),
        dstPathHint: target,
        kind: 'references_doc',
        weight: 1.0,
      })
    }

    // Extract backticked code symbol references
    const codeRefRegex = /`([A-Za-z_][A-Za-z0-9_./-]{2,45})`/g
    let cMatch: RegExpExecArray | null
    while ((cMatch = codeRefRegex.exec(file.content)) !== null) {
      const ref = cMatch[1]
      if (seenLinks.has(ref)) continue
      seenLinks.add(ref)
      edges.push({
        srcSymbolName: symbols[0]?.name ?? baseFileName,
        dstName: ref,
        kind: 'mentions_symbol',
        weight: 0.6,
      })
    }

    // Hub detection: explicitly flags high out-degree index docs (e.g. CENTRAL-RELACIONAMENTOS.md, MAPA-GERAL.md)
    const isHub =
      HUB_FILENAME_REGEX.test(baseFileName) ||
      seenLinks.size > 18 ||
      (headingIndices.length > 20 && file.content.split('|').length > 60)

    return {
      isHub,
      summary: headingIndices
        .slice(0, 6)
        .map((h) => h.title)
        .join(' | '),
      headings: [baseFileName, ...headingIndices.map((h) => h.title)].join(' '),
      symbols,
      edges,
      routes: [],
    }
  }

  private extractGeneric(file: ScannedFile): ExtractionResult {
    const lines = file.content.split(/\r?\n/)
    const name = basename(file.relPath)
    const sliceText = lines.slice(0, Math.min(lines.length, 80)).join('\n')
    return {
      isHub: false,
      summary: lines.slice(0, 3).join(' ').slice(0, 200),
      headings: name,
      symbols: [
        {
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind: 'section',
          exported: true,
          startLine: 1,
          endLine: lines.length,
          signature: name,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: lines.slice(0, 4).join(' ').slice(0, 220),
          sliceText,
        },
      ],
      edges: [],
      routes: [],
    }
  }
}
