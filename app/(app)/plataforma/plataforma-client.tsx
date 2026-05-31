'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Copy, Power, PowerOff, Building2, Cpu, Users, Bell } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { criarEmpresaComAdminAction, salvarNotifConfigAction, salvarEmpresaConfigAction, type NotifConfigInput, type EmpresaConfigInput } from '@/lib/empresa/actions';
import { criarDispositivoAction, setDispositivoAtivoAction } from '@/lib/empresa/devices-actions';
import { salvarVendedorMapAction } from '@/lib/empresa/vendedor-map-actions';

type Empresa = {
  id: string; nome: string; slug: string; ativo: boolean; usa_os: boolean;
  logo_url: string | null; cor_primaria: string | null;
  notif_whatsapp_ativo: boolean; uazapi_url: string | null; uazapi_token: string | null;
  uazapi_instancia: string | null; notif_email_ativo: boolean; email_remetente: string | null;
  manutencao_lembrete_dias: number; os_situacao_autorizacao: number | null; os_situacao_pronto: number | null;
};
type Dispositivo = { id: string; empresa_id: string; nome: string; ativo: boolean; last_seen_at: string | null; created_at: string };
type Mapeamento = { empresa_id: string; hiper_usuario_id: number; hiper_usuario_nome: string | null; vendedor_id: string };
type Profile = { id: string; full_name: string | null; email: string | null; role: string; empresa_id: string | null };

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000;
}

