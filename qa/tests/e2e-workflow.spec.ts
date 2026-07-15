import { test, expect, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { authStateFile } from './profiles';

/**
 * Workflow real da Franzoni:
 *  1. vendas1 cria um pedido (rascunho → pendente)
 *  2. vendas2 abre sua lista: NÃO deve ver o pedido (RLS isola por vendedor_id)
 *  3. vendas2 tenta abrir /vendas/<id-do-vendas1> direto: deve cair em notFound
 *  4. logistica abre a fila: DEVE ver o pedido (RLS libera pra logistica)
 *  5. logistica abre detalhe, inicia separação
 *  6. vendas1 recarrega e vê status "em separação"
 *  7. logistica finaliza
 *  8. vendas1 recarrega e vê status "finalizado"
 *  9. admin abre /historico: pedido aparece como finalizado
 * 10. cleanup: admin cancela o pedido
 */

const SAMPLES_DIR = './.samples';

test.describe.configure({ mode: 'serial' });

test.describe('E2E workflow real Franzoni (4 personas)', () => {
  test.beforeAll(() => {
    mkdirSync(SAMPLES_DIR, { recursive: true });
  });

  // Compartilhado entre os testes desse describe
  let pedidoId = '';
  const docId = `QA-E2E-${Date.now()}`;
  const pdfPath = `${SAMPLES_DIR}/${docId}.pdf`;

  test('vendas1 cria pedido (envia pra logística)', async ({ browser }) => {
    execFileSync('python3', ['scripts/make-sample-pdf.py', pdfPath, docId], {
      stdio: 'inherit',
    });

    const page = await openAs(browser, 'vendas1');
    await page.goto('/vendas/novo');
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page.getByRole('button', { name: /processar pdf/i }).click();

    await expect(page.getByText(/revisar pedido/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('input[name="documento_erp"]')).toHaveValue(docId);

    // Envia direto pra logística (pendente)
    await page.getByRole('button', { name: /enviar para log[íi]stica/i }).click();
    await page.waitForURL(/\/vendas\/[0-9a-f-]{36}/, { timeout: 15_000 });

    pedidoId = page.url().split('/').pop()!;
    expect(pedidoId).toMatch(/^[0-9a-f-]{36}$/);

    // Status visível no detalhe
    await expect(page.getByText(/pendente/i).first()).toBeVisible();
    await page.context().close();
  });

  test('vendas2 NÃO deve ver o pedido na lista (RLS isola por vendedor_id)', async ({ browser }) => {
    const page = await openAs(browser, 'vendas2');
    await page.goto('/vendas');
    // Espera tabela carregar
    await page.waitForLoadState('networkidle');
    // Verifica que o documento_erp criado pelo vendas1 NÃO aparece
    await expect(page.getByText(docId)).toHaveCount(0);
    await page.context().close();
  });

  test('vendas2 tenta acessar /vendas/<id-do-vendas1> direto → 404', async ({ browser }) => {
    const page = await openAs(browser, 'vendas2');
    const resp = await page.goto(`/vendas/${pedidoId}`);
    // A página chama notFound() quando RLS filtra → Next renderiza 404
    // (status pode ser 404 ou 200 com página /_not-found)
    const body = await page.locator('body').innerText();
    const looksLikeNotFound =
      /not found|n[ãa]o encontrado|404/i.test(body) ||
      resp?.status() === 404;
    expect(looksLikeNotFound, `vendas2 não deveria ver pedido alheio (body: ${body.slice(0, 80)}...)`)
      .toBe(true);
    await page.context().close();
  });

  test('logistica DEVE ver o pedido na fila', async ({ browser }) => {
    const page = await openAs(browser, 'logistica');
    await page.goto('/logistica');
    await page.waitForLoadState('networkidle');
    // Em desktop, a tabela <table> é visível e o card mobile é display:none.
    // Pega a célula dentro da tabela.
    await expect(
      page.locator('table').getByText(/QA AUTO TEST LTDA/i),
    ).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('logistica inicia separação', async ({ browser }) => {
    const page = await openAs(browser, 'logistica');
    await page.goto(`/logistica/${pedidoId}`);
    await page.getByRole('button', { name: /iniciar separa[çc][aã]o/i }).click();
    await expect(
      page.getByText(/em separa[çc][aã]o/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('vendas1 recarrega e vê status "em separação"', async ({ browser }) => {
    const page = await openAs(browser, 'vendas1');
    await page.goto(`/vendas/${pedidoId}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByText(/em separa[çc][aã]o/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('logistica preenche motorista e finaliza', async ({ browser }) => {
    const page = await openAs(browser, 'logistica');
    await page.goto(`/logistica/${pedidoId}`);

    // Preenche motorista (campo de texto)
    const motorista = page.locator('input[name="motorista"]');
    await motorista.fill('Motorista QA Test');
    await page.getByRole('button', { name: /^salvar$/i }).click();
    await page.waitForTimeout(1000);

    // Finaliza
    await page.getByRole('button', { name: /marcar como finalizado/i }).click();
    await expect(page.getByText(/finalizado/i).first()).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('vendas1 vê pedido como "finalizado" + aparece no histórico', async ({ browser }) => {
    const page = await openAs(browser, 'vendas1');
    await page.goto(`/vendas/${pedidoId}`);
    await expect(page.getByText(/finalizado/i).first()).toBeVisible({ timeout: 10_000 });

    // Histórico
    await page.goto('/historico');
    await page.waitForLoadState('networkidle');
    // Em desktop, a tabela <table> é visível e o card mobile é display:none.
    // Pega a célula dentro da tabela.
    await expect(
      page.locator('table').getByText(/QA AUTO TEST LTDA/i),
    ).toBeVisible({ timeout: 10_000 });
    await page.context().close();
  });

  test('admin vê tudo + dados de motorista preenchidos', async ({ browser }) => {
    const page = await openAs(browser, 'admin');
    await page.goto(`/vendas/${pedidoId}`);
    await expect(page.getByText('Motorista QA Test').first()).toBeVisible({
      timeout: 10_000,
    });
    await page.context().close();
  });

  test.afterAll(async ({ browser }) => {
    // Cleanup do PDF local
    if (existsSync(pdfPath)) unlinkSync(pdfPath);
    // O cleanup do pedido vai ser feito via API depois (mais confiável que UI)
  });
});

// Helper: abre página com storageState do perfil
async function openAs(
  browser: Browser,
  profile: 'admin' | 'vendas1' | 'vendas2' | 'vendas3' | 'vendas4' | 'logistica',
) {
  const ctx = await browser.newContext({
    storageState: authStateFile(profile),
    baseURL: process.env.BASE_URL ?? 'https://franzoni.vercel.app',
  });
  return ctx.newPage();
}
