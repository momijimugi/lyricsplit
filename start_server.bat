@echo off
setlocal

cd /d "%~dp0"
set "LYRICLAB_PORT=8010"
set "LYRICLAB_URL=http://127.0.0.1:%LYRICLAB_PORT%/index.html"

where py >nul 2>nul
if %errorlevel%==0 (
  set "LYRICLAB_PYTHON=py"
  goto :start
)

where python >nul 2>nul
if %errorlevel%==0 (
  set "LYRICLAB_PYTHON=python"
  goto :start
)

echo.
echo [LYRICLAB] Python was not found.
echo Install Python 3, then run this file again.
echo https://www.python.org/downloads/
echo.
pause
exit /b 1

:start
title LYRICLAB Local Server
echo.
echo ========================================
echo   LYRICLAB Local Server
echo ========================================
echo.
echo URL: %LYRICLAB_URL%
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process '%LYRICLAB_URL%'"
%LYRICLAB_PYTHON% -m http.server %LYRICLAB_PORT% --bind 127.0.0.1

echo.
echo Server stopped.
pause
