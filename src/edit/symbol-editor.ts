import type { ExtractionResult } from '../core/types.ts'

export type SymbolEditOp = 'replace' | 'insert_before' | 'insert_after' | 'delete'

export const SYMBOL_EDIT_OPS: readonly SymbolEditOp[] = ['replace', 'insert_before', 'insert_after', 'delete']

export interface SymbolLock {
  qualifiedName: string
  relPath: string
  mode: 'allow_body_only' | 'frozen'
  source: 'kvx' | 'fabrica-v4'
}

export interface LineEditResult {
  content: string
  /** 1-based line range the new text occupies (empty for delete: start = end + 1). */
  newStart: number
  newEnd: number
  linesRemoved: number
  linesAdded: number
}

/**
 * Applies a whole-line edit to `content` keeping its BOM, its line ending (CRLF or LF) and
 * whether it ends with a newline. `start`/`end` are the 1-based symbol range.
 */
export function applyLineEdit(content: string, start: number, end: number, op: SymbolEditOp, text = ''): LineEditResult {
  const bom = content.startsWith('﻿') ? '﻿' : ''
  const body = bom ? content.slice(1) : content
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const textLines = op === 'delete' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const before = lines.slice(0, start - 1)
  const after = lines.slice(end)
  const target = lines.slice(start - 1, end)
  let next: string[]
  let newStart: number
  switch (op) {
    case 'replace':
      next = [...before, ...textLines, ...after]
      newStart = start
      break
    case 'insert_before':
      next = [...before, ...textLines, ...target, ...after]
      newStart = start
      break
    case 'insert_after':
      next = [...before, ...target, ...textLines, ...after]
      newStart = end + 1
      break
    case 'delete':
      next = [...before, ...after]
      newStart = start
      break
  }
  return {
    content: bom + next.join(eol),
    newStart,
    newEnd: newStart + textLines.length - 1,
    linesRemoved: op === 'replace' || op === 'delete' ? target.length : 0,
    linesAdded: textLines.length,
  }
}

/** The symbol's current text on disk, with LF endings, for comparison with the indexed slice. */
export function sliceLines(content: string, start: number, end: number): string {
  const body = content.startsWith('﻿') ? content.slice(1) : content
  return body.split(/\r?\n/).slice(start - 1, end).join('\n')
}

/**
 * Locked symbols of this file that the edit would break, comparing the extraction of the file
 * before and after the edit (same extractor, so no dependency on when the lock was taken):
 * `frozen` -> any change to its text; `allow_body_only` -> a change to its signature; both -> removal.
 */
export function lockViolations(
  relPath: string,
  before: ExtractionResult,
  after: ExtractionResult,
  locks: SymbolLock[],
): Array<{ qualifiedName: string; mode: string; violation: string; source: string }> {
  const out: Array<{ qualifiedName: string; mode: string; violation: string; source: string }> = []
  const find = (res: ExtractionResult, lockName: string) => {
    const bare = lockName.includes('#') ? lockName.slice(lockName.lastIndexOf('#') + 1) : lockName
    const pathPart = lockName.includes('#') ? lockName.slice(0, lockName.lastIndexOf('#')) : ''
    if (pathPart && pathPart.toLowerCase() !== relPath.toLowerCase()) return null
    return (
      res.symbols.find((s) => s.qualifiedName === `${relPath}#${bare}`) ??
      res.symbols.find((s) => s.scope !== 'local' && s.name === bare) ??
      null
    )
  }
  for (const lock of locks) {
    if (lock.relPath && lock.relPath.toLowerCase() !== relPath.toLowerCase() && !lock.qualifiedName.includes('#')) continue
    const old = find(before, lock.qualifiedName)
    if (!old) continue // the lock is about a symbol of another file
    const now = find(after, lock.qualifiedName)
    if (!now) {
      out.push({ qualifiedName: lock.qualifiedName, mode: lock.mode, violation: 'o símbolo travado seria removido', source: lock.source })
    } else if (lock.mode === 'frozen' && now.sliceText !== old.sliceText) {
      out.push({ qualifiedName: lock.qualifiedName, mode: lock.mode, violation: 'símbolo congelado (frozen) seria alterado', source: lock.source })
    } else if (lock.mode === 'allow_body_only' && now.signature !== old.signature) {
      out.push({
        qualifiedName: lock.qualifiedName,
        mode: lock.mode,
        violation: `assinatura travada (allow_body_only) mudaria: "${old.signature}" -> "${now.signature}"`,
        source: lock.source,
      })
    }
  }
  return out
}
