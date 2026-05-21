import { test, expect, type Page, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';

/**
 * Dedup cross-vendedor: o índice único de documento_erp é global, mas o
 * dedup amigável roda sob RLS (vendedor só vê os próprios pedidos). Quando
 * vendas2 sobe um documento que vendas1 já tem, antes vazava o erro cru do
 * Postgres ("duplicate key value violates unique constraint"). Agora deve
 * mostrar mensagem amigável.
 *
 *  1. vendas1 cria pedido com documento_erp fixo (envia pra logística)
 *  2. vendas2 sobe PDF com o MESMO documento → mensagem amigável, sem erro cru
 */

const SAMPLES_DIR = './.samples';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Franzoni@2026';
const EMAILS = {
  vendas1: process.env.VENDAS1_EMAIL ?? 'vendas1@franzoni.local',
  vendas2: process.env.VENDAS2_EMAIL ?? 'vendas2@franzoni.local',
};

async function loginAs(browser: Browser, who: 'vendas1' | 'vendas2'): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3030',
  });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(EMAILS[who]);
  await page.getByLabel(/senha/i).fill(PASSWORD);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL(/\/vendas/, { timeout: 20_000 });
  return page;
}

async function parseEReview(page: Page, pdfPath: string) {
  await page.goto('/vendas/novo');
  await page.locator('input[type="file"]').setInputFiles(pdfPath);
  await page.getByRole('button', { name: /processar pdf/i }).click();
  await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Dedup cross-vendedor (documento_erp global)', () => {
  test.beforeAll(() => mkdirSync(SAMPLES_DIR, { recursive: true }));

  const docId = `QA-DUP-${Date.now()}`;
  const pdf1 = `${SAMPLES_DIR}/${docId}-A.pdf`;
  const pdf2 = `${SAMPLES_DIR}/${docId}-B.pdf`;

  test('vendas1 cria o pedido original', async ({ browser }) => {
    execFileSync('python3', ['scripts/make-sample-pdf.py', pdf1, docId], { stdio: 'inherit' });
    const page = await loginAs(browser, 'vendas1');
    await parseEReview(page, pdf1);
    await page.getByRole('button', { name: /enviar para log[íi]stica/i }).click();
    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await page.context().close();
  });

  test('vendas2 tenta o mesmo documento → mensagem amigável, sem erro cru', async ({ browser }) => {
    execFileSync('python3', ['scripts/make-sample-pdf.py', pdf2, docId], { stdio: 'inherit' });
    const page = await loginAs(browser, 'vendas2');
    await parseEReview(page, pdf2);
    await page.getByRole('button', { name: /enviar para log[íi]stica/i }).click();

    // Mensagem amigável aparece
    await expect(
      page.getByText(/já existe um pedido ativo com o documento/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // E o erro cru do Postgres NÃO aparece em lugar nenhum
    await expect(page.getByText(/duplicate key value|violates unique constraint/i)).toHaveCount(0);
    await page.context().close();
  });

  test.afterAll(() => {
    for (const p of [pdf1, pdf2]) if (existsSync(p)) unlinkSync(p);
  });
});
