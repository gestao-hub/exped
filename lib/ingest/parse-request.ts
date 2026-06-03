/**
 * Parser robusto do corpo de ingestão (endpoints /api/ingest/*). Aceita:
 *  - application/json: o corpo É o objeto de dados (agente sem PDF).
 *  - multipart/form-data: campo "dados" (JSON) + "file" (PDF opcional).
 *
 * Robustez: lê o corpo inteiro (`arrayBuffer`) e reparseia via `new Response(...)`
 * com o boundary normalizado (sem aspas). Isso evita as falhas observadas com o
 * multipart do .NET (`MultipartFormDataContent`) no `req.formData()` do Next sob
 * Node 20 — boundary entre aspas e/ou corpo em stream chunked.
 */
export type IngestParse =
  | { ok: true; dadosJson: unknown; file: File | null }
  | { ok: false; status: number; error: string };

export async function parseIngestRequest(req: Request): Promise<IngestParse> {
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      return { ok: true, dadosJson: await req.json(), file: null };
    } catch {
      return { ok: false, status: 400, error: 'JSON inválido' };
    }
  }

  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      const raw = await req.arrayBuffer();
      const ctNorm = contentType.replace(/boundary="([^"]*)"/i, 'boundary=$1');
      form = await new Response(raw, { headers: { 'content-type': ctNorm } }).formData();
    } catch {
      return { ok: false, status: 400, error: 'multipart inválido' };
    }
    const dadosRaw = form.get('dados');
    if (typeof dadosRaw !== 'string') {
      return { ok: false, status: 400, error: 'Campo "dados" (JSON) ausente' };
    }
    let dadosJson: unknown;
    try {
      dadosJson = JSON.parse(dadosRaw);
    } catch {
      return { ok: false, status: 400, error: '"dados" não é JSON válido' };
    }
    const fileVal = form.get('file');
    return { ok: true, dadosJson, file: fileVal instanceof File ? fileVal : null };
  }

  return { ok: false, status: 400, error: 'Esperado application/json ou multipart/form-data' };
}
