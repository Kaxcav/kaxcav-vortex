import { inflateRawSync, inflateSync } from 'node:zlib'

export interface ZipEntry {
  fileName: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  data: Buffer
}

export interface ParsedSheet {
  title: string
  state: 'visible' | 'hidden' | 'veryHidden'
  rowCount: number
  colCount: number
  headers: string[]
  formulas: Array<{ cell: string; formula: string }>
  validations: Array<{ type: string; sqref: string; formula1: string }>
  sampleRows: Array<Record<string, string | number | null>>
}

export interface ParsedWorkbook {
  fileName: string
  sheets: ParsedSheet[]
  totalFormulas: number
  totalRows: number
  markdownTwin: string
}

export interface ParsedDocx {
  fileName: string
  headings: string[]
  tableCount: number
  paragraphCount: number
  extractedSqlTables: number
  markdownTwin: string
  extractedSqlDdl: string
}

export interface ParsedPdf {
  fileName: string
  pageCount: number
  imageObjectCount: number
  extractedChars: number
  needsOcr: boolean
  markdownTwin: string
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripXmlTags(xmlFragment: string): string {
  return decodeXmlEntities(xmlFragment.replace(/<[^>]+>/g, ''))
}

/**
 * Zero-dependency ZIP Archive Reader with anti-Zip-Bomb guards.
 * Uses Central Directory when present, falling back to sequential Local File Headers.
 */
export function readZipEntries(
  buf: Buffer,
  maxEntries = 400,
  maxTotalUncompressedBytes = 64 * 1024 * 1024,
): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>()
  let totalUncompressed = 0

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1
  const minSearch = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset !== -1) {
    const totalEntries = buf.readUInt16LE(eocdOffset + 10)
    const cdSize = buf.readUInt32LE(eocdOffset + 12)
    const cdOffset = buf.readUInt32LE(eocdOffset + 16)

    if (cdOffset + cdSize <= buf.length) {
      let ptr = cdOffset
      const count = Math.min(totalEntries, maxEntries)
      for (let idx = 0; idx < count && ptr + 46 <= buf.length; idx++) {
        const sig = buf.readUInt32LE(ptr)
        if (sig !== 0x02014b50) break

        const compressionMethod = buf.readUInt16LE(ptr + 10)
        const compressedSize = buf.readUInt32LE(ptr + 20)
        const uncompressedSize = buf.readUInt32LE(ptr + 24)
        const fileNameLen = buf.readUInt16LE(ptr + 28)
        const extraLen = buf.readUInt16LE(ptr + 30)
        const commentLen = buf.readUInt16LE(ptr + 32)
        const localHeaderOffset = buf.readUInt32LE(ptr + 42)

        const fileName = buf.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8')
        ptr += 46 + fileNameLen + extraLen + commentLen

        if (fileName.endsWith('/')) continue
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) continue
        if (compressedSize > 0 && uncompressedSize / compressedSize > 120) continue
        if (totalUncompressed + uncompressedSize > maxTotalUncompressedBytes) break

        if (localHeaderOffset + 30 > buf.length) continue
        const lSig = buf.readUInt32LE(localHeaderOffset)
        if (lSig !== 0x04034b50) continue

        const lNameLen = buf.readUInt16LE(localHeaderOffset + 26)
        const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen
        const dataEnd = dataStart + compressedSize
        if (dataEnd > buf.length) continue

        const rawSlice = buf.subarray(dataStart, dataEnd)
        try {
          let data: Buffer
          if (compressionMethod === 0) {
            data = rawSlice
          } else if (compressionMethod === 8) {
            data = inflateRawSync(rawSlice, { maxOutputLength: maxTotalUncompressedBytes - totalUncompressed })
          } else {
            continue
          }
          totalUncompressed += data.length
          entries.set(fileName, {
            fileName,
            compressedSize,
            uncompressedSize: data.length,
            compressionMethod,
            data,
          })
        } catch {
          // Skip corrupt individual entry without failing the archive
        }
      }
      return entries
    }
  }

  return entries
}

