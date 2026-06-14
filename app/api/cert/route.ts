import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve o certificado raiz da loja (rootCA-Exped.crt) para instalação nas máquinas da LAN.
 * Existe SÓ no HUB (o mkcert gera o rootCA na instalação, copiado para a raiz C:\Exped); na
 * nuvem não há arquivo → 404. Público de propósito (CA cert é feito pra ser distribuído) e
 * sob /api/* (fora do middleware de login). O app roda com cwd = raiz do hub (C:\Exped).
 *
 * Uso (em cada PC, baixa ignorando o cert ainda-não-confiável e instala):
 *   curl.exe -k -s -o "$env:TEMP\rootCA-Exped.crt" "https://<ip>/api/cert"
 *   Import-Certificate -FilePath "$env:TEMP\rootCA-Exped.crt" -CertStoreLocation Cert:\LocalMachine\Root
 */
const CANDIDATOS = [
  process.env.EXPED_CA_FILE,
  path.join(process.cwd(), 'rootCA-Exped.crt'),
  'C:\\Exped\\rootCA-Exped.crt',
].filter((p): p is string => Boolean(p));

export async function GET() {
  for (const p of CANDIDATOS) {
    try {
      const buf = await readFile(p);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="rootCA-Exped.crt"',
          'cache-control': 'no-store',
        },
      });
    } catch {
      // arquivo ausente nesse caminho — tenta o próximo
    }
  }
  return new NextResponse(
    'Certificado não disponível neste servidor (rota válida só no hub local).',
    { status: 404 },
  );
}
