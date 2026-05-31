# Expedi Local — Operação híbrida offline (Abordagem B)

**Data:** 2026-05-31
**Status:** Design aprovado (aguardando revisão da spec)
**Origem:** Necessidade de o Expedi continuar operando quando cai a internet do cliente.

---

## 1. Problema

Hoje o Expedi é um SaaS **100% na nuvem** (Next.js na Vercel + Supabase). Na máquina do
cliente roda apenas o **agente .NET** (ExpediAgent), que lê o Hiper (SQL Server local) e
**empurra** os dados pra nuvem (mão única, depende de internet).

Se a internet do cliente cai:
- O Hiper (local) continua funcionando.
- O agente **pausa** o envio (sem perda — retoma do high-water-mark quando volta).
- **O app Expedi fica inacessível** (mapa de carregamento, OS, notificações) — a equipe não consegue trabalhar no Expedi.

O cliente precisa de **paridade total offline**: ver/imprimir, mudar status (separar/entregar),
criar/editar pedido e OS, e enfileirar notificações — tudo sem internet, sincronizando quando volta.

## 2. Decisões tomadas (brainstorming)

| Tema | Decisão |
|------|---------|
| Escopo offline | **Paridade total**: ver/imprimir, mudar status, criar/editar pedido+OS, notificações |
| Usuários/dispositivos | **Variável por cliente** → desenhar pro caso amplo: **servidor local na LAN** servindo PCs e celulares via navegador; funciona também em 1 PC só |
| Escrita no Hiper | **NÃO.** O que o Expedi cria/edita vive **só no Expedi**. Nunca escrevemos no banco do Hiper (risco/escopo do ERP) |
| Login offline | **Sessão lembrada por dispositivo** (loga 1x online → segue offline naquele aparelho) |
| Conflito | **Última edição vence** (por timestamp). Aceitável porque é 1 cliente / 1 equipe por site |
| Abordagem | **B — o agente vira "hub local"**: banco local + serve a UI na rede + sincroniza com a nuvem |

## 3. Arquitetura: local-first no site, nuvem como espelho

O site do cliente **sempre usa o Expedi local** (principal). A nuvem é o **espelho
sincronizado** + ponto de acesso remoto. Elimina a ambiguidade de "qual cópia é a verdadeira":
no site é a local; fora é a nuvem; o sincronizador mantém as duas iguais.

```
MÁQUINA DO CLIENTE (hub local):
  Hiper (SQL local) ─> [Leitor Hiper] ─> Banco LOCAL (Postgres) <─> [Expedi LOCAL] (equipe, via LAN/navegador)
                                              │
                                       [Sincronizador] ⇅ internet (quando há)
                                              │
NUVEM:                                        ▼
  Banco nuvem (Supabase) <─> [Expedi NUVEM] (operador + dono, acesso remoto; disparo de notificações)
```

- Equipe no site → **Expedi local** (rápido, LAN, com/sem internet).
- Sincronizador → replica **local ⇄ nuvem continuamente** quando online.
- Operador/dono → **Expedi nuvem** (sempre igual ao local, via sync).
- Hiper → alimenta o **banco local** (o agente evoluído).
- Notificações → fila; saem pela nuvem assim que alcançável.

## 4. Componentes no hub local (um instalador único, sem Docker)

1. **Expedi local** — o mesmo Next.js de hoje, rodando como processo Node na máquina, servindo a LAN. Mesmas telas.
2. **Banco local** — Postgres embarcado/portátil (sem Docker; bundle no instalador). Guarda os dados desta empresa + ingestão do Hiper.
3. **Leitor Hiper** — o ExpediAgent atual, evoluído pra gravar no **banco local** (em vez de POSTar pra nuvem).
4. **Sincronizador** — peça nova; mantém banco local ⇄ nuvem iguais (fila + última-edição-vence).

Instalador único (estilo Inno Setup, como o do agente hoje): "avançar → concluir". Requisito:
a máquina-hub fica ligada no horário de trabalho (normalmente o próprio PC do Hiper).

## 5. Sincronizador (núcleo do projeto)

