'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UploadPdf } from '@/components/upload-pdf';
import { PedidoForm } from '@/components/pedido-form';
import { parsedToFormInput, emptyFormInput } from '@/lib/parser/to-form-input';
import type { PedidoFormInput } from '@/lib/validators/pedido';

export default function NovoPedidoPage() {
  const [defaults, setDefaults] = useState<PedidoFormInput | null>(null);

  if (defaults) {
    return (
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Revisar Pedido</h2>
            <p className="text-sm text-muted-foreground">
              Confira os dados extraídos antes de salvar.
            </p>
          </div>
          <Button variant="outline" onClick={() => setDefaults(null)}>
            ← Voltar ao upload
          </Button>
        </div>
        <PedidoForm defaultValues={defaults} />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Novo Pedido</CardTitle>
          <CardDescription>
            Faça upload do PDF do pedido emitido pelo ERP. Os dados serão extraídos
            automaticamente para revisão.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <UploadPdf
            onParsedAction={(data) =>
              setDefaults(parsedToFormInput(data.pedido, data.storage_path))
            }
          />

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex-1 border-t" />
            <span>ou</span>
            <div className="flex-1 border-t" />
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => setDefaults(emptyFormInput())}
          >
            Preencher manualmente (sem PDF)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
