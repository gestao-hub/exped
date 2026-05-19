import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { authStateFile } from './profiles';

const SAMPLES_DIR = './.samples';

test.describe('Upload PDF (vendedor) — CRUD com cleanup', () => {
  test.use({ storageState: authStateFile('vendas1') });

  test.beforeAll(() => {
    mkdirSync(SAMPLES_DIR, { recursive: true });
  });

  test('upload → revisar → salvar rascunho → cancelar', async ({ page }) => {
    const docId = `QA-${Date.now()}`;
    const pdfPath = `${SAMPLES_DIR}/${docId}.pdf`;

    // Gera PDF (execFile, sem shell — args sanitizados via docId Date.now())
    execFileSync('python3', ['scripts/make-sample-pdf.py', pdfPath, docId], { stdio: 'inherit' });
    expect(existsSync(pdfPath), 'PDF gerado').toBe(true);

    await page.goto('/vendas/novo', { waitUntil: 'networkidle' });
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page.getByRole('button', { name: /processar pdf/i }).click();

    await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[name="documento_erp"]')).toHaveValue(docId);

    await page.getByRole('button', { name: /salvar rascunho/i }).click();
    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });
    const pedidoUrl = page.url();

    // Cleanup
    await page.getByRole('button', { name: /cancelar pedido/i }).click();
    page.once('dialog', (d) => d.accept());
    await page.waitForTimeout(1500);

    if (existsSync(pdfPath)) unlinkSync(pdfPath);
    expect(pedidoUrl).toBeTruthy();
  });

  test('upload do mesmo documento_erp → leva pro pedido existente', async ({ page }) => {
    const docId = `QA-DUP-${Date.now()}`;
    const pdfPath = `${SAMPLES_DIR}/${docId}.pdf`;
    execFileSync('python3', ['scripts/make-sample-pdf.py', pdfPath, docId], { stdio: 'inherit' });

    await page.goto('/vendas/novo');
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page.getByRole('button', { name: /processar pdf/i }).click();
    await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /salvar rascunho/i }).click();
    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });
    const firstUrl = page.url();

    await page.goto('/vendas/novo');
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page.getByRole('button', { name: /processar pdf/i }).click();
    await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /salvar rascunho/i }).click();

    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });
    expect(page.url(), 'redireciona pro pedido existente').toBe(firstUrl);

    // Cleanup
    await page.goto(firstUrl);
    await page.getByRole('button', { name: /cancelar pedido/i }).click();
    page.once('dialog', (d) => d.accept());
    await page.waitForTimeout(1500);
    if (existsSync(pdfPath)) unlinkSync(pdfPath);
  });
});