**Replicação por deltas, bidirecional, com cursor por tabela:**
- **Push:** linhas locais com `updated_at` > cursor → upsert na nuvem.
- **Pull:** linhas da nuvem com `updated_at` > cursor → upsert no local.
- **Conflito:** última escrita vence (compara `updated_at`). Linhas novas têm UUID → sem conflito de inserção.
- **Fila de saída ("caderninho"):** mudanças feitas offline ficam registradas; ao voltar a internet, esvaziam automaticamente (poll a cada poucos segundos).
- **Agregados (pedido + pontos + itens; OS + itens + serviços):** sincronizar no nível do agregado (versionar o pai; substituir filhos juntos) pra evitar estado parcial. Edição hoje é delete+insert dos filhos → tratar como troca atômica do agregado.
- **Deletes:** preferir soft-delete/`status='cancelado'` (já é o padrão) pra propagar sem ambiguidade. Evitar hard-delete em tabelas sincronizadas.
- **Idempotência:** ingestão do Hiper dedupa por `documento_erp` (já existe) → segura nos dois lados.

**Notificações:** enfileiradas localmente; o sincronizador sobe pra `os_notificacoes` da nuvem; o
**dispatcher da nuvem (já existe)** envia. WhatsApp/e-mail só saem online — fila cobre o offline.

## 6. Separação do "cérebro" (o grosso do esforço)

Hoje login + regras de dados vivem na nuvem (Supabase Auth + RLS + server actions). Pra rodar
local também, separar numa **camada de dados/auth com duas implementações**:
- **Nuvem:** Supabase (como hoje).
- **Local:** Postgres local + **auth local** (sessão lembrada; valida contra a nuvem quando online).

O mesmo código Next roda nos dois modos, escolhendo a implementação conforme o ambiente
(deploy nuvem vs. bundle local). Esse desacoplamento é o trabalho mais pesado e o de maior risco.

## 7. Login offline + segurança

- Sessão **lembrada por dispositivo**: 1º login exige internet; depois funciona offline naquele aparelho.
- Expedi local responde **só na LAN** do cliente (não exposto na internet aberta); continua exigindo login.
- Credenciais sensíveis (token uazapi etc.) ficam no lado servidor do hub, nunca expostas ao navegador.
- **Limitação conhecida:** aparelho novo que nunca logou online não consegue 1º login durante queda.

## 8. Escopo / Não-objetivos

**No escopo:** paridade offline das telas atuais (vendas/mapa, OS, notificações, status),
sincronização bidirecional, instalador único, piloto com 1 cliente.

**Fora do escopo:** escrever de volta no Hiper; multi-master entre vários sites do mesmo cliente;
resolução de conflito campo-a-campo sofisticada (usamos última-edição-vence); app mobile nativo.

## 9. Riscos

- **Sincronizador malfeito = dado some/duplica.** Maior risco. Mitigar com piloto + testes de queda + verificação.
- **Manutenção dobrada:** toda regra nova passa a valer nos dois ambientes (custo permanente).
- **Instalação no perfil do cliente** (oficina/loja, não-TI): instalador tem que ser à prova de bala (sem Docker).
- **Postgres embarcado no Windows:** validar a opção mais simples e confiável de empacotar.

## 10. Estratégia de teste e rollout

1. **1 cliente piloto** (não soltar geral).
2. Instalar e rodar **~1 semana** em uso real.
3. **Simular quedas de internet** de propósito; conferir: nada some, nada duplica, sincroniza correto.
4. Testes automatizados do sincronizador (cenários de conflito, fila, agregados).
5. Só liberar pros demais após o piloto passar.

**Prazo honesto:** semanas (sincronizador + desacoplamento do cérebro + instalador + testes).
É o maior pedaço do projeto inteiro.

## 11. Decomposição sugerida (para os planos de implementação)

1. **Desacoplar a camada de dados/auth** (cérebro nos dois ambientes) — fundação.
2. **Hub local**: empacotar Next + Postgres local + instalador; agente grava no banco local.
3. **Sincronizador**: deltas bidirecionais + fila + conflito + agregados.
4. **Login offline** (sessão lembrada) + segurança LAN.
5. **Piloto + testes de queda** e ajustes.

Cada item vira seu próprio ciclo spec → plano → implementação.
