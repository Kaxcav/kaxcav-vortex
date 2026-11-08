import { createHash } from 'node:crypto'
import { existsSync, openSync, readFileSync, readdirSync, readSync, closeSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { ScannedFile, SupportedLanguage } from './types.ts'
import { checkKvxIgnore } from './kvxignore.ts'

const ALWAYS_EXCLUDED_DIRS = new Set([
  '.git',
  '.kaxcav',
  '.kvx',
  '.fabrica',
  '.tools',
  '.tmp',
  '.vscode',
  '.idea',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  'attachments',
  'audit',
  'evidence',
  'quarentena',
  'ferramentas',
  'legacy',
  'reference',
  'backups',
  'logs',
  'uploads',
  'vendor',
  'vendor_legacy',
  'third_party',
])

const BLOCKED_EXTENSIONS = new Set([
  '.pdf',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.mp4',
  '.mp3',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.wav',
  '.ogg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.svg',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.zst',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.iso',
  '.dmg',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.db3',
  '.wal',
  '.shm',
  '.log',
  '.lock',
  '.bak',
  '.tmp',
  '.swp',
  '.parquet',
  '.feather',
  '.arrow',
  '.onnx',
  '.pt',
  '.pth',
  '.safetensors',
  '.gguf',
  '.wasm',
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.pdb',
  '.map',
  '.min.js',
  '.min.css',
  '.bundle.js',
])

const EXTENSION_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.prisma': 'prisma',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
}

const MAGIC_SIGNATURES: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], name: 'PDF' }, // %PDF-
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP_OFFICE' }, // PK..
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], name: 'SQLITE' }, // SQLite
  { bytes: [0x4d, 0x5a], name: 'PE_EXE' }, // MZ
  { bytes: [0x7f, 0x45, 0x4c, 0x46], name: 'ELF' }, // .ELF
  { bytes: [0x89, 0x50, 0x4e, 0x47], name: 'PNG' }, // .PNG
  { bytes: [0xff, 0xd8, 0xff], name: 'JPEG' }, // JPEG
  { bytes: [0x1f, 0x8b], name: 'GZIP' }, // GZIP
]

export interface FirewallOptions {
  maxFileBytes?: number
  extraExcludes?: string[]
}

export interface FileFingerprint {
  absPath: string
  relPath: string
  mtimeMs: number
  byteSize: number
  lang: SupportedLanguage
}

export class AdmissionFirewall {
  readonly maxFileBytes: number
  private readonly customExcludedPrefixes: string[] = []
  /** Content-probe verdicts keyed by absolute path, reused while mtime and size are unchanged. */
  private readonly probeCache = new Map<string, { mtimeMs: number; size: number; ok: boolean }>()

  constructor(repoPath: string, options: FirewallOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 524_288 // 512 KB hard ceiling
    this.loadWorkspaceExcludes(repoPath, options.extraExcludes ?? [])
  }

  private loadWorkspaceExcludes(repoPath: string, extra: string[]): void {
    const rawPatterns = [...extra]
    for (const cfgName of ['.kvx.yaml']) {
      const cfgPath = join(repoPath, cfgName)
      if (existsSync(cfgPath)) {
        try {
          const text = readFileSync(cfgPath, 'utf8')
          for (const line of text.split(/\r?\n/)) {
            const match = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line)
            if (match?.[1]) rawPatterns.push(match[1].trim())
          }
        } catch {
          // Ignore malformed config
        }
      }
    }

    for (const pat of rawPatterns) {
      const cleaned = pat
        .replace(/^\*\*\/?/, '')
        .replace(/\/\*\*$/, '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .trim()
      if (cleaned && !cleaned.startsWith('*')) {
        this.customExcludedPrefixes.push(cleaned.toLowerCase())
      }
    }
  }

  private isExcludedRelPath(relPosix: string, dirName: string): boolean {
    return this.exclusionReason(relPosix, dirName) !== null
  }

  private exclusionReason(relPosix: string, dirName: string): string | null {
    if (ALWAYS_EXCLUDED_DIRS.has(dirName)) return `pasta '${dirName}' sempre excluída do índice`
    if (dirName.startsWith('.playwright-artifacts-')) return `pasta '${dirName}' excluída do índice`
    if (dirName.startsWith('.daemon-state')) return `pasta '${dirName}' excluída do índice`

    const lowerRel = relPosix.toLowerCase()
    for (const prefix of this.customExcludedPrefixes) {
      if (
        lowerRel === prefix ||
        lowerRel.startsWith(prefix + '/') ||
        lowerRel.endsWith('/' + prefix) ||
        lowerRel.includes('/' + prefix + '/')
      ) {
        return `excluído pela regra '${prefix}' do .kvx.yaml`
      }
    }
    return null
  }

