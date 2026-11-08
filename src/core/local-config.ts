import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Machine-local settings that must never live in the repository: personal folders, client
 * workspaces, dashboard presets and fallback API keys. Read from `$KVX_LOCAL_CONFIG` or
 * `~/.kvx/local.json`; a missing or invalid file means "no local defaults".
 *
 * {
 *   "defaultVaults":  [{ "path": "C:\\dados\\drive", "name": "Meu Drive", "tenantSlug": "meu-drive" }],
 *   "driveShortcuts": [{ "label": "Drive exportado", "path": "C:\\dados\\drive" }],
 *   "defaultWorkspaceHint": "meu-drive",
 *   "presets": [{ "label": "Regras de negócio", "task": "regras de validação", "repo": "C:\\repo" }],
 *   "driveWebKeys": ["…"]          // or env KVX_DRIVE_WEB_KEYS="k1,k2"
 * }
 */
export interface LocalVaultSource {
  path: string
  name: string
  tenantSlug: string
}

export interface KvxLocalConfig {
  defaultVaults?: LocalVaultSource[]
  /** Vaults the Drive app bootstraps (falls back to defaultVaults). */
  driveAppVaults?: LocalVaultSource[]
  /** Label shown in the Drive app header when no workspace is active. */
  accountLabel?: string
  driveShortcuts?: Array<{ label: string; path: string }>
  defaultWorkspaceHint?: string
  presets?: Array<{ label: string; task: string; repo?: string }>
  driveWebKeys?: string[]
}

export function localConfigPath(): string {
  return process.env.KVX_LOCAL_CONFIG || join(homedir(), '.kvx', 'local.json')
}

export function loadLocalConfig(): KvxLocalConfig {
  try {
    const parsed = JSON.parse(readFileSync(localConfigPath(), 'utf8').replace(/^\uFEFF/, '')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as KvxLocalConfig) : {}
  } catch {
    return {}
  }
}

/** Fallback Google Drive web keys: env first, then the local config. Never hard-coded. */
export function driveWebKeys(): string[] {
  const fromEnv = (process.env.KVX_DRIVE_WEB_KEYS ?? '')
    .split(/[,;\s]+/)
    .map((k) => k.trim())
    .filter(Boolean)
  if (fromEnv.length > 0) return fromEnv
  return (loadLocalConfig().driveWebKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0)
}
