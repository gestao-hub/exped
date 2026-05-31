; ExpedAgent.iss — instalador (Inno Setup). Compile no Windows com Inno Setup 6+.
; Instala SEM admin em %LOCALAPPDATA% e configura auto-start no logon do usuário
; (roda start.cmd oculto via .vbs na pasta Startup). Assine o ExpedAgentSetup.exe
; gerado com o certificado de assinatura de código (signtool) antes de distribuir.
;
; Pré-passo (gerar o publish self-contained que este script empacota):
;   dotnet publish ..\ExpedAgent -c Release -o publish

#define MyVersion "1.0.0"

[Setup]
AppName=Exped Agent
AppVersion={#MyVersion}
AppPublisher=Exped
DefaultDirName={localappdata}\ExpedAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=ExpedAgentSetup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName=Exped Agent

[Files]
; Conteúdo do publish (self-contained — máquina final não precisa de runtime).
Source: "publish\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
Source: "start.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Code]
// Cria o .vbs na pasta Startup do usuário, apontando pro start.cmd instalado.
procedure CurStepChanged(CurStep: TSetupStep);
var
  vbsPath, vbsBody, appDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    appDir := ExpandConstant('{app}');
    vbsPath := ExpandConstant('{userstartup}\ExpedAgent.vbs');
    vbsBody := 'Set sh = CreateObject("WScript.Shell")' + #13#10 +
               'sh.Run "cmd /c ""' + appDir + '\start.cmd""", 0, False';
    SaveStringToFile(vbsPath, vbsBody, False);
  end;
end;

// Remove o .vbs da Startup ao desinstalar.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    DeleteFile(ExpandConstant('{userstartup}\ExpedAgent.vbs'));
end;
