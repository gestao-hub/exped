; ============================================================================
;  Exped Setup — instalador UNIFICADO (hub + agente) — Inno Setup 6
; ----------------------------------------------------------------------------
;  Combina o instalador do hub (exped-hub.iss) com o do agente
;  (agent/installer/ExpedAgent.iss) num único .exe, e acrescenta um wizard que
;  pede o "Código de instalação" gerado no painel. Ao final, resgata o código
;  (provision.ps1) e escreve os 2 configs automaticamente:
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
;  baixados no [Run] por download-binaries.ps1 (ver variante offline no README).
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
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Instala SEMPRE em C:\Exped (o hub assume essa raiz; nao deixamos o usuario mudar).
; O agente vai pra {localappdata}\ExpedAgent (feito no [Files]/[Code], nao em {app}).
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
; Pasta do agente (no perfil do usuario que roda o instalador).
Name: "{localappdata}\ExpedAgent"

[Files]
; =========================== PARTE HUB (de exped-hub.iss) ====================
; --- App Next standalone (payload\app -> C:\Exped\app) -----------------------
; payload\app deve conter: server.js + node_modules do standalone, a pasta
; .next\static (em app\.next\static) e public\ (em app\public). Ver README.
Source: "{#Payload}\app\*";                 DestDir: "{app}\app";   Flags: recursesubdirs createallsubdirs ignoreversion

; --- Hub Node (maestro/supervisor/health/storage/bootstrap/config/updater) ---
Source: "{#Payload}\hub\*";                 DestDir: "{app}\hub";   Flags: recursesubdirs createallsubdirs ignoreversion

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
; provision.ps1: resgata o codigo (ou, no modo manual, recebe Token+URL diretos)
; e escreve os 2 configs. Chamado no [Run] depois do install-service.ps1.
Source: "provision.ps1";                    DestDir: "{app}\hub\win"; Flags: ignoreversion

; --- config.json default ----------------------------------------------------
; onlyifdoesntexist: preserva o config de uma instalacao anterior (nao sobrescreve).
Source: "{#Payload}\config.json";           DestDir: "{app}";       Flags: onlyifdoesntexist

; --- (OFFLINE OPCIONAL) Postgres/PostgREST/Node/NSSM pre-bundlados ----------
; Se voce montou payload\bin com pgsql\, postgrest.exe, node\+node.exe e nssm.exe,
; descomente as linhas abaixo E comente o passo de download no [Run].
; Source: "{#Payload}\bin\pgsql\*";    DestDir: "{app}\bin\pgsql"; Flags: recursesubdirs createallsubdirs ignoreversion
; Source: "{#Payload}\bin\postgrest.exe"; DestDir: "{app}\bin";   Flags: ignoreversion
; Source: "{#Payload}\bin\node\*";     DestDir: "{app}\bin\node"; Flags: recursesubdirs createallsubdirs ignoreversion
; Source: "{#Payload}\bin\node.exe";   DestDir: "{app}\bin";      Flags: ignoreversion
; Source: "{#Payload}\bin\nssm.exe";   DestDir: "{app}\bin";      Flags: ignoreversion

; ========================= PARTE AGENTE (de ExpedAgent.iss) ==================
; Conteudo do publish self-contained do agente (.NET) -> {localappdata}\ExpedAgent.
; A maquina final NAO precisa de runtime .NET (self-contained). O publish inclui
; o appsettings.json default; o provision.ps1 reescreve ApiBaseUrl/DeviceToken nele.
Source: "{#AgentPublish}\*"; DestDir: "{localappdata}\ExpedAgent"; Flags: recursesubdirs ignoreversion
; start.cmd: wrapper que aloca console (ConsoleLifetime) e redireciona o log.
Source: "{#AgentStartCmd}";  DestDir: "{localappdata}\ExpedAgent"; Flags: ignoreversion

