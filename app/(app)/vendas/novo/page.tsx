'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { ContentCard, ContentCardTitle } from '@/components/layout/content-card';
import {
  UploadPdf,
  BulkProgressList,
  type BulkItem,
  type SingleParseResult,
} from '@/components/upload-pdf';
import { PedidoForm } from '@/components/pedido-form';
import { parsedToFormInput, emptyFormInput } from '@/lib/parser/to-form-input';
import type { PedidoFormInput } from '@/lib/validators/pedido';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { criarPedidoAction } from '@/app/(app)/vendas/actions';
import Link from 'next/link';

type Mode = 'upload' | 'review' | 'bulk';

export default function NovoPedidoPage() {
  const [mode, setMode] = useState<Mode>('upload');
  const [defaults, setDefaults] = useState<PedidoFormInput | null>(null);
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
  const [bulkBusy, startBulk] = useTransition();

  function reset() {
    setMode('upload');
    setDefaults(null);
    setBulkItems([]);
  }

  function handleSingle(data: SingleParseResult) {
    setDefaults(parsedToFormInput(data.pedido, data.storage_path));
    setMode('review');
  }

  function handleBulk(files: File[]) {
    const items: BulkItem[] = files.map((f, i) => ({
      id: `${f.name}-${f.size}-${i}`,
      file: f,
      status: { kind: 'pending' },
    }));
    setBulkItems(items);
    setMode('bulk');

    startBulk(async () => {
      // Processa todos em paralelo (até 4 simultâneos pra não estressar o serverless)
      const queue = [...items];
      const concurrency = 4;
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          const item = queue.shift()!;
          await processOne(item, setBulkItems);
        }
      });
      await Promise.all(workers);
    });
  }

  // ---------- Review ----------
  if (mode === 'review' && defaults) {
    return (
      <>
        <PageHeader
          title="Revisar Pedido"
          description="Confira os dados extraídos do PDF antes de enviar para a logística."
          actions={
            <Button variant="outline" onClick={reset}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
            </Button>
          }
        />
        <PedidoForm defaultValues={defaults} />
      </>
    );
  }

  // ---------- Bulk ----------
  if (mode === 'bulk') {
    const created   = bulkItems.filter((i) => i.status.kind === 'created').length;
    const duplicate = bulkItems.filter((i) => i.status.kind === 'duplicate').length;
    const errored   = bulkItems.filter((i) => i.status.kind === 'error').length;
    const done      = created + duplicate + errored;
    const allDone   = done === bulkItems.length;

    return (
      <>
        <PageHeader
          title="Processamento em Lote"
          description={
            allDone
              ? `${bulkItems.length} arquivo${bulkItems.length === 1 ? '' : 's'} processado${bulkItems.length === 1 ? '' : 's'}.`
              : `Processando ${bulkItems.length} arquivo${bulkItems.length === 1 ? '' : 's'}…`
          }
          actions={
            allDone && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Novo lote
                </Button>
                <Link
                  href="/vendas"
                  className="inline-flex items-center justify-center rounded-md text-sm font-medium px-4 h-9 bg-franzoni-orange hover:bg-franzoni-orange-600 text-white"
                >
                  Ver pedidos
                </Link>
              </div>
            )
          }
        />

        <div className="grid grid-cols-3 gap-3">
          <KpiMini label="Criados"    value={created}   color="text-status-finalizado" />
          <KpiMini label="Duplicados" value={duplicate} color="text-status-pendente" />
          <KpiMini label="Erros"      value={errored}   color="text-destructive" />
        </div>

        <ContentCard
          variant="padded"
          header={
            <div className="flex items-center gap-2">
              {bulkBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <ContentCardTitle>Status dos arquivos</ContentCardTitle>
            </div>
          }
        >
          <BulkProgressList items={bulkItems} />
        </ContentCard>
      </>
    );
  }

  // ---------- Upload ----------
  return (
    <>
      <PageHeader
        title="Novo Pedido"
        description="Faça upload do PDF emitido pelo ERP. Você pode soltar vários PDFs ao mesmo tempo — o sistema processa em lote e detecta duplicados."
      />

      <div className="max-w-2xl mx-auto w-full">
        <ContentCard
          header={<ContentCardTitle>Importar PDF</ContentCardTitle>}
          className="space-y-6"
        >
          <UploadPdf onParsedAction={handleSingle} onBulkStartAction={handleBulk} />

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex-1 border-t border-border/60" />
            <span>ou</span>
            <div className="flex-1 border-t border-border/60" />
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setDefaults(emptyFormInput());
              setMode('review');
            }}
          >
            Preencher manualmente (sem PDF)
          </Button>
        </ContentCard>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pipeline de processamento de 1 item do lote
// ---------------------------------------------------------------------------

async function processOne(
  item: BulkItem,
  setItems: React.Dispatch<React.SetStateAction<BulkItem[]>>,
) {
  const setStatus = (next: BulkItem['status']) =>
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: next } : it)));

  try {
    setStatus({ kind: 'parsing' });
    const fd = new FormData();
    fd.append('file', item.file);
    const res = await fetch('/api/parse-pdf', { method: 'POST', body: fd });
    const parsed = (await res.json().catch(() => ({}))) as
      | { pedido: import('@/lib/parser/franzoni-erp').PedidoParsed; storage_path: string | null }
      | { error: string; detail?: string };

    if (!res.ok || 'error' in parsed) {
      const msg = 'error' in parsed ? parsed.error : 'Falha ao ler PDF';
      setStatus({ kind: 'error', message: msg });
      return;
    }

    setStatus({ kind: 'saving' });
    const form = parsedToFormInput(parsed.pedido, parsed.storage_path);
    const r = await criarPedidoAction(form, 'rascunho');

    if ('error' in r) {
      setStatus({ kind: 'error', message: r.error });
    } else if ('duplicate' in r) {
      setStatus({
        kind: 'duplicate',
        existingId: r.existing_id,
        existingNumero: r.existing_numero,
      });
    } else {
      setStatus({ kind: 'created', pedidoId: r.id, numero: r.numero });
    }
  } catch (err) {
    setStatus({ kind: 'error', message: (err as Error).message });
  }
}

function KpiMini({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <ContentCard className="p-3!">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </p>
      <p className={`text-xl font-heading font-bold mt-0.5 ${color}`}>{value}</p>
    </ContentCard>
  );
}

