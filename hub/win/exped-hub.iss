; ============================================================================
;  Exped Hub — instalador Inno Setup 6
; ----------------------------------------------------------------------------
;  Empacota o hub local do Exped (pilha Supabase nativa + app Next standalone)
;  e o instala em C:\Exped, registrando o serviço Windows "ExpedHub".
;
;  COMO COMPILAR (no Windows, com Inno Setup 6 instalado):
;      ISCC.exe hub\win\exped-hub.iss
;  -> gera Output\ExpedHubSetup.exe
;
;  PRE-REQUISITO: a pasta de payload precisa estar montada ANTES de compilar.
;  Por padrao este script espera "hub\win\payload\" com o layout abaixo (veja o
;  README.md, secao "Pre-build", pro passo-a-passo de o que copiar de onde):
;
;      payload\
;        hub\                 <- conteudo de hub\ (maestro.mjs, supervisor.mjs, ...)
;        scripts\local-stack\ <- *.sql, gateway.mjs, make-keys.sh, postgrest.conf
;        app\                 <- .next\standalone\* + .next\static + public (app Next)
;        bin\auth.exe         <- GoTrue cross-compilado win-x64
;        bin\migrations\      <- migrations do GoTrue
;        config.json          <- gerado do config.example.json (jwtSecret trocado no install)
;
;  Postgres / PostgREST / Node / NSSM NAO vao no payload (binarios grandes):
;  sao baixados em [Code] por download-binaries.ps1. Para fazer um instalador
;  "offline" (pre-bundlado), copie esses binarios pra payload\bin\ antes de
;  compilar e remova a chamada de download em CurStepChanged.
; ============================================================================

#define MyAppName "Exped Hub"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "Exped"
; Raiz fixa C:\Exped (convencao do hub; maestro.mjs resolve paths a partir dela).
#define InstallRoot "C:\Exped"
; Pasta de payload relativa a este .iss (hub\win\).
#define Payload "payload"

[Setup]
AppId=Exped Hub
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Instala SEMPRE em C:\Exped (o hub assume essa raiz; nao deixamos o usuario mudar).
DefaultDirName={#InstallRoot}
DisableDirPage=yes
DisableProgramGroupPage=yes
; Serviço Windows + firewall exigem elevacao.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=ExpedHubSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; AVISO: este .exe NAO é assinado. Windows SmartScreen vai alertar.
; Ver README.md (troubleshooting) sobre assinatura de codigo (signtool).

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Dirs]
; Diretorios de runtime criados no install (vazios). data\ e logs\ ficam fora
; do empacotamento e sao preservados em desinstalacoes (ver [UninstallDelete]).
Name: "{app}\data";     Flags: uninsneveruninstall
Name: "{app}\logs";     Flags: uninsneveruninstall
Name: "{app}\releases"; Flags: uninsneveruninstall
Name: "{app}\bin"

[Files]
; --- App Next standalone (payload\app -> C:\Exped\app) -----------------------
; payload\app deve conter: server.js + node_modules do standalone, a pasta
; .next\static (em app\.next\static) e public\ (em app\public). Ver README.
Source: "{#Payload}\app\*";                 DestDir: "{app}\app";   Flags: recursesubdirs createallsubdirs ignoreversion

; --- Hub Node (maestro/supervisor/health/storage/bootstrap/config/updater) ---
Source: "{#Payload}\hub\*";                 DestDir: "{app}\hub";   Flags: recursesubdirs createallsubdirs ignoreversion
; Substitui o watchdog legado em C:\Exped por uma versao somente diagnostica.
Source: "{#Payload}\hub\watchdog.ps1";      DestDir: "{app}";       Flags: ignoreversion

