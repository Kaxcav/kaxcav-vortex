/**
 * Ground Truth extractor using the official TypeScript Compiler API.
 * Uses ts.LanguageService, ts.preProcessFile, and ts.resolveModuleName.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('./node_modules/typescript');

export interface GroundTruthDeclaration {
  name: string;
  qualified: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface GroundTruthReference {
  file: string; // repo-relative path with forward slashes
  line: number;
}

function getNodeStartLine(node: any, sourceFile: any): number {
  const startPos = node.getStart(sourceFile, false);
  return sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
}

function getNodeEndLine(node: any, sourceFile: any): number {
  const lastToken = node.getLastToken ? node.getLastToken(sourceFile) : null;
  const endPos = lastToken ? lastToken.getEnd() - 1 : Math.max(0, node.getEnd() - 1);
  return sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;
}

function hasModifier(node: any, kind: number): boolean {
  if (!node.modifiers) return false;
  return node.modifiers.some((m: any) => m.kind === kind);
}

export class GroundTruth {
  repoRoot: string;
  roots: string[];
  sourceFiles: string[]; // absolute paths
  sourceFileSet: Set<string>;
  compilerOptions: any;
  languageService: any;
  program: any;
  private fileContentCache = new Map<string, string>();
  private importersGraph: Map<string, Set<string>> | null = null;

  constructor(repoRoot: string, roots: string[] = ['src']) {
    this.repoRoot = path.resolve(repoRoot);
    this.roots = roots;
    this.sourceFiles = this.discoverSourceFiles();
    this.sourceFileSet = new Set(this.sourceFiles.map((f) => path.resolve(f)));

    this.compilerOptions = {
      allowJs: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
    };
    // The repo's own tsconfig decides module resolution (paths, customConditions, nodenext):
    // without it, package self-references such as zod's `zod/v4` stay unresolved.
    const tsconfigPath = path.join(this.repoRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this.repoRoot);
        this.compilerOptions = { ...parsed.options, allowJs: false, noEmit: true, skipLibCheck: true };
      }
    }

    const host = {
      getScriptFileNames: () => this.sourceFiles,
      getScriptVersion: () => '1',
      getScriptSnapshot: (fileName: string) => {
        const norm = path.resolve(fileName);
        let text = this.fileContentCache.get(norm);
        if (text === undefined) {
          try {
            text = fs.readFileSync(norm, 'utf8');
          } catch {
            return undefined;
          }
          this.fileContentCache.set(norm, text);
        }
        return ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.repoRoot,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options: any) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName: string) => fs.existsSync(fileName),
      readFile: (fileName: string) => {
        try {
          return fs.readFileSync(fileName, 'utf8');
        } catch {
          return undefined;
        }
      },
      directoryExists: (dirName: string) => {
        try {
          return fs.statSync(dirName).isDirectory();
        } catch {
          return false;
        }
      },
      getDirectories: (dirName: string) => {
        try {
          return fs.readdirSync(dirName, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
          return [];
        }
      },
    };

    const documentRegistry = ts.createDocumentRegistry();
    this.languageService = ts.createLanguageService(host, documentRegistry);
    this.program = this.languageService.getProgram();
  }

  private discoverSourceFiles(): string[] {
    const result: string[] = [];
    for (const root of this.roots) {
      const rootAbs = path.resolve(this.repoRoot, root);
      if (!fs.existsSync(rootAbs)) continue;
      const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(this.repoRoot, full).replace(/\\/g, '/');
          if (
            rel.includes('node_modules') ||
            rel.includes('/dist/') ||
            rel.startsWith('dist/') ||
            rel.includes('/.cache/')
          ) {
            continue;
          }
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            if (
              (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
              !entry.name.endsWith('.d.ts')
            ) {
              result.push(path.resolve(full));
            }
          }
        }
      };
      walk(rootAbs);
    }
    return result.sort();
  }

  private getSourceFile(file: string): any {
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.repoRoot, file);
    let sf = this.program.getSourceFile(abs);
    if (!sf) {
      let content = this.fileContentCache.get(abs);
      if (content === undefined) {
        content = fs.readFileSync(abs, 'utf8');
        this.fileContentCache.set(abs, content);
      }
      sf = ts.createSourceFile(abs, content, ts.ScriptTarget.ES2022, true);
    }
    return sf;
  }

  /**
   * Module-level declarations and class members with 1-based lines.
   */
  declarations(file: string): GroundTruthDeclaration[] {
    const sf = this.getSourceFile(file);
    const results: GroundTruthDeclaration[] = [];

    for (const stmt of sf.statements) {
      const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      const isDeclare = hasModifier(stmt, ts.SyntaxKind.DeclareKeyword);

      // 1. Function declaration
      if (ts.isFunctionDeclaration(stmt)) {
        // Skip overload signatures without body unless declared
        if (!stmt.body && !isDeclare) continue;
        const name = stmt.name?.text ?? (isDefault ? 'default' : '');
        if (!name) continue;
        results.push({
          name,
          qualified: name,
          kind: 'function',
          startLine: getNodeStartLine(stmt, sf),
          endLine: getNodeEndLine(stmt, sf),
          exported,
        });
      }

      // 2. Class declaration
      else if (ts.isClassDeclaration(stmt)) {
        const className = stmt.name?.text ?? (isDefault ? 'default' : '');
        if (!className) continue;
        results.push({
          name: className,
          qualified: className,
          kind: 'class',
          startLine: getNodeStartLine(stmt, sf),
          endLine: getNodeEndLine(stmt, sf),
          exported,
        });

        // Class members (methods, properties, getters/setters; constructor excluded)
        for (const member of stmt.members) {
          if (ts.isConstructorDeclaration(member)) continue;

          let memberName = '';
          if (member.name) {
            if (
              ts.isIdentifier(member.name) ||
              ts.isStringLiteral(member.name) ||
              ts.isNumericLiteral(member.name)
            ) {
              memberName = member.name.text;
            } else if (ts.isPrivateIdentifier && ts.isPrivateIdentifier(member.name)) {
              memberName = member.name.text;
            } else {
              memberName = member.name.getText(sf);
            }
          }
          if (!memberName) continue;

          let kind = 'property';
          if (ts.isMethodDeclaration(member)) {
            // Skip method overloads without body unless abstract
            if (!member.body && !hasModifier(member, ts.SyntaxKind.AbstractKeyword)) continue;
            kind = 'method';
          } else if (ts.isGetAccessorDeclaration(member)) {
            kind = 'getter';
          } else if (ts.isSetAccessorDeclaration(member)) {
            kind = 'setter';
          } else if (ts.isPropertyDeclaration(member)) {
            kind = 'property';
          } else {
            continue;
          }

          const isPrivate =
            hasModifier(member, ts.SyntaxKind.PrivateKeyword) || memberName.startsWith('#');

          results.push({
            name: memberName,
            qualified: `${className}.${memberName}`,
            kind,
            startLine: getNodeStartLine(member, sf),
            endLine: getNodeEndLine(member, sf),
            exported: exported && !isPrivate,
          });
        }
      }

      // 3. Interface declaration
      else if (ts.isInterfaceDeclaration(stmt)) {
        const name = stmt.name.text;
        results.push({
          name,
          qualified: name,
          kind: 'interface',
          startLine: getNodeStartLine(stmt, sf),
          endLine: getNodeEndLine(stmt, sf),
          exported,
        });
      }

      // 4. Type alias declaration
      else if (ts.isTypeAliasDeclaration(stmt)) {
        const name = stmt.name.text;
        results.push({
          name,
          qualified: name,
          kind: 'type',
          startLine: getNodeStartLine(stmt, sf),
          endLine: getNodeEndLine(stmt, sf),
          exported,
        });
      }

      // 5. Enum declaration
      else if (ts.isEnumDeclaration(stmt)) {
        const name = stmt.name.text;
        results.push({
          name,
          qualified: name,
          kind: 'enum',
          startLine: getNodeStartLine(stmt, sf),
          endLine: getNodeEndLine(stmt, sf),
          exported,
        });
      }

      // 6. Variable statement (each declarator)
      else if (ts.isVariableStatement(stmt)) {
        const stmtStart = getNodeStartLine(stmt, sf);
        const stmtEnd = getNodeEndLine(stmt, sf);
        const decls = stmt.declarationList.declarations;

        for (let idx = 0; idx < decls.length; idx++) {
          const d = decls[idx];
          if (ts.isIdentifier(d.name)) {
            const name = d.name.text;
            const startLine = idx === 0 ? stmtStart : getNodeStartLine(d, sf);
            const endLine = decls.length === 1 ? stmtEnd : getNodeEndLine(d, sf);
            results.push({
              name,
              qualified: name,
              kind: 'variable',
              startLine,
              endLine,
              exported,
            });
          } else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
            // Binding patterns: extract each declared identifier element
            const collectBindingElements = (pattern: any) => {
              for (const elem of pattern.elements) {
                if (ts.isBindingElement(elem)) {
                  if (ts.isIdentifier(elem.name)) {
                    const name = elem.name.text;
                    results.push({
                      name,
                      qualified: name,
                      kind: 'variable',
                      startLine: getNodeStartLine(elem, sf),
                      endLine: getNodeEndLine(elem, sf),
                      exported,
                    });
                  } else if (ts.isObjectBindingPattern(elem.name) || ts.isArrayBindingPattern(elem.name)) {
                    collectBindingElements(elem.name);
                  }
                }
              }
            };
            collectBindingElements(d.name);
          }
        }
      }
    }

    return results;
  }

  /**
   * References at the declaration name position, excluding the definition itself.
   */
  references(file: string, name: string, startLine: number): GroundTruthReference[] {
    const absPath = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.repoRoot, file);
    const sf = this.getSourceFile(absPath);

    // Find the declaration name node matching `name` and starting at or near `startLine`
    let targetNameNode: any = null;

    const findNodeInStatements = () => {
      for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
          if (stmt.name && stmt.name.text === name) {
            const line = getNodeStartLine(stmt, sf);
            if (Math.abs(line - startLine) <= 1) {
              return stmt.name;
            }
          }
        }
        if (ts.isClassDeclaration(stmt)) {
          for (const m of stmt.members) {
            if (m.name && m.name.getText(sf) === name) {
              const line = getNodeStartLine(m, sf);
              if (Math.abs(line - startLine) <= 1) {
                return m.name;
              }
            }
          }
        }
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) {
              const line = getNodeStartLine(stmt, sf);
              const declLine = getNodeStartLine(d, sf);
              if (Math.abs(line - startLine) <= 1 || Math.abs(declLine - startLine) <= 1) {
                return d.name;
              }
            }
          }
        }
      }
      return null;
    };

    targetNameNode = findNodeInStatements();

    if (!targetNameNode) {
      // Fallback: search any identifier matching name with line number
      const searchAst = (node: any): any => {
        if (ts.isIdentifier(node) && node.text === name) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (Math.abs(line - startLine) <= 1) return node;
        }
        return ts.forEachChild(node, searchAst);
      };
      targetNameNode = searchAst(sf);
    }

    if (!targetNameNode) {
      return [];
    }

    const namePos = targetNameNode.getStart(sf);
    let refSymbols: any[];
    try {
      refSymbols = this.languageService.findReferences(absPath, namePos);
    } catch {
      return [];
    }

    if (!refSymbols || refSymbols.length === 0) {
      return [];
    }

    const results: GroundTruthReference[] = [];
    const seen = new Set<string>();

    for (const refSymbol of refSymbols) {
      for (const entry of refSymbol.references) {
        if (entry.isDefinition) continue;

        const entryAbs = path.resolve(entry.fileName);
        if (entryAbs === absPath && entry.textSpan.start === namePos) {
          continue;
        }

        const rel = path.relative(this.repoRoot, entryAbs).replace(/\\/g, '/');
        if (rel.startsWith('..') || rel.includes('node_modules')) {
          continue;
        }

        const refSf = this.getSourceFile(entryAbs);
        const line = refSf.getLineAndCharacterOfPosition(entry.textSpan.start).line + 1;
        const key = `${rel}:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ file: rel, line });
        }
      }
    }

    return results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private buildImportersGraph(): Map<string, Set<string>> {
    if (this.importersGraph) return this.importersGraph;
    const graph = new Map<string, Set<string>>();

    for (const sf of this.sourceFiles) {
      const rel = path.relative(this.repoRoot, sf).replace(/\\/g, '/');
      graph.set(rel, new Set());
    }

    const moduleResolutionHost = {
      fileExists: (fileName: string) => fs.existsSync(fileName),
      readFile: (fileName: string) => {
        try {
          return fs.readFileSync(fileName, 'utf8');
        } catch {
          return undefined;
        }
      },
      directoryExists: (dirName: string) => {
        try {
          return fs.statSync(dirName).isDirectory();
        } catch {
          return false;
        }
      },
      realpath: (p: string) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      },
      getCurrentDirectory: () => this.repoRoot,
      getDirectories: (dirName: string) => {
        try {
          return fs.readdirSync(dirName, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
          return [];
        }
      },
    };

    for (const fileAbs of this.sourceFiles) {
      const srcRel = path.relative(this.repoRoot, fileAbs).replace(/\\/g, '/');
      let content = this.fileContentCache.get(fileAbs);
      if (content === undefined) {
        try {
          content = fs.readFileSync(fileAbs, 'utf8');
        } catch {
          content = '';
        }
        this.fileContentCache.set(fileAbs, content);
      }
      const pre = ts.preProcessFile(content, true, true);
      // preProcessFile's light scanner misses `export * as ns from "..."` (ES2020): add the
      // module specifiers of every import/export declaration from the real AST.
      const specifiers = new Set<string>(pre.importedFiles.map((f: any) => f.fileName));
      const astFile = ts.createSourceFile(fileAbs, content, ts.ScriptTarget.ES2022, false);
      for (const stmt of astFile.statements) {
        const spec = (stmt as any).moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) specifiers.add(spec.text);
      }
      for (const imp of [...specifiers].map((fileName) => ({ fileName }))) {
        const resolved = ts.resolveModuleName(
          imp.fileName,
          fileAbs,
          this.compilerOptions,
          moduleResolutionHost
        );
        if (resolved.resolvedModule) {
          const targetAbs = path.resolve(resolved.resolvedModule.resolvedFileName);
          const targetRel = path.relative(this.repoRoot, targetAbs).replace(/\\/g, '/');
          if (graph.has(targetRel)) {
            graph.get(targetRel)!.add(srcRel);
          }
        }
      }
    }

    this.importersGraph = graph;
    return graph;
  }

  /**
   * Reverse import graph transitive BFS (depth <= 5), excluding the file itself.
   */
  importers(file: string): string[] {
    const graph = this.buildImportersGraph();
    const fileRel = path.isAbsolute(file)
      ? path.relative(this.repoRoot, file).replace(/\\/g, '/')
      : file.replace(/\\/g, '/');

    const visited = new Set<string>();
    const queue: Array<{ rel: string; depth: number }> = [{ rel: fileRel, depth: 0 }];

    while (queue.length > 0) {
      const { rel: curr, depth } = queue.shift()!;
      if (depth >= 5) continue;
      const direct = graph.get(curr);
      if (direct) {
        for (const imp of direct) {
          if (imp !== fileRel && !visited.has(imp)) {
            visited.add(imp);
            queue.push({ rel: imp, depth: depth + 1 });
          }
        }
      }
    }

    return Array.from(visited).sort();
  }
}
