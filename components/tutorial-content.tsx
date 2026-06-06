import Link from 'next/link';
import {
  Upload,
  ListChecks,
  Send,
  Bell,
  Ban,
  Inbox,
  Play,
  Truck,
  Printer,
  CheckCircle2,
  PackageCheck,
  MapPin,
  LayoutDashboard,
  Users,
  History,
  Lightbulb,
  HelpCircle,
  KeyRound,
  Layers,
  Filter,
  ArrowUpDown,
  Moon,
  Smartphone,
  RefreshCw,
  AlertTriangle,
  Copy,
  MessageCircle,
  BarChart3,
  Download,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { ContentCard } from '@/components/layout/content-card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { UserRole } from '@/lib/types';

type Step = {
  icon: LucideIcon;
  title: string;
  body: string;
  cta?: { label: string; href: string };
  tip?: string;
};

// ============================================================================
// FLUXO PRINCIPAL — passos numerados por role
// ============================================================================

const STEPS_BY_ROLE: Record<UserRole, Step[]> = {
  vendedor: [
    {
      icon: Upload,
      title: 'Importe o PDF do pedido',
      body:
        'Em "Novo Pedido", arraste um ou vários PDFs gerados pelo ERP. O sistema extrai os dados automaticamente — cliente, endereço, itens, valores. Você pode soltar vários ao mesmo tempo: o lote processa em paralelo (até 4 simultâneos).',
      cta: { label: 'Abrir Novo Pedido', href: '/vendas/novo' },
      tip: 'Se o mesmo pedido (mesmo documento ERP) for enviado duas vezes, o sistema detecta e abre o existente em vez de duplicar.',
    },
    {
      icon: ListChecks,
      title: 'Revise os dados extraídos',
      body:
        'Confira cliente, endereço, bairro, itens e total. Tudo é editável caso o parser não tenha pego algum campo (ex.: PDFs com layout estranho). O bairro fica destacado em laranja porque é a chave da rota da logística.',
      tip: 'Se preferir, salve como "Rascunho" pra finalizar depois — fica visível só pra você até virar Pendente.',
    },
    {
      icon: MapPin,
      title: 'Endereços do cliente lembrados',
      body:
        'Se o cliente tem CNPJ/CPF preenchido e já apareceu em pedidos anteriores, o sistema mostra um seletor "Endereço de entrega" com os endereços cadastrados (Sede, Obra 1, Depósito…). Se o endereço do PDF bate com algum, ele vem pré-selecionado. Senão, fica em "Outro endereço" e você pode clicar em "Salvar como novo endereço deste cliente" pra reusar nos próximos pedidos.',
      tip: 'Sem CNPJ/CPF o seletor não aparece — preencha o documento pra ativar o histórico de endereços do cliente.',
    },
    {
      icon: CheckCircle2,
      title: 'Checkbox "Receber na entrega"',
      body:
        'Na seção Pagamento, o checkbox "Receber na entrega" marca que o valor é recebido na entrega (ex.: o motorista cobra). Vem desmarcado — marque quando for o caso. É INDEPENDENTE da forma de pagamento: você pode marcar "Receber na entrega" e ainda escolher a forma (ex.: receber na entrega em Dinheiro). No mapa impresso aparece em destaque pra logística.',
    },
    {
      icon: Send,
      title: 'Envie para a logística',
      body:
        'Clique em "Enviar para Logística". O pedido vira pendente e aparece na fila da equipe de entrega em tempo real — sem precisar avisar manualmente.',
    },
    {
      icon: Bell,
      title: 'Acompanhe o status',
      body:
        'Em "Meus Pedidos" você vê todos os seus pedidos com filtros (período, status, busca livre). Quando a logística inicia separação ou finaliza, a mudança chega ao vivo via realtime — sem precisar atualizar a página.',
      cta: { label: 'Ver meus pedidos', href: '/vendas' },
    },
    {
      icon: Ban,
      title: 'Cancele quando precisar',
      body:
        'Enquanto o pedido está em rascunho ou pendente, você pode cancelar pela tela de detalhe. Depois que entra em separação, só o admin cancela (regra de processo — a logística já está movimentando estoque).',
    },
  ],

  financeiro: [
    {
      icon: Inbox,
      title: 'Os pedidos chegam do vendedor',
      body:
        'Em "Financeiro", aparecem os pedidos que o vendedor enviou para conferência. Cada um vem com cliente, itens e o que o ERP/vendedor preencheu de pagamento e frete.',
      cta: { label: 'Abrir Financeiro', href: '/financeiro' },
    },
    {
      icon: ListChecks,
      title: 'Confira pagamento e frete',
      body:
        'Revise e ajuste a forma de pagamento, parcelas, "receber na entrega" e o valor do frete. É aqui que as informações são compiladas antes de seguir para a logística.',
      tip: 'Quando o pedido vem do Hiper, o valor do frete já chega preenchido — confira e corrija se necessário.',
    },
    {
      icon: Send,
      title: 'Libere para a logística',
      body:
        'Com tudo conferido, clique em "Liberar para logística". O pedido sai da sua fila e entra como Pendente na logística para separação.',
    },
  ],

  logistica: [
    {
      icon: Inbox,
      title: 'A fila chega ordenada por bairro',
      body:
        'Em "Fila", os pedidos pendentes aparecem agrupados por bairro e data de entrega — o mais urgente primeiro. As tabs no topo (Pendentes / Em separação / Finalizados) trocam o conjunto exibido.',
      cta: { label: 'Ver fila', href: '/logistica' },
      tip: 'Clique no cabeçalho de qualquer coluna pra reordenar (Cliente alfabético, Valor maior primeiro, etc.). Use os atalhos Hoje/Semana/Mês ou o range De/Até pra filtrar por data de entrega.',
    },
    {
      icon: Play,
      title: 'Inicie a separação',
      body:
        'Clique numa linha da fila pra abrir o pedido. Lá dentro, clique em "Iniciar Separação". Isso muda o status pra "em_separacao" — o vendedor recebe esse status ao vivo, e o pedido sai dos Pendentes pra aba "Em separação".',
      tip: 'Mesmo durante a separação, dá pra ajustar dados do pedido. Se o vendedor errou um campo, avise ele pra editar — você não tem permissão de editar dados de venda, só dados de logística.',
    },
    {
      icon: Truck,
      title: 'Preencha os dados da carga',
      body:
        'No card "Dados de Logística": pré-carga, motorista, veículo, km inicial/final, região, peso bruto/líquido, conferente e observações. Salve a qualquer momento (botão "Salvar" no rodapé do card) — fica em "Em separação" até você finalizar.',
    },
    {
      icon: Printer,
      title: 'Imprima o Pedido',
      body:
        'Botão "Imprimir Pedido" abre uma versão A4 pronta numa nova aba, com cliente, endereço, itens, totais, pesos e linha de assinatura do conferente. O navegador chama o diálogo de impressão automaticamente.',
      tip: 'Pra economizar tinta, configure o Chrome em "Mais configurações → Cor → Preto e branco" antes de imprimir.',
    },
    {
      icon: PackageCheck,
      title: 'Entrega parcial — quando faltou produto',
      body:
        'Se entregou só uma parte (ex.: 7t de 10t de areia), abra o pedido e clique em "Registrar Entrega". Preencha quanto saiu de cada item — o restante fica pendente. O pedido vai pra aba "Parcialmente" e, ali na própria linha da fila, aparece sob o nome do cliente um resumo dos itens pendentes (ex.: "Areia média 6/10 TN · falta 4 TN") — dá pra saber o que falta sem abrir o pedido. Quando o restante for entregue, faça outro "Registrar Entrega" ou "Marcar como Finalizado".',
      tip: 'Cada "Registrar Entrega" SOMA na quantidade já entregue — não substitui. Use "Preencher tudo" pra completar o restante de uma vez.',
    },
    {
      icon: CheckCircle2,
      title: 'Finalize ao entregar tudo',
      body:
        'Quando entregou 100% dos itens, clique em "Marcar como Finalizado". Ele sai da fila ativa, vai pra aba "Finalizados" e entra nos KPIs do histórico (valor faturado, clientes únicos). Na fila, dá pra finalizar direto pelo ícone ✓ na linha — sem precisar abrir o pedido.',
      cta: { label: 'Ver histórico', href: '/historico' },
    },
  ],

  admin: [
    {
      icon: LayoutDashboard,
      title: 'Dashboard com gráficos e KPIs',
      body:
        'Em "Dashboard" você vê contagens por status, tempo médio até finalizado, e 3 gráficos: pedidos por dia (últimos 30 dias), top 10 clientes por valor faturado e top 10 bairros por quantidade de entregas. Atalhos pras áreas principais ficam no fim.',
      cta: { label: 'Abrir Dashboard', href: '/admin' },
    },
    {
      icon: ListChecks,
      title: 'Veja todos os pedidos',
      body:
        'Em "Pedidos" você vê todos da empresa, não só os seus. Use os filtros (período / status / busca) e a ordenação por coluna pra investigar. Pode entrar em qualquer pedido pra ver detalhe completo.',
      cta: { label: 'Pedidos', href: '/vendas' },
    },
    {
      icon: Truck,
      title: 'Acompanhe a logística',
      body:
        'Em "Logística" você vê a mesma fila que a equipe de entrega vê. Útil pra resolver dúvidas, alterar dados de carga ou destravar pedidos parados. Admin pode cancelar pedidos em qualquer status (vendedor só em rascunho/pendente).',
      cta: { label: 'Fila', href: '/logistica' },
    },
    {
      icon: UsersRound,
      title: 'Cadastro de clientes + endereços',
      body:
        'Em "Clientes" você vê todos os clientes que apareceram em pedidos — o sistema cria automaticamente no upload do PDF (chave: CNPJ/CPF). Edite nomes, mescle duplicados, ou cadastre múltiplos endereços de entrega (Sede, Obra 1, Depósito…) com um marcado como padrão. Os vendedores enxergam esses endereços ao montar novos pedidos.',
      cta: { label: 'Clientes', href: '/admin/clientes' },
      tip: 'Quando vendedor sobe PDF, o sistema busca por CNPJ. Se existe, reutiliza; se não, cria. Nome do cadastro não é sobrescrito automaticamente — você edita aqui se quiser padronizar.',
    },
    {
      icon: Users,
      title: 'Gerencie a equipe e os cargos',
      body:
        'Em "Equipe" você vê todos os colaboradores, adiciona novos (nome, e-mail, senha, cargo), desativa quem saiu (reversível, sem apagar histórico) e muda o cargo de cada um (admin / vendedor / logística). Você não pode rebaixar nem desativar a si mesmo — guardrail pra evitar lockout do admin.',
      cta: { label: 'Equipe', href: '/admin/usuarios' },
      tip: 'A gestão da equipe é feita no Exped na nuvem; as mudanças descem automaticamente pro app local (hub).',
    },
    {
      icon: History,
      title: 'Histórico + exportar CSV',
      body:
        'Em "Histórico" você vê todos finalizados + 3 KPIs (total, valor faturado, clientes únicos). Filtre por período e clique em "Exportar CSV" pra baixar planilha completa com dados de pedido + logística — pronta pro contábil/financeiro.',
      cta: { label: 'Histórico', href: '/historico' },
    },
  ],
};

// ============================================================================
// COMO COMEÇAR — comum a todos os roles
// ============================================================================

const GETTING_STARTED: Step[] = [
  {
    icon: KeyRound,
    title: 'Login',
    body:
      'Acesse pela URL da empresa com seu e-mail e senha. Se esqueceu a senha, fale com um admin — a recuperação automática por e-mail não está habilitada (o sistema é interno, sem caixa postal externa).',
    tip: 'Marque o site nos favoritos do navegador. A sessão fica salva por algumas semanas, então no dia a dia você não precisa logar de novo.',
  },
  {
    icon: Layers,
    title: 'Sidebar e navegação',
    body:
      'A barra lateral à esquerda mostra só os menus do seu setor. Cada seção (Operação / Consulta / Ajuda) agrupa funcionalidades relacionadas. Quem é admin enxerga uma seção "Admin" extra.',
  },
  {
    icon: Moon,
    title: 'Tema claro ou escuro',
    body:
      'Ícone de sol/lua no rodapé da sidebar (ao lado do botão Sair). Muda só pra você, não afeta os outros usuários. Útil em galpões com pouca luz ou pra economizar bateria do celular.',
  },
  {
    icon: Smartphone,
    title: 'Funciona no celular',
    body:
      'A plataforma é responsiva — em telas pequenas, a sidebar vira um menu hambúrguer no topo, e as listagens viram cards verticais em vez de tabela horizontal. Pode usar tablet, celular ou desktop, todos com mesmo login.',
  },
  {
    icon: RefreshCw,
    title: 'Atualização em tempo real',
    body:
      'Quando alguém cria, edita ou muda status de um pedido, sua tela é avisada na hora. Não precisa apertar F5. Isso vale entre setores: vendedor vê em tempo real quando a logística pega o pedido dele, e vice-versa.',
  },
];

// ============================================================================
// RECURSOS AVANÇADOS — comum a todos
// ============================================================================

const ADVANCED_FEATURES: Step[] = [
  {
    icon: MessageCircle,
    title: 'Comentários no pedido',
    body:
      'Em cada detalhe de pedido tem um card "Comentários" com thread vendedor↔logística. Substitui WhatsApp paralelo. Mensagem chega em tempo real pra quem estiver com a tela aberta. Ctrl+Enter envia rápido.',
    tip: 'Bom pra: "produto X em falta, pode substituir?", "cliente pediu pra entregar amanhã em vez de hoje", "logística não consegue contato com o destinatário".',
  },
  {
    icon: Upload,
    title: 'Upload de vários PDFs em lote',
    body:
      'Em "Novo Pedido", você pode arrastar 2 ou mais PDFs ao mesmo tempo. O sistema processa em paralelo, checa duplicados e salva todos como rascunho. No fim aparece um resumo com KPIs (Criados / Duplicados / Erros) e link pra cada pedido.',
    tip: 'Ideal pro vendedor que junta os PDFs do dia inteiro e sobe tudo de uma vez no fim do expediente.',
  },
  {
    icon: Copy,
    title: 'Detecção automática de duplicado',
    body:
      'Se você subir o mesmo PDF (mesmo "Documento ERP" — ex.: L4077) duas vezes, o sistema detecta e abre o existente em vez de criar duplicata. Garantia: índice único parcial no banco (status<>cancelado), então pedidos cancelados podem ser re-importados se precisar.',
  },
  {
    icon: ArrowUpDown,
    title: 'Ordenação por coluna',
    body:
      'Nas listagens, clique no cabeçalho de qualquer coluna pra ordenar. Click de novo inverte a direção. Funciona em Nº, Cliente, Bairro, Entrega e Valor. O ícone de seta indica a direção atual.',
  },
  {
    icon: Filter,
    title: 'Filtros de data',
    body:
      'Acima da tabela tem atalhos rápidos (Todos / Hoje / Semana / Mês) e um range personalizado (De [data] até [data]). Tudo aplicado sobre "data de entrega". Combina com filtro de status e busca livre.',
  },
  {
    icon: BarChart3,
    title: 'Dashboard analítico (admin)',
    body:
      'Admins veem gráficos no dashboard: pedidos por dia (últimos 30), top clientes por valor faturado, top bairros por volume e tempo médio até finalizado.',
  },
  {
    icon: Download,
    title: 'Exportar histórico em CSV (admin)',
    body:
      'Botão "Exportar CSV" no /histórico baixa planilha completa (cliente, valor, motorista, veículo, conferente, kms, pesos, etc.) pronta pro Excel. BOM UTF-8 incluído então acentos aparecem certo.',
  },
];

// ============================================================================
// FAQ — comum a todos
// ============================================================================

type FAQ = { q: string; a: React.ReactNode };

const FAQS: FAQ[] = [
  {
    q: 'O PDF subiu mas vários campos vieram em branco / errados',
    a: (
      <>
        O parser foi calibrado pro layout do ERP padrão da Franzoni. Layouts diferentes podem ter
        campos não-reconhecidos. <strong>Solução:</strong> na tela de revisão, edite os campos
        faltantes manualmente antes de enviar pra logística. O texto extraído fica salvo de
        qualquer forma, então mesmo se a UI tiver problema o dado original do PDF está
        preservado no Storage.
      </>
    ),
  },
  {
    q: 'Tentei subir um pedido e apareceu mensagem "já existe pedido com este documento"',
    a: (
      <>
        Significa que esse <strong>Documento ERP</strong> já foi importado antes e ainda não foi
        cancelado. O sistema te leva direto pro pedido existente. Se foi engano, ignore; se for
        re-emissão de um pedido cancelado, peça pro admin reativar (ou re-importe depois de
        cancelar o duplicado).
      </>
    ),
  },
  {
    q: 'Posso cancelar um pedido depois que a logística começou a separar?',
    a: (
      <>
        Vendedor só cancela em <strong>rascunho</strong> ou <strong>pendente</strong>. Depois que
        entra em <strong>em separação</strong>, só admin cancela. É proteção pra evitar
        re-trabalho da equipe de entrega que já tirou o produto do estoque.
      </>
    ),
  },
  {
    q: 'O número do mapa pulou — vi #5 depois #7, cadê o #6?',
    a: (
      <>
        Provavelmente o #6 foi um pedido que falhou ao salvar e nunca chegou no banco — o número
        já tinha sido reservado pela sequence do Postgres. Não há perda de dados; é só uma
        descontinuidade na numeração. Acontece raramente.
      </>
    ),
  },
  {
    q: 'A impressão do mapa saiu cortada / muito grande',
    a: (
      <>
        No diálogo de impressão do Chrome, verifique: <strong>Tamanho do papel = A4</strong> e{' '}
        <strong>Escala = 100%</strong> (não "Ajustar à página"). Margens podem ficar em "Padrão"
        ou "Mínimas". A view de impressão (<code className="text-xs">/imprimir/[id]</code>) já
        vem com layout A4 otimizado.
      </>
    ),
  },
];

// ============================================================================
// GLOSSÁRIO — comum a todos, agora mais completo
// ============================================================================

type GlossaryEntry = { term: string; def: React.ReactNode };

const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Pedido (impressão)',
    def: (
      <>
        Documento que a logística imprime e leva pra entrega. Tem cliente, endereço, itens da
        loja/depósito, totais, peso e linha de assinatura do conferente.
      </>
    ),
  },
  {
    term: 'Documento ERP',
    def: (
      <>
        Número do pedido como o ERP emitiu (ex.: <code className="text-xs">L4077</code>). Único
        no sistema — duplicado é detectado e bloqueado.
      </>
    ),
  },
  {
    term: 'Número do Pedido',
    def: (
      <>
        Identificador interno do sistema (ex.: <code className="text-xs">#42</code>),
        sequencial. Diferente do Documento ERP. Aparece em todas as listagens e na impressão.
      </>
    ),
  },
  {
    term: 'Ponto de Retirada',
    def: (
      <>
        Onde os produtos saem fisicamente — pode ser <strong>Loja</strong> ou{' '}
        <strong>Depósito</strong>. Um pedido pode ter dois pontos (ex.: parte da loja, parte do
        depósito).
      </>
    ),
  },
  {
    term: 'Rascunho vs Pendente',
    def: (
      <>
        <strong>Rascunho</strong> = só o próprio vendedor vê, ainda não foi pra logística.{' '}
        <strong>Pendente</strong> = na fila aguardando separação. O vendedor decide quando promover.
      </>
    ),
  },
  {
    term: 'Em separação',
    def: (
      <>
        Logística começou a separar fisicamente os produtos. Vendedor não pode mais editar o
        pedido, só ver status e cancelar via admin.
      </>
    ),
  },
  {
    term: 'Parcialmente entregue',
    def: (
      <>
        Logística entregou parte dos itens, mas restou quantidade. Aparece em aba própria
        em <strong>/logistica</strong>; no detalhe do pedido todos veem por item quanto foi
        entregue e quanto falta. Continua aberto até "Marcar como Finalizado".
      </>
    ),
  },
  {
    term: 'Pré-carga',
    def: <>Identificação interna da carga (ex.: lote do dia, código de roteiro).</>,
  },
  {
    term: 'Conferente',
    def: (
      <>
        Pessoa responsável por conferir fisicamente o conteúdo da carga antes da saída. Nome
        impresso no mapa, com linha pra assinar.
      </>
    ),
  },
  {
    term: 'Bairro destacado',
    def: (
      <>
        A logística ordena os pedidos por bairro pra otimizar deslocamento. Por isso o bairro
        aparece em pill colorida nas listagens e é destacado na revisão — sempre confira esse
        campo antes de enviar.
      </>
    ),
  },
  {
    term: 'Endereço cadastrado vs livre',
    def: (
      <>
        Cliente com CNPJ ou CPF pode ter vários <strong>endereços cadastrados</strong>{' '}
        (Sede, Obra 1, Depósito) gerenciados em /admin/clientes. No formulário do pedido, o
        vendedor escolhe um do seletor (auto-pré-seleciona se bater com o do PDF) ou usa
        "Outro endereço" pra digitar livre e opcionalmente salvar como novo. O Pedido
        impresso sempre mostra o endereço daquele pedido (snapshot), mesmo que o cadastro
        do cliente mude depois.
      </>
    ),
  },
  {
    term: 'Forma de Pagamento',
    def: (
      <>
        O método (Crédito, Pix, Débito, Dinheiro, Boleto). Parcelas só no Crédito/Boleto. É
        separado do "Receber na entrega" (que diz se o valor é cobrado na entrega). Aparece no
        pedido impresso pra logística.
      </>
    ),
  },
];

