import express, { type Request, type Response as ExpressResponse } from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const BASE_URL = "https://bff.assiny.com.br/v1/public";
const API_KEY = process.env.ASSINY_API_KEY ?? "";
const PROJECT_ID = process.env.ASSINY_PROJECT_ID ?? "";
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 3000);
// O Render define RENDER_EXTERNAL_URL automaticamente.
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL ?? "https://assiny-mcp.onrender.com").replace(/\/$/, "");
const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

// ---------------------------------------------------------------------------
// Cliente HTTP da Assiny (único ponto que coloca os cabeçalhos)
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | undefined>;

async function assinyGet(path: string, query: Query = {}): Promise<unknown> {
  if (!API_KEY || !PROJECT_ID) {
    throw new Error(
      "ASSINY_API_KEY e/ou ASSINY_PROJECT_ID não estão configurados no servidor.",
    );
  }
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    ProjectId: PROJECT_ID,
  };

  // 5xx: até 3 tentativas com espera crescente (só em GET, que é seguro repetir)
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
      throw new Error(`Não foi possível conectar à Assiny. ${cause}`.trim());
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      continue;
    }
    lastError = `Assiny respondeu ${res.status}: ${friendlyError(res.status, text)}`;
    break;
  }
  throw new Error(lastError || "Falha ao consultar a Assiny.");
}

function friendlyError(status: number, body: string): string {
  const hints: Record<number, string> = {
    400: "requisição inválida (confira filtros e datas, que precisam de fuso, ex.: 2026-11-01T00:00:00-03:00).",
    401: "chave de API ausente, errada ou revogada.",
    403: "o projeto não foi liberado para essa chave (peça ao suporte da Assiny).",
    404: "o ID informado não existe.",
    422: "regra de negócio recusou a operação.",
  };
  let detail = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { message?: string };
    if (j.message) detail = j.message;
  } catch {
    /* corpo não era JSON */
  }
  return `${hints[status] ?? "erro inesperado."} ${detail}`.trim();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Data com hora e fuso, exigida pela API (data sem hora é recusada com 400)
const dateTimeWithZone = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    "Use data e hora com fuso, ex.: 2026-11-01T00:00:00-03:00",
  );

const SALE_STATUS = [
  "paid",
  "pending",
  "waiting_payment",
  "refunded",
  "refused",
  "chargedback",
  "chargedback_refunded",
  "pix_expired",
  "request_refund",
  "sent_to_refund",
  "refunded_by_client",
] as const;