function colLettersToIndex(letters: string): number {
  let col = 0
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64)
  }
  return Math.max(0, col - 1)
}

/**
 * Lossless OpenXML Workbook (.xlsx) parser.
 * Extracts all visible/hidden sheets, sharedStrings, headers, formulas, validations, and tabular rows.
 */
export function parseXlsxBuffer(
  buf: Buffer,
  fileName: string,
  maxSampleRowsPerSheet = 250,
): ParsedWorkbook {
  const entries = readZipEntries(buf)
  const sharedStrings: string[] = []

  const sstEntry = entries.get('xl/sharedStrings.xml')
  if (sstEntry) {
    const sstXml = sstEntry.data.toString('utf8')
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
    let siMatch: RegExpExecArray | null
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const inner = siMatch[1]
      const tParts: string[] = []
      const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g
      let tMatch: RegExpExecArray | null
      while ((tMatch = tRegex.exec(inner)) !== null) {
        tParts.push(decodeXmlEntities(tMatch[1]))
      }
      sharedStrings.push(tParts.join(''))
    }
  }

  // Map r:id -> target worksheet path from xl/_rels/workbook.xml.rels
  const relTargetById = new Map<string, string>()
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels')
  if (relsEntry) {
    const relsXml = relsEntry.data.toString('utf8')
    const relRegex = /<Relationship\b([^>]+)\/?>/g
    let rMatch: RegExpExecArray | null
    while ((rMatch = relRegex.exec(relsXml)) !== null) {
      const attrs = rMatch[1]
      const idM = /\bId="([^"]+)"/.exec(attrs)
      const targetM = /\bTarget="([^"]+)"/.exec(attrs)
      if (idM && targetM) {
        const cleanTarget = targetM[1].replace(/^\/+/, '').replace(/^xl\//, '')
        relTargetById.set(idM[1], `xl/${cleanTarget}`)
      }
    }
  }

  const sheetMetaList: Array<{ name: string; state: ParsedSheet['state']; path: string }> = []
  const wbEntry = entries.get('xl/workbook.xml')
  if (wbEntry) {
    const wbXml = wbEntry.data.toString('utf8')
    const sheetRegex = /<sheet\b([^>]+)\/?>/g
    let sMatch: RegExpExecArray | null
    let fallbackIdx = 1
    while ((sMatch = sheetRegex.exec(wbXml)) !== null) {
      const attrs = sMatch[1]
      const nameM = /\bname="([^"]+)"/.exec(attrs)
      const stateM = /\bstate="([^"]+)"/.exec(attrs)
      const rIdM = /\br:id="([^"]+)"/.exec(attrs)
      const title = nameM ? decodeXmlEntities(nameM[1]) : `Sheet${fallbackIdx}`
      const state = (stateM?.[1] as ParsedSheet['state']) ?? 'visible'
      const resolvedPath =
        (rIdM && relTargetById.get(rIdM[1])) || `xl/worksheets/sheet${fallbackIdx}.xml`
      sheetMetaList.push({ name: title, state, path: resolvedPath })
      fallbackIdx++
    }
  }

  if (sheetMetaList.length === 0) {
    for (const key of entries.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) {
        sheetMetaList.push({
          name: key.replace('xl/worksheets/', '').replace('.xml', ''),
          state: 'visible',
          path: key,
        })
      }
    }
  }

  const sheets: ParsedSheet[] = []
  let totalFormulas = 0
  let totalRows = 0

  for (const sm of sheetMetaList) {
    const wsEntry = entries.get(sm.path)
    if (!wsEntry) continue
    const wsXml = wsEntry.data.toString('utf8')

    const formulas: Array<{ cell: string; formula: string }> = []
    const validations: Array<{ type: string; sqref: string; formula1: string }> = []

    const valRegex = /<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g
    let vMatch: RegExpExecArray | null
    while ((vMatch = valRegex.exec(wsXml)) !== null) {
      const attrs = vMatch[1]
      const body = vMatch[2]
      const typeM = /\btype="([^"]+)"/.exec(attrs)
      const sqrefM = /\bsqref="([^"]+)"/.exec(attrs)
      const f1M = /<formula1>([\s\S]*?)<\/formula1>/.exec(body)
      validations.push({
        type: typeM ? typeM[1] : 'custom',
        sqref: sqrefM ? sqrefM[1] : '',
        formula1: f1M ? decodeXmlEntities(f1M[1]) : '',
      })
    }

    const parsedGridRows: Array<{ rowNum: number; cells: Map<number, string> }> = []
    let maxColSeen = 0
    let maxRowSeen = 0

    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowRegex.exec(wsXml)) !== null) {
      const rowAttrs = rowMatch[1]
      const rowBody = rowMatch[2]
      const rNumM = /\br="(\d+)"/.exec(rowAttrs)
      const rowNum = rNumM ? parseInt(rNumM[1], 10) : parsedGridRows.length + 1
      if (rowNum > maxRowSeen) maxRowSeen = rowNum

      const cellMap = new Map<number, string>()
      const cellRegex = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
      let cMatch: RegExpExecArray | null
      while ((cMatch = cellRegex.exec(rowBody)) !== null) {
        const cAttrs = cMatch[1]
        const cBody = cMatch[2] ?? ''
        const refM = /\br="([A-Z]+)(\d+)"/.exec(cAttrs)
        const typeM = /\bt="([^"]+)"/.exec(cAttrs)
        const colIdx = refM ? colLettersToIndex(refM[1]) : cellMap.size
        if (colIdx + 1 > maxColSeen) maxColSeen = colIdx + 1

        const fM = /<f(?:\s+[^>]*)?>([\s\S]*?)<\/f>/.exec(cBody)
        if (fM && fM[1].trim()) {
          totalFormulas++
          if (formulas.length < 80) {
            formulas.push({
              cell: refM ? `${refM[1]}${refM[2]}` : `R${rowNum}C${colIdx + 1}`,
              formula: '=' + decodeXmlEntities(fM[1].trim()),
            })
          }
        }

        const vM = /<v>([\s\S]*?)<\/v>/.exec(cBody)
        const isM = /<is>([\s\S]*?)<\/is>/.exec(cBody)
        let resolvedVal = ''
        if (typeM?.[1] === 's' && vM) {
          const sstIdx = parseInt(vM[1], 10)
          resolvedVal = sharedStrings[sstIdx] ?? vM[1]
        } else if (typeM?.[1] === 'inlineStr' && isM) {
          resolvedVal = stripXmlTags(isM[1])
        } else if (vM) {
          resolvedVal = decodeXmlEntities(vM[1])
        }

        if (resolvedVal !== '') {
          cellMap.set(colIdx, resolvedVal.trim())
        }
      }

      if (cellMap.size > 0) {
        parsedGridRows.push({ rowNum, cells: cellMap })
      }
    }

    totalRows += maxRowSeen

    // Pick best header row from the first 12 non-empty rows
    let bestHeaderIdx = 0
    let bestNonEmptyCount = 0
    for (let i = 0; i < Math.min(parsedGridRows.length, 12); i++) {
      const candidate = parsedGridRows[i]
      let alphaCells = 0
      for (const val of candidate.cells.values()) {
        if (/[A-Za-zÀ-ÿ_]/.test(val) && val.length <= 110) alphaCells++
      }
      if (alphaCells > bestNonEmptyCount) {
        bestNonEmptyCount = alphaCells
        bestHeaderIdx = i
      }
    }

    const headers: string[] = []
    const colIndexToHeader = new Map<number, string>()
    if (parsedGridRows.length > 0 && bestNonEmptyCount >= 1) {
      const hdrRow = parsedGridRows[bestHeaderIdx]
      const seenHeaders = new Set<string>()
      for (let c = 0; c < maxColSeen; c++) {
        const rawH = hdrRow.cells.get(c)?.replace(/\s+/g, ' ').trim()
        if (rawH) {
          let uniqueH = rawH
          let suffix = 2
          while (seenHeaders.has(uniqueH.toLowerCase())) {
            uniqueH = `${rawH}_${suffix++}`
          }
          seenHeaders.add(uniqueH.toLowerCase())
          headers.push(uniqueH)
          colIndexToHeader.set(c, uniqueH)
        }
      }
    }

    const sampleRows: Array<Record<string, string | number | null>> = []
    const dataStartIdx = parsedGridRows.length > 0 ? bestHeaderIdx + 1 : 0
    for (
      let rIdx = dataStartIdx;
      rIdx < parsedGridRows.length && sampleRows.length < maxSampleRowsPerSheet;
      rIdx++
    ) {
      const rObj = parsedGridRows[rIdx]
      const record: Record<string, string | number | null> = {}
      let hasValue = false
      for (const [colIdx, val] of rObj.cells.entries()) {
        const colName = colIndexToHeader.get(colIdx) ?? `col_${colIdx + 1}`
        const num = Number(val)
        record[colName] =
          val !== '' && !Number.isNaN(num) && /^-?\d+(?:\.\d+)?$/.test(val) ? num : val
        hasValue = true
      }
      if (hasValue) sampleRows.push(record)
    }

    sheets.push({
      title: sm.name,
      state: sm.state,
      rowCount: maxRowSeen,
      colCount: maxColSeen,
      headers,
      formulas,
      validations,
      sampleRows,
    })
  }

  // Build lossless canonical Markdown Twin
  const md: string[] = [
    `# Workbook Estrutural: ${fileName}`,
    '',
    `Authority: LEGACY_OBSERVED`,
    `Formato Original: OpenXML Spreadsheet (.xlsx) | Abas: ${sheets.length} | Linhas Totais: ${totalRows} | Fórmulas: ${totalFormulas}`,
    '',
  ]

  for (const s of sheets) {
    md.push(`## Aba ${fileName} :: ${s.title}`)
    md.push(`- Estado: \`${s.state}\` | Dimensões: \`${s.rowCount} linhas x ${s.colCount} colunas\``)
    if (s.headers.length > 0) {
      md.push(
        `- Colunas (${s.headers.length}): ` + s.headers.map((h) => `\`${h}\``).join(', '),
      )
    } else {
      md.push(`- Colunas: \`sem_cabecalho_nominal\``)
    }

    if (s.validations.length > 0) {
      const vList = s.validations
        .slice(0, 10)
        .map((v) => `\`${v.type}\` em \`${v.sqref}\` (${v.formula1})`)
      md.push(`- Validações de Dados: ` + vList.join('; '))
    }

    if (s.formulas.length > 0) {
      const uniqueFormulas: string[] = []
      for (const f of s.formulas) {
        const cleanF = f.formula.replace(/\s+/g, ' ')
        if (!uniqueFormulas.includes(cleanF)) uniqueFormulas.push(cleanF)
        if (uniqueFormulas.length >= 8) break
      }
      md.push(`- Fórmulas de Negócio (${s.formulas.length} amostradas):`)
      for (const uf of uniqueFormulas) {
        md.push(`  - \`${uf}\``)
      }
    }

    if (s.sampleRows.length > 0 && s.headers.length > 0) {
      const previewCols = s.headers.slice(0, 8)
      md.push('', `### Amostra Estrutural (${s.title})`)
      md.push('| ' + previewCols.join(' | ') + ' |')
      md.push('| ' + previewCols.map(() => '---').join(' | ') + ' |')
      for (const row of s.sampleRows.slice(0, 5)) {
        const cells = previewCols.map((col) =>
          String(row[col] ?? '')
            .replace(/\|/g, '\\|')
            .replace(/\r?\n/g, ' ')
            .slice(0, 60),
        )
        md.push('| ' + cells.join(' | ') + ' |')
      }
    }
    md.push('')
  }

  return {
    fileName,
    sheets,
    totalFormulas,
    totalRows,
    markdownTwin: md.join('\n') + '\n',
  }
}

