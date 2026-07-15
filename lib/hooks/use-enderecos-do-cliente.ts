'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export type ClienteEndereco = {
  id: string;
  cliente_id: string;
  rotulo: string;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  is_padrao: boolean;
};

export type ClienteResumo = { id: string; nome: string };

/**
 * Resolve um cliente pelo CNPJ/CPF e devolve seus endereços cadastrados.
 * - Sem CNPJ/CPF → não busca (seletor não aparece pra cliente efêmero).
 * - Cliente não existe ainda → cliente=null, lista vazia (será criado no submit).
 * - Cliente existe → lista ordenada por (padrão primeiro, depois created_at).
 */
export function useEnderecosDoCliente(cnpjCpf: string | null | undefined) {
  const supabase = useMemo(() => createClient(), []);
  const [cliente, setCliente] = useState<ClienteResumo | null>(null);
  const [enderecos, setEnderecos] = useState<ClienteEndereco[]>([]);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const key = (cnpjCpf ?? '').trim();
    if (!key) {
      // The lookup key was cleared, so stale results must disappear immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCliente(null);
      setEnderecos([]);
      return;
    }
    let cancel = false;
    setLoading(true);
    (async () => {
      const { data: c } = await supabase
        .from('clientes')
        .select('id, nome')
        .eq('cnpj_cpf', key)
        .is('deleted_at', null)
        .maybeSingle();
      if (cancel) return;
      if (!c) {
        setCliente(null);
        setEnderecos([]);
        setLoading(false);
        return;
      }
      setCliente({ id: c.id as string, nome: c.nome as string });
      const { data: list } = await supabase
        .from('cliente_enderecos')
        .select('*')
        .eq('cliente_id', c.id as string)
        .order('is_padrao', { ascending: false })
        .order('created_at');
      if (cancel) return;
      setEnderecos((list ?? []) as ClienteEndereco[]);
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [supabase, cnpjCpf, version]);

  return { cliente, enderecos, loading, refetch };
}

/** Normaliza string pra comparação (lowercase, sem acentos/pontuação). */
function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Tenta casar um endereço solto (vindo do PDF) com algum cadastrado.
 * Estratégia: 1º por CEP (8 dígitos exato); 2º por endereço normalizado.
 * Em caso de empate, prefere o is_padrao.
 */
export function matchEndereco(
  currentEndereco: string | null | undefined,
  currentCep: string | null | undefined,
  enderecos: ClienteEndereco[],
): ClienteEndereco | null {
  if (enderecos.length === 0) return null;
  const cep = (currentCep ?? '').replace(/\D/g, '');
  if (cep.length === 8) {
    const matches = enderecos.filter((e) => (e.cep ?? '').replace(/\D/g, '') === cep);
    if (matches.length > 0) return matches.find((e) => e.is_padrao) ?? matches[0];
  }
  const e1 = norm(currentEndereco);
  if (e1) {
    const matches = enderecos.filter((e) => norm(e.endereco) === e1);
    if (matches.length > 0) return matches.find((e) => e.is_padrao) ?? matches[0];
  }
  return null;
}
