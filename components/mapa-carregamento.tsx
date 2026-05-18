import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { FranzoniLogo } from '@/components/franzoni-logo';
import { StatusBadge } from '@/components/status-badge';
import type {
  Pedido,
  PedidoLogistica,
  PontoRetirada,
  PedidoItem,
} from '@/lib/types';

export type PontoComItens = PontoRetirada & { itens: PedidoItem[] };

export function MapaCarregamento({
  pedido,
  pontos,
  logistica,
  vendedor,
  mode = 'leitura',
}: {
  pedido: Pedido;
  pontos: PontoComItens[];
  logistica?: PedidoLogistica | null;
  vendedor?: { full_name: string | null; email: string | null } | null;
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

  return (
    <div
      className={
        isPrint
          ? 'bg-white text-black text-[11pt] mx-auto max-w-[210mm]'
          : 'bg-white text-foreground border rounded-lg overflow-hidden'
      }
    >
      {/* Header */}
      <header className="border-b border-black/20 px-6 py-4 flex items-center justify-between gap-6">
        <FranzoniLogo variant="dark" size={56} />
        <div className="text-right">
          <h1 className="text-lg font-bold tracking-tight">Mapa de Carregamento</h1>
          <p className="text-xs text-muted-foreground">
            Mapa Nº <span className="font-mono font-semibold">#{pedido.numero_mapa}</span>
            {pedido.documento_erp && (
              <>
                {' '}· ERP <span className="font-mono">{pedido.documento_erp}</span>
              </>
            )}
          </p>
          {!isPrint && <div className="mt-2"><StatusBadge status={pedido.status} /></div>}
        </div>
      </header>

      {/* Logística de Entrega de Mercadorias */}
      <Section title="Logística de Entrega">
        <Grid cols={4}>
          <KV label="Pré-Carga"  value={logistica?.pre_carga} />
          <KV label="Motorista"  value={logistica?.motorista} />
          <KV label="Veículo"    value={logistica?.veiculo} />
          <KV label="Região"     value={logistica?.regiao} />
          <KV label="Km Inicial" value={logistica?.km_inicial} />
          <KV label="Km Final"   value={logistica?.km_final} />
          <KV label="Conferente" value={logistica?.conferente} />
          <KV
            label="Atualizado em"
            value={
              logistica?.updated_at
                ? format(new Date(logistica.updated_at), 'dd/MM HH:mm', { locale: ptBR })
                : '—'
            }
          />
        </Grid>
      </Section>

      {/* Cliente */}
      <Section title="Cliente">
        <Grid cols={4}>
          <KV label="Código"       value={pedido.cliente_codigo} />
          <KV label="Nome"         value={pedido.cliente_nome} className="col-span-2 font-semibold" />
          <KV label="CNPJ/CPF"     value={pedido.cliente_cnpj_cpf} />
          <KV label="Emissão"      value={fmtDate(pedido.data_emissao)} />
          <KV label="Entrega"      value={fmtDate(pedido.data_entrega)} />
          <KV
            label="Vendedor"
            value={vendedor?.full_name || vendedor?.email || '—'}
            className="col-span-2"
          />
        </Grid>
      </Section>

      {/* Endereço */}
      <Section title="Endereço de Entrega">
        <Grid cols={6}>
          <KV label="Endereço" value={pedido.cliente_endereco} className="col-span-3" />
          <KV
            label="Bairro"
            value={pedido.cliente_bairro}
            className="col-span-1 [&_.kv-value]:font-semibold [&_.kv-value]:text-franzoni-orange-700"
          />
          <KV label="Cidade"  value={pedido.cliente_cidade} className="col-span-1" />
          <KV label="UF"      value={pedido.cliente_uf} className="col-span-1" />
          <KV label="CEP"     value={pedido.cliente_cep} className="col-span-2" />
          <KV label="Tel"     value={pedido.cliente_telefone} className="col-span-2" />
          <KV
            label="Pagamento"
            value={`${pedido.forma_pagamento ?? '—'}${pedido.parcelas ? ` · ${pedido.parcelas}` : ''}`}
            className="col-span-2"
          />
        </Grid>
      </Section>

      {/* Pontos de Retirada */}
      {pontos.map((ponto, idx) => (
        <Section
          key={ponto.id}
          title={`${ponto.tipo === 'loja' ? 'Loja' : 'Depósito'} ${pontos.length > 1 ? `· ${idx + 1}/${pontos.length}` : ''}`}
          headerExtra={ponto.empresa_nome}
          className={isPrint && idx > 0 ? 'print-break-before' : ''}
        >
          {ponto.endereco && (
            <p className="text-xs text-muted-foreground mb-2">{ponto.endereco}</p>
          )}
          {ponto.itens.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">Sem itens.</p>
          ) : (
            <table className="w-full text-xs border-collapse table-fixed">
              <colgroup>
                <col style={{ width: '70px' }} />
                <col />
                <col style={{ width: '52px' }} />
                <col style={{ width: '40px' }} />
                <col style={{ width: '90px' }} />
                <col style={{ width: '52px' }} />
                <col style={{ width: '52px' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: '80px' }} />
              </colgroup>
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-2 py-1 border">Código</th>
                  <th className="px-2 py-1 border">Descrição</th>
                  <th className="px-2 py-1 border text-right">Qtd</th>
                  <th className="px-2 py-1 border">Un</th>
                  <th className="px-2 py-1 border">Lote/Ref</th>
                  <th className="px-2 py-1 border text-right">PB</th>
                  <th className="px-2 py-1 border text-right">PL</th>
                  <th className="px-2 py-1 border text-right">Unitário</th>
                  <th className="px-2 py-1 border text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {ponto.itens.map((it: PedidoItem) => (
                  <tr key={it.id} className="even:bg-muted/10 align-top">
                    <td className="px-2 py-1 border font-mono truncate" title={it.codigo}>{it.codigo}</td>
                    <td className="px-2 py-1 border wrap-break-word">{it.descricao}</td>
                    <td className="px-2 py-1 border text-right font-mono">{Number(it.quantidade)}</td>
                    <td className="px-2 py-1 border">{it.unidade}</td>
                    <td className="px-2 py-1 border">{it.referencia || it.lote || '—'}</td>
                    <td className="px-2 py-1 border text-right font-mono">
                      {it.peso_bruto != null ? Number(it.peso_bruto).toFixed(2) : '—'}
                    </td>
                    <td className="px-2 py-1 border text-right font-mono">
                      {it.peso_liquido != null ? Number(it.peso_liquido).toFixed(2) : '—'}
                    </td>
                    <td className="px-2 py-1 border text-right font-mono">
                      {fmtMoney(Number(it.preco_unitario))}
                    </td>
                    <td className="px-2 py-1 border text-right font-mono">
                      {fmtMoney(Number(it.total))}
                    </td>
                  </tr>
                ))}
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
          <KV
            label="Valor Total"
            value={fmtMoney(Number(pedido.valor_total))}
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
      <footer className="px-6 py-6 text-xs">
        <div className="flex justify-between gap-12 mt-4">
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
    <section className={`border-b border-black/15 px-6 py-3 print-avoid-break ${className ?? ''}`}>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-bold uppercase tracking-widest text-franzoni-navy">{title}</h3>
        {headerExtra && (
          <span className="text-sm font-medium text-foreground">{headerExtra}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ cols, children }: { cols: 3 | 4 | 6; children: React.ReactNode }) {
  const cls = cols === 3 ? 'grid-cols-3' : cols === 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3 md:grid-cols-6';
  return <div className={`grid ${cls} gap-x-4 gap-y-2`}>{children}</div>;
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
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="kv-value text-sm font-medium">{value == null || value === '' ? '—' : value}</div>
    </div>
  );
}
