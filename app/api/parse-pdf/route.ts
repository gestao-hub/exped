import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { parseFranzoniErp } from '@/lib/parser/franzoni-erp';

export const runtime = 'nodejs'; // unpdf precisa de Node (não Edge)
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const BUCKET = 'pedidos-pdfs';

export async function POST(req: NextRequest) {
  // 1) Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }

  // 2) Recebe o arquivo
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Body inválido (esperado multipart/form-data)' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Campo "file" ausente' }, { status: 400 });
  }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'Arquivo precisa ser PDF' }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'PDF acima de 10 MB' }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 3) Extrai texto + parseia
  // unpdf é um wrapper de pdfjs feito pra rodar em serverless Node sem
  // depender de globals do browser (DOMMatrix, etc.) — diferente do pdf-parse v2.
  let text = '';
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text: pages } = await extractText(pdf, { mergePages: true });
    text = Array.isArray(pages) ? pages.join('\n') : (pages ?? '');
  } catch (err) {
    return NextResponse.json(
      { error: 'Falha ao ler PDF', detail: (err as Error).message },
      { status: 422 },
    );
  }

  const pedido = parseFranzoniErp(text);

  // 4) Upload pro Storage (path: {user_id}/{timestamp}-{nome})
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${user.id}/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (upErr) {
    // Mesmo se o upload falhar, devolvemos o parse — o vendedor revisa
    // sem perder o trabalho. O storage pode ser tentado de novo no save.
    return NextResponse.json({
      pedido,
      storage_path: null,
      storage_error: upErr.message,
    });
  }

  return NextResponse.json({ pedido, storage_path: storagePath });
}
