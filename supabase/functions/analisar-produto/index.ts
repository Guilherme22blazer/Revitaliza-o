// Edge Function: analisar-produto
// Recebe os dados de um produto e usa a Claude API (Anthropic) para gerar
// uma auditoria fiscal (descrição, NCM, alertas, sugestões).
// A chave da API fica só aqui no servidor (secret ANTHROPIC_API_KEY),
// nunca é exposta ao navegador.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function buildUserPrompt(product: Record<string, unknown>): string {
  const lines = Object.entries(product)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `Audite o seguinte cadastro de produto e responda no formato JSON definido nas instruções do sistema.\n\nDados do produto:\n${lines.join("\n")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não suportado" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada nas secrets da função." }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const { product } = await req.json();
    if (!product || typeof product !== "object") {
      return new Response(JSON.stringify({ error: "Campo 'product' ausente ou inválido." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
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
      return new Response(
        JSON.stringify({ error: "Falha ao consultar a IA.", detail }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const anthropicJson = await anthropicRes.json();
    const rawText: string = anthropicJson?.content?.[0]?.text ?? "";

    let analysis;
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(match ? match[0] : rawText);
    } catch (_err) {
      return new Response(
        JSON.stringify({ error: "A IA respondeu em um formato inesperado.", raw: rawText }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Erro interno.", detail: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
