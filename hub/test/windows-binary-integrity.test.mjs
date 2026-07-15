import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function expectOrder(text, needles) {
  const positions = needles.map((needle) => text.indexOf(needle));
  expect(positions.every((position) => position >= 0), `itens ausentes: ${needles}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe('integridade dos binarios nativos do instalador Windows', () => {
  const script = source('../win/download-binaries.ps1');

  it('fixa versoes e SHA-256 de todos os artefatos baixados', () => {
    expect(script).toContain("[string]$PgVersion        = '16.14-1'");
    expect(script).toContain("[string]$PostgrestVersion = 'v14.12'");
    expect(script).toContain("[string]$NodeVersion      = 'v24.18.0'");
    expect(script).toContain("[string]$NssmVersion      = '2.24'");

    expect(script).toContain("[string]$PgSha256         = '98af1417ba6a8dc30543e560e5407833a3b9e7cc7ed20e73b2006f3aa2f04663'");
    expect(script).toContain("[string]$PostgrestSha256  = '0265772defae0fc24615ccb1e5a40c3f81d59f8f2fbc57ab20ac8e1d1aa7d0a3'");
    expect(script).toContain("[string]$NodeSha256       = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'");
    expect(script).toContain("[string]$NssmSha256       = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743'");
    expect(script).toContain("[string]$NssmExeSha256    = 'f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97'");
  });

  it('torna a validacao obrigatoria e a executa antes de cada extracao', () => {
    expect(script).toMatch(/function Assert-Sha256\b/);
    expect(script).not.toMatch(/pular a verifica[cç][aã]o|if \(\$NodeSha256\)/i);

    expectOrder(script, [
      'Invoke-WebRequest -Uri $pgUrl -OutFile $pgZip',
      'Assert-Sha256 -Path $pgZip -Expected $PgSha256',
      'Expand-Archive -LiteralPath $pgZip',
    ]);
    expectOrder(script, [
      'Invoke-WebRequest -Uri $prUrl -OutFile $prZip',
      'Assert-Sha256 -Path $prZip -Expected $PostgrestSha256',
      'Expand-Archive -LiteralPath $prZip',
    ]);
    expectOrder(script, [
      'Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip',
      'Assert-Sha256 -Path $nodeZip -Expected $NodeSha256',
      'Expand-Archive -LiteralPath $nodeZip',
    ]);
    expectOrder(script, [
      'Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip',
      'Assert-Sha256 -Path $nssmZip -Expected $NssmSha256',
      'Expand-Archive -LiteralPath $nssmZip',
    ]);
  });

  it('tambem valida o executavel NSSM pre-empacotado e o extraido', () => {
    const checks = script.match(/Assert-Sha256 -Path \$nssmExe -Expected \$NssmExeSha256/g) ?? [];
    expect(checks).toHaveLength(2);
  });
});

describe('cadeia de build do instalador Windows', () => {
  const workflow = source('../../.github/workflows/build-installer.yml');

  it('fixa actions e toolchains em revisoes exatas', () => {
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain('actions/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9');
    expect(workflow).toContain('actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).toContain("node-version: '24.18.0'");
    expect(workflow).toContain("dotnet-version: '8.0.423'");
    expect(workflow).toContain("go-version: '1.25.8'");
  });

  it('faz checkout do GoTrue por commit imutavel e sem cache de binario', () => {
    expect(workflow).toContain('AUTH_COMMIT_1: 4fa66ba7');
    expect(workflow).toContain('AUTH_COMMIT_2: 1d8c55b5');
    expect(workflow).toContain('AUTH_COMMIT_3: c95cd563');
    expect(workflow).toContain('AUTH_COMMIT_4: 5766ed8b');
    expect(workflow).toContain('AUTH_COMMIT_5: bae6d96a');
    expect(workflow).toContain(
      'AUTH_COMMIT="${AUTH_COMMIT_1}${AUTH_COMMIT_2}${AUTH_COMMIT_3}${AUTH_COMMIT_4}${AUTH_COMMIT_5}"',
    );
    expect(workflow).toMatch(/git fetch --depth 1 origin "\$AUTH_COMMIT"/);
    expect(workflow).toMatch(/git rev-parse HEAD/);
    expect(workflow).not.toContain('actions/cache@');
    expect(workflow).not.toMatch(/git clone[^\n]+--branch/);
  });

  it('verifica mkcert e Inno Setup antes de executar os artefatos', () => {
    expectOrder(workflow, [
      'curl.exe -fL --retry 3 -o mkcert.exe',
      "Assert-Sha256 'mkcert.exe' 'd2660b50a9ed59eada480750561c96abc2ed4c9a38c6a24d93e30e0977631398'",
      'node scripts/montar-payload.mjs',
    ]);
    expectOrder(workflow, [
      'curl.exe -fL --retry 3 -o innosetup.exe',
      "Assert-Sha256 'innosetup.exe' '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'",
      'Start-Process -FilePath .\\innosetup.exe',
    ]);
    expect(workflow).not.toMatch(/choco(?:latey)?\s+install/i);
  });
});
