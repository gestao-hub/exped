import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const contractUrl = new URL('../win/agent-sync-contract.mjs', import.meta.url);
let contract;

beforeAll(async () => {
  expect(existsSync(contractUrl), 'helper puro do contrato Windows deve existir').toBe(true);
  if (existsSync(contractUrl)) contract = await import(contractUrl.href);
});

describe('contrato da porta do agente', () => {
  it('resolve default, custom e zero e rejeita portas inválidas', () => {
    expect(contract.resolveSyncNowPort({})).toBe(5005);
    expect(contract.resolveSyncNowPort({ agent: { syncNowPort: 6005 } })).toBe(6005);
    expect(contract.resolveSyncNowPort({ agent: { syncNowPort: 0 } })).toBe(0);
    expect(() => contract.resolveSyncNowPort({ agent: { syncNowPort: 65536 } })).toThrow();
    expect(() => contract.resolveSyncNowPort({ agent: { syncNowPort: '5005' } })).toThrow();
  });
});

describe('plano de URL ACL', () => {
  const userSid = 'S-1-5-21-111-222-333-1001';
  const sddl = `D:(A;;GX;;;${userSid})`;

  it('adiciona a reserva default para o SID exato', () => {
    expect(
      contract.planUrlAclTransition({ desiredPort: 5005, userSid }),
    ).toEqual([
      {
        action: 'add',
        args: ['http', 'add', 'urlacl', 'url=http://127.0.0.1:5005/', `sddl=${sddl}`],
        showArgs: ['http', 'show', 'urlacl', 'url=http://127.0.0.1:5005/'],
        expectedSddl: sddl,
      },
    ]);
  });

  it('move com segurança: adiciona custom antes de remover a reserva anterior', () => {
    expect(
      contract.planUrlAclTransition({
        previousPort: 5005,
        previousUserSid: userSid,
        desiredPort: 6005,
        userSid,
      }),
    ).toEqual([
      {
        action: 'add',
        args: ['http', 'add', 'urlacl', 'url=http://127.0.0.1:6005/', `sddl=${sddl}`],
        showArgs: ['http', 'show', 'urlacl', 'url=http://127.0.0.1:6005/'],
        expectedSddl: sddl,
      },
      {
        action: 'delete',
        args: ['http', 'delete', 'urlacl', 'url=http://127.0.0.1:5005/'],
        showArgs: ['http', 'show', 'urlacl', 'url=http://127.0.0.1:5005/'],
        expectedSddl: sddl,
        tolerateMissing: true,
      },
    ]);
  });

  it('zero remove a reserva anterior e zero repetido não faz nada', () => {
    expect(
      contract.planUrlAclTransition({
        previousPort: 6005,
        previousUserSid: userSid,
        desiredPort: 0,
      }),
    ).toEqual([
      {
        action: 'delete',
        args: ['http', 'delete', 'urlacl', 'url=http://127.0.0.1:6005/'],
        showArgs: ['http', 'show', 'urlacl', 'url=http://127.0.0.1:6005/'],
        expectedSddl: sddl,
        tolerateMissing: true,
      },
    ]);
    expect(contract.planUrlAclTransition({ previousPort: 0, desiredPort: 0 })).toEqual([]);
  });

  it('rerun idempotente garante a reserva sem apagar e recriar', () => {
    expect(
      contract.planUrlAclTransition({
        previousPort: 5005,
        previousUserSid: userSid,
        desiredPort: 5005,
        userSid,
      }),
    ).toEqual([
      {
        action: 'ensure',
        showArgs: ['http', 'show', 'urlacl', 'url=http://127.0.0.1:5005/'],
        addArgs: ['http', 'add', 'urlacl', 'url=http://127.0.0.1:5005/', `sddl=${sddl}`],
        expectedSddl: sddl,
      },
    ]);
  });

  it('aceita somente o SDDL exato; outro SID ou ACE extra é conflito', () => {
    expect(contract.reservationMatchesExpectedSddl(`SDDL: ${sddl}\r\n`, sddl)).toBe(true);
    expect(
      contract.reservationMatchesExpectedSddl(
        'SDDL: D:(A;;GX;;;S-1-5-21-111-222-333-1002)\r\n',
        sddl,
      ),
    ).toBe(false);
    expect(
      contract.reservationMatchesExpectedSddl(
        `SDDL: ${sddl}(A;;GX;;;S-1-1-0)\r\n`,
        sddl,
      ),
    ).toBe(false);
  });

  it('troca o SID na mesma porta e rejeita identidade não-SID', () => {
    const oldSid = 'S-1-5-21-111-222-333-1000';
    const plan = contract.planUrlAclTransition({
      previousPort: 5005,
      previousUserSid: oldSid,
      desiredPort: 5005,
      userSid,
    });
    expect(plan.map((step) => step.action)).toEqual(['delete', 'add']);
    expect(plan[1]).toMatchObject({
      rollbackArgs: [
        'http',
        'add',
        'urlacl',
        'url=http://127.0.0.1:5005/',
        `sddl=D:(A;;GX;;;${oldSid})`,
      ],
      rollbackExpectedSddl: `D:(A;;GX;;;${oldSid})`,
    });
    expect(() => contract.planUrlAclTransition({ desiredPort: 5005, userSid: 'Users' })).toThrow();
    expect(() => contract.planUrlAclTransition({ previousPort: 5005, desiredPort: 0 })).toThrow(
      /previousUserSid/,
    );
  });

  it('CLI emite o mesmo plano consumido pelo PowerShell', () => {
    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(contractUrl), 'urlacl-plan', '5005', userSid, '6005', userSid],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(stdout).map((step) => step.action)).toEqual(['add', 'delete']);

    const initial = execFileSync(
      process.execPath,
      [fileURLToPath(contractUrl), 'urlacl-plan', '0', '-', '5005', userSid],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(initial).map((step) => step.action)).toEqual(['add']);

    const disabled = execFileSync(
      process.execPath,
      [fileURLToPath(contractUrl), 'urlacl-plan', '5005', userSid, '0', '-'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(disabled).map((step) => step.action)).toEqual(['delete']);
  });
});