; --- Local-stack: SQL de bootstrap + gateway + scripts auxiliares -----------
; Inclui o gotrue.env (lido por hub/bootstrap.mjs em scripts\local-stack\gotrue.env
; para o `auth migrate`). Garanta que payload\scripts\local-stack\gotrue.env exista
; (ver README, Fase 1.3).
Source: "{#Payload}\scripts\local-stack\*"; DestDir: "{app}\scripts\local-stack"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- Migrations do APP (supabase\migrations\*.sql) --------------------------
; O maestro/bootstrap aplica essas no 1o start (hub/config.mjs migrationsDir =
; supabase/migrations, relativo a C:\Exped). SEM elas o bootstrap do schema falha.
Source: "{#Payload}\supabase\migrations\*"; DestDir: "{app}\supabase\migrations"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- GoTrue (auth.exe + migrations) — vem do payload, NAO é baixado ---------
Source: "{#Payload}\bin\auth.exe";          DestDir: "{app}\bin";   Flags: ignoreversion
Source: "{#Payload}\bin\migrations\*";      DestDir: "{app}\bin\migrations"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- Scripts de servico/download (ficam em C:\Exped\hub\win pra reuso) -------
Source: "download-binaries.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "install-service.ps1";              DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "uninstall-service.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "agent-settings.ps1";               DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "windows-canary.ps1";               DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "installer-orchestrator.ps1";       Flags: dontcopy

; --- config.json default ----------------------------------------------------
; onlyifdoesntexist: preserva o config de uma instalacao anterior (nao sobrescreve).
Source: "{#Payload}\config.json";           DestDir: "{app}";       Flags: onlyifdoesntexist

; --- (OFFLINE OPCIONAL) Postgres/PostgREST/Node/NSSM pre-bundlados ----------
; Se voce montou payload\bin com pgsql\, postgrest.exe, node\+node.exe e nssm.exe,
; descomente as linhas abaixo E remova a chamada de download em CurStepChanged.
; Source: "{#Payload}\bin\pgsql\*";    DestDir: "{app}\bin\pgsql"; Flags: recursesubdirs createallsubdirs ignoreversion
; Source: "{#Payload}\bin\postgrest.exe"; DestDir: "{app}\bin";   Flags: ignoreversion
; Source: "{#Payload}\bin\node\*";     DestDir: "{app}\bin\node"; Flags: recursesubdirs createallsubdirs ignoreversion
; Source: "{#Payload}\bin\node.exe";   DestDir: "{app}\bin";      Flags: ignoreversion
; Source: "{#Payload}\bin\nssm.exe";   DestDir: "{app}\bin";      Flags: ignoreversion

; Ultima entrada: mantem as operacoes faliveis dentro da transacao [Files].
Source: "install-transaction.marker"; DestDir: "{tmp}"; Flags: deleteafterinstall; AfterInstall: RunTransactionalInstall

[Run]
; Vazio: passos criticos rodam em [Code] e conferem ResultCode.

[UninstallRun]
; Vazio: CurUninstallStepChanged aborta antes de apagar arquivos se o teardown falhar.

[UninstallDelete]
; Limpa o que foi baixado/gerado em runtime (nao versionado). data\ NAO entra
; aqui (uninsneveruninstall + preservado pelo uninstall-service).
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\releases"

[Code]
var
  OrchestratorPath: String;
  HubTransactionDir: String;
  HubExisted: Boolean;
  HubWasRunning: Boolean;
  HubSnapshotCreated: Boolean;
  InstallCompleted: Boolean;
  ServiceInstallAttempted: Boolean;
  RollbackDone: Boolean;
  ExistingProvisionedConfig: Boolean;
  ReceiptId: String;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function QuoteArg(Value: String): String;
