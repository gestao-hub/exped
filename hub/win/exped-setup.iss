; ============================================================================
;  Exped Setup — instalador UNIFICADO (hub + agente) — Inno Setup 6
; ----------------------------------------------------------------------------
;  Combina o instalador do hub (exped-hub.iss) com o do agente
;  (agent/installer/ExpedAgent.iss) num único .exe, e acrescenta um wizard que
;  pede o "Código de instalação" gerado no painel. Ao final, resgata o código,
;  prepara o agente em staging e o instala sob o usuario interativo original:
;    - C:\Exped\config.json            (cloud.apiBase + cloud.deviceToken)
;    - %LOCALAPPDATA%\ExpedAgent\appsettings.json (ApiBaseUrl local + token)
;
;  O hub é instalado em C:\Exped como serviço Windows "ExpedHub" (admin).
;  O agente é instalado em %LOCALAPPDATA%\ExpedAgent com autostart no logon (.vbs).
;
;  COMO COMPILAR (no Windows, com Inno Setup 6 instalado):
;      ISCC.exe hub\win\exped-setup.iss
;  -> gera Output\ExpedSetup.exe
;
;  PRE-REQUISITO 1 — payload do HUB (igual ao exped-hub.iss): a pasta
;  "hub\win\payload\" precisa estar montada ANTES de compilar (ver README.md,
;  Fase 1.3). Layout esperado:
;      payload\
;        hub\                 <- conteudo de hub\ (maestro.mjs, supervisor.mjs, ...)
;        scripts\local-stack\ <- *.sql, gateway.mjs, make-keys.sh, postgrest.conf
;        app\                 <- .next\standalone\* + .next\static + public (app Next)
;        supabase\migrations\ <- migrations do APP
;        bin\auth.exe         <- GoTrue cross-compilado win-x64
;        bin\migrations\      <- migrations do GoTrue
;        config.json          <- gerado do config.example.json (jwtSecret no install)
;
;  PRE-REQUISITO 2 — publish do AGENTE: gere o publish self-contained do agente
;  ANTES de compilar (igual ao ExpedAgent.iss). A partir de agent\installer\:
;      dotnet publish ..\ExpedAgent -c Release -o publish
;  -> isto cria agent\installer\publish\ (ExpedAgent.exe + deps + appsettings.json).
;  Este .iss referencia esse publish por caminho RELATIVO a hub\win\ (ver [Files]).
;
;  Postgres / PostgREST / Node / NSSM NAO vao no payload (binarios grandes): sao
;  baixados em [Code] por download-binaries.ps1 (ver variante offline no README).
; ============================================================================

#define MyAppName "Exped"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "Exped"
; Raiz fixa C:\Exped (convencao do hub; maestro.mjs resolve paths a partir dela).
#define InstallRoot "C:\Exped"
; Pasta de payload do HUB, relativa a este .iss (hub\win\).
#define Payload "payload"
; Pasta do publish do AGENTE, relativa a este .iss (hub\win\ -> ..\..\agent\installer\publish).
#define AgentPublish "..\..\agent\installer\publish"
; start.cmd do agente (wrapper que aloca console e redireciona log).
#define AgentStartCmd "..\..\agent\installer\start.cmd"
; URL padrao da nuvem (usada como fallback se o operador nao informar outra no modo manual).
#define CloudApiDefault "https://app-exped.vercel.app"

[Setup]
AppId=Exped
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Instala SEMPRE em C:\Exped (o hub assume essa raiz; nao deixamos o usuario mudar).
; O payload do agente fica em staging sob {app}; um helper runasoriginaluser
; copia/configura no LOCALAPPDATA do usuario interativo comprovado por SID.
DefaultDirName={#InstallRoot}
DisableDirPage=yes
DisableProgramGroupPage=yes
; Serviço Windows + firewall exigem elevacao.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=ExpedSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; AVISO: este .exe NAO é assinado. Windows SmartScreen vai alertar.
; Ver README.md (troubleshooting) sobre assinatura de codigo (signtool).

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Dirs]
; Diretorios de runtime do HUB criados no install (vazios). data\ e logs\ ficam
; fora do empacotamento e sao preservados em desinstalacoes (ver [UninstallDelete]).
Name: "{app}\data";     Flags: uninsneveruninstall
Name: "{app}\logs";     Flags: uninsneveruninstall
Name: "{app}\releases"; Flags: uninsneveruninstall
Name: "{app}\bin"
Name: "{app}\agent-stage"

