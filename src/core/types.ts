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
  | 'other'

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'const'
  | 'route'
  | 'model'
  | 'table'
  | 'section'

export type EdgeKind =
  | 'imports'
  | 'calls'
  | 'implements'
  | 'extends'
  | 'routes_to'
  | 'references_doc'
  | 'mentions_symbol'

export type ContextFidelity = 'full' | 'graded' | 'compact'

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

export interface ExtractedSymbol {
  name: string
  qualifiedName: string
  kind: SymbolKind
  exported: boolean
  startLine: number
  endLine: number
  signature: string
  bodyHash: string
  tokenEstimate: number
  docSummary: string
  sliceText: string
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

export interface ExtractionResult {
  isHub: boolean
  summary: string
  headings: string
  symbols: ExtractedSymbol[]
  edges: ExtractedEdge[]
  routes: ExtractedRoute[]
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
  telemetry: {
    totalQueries: number
    totalTokensReturned: number
    totalTokensSaved: number
    savingsPercent: number
    avgLatencyMs: number
  }
}