export function PlataformaClient({
  empresas, dispositivos, mapeamentos, profiles,
}: {
  empresas: Empresa[]; dispositivos: Dispositivo[]; mapeamentos: Mapeamento[]; profiles: Profile[];
}) {
  const [tokenRevelado, setTokenRevelado] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Plataforma" description="Operador: empresas, agentes e mapeamentos (cross-tenant)." />

      <NovaEmpresa />

      {empresas.map((e) => (
        <EmpresaCard
          key={e.id}
          empresa={e}
          dispositivos={dispositivos.filter((d) => d.empresa_id === e.id)}
          mapeamentos={mapeamentos.filter((m) => m.empresa_id === e.id)}
          vendedores={profiles.filter((p) => p.empresa_id === e.id)}
          onTokenGerado={setTokenRevelado}
        />
      ))}

      <Dialog open={!!tokenRevelado} onOpenChange={(o) => !o && setTokenRevelado(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token do dispositivo</DialogTitle>
            <DialogDescription>
              Copie agora — ele <strong>só aparece uma vez</strong>. Cole no <code>appsettings.json</code> do agente
              (<code>DeviceToken</code>) na máquina do cliente.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={tokenRevelado ?? ''} className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(tokenRevelado ?? '');
                toast.success('Token copiado');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setTokenRevelado(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------

function NovaEmpresa() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ nome: '', slug: '', admin_email: '', admin_nome: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  function salvar() {
    start(async () => {
      const r = await criarEmpresaComAdminAction(f);
      if ('error' in r) { toast.error(r.error); return; }
      toast.success('Empresa criada + convite enviado ao admin');
      setF({ nome: '', slug: '', admin_email: '', admin_nome: '' });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="inline-flex items-center gap-2"><Building2 className="h-4 w-4" /> Empresas</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          <Plus className="h-4 w-4 mr-1" /> Nova empresa
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Nome"><Input value={f.nome} onChange={(e) => set('nome')(e.target.value)} /></Field>
          <Field label="Slug"><Input value={f.slug} placeholder="ex.: loja-centro" onChange={(e) => set('slug')(e.target.value)} /></Field>
          <Field label="E-mail do admin"><Input value={f.admin_email} onChange={(e) => set('admin_email')(e.target.value)} /></Field>
          <Field label="Nome do admin"><Input value={f.admin_nome} onChange={(e) => set('admin_nome')(e.target.value)} /></Field>
          <div className="md:col-span-4 flex justify-end">
            <Button onClick={salvar} disabled={pending}>Criar empresa</Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function EmpresaCard({
  empresa, dispositivos, mapeamentos, vendedores, onTokenGerado,
}: {
  empresa: Empresa; dispositivos: Dispositivo[]; mapeamentos: Mapeamento[];
  vendedores: Profile[]; onTokenGerado: (t: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{empresa.nome} <span className="text-xs text-muted-foreground">/{empresa.slug}</span></CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <EmpresaConfigSection empresa={empresa} />
        <DispositivosSection empresaId={empresa.id} dispositivos={dispositivos} onTokenGerado={onTokenGerado} />
        <VendedoresSection empresaId={empresa.id} mapeamentos={mapeamentos} vendedores={vendedores} />
        {empresa.usa_os && <NotificacoesSection empresa={empresa} />}
      </CardContent>
    </Card>
  );
}

function NotificacoesSection({ empresa }: { empresa: Empresa }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState<NotifConfigInput>({
    notif_whatsapp_ativo: empresa.notif_whatsapp_ativo,
    uazapi_url: empresa.uazapi_url,
    uazapi_token: empresa.uazapi_token,
    uazapi_instancia: empresa.uazapi_instancia,
    notif_email_ativo: empresa.notif_email_ativo,
    email_remetente: empresa.email_remetente,
    manutencao_lembrete_dias: empresa.manutencao_lembrete_dias ?? 7,
    os_situacao_autorizacao: empresa.os_situacao_autorizacao,
    os_situacao_pronto: empresa.os_situacao_pronto,
  });
  const set = <K extends keyof NotifConfigInput>(k: K, v: NotifConfigInput[K]) =>
    setF((p) => ({ ...p, [k]: v }));
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  function salvar() {
    start(async () => {
      const r = await salvarNotifConfigAction(empresa.id, f);
      if ('error' in r) toast.error(r.error);
      else { toast.success('Notificações salvas.'); router.refresh(); }
    });
  }

  return (
    <section>
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
        <Bell className="h-4 w-4" /> Notificações (OS)
      </h3>
      <div className="space-y-4">
        {/* WhatsApp */}
        <div className="rounded-md border p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={f.notif_whatsapp_ativo}
              onChange={(e) => set('notif_whatsapp_ativo', e.target.checked)} />
            WhatsApp (uazapi)
          </label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input placeholder="URL da instância (uazapi_url)" value={f.uazapi_url ?? ''}
              onChange={(e) => set('uazapi_url', e.target.value)} />
            <Input placeholder="Token" value={f.uazapi_token ?? ''}
              onChange={(e) => set('uazapi_token', e.target.value)} />
            <Input placeholder="Instância (opcional)" value={f.uazapi_instancia ?? ''}
              onChange={(e) => set('uazapi_instancia', e.target.value)} />
          </div>
        </div>
        {/* E-mail */}
        <div className="rounded-md border p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={f.notif_email_ativo}
              onChange={(e) => set('notif_email_ativo', e.target.checked)} />
            E-mail (Resend)
          </label>
          <Input placeholder='Remetente — ex: "Oficina X <oi@oficina.com>"' value={f.email_remetente ?? ''}
            onChange={(e) => set('email_remetente', e.target.value)} />
        </div>
        {/* Gatilhos + lembrete */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div>
            <Label className="text-[11px]">Situação = Autorização</Label>
            <Input type="number" placeholder="ex.: 3" value={f.os_situacao_autorizacao ?? ''}
              onChange={(e) => set('os_situacao_autorizacao', numOrNull(e.target.value))} />
          </div>
          <div>
            <Label className="text-[11px]">Situação = Pronto</Label>
            <Input type="number" placeholder="ex.: 5" value={f.os_situacao_pronto ?? ''}
              onChange={(e) => set('os_situacao_pronto', numOrNull(e.target.value))} />
          </div>
          <div>
            <Label className="text-[11px]">Lembrete: dias antes</Label>
            <Input type="number" value={f.manutencao_lembrete_dias}
              onChange={(e) => set('manutencao_lembrete_dias', Number(e.target.value))} />
          </div>
        </div>
        <Button size="sm" onClick={salvar} disabled={pending}>Salvar notificações</Button>
        <p className="text-[11px] text-muted-foreground">
          Sem credencial, a notificação é enfileirada mas não enviada. As situações vêm do Hiper do cliente (deixe em branco para não disparar automático).
        </p>
      </div>
    </section>
  );
}

function EmpresaConfigSection({ empresa }: { empresa: Empresa }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState<EmpresaConfigInput>({
    usa_os: empresa.usa_os,
    ativo: empresa.ativo,
    logo_url: empresa.logo_url,
    cor_primaria: empresa.cor_primaria,
  });
  const set = <K extends keyof EmpresaConfigInput>(k: K, v: EmpresaConfigInput[K]) => setF((p) => ({ ...p, [k]: v }));

  function salvar() {
    start(async () => {
      const r = await salvarEmpresaConfigAction(empresa.id, f);
      if ('error' in r) toast.error(r.error);
      else { toast.success('Empresa atualizada.'); router.refresh(); }
    });
  }

  return (
    <section>
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
        <Building2 className="h-4 w-4" /> Configuração da empresa
      </h3>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.usa_os} onChange={(e) => set('usa_os', e.target.checked)} />
            Usa Ordem de Serviço
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.ativo} onChange={(e) => set('ativo', e.target.checked)} />
            Empresa ativa
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
          <div className="md:col-span-2">
            <Label className="text-[11px]">Logo (URL)</Label>
            <Input placeholder="https://…/logo.png" value={f.logo_url ?? ''} onChange={(e) => set('logo_url', e.target.value)} />
          </div>
          <div>
            <Label className="text-[11px]">Cor da marca</Label>
            <div className="flex gap-2 items-center">
              <input type="color" value={f.cor_primaria ?? '#039855'} onChange={(e) => set('cor_primaria', e.target.value)}
                className="h-9 w-12 rounded border cursor-pointer" />
              <Input placeholder="#039855" value={f.cor_primaria ?? ''} onChange={(e) => set('cor_primaria', e.target.value)} />
            </div>
          </div>
        </div>
        <Button size="sm" onClick={salvar} disabled={pending}>Salvar empresa</Button>
      </div>
    </section>
  );
}

function DispositivosSection({
  empresaId, dispositivos, onTokenGerado,
}: { empresaId: string; dispositivos: Dispositivo[]; onTokenGerado: (t: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [nome, setNome] = useState('');

  function gerar() {
    if (!nome.trim()) { toast.error('Dê um nome ao dispositivo (ex.: PDV Loja)'); return; }
    start(async () => {
      const r = await criarDispositivoAction(empresaId, nome);
      if ('error' in r) { toast.error(r.error); return; }
      onTokenGerado(r.token);
      setNome('');
      router.refresh();
    });
  }
  function toggle(id: string, ativo: boolean) {
    start(async () => {
      const r = await setDispositivoAtivoAction(id, ativo);
      if ('error' in r) { toast.error(r.error); return; }
      toast.success(ativo ? 'Dispositivo reativado' : 'Dispositivo revogado');
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium inline-flex items-center gap-2"><Cpu className="h-4 w-4" /> Agentes ({dispositivos.length})</h4>
      <div className="flex gap-2">
        <Input value={nome} placeholder="Nome do agente (ex.: PDV Loja Centro)" onChange={(e) => setNome(e.target.value)} className="max-w-xs" />
        <Button size="sm" onClick={gerar} disabled={pending}><Plus className="h-4 w-4 mr-1" /> Gerar token</Button>
      </div>
      {dispositivos.length > 0 && (
        <ul className="text-sm divide-y border rounded-md">
          {dispositivos.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-3 py-2">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${isOnline(d.last_seen_at) ? 'bg-status-finalizado' : 'bg-muted-foreground/40'}`} />
                {d.nome}
                {!d.ativo && <span className="text-[11px] text-destructive">(revogado)</span>}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-[11px] text-muted-foreground">
                  {d.last_seen_at ? `visto ${new Date(d.last_seen_at).toLocaleString('pt-BR')}` : 'nunca conectou'}
                </span>
                <Button size="icon" variant="ghost" onClick={() => toggle(d.id, !d.ativo)} disabled={pending}
                  aria-label={d.ativo ? 'Revogar' : 'Reativar'}>
                  {d.ativo ? <PowerOff className="h-4 w-4 text-destructive" /> : <Power className="h-4 w-4" />}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VendedoresSection({
  empresaId, mapeamentos, vendedores,
}: { empresaId: string; mapeamentos: Mapeamento[]; vendedores: Profile[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hiperId, setHiperId] = useState('');
  const [hiperNome, setHiperNome] = useState('');
  const [vendedorId, setVendedorId] = useState('');

  function salvar() {
    const id = Number(hiperId);
    if (!Number.isInteger(id)) { toast.error('id do Hiper inválido'); return; }
    if (!vendedorId) { toast.error('Escolha o vendedor Expedi'); return; }
    start(async () => {
      const r = await salvarVendedorMapAction({
        empresa_id: empresaId, hiper_usuario_id: id,
        hiper_usuario_nome: hiperNome || null, vendedor_id: vendedorId,
      });
      if ('error' in r) { toast.error(r.error); return; }
      toast.success('Mapeamento salvo');
      setHiperId(''); setHiperNome(''); setVendedorId('');
      router.refresh();
    });
  }
  const nomeVendedor = (id: string) => {
    const v = vendedores.find((x) => x.id === id);
    return v ? (v.full_name || v.email || id) : id;
  };

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium inline-flex items-center gap-2"><Users className="h-4 w-4" /> Vendedores (Hiper → Expedi)</h4>
      <div className="flex flex-wrap gap-2 items-end">
        <Field label="ID Hiper"><Input value={hiperId} onChange={(e) => setHiperId(e.target.value)} className="w-24" placeholder="1" /></Field>
        <Field label="Nome no Hiper"><Input value={hiperNome} onChange={(e) => setHiperNome(e.target.value)} className="w-40" placeholder="Michel" /></Field>
        <Field label="Vendedor Expedi">
          <select value={vendedorId} onChange={(e) => setVendedorId(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm min-w-[200px]">
            <option value="">— escolher —</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.full_name || v.email} ({v.role})</option>)}
          </select>
        </Field>
        <Button size="sm" onClick={salvar} disabled={pending}><Plus className="h-4 w-4 mr-1" /> Adicionar</Button>
      </div>
      {mapeamentos.length > 0 && (
        <ul className="text-sm divide-y border rounded-md">
          {mapeamentos.map((m) => (
            <li key={m.hiper_usuario_id} className="flex items-center justify-between px-3 py-2">
              <span>Hiper #{m.hiper_usuario_id} {m.hiper_usuario_nome ? `(${m.hiper_usuario_nome})` : ''}</span>
              <span className="text-muted-foreground">→ {nomeVendedor(m.vendedor_id)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1 block">{label}</Label>
      {children}
    </div>
  );
}
