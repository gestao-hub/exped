'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { novaEmpresaSchema, type NovaEmpresaInput } from '@/lib/validators/empresa';

/**
 * Cria uma nova empresa (tenant) + convida o 1º usuário como admin DELA.
 * Só platform admin (operador do produto) pode chamar.
 *
 * SEGURANÇA: não passamos role/empresa_id no metadata do convite — o trigger
 * handle_new_user ignora metadata de propósito (anti-bypass de tenant). O profile
 * nasce com empresa_id=NULL/role='vendedor' e nós atribuímos empresa+role logo
 * depois via service_role (o trigger anti-escalonamento permite porque auth.uid()
 * é null nesse contexto de servidor).
 */
export async function criarEmpresaComAdminAction(
  input: NovaEmpresaInput,
): Promise<{ ok: true; empresa_id: string } | { error: string }> {
  const supa = await createClient();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) return { error: 'Não autenticado' };

  const { data: me } = await supa
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', user.id)
    .single();
  if (!me?.is_platform_admin) return { error: 'Apenas o operador da plataforma pode criar empresas' };

  const parsed = novaEmpresaSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' };
  const d = parsed.data;

  const admin = createAdminClient();

  // 1) Cria a empresa
  const { data: emp, error: e1 } = await admin
    .from('empresas')
    .insert({ nome: d.nome, slug: d.slug })
    .select('id')
    .single();
  if (e1 || !emp) return { error: e1?.message ?? 'Falha ao criar empresa' };

  // 2) Convida o 1º usuário (SEM role/empresa no metadata)
  const { data: invited, error: e2 } = await admin.auth.admin.inviteUserByEmail(d.admin_email, {
    data: { full_name: d.admin_nome },
  });
  if (e2 || !invited?.user) return { error: `Empresa criada, mas convite falhou: ${e2?.message}` };

  // 3) Atribui empresa + role admin via service_role (trigger permite: auth.uid() null)
  const { error: e3 } = await admin
    .from('profiles')
    .update({ empresa_id: emp.id as string, role: 'admin' })
    .eq('id', invited.user.id);
  if (e3) return { error: `Empresa/convite OK, mas atribuição de admin falhou: ${e3.message}` };

  return { ok: true, empresa_id: emp.id as string };
}
