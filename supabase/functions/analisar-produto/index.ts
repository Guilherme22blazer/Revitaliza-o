// Edge Function: analisar-produto
// Recebe os dados de um produto e usa a Claude API (Anthropic) para gerar
// uma auditoria fiscal (descrição, NCM, alertas, sugestões).
// A chave da API fica só aqui no servidor (secret ANTHROPIC_API_KEY),
// nunca é exposta ao navegador.
//
// Proteções aplicadas:
// - CORS restrito às origens permitidas (evita que outros sites usem esta
//   função com a chave pública do projeto e gerem custo indevido de IA).
// - Rate limit simples baseado na própria tabela de histórico (analises_ia),
//   para conter picos de uso automatizado/abusivo.
// - Respostas de erro não ecoam o corpo bruto de provedores externos ao
//   cliente; o detalhe completo vai só para os logs da função.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://guilherme22blazer.github.io",
];
const RATE_LIMIT_MAX_PER_MINUTE = 20;

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const SYSTEM_PROMPT = `Você é um assistente fiscal especializado em classificação de mercadorias (NCM) e cadastro de produtos no Brasil.

Sua função é AUDITAR o cadastro de um produto e apontar problemas de descrição, possíveis divergências de NCM e outros dados fiscais, SEMPRE como sugestão — nunca como decisão definitiva.

Regras obrigatórias:
- Nunca invente vigência, extinção ou alteração oficial de NCM: você não tem acesso a uma base fiscal oficial atualizada nesta análise. Diga isso claramente no campo "fontes".
- Baseie suas sugestões de NCM no seu conhecimento geral da tabela NCM/TIPI e no raciocínio sobre a descrição e demais campos do produto, mas deixe claro que é uma sugestão que REQUER VALIDAÇÃO por um responsável fiscal.
- Se as informações do produto forem insuficientes para uma classificação seura, diga isso explicitamente e não force uma sugestão de NCM.
- "confianca" é sua estimativa de 0 a 100 de quão bem a descrição/dados sustentam a classificação sugerida — nunca invente um número preciso sem justificativa coerente.
- Responda ESTRITAMENTE em JSON válido, sem nenhum texto fora do JSON, seguindo exatamente este formato:

{
  "diagnostico": {"cadastro": "verde|amarelo|vermelho", "descricao": "verde|amarelo|vermelho", "ncm": "verde|amarelo|vermelho"},
  "ncm_atual": {"status": "compativel|necessita_validacao|possivel_incorreto", "justificativa": "..."},
  "ncm_sugerido": [
    {"codigo": "00000000", "descricao": "...", "confianca": 0, "justificativa": "..."}
  ],
  "descricao_problema": "...ou null se a descrição já estiver adequada",
  "descricao_sugerida": "...ou null se não houver sugestão melhor",
  "alertas": [
    {"nivel": "verde|amarelo|vermelho", "texto": "..."}
  ],
  "recomendacoes": "...",
  "fontes": "explicação curta de que a sugestão usa conhecimento geral do modelo sobre a tabela NCM/TIPI, sem confirmação em base fiscal oficial atualizada nesta análise; oriente validação com um responsável fiscal antes de aplicar."
}

"ncm_sugerido" deve ter no máximo 3 itens, ordenados do mais para o menos aderente. Se o NCM atual já parecer correto, pode devolver uma lista vazia.
Nunca inclua texto, markdown ou comentários fora do objeto JSON.`;

const MAX_FIELD_LENGTH = 500;

function buildUserPrompt(product: Record<string, unknown>): string {
  const lines = Object.entries(product)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .slice(0, 40)
    .map(([k, v]) => `${String(k).slice(0, 100)}: ${String(v).slice(0, MAX_FIELD_LENGTH)}`);
  return `Audite o seguinte cadastro de produto e responda no formato JSON definido nas instruções do sistema.\n\nDados do produto:\n${lines.join("\n")}`;
}

async function isRateLimited(): Promise<boolean> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return false; // sem acesso à base, não bloqueia
  try {
    const supa = createClient(supabaseUrl, serviceKey);
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { count, error } = await supa
      .from("analises_ia")
      .select("id", { count: "exact", head: true })
      .gte("criado_em", oneMinuteAgo);
    if (error) return false;
    return (count ?? 0) >= RATE_LIMIT_MAX_PER_MINUTE;
  } catch (_err) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não suportado" }), { status: 405, headers });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada nas secrets da função." }),
        { status: 500, headers },
      );
    }

    if (await isRateLimited()) {
      return new Response(
        JSON.stringify({ error: "Limite de análises por minuto atingido. Tente novamente em instantes." }),
        { status: 429, headers },
      );
    }

    const { product } = await req.json();
    if (!product || typeof product !== "object") {
      return new Response(JSON.stringify({ error: "Campo 'product' ausente ou inválido." }), {
        status: 400,
        headers,
      });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(product) }],
      }),
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text();
      console.error("Falha ao consultar a Anthropic API:", anthropicRes.status, detail);
      return new Response(
        JSON.stringify({ error: "Falha ao consultar a IA (status " + anthropicRes.status + ")." }),
        { status: 502, headers },
      );
    }

    const anthropicJson = await anthropicRes.json();
    const rawText: string = anthropicJson?.content?.[0]?.text ?? "";

    let analysis;
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(match ? match[0] : rawText);
    } catch (_err) {
      console.error("Resposta da IA não é JSON válido:", rawText);
      return new Response(
        JSON.stringify({ error: "A IA respondeu em um formato inesperado." }),
        { status: 502, headers },
      );
    }

    return new Response(JSON.stringify({ analysis }), { headers });
  } catch (err) {
    console.error("Erro interno na função analisar-produto:", err);
    return new Response(JSON.stringify({ error: "Erro interno." }), { status: 500, headers });
  }
});