[Run]
; A ORDEM importa (o servico precisa subir UMA vez ja com as credenciais cloud):
;   1. download-binaries.ps1  -> baixa Postgres/PostgREST/Node pra bin\ (NSSM vem
;      pre-empacotado em payload\bin e o download pula; ver [Files]/download-binaries.ps1).
;   2. (jwtSecret real no config.json -> feito em [Code] CurStepChanged, antes do [Run])
;   3. provision.ps1          -> resgata o codigo (ou Token+URL do modo manual) e escreve
;                                cloud.apiBase/deviceToken no config.json + appsettings do agente.
;   4. install-service.ps1    -> le o config.json JA COMPLETO, injeta as env EXPED_* e
;                                inicia o servico ExpedHub (+ firewall). Sync liga de primeira.
; provision roda ANTES do install-service de proposito: se o servico subisse antes das
; credenciais, ficaria em "modo ilha" (sync desligado) e exigiria reiniciar.
; O bootstrap do banco (DB/auth/schema) e feito pelo MAESTRO no 1o start do servico.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\download-binaries.ps1"" -InstallDir ""{app}\bin"""; \
    StatusMsg: "Baixando binarios (PostgreSQL, PostgREST, Node)..."; \
    Flags: runhidden waituntilterminated

; --- Provisionamento: MODO CODIGO (default) ---------------------------------
; Resgata o codigo digitado no wizard ({code:GetCode}). So roda fora do modo manual.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\provision.ps1"" -Code ""{code:GetCode}"" -Root ""{app}"" -AgentDir ""{localappdata}\ExpedAgent"""; \
    StatusMsg: "Provisionando..."; \
    Flags: runhidden waituntilterminated; \
    Check: IsCodeMode

; --- Provisionamento: MODO MANUAL (suporte) ---------------------------------
; Em vez do codigo, o suporte digita Token + URL direto (provision pula o resgate).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\provision.ps1"" -DeviceToken ""{code:GetManualToken}"" -CloudApi ""{code:GetManualUrl}"" -Root ""{app}"" -AgentDir ""{localappdata}\ExpedAgent"""; \
    StatusMsg: "Provisionando (modo manual)..."; \
    Flags: runhidden waituntilterminated; \
    Check: IsManualMode

; --- Registra e inicia o servico (POR ULTIMO, com o config.json ja completo) -
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\install-service.ps1"" -Root ""{app}"" -ConfigPath ""{app}\config.json"""; \
    StatusMsg: "Registrando e iniciando o servico ExpedHub..."; \
    Flags: runhidden waituntilterminated

