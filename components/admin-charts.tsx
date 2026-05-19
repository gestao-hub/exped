'use client';

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import { ContentCard } from '@/components/layout/content-card';

type SeriePorDia = { dia: string; pedidos: number };
type TopCliente  = { nome: string; valor: number; pedidos: number };
type TopBairro   = { bairro: string; pedidos: number };

const ORANGE = '#F37021';
const NAVY   = '#1E2761';
const PALETTE = [ORANGE, NAVY, '#3B82F6', '#10B981', '#F59E0B', '#A855F7', '#06B6D4', '#EF4444', '#84CC16', '#EC4899'];

export function PedidosPorDia({ data }: { data: SeriePorDia[] }) {
  return (
    <ContentCard
      className="p-5!"
      header={
        <div>
          <h3 className="font-heading font-semibold text-base">Pedidos por dia</h3>
          <p className="text-xs text-muted-foreground">Últimos 30 dias (criados — qualquer status)</p>
        </div>
      }
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
            <XAxis dataKey="dia" tick={{ fontSize: 11 }} stroke="#999" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#999" width={30} />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.95)',
              }}
              labelStyle={{ color: NAVY, fontWeight: 600 }}
            />
            <Line
              type="monotone"
              dataKey="pedidos"
              stroke={ORANGE}
              strokeWidth={2.5}
              dot={{ fill: ORANGE, r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ContentCard>
  );
}

export function TopClientes({ data }: { data: TopCliente[] }) {
  const fmtCur = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

  return (
    <ContentCard
      className="p-5!"
      header={
        <div>
          <h3 className="font-heading font-semibold text-base">Top 10 clientes</h3>
          <p className="text-xs text-muted-foreground">Valor faturado (pedidos finalizados)</p>
        </div>
      }
    >
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} stroke="#999" tickFormatter={fmtCur} />
            <YAxis
              dataKey="nome"
              type="category"
              tick={{ fontSize: 11 }}
              stroke="#999"
              width={130}
              tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 16) + '…' : v)}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.95)',
              }}
              labelStyle={{ color: NAVY, fontWeight: 600 }}
              formatter={(v, _name, item) => {
                const n = typeof v === 'number' ? v : Number(v);
                const p = item.payload as TopCliente;
                return [`${fmtCur(n)} · ${p.pedidos}p`, 'Faturado'] as [string, string];
              }}
            />
            <Bar dataKey="valor" radius={[0, 4, 4, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ContentCard>
  );
}

export function TopBairros({ data }: { data: TopBairro[] }) {
  return (
    <ContentCard
      className="p-5!"
      header={
        <div>
          <h3 className="font-heading font-semibold text-base">Top 10 bairros</h3>
          <p className="text-xs text-muted-foreground">Quantidade de entregas (todos os status)</p>
        </div>
      }
    >
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} stroke="#999" />
            <YAxis
              dataKey="bairro"
              type="category"
              tick={{ fontSize: 11 }}
              stroke="#999"
              width={130}
              tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 16) + '…' : v)}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.95)',
              }}
              labelStyle={{ color: NAVY, fontWeight: 600 }}
            />
            <Bar dataKey="pedidos" radius={[0, 4, 4, 0]} fill={NAVY} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ContentCard>
  );
}
