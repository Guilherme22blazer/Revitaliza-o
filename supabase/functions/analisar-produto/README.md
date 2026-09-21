# Deploy da função `analisar-produto`

## 1. Criar a tabela de histórico

No Supabase, **SQL Editor → New query**, rode:

```sql
create table public.analises_ia (
  id uuid primary key default gen_random_uuid(),
  produto_key text not null,
  sheet text not null,
  row_idx integer not null,
  codigo text,
  descricao text,
  usuario text,
  ncm_anterior text,
  ncm_sugerido text,
  resultado jsonb not null,
  aplicado boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.analises_ia enable row level security;

create policy "leitura publica" on public.analises_ia for select using (true);
create policy "insercao publica" on public.analises_ia for insert with check (true);
```

## 2. Publicar a função

No Supabase, **Edge Functions → Deploy a new function**:

- Nome: `analisar-produto`
- Cole o conteúdo de `index.ts` (nesta mesma pasta)
- Deploy

## 3. Configurar a chave da IA

Em **Edge Functions → Manage secrets** (ou Settings → Edge Functions), adicione:

- Nome: `ANTHROPIC_API_KEY`
- Valor: sua chave da Anthropic (começa com `sk-ant-...`)

Nunca coloque essa chave em nenhum arquivo do repositório — ela fica só como secret da função.

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetadas automaticamente pelo Supabase em toda Edge Function — não precisa configurar nada extra para elas.

## 4. Limite de gastos na Anthropic (recomendado)

A função tem um limite de 20 análises/minuto (proteção básica contra abuso), mas o controle mais importante é feito direto na sua conta:

- Acesse **console.anthropic.com → Settings → Billing → Usage limits**
- Configure um limite mensal de gastos compatível com o uso esperado

Isso evita surpresas na fatura caso a chave seja usada de forma inesperada.

## Se você já publicou uma versão anterior da função

Sempre que `index.ts` for atualizado neste repositório, é preciso **colar o novo conteúdo e clicar em Deploy de novo** no Supabase — o código daqui não se sincroniza sozinho com o que está publicado lá.
