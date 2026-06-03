import { describe, it, expect } from 'vitest';
import { parseIngestRequest } from '../parse-request';

function jsonReq(obj: unknown) {
  return new Request('http://x/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
}

function multipartReq(dados: unknown, boundary: string, quoted: boolean, withFile = false) {
  const CRLF = '\r\n';
  const parts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="dados"',
    'Content-Type: text/plain; charset=utf-8',
    '',
    JSON.stringify(dados),
  ];
  if (withFile) {
    parts.push(
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="nf.pdf"',
      'Content-Type: application/pdf',
      '',
      '%PDF-1.4 fake',
    );
  }
  parts.push(`--${boundary}--`, '');
  const ct = quoted
    ? `multipart/form-data; boundary="${boundary}"`
    : `multipart/form-data; boundary=${boundary}`;
  return new Request('http://x/api/ingest', { method: 'POST', headers: { 'content-type': ct }, body: parts.join(CRLF) });
}

describe('parseIngestRequest', () => {
  it('application/json: o corpo é o objeto de dados, sem file', async () => {
    const r = await parseIngestRequest(jsonReq({ a: 1, numero: 'L001' }));
    expect(r).toEqual({ ok: true, dadosJson: { a: 1, numero: 'L001' }, file: null });
  });

  it('multipart com boundary entre aspas (estilo .NET): extrai dados', async () => {
    const r = await parseIngestRequest(multipartReq({ b: 2 }, 'NextPart_abc', true));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dadosJson).toEqual({ b: 2 });
  });

  it('multipart com boundary sem aspas: extrai dados', async () => {
    const r = await parseIngestRequest(multipartReq({ b: 3 }, 'NextPart_abc', false));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dadosJson).toEqual({ b: 3 });
  });

  it('multipart com file: retorna o File', async () => {
    const r = await parseIngestRequest(multipartReq({ c: 4 }, 'bnd', true, true));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dadosJson).toEqual({ c: 4 });
      expect(r.file).toBeInstanceOf(File);
    }
  });

  it('multipart sem campo "dados": erro 400', async () => {
    const CRLF = '\r\n';
    const b = 'bnd';
    const body = [`--${b}`, 'Content-Disposition: form-data; name="outro"', '', 'x', `--${b}--`, ''].join(CRLF);
    const req = new Request('http://x', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body });
    const r = await parseIngestRequest(req);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('content-type não suportado: erro 400', async () => {
    const req = new Request('http://x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'oi' });
    const r = await parseIngestRequest(req);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});