// ---------------------------------------------------------------------------
// Servidor MCP (somente leitura)
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({
    name: "assiny-mcp",
    title: "Assiny",
    version: "1.0.0",
    icons: [{ src: `${PUBLIC_URL}/logo.png`, mimeType: "image/png", sizes: ["512x512"] }],
  });

  server.registerTool(
    "listar_produtos",
    {
      title: "Listar produtos e ofertas",
      description:
        "Lista os produtos do projeto na Assiny, cada um com suas ofertas (preços em centavos). Use para descobrir os IDs de produtos e ofertas.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await assinyGet(`/product/list/product/checkout/${PROJECT_ID}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "listar_vendas",
    {
      title: "Listar vendas",
      description:
        "Lista as vendas do projeto com filtros, em páginas. Valores vêm em centavos (R$ 97,00 = 9700). Datas precisam de hora e fuso (ex.: 2026-11-01T00:00:00-03:00). Para vendas aprovadas use status=paid. Para ver só o que mudou desde a última consulta, use updatedAtStartDate/updatedAtEndDate.",
      inputSchema: {
        startDate: dateTimeWithZone.optional().describe("Início do período de criação da venda"),
        endDate: dateTimeWithZone.optional().describe("Fim do período de criação da venda"),
        updatedAtStartDate: dateTimeWithZone.optional().describe("Início do período da última atualização"),
        updatedAtEndDate: dateTimeWithZone.optional().describe("Fim do período da última atualização"),
        status: z.array(z.enum(SALE_STATUS)).optional().describe("Um ou mais status"),
        paymentTypes: z.array(z.enum(["CREDIT", "PIX", "BANK_SLIP"])).optional(),
        offerTypes: z.array(z.enum(["ENTRY", "UPSELL", "DOWNSELL", "ORDERBUMP"])).optional(),
        products: z.array(z.string().uuid()).optional().describe("IDs de produtos"),
        offers: z.array(z.string().uuid()).optional().describe("IDs de ofertas"),
        funnels: z.array(z.string().uuid()).optional().describe("IDs de funis"),
        clientEmail: z.string().optional(),
        clientDocument: z.string().optional().describe("CPF/CNPJ do comprador"),
        nameEmailClient: z.string().optional().describe("Busca por nome ou e-mail do comprador"),
        utmSource: z.string().optional(),
        utmMedium: z.string().optional(),
        utmCampaign: z.string().optional(),
        utmTerm: z.string().optional(),
        utmContent: z.string().optional(),
        src: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50).describe("Vendas por página (máx. 100)"),
        offset: z.number().int().min(0).default(0).describe("Quantas vendas pular (paginação)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { status, paymentTypes, offerTypes, products, offers, funnels, ...rest } = args;
        const query: Query = {
          projectId: PROJECT_ID,
          ...rest,
          status: status?.join(","),
          paymentTypes: paymentTypes?.join(","),
          offerTypes: offerTypes?.join(","),
          products: products?.join(","),
          offers: offers?.join(","),
          funnels: funnels?.join(","),
        };
        return ok(await assinyGet("/financial/bff/project/transaction", query));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "detalhe_venda",
    {
      title: "Detalhe de uma venda",
      description:
        "Dados completos de uma venda: status, valores, forma de pagamento, comprador, produto, oferta, funil, UTMs, order bumps e, se for assinatura, o subscriptionId.",
      inputSchema: { transactionId: z.string().uuid().describe("ID (UUID) da venda") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ transactionId }) => {
      try {
        return ok(await assinyGet(`/financial/bff/sale/details/${transactionId}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "detalhe_assinatura",
    {
      title: "Detalhe de uma assinatura",
      description:
        "Situação de uma assinatura: status da recorrência, ciclo atual, próxima cobrança, status da última cobrança, valor, comprador, produto e oferta.",
      inputSchema: { subscriptionId: z.string().uuid().describe("ID (UUID) da assinatura") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ subscriptionId }) => {
      try {
        return ok(await assinyGet(`/subscription-admin/subscription/details/${subscriptionId}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ name: "assiny-mcp", status: "ok" });
});

// Logo do conector (favicon e ícone declarado no serverInfo)
app.get("/favicon.ico", (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.type("image/x-icon").sendFile(ASSETS_DIR + "favicon.ico");
});
app.get("/logo.png", (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.type("image/png").sendFile(ASSETS_DIR + "logo.png");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    assinyKeyConfigured: Boolean(API_KEY),
    projectConfigured: Boolean(PROJECT_ID),
    accessTokenConfigured: Boolean(ACCESS_TOKEN),
  });
});

// Servidor sem estado: um servidor MCP + transporte novo por requisição.
async function handleMcp(req: Request, res: ExpressResponse) {
  if (!ACCESS_TOKEN) {
    res.status(503).json({ error: "MCP_ACCESS_TOKEN não configurado no servidor." });
    return;
  }
  if (!tokenMatches(String(req.params.token ?? ""))) {
    res.status(401).json({ error: "Não autorizado." });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Erro ao tratar requisição MCP:", e instanceof Error ? e.message : e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Erro interno do servidor" },
        id: null,
      });
    }
  }
}

app.post("/mcp/:token", handleMcp);
app.get("/mcp/:token", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Método não permitido." },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`assiny-mcp ouvindo na porta ${PORT}`);
});