const ROLE_HEADERS: Record<UserRole, { title: string; sub: string }> = {
  vendedor: {
    title: 'Como funciona — Vendas',
    sub:
      'Fluxo do vendedor: do PDF emitido pelo ERP até o pedido entregue. Tudo em tempo real.',
  },
  financeiro: {
    title: 'Como funciona — Financeiro',
    sub:
      'Fluxo do financeiro: conferir pagamento e frete dos pedidos do vendedor e liberar para a logística.',
  },
  logistica: {
    title: 'Como funciona — Logística',
    sub:
      'Fluxo da equipe de entrega: da fila à entrega, com mapa impresso e dados de carga.',
  },
  admin: {
    title: 'Como funciona — Admin',
    sub:
      'Visão completa do sistema: pedidos, logística, usuários e histórico em um único lugar.',
  },
};

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export function TutorialContent({ role }: { role: UserRole }) {
  const steps = STEPS_BY_ROLE[role];
  const header = ROLE_HEADERS[role];

  return (
    <div className="max-w-4xl mx-auto w-full space-y-8">
      {/* Hero */}
      <ContentCard className="p-6!">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-brand/15 flex items-center justify-center shrink-0">
            <Lightbulb className="h-6 w-6 text-brand" />
          </div>
          <div>
            <h2 className="font-heading text-xl font-bold text-franzoni-navy dark:text-white">
              {header.title}
            </h2>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{header.sub}</p>
          </div>
        </div>
      </ContentCard>

      {/* Seção: Como começar */}
      <Section title="Como começar" subtitle="Primeiros passos pra qualquer perfil">
        <StepList steps={GETTING_STARTED} />
      </Section>

      {/* Seção: Fluxo principal */}
      <Section
        title={`Seu fluxo diário (${roleLabel(role)})`}
        subtitle="As 5 etapas do trabalho de quem é seu setor"
      >
        <StepList steps={steps} />
      </Section>

      {/* Seção: Recursos avançados */}
      <Section title="Recursos avançados" subtitle="Pra extrair mais da plataforma">
        <StepList steps={ADVANCED_FEATURES} numbered={false} />
      </Section>

      {/* FAQ */}
      <ContentCard className="p-5!">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-brand" />
          <h3 className="font-heading font-semibold text-base">Dúvidas frequentes</h3>
        </div>
        <dl className="divide-y divide-border/40">
          {FAQS.map((faq, i) => (
            <div key={i} className="py-3 first:pt-0 last:pb-0">
              <dt className="font-semibold text-sm text-foreground mb-1.5">{faq.q}</dt>
              <dd className="text-sm text-muted-foreground leading-relaxed">{faq.a}</dd>
            </div>
          ))}
        </dl>
      </ContentCard>

      {/* Glossário */}
      <ContentCard className="p-5!">
        <div className="flex items-center gap-2 mb-3">
          <HelpCircle className="h-4 w-4 text-brand" />
          <h3 className="font-heading font-semibold text-base">Glossário</h3>
        </div>
        <dl className="space-y-3 text-sm">
          {GLOSSARY.map((g, i) => (
            <div key={i} className="flex flex-col sm:flex-row gap-1 sm:gap-3">
              <dt className="font-semibold text-foreground sm:w-44 shrink-0">{g.term}</dt>
              <dd className="text-muted-foreground leading-relaxed">{g.def}</dd>
            </div>
          ))}
        </dl>
      </ContentCard>
    </div>
  );
}

