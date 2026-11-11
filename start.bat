@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
    echo Could not open the migration folder.
    pause
    exit /b 1
)

if not defined TINYNEWBORN_MIGRATION_HOST set "TINYNEWBORN_MIGRATION_HOST=127.0.0.1"
if not defined TINYNEWBORN_MIGRATION_PORT set "TINYNEWBORN_MIGRATION_PORT=3005"

set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
    set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "%NODE_EXE%" (
    echo Node.js was not found. Install Node.js or add it to PATH.
    pause
    exit /b 1
)

"%NODE_EXE%" -e "const host=process.env.TINYNEWBORN_MIGRATION_HOST, port=Number(process.env.TINYNEWBORN_MIGRATION_PORT), net=require('node:net'); if(!net.isIP(host) || !Number.isInteger(port) || port<1 || port>65535) process.exit(2); const s=net.connect({host:host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host,port}); s.setTimeout(1000); s.on('connect',()=>{s.destroy();process.exitCode=0}); s.on('error',()=>{process.exitCode=1}); s.on('timeout',()=>{s.destroy();process.exitCode=1});"
if errorlevel 2 (
    echo Set TINYNEWBORN_MIGRATION_HOST to a local IP address and TINYNEWBORN_MIGRATION_PORT to a number from 1 to 65535.
    pause
    exit /b 2
)
if not errorlevel 1 (
    echo %TINYNEWBORN_MIGRATION_HOST%:%TINYNEWBORN_MIGRATION_PORT% already has a listener. Skipping startup.
    pause
    exit /b 0
)

"%NODE_EXE%" server.js
set "SERVER_EXIT=%errorlevel%"
if not "%SERVER_EXIT%"=="0" (
    echo TinyNewborn API stopped with exit code %SERVER_EXIT%.
    pause
)
exit /b %SERVER_EXIT%
