@echo off
rem Wrapper que aloca console (o host usa ConsoleLifetime) e redireciona o log.
cd /d "%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-log-settings.ps1" -SettingsPath "%~dp0appsettings.json" >nul 2>&1
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0rotate-log.ps1" -Path "%~dp0agent.log" -MaxBytes 67108864 -Backups 2 >nul 2>&1
"%~dp0ExpedAgent.exe" >> "%~dp0agent.log" 2>&1