[Files]
; =========================== PARTE HUB (de exped-hub.iss) ====================
; --- App Next standalone (payload\app -> C:\Exped\app) -----------------------
; payload\app deve conter: server.js + node_modules do standalone, a pasta
; .next\static (em app\.next\static) e public\ (em app\public). Ver README.
Source: "{#Payload}\app\*";                 DestDir: "{app}\app";   Flags: recursesubdirs createallsubdirs ignoreversion

; --- Hub Node (maestro/supervisor/health/storage/bootstrap/config/updater) ---
Source: "{#Payload}\hub\*";                 DestDir: "{app}\hub";   Flags: recursesubdirs createallsubdirs ignoreversion
; Substitui o watchdog legado em C:\Exped por uma versao somente diagnostica.
Source: "{#Payload}\hub\watchdog.ps1";      DestDir: "{app}";       Flags: ignoreversion

; --- Local-stack: SQL de bootstrap + gateway + scripts auxiliares -----------
; Inclui o gotrue.env (lido por hub/bootstrap.mjs para o `auth migrate`).
Source: "{#Payload}\scripts\local-stack\*"; DestDir: "{app}\scripts\local-stack"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- Migrations do APP (supabase\migrations\*.sql) --------------------------
; O maestro/bootstrap aplica essas no 1o start. SEM elas o bootstrap do schema falha.
Source: "{#Payload}\supabase\migrations\*"; DestDir: "{app}\supabase\migrations"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- GoTrue (auth.exe + migrations) — vem do payload, NAO é baixado ---------
Source: "{#Payload}\bin\auth.exe";          DestDir: "{app}\bin";   Flags: ignoreversion
Source: "{#Payload}\bin\migrations\*";      DestDir: "{app}\bin\migrations"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- NSSM pre-empacotado (robustez) -----------------------------------------
; nssm.cc e instavel (503/timeout) e derrubava o install zero-toque. Se houver
; payload\bin\nssm.exe, o instalador o copia e o download-binaries.ps1 pula o NSSM.
; skipifsourcedoesntexist: se NAO empacotar, o passo e ignorado e o NSSM e baixado.
Source: "{#Payload}\bin\nssm.exe";          DestDir: "{app}\bin";   Flags: ignoreversion skipifsourcedoesntexist

; --- Scripts de servico/download/provision (ficam em C:\Exped\hub\win) -------
Source: "download-binaries.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "install-service.ps1";              DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "uninstall-service.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "agent-settings.ps1";               DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "agent-sync-contract.mjs";          DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "agent-user-install.ps1";           DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "windows-canary.ps1";               DestDir: "{app}\hub\win"; Flags: ignoreversion
; Helper autocontido extraido em {tmp} antes de [Files] para preflight/snapshot.
Source: "installer-orchestrator.ps1";       Flags: dontcopy
; provision.ps1: resgata o codigo (ou, no modo manual, recebe Token+URL diretos)
; e escreve o Hub; o helper original-user conclui o agente antes do servico.
Source: "provision.ps1";                    DestDir: "{app}\hub\win"; Flags: ignoreversion

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

; ========================= PARTE AGENTE (de ExpedAgent.iss) ==================
; Conteudo do publish self-contained vai para staging elevado. Somente o helper
; runasoriginaluser toca LOCALAPPDATA/Startup, depois de validar o SID da sessao.
Source: "{#AgentPublish}\*"; DestDir: "{app}\agent-stage"; Flags: recursesubdirs ignoreversion
; start.cmd: wrapper que aloca console (ConsoleLifetime) e redireciona o log.
Source: "{#AgentStartCmd}";  DestDir: "{app}\agent-stage"; Flags: ignoreversion

