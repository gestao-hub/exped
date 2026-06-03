// Cria os logins de vendedor da Franzoni + mapeia hiper_vendedor_map.
// Uso (Node 18+):  SR="<service_role JWT>" node scripts/franzoni-vendedores.mjs
// SR = service_role key do projeto louaguxcohfeicxxqggw (NUNCA commitar; rotacionar depois).
// Idempotente: pode rodar de novo sem duplicar.

const BASE = 'https://louaguxcohfeicxxqggw.supabase.co';
const KEY = process.env.SR;
if (!KEY) { console.error('ERRO: defina SR com a service_role key.'); process.exit(1); }
const FRAN = '00000000-0000-0000-0000-0000000f0001';
const SENHA = 'Franzoni@2026';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

// vendedor Exped -> nome + quais ids do Hiper mapeiam pra ele
const VENDEDORES = [
  { email: 'christian@franzoni.local', nome: 'Christian',                hiper: [[11, 'CHRISTIAN']] },
  { email: 'nubia@franzoni.local',     nome: 'Nubia',                    hiper: [[3,  'NUBIA']] },
  { email: 'eliana@franzoni.local',    nome: 'Eliana de Souza Cardoso',  hiper: [[15, 'ELIANA DE SOUZA CARDOSO']] },
  { email: 'mauricio@franzoni.local',  nome: 'Mauricio Honorato',        hiper: [[4,  'MAURICIO HONORATO']] },
  { email: 'gustavo@franzoni.local',   nome: 'Gustavo',                  hiper: [[12, 'GUSTAVO']] },
  { email: 'douglas@franzoni.local',   nome: 'Douglas Pedrinho',         hiper: [[2,  'DOUGLAS PEDRINHO']] },
  { email: 'sabrina@franzoni.local',   nome: 'Sabrina Kieling',          hiper: [[5,  'SABRINA KIELING']] },
  // genérico p/ os usuários "VENDEDORES" e "ADMIN" do Hiper (senão pedido deles dá 422)
  { email: 'balcao@franzoni.local',    nome: 'Balcão Franzoni',          hiper: [[8, 'VENDEDORES'], [1, 'ADMIN']] },
];

async function api(method, path, body, extraHeaders = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { ...H, ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: r.status, data };
}

// cria (ou acha) o usuário de auth; devolve o id (= profile id)
async function ensureUser(email, nome) {
  const c = await api('POST', '/auth/v1/admin/users', {
    email, password: SENHA, email_confirm: true, user_metadata: { full_name: nome },
  });
  if ((c.status === 200 || c.status === 201) && c.data?.id) return { id: c.data.id, criado: true };
  // já existe → busca o id pelo profile (profiles tem coluna email)
  const p = await api('GET', `/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(email)}`);
  if (Array.isArray(p.data) && p.data[0]?.id) return { id: p.data[0].id, criado: false };
  throw new Error(`Não consegui criar nem achar ${email}: ${c.status} ${JSON.stringify(c.data)}`);
}

async function main() {
  const mapeamentos = [];
  for (const v of VENDEDORES) {
    const { id, criado } = await ensureUser(v.email, v.nome);
    // ajusta o profile: empresa + role vendedor + nome (service_role => trigger anti-escalonamento permite)
    const up = await api('PATCH', `/rest/v1/profiles?id=eq.${id}`,
      { empresa_id: FRAN, role: 'vendedor', full_name: v.nome },
      { Prefer: 'return=minimal' });
    console.log(`${criado ? 'CRIADO ' : 'existe '} ${v.email}  profile=${id}  patch=${up.status}`);
    for (const [hid, hnome] of v.hiper) {
      mapeamentos.push({ empresa_id: FRAN, hiper_usuario_id: hid, hiper_usuario_nome: hnome, vendedor_id: id });
    }
  }
  // upsert dos 9 mapeamentos (merge por chave única empresa_id+hiper_usuario_id)
  const m = await api('POST', '/rest/v1/hiper_vendedor_map', mapeamentos,
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  console.log(`\nhiper_vendedor_map upsert: status=${m.status} ${m.status >= 300 ? JSON.stringify(m.data) : '(' + mapeamentos.length + ' linhas)'}`);

  // verificação final
  const chk = await api('GET',
    `/rest/v1/hiper_vendedor_map?select=hiper_usuario_id,hiper_usuario_nome,vendedor_id&empresa_id=eq.${FRAN}&order=hiper_usuario_id`);
  console.log('\n== mapeamentos agora ==');
  for (const r of (chk.data || [])) console.log(`  Hiper #${r.hiper_usuario_id} (${r.hiper_usuario_nome}) -> ${r.vendedor_id}`);
  console.log('\nOK. Logins criados com senha:', SENHA, '(mude depois se quiser).');
}
main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