[UninstallRun]
; Para+remove o serviço e a regra de firewall ANTES de apagar os arquivos.
; Preserva C:\Exped\data por padrao (uninstall-service.ps1 sem -RemoveData).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\uninstall-service.ps1"" -Root ""{app}"""; \
    RunOnceId: "RemoveExpedHubService"; \
    Flags: runhidden

[UninstallDelete]
; Limpa o que foi baixado/gerado em runtime (nao versionado). data\ NAO entra aqui.
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\releases"
; Pasta do agente (no perfil do usuario). O .vbs de autostart é removido no [Code].
Type: filesandordirs; Name: "{localappdata}\ExpedAgent"

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
  { Em modo silencioso o código vem via /code= na linha de comando; sem wizard. }
  if WizardSilent() then Exit;

  { Pagina apos a de boas-vindas. }
  CodePage := CreateInputQueryPage(wpWelcome,
    'Código de instalação',
    'Cole o código gerado no painel do Exped.',
    'O operador gera um código por empresa no painel; ele vale 1 instalação e expira em 24h.');
  CodePage.Add('Código (ex.: EXPED-7K4P-2QXM):', False);   { [0] }
  CodePage.Add('Token de dispositivo (suporte):', False);  { [1] }
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

{ --- Scripted constants usadas no [Run] (parametros code:GetCode etc.) ------- }
function GetCode(Param: String): String;
begin
  if WizardSilent() then
    Result := Trim(ExpandConstant('{param:code}'))
  else
    Result := Trim(CodePage.Values[0]);
end;

function GetManualToken(Param: String): String;
begin
  if WizardSilent() then
    Result := Trim(ExpandConstant('{param:token}'))
  else
    Result := Trim(CodePage.Values[1]);
end;

function GetManualUrl(Param: String): String;
begin
  if WizardSilent() then
    Result := Trim(ExpandConstant('{param:cloudapi}'))
  else
    Result := Trim(CodePage.Values[2]);
end;

{ --- Check functions do [Run] (decidem qual provisionamento roda) ----------- }
function IsCodeMode: Boolean;
begin
  if WizardSilent() then
    Result := (Trim(ExpandConstant('{param:code}')) <> '')
  else
    { Roda o provisionamento por código se NAO estiver em modo manual. }
    Result := not ManualCheck.Checked;
end;

function IsManualMode: Boolean;
begin
  if WizardSilent() then
    Result := (Trim(ExpandConstant('{param:token}')) <> '')
  else
    Result := ManualCheck.Checked;
end;

{ Roda APOS o wizard e ANTES de copiar arquivos. Se o servico ExpedHub ja existe e
  esta rodando (reinstalacao/atualizacao), ele segura auth.exe/nssm.exe/etc. e o [Files]
  falha com "Acesso negado" (DeleteFile codigo 5). Paramos o servico aqui pra liberar os
  binarios; o install-service.ps1 do [Run] reinicia depois. Em maquina virgem (sem o
  servico), o sc stop apenas falha em silencio e seguimos. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var rc: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{cmd}'), '/c sc stop ExpedHub', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Sleep(3000); { da tempo do processo soltar os handles dos binarios }
end;

{ ============================================================================
  jwtSecret aleatorio (igual ao exped-hub.iss) + autostart do agente (.vbs)
  ----------------------------------------------------------------------------
  Gera um jwtSecret aleatorio (>=32 chars) no config.json antes do
  install-service.ps1 rodar (so se ainda estiver com o placeholder), e cria o
  .vbs de autostart do agente na pasta Startup do usuario.
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

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigFile: String;
  Content: AnsiString;
  S: String;
  Secret: String;
  vbsPath, vbsBody, agentDir: String;
begin
  { ssPostInstall roda DEPOIS de [Files] (config.json + agente ja copiados) e
    ANTES de [Run] (download/install-service/provision). }
  if CurStep = ssPostInstall then
  begin
    { --- (1) jwtSecret do hub (mesma logica do exped-hub.iss) --------------- }
    ConfigFile := ExpandConstant('{app}\config.json');
    if LoadStringFromFile(ConfigFile, Content) then
    begin
      S := String(Content);
      { So troca se ainda estiver com o placeholder (nao mexe em config de reinstalacao). }
      if Pos('TROCAR-no-install', S) > 0 then
      begin
        Secret := RandomSecret(48);
        StringChangeEx(S, 'TROCAR-no-install-por-segredo-aleatorio-min-32-chars', Secret, True);
        SaveStringToFile(ConfigFile, AnsiString(S), False);
      end;
    end;

    { --- (2) autostart do agente (.vbs na Startup, igual ao ExpedAgent.iss) - }
    agentDir := ExpandConstant('{localappdata}\ExpedAgent');
    vbsPath := ExpandConstant('{userstartup}\ExpedAgent.vbs');
    vbsBody := 'Set sh = CreateObject("WScript.Shell")' + #13#10 +
               'sh.Run "cmd /c ""' + agentDir + '\start.cmd""", 0, False';
    SaveStringToFile(vbsPath, vbsBody, False);
  end;
end;

{ Remove o .vbs da Startup ao desinstalar. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    DeleteFile(ExpandConstant('{userstartup}\ExpedAgent.vbs'));
end;
