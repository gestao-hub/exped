import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8').replace(/\r\n?/g, '\n');
const dbScriptPath = 'scripts/test-supabase-local.sh';

describe('CI do banco e supply chain', () => {
  it('fixa actions por SHA e concede somente leitura ao conteudo', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@(v\d+|main|master|latest)\b/);
  });

  it('executa migracoes, pgTAP, lint e concorrencia PostgreSQL real', () => {
    expect(workflow).toContain('supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520');
    expect(workflow).toContain('version: 2.109.1');
    expect(workflow).toContain(`run: ${dbScriptPath}`);

    const script = readFileSync(dbScriptPath, 'utf8').replace(/\r\n?/g, '\n');
    expect(script).toContain('supabase/migrations/*.sql');
    expect(script).toContain('supabase test db');
    expect(script).toContain('supabase db lint');
    expect(script).toContain('sync-db-concurrency.test.mjs');
    expect(script).toContain('release-hub-postgres-concurrency.test.mjs');
    expect(script).toContain('supabase stop');
  });

  it('valida o Agent e os scripts no Windows PowerShell 5.1 em pull requests', () => {
    expect(workflow).toMatch(/\n  windows:\n/);
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain(
      'actions/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9',
    );
    expect(workflow).toContain("dotnet-version: '8.0.423'");
    expect(workflow).toContain(
      'dotnet test agent/ExpedAgent.Tests/ExpedAgent.Tests.csproj --configuration Release',
    );
    expect(workflow).toContain('Test release contracts on Windows');
    expect(workflow).toMatch(
      /name: Install pinned Info-ZIP[\s\S]*choco install zip --version=3\.0\.0\.20251001 --yes --no-progress/,
    );
    expect(workflow).toContain('EXPED_ZIP_COMMAND=');
    expect(workflow).toContain('$env:GITHUB_ENV');
    expect(workflow).toContain(
      'npx vitest run scripts/__tests__/release-hub.test.mjs scripts/__tests__/ci-workflow.test.mjs hub/test/windows-installer-transaction.test.mjs hub/test/updater.test.mjs',
    );
    expect(workflow).toContain('shell: powershell');
    expect(workflow).toContain('$PSVersionTable.PSVersion.Major -ne 5');
  });
});
