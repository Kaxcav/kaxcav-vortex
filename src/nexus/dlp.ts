import { createHash } from 'node:crypto'

export type DlpCategory =
  | 'appsheet_access_key'
  | 'appsheet_app_id'
  | 'google_api_key'
  | 'google_oauth_token'
  | 'drive_resource_id'
  | 'generic_secret'
  | 'private_key_pem'
  | 'pii_cpf_cnpj'

export interface DlpFinding {
  category: DlpCategory
  severity: 'critical' | 'high' | 'medium'
  lineNumber: number
  redactedToken: string
  secretFingerprint: string
  contextPreview: string
}

export interface DlpScanResult {
  sanitizedText: string
  findings: DlpFinding[]
  countsByCategory: Record<DlpCategory, number>
}

export class DlpScanner {
  static scanAndSanitize(sourceText: string, redactPii = false): DlpScanResult {
    const findings: DlpFinding[] = []
    const countsByCategory: Record<DlpCategory, number> = {
      appsheet_access_key: 0,
      appsheet_app_id: 0,
      google_api_key: 0,
      google_oauth_token: 0,
      drive_resource_id: 0,
      generic_secret: 0,
      private_key_pem: 0,
      pii_cpf_cnpj: 0,
    }

    const lines = sourceText.split(/\r?\n/)
    const sanitizedLines: string[] = []

    const fingerprint = (val: string) =>
      createHash('sha256').update(val).digest('hex').slice(0, 10)

    for (let idx = 0; idx < lines.length; idx++) {
      let line = lines[idx]
      const lineNo = idx + 1

      // 1. AppSheet V2 Access Keys (e.g. V2-xxxxx-xxxxx...)
      line = line.replace(/\b(V2-[A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,})+)\b/g, (full) => {
        if (full === 'V2-REDACTED') return full
        const fp = fingerprint(full)
        countsByCategory.appsheet_access_key++
        findings.push({
          category: 'appsheet_access_key',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'V2-REDACTED',
          secretFingerprint: fp,
          contextPreview: `AppSheet Access Key V2-*** (sha256:${fp})`,
        })
        return 'V2-REDACTED'
      })

      // 2. AppSheet App UUID in API URL
      line = line.replace(
        /(api\.appsheet\.com\/api\/v2\/apps\/)([0-9a-f]{8}-[0-9a-f-]{27})/gi,
        (_, prefix: string, uuid: string) => {
          const fp = fingerprint(uuid)
          countsByCategory.appsheet_app_id++
          findings.push({
            category: 'appsheet_app_id',
            severity: 'high',
            lineNumber: lineNo,
            redactedToken: 'REDACTED_APP_ID',
            secretFingerprint: fp,
            contextPreview: `${prefix}REDACTED_APP_ID (sha256:${fp})`,
          })
          return `${prefix}REDACTED_APP_ID`
        },
      )

      // 3. Google Cloud / Maps / Gemini API Keys (AIza...)
      line = line.replace(/\b(AIza[0-9A-Za-z_-]{30,45})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.google_api_key++
        findings.push({
          category: 'google_api_key',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'GOOGLE_API_KEY_REDACTED',
          secretFingerprint: fp,
          contextPreview: `Google API Key AIza*** (sha256:${fp})`,
        })
        return 'GOOGLE_API_KEY_REDACTED'
      })

      // 4. Google OAuth2 Access Tokens (ya29....)
      line = line.replace(/\b(ya29\.[0-9A-Za-z_-]{24,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.google_oauth_token++
        findings.push({
          category: 'google_oauth_token',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'GOOGLE_OAUTH_REDACTED',
          secretFingerprint: fp,
          contextPreview: `Google OAuth Token ya29.*** (sha256:${fp})`,
        })
        return 'GOOGLE_OAUTH_REDACTED'
      })

      // 5. Hardcoded Google Drive / Template Resource IDs in code constants
      line = line.replace(
        /((?:const|var|let)\s+(?:TEMPLATE_ID|PASTA_DESTINO(?:_PDF)?|API_APP|idPastaRaiz|FOLDER_ID|DRIVE_FOLDER_ID)\s*=\s*['"])([^'"]+)(['"])/g,
        (full, pre: string, val: string, suf: string) => {
          if (val === 'REDACTED_RESOURCE_ID') return full
          const fp = fingerprint(val)
          countsByCategory.drive_resource_id++
          findings.push({
            category: 'drive_resource_id',
            severity: 'medium',
            lineNumber: lineNo,
            redactedToken: 'REDACTED_RESOURCE_ID',
            secretFingerprint: fp,
            contextPreview: `${pre}REDACTED_RESOURCE_ID${suf} (sha256:${fp})`,
          })
          return `${pre}REDACTED_RESOURCE_ID${suf}`
        },
      )

      // 6. Generic Secret / Token / Key assignments
      line = line.replace(
        /((?:const|var|let)\s+[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*['"])([^'"]+)(['"])/gi,
        (full, pre: string, val: string, suf: string) => {
          if (val.includes('REDACTED')) return full
          const fp = fingerprint(val)
          countsByCategory.generic_secret++
          findings.push({
            category: 'generic_secret',
            severity: 'critical',
            lineNumber: lineNo,
            redactedToken: 'REDACTED_SECRET',
            secretFingerprint: fp,
            contextPreview: `${pre}REDACTED_SECRET${suf} (sha256:${fp})`,
          })
          return `${pre}REDACTED_SECRET${suf}`
        },
      )

      // 7. JSON / Object literal client_secret, refresh_token, private_key, applicationAccessKey
      line = line.replace(
        /(['"]?(?:client_secret|access_token|refresh_token|private_key|applicationAccessKey)['"]?\s*[:=]\s*['"])([^'"]+)(['"])/gi,
        (full, pre: string, val: string, suf: string) => {
          if (val.includes('REDACTED')) return full
          const fp = fingerprint(val)
          countsByCategory.generic_secret++
          findings.push({
            category: 'generic_secret',
            severity: 'critical',
            lineNumber: lineNo,
            redactedToken: 'REDACTED_SECRET',
            secretFingerprint: fp,
            contextPreview: `${pre}REDACTED_SECRET${suf} (sha256:${fp})`,
          })
          return `${pre}REDACTED_SECRET${suf}`
        },
      )

      // 8. Optional CPF/CNPJ PII detection
      if (redactPii) {
        line = line.replace(
          /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\b/g,
          (docVal) => {
            const fp = fingerprint(docVal)
            countsByCategory.pii_cpf_cnpj++
            findings.push({
              category: 'pii_cpf_cnpj',
              severity: 'medium',
              lineNumber: lineNo,
              redactedToken: 'REDACTED_BR_DOC',
              secretFingerprint: fp,
              contextPreview: `Documento CPF/CNPJ mascarado (sha256:${fp})`,
            })
            return 'REDACTED_BR_DOC'
          },
        )
      }

      sanitizedLines.push(line)
    }

    return {
      sanitizedText: sanitizedLines.join('\n'),
      findings,
      countsByCategory,
    }
  }
}
