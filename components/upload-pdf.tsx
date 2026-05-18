'use client';

import { useCallback, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { FileText, Upload, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PedidoParsed } from '@/lib/parser/franzoni-erp';

type ParseResponse = {
  pedido: PedidoParsed;
  storage_path: string | null;
  storage_error?: string;
};

export function UploadPdf({
  onParsedAction,
}: {
  onParsedAction: (data: ParseResponse) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    if (rejected.length > 0) {
      toast.error(rejected[0].errors[0]?.message ?? 'Arquivo rejeitado');
      return;
    }
    setFile(accepted[0] ?? null);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    maxSize: 10 * 1024 * 1024,
    disabled: loading,
  });

  const onProcess = async () => {
    if (!file) return;
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
      onParsedAction(json);
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
          'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-franzoni-orange bg-franzoni-orange-50/50'
            : 'border-muted-foreground/25 hover:border-franzoni-orange/50 hover:bg-muted/30',
          loading && 'opacity-50 cursor-not-allowed',
        )}
      >
        <input {...getInputProps()} />
        <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <FileText className="h-5 w-5 text-franzoni-orange" />
            <span className="font-medium">{file.name}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
              }}
              disabled={loading}
              aria-label="Remover arquivo"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium">
              Arraste o PDF do pedido ou clique para selecionar
            </p>
            <p className="text-xs text-muted-foreground mt-1">PDF, máx. 10 MB</p>
          </>
        )}
      </div>

      <Button
        type="button"
        onClick={onProcess}
        disabled={!file || loading}
        className="w-full bg-franzoni-orange hover:bg-franzoni-orange-600"
      >
        {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Processar PDF
      </Button>
    </div>
  );
}
