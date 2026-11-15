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
  | 'anthropic_key'
  | 'openai_key'
  | 'github_pat'
  | 'aws_key'
  | 'jwt_token'
  | 'db_uri'
  | 'stripe_slack_token'

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
  /** Example/placeholder values (`xxxx-xxxx`, `****`, `0000`, `<token>`) are documentation, not secrets. */
  static isPlaceholderValue(value: string): boolean {
    const v = value.trim()
    if (!v) return true
    if (/^<[^>]*>$/.test(v) || /\$\{[^}]*\}/.test(v)) return true
    return /^[xX*#0._\-]+$/.test(v)
  }

  static scanText(sourceText: string): {
    findings: Array<{
      ruleId: string
      severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'
      count: number
    }>
  } {
    const res = DlpScanner.scanAndSanitize(sourceText, true)
    const grouped = new Map<string, { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'; count: number }>()
    for (const f of res.findings) {
      const sev = f.severity.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM'
      const cur = grouped.get(f.category)
      if (cur) cur.count++
      else grouped.set(f.category, { severity: sev, count: 1 })
    }
    return {
      findings: Array.from(grouped.entries()).map(([ruleId, v]) => ({
        ruleId,
        severity: v.severity,
        count: v.count,
      })),
    }
  }

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
      anthropic_key: 0,
      openai_key: 0,
      github_pat: 0,
      aws_key: 0,
      jwt_token: 0,
      db_uri: 0,
      stripe_slack_token: 0,
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
        if (full === 'V2-REDACTED' || DlpScanner.isPlaceholderValue(full.slice(3))) return full
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
          if (val.includes('REDACTED') || DlpScanner.isPlaceholderValue(val)) return full
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
          if (val.includes('REDACTED') || DlpScanner.isPlaceholderValue(val)) return full
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

      // Additional Categories
      line = line.replace(/\b(sk-ant-api03-[A-Za-z0-9\-_]{20,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.anthropic_key++
        findings.push({
          category: 'anthropic_key',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'ANTHROPIC_REDACTED',
          secretFingerprint: fp,
          contextPreview: `Anthropic Key (sha256:${fp})`,
        })
        return 'ANTHROPIC_REDACTED'
      })
      line = line.replace(/\b(sk-(?:proj|live|svcacct)-[A-Za-z0-9\-_]{20,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.openai_key++
        findings.push({
          category: 'openai_key',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'OPENAI_REDACTED',
          secretFingerprint: fp,
          contextPreview: `OpenAI Key (sha256:${fp})`,
        })
        return 'OPENAI_REDACTED'
      })
      line = line.replace(/\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.github_pat++
        findings.push({
          category: 'github_pat',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'GITHUB_REDACTED',
          secretFingerprint: fp,
          contextPreview: `GitHub PAT (sha256:${fp})`,
        })
        return 'GITHUB_REDACTED'
      })
      line = line.replace(/\b(AKIA[0-9A-Z]{16})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.aws_key++
        findings.push({
          category: 'aws_key',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'AWS_REDACTED',
          secretFingerprint: fp,
          contextPreview: `AWS Key (sha256:${fp})`,
        })
        return 'AWS_REDACTED'
      })
      line = line.replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.jwt_token++
        findings.push({
          category: 'jwt_token',
          severity: 'medium',
          lineNumber: lineNo,
          redactedToken: 'JWT_REDACTED',
          secretFingerprint: fp,
          contextPreview: `JWT Token (sha256:${fp})`,
        })
        return 'JWT_REDACTED'
      })
      line = line.replace(/(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+:[^\s"'<>]+@[^\s"'<>]+/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.db_uri++
        findings.push({
          category: 'db_uri',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'DB_URI_REDACTED',
          secretFingerprint: fp,
          contextPreview: `DB URI (sha256:${fp})`,
        })
        return 'DB_URI_REDACTED'
      })

      line = line.replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.private_key_pem++
        findings.push({
          category: 'private_key_pem',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'PRIVATE_KEY_PEM_REDACTED',
          secretFingerprint: fp,
          contextPreview: `PEM Private Key Header (sha256:${fp})`,
        })
        return 'PRIVATE_KEY_PEM_REDACTED'
      })
      line = line.replace(/\b((?:sk_live|rk_live)_[0-9a-zA-Z]{20,}|xox[baprs]-[0-9A-Za-z-]{20,})\b/g, (full) => {
        const fp = fingerprint(full)
        countsByCategory.stripe_slack_token++
        findings.push({
          category: 'stripe_slack_token',
          severity: 'critical',
          lineNumber: lineNo,
          redactedToken: 'STRIPE_SLACK_REDACTED',
          secretFingerprint: fp,
          contextPreview: `Stripe/Slack Token (sha256:${fp})`,
        })
        return 'STRIPE_SLACK_REDACTED'
      })

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
