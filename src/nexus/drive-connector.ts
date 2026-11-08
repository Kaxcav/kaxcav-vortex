import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveWebKeys } from '../core/local-config.ts'

export interface DriveRemoteItem {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  md5Checksum?: string
  modifiedTime?: string
  webViewLink: string
  parentFolderId: string
  localPath?: string
}

export interface DriveCrawlSummary {
  rootFolderId: string
  folderTitle: string
  mode: 'oauth_v3' | 'shared_folder_link'
  discoveredFiles: number
  downloadedFiles: number
  skippedFolders: number
  stagingDir: string
  nextPageToken?: string
  items: DriveRemoteItem[]
  elapsedMs: number
}

const IGNORED_DRIVE_FOLDERS = new Set([
  '.next',
  'node_modules',
  '.git',
  '__pycache__',
  '.turbo',
  'dist',
  'build',
  'coverage',
])

// Fallback Drive web keys: KVX_DRIVE_WEB_KEYS or ~/.kvx/local.json (never hard-coded).

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export class GoogleDriveConnector {
  static extractFolderId(input: string): string {
    const trimmed = input.trim()
    const folderMatch = /\/folders\/([A-Za-z0-9_-]{15,})/.exec(trimmed)
    if (folderMatch) return folderMatch[1]!
    const idParamMatch = /[?&]id=([A-Za-z0-9_-]{15,})/.exec(trimmed)
    if (idParamMatch) return idParamMatch[1]!
    return trimmed.replace(/[?#].*$/, '')
  }

  static async syncFolderToStaging(options: {
    folderIdOrUrl: string
    stagingDir: string
    accessToken?: string
    apiKey?: string
    maxFiles?: number
  }): Promise<DriveCrawlSummary> {
    const t0 = performance.now()
    const rootFolderId = GoogleDriveConnector.extractFolderId(options.folderIdOrUrl)
    const maxFiles = Math.max(1, Math.min(600, options.maxFiles ?? 220))
    mkdirSync(options.stagingDir, { recursive: true })

    if (options.accessToken || options.apiKey) {
      return GoogleDriveConnector.syncViaRestApiV3({
        rootFolderId,
        stagingDir: options.stagingDir,
        accessToken: options.accessToken,
        apiKey: options.apiKey,
        maxFiles,
        t0,
      })
    }

    return GoogleDriveConnector.syncViaSharedFolderWeb({
      rootFolderId,
      stagingDir: options.stagingDir,
      maxFiles,
      t0,
    })
  }

  private static async discoverWebKeyAndTitle(folderId: string): Promise<{
    webKey: string
    folderTitle: string
  }> {
    let folderTitle = `Google Drive (${folderId.slice(0, 8)})`
    const candidateKeys: string[] = []

    try {
      const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      })
      if (res.ok) {
        const html = await res.text()
        const titleMatch = /<title>(.*?)<\/title>/i.exec(html)
        if (titleMatch?.[1]) {
          const cleanTitle = titleMatch[1]
            .replace(/\s*-\s*Google\s+Drive\s*$/i, '')
            .trim()
          if (cleanTitle) folderTitle = cleanTitle
        }
        for (const m of html.matchAll(/"(AIza[0-9A-Za-z_-]{33,40})"/g)) {
          if (m[1] && !candidateKeys.includes(m[1])) {
            candidateKeys.push(m[1])
          }
        }
      }
    } catch {}

    const fallbackKeys = driveWebKeys()
    for (const fb of fallbackKeys) {
      if (!candidateKeys.includes(fb)) candidateKeys.push(fb)
    }

    for (const key of candidateKeys) {
      try {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
        const testUrl = `https://clients6.google.com/drive/v2beta/files?openDrive=true&reason=102&syncType=0&errorRecovery=false&q=${q}&fields=items(id)&maxResults=1&key=${key}`
        const r = await fetch(testUrl, {
          headers: {
            Referer: `https://drive.google.com/drive/folders/${folderId}`,
            Origin: 'https://drive.google.com',
            'User-Agent': USER_AGENT,
          },
        })
        if (r.ok) {
          return { webKey: key, folderTitle }
        }
      } catch {}
    }

    return { webKey: candidateKeys[0] ?? fallbackKeys[0] ?? '', folderTitle }
  }

  private static async listFolderItemsViaClients6(
    folderId: string,
    webKey: string,
  ): Promise<{
    folders: Array<{ id: string; name: string }>
    files: Array<{ id: string; name: string; mimeType: string; sizeBytes: number }>
  }> {
    const folders: Array<{ id: string; name: string }> = []
    const files: Array<{ id: string; name: string; mimeType: string; sizeBytes: number }> = []

    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
    const url = `https://clients6.google.com/drive/v2beta/files?openDrive=true&reason=102&syncType=0&errorRecovery=false&q=${q}&fields=nextPageToken,items(id,title,mimeType,fileSize,shortcutDetails)&maxResults=500&key=${webKey}`

    try {
      const res = await fetch(url, {
        headers: {
          Referer: `https://drive.google.com/drive/folders/${folderId}`,
          Origin: 'https://drive.google.com',
          'X-Goog-Drive-Client-Version': 'drive.fe.current',
          'User-Agent': USER_AGENT,
        },
      })
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            id: string
            title: string
            mimeType: string
            fileSize?: string
            shortcutDetails?: { targetId?: string; targetMimeType?: string }
          }>
        }
        for (const it of data.items ?? []) {
          const id = it.shortcutDetails?.targetId ?? it.id
          const mime = it.shortcutDetails?.targetMimeType ?? it.mimeType
          const name = String(it.title ?? `item_${id}`).trim()
          const sizeBytes = Number(it.fileSize ?? 0)
          if (mime === 'application/vnd.google-apps.folder') {
            folders.push({ id, name })
          } else {
            files.push({ id, name, mimeType: mime, sizeBytes })
          }
        }
        return { folders, files }
      }
    } catch {}

    // Fallback to HTML AF_initDataCallback('ds:3') if clients6 fails
    try {
      const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (res.ok) {
        const html = await res.text()
        const m = /AF_initDataCallback\(\{key:\s*'ds:3'[\s\S]*?data:([\s\S]*?)\}\);/.exec(html)
        if (m?.[1]) {
          let rawJson = m[1].trim()
          const sideIdx = rawJson.lastIndexOf(', sideChannel:')
          if (sideIdx !== -1) rawJson = rawJson.slice(0, sideIdx).trim()
          const parsed = JSON.parse(rawJson) as any
          const rawItems = (parsed?.[27]?.[7]?.[0]?.[0] ?? []) as any[]
          for (const it of rawItems) {
            const fid = String(it?.[0]?.[1] ?? '')
            const mime = String(it?.[4] ?? '')
            const name = String(it?.[24]?.[2]?.[0]?.[2]?.[1]?.[0]?.[0]?.[0] ?? `item_${fid}`)
            const sizeBytes = typeof it?.[5] === 'number' ? it[5] : 0
            if (!fid || !mime) continue
            if (mime === 'application/vnd.google-apps.folder') {
              folders.push({ id: fid, name })
            } else {
              files.push({ id: fid, name, mimeType: mime, sizeBytes })
            }
          }
        }
      }
    } catch {}

    return { folders, files }
  }

  private static async syncViaSharedFolderWeb(params: {
    rootFolderId: string
    stagingDir: string
    maxFiles: number
    t0: number
  }): Promise<DriveCrawlSummary> {
    const { webKey, folderTitle } = await GoogleDriveConnector.discoverWebKeyAndTitle(params.rootFolderId)
    const items: DriveRemoteItem[] = []
    let downloadedFiles = 0
    let skippedFolders = 0
    const visitedFolders = new Set<string>()

    const commonHeaders = {
      Referer: `https://drive.google.com/drive/folders/${params.rootFolderId}`,
      Origin: 'https://drive.google.com',
      'User-Agent': USER_AGENT,
    }

    // Queue for Breadth-First Traversal (root files first, then key subfolders)
    const folderQueue: Array<{ folderId: string; relDir: string; depth: number }> = [
      { folderId: params.rootFolderId, relDir: '', depth: 0 },
    ]

    const downloadTasks: Array<() => Promise<void>> = []

    while (folderQueue.length > 0 && items.length < params.maxFiles) {
      const current = folderQueue.shift()!
      if (visitedFolders.has(current.folderId)) continue
      visitedFolders.add(current.folderId)

      const { folders, files } = await GoogleDriveConnector.listFolderItemsViaClients6(
        current.folderId,
        webKey,
      )

      // 1. Schedule all files at this level first!
      for (const entry of files) {
        if (items.length >= params.maxFiles) break
        const safeName = entry.name.replace(/[\\/*?:"<>|]/g, '_').trim() || `item_${entry.id}`
        const targetDir = current.relDir ? join(params.stagingDir, current.relDir) : params.stagingDir
        mkdirSync(targetDir, { recursive: true })

        let localPath = join(targetDir, safeName)
        let downloadUrl: string | null = null
        let fallbackUrl: string | null = null

        if (entry.mimeType === 'application/vnd.google-apps.document') {
          localPath = safeName.toLowerCase().endsWith('.docx') ? localPath : `${localPath}.docx`
          downloadUrl = `https://docs.google.com/document/d/${entry.id}/export?format=docx`
          fallbackUrl = `https://www.googleapis.com/drive/v3/files/${entry.id}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.wordprocessingml.document')}&key=${webKey}`
        } else if (entry.mimeType === 'application/vnd.google-apps.spreadsheet') {
          localPath = safeName.toLowerCase().endsWith('.xlsx') ? localPath : `${localPath}.xlsx`
          downloadUrl = `https://docs.google.com/spreadsheets/d/${entry.id}/export?format=xlsx`
          fallbackUrl = `https://www.googleapis.com/drive/v3/files/${entry.id}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}&key=${webKey}`
        } else if (
          entry.mimeType === 'application/vnd.google-apps.script' ||
          entry.mimeType === 'application/vnd.google-apps.project'
        ) {
          localPath = safeName.toLowerCase().endsWith('.json') ? localPath : `${localPath}.json`
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${entry.id}/export?mimeType=${encodeURIComponent('application/vnd.google-apps.script+json')}&key=${webKey}`
        } else if (entry.mimeType === 'application/vnd.google-apps.presentation') {
          localPath = safeName.toLowerCase().endsWith('.txt') ? localPath : `${localPath}.txt`
          downloadUrl = `https://docs.google.com/presentation/d/${entry.id}/export/txt`
        } else if (!entry.mimeType.startsWith('application/vnd.google-apps.')) {
          if (entry.sizeBytes > 15 * 1024 * 1024) {
            // Very large binary (> 15 MB): write instant metadata descriptor so sync never times out
            localPath = `${localPath}.md`
            const stub = [
              `# Arquivo Grande no Google Drive: ${entry.name}`,
              '',
              `- **Drive ID**: \`${entry.id}\``,
              `- **Tipo MIME**: \`${entry.mimeType}\``,
              `- **Tamanho**: \`${(entry.sizeBytes / 1048576).toFixed(2)} MB\``,
              `- **Link Direto**: https://drive.google.com/open?id=${entry.id}`,
              '',
            ].join('\n')
            writeFileSync(localPath, stub, 'utf8')
            downloadedFiles++
          } else {
            downloadUrl = `https://www.googleapis.com/drive/v3/files/${entry.id}?alt=media&supportsAllDrives=true&key=${webKey}`
            fallbackUrl = `https://drive.usercontent.google.com/download?id=${entry.id}&export=download`
          }
        } else {
          // Google Form, Site, Map, Shortcut: write structured descriptor
          localPath = `${localPath}.md`
          const stub = [
            `# Recurso Google Workspace: ${entry.name}`,
            '',
            `- **Drive ID**: \`${entry.id}\``,
            `- **Tipo**: \`${entry.mimeType}\``,
            `- **Link no Drive**: https://drive.google.com/open?id=${entry.id}`,
            '',
          ].join('\n')
          writeFileSync(localPath, stub, 'utf8')
          downloadedFiles++
        }

        const itemRecord: DriveRemoteItem = {
          id: entry.id,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          webViewLink: `https://drive.google.com/open?id=${entry.id}`,
          parentFolderId: current.folderId,
          localPath,
        }
        items.push(itemRecord)

        if (downloadUrl) {
          const primary = downloadUrl
          const secondary = fallbackUrl
          const targetOut = localPath
          downloadTasks.push(async () => {
            let ok = await GoogleDriveConnector.downloadBinary(primary, targetOut, commonHeaders)
            if (!ok && secondary) {
              ok = await GoogleDriveConnector.downloadBinary(secondary, targetOut, commonHeaders)
            }
            if (ok) {
              downloadedFiles++
            } else {
              // Ensure a readable placeholder exists if Google blocked direct binary download
              const metaMd = `${targetOut}.md`
              if (!existsSync(targetOut) && !existsSync(metaMd)) {
                writeFileSync(
                  metaMd,
                  `# Arquivo Catalogado do Google Drive: ${entry.name}\n\n- **ID**: \`${entry.id}\`\n- **Tipo**: \`${entry.mimeType}\`\n- **Link**: https://drive.google.com/open?id=${entry.id}\n`,
                  'utf8',
                )
              }
            }
          })
        }
      }

      // 2. Enqueue subfolders (skipping _Images / _Files_ AppSheet attachment dumps so we prioritize real documents)
      if (current.depth < 2) {
        const prioritizedFolders = folders.filter((f) => {
          const clean = f.name.replace(/[\\/*?:"<>|]/g, '_').trim()
          if (IGNORED_DRIVE_FOLDERS.has(clean)) {
            skippedFolders++
            return false
          }
          if (/_Images$|_Files_$/i.test(clean)) {
            skippedFolders++
            return false
          }
          return true
        })

        for (const sub of prioritizedFolders.slice(0, 18)) {
          const safeSub = sub.name.replace(/[\\/*?:"<>|]/g, '_').trim() || `folder_${sub.id}`
          const subRel = current.relDir ? join(current.relDir, safeSub) : safeSub
          folderQueue.push({
            folderId: sub.id,
            relDir: subRel,
            depth: current.depth + 1,
          })
        }
      }
    }

    // Run download tasks with concurrency = 10
    const concurrency = 10
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, downloadTasks.length) }, async () => {
      while (cursor < downloadTasks.length) {
        const idx = cursor++
        const fn = downloadTasks[idx]
        if (fn) await fn()
      }
    })
    await Promise.all(workers)

    return {
      rootFolderId: params.rootFolderId,
      folderTitle,
      mode: 'shared_folder_link',
      discoveredFiles: items.length,
      downloadedFiles,
      skippedFolders,
      stagingDir: params.stagingDir,
      items,
      elapsedMs: Math.round((performance.now() - params.t0) * 100) / 100,
    }
  }

  private static async syncViaRestApiV3(params: {
    rootFolderId: string
    stagingDir: string
    accessToken?: string
    apiKey?: string
    maxFiles: number
    t0: number
  }): Promise<DriveCrawlSummary> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Referer: 'https://drive.google.com/',
      'User-Agent': USER_AGENT,
    }
    if (params.accessToken) {
      headers.Authorization = `Bearer ${params.accessToken}`
    }

    const items: DriveRemoteItem[] = []
    let downloadedFiles = 0
    let skippedFolders = 0
    const visitedFolders = new Set<string>()

    const walkFolder = async (folderId: string, relDir: string): Promise<void> => {
      if (visitedFolders.has(folderId) || items.length >= params.maxFiles) return
      visitedFolders.add(folderId)

      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`)
      const fields = encodeURIComponent(
        'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,shortcutDetails)',
      )
      const keySuffix = params.apiKey ? `&key=${encodeURIComponent(params.apiKey)}` : ''
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${keySuffix}`

      const res = await fetch(url, { headers })
      if (!res.ok) {
        throw new Error(`Google Drive API v3 returned HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        files?: Array<{
          id: string
          name: string
          mimeType: string
          size?: string
          md5Checksum?: string
          modifiedTime?: string
          webViewLink?: string
          shortcutDetails?: { targetId?: string; targetMimeType?: string }
        }>
      }

      for (const f of data.files ?? []) {
        if (items.length >= params.maxFiles) break
        const effectiveId = f.shortcutDetails?.targetId ?? f.id
        const effectiveMime = f.shortcutDetails?.targetMimeType ?? f.mimeType
        const safeName = f.name.replace(/[\\/*?:"<>|]/g, '_').trim() || `file_${effectiveId}`

        if (effectiveMime === 'application/vnd.google-apps.folder') {
          if (IGNORED_DRIVE_FOLDERS.has(safeName)) {
            skippedFolders++
            continue
          }
          const subRel = relDir ? join(relDir, safeName) : safeName
          await walkFolder(effectiveId, subRel)
          continue
        }

        const targetDir = relDir ? join(params.stagingDir, relDir) : params.stagingDir
        mkdirSync(targetDir, { recursive: true })

        let downloadUrl: string | null = null
        let outFileName = safeName

        if (effectiveMime === 'application/vnd.google-apps.document') {
          outFileName = safeName.endsWith('.docx') ? safeName : `${safeName}.docx`
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${effectiveId}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.wordprocessingml.document')}${keySuffix}`
        } else if (effectiveMime === 'application/vnd.google-apps.spreadsheet') {
          outFileName = safeName.endsWith('.xlsx') ? safeName : `${safeName}.xlsx`
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${effectiveId}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}${keySuffix}`
        } else if (effectiveMime === 'application/vnd.google-apps.script') {
          outFileName = safeName.endsWith('.json') ? safeName : `${safeName}.json`
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${effectiveId}/export?mimeType=${encodeURIComponent('application/vnd.google-apps.script+json')}${keySuffix}`
        } else if (!effectiveMime.startsWith('application/vnd.google-apps.')) {
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${effectiveId}?alt=media&supportsAllDrives=true${keySuffix}`
        }

        const localPath = join(targetDir, outFileName)
        if (downloadUrl) {
          const ok = await GoogleDriveConnector.downloadBinary(downloadUrl, localPath, headers)
          if (ok) downloadedFiles++
        }

        items.push({
          id: effectiveId,
          name: f.name,
          mimeType: effectiveMime,
          sizeBytes: Number(f.size ?? 0),
          md5Checksum: f.md5Checksum,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink ?? `https://drive.google.com/open?id=${effectiveId}`,
          parentFolderId: folderId,
          localPath: existsSync(localPath) ? localPath : undefined,
        })
      }
    }

    await walkFolder(params.rootFolderId, '')

    return {
      rootFolderId: params.rootFolderId,
      folderTitle: `Drive (${params.rootFolderId.slice(0, 8)})`,
      mode: 'oauth_v3',
      discoveredFiles: items.length,
      downloadedFiles,
      skippedFolders,
      stagingDir: params.stagingDir,
      items,
      elapsedMs: Math.round((performance.now() - params.t0) * 100) / 100,
    }
  }

  private static async downloadBinary(
    url: string,
    outPath: string,
    headers: Record<string, string>,
  ): Promise<boolean> {
    if (existsSync(outPath) && statSync(outPath).size > 0) return true
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 18_000)
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return false
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      if (ctype.includes('text/html') && !outPath.endsWith('.html')) {
        return false
      }
      const arrayBuf = await res.arrayBuffer()
      if (arrayBuf.byteLength === 0) return false
      writeFileSync(outPath, Buffer.from(arrayBuf))
      return true
    } catch {
      return false
    }
  }
}
