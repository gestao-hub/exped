import { requireRole } from '@/lib/auth/require-role';

/**
 * Gate de role: apenas admin e financeiro acessam /financeiro e suas subrotas.
 * (vendedor → /vendas; logística → /logistica)
 */
export default async function FinanceiroLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['admin', 'financeiro']);
  return <>{children}</>;
}