describe('importação conservadora do recibo do agente', () => {
  const oldSid = 'S-1-5-21-111-222-333-1000';
  const newSid = 'S-1-5-21-111-222-333-1001';
  const oldPath = 'C:\\Users\\old\\AppData\\Local\\ExpedAgent\\appsettings.json';
  const newPath = 'C:\\Users\\new\\AppData\\Local\\ExpedAgent\\appsettings.json';

  it('aceita primeiro install e reinstalação do mesmo path/SID', () => {
    expect(
      contract.validateAgentReceiptTransition({
        receiptSettingsPath: oldPath,
        receiptUserSid: oldSid,
      }),
    ).toEqual({ settingsPath: oldPath, userSid: oldSid });
    expect(
      contract.validateAgentReceiptTransition({
        existingSettingsPath: oldPath.toUpperCase(),
        existingUserSid: oldSid.toLowerCase(),
        receiptSettingsPath: oldPath,
        receiptUserSid: oldSid,
      }),
    ).toEqual({ settingsPath: oldPath, userSid: oldSid });
  });

  it('migra legado sem userSid somente com path exato e owner SID coerente', () => {
    expect(
      contract.validateAgentReceiptTransition({
        existingSettingsPath: oldPath,
        existingSettingsOwnerSid: oldSid,
        receiptSettingsPath: oldPath,
        receiptUserSid: oldSid,
      }),
    ).toEqual({ settingsPath: oldPath, userSid: oldSid });
    expect(() => contract.validateAgentReceiptTransition({
      existingSettingsPath: oldPath,
      receiptSettingsPath: oldPath,
      receiptUserSid: oldSid,
    })).toThrow(/owner SID/i);
    expect(() => contract.validateAgentReceiptTransition({
      existingSettingsPath: oldPath,
      existingSettingsOwnerSid: newSid,
      receiptSettingsPath: oldPath,
      receiptUserSid: oldSid,
    })).toThrow(/desinstale.*migre/i);
  });

  it('rejeita troca de SID ou path sem migração/desinstalação explícita', () => {
    expect(() => contract.validateAgentReceiptTransition({
      existingSettingsPath: oldPath,
      existingUserSid: oldSid,
      receiptSettingsPath: newPath,
      receiptUserSid: oldSid,
    })).toThrow(/desinstale.*migre/i);
    expect(() => contract.validateAgentReceiptTransition({
      existingSettingsPath: oldPath,
      existingUserSid: oldSid,
      receiptSettingsPath: oldPath,
      receiptUserSid: newSid,
    })).toThrow(/desinstale.*migre/i);
  });

  it('expõe a mesma política na CLI consumida pelos dois passos do instalador', () => {
    const accepted = execFileSync(
      process.execPath,
      [fileURLToPath(contractUrl), 'receipt-transition', oldPath, oldSid, '-', oldPath, oldSid],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(accepted)).toEqual({ settingsPath: oldPath, userSid: oldSid });

    expect(() => execFileSync(
      process.execPath,
      [fileURLToPath(contractUrl), 'receipt-transition', oldPath, oldSid, '-', newPath, newSid],
      { encoding: 'utf8', stdio: 'pipe' },
    )).toThrow();
  });
});