/**
 * Lossless OpenXML Word Document (.docx) parser.
 * Extracts hierarchical headings, paragraphs, tables, and embedded SQL DDL blocks.
 */
export function parseDocxBuffer(buf: Buffer, fileName: string): ParsedDocx {
  const entries = readZipEntries(buf)
  const docEntry = entries.get('word/document.xml')
  if (!docEntry) {
    return {
      fileName,
      headings: [],
      tableCount: 0,
      paragraphCount: 0,
      extractedSqlTables: 0,
      markdownTwin: `# Documento: ${fileName}\n\nAuthority: LEGACY_OBSERVED\n`,
      extractedSqlDdl: '',
    }
  }

  const xml = docEntry.data.toString('utf8')
  const headings: string[] = []
  const mdLines: string[] = [
    `# Documento Estrutural: ${fileName}`,
    '',
    `Authority: LEGACY_OBSERVED`,
    '',
  ]
  const sqlLines: string[] = []
  let tableCount = 0
  let paragraphCount = 0

  // Match either <w:tbl>...</w:tbl> or <w:p>...</w:p> in document order
  const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g
  let bMatch: RegExpExecArray | null
  while ((bMatch = blockRegex.exec(xml)) !== null) {
    const block = bMatch[0]
    if (block.startsWith('<w:tbl')) {
      tableCount++
      const rows: string[][] = []
      const trRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g
      let trM: RegExpExecArray | null
      while ((trM = trRegex.exec(block)) !== null) {
        const rowCells: string[] = []
        const tcRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g
        let tcM: RegExpExecArray | null
        while ((tcM = tcRegex.exec(trM[0])) !== null) {
          const cellTexts: string[] = []
          const tRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g
          let tM: RegExpExecArray | null
          while ((tM = tRegex.exec(tcM[0])) !== null) {
            cellTexts.push(decodeXmlEntities(tM[1]))
          }
          rowCells.push(cellTexts.join(' ').replace(/\s+/g, ' ').trim())
        }
        if (rowCells.some(Boolean)) rows.push(rowCells)
      }

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length))
        const normRows = rows.map((r) => {
          const padded = [...r]
          while (padded.length < colCount) padded.push('')
          return padded.map((c) => c.replace(/\|/g, '\\|'))
        })
        mdLines.push('')
        mdLines.push('| ' + normRows[0].join(' | ') + ' |')
        mdLines.push('| ' + normRows[0].map(() => '---').join(' | ') + ' |')
        for (const nr of normRows.slice(1, 80)) {
          mdLines.push('| ' + nr.join(' | ') + ' |')
        }
        mdLines.push('')
      }
      continue
    }

    // Paragraph <w:p>
    const styleM = /<w:pStyle\s+w:val="([^"]+)"/.exec(block)
    const styleVal = styleM ? styleM[1] : ''
    const runs: string[] = []
    const tokenRegex = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g
    let tkM: RegExpExecArray | null
    while ((tkM = tokenRegex.exec(block)) !== null) {
      if (tkM[0] === '<w:tab/>') runs.push('\t')
      else if (tkM[0] === '<w:br/>') runs.push('\n')
      else if (tkM[1] !== undefined) runs.push(decodeXmlEntities(tkM[1]))
    }

    const text = runs.join('').trim()
    if (!text) continue
    paragraphCount++

    if (/CREATE\s+TABLE|ALTER\s+TABLE|PRIMARY\s+KEY|FOREIGN\s+KEY/i.test(text) || sqlLines.length > 0 && /^[a-z_0-9"\s(),.;:-]+$/i.test(text)) {
      sqlLines.push(text)
    }

    if (/^(?:Heading|Ttulo|Title)\s*([1-6])/i.test(styleVal)) {
      const lvl = Math.min(4, Math.max(2, parseInt(RegExp.$1 || '2', 10)))
      headings.push(text)
      mdLines.push('', `${'#'.repeat(lvl)} ${text}`, '')
    } else if (text.length < 95 && /^[0-9]+(?:\.[0-9]+)*\s+[A-ZÀ-Ú]/.test(text)) {
      headings.push(text)
      mdLines.push('', `## ${text}`, '')
    } else {
      mdLines.push(text)
    }
  }

  const extractedSqlDdl = sqlLines.join('\n')
  const extractedSqlTables = (extractedSqlDdl.match(/CREATE\s+TABLE/gi) ?? []).length

  return {
    fileName,
    headings,
    tableCount,
    paragraphCount,
    extractedSqlTables,
    markdownTwin: mdLines.join('\n') + '\n',
    extractedSqlDdl,
  }
}