; Deve ser a ultima entrada. Falhas no callback ainda pertencem a fase [Files],
; permitindo que o Inno reverta arquivos e metadados do produto.
Source: "install-transaction.marker"; DestDir: "{tmp}"; Flags: deleteafterinstall; AfterInstall: RunTransactionalInstall

[Run]
; Vazio de proposito. Operacoes criticas rodam em [Code] com ResultCode conferido.

[UninstallDelete]
; Limpa o que foi baixado/gerado em runtime (nao versionado). data\ NAO entra aqui.
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\releases"

[Code]
{ ============================================================================
  WIZARD CUSTOM — pagina do "Código de instalação"
  ----------------------------------------------------------------------------
  CodePage tem 3 campos (indices 0..2):
    0: Código de instalação  (ex.: EXPED-7K4P-2QXM)
    1: Token de dispositivo  (modo manual / suporte)
    2: URL da nuvem          (modo manual / suporte)
  Um checkbox "modo manual (suporte)" alterna entre:
    - desmarcado: usa o campo Código (resgata via /api/provision/redeem)
    - marcado:    usa Token + URL diretos (sem resgate)
  Os campos manuais começam ocultos e aparecem ao marcar o checkbox.
  ============================================================================ }

var
  CodePage: TInputQueryWizardPage;
  ManualCheck: TNewCheckBox;
  ReceiptId: String;
  OrchestratorPath: String;
  HubTransactionDir: String;
  CredentialsFile: String;
  ProvisionCapabilityFile: String;
  SilentCredentialMode: String;
  SilentProvisionSecret: String;
  SilentProvisionUrl: String;
  SilentManualLoaded: Boolean;
  HubExisted: Boolean;
  HubWasRunning: Boolean;
  HubSnapshotCreated: Boolean;
  AgentTransactionMayExist: Boolean;
  InstallCompleted: Boolean;
  ServiceInstallAttempted: Boolean;
  ProvisionTransactionMayExist: Boolean;
  ProvisionRollbackDone: Boolean;
  AgentUrlAclRollbackDone: Boolean;
  AgentUrlAclRollbackSucceeded: Boolean;
  RollbackDone: Boolean;
  ExistingProvisionedConfig: Boolean;

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

procedure ExecOriginalUserChecked(Filename, Params, WorkingDir, FailureMessage: String);
var
  ResultCode: Integer;
