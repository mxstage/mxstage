@echo off
rem mxstudio: one-step local setup. Double-click this file.
rem To undo:  .\mxstudio.cmd --uninstall
rem NOTE: this file is saved in Shift_JIS (cp932) on purpose. cmd.exe misparses a batch
rem file that mixes UTF-8 Japanese text with chcp, so do not convert it to UTF-8.
setlocal
cd /d "%~dp0"
title mxstudio

where node > nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。
  echo https://nodejs.org から LTS 版を入れてから、このファイルをもう一度実行してください。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\setup-local.mjs" %*
set "MXS_CODE=%ERRORLEVEL%"
echo.
if not "%MXS_CODE%"=="0" echo 失敗した手順があります。上の [NG] と矢印の行を見てやり直してください。
pause
exit /b %MXS_CODE%