begin
  if (Pos('"', Value) > 0) or (Pos(#13, Value) > 0) or (Pos(#10, Value) > 0) then
    RaiseException('Parametro contem caractere inseguro para linha de comando.');
  Result := '"' + Value + '"';
end;

function PowerShellFileParams(ScriptPath, Tail: String): String;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File ' + QuoteArg(ScriptPath);
  if Tail <> '' then Result := Result + ' ' + Tail;
end;

procedure ExecChecked(Filename, Params, WorkingDir, FailureMessage: String);
var
  ResultCode: Integer;
begin
  if not Exec(Filename, Params, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException(FailureMessage + ' (processo nao iniciado).');
  if ResultCode <> 0 then
    RaiseException(FailureMessage + ' (exit code ' + IntToStr(ResultCode) + ').');
end;

function OrchestratorParams(Operation, Extra: String): String;
var
  Tail: String;
begin
  Tail := '-Operation ' + Operation + ' -Root ' + QuoteArg(ExpandConstant('{app}'));
  if Extra <> '' then Tail := Tail + ' ' + Extra;
  Result := PowerShellFileParams(OrchestratorPath, Tail);
end;

procedure RunOrchestratorChecked(Operation, Extra, FailureMessage: String);
begin
  ExecChecked(PowerShellExe, OrchestratorParams(Operation, Extra),
    ExpandConstant('{tmp}'), FailureMessage);
end;

function QueryHubRunning: Boolean;
var
  ResultCode: Integer;
begin
  if not Exec(PowerShellExe, OrchestratorParams('QueryHubRunning', ''),
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Nao foi possivel consultar o servico ExpedHub.');
  if ResultCode = 0 then
  begin
    HubExisted := True;
    Result := True;
  end
  else if ResultCode = 3 then
  begin
    HubExisted := True;
    Result := False;
  end
  else if ResultCode = 4 then
  begin
    HubExisted := False;
    Result := False;
  end
  else RaiseException('Consulta do ExpedHub falhou (exit code ' + IntToStr(ResultCode) + ').');
end;

function QueryProvisionedConfig: Boolean;
var
  ResultCode: Integer;
begin
  if not Exec(PowerShellExe, OrchestratorParams('QueryProvisionedConfig', ''),
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Nao foi possivel validar o provisionamento existente.');
  if ResultCode = 0 then
    Result := True
  else if ResultCode = 4 then
    Result := False
  else
    RaiseException('Validacao do provisionamento existente falhou (exit code ' +
      IntToStr(ResultCode) + ').');
end;

procedure RestoreHubAfterFailure;
var
  ResultCode: Integer;
begin
  if RollbackDone then Exit;
  RollbackDone := True;
  if HubSnapshotCreated then
  begin
    if (not Exec(PowerShellExe, OrchestratorParams('RestoreHub',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      Log('AVISO: rollback byte-a-byte do Hub/servico nao foi concluido.');
  end;
end;

function GetReceiptId(Param: String): String;
begin
  if ReceiptId = '' then
    ReceiptId := 'exped-' + GetDateTimeString('yyyymmddhhnnss', '-', ':') + '-' +
      IntToStr(Random(1000000000));
  Result := ReceiptId;
end;

procedure InitializeWizard;
begin
  if Trim(ExpandConstant('{param:initsmoke}')) = '1' then
    RaiseException('EXPED_HUB_INIT_SMOKE_OK:' + GetReceiptId(''));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  RollbackDone := False;
  HubSnapshotCreated := False;
  HubExisted := False;
  HubWasRunning := False;
  InstallCompleted := False;
  ServiceInstallAttempted := False;
  ReceiptId := '';
  try
    ExtractTemporaryFile('installer-orchestrator.ps1');
    OrchestratorPath := ExpandConstant('{tmp}\installer-orchestrator.ps1');
    { Raiz curta: o payload inclui paths profundos do pgAdmin e PowerShell 5 limita MAX_PATH. }
    HubTransactionDir := ExpandConstant('{sd}\ExpedHubTxn-') +
      GetReceiptId('');
    HubWasRunning := QueryHubRunning;
    ExistingProvisionedConfig := QueryProvisionedConfig;
    if not ExistingProvisionedConfig then
      RaiseException('ExpedHubSetup e somente para upgrade ja provisionado. Use ExpedSetup para a instalacao inicial.');
    RunOrchestratorChecked('SnapshotHub',
      '-TransactionDir ' + QuoteArg(HubTransactionDir),
      'Snapshot do payload/config/servico falhou');
    HubSnapshotCreated := True;
    RunOrchestratorChecked('StopHub', '', 'Nao foi possivel parar o ExpedHub');
    if HubWasRunning then Sleep(2000);
  except
    Result := GetExceptionMessage;
    RestoreHubAfterFailure;
  end;
end;

function RandomSecret(Len: Integer): String;
var
  i: Integer;
  Chars: String;
begin
  Chars := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  Result := '';
  for i := 1 to Len do
    Result := Result + Copy(Chars, Random(Length(Chars)) + 1, 1);
end;

procedure RunTransactionalInstall;
var
  ConfigFile: String;
  Content: AnsiString;
  S: String;
  Secret: String;
  FailureMessage: String;
  ResultCode: Integer;
begin
  try
    ConfigFile := ExpandConstant('{app}\config.json');
    RunOrchestratorChecked('StampHubVersion',
      '-AppVersion ' + QuoteArg('{#MyAppVersion}'),
      'Carimbo atomico de config.version falhou');
    if LoadStringFromFile(ConfigFile, Content) then
    begin
      S := String(Content);
      { So troca se ainda estiver com o placeholder (nao mexe em config de reinstalacao). }
      if Pos('TROCAR-no-install', S) > 0 then
      begin
        Secret := RandomSecret(48);
        StringChangeEx(S, 'TROCAR-no-install-por-segredo-aleatorio-min-32-chars', Secret, True);
        if not SaveStringToFile(ConfigFile, AnsiString(S), False) then
          RaiseException('Nao foi possivel escrever jwtSecret em config.json.');
      end;
    end;

    ExecChecked(PowerShellExe,
      PowerShellFileParams(ExpandConstant('{app}\hub\win\download-binaries.ps1'),
        '-InstallDir ' + QuoteArg(ExpandConstant('{app}\bin'))),
      ExpandConstant('{app}'), 'Download de binarios falhou');
    ServiceInstallAttempted := True;
    ExecChecked(PowerShellExe,
      PowerShellFileParams(ExpandConstant('{app}\hub\win\install-service.ps1'),
        '-Root ' + QuoteArg(ExpandConstant('{app}')) +
        ' -ConfigPath ' + QuoteArg(ConfigFile) + ' -ManageAgent false'),
      ExpandConstant('{app}'), 'Registro do servico ExpedHub falhou');
    if (not Exec(PowerShellExe, OrchestratorParams('VerifyCompleteStatus',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      RaiseException('Health final incompleto; snapshot de rollback foi preservado.');
    if (not Exec(PowerShellExe, OrchestratorParams('FinalizeHub',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      Log('AVISO: backup do Hub foi preservado apos instalacao concluida.');
    InstallCompleted := True;
  except
    FailureMessage := GetExceptionMessage;
    RestoreHubAfterFailure;
    RaiseException(FailureMessage);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { Operacoes faliveis pertencem ao callback AfterInstall da ultima entrada [Files]. }
end;

procedure DeinitializeSetup;
begin
  if not InstallCompleted then RestoreHubAfterFailure;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
  ResultCode: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\uninstall-service.ps1'),
    '-Root ' + QuoteArg(ExpandConstant('{app}')) + ' -ManageAgent false');
  if not Exec(PowerShellExe, Params, ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Nao foi possivel iniciar a remocao do ExpedHub. Arquivos preservados.', mbError, MB_OK);
    Abort;
  end;
  if ResultCode <> 0 then
  begin
    MsgBox('A remocao do servico/firewall falhou. Arquivos preservados.', mbError, MB_OK);
    Abort;
  end;
end;
