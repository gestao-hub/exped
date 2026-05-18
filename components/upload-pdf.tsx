'use client';

import { useCallback, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import {
  FileText,
  Upload,
  Loader2,
  X,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PedidoParsed } from '@/lib/parser/franzoni-erp';

type ParseResponse = {
  pedido: PedidoParsed;
  storage_path: string | null;
  storage_error?: string;
};

export type SingleParseResult = ParseResponse & { file: File };

export type BulkItemStatus =
  | { kind: 'pending' }
  | { kind: 'parsing' }
  | { kind: 'saving' }
  | { kind: 'created'; pedidoId: string; numero: number }
  | { kind: 'duplicate'; existingId: string; existingNumero: number }
  | { kind: 'error'; message: string };

export type BulkItem = {
  id: string;
  file: File;
  status: BulkItemStatus;
};

export function UploadPdf({
  onParsedAction,
  onBulkStartAction,
}: {
  /** Chamado quando exatamente 1 arquivo é processado (fluxo de revisão). */
  onParsedAction: (data: SingleParseResult) => void;
  /** Chamado quando 2+ arquivos foram droppados (modo lote). Recebe a lista de arquivos. */
  onBulkStartAction: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    if (rejected.length > 0) {
      toast.error(rejected[0].errors[0]?.message ?? 'Arquivo rejeitado');
    }
    if (accepted.length > 0) {
      // dedup por nome + tamanho (no client; banco re-checa por documento_erp)
      setFiles((prev) => {
        const map = new Map(prev.map((f) => [`${f.name}-${f.size}`, f]));
        for (const f of accepted) {
          map.set(`${f.name}-${f.size}`, f);
        }
        return Array.from(map.values());
      });
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: true,
    maxSize: 10 * 1024 * 1024,
    disabled: loading,
  });

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const onProcess = async () => {
    if (files.length === 0) return;
    if (files.length > 1) {
      // modo lote: a página assume o controle
      onBulkStartAction(files);
      return;
    }
    // 1 arquivo → parse e devolve pro fluxo de revisão
    const file = files[0];
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/parse-pdf', { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as
        | ParseResponse
        | { error: string; detail?: string };

      if (!res.ok || 'error' in json) {
        toast.error(
          'error' in json
            ? `${json.error}${'detail' in json && json.detail ? `: ${json.detail}` : ''}`
            : 'Falha ao processar PDF',
        );
        return;
      }

      if (json.storage_error) {
        toast.warning(`PDF parseado, mas não salvo no storage: ${json.storage_error}`);
      } else {
        toast.success('PDF processado!');
      }
      onParsedAction({ ...json, file });
    } catch (err) {
      toast.error(`Erro: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-franzoni-orange bg-franzoni-orange-50/50'
            : 'border-muted-foreground/25 hover:border-franzoni-orange/50 hover:bg-muted/30',
          loading && 'opacity-50 cursor-not-allowed',
        )}
      >
        <input {...getInputProps()} />
        <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
        {files.length > 0 ? (
          <p className="text-sm font-medium">
            {files.length} arquivo{files.length === 1 ? '' : 's'} pronto
            {files.length === 1 ? '' : 's'} para processar.{' '}
            <span className="text-muted-foreground">
              Clique ou arraste pra adicionar mais.
            </span>
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">
              Arraste o(s) PDF(s) do pedido ou clique para selecionar
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              PDF, máx. 10 MB por arquivo · pode soltar vários ao mesmo tempo
            </p>
          </>
        )}
      </div>

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/40 border border-border/60"
            >
              <FileText className="h-4 w-4 text-franzoni-orange shrink-0" />
              <span className="flex-1 text-sm truncate">{f.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {(f.size / 1024).toFixed(0)} KB
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeFile(i)}
                disabled={loading}
                aria-label="Remover"
                className="h-7 w-7"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        onClick={onProcess}
        disabled={files.length === 0 || loading}
        className="w-full bg-franzoni-orange hover:bg-franzoni-orange-600"
      >
        {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {files.length > 1 ? `Processar ${files.length} PDFs em lote` : 'Processar PDF'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lista de status em modo lote (renderizada pela página /vendas/novo)
// ---------------------------------------------------------------------------

export function BulkProgressList({ items }: { items: BulkItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center gap-3 px-3 py-2.5 rounded-md border border-border/60 bg-card/60"
        >
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-sm truncate font-medium">{item.file.name}</span>
          <StatusPill status={item.status} />
        </li>
      ))}
    </ul>
  );
}

function StatusPill({ status }: { status: BulkItemStatus }) {
  switch (status.kind) {
    case 'pending':
      return <span className="text-xs text-muted-foreground">Na fila</span>;
    case 'parsing':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-status-separacao">
          <Loader2 className="h-3 w-3 animate-spin" /> Lendo PDF…
        </span>
      );
    case 'saving':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-status-separacao">
          <Loader2 className="h-3 w-3 animate-spin" /> Salvando…
        </span>
      );
    case 'created':
      return (
        <a
          href={`/vendas/${status.pedidoId}`}
          className="inline-flex items-center gap-1.5 text-xs text-status-finalizado hover:underline"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Criado #{status.numero}
        </a>
      );
    case 'duplicate':
      return (
        <a
          href={`/vendas/${status.existingId}`}
          className="inline-flex items-center gap-1.5 text-xs text-status-pendente hover:underline"
          title="Já existe pedido com este documento ERP"
        >
          <Copy className="h-3.5 w-3.5" /> Duplicado · existe #{status.existingNumero}
        </a>
      );
    case 'error':
      return (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-destructive max-w-[16rem] truncate"
          title={status.message}
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {status.message}
        </span>
      );
    default:
      return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
  }
}
