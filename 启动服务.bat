@echo off
rem ============================================================
rem  FFmpeg Command Generator - launcher
rem
rem  IMPORTANT: this whole file is intentionally ASCII-only.
rem  cmd.exe decodes a .bat file using the active console code page
rem  and reads ahead; mixing a mid-file "chcp" with non-ASCII text
rem  desyncs its line boundaries and later lines fail with
rem  "'xxx' is not recognized as an internal or external command".
rem  Chinese text lives in README.md instead.
rem ============================================================
chcp 65001 >nul
title FFmpeg Command Generator
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Please install it first:
  echo         https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================
echo    FFmpeg Command Generator - starting server
echo   ============================================
echo.
echo    URL:  http://127.0.0.1:8787
echo.
echo    The browser should open automatically.
echo    If not, open the URL above manually.
echo.
echo    Close this window to stop the server.
echo.

node server.js
pause
