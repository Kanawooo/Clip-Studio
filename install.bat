@echo off
title Clip Studio Installer
cd /d "%~dp0"

set "CALLED_BY_START=0"
if /i "%~1"=="--from-start" set "CALLED_BY_START=1"

echo ========================================================
echo   Clip Studio - Project Environment Installer
echo ========================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "INSTALL_EXIT=%errorlevel%"

echo.
if not "%INSTALL_EXIT%"=="0" goto INSTALL_FAILED

if "%CALLED_BY_START%"=="1" (
    echo [OK] Installation completed. Returning to start.bat.
    exit /b 0
)

echo [OK] Installation completed. You can now run start.bat.
pause
exit /b 0

:INSTALL_FAILED
echo [ERROR] Installation failed. See the message above.
if "%CALLED_BY_START%"=="1" exit /b %INSTALL_EXIT%
pause
exit /b %INSTALL_EXIT%
