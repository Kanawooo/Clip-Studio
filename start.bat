@echo off
title Clip Studio
cd /d "%~dp0"

set "AUTO_INSTALL_ATTEMPTED=0"

:START_CLIP_STUDIO
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "START_EXIT=%errorlevel%"

if "%START_EXIT%"=="0" exit /b 0
if not "%START_EXIT%"=="20" goto START_FAILED
if "%AUTO_INSTALL_ATTEMPTED%"=="1" goto START_FAILED

set "AUTO_INSTALL_ATTEMPTED=1"
echo.
echo [INFO] Starting install.bat automatically...
call "%~dp0install.bat" --from-start
set "INSTALL_EXIT=%errorlevel%"
if not "%INSTALL_EXIT%"=="0" goto INSTALL_FAILED

echo.
echo [OK] Installation completed. Continuing startup...
goto START_CLIP_STUDIO

:INSTALL_FAILED
echo.
echo [ERROR] Automatic installation failed. Clip Studio did not start.
pause
exit /b %INSTALL_EXIT%

:START_FAILED
echo.
echo [ERROR] Clip Studio did not start.
pause
exit /b %START_EXIT%
