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
;  sao baixados no [Run] por download-binaries.ps1. Para fazer um instalador
;  "offline" (pre-bundlado), copie esses binarios pra payload\bin\ antes de
;  compilar e comente o passo de download no [Run] (ver comentario la embaixo).
; ============================================================================

#define MyAppName "Exped Hub"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Exped"
; Raiz fixa C:\Exped (convencao do hub; maestro.mjs resolve paths a partir dela).
#define InstallRoot "C:\Exped"
; Pasta de payload relativa a este .iss (hub\win\).
#define Payload "payload"

[Setup]
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

; --- Local-stack: SQL de bootstrap + gateway + scripts auxiliares -----------
Source: "{#Payload}\scripts\local-stack\*"; DestDir: "{app}\scripts\local-stack"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- GoTrue (auth.exe + migrations) — vem do payload, NAO é baixado ---------
Source: "{#Payload}\bin\auth.exe";          DestDir: "{app}\bin";   Flags: ignoreversion
Source: "{#Payload}\bin\migrations\*";      DestDir: "{app}\bin\migrations"; Flags: recursesubdirs createallsubdirs ignoreversion

; --- Scripts de servico/download (ficam em C:\Exped\hub\win pra reuso) -------
Source: "download-binaries.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "install-service.ps1";              DestDir: "{app}\hub\win"; Flags: ignoreversion
Source: "uninstall-service.ps1";            DestDir: "{app}\hub\win"; Flags: ignoreversion

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

[Run]
; A ORDEM importa:
;   1. download-binaries.ps1  -> baixa Postgres/PostgREST/Node/NSSM pra bin\
;      (COMENTE este passo se voce pre-bundlou os binarios — ver [Files] acima)
;   2. (gerar jwtSecret real no config.json — feito em [Code] PrepareToInstall)
;   3. install-service.ps1    -> registra+inicia o serviço ExpedHub e abre o firewall
; O bootstrap do banco (criar DB/auth/schema) é feito pelo MAESTRO no 1o start;
; nao ha passo de bootstrap aqui.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\download-binaries.ps1"" -InstallDir ""{app}\bin"""; \
    StatusMsg: "Baixando binarios (PostgreSQL, PostgREST, Node, NSSM)..."; \
    Flags: runhidden

Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\install-service.ps1"" -Root ""{app}"" -ConfigPath ""{app}\config.json"""; \
    StatusMsg: "Registrando e iniciando o serviço ExpedHub..."; \
    Flags: runhidden

[UninstallRun]
; Para+remove o serviço e a regra de firewall ANTES de apagar os arquivos.
; Preserva C:\Exped\data por padrao (uninstall-service.ps1 sem -RemoveData).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\hub\win\uninstall-service.ps1"" -Root ""{app}"""; \
    RunOnceId: "RemoveExpedHubService"; \
    Flags: runhidden

[UninstallDelete]
; Limpa o que foi baixado/gerado em runtime (nao versionado). data\ NAO entra
; aqui (uninsneveruninstall + preservado pelo uninstall-service).
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\releases"

[Code]
{ Gera um jwtSecret aleatorio (>=32 chars) e o grava no config.json antes do
  install-service.ps1 rodar, substituindo o placeholder do config.example.json.
  Assim cada instalacao tem um segredo unico. Se o config.json ja existir
  (reinstalacao), preservamos o jwtSecret existente. }

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
begin
  { ssPostInstall roda DEPOIS de [Files] (config.json ja copiado) e ANTES de [Run]. }
  if CurStep = ssPostInstall then
  begin
    Randomize;
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
  end;
end;
