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

  private hashSlice(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
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
    let currentClass: string | null = null
    let classEndLine = 0

    // 1. Extract imports & re-exports
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const importMatch =
        /^\s*(?:import|export)\s+(?:type\s+)?(?:(\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/.exec(
          line,
        )
      if (importMatch) {
        const specifiers = importMatch[1] ?? ''
        const modPath = importMatch[2]
        const names = specifiers
          .replace(/[{}]/g, '')
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean)

        if (names.length === 0) {
          edges.push({
            srcSymbolName: '__file__',
            dstName: basename(modPath).replace(/\.\w+$/, ''),
            dstPathHint: modPath,
            kind: 'imports',
            weight: 1.0,
          })
        } else {
          for (const n of names) {
            edges.push({
              srcSymbolName: '__file__',
              dstName: n.replace(/^\*\s*/, ''),
              dstPathHint: modPath,
              kind: 'imports',
              weight: 1.2,
            })
          }
        }
      }
    }

    // 2. Extract Declarations & Routes
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNo = i + 1
      if (currentClass && lineNo > classEndLine) {
        currentClass = null
      }

      // Class / Interface / Type / Enum
      const typeDecl =
        /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?(?:\s+implements\s+([A-Za-z_$][\w$.,\s]*))?/.exec(
          line,
        )
      if (typeDecl) {
        const exported = Boolean(typeDecl[1])
        const kind = typeDecl[2] as SymbolKind
        const name = typeDecl[3]
        const extendsTarget = typeDecl[4]
        const implementsTargets = typeDecl[5]
        const endLine = this.findBlockEnd(lines, i, 200)
        const sliceText = lines.slice(i, endLine).join('\n')
        const signature = line.replace(/\{\s*$/, '').trim()

        if (kind === 'class') {
          currentClass = name
          classEndLine = endLine
        }

        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind,
          exported,
          startLine: lineNo,
          endLine,
          signature,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: this.extractLeadingDoc(lines, i),
          sliceText,
        })

        if (extendsTarget) {
          edges.push({
            srcSymbolName: name,
            dstName: extendsTarget.trim(),
            kind: 'extends',
            weight: 1.8,
          })
        }
        if (implementsTargets) {
          for (const impl of implementsTargets.split(',')) {
            const clean = impl.trim()
            if (clean) {
              edges.push({
                srcSymbolName: name,
                dstName: clean,
                kind: 'implements',
                weight: 1.6,
              })
            }
          }
        }
        continue
      }

      // Function / Const Arrow Function (supports multi-line parameter lists)
      const fnDecl =
        /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(
          line,
        )
      const arrowDecl = !fnDecl
        ? /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/.exec(
            line,
          )
        : null

      const fnMatch = fnDecl ?? arrowDecl
      if (fnMatch) {
        const exported = Boolean(fnMatch[1])
        const name = fnMatch[2]
        const endLine = this.findBlockEnd(lines, i, 160)
        const sliceText = lines.slice(i, endLine).join('\n')
        const signature = this.extractSignature(lines, i)

        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind: 'function',
          exported,
          startLine: lineNo,
          endLine,
          signature,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: this.extractLeadingDoc(lines, i),
          sliceText,
        })
        this.extractCallSitesFromBlock(name, sliceText, edges, routes)
        continue
      }

      // Class Method (supports multi-line parameters)
      if (currentClass) {
        const methodDecl =
          /^\s*(?:(public|private|protected|readonly|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(
            line,
          )
        if (methodDecl) {
          const methodName = methodDecl[2]
          if (!JS_STOPWORDS.has(methodName) && methodName !== 'constructor') {
            const endLine = this.findBlockEnd(lines, i, 120)
            const sliceText = lines.slice(i, endLine).join('\n')
            const qualifiedSym = `${currentClass}.${methodName}`
            const cleanSig = this.extractSignature(lines, i)
            symbols.push({
              name: methodName,
              qualifiedName: `${file.relPath}#${qualifiedSym}`,
              kind: 'method',
              exported: true,
              startLine: lineNo,
              endLine,
              signature: `${currentClass}.${cleanSig}`,
              bodyHash: this.hashSlice(sliceText),
              tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
              docSummary: this.extractLeadingDoc(lines, i),
              sliceText,
            })
            this.extractCallSitesFromBlock(qualifiedSym, sliceText, edges, routes)
          }
        }
      }

      // Express / Fastify / Hono Route Expositions
      const routeExpose =
        /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(
          line,
        )
      if (routeExpose) {
        const method = routeExpose[1].toUpperCase()
        const pathPattern = routeExpose[2]
        const routeSym = `${method} ${pathPattern}`
        const endLine = this.findBlockEnd(lines, i, 60)
        const sliceText = lines.slice(i, endLine).join('\n')
        symbols.push({
          name: routeSym,
          qualifiedName: `${file.relPath}#${routeSym}`,
          kind: 'route',
          exported: true,
          startLine: lineNo,
          endLine,
          signature: `${method} ${pathPattern}`,
          bodyHash: this.hashSlice(sliceText),
          tokenEstimate: Math.max(1, Math.ceil(sliceText.length / 4)),
          docSummary: `HTTP Route ${method} ${pathPattern}`,
          sliceText,
        })
        routes.push({
          symbolName: routeSym,
          direction: 'expose',
          method,
          pathPattern,
          framework: 'http-router',
        })
      }
    }

    if (symbols.length === 0) {
      return this.extractGeneric(file)
    }

    return {
      isHub: symbols.length > 35 || edges.length > 45,
      summary: symbols
        .slice(0, 8)
        .map((s) => `${s.kind} ${s.name}`)
        .join(', '),
      headings: symbols.map((s) => s.name).join(' '),
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
        const kind: SymbolKind = decl[2] === 'class' ? 'class' : 'function'
        const name = decl[3]
        let endIdx = i + 1
        while (endIdx < lines.length && endIdx < i + 120) {
          const next = lines[endIdx]
          if (next.trim() !== '' && !next.trim().startsWith('#')) {
            const nextIndent = next.match(/^\s*/)?.[0].length ?? 0
            if (nextIndent <= indent) break
          }
          endIdx++
        }
        const sliceText = lines.slice(i, endIdx).join('\n')
        symbols.push({
          name,
          qualifiedName: `${file.relPath}#${name}`,
          kind,
          exported: !name.startsWith('_'),
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fn =
        /^\s*func\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(
          line,
        )
      if (fn) {
        const recv = fn[1]
        const name = fn[2]
        const qName = recv ? `${recv}.${name}` : name
        const endLine = this.findBlockEnd(lines, i, 120)
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
        continue
      }

      const typeMatch = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(line)
      if (typeMatch) {
        const name = typeMatch[1]
        const endLine = this.findBlockEnd(lines, i, 120)
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
      routes: [],
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
        const endLine = this.findBlockEnd(lines, i, 120)
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
        const endLine = Math.min(lines.length, i + 45)
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
          .slice(0, 280)

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
          docSummary: bodyPreview || cur.title,
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
