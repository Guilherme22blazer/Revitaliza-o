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

## 3. Gerar uma chave gratuita do Google Gemini

1. Acesse https://aistudio.google.com/apikey
2. Faça login com uma conta Google
3. Clique em **Create API key** (não pede cartão de crédito — tem cota gratuita)
4. Copie a chave gerada (começa com `AIza...`)

## 4. Configurar a chave da IA

Em **Edge Functions → analisar-produto → Manage secrets** (ou Settings → Edge Functions), adicione:

- Nome: `GEMINI_API_KEY`
- Valor: a chave copiada do Google AI Studio

Nunca coloque essa chave em nenhum arquivo do repositório — ela fica só como secret da função.

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetadas automaticamente pelo Supabase em toda Edge Function — não precisa configurar nada extra para elas.

A função já tem um limite de 20 análises/minuto (proteção básica contra abuso). A cota gratuita do Gemini também tem seus próprios limites por minuto/dia — se bater no limite, a IA retorna erro até renovar.

## Se você já publicou uma versão anterior da função

Sempre que `index.ts` for atualizado neste repositório, é preciso **colar o novo conteúdo e clicar em Deploy de novo** no Supabase — o código daqui não se sincroniza sozinho com o que está publicado lá.

## 5. Tabela de atribuição de tarefas (distribuição por usuário)

Usada nas abas "NCM Mesma Descrição" e "Descrições Duplicadas" para marcar de qual responsável (Guilherme/Caio/Karolayne/João) é cada produto. Rode no **SQL Editor**:

```sql
create table public.atribuicoes (
  key text primary key,
  sheet text not null,
  row_idx integer not null,
  responsavel text,
  atribuido_por text,
  atribuido_em timestamptz,
  historico jsonb not null default '[]'::jsonb,
  atualizado_em timestamptz not null default now()
);

alter table public.atribuicoes enable row level security;

create policy "leitura publica" on public.atribuicoes for select using (true);
create policy "insercao publica" on public.atribuicoes for insert with check (true);
create policy "atualizacao publica" on public.atribuicoes for update using (true);

alter publication supabase_realtime add table public.atribuicoes;
```

## 6. Registrar o nome do usuário em toda edição/exclusão/validação

Adiciona uma coluna `usuario` na tabela `validacoes` (já criada antes, em outro passo). Rode no **SQL Editor**:

```sql
alter table public.validacoes add column if not exists usuario text;
```

A partir dessa mudança, toda ação que altera um registro (editar, excluir, validar, desfazer) pede o nome de quem está fazendo e grava junto — visível para todos os usuários.
