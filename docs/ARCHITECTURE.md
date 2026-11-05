# Kaxcav Vortex (`kvx` v2.0.0-apex) — Especificação de Arquitetura

## 1. Visão Geral

O **Kaxcav Vortex (`kvx`)** é um motor poliglota de inteligência de código, indexação incremental por hash de conteúdo (CAS), grafo esparso em memória (**CSR — Compressed Sparse Row**) e empacotamento submodular de contexto (`L0–L3`).

---

## 2. As 7 Camadas do Motor

### Camada 1: `AdmissionFirewall` ([src/core/firewall.ts](../src/core/firewall.ts))
- Inspeciona os primeiros `4.096 bytes` de cada arquivo candidato via descritor de baixo nível (`openSync`/`readSync`).
- Bloqueia assinaturas binárias (`%PDF-`, `PK\x03\x04`, `SQLite`, `MZ`, `.ELF`, `PNG`, `JPEG`, `GZIP`), bytes nulos (`0x00`) e arquivos minificados/bundles com linhas acima de `1.400` caracteres.
- Não depende da existência de `.git` no repositório.

### Camada 2: `CodeStateMachine` & `PolyglotExtractor` ([src/parser/lexer.ts](../src/parser/lexer.ts), [src/parser/extractor.ts](../src/parser/extractor.ts))
- Autômato léxico finito de 6 estados (`Code`, `LineComment`, `BlockComment`, `SingleQuote`, `DoubleQuote`, `TemplateQuote`) que calcula limites exatos de blocos `{ ... }` ignorando chaves dentro de strings, regexes ou comentários.
- Extrai símbolos tipados, assinaturas multi-linha, rotas REST (`expose`/`consume`), modelos Prisma/SQL e arestas de chamada (`calls`, `imports`, `tests`).

### Camada 3: `RepositoryShard` ([src/storage/shard.ts](../src/storage/shard.ts))
- Isolamento físico em SQLite nativo (`node:sqlite`) com `1 shard por repositório` em `~/.kaxcav-vortex/shards/<repo-hash>.sqlite`.
- Limite físico de WAL em `32 MB` (`PRAGMA journal_size_limit = 33554432`).
- Cache Content-Addressable (`cas_extractions`) indexado por `SHA-256` + busca híbrida `FTS5 (BM25F)`.
- Auditoria contínua de assinaturas em `symbol_history` para detecção automática de *Contract Drift*.

### Camada 4: `CsrGraph` + `PPR-HD` ([src/graph/csr.ts](../src/graph/csr.ts))
- Grafo **Compressed Sparse Row (CSR)** alocado em `Uint32Array` e `Float32Array`.
- Algoritmo **Query-Anchored Personalized PageRank with Hub Dampening (`PPR-HD`)**:
  $$\text{Score}(v) = (1 - \alpha)\,s_Q(v) + \alpha \sum_{u \in \mathcal{N}_{\text{in}}(v)} \frac{w(u,v) \cdot \text{Score}(u)}{\text{OutDeg}(u) \cdot \left(1 + \beta \ln(1 + \text{OutDeg}(u))\right)}$$
- Penaliza arquivos-índice (*barrels* e *hubs* de documentação) que diluem o ranking do código executável.

### Camada 5: `SubmodularPacker` ([src/packer/packer.ts](../src/packer/packer.ts))
- Otimização submodular sob restrição de mochila (*knapsack budget*) em 4 níveis de fidelidade:
  - `L3_FOCAL`: Corpo completo da função/classe alvo.
  - `L2_CONTRACT`: Assinatura tipada + docstring dos chamadores/dependentes diretos.
  - `L1_SKELETON`: Esqueleto estrutural compacto (~40 tokens por arquivo).
  - `L0_DELTA`: Marcador `[ETAG_UNCHANGED]` persistido entre processos no SQLite (`pack_snapshots`).

### Camada 6: `MultiRepoFederator` ([src/federation/federator.ts](../src/federation/federator.ts))
- Conecta múltiplos shards simultâneos cruzando rotas HTTP (`expose` <-> `consume`), contratos exportados e modelos Prisma/SQL.

### Camada 7: Interfaces (`CLI`, `MCP JSON-RPC 2.0`, `Web Workbench`)
- **CLI (`kvx`)**: [src/cli/main.ts](../src/cli/main.ts)
- **Servidor MCP (10 Tools)**: [src/mcp/server.ts](../src/mcp/server.ts)
- **Web Workbench (`http://127.0.0.1:7788`)**: [src/ui/server.ts](../src/ui/server.ts) e [src/ui/dashboard.html](../src/ui/dashboard.html)
