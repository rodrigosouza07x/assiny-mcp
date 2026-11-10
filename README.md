# assiny-mcp

Servidor MCP **somente leitura** para a API pública da Assiny (Treinar Serviços). Permite conversar com o Claude sobre vendas, produtos e assinaturas.

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `listar_produtos` | Produtos do projeto com suas ofertas |
| `listar_vendas` | Vendas com filtros (período, status, UTMs, produto, funil, comprador) e paginação |
| `detalhe_venda` | Detalhe completo de uma venda |
| `detalhe_assinatura` | Situação de uma assinatura |

Nenhuma ferramenta cancela, reativa ou reembolsa. Ações que mexem com dinheiro ficam de fora de propósito.

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `ASSINY_API_KEY` | Chave da API (pedir ao suporte da Assiny). Nunca commitar. |
| `ASSINY_PROJECT_ID` | UUID do projeto (aparece na URL do painel depois de `/projects/`) |
| `MCP_ACCESS_TOKEN` | Segredo que protege o endpoint. Faz parte da URL do conector. |

## Deploy no Render

1. Render → New → Web Service → este repositório (ou use o `render.yaml`).
2. Build: `npm install && npm run build` · Start: `npm start`.
3. Em **Environment**, preencha `ASSINY_API_KEY`, `ASSINY_PROJECT_ID` e `MCP_ACCESS_TOKEN` (valor longo e aleatório).
4. Confira `https://SEU-SERVICO.onrender.com/health`: os três campos devem aparecer como `true`.

## Conectar no Claude

Claude → Configurações → Conectores → Adicionar conector personalizado:

```
https://SEU-SERVICO.onrender.com/mcp/<MCP_ACCESS_TOKEN>
```

O conector personalizado do Claude não envia cabeçalho de autenticação próprio, por isso o segredo vai no caminho da URL. Trate a URL completa como senha. Se vazar, troque `MCP_ACCESS_TOKEN` no Render.

## Observações da API

- Valores em centavos (R$ 97,00 = `9700`).
- Datas enviadas exigem hora e fuso: `2026-11-01T00:00:00-03:00`.
- Respostas em UTC.
- Erros 5xx são repetidos até 3 vezes; os demais voltam com mensagem explicativa.

## Desenvolvimento local

```
cp .env.example .env   # preencher
npm install
npm run dev
```