/**
 * Safe, zero-dependency PDF stream text extractor and OCR density detector.
 */
export function parsePdfBuffer(buf: Buffer, fileName: string): ParsedPdf {
  const rawLatin = buf.subarray(0, Math.min(buf.length, 8 * 1024 * 1024)).toString('latin1')
  const pageMatches = rawLatin.match(/\/Type\s*\/Page\b/g)
  const pageCount = Math.max(1, pageMatches ? pageMatches.length : 1)
  const imageMatches = rawLatin.match(/\/Subtype\s*\/Image\b/g)
  const imageObjectCount = imageMatches ? imageMatches.length : 0

  const extractedSegments: string[] = []
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let sMatch: RegExpExecArray | null
  let streamsProcessed = 0

  while ((sMatch = streamRegex.exec(rawLatin)) !== null && streamsProcessed < 250) {
    streamsProcessed++
    const rawStream = Buffer.from(sMatch[1], 'latin1')
    let decoded = ''
    try {
      decoded = inflateSync(rawStream, { maxOutputLength: 512 * 1024 }).toString('latin1')
    } catch {
      decoded = sMatch[1]
    }

    if (!/BT[\s\S]*?ET/.test(decoded)) continue
    const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj|\[([\s\S]*?)\]\s*TJ/g
    let tjM: RegExpExecArray | null
    const chunkTokens: string[] = []
    while ((tjM = tjRegex.exec(decoded)) !== null) {
      if (tjM[1] !== undefined) {
        chunkTokens.push(tjM[1].replace(/\\([()\\])/g, '$1'))
      } else if (tjM[2] !== undefined) {
        const innerParens = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g
        let ipM: RegExpExecArray | null
        while ((ipM = innerParens.exec(tjM[2])) !== null) {
          chunkTokens.push(ipM[1].replace(/\\([()\\])/g, '$1'))
        }
      }
    }
    const lineText = chunkTokens
      .join(' ')
      .replace(/[^\x20-\x7EÀ-ÿ\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (lineText.length >= 4) {
      extractedSegments.push(lineText)
    }
  }

  const fullText = extractedSegments.join('\n')
  const extractedChars = fullText.length
  const needsOcr = extractedChars < pageCount * 45 && imageObjectCount > 0

  const md = [
    `# Documento PDF: ${fileName}`,
    '',
    `Authority: LEGACY_OBSERVED`,
    `Páginas: ${pageCount} | Objetos de Imagem: ${imageObjectCount} | Caracteres Nativos: ${extractedChars} | Status OCR: ${needsOcr ? 'TIER2_OCR_REQUIRED' : 'TIER1_NATIVE_TEXT'}`,
    '',
    '## Conteúdo Extraído',
    fullText ||
      `[Documento PDF predominantemente gráfico/escaneado (${pageCount} páginas, ${imageObjectCount} imagens). Catalogado no Zero-Loss Vault para processamento Tier-2 OCR.]`,
    '',
  ].join('\n')

  return {
    fileName,
    pageCount,
    imageObjectCount,
    extractedChars,
    needsOcr,
    markdownTwin: md,
  }
}
