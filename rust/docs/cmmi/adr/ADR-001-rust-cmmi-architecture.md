---
adr_id: ADR-001
title: Arquitetura Monorepo Cargo Rust + Governança CMMI Nível 4 + Organograma Dual-Plane
status: Accepted
date: 2026-11-14
layer_rules:
  - from: "crates/vortex-core/**"
    forbid:
      - "crates/fabrica-cmmi/**"
      - "crates/fabrica-agents/**"
      - "crates/fabrica-daemon/**"
      - "crates/fabrica-mcp/**"
      - "crates/fabrica-cli/**"
      - "ui/**"
    reason: "vortex-core deve permanecer 100% independente para compilar o binário standalone kvx espelhado ao repositório oficial kaxcav-vortex."
  - from: "crates/fabrica-cmmi/**"
    forbid:
      - "crates/fabrica-agents/**"
      - "crates/fabrica-daemon/**"
      - "crates/fabrica-mcp/**"
      - "crates/fabrica-cli/**"
      - "ui/**"
    reason: "O domínio formal CMMI (FSM, validadores, Organograma e SPC) não pode depender de adaptadores de execução CLI ou transporte HTTP/MCP."
  - from: "crates/fabrica-agents/**"
    forbid:
      - "crates/fabrica-daemon/**"
      - "crates/fabrica-mcp/**"
      - "crates/fabrica-cli/**"
      - "ui/**"
    reason: "A camada de aplicação de agentes orquestra worktrees e CLIs mas não conhece protocolos de transporte."
  - from: "ui/organograma/packages/**"
    forbid:
      - "ui/organograma/apps/**"
    reason: "Pacotes puros de schema/core/layout da UI nunca dependem da camada React/DOM do app."
---

# ADR-001: Padrão Arquitetural Organizacional (OPD — CMMI Nível 3 TS/PI)

## 1. Contexto
A migração da Fábrica Kaxcav v3.1 (TypeScript/Node.js) para a v4.0-CMMI exige eliminar o split-brain com o `kaxcav-vortex` oficial, erradicar 514 erros de tipagem e estabelecer garantias formais de engenharia de software assistida por IA sob práticas CMMI Níveis 2, 3 e 4.

## 2. Regras Inegociáveis de Clean Code e Engenharia (Injetadas em Todo Briefing L0-L3)
1. **Zero Código Inacabado:** É estritamente proibido introduzir funções vazias, retornos falsos hardcoded, blocos `catch` mudos, supressões indevidas de linter ou marcadores de pendência em comentários.
2. **Tipagem Estrita e Erros Explícitos:** Em Rust, toda falha recuperável retorna `Result<T, E>` tipado com `thiserror`; `.unwrap()` ou `.expect()` são proibidos em caminhos de produção fora de invariantes estáticas provadas na inicialização. Em TypeScript (`ui/organograma`), `strict: true` é obrigatório e `any` explícito é proibido.
3. **Fronteiras de Camada Determinísticas:**
   - `vortex-core` (`domain/infra-ast`) → base pura compartilhada entre `fabrica` e `kvx`.
   - `fabrica-cmmi` (`domain-governance`) → depende apenas de `vortex-core`.
   - `fabrica-agents` (`application`) → depende de `vortex-core` e `fabrica-cmmi`.
   - `fabrica-daemon` / `fabrica-mcp` (`interface-transport`) → expõem Unix Socket, HTTP/WS `:7788` e stdio JSON-RPC.
   - `fabrica-cli` (`entrypoint`) → binários `fabrica` e `kvx`.
4. **Rastreabilidade Obrigatória ao Organograma:** Nenhum módulo novo pode ser criado fora dos `write_globs` declarados em `docs/cmmi/organograma.json` e sem cobertura de requisito `@REQ-*`.
5. **Isolamento de Verificação:** Nenhum agente `Builder` pode assinar artefatos de `BlindVerification (VER/VAL)` ou `ProcessAudit (PPQA)`.
