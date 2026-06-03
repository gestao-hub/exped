import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AppLogo } from '@/components/app-logo';
import { StatusBadge } from '@/components/status-badge';
import { rotuloFormaPagamento } from '@/lib/parser/forma-pagamento';
import { rotuloEntrega } from '@/lib/pedidos/entrega';
import type {
  Pedido,
  PedidoLogistica,
  PontoRetirada,
  PedidoItem,
} from '@/lib/types';

const ROTULO_PONTO: Record<string, string> = {
  loja: 'Loja',
  deposito: 'Depósito',
  entrega: 'Entrega',
};

export type PontoComItens = PontoRetirada & { itens: PedidoItem[] };

export function MapaCarregamento({
  pedido,
  pontos,
  logistica,
  vendedor,
  logoUrlPrint,
  mode = 'leitura',
}: {
  pedido: Pedido;
  pontos: PontoComItens[];
  logistica?: PedidoLogistica | null;
  vendedor?: { full_name: string | null; email: string | null } | null;
  logoUrlPrint?: string | null;
  mode?: 'leitura' | 'impressao';
}) {
  const fmtDate = (d: string | null) =>
    d ? format(new Date(`${d}T12:00:00`), 'dd/MM/yyyy', { locale: ptBR }) : '—';
  const fmtMoney = (n: number | null) =>
    Number(n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const isPrint = mode === 'impressao';

  // totalizadores
  const allItens: PedidoItem[] = pontos.flatMap((p) => p.itens);
  const pesoBruto =
    logistica?.peso_bruto_total != null
      ? Number(logistica.peso_bruto_total)
      : allItens.reduce((s: number, i: PedidoItem) => s + (Number(i.peso_bruto) || 0), 0);
  const pesoLiquido =
    logistica?.peso_liquido_total != null
      ? Number(logistica.peso_liquido_total)
      : allItens.reduce((s: number, i: PedidoItem) => s + (Number(i.peso_liquido) || 0), 0);

  // valor_total vem do Hiper como SOMA DOS ITENS (sem frete); valor_frete é separado.
  // O total que o cliente paga é itens + frete — exibido como "Total" em destaque.
  const subtotalItens = Number(pedido.valor_total) || 0;
  const valorFrete = Number(pedido.valor_frete) || 0;
  const totalComFrete = subtotalItens + valorFrete;
  const temFrete = valorFrete > 0;

  // Corpo do documento como função reutilizável: na impressão geramos 2 vias
  // idênticas na mesma folha (Loja em cima, Cliente embaixo, recorte no meio).
  const via = (viaLabel: string | null) => (
    <div
      className={
        isPrint
          ? 'bg-white text-black'
          : 'bg-white text-foreground border rounded-lg overflow-hidden'
      }
    >
      {/* Header */}
      <header className="border-b border-black/20 px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {logoUrlPrint ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrlPrint} alt="" className="h-11 w-auto object-contain" />
          ) : (
            <AppLogo variant="dark" size={44} />
          )}
          {viaLabel && (
            <span className="text-[8px] font-bold uppercase tracking-widest text-franzoni-navy border border-black/25 rounded px-1.5 py-0.5 leading-none">
              {viaLabel}
            </span>
          )}
        </div>
        <div className="text-right">
          <h1 className="text-base font-bold tracking-tight">Pedido</h1>
          <p className="text-xs text-muted-foreground">
            Nº <span className="font-mono font-semibold">#{pedido.numero_mapa}</span>
            {pedido.documento_erp && (
              <>
                {' '}· ERP <span className="font-mono">{pedido.documento_erp}</span>
              </>
            )}
          </p>
          <p className="mt-0.5 text-sm font-bold uppercase tracking-wide text-franzoni-navy">
            Entregar:{' '}
            <span className="text-brand-700">
              {rotuloEntrega(pedido.data_entrega, pedido.data_entrega_inicio, new Date())}
            </span>
          </p>
          {!isPrint && <div className="mt-2"><StatusBadge status={pedido.status} /></div>}
        </div>
      </header>

      {/* Cliente + Endereço lado a lado — economiza ~1/3 da altura na impressão.
          A data de entrega não se repete aqui (já está em destaque no cabeçalho). */}
      <div className="flex border-b border-black/15 print-avoid-break">
        <div className="flex-1 px-4 py-2 border-r border-black/15">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-franzoni-navy mb-1">Cliente</h3>
          <Grid cols={2}>
            <KV label="Nome"     value={pedido.cliente_nome} className="col-span-2 font-semibold" />
            <KV label="CNPJ/CPF" value={pedido.cliente_cnpj_cpf} />
            <KV label="Código"   value={pedido.cliente_codigo} />
            <KV label="Emissão"  value={fmtDate(pedido.data_emissao)} />
            <KV label="Vendedor" value={vendedor?.full_name || vendedor?.email || '—'} />
          </Grid>
        </div>
        <div className="flex-1 px-4 py-2">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-franzoni-navy mb-1">Endereço de Entrega</h3>
          <Grid cols={2}>
            <KV label="Endereço" value={pedido.cliente_endereco} className="col-span-2" />
            <KV
              label="Bairro"
              value={pedido.cliente_bairro}
              className="[&_.kv-value]:font-semibold [&_.kv-value]:text-brand-700"
            />
            <KV
              label="Cidade/UF"
              value={[pedido.cliente_cidade, pedido.cliente_uf].filter(Boolean).join(' / ') || '—'}
            />
            <KV label="CEP" value={pedido.cliente_cep} />
            <KV label="Tel" value={pedido.cliente_telefone} />
            <KV
              label="Pagamento"
              value={
                pedido.receber_na_entrega
                  ? `A RECEBER NA ENTREGA${pedido.forma_pagamento ? ` · ${rotuloFormaPagamento(pedido.forma_pagamento, pedido.parcelas)}` : ''}`
                  : rotuloFormaPagamento(pedido.forma_pagamento, pedido.parcelas)
              }
              className={`col-span-2 [&_.kv-value]:font-semibold ${pedido.receber_na_entrega ? '[&_.kv-value]:text-brand-700' : ''}`}
            />
          </Grid>
        </div>
      </div>

      {/* Pontos de Retirada */}
      {pontos.map((ponto, idx) => (
        <Section
          key={ponto.id}
          title={`${ROTULO_PONTO[ponto.tipo] ?? 'Loja'} ${pontos.length > 1 ? `· ${idx + 1}/${pontos.length}` : ''}`}
          headerExtra={ponto.empresa_nome}
          className={isPrint && idx > 0 ? 'print-break-before' : ''}
        >
          {ponto.tipo === 'entrega' ? (
            <p className="text-xs mb-2">
              <span className="font-semibold uppercase tracking-wider text-brand-700">Enviar para:</span>{' '}
              {ponto.endereco || pedido.cliente_endereco || '—'}
            </p>
          ) : (
            ponto.endereco && (
              <p className="text-xs text-muted-foreground mb-2">{ponto.endereco}</p>
            )
          )}
          {ponto.itens.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">Sem itens.</p>
          ) : (
            <table className="w-full text-[10px] border-collapse table-fixed">
              <colgroup>
                <col style={{ width: '60px' }} />
                <col />
                <col style={{ width: '46px' }} />
                <col style={{ width: '38px' }} />
                <col style={{ width: '58px' }} />
                <col style={{ width: '58px' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: '70px' }} />
              </colgroup>
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-1.5 py-0.5 border">Código</th>
                  <th className="px-1.5 py-0.5 border">Descrição</th>
                  <th className="px-1.5 py-0.5 border text-right">Qtd</th>
                  <th className="px-1.5 py-0.5 border">Un</th>
                  <th className="px-1.5 py-0.5 border text-right">Entreg.</th>
                  <th className="px-1.5 py-0.5 border text-right">Restante</th>
                  <th className="px-1.5 py-0.5 border text-right">Unitário</th>
                  <th className="px-1.5 py-0.5 border text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {ponto.itens.map((it: PedidoItem) => {
                  const qt = Number(it.quantidade);
                  const qe = Number(
                    (it as PedidoItem & { quantidade_entregue?: number }).quantidade_entregue ?? 0,
                  );
                  const restante = Math.max(0, qt - qe);
                  return (
                  <tr key={it.id} className="even:bg-muted/10 align-top">
                    <td className="px-1.5 py-0.5 border font-mono truncate" title={it.codigo}>{it.codigo}</td>
                    <td className="px-1.5 py-0.5 border wrap-break-word">
                      {it.descricao}
                      {!isPrint && (it as PedidoItem & { saldo_estoque?: number | null }).saldo_estoque != null && (
                        <span
                          className={`ml-2 text-[10px] font-medium ${
                            Number((it as PedidoItem & { saldo_estoque?: number | null }).saldo_estoque) < qt
                              ? 'text-red-600'
                              : 'text-muted-foreground'
                          }`}
                          title="Saldo em estoque no Hiper (no momento da sincronização)"
                        >
                          • estoque: {Number((it as PedidoItem & { saldo_estoque?: number | null }).saldo_estoque)}
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-0.5 border text-right font-mono">{qt}</td>
                    <td className="px-1.5 py-0.5 border">{it.unidade}</td>
                    <td className="px-1.5 py-0.5 border text-right font-mono">{qe > 0 ? qe : '—'}</td>
                    <td className={`px-1.5 py-0.5 border text-right font-mono ${restante > 0 && qe > 0 ? 'font-bold text-amber-700' : ''}`}>
                      {restante}
                    </td>
                    <td className="px-1.5 py-0.5 border text-right font-mono">
                      {fmtMoney(Number(it.preco_unitario))}
                    </td>
                    <td className="px-1.5 py-0.5 border text-right font-mono">
                      {fmtMoney(Number(it.total))}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
      ))}

      {/* Totalizador */}
      <Section title="Totais">
        <Grid cols={3}>
          <KV label="Peso Bruto Total" value={pesoBruto > 0 ? `${pesoBruto.toFixed(2)} kg` : '—'} />
          <KV label="Peso Líquido Total" value={pesoLiquido > 0 ? `${pesoLiquido.toFixed(2)} kg` : '—'} />
          {temFrete && <KV label="Subtotal (itens)" value={fmtMoney(subtotalItens)} />}
          <KV label="Frete" value={temFrete ? fmtMoney(valorFrete) : '—'} />
          {pedido.nf_numero && (
            <KV
              label="Nota Fiscal"
              value={`Nº ${pedido.nf_numero}${pedido.nf_emitida_em ? ` · ${fmtDate(pedido.nf_emitida_em.slice(0, 10))}` : ''}`}
              className="col-span-2 [&_.kv-value]:text-emerald-700 [&_.kv-value]:font-semibold"
            />
          )}
          <KV
            label={temFrete ? 'Total (com frete)' : 'Valor Total'}
            value={fmtMoney(totalComFrete)}
            className="[&_.kv-value]:text-lg [&_.kv-value]:font-bold [&_.kv-value]:text-franzoni-navy"
          />
        </Grid>
      </Section>

      {/* Observações */}
      {(pedido.observacoes || logistica?.observacoes) && (
        <Section title="Observações">
          {pedido.observacoes && (
            <p className="text-sm whitespace-pre-wrap">{pedido.observacoes}</p>
          )}
          {logistica?.observacoes && (
            <p className="text-sm whitespace-pre-wrap mt-2 pt-2 border-t border-dashed">
              <span className="text-xs font-medium text-muted-foreground mr-2">Logística:</span>
              {logistica.observacoes}
            </p>
          )}
        </Section>
      )}

      {/* Conferente footer */}
      <footer className="px-4 py-4 text-[10px]">
        <div className="flex justify-between gap-12 mt-3">
          <div className="flex-1 border-t border-black/30 pt-1 text-center text-muted-foreground">
            Conferente
          </div>
          <div className="flex-1 border-t border-black/30 pt-1 text-center text-muted-foreground">
            Motorista
          </div>
          <div className="flex-1 border-t border-black/30 pt-1 text-center text-muted-foreground">
            Cliente
          </div>
        </div>
      </footer>
    </div>
  );

  // Tela: uma via só. Impressão: 2 vias na mesma folha (Loja em cima fica com quem
  // entrega; Cliente embaixo fica com quem recebe os materiais), recorte no meio.
  if (isPrint) {
    return (
      <div className="folha-vias bg-white text-black text-[10pt] mx-auto max-w-[210mm]">
        {/* Cada via ocupa metade da folha A4 (altura fixa via .via-bloco no print).
            O zoom de cada via é ajustado por JS (AjustarVias) pra caber sem cortar;
            pedido grande demais cai pra 1 via/página (classe .paginado). */}
        <div className="via-bloco">{via('1ª via · Loja')}</div>
        {/* 2ª via destacável — controlada pelo check "Guia do cliente" (classe .via-cliente) */}
        <div className="via-bloco via-cliente">
          <div className="recorte relative border-t-2 border-dashed border-black/50 mb-2 print-avoid-break">
            <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 bg-white px-2 text-[8px] font-bold uppercase tracking-widest text-black/50">
              Recorte aqui · via do cliente
            </span>
          </div>
          {via('2ª via · Cliente')}
        </div>
      </div>
    );
  }

  return via(null);
}

// ---------- subcomponentes ----------

function Section({
  title,
  children,
  headerExtra,
  className,
}: {
  title: string;
  children: React.ReactNode;
  headerExtra?: string | null;
  className?: string;
}) {
  return (
    <section className={`border-b border-black/15 px-4 py-2 print-avoid-break ${className ?? ''}`}>
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-franzoni-navy">{title}</h3>
        {headerExtra && (
          <span className="text-xs font-medium text-foreground">{headerExtra}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ cols, children }: { cols: 2 | 3 | 4 | 6; children: React.ReactNode }) {
  const cls =
    cols === 2 ? 'grid-cols-2' :
    cols === 3 ? 'grid-cols-3' :
    cols === 4 ? 'grid-cols-2 md:grid-cols-4' :
    'grid-cols-3 md:grid-cols-6';
  return <div className={`grid ${cls} gap-x-4 gap-y-1`}>{children}</div>;
}

function KV({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="kv-value text-xs font-medium">{value == null || value === '' ? '—' : value}</div>
    </div>
  );
}
