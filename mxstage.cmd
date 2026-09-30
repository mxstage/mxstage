@echo off
rem MX Stage: one-step local setup. Double-click this file.
rem To undo:  .\mxstage.cmd --uninstall
rem This file is plain ASCII on purpose so that it works on any Windows code page.
setlocal
cd /d "%~dp0"
title MX Stage

where node > /dev/null 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\setup-local.mjs" %*
set "MXS_CODE=%ERRORLEVEL%"
echo.
if not "%MXS_CODE%"=="0" echo Some steps failed. Check the [NG] lines and the arrow lines above, then try again.
pause
exit /b %MXS_CODE%
