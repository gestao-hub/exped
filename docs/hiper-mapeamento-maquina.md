# Roteiro: mapear o Hiper na máquina do cliente

> **Objetivo:** descobrir, na máquina onde o Hiper está instalado, **duas coisas** —
> (1) onde/como o Hiper gera o PDF do pedido de venda, e (2) como o Hiper guarda
> os pedidos no banco local (SQL Server). Com isso decidimos a melhor forma de
> automatizar o fluxo **Hiper → plataforma Franzoni**, sem mais "arrastar PDF".
>
> **Como usar:** abra o Claude Code **na máquina do cliente** (a que tem o Hiper)
> e cole as tarefas abaixo, uma de cada vez. Você não precisa saber programar —
> o Claude executa e te explica o que achou.

---

## ⚠️ Antes de começar — segurança

- **Não vamos alterar nada** no Hiper. Tudo aqui é só **leitura/consulta**.
- Se em algum passo o Claude sugerir *escrever, apagar ou alterar* algo no banco
  do Hiper: **PARE e me chame.** Nesta fase é só olhar.
- Ideal rodar com o Hiper **fechado** durante a inspeção do banco (evita travar arquivos).

---

## Tarefa 1 — Descobrir se o add-on "Loja Virtual" está contratado

Isso decide se a **API oficial do Hiper** está disponível pra gente.

**Você mesmo verifica dentro do Hiper Gestão:**
1. Abra o Hiper Gestão.
2. Vá em **Vendas → Loja Virtual → Configurações** (ou procure por "Loja de Aplicativos").
3. Anote:
   - Existe uma opção/menu **"Loja Virtual"** ou **"Pacote do Varejo Digital"**? Está **ativo**?
   - Aparece em algum lugar uma **"chave de segurança"** (um texto longo, ~64 caracteres)?

➡️ **Se aparecer a chave de segurança:** ótimo — a API oficial está liberada (Opção C vira possível).
➡️ **Se não aparecer nada disso:** sem problema — seguimos pelo PDF/banco local.

> **Não copie/cole a chave aqui no chat.** Só me diga **"tem chave"** ou **"não tem"**.

---

## Tarefa 2 — Achar onde o Hiper gera/salva o PDF do pedido

**Cole no Claude da sua máquina:**

```
Estou numa máquina Windows com o ERP "Hiper" instalado em C:\Hiper.
Quando faço um "Pedido de Venda" e mando imprimir/gerar PDF, o sistema cria
um arquivo PDF (ex: documento L4077). Preciso descobrir ONDE esse PDF é salvo
e se há uma pasta fixa de saída.

Por favor:
1. Liste o conteúdo de C:\Hiper e subpastas que tenham "pdf", "temp", "report",
   "impress", "documento" ou "venda" no nome.
2. Procure no disco por arquivos .pdf modificados recentemente
   (ex: criados nas últimas horas), priorizando pastas do Hiper, Documentos,
   Downloads e %TEMP%.
3. Me diga o caminho mais provável onde o PDF do pedido aparece quando é gerado.
Só leitura — não crie nem apague nada.
```

**Teste prático junto:** gere um pedido de venda de teste no Hiper, mande
imprimir/salvar PDF, e veja em qual pasta ele caiu. Anote o caminho.

➡️ **Resultado que eu preciso:** o **caminho da pasta** onde o PDF aparece
(ex: `C:\Hiper\Relatorios\` ou `C:\Users\...\Documents\`).

---

## Tarefa 3 — Inspecionar o banco local (SQL Server)

**Cole no Claude da sua máquina:**

```
O Hiper usa Microsoft SQL Server local (instância chamada "Hiper", ou
"(LocalDb)\MSSQLLocalDB"). Quero apenas INSPECIONAR (somente leitura) o banco
para entender como os pedidos de venda são armazenados.

Por favor:
1. Detecte as instâncias de SQL Server instaladas nesta máquina
   (ex: via "sqllocaldb info", serviços do Windows, ou registro).
2. Conecte na instância do Hiper (tente autenticação do Windows primeiro).
3. Liste os bancos de dados disponíveis e identifique o do Hiper.
4. Liste as tabelas cujo nome contenha: venda, pedido, item, cliente, produto,
   pagamento, parcela.
5. Para as tabelas de "pedido de venda" e seus "itens", mostre as COLUNAS
   (nome e tipo) e 1 a 2 linhas de exemplo do pedido de teste que acabei de criar
   (procure pelo número do documento, ex: L4077).
NÃO altere, insira nem apague nada. Apenas SELECT / leitura de schema.
```

➡️ **Resultado que eu preciso:**
- Nome do **banco** e da **instância**.
- Nomes das **tabelas** de pedido de venda + itens + cliente.
- As **colunas** dessas tabelas (pra eu mapear com o parser atual).
- Confirmar que dá pra **ler** o pedido recém-criado (ex: L4077).

---

## O que fazer com os resultados

Me traga, de volta nesta conversa (ou numa nova), as **3 respostas**:
1. Tem chave de segurança? (sim/não)
2. Caminho da pasta do PDF.
3. Nome do banco/instância + tabelas e colunas de pedido de venda.

Com isso eu fecho a decisão:
- **Opção A** (capturar PDF automático e mandar pro `/api/parse-pdf` existente), e/ou
- **Opção B** (ler o banco local direto), e/ou
- **Opção C** (API oficial, se houver chave).

E aí partimos pra implementação de verdade.
