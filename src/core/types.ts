export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'prisma'
  | 'sql'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'powershell'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'bash'
  | 'other'

/** Languages treated as source code (slop scan, `corpus: code`). */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'powershell',
  'java',
  'csharp',
  'cpp',
  'rust',
  'ruby',
  'php',
  'bash',
])

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'const'
  | 'route'
  | 'model'
  | 'table'
  | 'section'
  | 'namespace'

export type EdgeKind =
  | 'imports'
  | 'calls'
  | 'implements'
  | 'extends'
  | 'routes_to'
  | 'references_doc'
  | 'mentions_symbol'

export type ContextFidelity = 'full' | 'graded' | 'compact'

export type SearchCorpus = 'all' | 'docs' | 'code' | 'sql' | 'content'

export interface SearchOptions {
  limit?: number
  path?: string
  corpus?: SearchCorpus | string
}

export interface RepoConfig {
  path: string
  exclude?: string[]
  maxFileBytes?: number
}

export interface ScannedFile {
  absPath: string
  relPath: string
  contentHash: string
  mtimeMs: number
  byteSize: number
  lang: SupportedLanguage
  content: string
  tokenEstimate: number
}

/** `module` = top level, `member` = class member, `local` = declared inside a function body. */
export type SymbolScope = 'module' | 'member' | 'local'

export interface ExtractedSymbol {
  name: string
  qualifiedName: string
  kind: SymbolKind
  exported: boolean
  scope?: SymbolScope
  parent?: string
  startLine: number
  endLine: number
  signature: string
  bodyHash: string
  tokenEstimate: number
  docSummary: string
  sliceText: string
  complexity?: number
}

export interface ExtractedEdge {
  srcSymbolName: string
  dstName: string
  dstPathHint?: string
  kind: EdgeKind
  weight: number
}

export interface ExtractedRoute {
  symbolName: string
  direction: 'expose' | 'consume'
  method: string
  pathPattern: string
  framework: string
}

export interface SlopFinding {
  relPath: string
  line: number
  kind:
    | 'empty_catch'
    | 'swallowed_error'
    | 'todo_placeholder'
    | 'explicit_any'
    | 'ts_ignore'
    | 'stub_return'
    | 'hardcoded_secret'
  severity: 'blocker' | 'warning'
  snippet: string
  message: string
}

export interface ArchitectureBoundaryRule {
  id: string
  name: string
  fromGlob: string
  forbidToGlob: string
  reason: string
}

export interface ArchitectureViolation {
  ruleId: string
  ruleName: string
  sourceFile: string
  sourceSymbol: string
  targetFile: string
  targetSymbol: string
  edgeKind: string
  reason: string
}

export interface CycleFinding {
  symbols: Array<{ qualifiedName: string; relPath: string }>
  severity: 'warning' | 'blocker'
}

export interface ExtractionResult {
  isHub: boolean
  summary: string
  headings: string
  symbols: ExtractedSymbol[]
  edges: ExtractedEdge[]
  routes: ExtractedRoute[]
  slopFindings?: SlopFinding[]
  /** Identifier usages: [name, line, col, kind] (1-based), declaration sites excluded. */
  refs?: Array<[string, number, number, string]>
}

export interface StoredFileRow {
  fileId: number
  relPath: string
  contentHash: string
  mtimeMs: number
  byteSize: number
  lang: SupportedLanguage
  tokenEstimate: number
  isHub: number
  summary: string
}

export interface StoredSymbolRow {
  symId: number
  fileId: number
  relPath: string
  name: string
  qualifiedName: string
  kind: SymbolKind
  exported: number
  startLine: number
  endLine: number
  signature: string
  bodyHash: string
  tokenEstimate: number
  docSummary: string
  sliceText: string
  isHub: number
}

export interface ContextRequest {
  repositoryPath: string
  task: string
  tokenBudget?: number
  fidelity?: ContextFidelity
  format?: 'markdown' | 'json'
  ifNoneMatch?: string
  deltaFrom?: string
  view?: 'worktree' | 'git_ref'
  revision?: string
  includeFederation?: boolean
  path?: string
  corpus?: SearchCorpus | string
}

export interface PackedSlice {
  relPath: string
  symbolName: string
  qualifiedName: string
  kind: SymbolKind
  fidelityLevel: 'L3_FOCAL' | 'L2_CONTRACT' | 'L1_SKELETON' | 'L0_DELTA'
  startLine: number
  endLine: number
  score: number
  tokens: number
  etag: string
  content: string
}

export interface ContextPackResult {
  etag: string
  freshness: 'fresh' | 'stale' | 'unavailable'
  exact: boolean
  unchanged: boolean
  repositoryPath: string
  task: string
  fidelity: ContextFidelity
  tokenBudget: number
  tokenCount: number
  tokensSaved: number
  elapsedMs: number
  files: Array<{
    path: string
    etag: string
    score: number
    fidelityLevel: string
    tokens: number
  }>
  slices: PackedSlice[]
  federationLinks: FederationLink[]
  reusableSymbols?: SearchHit[]
  markdown: string
}

export interface SearchHit {
  relPath: string
  symbolName: string
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  score: number
  signature: string
  docSummary: string
}

export interface FederationLink {
  sourceRepo: string
  sourceFile: string
  sourceSymbol: string
  targetRepo: string
  targetFile: string
  targetSymbol: string
  linkKind: 'rest_route' | 'shared_symbol' | 'doc_reference' | 'prisma_model'
  detail: string
  confidence: number
}

export interface BlastRadiusReport {
  repositoryPath: string
  target: string
  directCallers: Array<{ repo: string; relPath: string; symbolName: string; kind: string; line: number }>
  transitiveFiles: string[]
  affectedTests: string[]
  /** Files that changed together with the target in recent git history (absent outside git). */
  coChanged?: Array<{ relPath: string; commits: number; ratio: number }>
  crossRepoImpacts: FederationLink[]
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  elapsedMs: number
}

export interface ShardHealth {
  repositoryPath: string
  shardPath: string
  fileCount: number
  symbolCount: number
  edgeCount: number
  routeCount: number
  dbSizeBytes: number
  walSizeBytes: number
  lastIndexedAt: string
  schemaVersion?: number
  extractorVersion?: string
  indexAge?: {
    lastSyncAt: string | null
    newestFileIndexedAt: string | null
    oldestFiles: Array<{ relPath: string; indexedAt: string | null; ageSeconds: number | null }>
  }
}

export interface EngineStatus {
  engine: 'kaxcav-vortex'
  version: string
  startup_phase: 'serving'
  status: 'ready'
  pid: number
  heap_alloc_bytes: number
  rss_bytes: number
  shards: ShardHealth[]
  federationEdges: number
  /** Optional tree-sitter layer: which languages it covers, or why it is off. */
  parsers?: { treeSitter: { ready: boolean; languages: string[]; reason?: string; version?: string } }
  telemetry: {
    totalQueries: number
    totalTokensReturned: number
    totalTokensSaved: number
    savingsPercent: number
    avgLatencyMs: number
  }
}