begin
  if not ExecAsOriginalUser(Filename, Params, WorkingDir, SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
    RaiseException(FailureMessage + ' (token original indisponivel).');
  if ResultCode <> 0 then
    RaiseException(FailureMessage + ' (exit code ' + IntToStr(ResultCode) + ').');
end;

function OrchestratorParamsForRoot(Operation, Extra, Root: String): String;
var
  Tail: String;
begin
  Tail := '-Operation ' + Operation + ' -Root ' + QuoteArg(Root);
  if Extra <> '' then Tail := Tail + ' ' + Extra;
  Result := PowerShellFileParams(OrchestratorPath, Tail);
end;

function OrchestratorParams(Operation, Extra: String): String;
begin
  Result := OrchestratorParamsForRoot(Operation, Extra, ExpandConstant('{app}'));
end;

procedure RunOrchestratorChecked(Operation, Extra, FailureMessage: String);
begin
  ExecChecked(PowerShellExe, OrchestratorParams(Operation, Extra),
    ExpandConstant('{tmp}'), FailureMessage);
end;

procedure RunOriginalOrchestratorChecked(Operation, Extra, FailureMessage: String);
begin
  ExecOriginalUserChecked(PowerShellExe, OrchestratorParams(Operation, Extra),
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

function QueryProvisionedConfigAtRoot(Root: String): Boolean;
var
  ResultCode: Integer;
begin
  if not Exec(PowerShellExe,
    OrchestratorParamsForRoot('QueryProvisionedConfig', '', Root),
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

function QueryProvisionedConfig: Boolean;
begin
  Result := QueryProvisionedConfigAtRoot(ExpandConstant('{app}'));
end;

procedure RollbackAgentAfterFailure;
var
  Params: String;
  ResultCode: Integer;
begin
  if (not AgentTransactionMayExist) or (ReceiptId = '') then Exit;
  Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\agent-user-install.ps1'),
    '-Rollback -Root ' + QuoteArg(ExpandConstant('{app}')) +
    ' -ReceiptId ' + QuoteArg(ReceiptId));
  if (not ExecAsOriginalUser(PowerShellExe, Params, ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    Log('AVISO: rollback do agente nao foi concluido; receipt/backup foram preservados.')
  else
    AgentTransactionMayExist := False;
end;

procedure RollbackProvisionAfterFailure;
var
  Params: String;
  ResultCode: Integer;
begin
  if ProvisionRollbackDone then Exit;
  ProvisionRollbackDone := True;
  if (not ProvisionTransactionMayExist) or (ReceiptId = '') or
    (not FileExists(ExpandConstant('{app}\hub\win\provision.ps1'))) then Exit;
  Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\provision.ps1'),
    '-RollbackTransaction -Root ' + QuoteArg(ExpandConstant('{app}')) +
    ' -InstallerTransactionId ' + QuoteArg(ReceiptId));
  if (not Exec(PowerShellExe, Params, ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    Log('AVISO: journal de provisioning foi preservado para recuperacao manual.');
end;

function RollbackAgentUrlAclAfterFailure: Boolean;
var
  ResultCode: Integer;
begin
  if AgentUrlAclRollbackDone then
  begin
    Result := AgentUrlAclRollbackSucceeded;
    Exit;
  end;
  AgentUrlAclRollbackDone := True;
  AgentUrlAclRollbackSucceeded := True;
  if HubSnapshotCreated and ServiceInstallAttempted then
  begin
    if (not Exec(PowerShellExe, OrchestratorParams('RollbackAgentUrlAcl',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    begin
      AgentUrlAclRollbackDone := False;
      AgentUrlAclRollbackSucceeded := False;
      Log('AVISO: rollback da URL ACL falhou; o agente anterior nao sera iniciado.');
    end;
  end;
  Result := AgentUrlAclRollbackSucceeded;
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

{ --- Mostra/oculta os campos manuais conforme o checkbox -------------------- }
procedure ManualCheckClicked(Sender: TObject);
begin
  { Indices 1 (Token) e 2 (URL) sao os campos do modo manual. }
  CodePage.PromptLabels[1].Visible := ManualCheck.Checked;
  CodePage.Edits[1].Visible        := ManualCheck.Checked;
  CodePage.PromptLabels[2].Visible := ManualCheck.Checked;
  CodePage.Edits[2].Visible        := ManualCheck.Checked;
  { Quando manual, o campo Código deixa de ser obrigatorio (oculta tambem). }
  CodePage.PromptLabels[0].Visible := not ManualCheck.Checked;
  CodePage.Edits[0].Visible        := not ManualCheck.Checked;
end;

procedure InitializeWizard;
begin
  ExtractTemporaryFile('installer-orchestrator.ps1');
  OrchestratorPath := ExpandConstant('{tmp}\installer-orchestrator.ps1');
  { {app} ainda nao existe nesta fase do Inno; a raiz do produto e fixa. }
  ExistingProvisionedConfig := QueryProvisionedConfigAtRoot('{#InstallRoot}');

  { Smoke de CI: comprova a inicializacao limpa/provisionada sem tocar no host. }
  if Trim(ExpandConstant('{param:initsmoke}')) = '1' then
  begin
    if ExistingProvisionedConfig then
      RaiseException('EXPED_INIT_SMOKE_OK:provisioned')
    else
      RaiseException('EXPED_INIT_SMOKE_OK:clean');
  end;

  { Em modo silencioso a credencial vem somente de /credentialsfile protegido. }
  if WizardSilent() then Exit;

  { Upgrade usa o token atual e nao consome novo codigo de instalacao. }
  if ExistingProvisionedConfig then Exit;

  { Pagina apos a de boas-vindas. }
  CodePage := CreateInputQueryPage(wpWelcome,
    'Código de instalação',
    'Cole o código gerado no painel do Exped.',
    'O operador gera um código por empresa no painel; ele vale 1 instalação e expira em 24h.');
  CodePage.Add('Código (ex.: EXPED-7K4P-2QXM):', False);   { [0] }
  CodePage.Add('Token de dispositivo (suporte):', True);   { [1], mascarado }
  CodePage.Add('URL da nuvem (suporte):', False);           { [2] }

  { URL padrao pre-preenchida pro modo manual. }
  CodePage.Values[2] := '{#CloudApiDefault}';

  { Checkbox "modo manual" ancorado abaixo dos campos. }
  ManualCheck := TNewCheckBox.Create(WizardForm);
  ManualCheck.Parent  := CodePage.Surface;
  ManualCheck.Top     := CodePage.Edits[2].Top + CodePage.Edits[2].Height + ScaleY(12);
  ManualCheck.Left    := CodePage.Edits[0].Left;
  ManualCheck.Width   := CodePage.SurfaceWidth;
  ManualCheck.Caption := 'Modo manual (suporte): informar Token + URL em vez do código';
  ManualCheck.OnClick := @ManualCheckClicked;

  { Estado inicial: modo código (campos manuais ocultos). }
  ManualCheckClicked(nil);
end;

{ --- Validacao da pagina do wizard ----------------------------------------- }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if Assigned(CodePage) and (CurPageID = CodePage.ID) then
  begin
    if ManualCheck.Checked then
    begin
      if Trim(CodePage.Values[1]) = '' then
      begin
        MsgBox('Informe o Token de dispositivo (modo manual).', mbError, MB_OK);
        Result := False;
      end
      else if Trim(CodePage.Values[2]) = '' then
      begin
        MsgBox('Informe a URL da nuvem (modo manual).', mbError, MB_OK);
        Result := False;
      end;
    end
    else
    begin
      if Trim(CodePage.Values[0]) = '' then
      begin
        MsgBox('Cole o código de instalação gerado no painel.', mbError, MB_OK);
        Result := False;
      end;
    end;
  end;
end;

procedure LoadSilentManualCredentials;
var
  SourceFile: String;
  Content: AnsiString;
  S: String;
  P1: Integer;
  P2: Integer;
  SeparatorLength1: Integer;
  SeparatorLength2: Integer;
  FirstLine: String;
  Rest: String;
begin
  if SilentManualLoaded then Exit;
  SourceFile := Trim(ExpandConstant('{param:credentialsfile}'));
  if (SourceFile = '') or (not LoadStringFromFile(SourceFile, Content)) then
    RaiseException('Modo silencioso exige /credentialsfile protegido; segredos nao sao aceitos em argumentos.');
  S := String(Content);
  P1 := Pos(#13#10, S);
  SeparatorLength1 := 2;
  if P1 = 0 then
  begin
    P1 := Pos(#10, S);
    SeparatorLength1 := 1;
  end;
  if P1 = 0 then RaiseException('credentialsfile silencioso invalido.');
  FirstLine := Trim(Copy(S, 1, P1 - 1));
  Rest := Copy(S, P1 + SeparatorLength1, Length(S));
  P2 := Pos(#13#10, Rest);
  SeparatorLength2 := 2;
  if P2 = 0 then
  begin
    P2 := Pos(#10, Rest);
    SeparatorLength2 := 1;
  end;
  if P2 = 0 then
  begin
    { Compatibilidade do arquivo manual antigo: URL + token. }
    SilentCredentialMode := 'manual';
    SilentProvisionUrl := FirstLine;
    SilentProvisionSecret := Trim(Rest);
  end
  else
  begin
    SilentCredentialMode := Lowercase(FirstLine);
    SilentProvisionUrl := Trim(Copy(Rest, 1, P2 - 1));
    SilentProvisionSecret := Trim(Copy(Rest, P2 + SeparatorLength2, Length(Rest)));
  end;
  if ((SilentCredentialMode <> 'manual') and (SilentCredentialMode <> 'code')) or
    (SilentProvisionUrl = '') or (SilentProvisionSecret = '') then
    RaiseException('credentialsfile deve conter modo, URL e segredo em tres linhas.');
  if not DeleteFile(SourceFile) then
    RaiseException('Nao foi possivel apagar o credentialsfile de entrada.');
  SilentManualLoaded := True;
end;

{ --- Valores do wizard usados pela orquestracao conferida em [Code] ---------- }
function GetCode(Param: String): String;
begin
  if WizardSilent() then
  begin
    LoadSilentManualCredentials;
    Result := SilentProvisionSecret;
  end
  else
    Result := Trim(CodePage.Values[0]);
end;

procedure DeleteSilentCredentialSource;
var
  SourceFile: String;
begin
  if not WizardSilent() then Exit;
  SourceFile := Trim(ExpandConstant('{param:credentialsfile}'));
  if (SourceFile <> '') and FileExists(SourceFile) then
    if not DeleteFile(SourceFile) then
      Log('AVISO: credentialsfile de entrada nao pode ser apagado.');
end;

function GetManualToken(Param: String): String;
begin
  if WizardSilent() then
  begin
    LoadSilentManualCredentials;
    Result := SilentProvisionSecret;
  end
  else
    Result := Trim(CodePage.Values[1]);
end;

function GetManualUrl(Param: String): String;
begin
  if WizardSilent() then
  begin
    LoadSilentManualCredentials;
    Result := SilentProvisionUrl;
  end
  else
    Result := Trim(CodePage.Values[2]);
end;

function GetReceiptId(Param: String): String;
begin
  if ReceiptId = '' then
    ReceiptId := 'exped-' + GetDateTimeString('yyyymmddhhnnss', '', '') + '-' +
      IntToStr(Random(1000000000));
  Result := ReceiptId;
end;

{ --- Seleciona o modo de provisionamento ------------------------------------ }
function IsCodeMode: Boolean;
begin
  if WizardSilent() then
  begin
    LoadSilentManualCredentials;
    Result := SilentCredentialMode = 'code';
  end
  else
    { Roda o provisionamento por código se NAO estiver em modo manual. }
    Result := not ManualCheck.Checked;
end;

function IsManualMode: Boolean;
begin
  if WizardSilent() then
  begin
    LoadSilentManualCredentials;
    Result := SilentCredentialMode = 'manual';
  end
  else
    Result := ManualCheck.Checked;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  RollbackDone := False;
  HubSnapshotCreated := False;
  HubExisted := False;
  HubWasRunning := False;
  AgentTransactionMayExist := False;
  InstallCompleted := False;
  ServiceInstallAttempted := False;
  ProvisionTransactionMayExist := False;
  ProvisionRollbackDone := False;
  AgentUrlAclRollbackDone := False;
  AgentUrlAclRollbackSucceeded := False;
  CredentialsFile := '';
  ProvisionCapabilityFile := '';
  ReceiptId := '';
  try
    if OrchestratorPath = '' then
    begin
      ExtractTemporaryFile('installer-orchestrator.ps1');
      OrchestratorPath := ExpandConstant('{tmp}\installer-orchestrator.ps1');
    end;
    HubTransactionDir := ExpandConstant('{tmp}\ExpedHubTransaction-') + GetReceiptId('');

    { Nenhum stop, download, escrita persistente ou redeem ocorre antes disto. }
    RunOriginalOrchestratorChecked('PreflightUser', '',
      'Preflight do usuario original falhou');
    ExistingProvisionedConfig := QueryProvisionedConfig;
    if WizardSilent() and (not ExistingProvisionedConfig) then
    begin
      LoadSilentManualCredentials;
    end;
    HubWasRunning := QueryHubRunning;
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

{ ============================================================================
  jwtSecret aleatorio (igual ao exped-hub.iss)
  ----------------------------------------------------------------------------
  Gera um jwtSecret aleatorio (>=32 chars) no config.json antes do
  install-service.ps1 rodar (so se ainda estiver com o placeholder). O helper
  runasoriginaluser e o unico responsavel pelo perfil e Startup do agente.
  ============================================================================ }

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
  Params: String;
  FailureMessage: String;
  ResultCode: Integer;
begin
  try
    try
    ConfigFile := ExpandConstant('{app}\config.json');
    RunOrchestratorChecked('StampHubVersion',
      '-AppVersion ' + QuoteArg('{#MyAppVersion}'),
      'Carimbo atomico de config.version falhou');
    if LoadStringFromFile(ConfigFile, Content) then
    begin
      S := String(Content);
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

    if not ExistingProvisionedConfig then
    begin
      CredentialsFile := ExpandConstant('{tmp}\ExpedCredentials-') + ReceiptId + '.txt';
      if not SaveStringToFile(CredentialsFile, '', False) then
        RaiseException('Nao foi possivel criar o arquivo efemero de credenciais.');
      RunOrchestratorChecked('ProtectCredentials',
        '-CredentialsFile ' + QuoteArg(CredentialsFile),
        'Nao foi possivel proteger o arquivo efemero de credenciais');
      ProvisionCapabilityFile := HubTransactionDir + '\provision-capability.json';
      ProvisionTransactionMayExist := True;
      RunOrchestratorChecked('IssueProvisionCapability',
        '-TransactionDir ' + QuoteArg(HubTransactionDir) +
        ' -InstallerTransactionId ' + QuoteArg(ReceiptId),
        'Nao foi possivel emitir a capability efemera de provisioning');
      { CREATE_ALWAYS preserva o descritor protegido; o segredo so entra depois
        que SYSTEM/Administrators sao os unicos principals. }
      if IsManualMode then
      begin
        if not SaveStringToFile(CredentialsFile,
          AnsiString('manual' + #13#10 + GetManualUrl('') + #13#10 + GetManualToken('')), False) then
          RaiseException('Nao foi possivel preencher o arquivo efemero de credenciais.');
      end
      else if IsCodeMode then
      begin
        if not SaveStringToFile(CredentialsFile,
          AnsiString('code' + #13#10 + '{#CloudApiDefault}' + #13#10 + GetCode('')), False) then
          RaiseException('Nao foi possivel preencher o arquivo efemero de provisioning.');
      end
      else
        RaiseException('Informe /credentialsfile protegido para o provisionamento silencioso.');

      Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\provision.ps1'),
        '-CredentialsFile ' + QuoteArg(CredentialsFile) +
        ' -InstallerCapabilityFile ' + QuoteArg(ProvisionCapabilityFile) +
        ' -Root ' + QuoteArg(ExpandConstant('{app}')) +
        ' -DeferAgent -InstallerTransactionId ' + QuoteArg(ReceiptId));
      ExecChecked(PowerShellExe, Params, ExpandConstant('{app}'), 'Provisionamento falhou');
    end;

    AgentTransactionMayExist := True;
    Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\agent-user-install.ps1'),
      '-Install -Root ' + QuoteArg(ExpandConstant('{app}')) +
      ' -StageDir ' + QuoteArg(ExpandConstant('{app}\agent-stage')) +
      ' -ReceiptId ' + QuoteArg(ReceiptId));
    ExecOriginalUserChecked(PowerShellExe, Params, ExpandConstant('{app}'),
      'Instalacao do agente no usuario original falhou');

    Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\install-service.ps1'),
      '-Root ' + QuoteArg(ExpandConstant('{app}')) +
      ' -ConfigPath ' + QuoteArg(ConfigFile) +
      ' -TransactionDir ' + QuoteArg(HubTransactionDir) +
      ' -AgentReceiptId ' + QuoteArg(ReceiptId) + ' -ManageAgent true');
    ServiceInstallAttempted := True;
    ExecChecked(PowerShellExe, Params, ExpandConstant('{app}'),
      'Registro do servico/URL ACL falhou');

    Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\agent-user-install.ps1'),
      '-Start -Root ' + QuoteArg(ExpandConstant('{app}')) +
      ' -ReceiptId ' + QuoteArg(ReceiptId));
    ExecOriginalUserChecked(PowerShellExe, Params, ExpandConstant('{app}'),
      'Start do agente no usuario original falhou');

    { Nenhum journal sai antes de /status provar toda a cadeia operacional. }
    if (not Exec(PowerShellExe, OrchestratorParams('VerifyCompleteStatus',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      RaiseException('Health final incompleto; snapshots de rollback foram preservados.');

    if ProvisionTransactionMayExist then
    begin
      Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\provision.ps1'),
        '-FinalizeTransaction -Root ' + QuoteArg(ExpandConstant('{app}')) +
        ' -InstallerTransactionId ' + QuoteArg(ReceiptId));
      ExecChecked(PowerShellExe, Params, ExpandConstant('{app}'),
        'Finalizacao do journal de provisioning falhou');
    end;
    if (not Exec(PowerShellExe, OrchestratorParams('FinalizeHub',
      '-TransactionDir ' + QuoteArg(HubTransactionDir)), ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      Log('AVISO: backup do Hub foi preservado apos instalacao concluida.');
    Params := PowerShellFileParams(ExpandConstant('{app}\hub\win\agent-user-install.ps1'),
      '-Finalize -Root ' + QuoteArg(ExpandConstant('{app}')) +
      ' -ReceiptId ' + QuoteArg(ReceiptId));
    if (not ExecAsOriginalUser(PowerShellExe, Params, ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      Log('AVISO: receipt/backup do agente foram preservados apos instalacao concluida.');
    InstallCompleted := True;
  except
    FailureMessage := GetExceptionMessage;
    if RollbackAgentUrlAclAfterFailure then
      RollbackAgentAfterFailure
    else
      Log('AVISO: receipt do agente foi preservado porque a URL ACL anterior nao foi restaurada.');
    RollbackProvisionAfterFailure;
    RestoreHubAfterFailure;
    RaiseException(FailureMessage);
    end;
  finally
    if (CredentialsFile <> '') and FileExists(CredentialsFile) then
      if not DeleteFile(CredentialsFile) then
        Log('AVISO: arquivo efemero de credenciais nao pode ser apagado.');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  { Operacoes faliveis pertencem ao callback AfterInstall da ultima entrada [Files]. }
end;

procedure DeinitializeSetup;
begin
  DeleteSilentCredentialSource;
  if not InstallCompleted then
  begin
    if RollbackAgentUrlAclAfterFailure then
      RollbackAgentAfterFailure;
    RollbackProvisionAfterFailure;
    RestoreHubAfterFailure;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  PowerShellPath: String;
  Params: String;
  ResultCode: Integer;
begin
  if CurUninstallStep <> usUninstall then
    exit;

  { runasoriginaluser nao existe no uninstall. O script elevado entrega o
    cleanup a uma tarefa TASK_LOGON_INTERACTIVE_TOKEN do SID exato. Exec nos
    permite verificar o resultado antes que o Inno apague config/helper. }
  PowerShellPath := PowerShellExe;
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\hub\win\uninstall-service.ps1') + '" -Root "' +
    ExpandConstant('{app}') + '" -ManageAgent true';
  if not Exec(PowerShellPath, Params, ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Nao foi possivel iniciar a limpeza elevada. Nenhum arquivo do instalador sera removido.',
      mbError, MB_OK);
    Abort;
  end;
  if ResultCode <> 0 then
  begin
    MsgBox('Desinstalacao parcial: o agente/Startup do usuario original nao foi removido. ' +
      'Os arquivos do instalador foram preservados. Entre no usuario original e tente novamente.',
      mbError, MB_OK);
    Abort;
  end;
end;