// ============================================================================
// SUBCOMPONENTES
// ============================================================================

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="font-heading text-lg font-bold text-franzoni-navy dark:text-white">
          {title}
        </h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function StepList({ steps, numbered = true }: { steps: Step[]; numbered?: boolean }) {
  return (
    <ol className="space-y-4">
      {steps.map((step, i) => {
        const Icon = step.icon;
        return (
          <li key={i}>
            <ContentCard className="p-5!">
              <div className="flex gap-4">
                <div className="flex flex-col items-center shrink-0">
                  {numbered ? (
                    <div className="h-9 w-9 rounded-full bg-brand text-white flex items-center justify-center font-heading font-bold text-sm shadow-sm shadow-brand/40">
                      {i + 1}
                    </div>
                  ) : (
                    <div className="h-9 w-9 rounded-full bg-franzoni-navy/10 dark:bg-white/10 flex items-center justify-center">
                      <Icon className="h-4 w-4 text-franzoni-navy dark:text-franzoni-navy-100" />
                    </div>
                  )}
                  {i < steps.length - 1 && (
                    <div className="w-px flex-1 mt-2 bg-border/60" />
                  )}
                </div>
                <div className="flex-1 min-w-0 pb-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    {numbered && (
                      <Icon className="h-4 w-4 text-franzoni-navy dark:text-franzoni-navy-100 shrink-0" />
                    )}
                    <h3 className="font-heading font-semibold text-base text-foreground">
                      {step.title}
                    </h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
                  {step.tip && (
                    <p className="mt-3 text-xs px-3 py-2 rounded-md bg-franzoni-navy/5 dark:bg-white/5 border-l-2 border-franzoni-navy/40 text-foreground/80">
                      <span className="font-semibold text-franzoni-navy dark:text-franzoni-navy-100">
                        Dica:
                      </span>{' '}
                      {step.tip}
                    </p>
                  )}
                  {step.cta && (
                    <Link
                      href={step.cta.href}
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'sm' }),
                        'mt-3 text-xs',
                      )}
                    >
                      {step.cta.label} →
                    </Link>
                  )}
                </div>
              </div>
            </ContentCard>
          </li>
        );
      })}
    </ol>
  );
}

function roleLabel(role: UserRole): string {
  return role === 'admin' ? 'Admin' : role === 'logistica' ? 'Logística' : 'Vendedor';
}
