@echo off
rem Wrapper que aloca console (o host usa ConsoleLifetime) e redireciona o log.
cd /d "%~dp0"
"%~dp0ExpedAgent.exe" >> "%~dp0agent.log" 2>&1