  /**
   * Explains why a repository-relative file is not (or would not be) indexed.
   * Returns null when the file is admissible.
   */
  explainExclusion(repoPath: string, relPosix: string): string | null {
    const root = resolve(repoPath)
    const absPath = join(root, ...relPosix.split('/'))
    if (!existsSync(absPath)) return 'arquivo não existe no disco'
    const parts = relPosix.split('/')
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).join('/')
      const reason = this.exclusionReason(sub, parts[i])
      if (reason) return reason
      if (i < parts.length - 1 && AdmissionFirewall.isNestedWorktree(join(root, ...parts.slice(0, i + 1)), sub)) {
        return `dentro de '${sub}', um worktree/submódulo aninhado (cópia do código, fora do índice)`
      }
    }
    const ignore = checkKvxIgnore(absPath)
    if (ignore.ignored) return `bloqueado por .kvxignore (regra '${ignore.pattern}' em ${ignore.source}:${ignore.line})`
    const lang = this.detectLanguage(parts[parts.length - 1])
    if (!lang) return `extensão não indexada ('${extname(relPosix) || parts[parts.length - 1]}')`
    let size = 0
    try {
      size = statSync(absPath).size
    } catch {
      return 'arquivo ilegível'
    }
    if (size <= 0) return 'arquivo vazio'
    if (size > this.maxFileBytes) return `arquivo maior que o limite de indexação (${size} > ${this.maxFileBytes} bytes)`
    if (!this.passesMagicAndMinifiedCheck(absPath, size)) return 'conteúdo binário, minificado ou de linha única muito longa'
    return null
  }

  static detectLanguage(fileName: string): SupportedLanguage | null {
    const lower = fileName.toLowerCase()
    if (
      lower.endsWith('.min.js') ||
      lower.endsWith('.min.css') ||
      lower.endsWith('.bundle.js') ||
      lower.endsWith('.d.ts.map') ||
      lower === 'package-lock.json' ||
      lower === 'pnpm-lock.yaml' ||
      lower === 'yarn.lock'
    ) {
      return null
    }
    const ext = extname(lower)
    if (BLOCKED_EXTENSIONS.has(ext)) return null
    return EXTENSION_LANGUAGE_MAP[ext] ?? null
  }

  detectLanguage(fileName: string): SupportedLanguage | null {
    return AdmissionFirewall.detectLanguage(fileName)
  }

  private passesMagicAndMinifiedCheck(absPath: string, byteSize: number): boolean {
    if (byteSize <= 0 || byteSize > this.maxFileBytes) return false
    const probeLen = Math.min(byteSize, 4096)
    const buf = Buffer.allocUnsafe(probeLen)
    let fd: number | null = null
    try {
      fd = openSync(absPath, 'r')
      const bytesRead = readSync(fd, buf, 0, probeLen, 0)
      if (bytesRead <= 0) return false

      for (const sig of MAGIC_SIGNATURES) {
        if (bytesRead >= sig.bytes.length) {
          let match = true
          for (let i = 0; i < sig.bytes.length; i++) {
            if (buf[i] !== sig.bytes[i]) {
              match = false
              break
            }
          }
          if (match) return false
        }
      }

      let newlines = 0
      let maxLineRun = 0
      let currentRun = 0
      for (let i = 0; i < bytesRead; i++) {
        const b = buf[i]
        if (b === 0x00) return false // Binary NUL byte
        if (b === 0x0a) {
          newlines++
          if (currentRun > maxLineRun) maxLineRun = currentRun
          currentRun = 0
        } else {
          currentRun++
        }
      }
      if (currentRun > maxLineRun) maxLineRun = currentRun

      // Reject minified/bundled single-line blobs
      if (maxLineRun > 1_400) return false
      if (bytesRead > 1_024 && newlines === 0) return false

      return true
    } catch {
      return false
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }

  /**
   * Nested git worktrees / submodules (a directory holding a `.git` FILE) and agent
   * worktrees under `.claude/worktrees` are copies of the code: indexing them duplicates
   * every symbol and multiplies indexing time.
   */
  static isNestedWorktree(absDir: string, relPosix: string): boolean {
    const lower = relPosix.toLowerCase()
    if (lower === '.claude/worktrees' || lower.endsWith('/.claude/worktrees')) return true
    try {
      return statSync(join(absDir, '.git')).isFile()
    } catch {
      return false
    }
  }

  discoverFingerprints(repoPath: string): FileFingerprint[] {
    const root = resolve(repoPath)
    const results: FileFingerprint[] = []
    const stack: string[] = [root]

    while (stack.length > 0) {
      const currentDir = stack.pop()!
      let entries
      try {
        entries = readdirSync(currentDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const absPath = join(currentDir, entry.name)
        const relPosix = relative(root, absPath).split(sep).join('/')

        if (entry.isDirectory()) {
          if (
            !this.isExcludedRelPath(relPosix, entry.name) &&
            !AdmissionFirewall.isNestedWorktree(absPath, relPosix) &&
            !checkKvxIgnore(absPath, true).ignored
          ) {
            stack.push(absPath)
          }
          continue
        }

        if (!entry.isFile()) continue
        if (this.isExcludedRelPath(relPosix, entry.name)) continue

        const lang = this.detectLanguage(entry.name)
        if (!lang) continue
        if (checkKvxIgnore(absPath, false).ignored) continue

        let st
        try {
          st = statSync(absPath)
        } catch {
          continue
        }

        const mtimeMs = Math.trunc(st.mtimeMs)
        const cachedProbe = this.probeCache.get(absPath)
        let admissible: boolean
        if (cachedProbe && cachedProbe.mtimeMs === mtimeMs && cachedProbe.size === st.size) {
          admissible = cachedProbe.ok
        } else {
          admissible = this.passesMagicAndMinifiedCheck(absPath, st.size)
          this.probeCache.set(absPath, { mtimeMs, size: st.size, ok: admissible })
        }
        if (!admissible) continue

        results.push({
          absPath,
          relPath: relPosix,
          mtimeMs,
          byteSize: st.size,
          lang,
        })
      }
    }

    results.sort((a, b) => a.relPath.localeCompare(b.relPath))
    return results
  }

  readAndHash(fp: FileFingerprint): ScannedFile | null {
    try {
      const content = readFileSync(fp.absPath, 'utf8')
      const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 32)
      const tokenEstimate = Math.max(1, Math.ceil(content.length / 4))
      return {
        absPath: fp.absPath,
        relPath: fp.relPath,
        contentHash,
        mtimeMs: fp.mtimeMs,
        byteSize: fp.byteSize,
        lang: fp.lang,
        content,
        tokenEstimate,
      }
    } catch {
      return null
    }
  }
}
