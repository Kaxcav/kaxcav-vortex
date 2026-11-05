const LexState = {
  Code: 0,
  LineComment: 1,
  BlockComment: 2,
  SingleQuote: 3,
  DoubleQuote: 4,
  TemplateQuote: 5,
} as const

type LexState = (typeof LexState)[keyof typeof LexState]

export class CodeStateMachine {
  /**
   * Finds the exact 1-based end line of a brace-delimited block starting at `startLineIdx` (0-based),
   * completely ignoring braces inside comments, strings, and template literals.
   */
  static findBalancedBlockEnd(lines: string[], startLineIdx: number, maxSpan = 260): number {
    let state: LexState = LexState.Code
    let braceDepth = 0
    let parenDepth = 0
    let seenOpenBrace = false
    const limit = Math.min(lines.length - 1, startLineIdx + maxSpan)

    for (let lineIdx = startLineIdx; lineIdx <= limit; lineIdx++) {
      const line = lines[lineIdx]
      const len = line.length

      if (state === LexState.LineComment) {
        state = LexState.Code
      }

      for (let i = 0; i < len; i++) {
        const ch = line[i]
        const next = i + 1 < len ? line[i + 1] : ''

        switch (state) {
          case LexState.Code: {
            if (ch === '/' && next === '/') {
              state = LexState.LineComment
              i++
              break
            }
            if (ch === '/' && next === '*') {
              state = LexState.BlockComment
              i++
              break
            }
            if (ch === "'") {
              state = LexState.SingleQuote
              break
            }
            if (ch === '"') {
              state = LexState.DoubleQuote
              break
            }
            if (ch === '`') {
              state = LexState.TemplateQuote
              break
            }
            if (ch === '(') {
              parenDepth++
            } else if (ch === ')') {
              if (parenDepth > 0) parenDepth--
            } else if (ch === '{') {
              braceDepth++
              seenOpenBrace = true
            } else if (ch === '}') {
              braceDepth--
              if (seenOpenBrace && braceDepth <= 0 && parenDepth === 0) {
                // Check if this '{}' was a TypeScript inline return-type annotation (e.g., '): { ok: boolean } {')
                const restOfLine = line.slice(i + 1).trim()
                if (
                  restOfLine.startsWith('{') ||
                  restOfLine.startsWith('>') ||
                  restOfLine.startsWith('|') ||
                  restOfLine.startsWith('&') ||
                  restOfLine.startsWith('[') ||
                  restOfLine.startsWith('=>')
                ) {
                  braceDepth = 0
                  seenOpenBrace = false
                  continue
                }
                return lineIdx + 1
              }
            } else if (ch === ';' && !seenOpenBrace && parenDepth === 0 && lineIdx > startLineIdx) {
              return lineIdx + 1
            }
            break
          }

          case LexState.BlockComment: {
            if (ch === '*' && next === '/') {
              state = LexState.Code
              i++
            }
            break
          }

          case LexState.SingleQuote: {
            if (ch === '\\') {
              i++
            } else if (ch === "'") {
              state = LexState.Code
            }
            break
          }

          case LexState.DoubleQuote: {
            if (ch === '\\') {
              i++
            } else if (ch === '"') {
              state = LexState.Code
            }
            break
          }

          case LexState.TemplateQuote: {
            if (ch === '\\') {
              i++
            } else if (ch === '`') {
              state = LexState.Code
            }
            break
          }
        }
      }
    }

    return Math.min(lines.length, startLineIdx + 30)
  }

  /**
   * Extracts a normalized single-line signature for declarations whose parameters
   * or return types span multiple lines before the opening '{' or ';'.
   */
  static extractCleanSignature(lines: string[], startLineIdx: number, maxHeaderLines = 8): string {
    const parts: string[] = []
    const limit = Math.min(lines.length - 1, startLineIdx + maxHeaderLines - 1)
    let state: LexState = LexState.Code
    let parenDepth = 0

    for (let lineIdx = startLineIdx; lineIdx <= limit; lineIdx++) {
      const line = lines[lineIdx]
      let lineBuf = ''
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        const next = i + 1 < line.length ? line[i + 1] : ''

        if (state === LexState.Code) {
          if (ch === '/' && next === '/') break
          if (ch === '/' && next === '*') {
            state = LexState.BlockComment
            i++
            continue
          }
          if (ch === '(') parenDepth++
          else if (ch === ')' && parenDepth > 0) parenDepth--
          else if (ch === ';' && parenDepth === 0) {
            parts.push(lineBuf.trim())
            return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
          } else if (ch === '{' && parenDepth === 0) {
            // Only stop at '{' if it is the block-opening brace at end of line, not an inline return type '{ ok: boolean } {'
            const rest = line.slice(i + 1).trim()
            if (rest === '' || rest.startsWith('//') || rest.startsWith('/*')) {
              parts.push(lineBuf.trim())
              return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
            }
          }
          lineBuf += ch
        } else if (state === LexState.BlockComment && ch === '*' && next === '/') {
          state = LexState.Code
          i++
        }
      }
      if (lineBuf.trim()) parts.push(lineBuf.trim())
    }

    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  /**
   * Strips all comments and string literals from a code block so call-site extraction
   * never matches words inside strings or comments.
   */
  static stripStringsAndComments(code: string): string {
    let state: LexState = LexState.Code
    let out = ''
    const len = code.length

    for (let i = 0; i < len; i++) {
      const ch = code[i]
      const next = i + 1 < len ? code[i + 1] : ''

      switch (state) {
        case LexState.Code:
          if (ch === '/' && next === '/') {
            state = LexState.LineComment
            i++
          } else if (ch === '/' && next === '*') {
            state = LexState.BlockComment
            i++
          } else if (ch === "'") {
            state = LexState.SingleQuote
            out += ' '
          } else if (ch === '"') {
            state = LexState.DoubleQuote
            out += ' '
          } else if (ch === '`') {
            state = LexState.TemplateQuote
            out += ' '
          } else {
            out += ch
          }
          break

        case LexState.LineComment:
          if (ch === '\n') {
            state = LexState.Code
            out += '\n'
          }
          break

        case LexState.BlockComment:
          if (ch === '*' && next === '/') {
            state = LexState.Code
            i++
            out += ' '
          } else if (ch === '\n') {
            out += '\n'
          }
          break

        case LexState.SingleQuote:
          if (ch === '\\') i++
          else if (ch === "'") state = LexState.Code
          break

        case LexState.DoubleQuote:
          if (ch === '\\') i++
          else if (ch === '"') state = LexState.Code
          break

        case LexState.TemplateQuote:
          if (ch === '\\') i++
          else if (ch === '`') state = LexState.Code
          break
      }
    }

    return out
  }
}
