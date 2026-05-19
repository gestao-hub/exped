import { test, expect, type Page, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';

/**
 * Fluxo de entrega parcial — teste autocontido, faz login inline.
 *  1. vendas1 cria pedido com 10 TN areia → pendente
 *  2. logistica inicia separação
 *  3. logistica entrega 6 de 10 (parcial) via dialog
 *  4. status vira parcialmente_entregue
 *  5. vendas1 vê status novo
 *  6. logistica entrega o restante (4) → finalizado
 */

const SAMPLES_DIR = './.samples';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Franzoni@2026';
const EMAILS = {
  vendas1: process.env.VENDAS1_EMAIL ?? 'vendas1@franzoni.local',
  logistica: process.env.LOGISTICA_EMAIL ?? 'logistica@franzoni.local',
};

async function loginAs(browser: Browser, who: 'vendas1' | 'logistica'): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: process.env.BASE_URL ?? 'http://localhost:3030',
  });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(EMAILS[who]);
  await page.getByLabel(/senha/i).fill(PASSWORD);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL(/\/(vendas|logistica)/, { timeout: 20_000 });
  return page;
}

test.describe.configure({ mode: 'serial' });

test.describe('Entrega parcial — fluxo completo', () => {
  test.beforeAll(() => {
    mkdirSync(SAMPLES_DIR, { recursive: true });
  });

  let pedidoId = '';
  const docId = `QA-PARCIAL-${Date.now()}`;
  const pdfPath = `${SAMPLES_DIR}/${docId}.pdf`;

  test('vendas1 cria pedido (10 TN areia)', async ({ browser }) => {
    execFileSync('python3', ['scripts/make-sample-pdf-multi.py', pdfPath, docId], {
      stdio: 'inherit',
    });
    const page = await loginAs(browser, 'vendas1');
    await page.goto('/vendas/novo');
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page.getByRole('button', { name: /processar pdf/i }).click();
    await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /enviar para log[íi]stica/i }).click();
    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });
    pedidoId = page.url().split('/').pop()!;
    expect(pedidoId).toMatch(/^[0-9a-f-]{36}$/);
    await page.context().close();
  });

  test('logistica inicia separação', async ({ browser }) => {
    const page = await loginAs(browser, 'logistica');
    await page.goto(`/logistica/${pedidoId}`);
    await page.getByRole('button', { name: /iniciar separa[çc][aã]o/i }).click();
    await expect(page.getByText(/em separa[çc][aã]o/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('logistica registra entrega PARCIAL (6 de 10) → status vira parcialmente_entregue', async ({ browser }) => {
    const page = await loginAs(browser, 'logistica');
    await page.goto(`/logistica/${pedidoId}`);
    await page.getByRole('button', { name: /registrar entrega/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator('input[type="number"]').first().fill('6');
    await dialog.getByRole('button', { name: /registrar entrega/i }).click();

    await expect(page.getByText(/parcialmente entregue/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('vendas1 vê pedido como parcialmente_entregue', async ({ browser }) => {
    const page = await loginAs(browser, 'vendas1');
    await page.goto(`/vendas/${pedidoId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/parcialmente entregue/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('logistica entrega o restante (4) → finalizado', async ({ browser }) => {
    const page = await loginAs(browser, 'logistica');
    await page.goto(`/logistica/${pedidoId}`);
    await page.getByRole('button', { name: /registrar entrega/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /preencher tudo/i }).click();
    const inp = dialog.locator('input[type="number"]').first();
    await expect(inp).toHaveValue('4');
    await dialog.getByRole('button', { name: /registrar entrega/i }).click();

    await expect(page.getByText(/finalizado/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('vendas1 vê pedido finalizado', async ({ browser }) => {
    const page = await loginAs(browser, 'vendas1');
    await page.goto(`/vendas/${pedidoId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/finalizado/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test.afterAll(() => {
    if (existsSync(pdfPath)) unlinkSync(pdfPath);
  });
});
