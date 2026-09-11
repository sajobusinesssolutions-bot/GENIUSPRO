@echo off
REM ===========================================================
REM  Genius POS - build the Windows installer
REM
REM  Double-click this on a Windows PC with Node.js installed.
REM  It installs what is needed, builds the interface, and writes
REM  two files into dist-desktop\ :
REM
REM     Genius-POS-Setup-1.42.0.exe      the installer
REM     Genius-POS-1.42.0-portable.exe   runs from a USB stick
REM
REM  The first run downloads Electron (about 90 MB) and takes a
REM  few minutes. After that it is quick.
REM ===========================================================
setlocal
cd /d "%~dp0"

echo.
echo  Genius POS - Windows build
echo  =================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Get the LTS version from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo  Node %%v
echo.

echo  [1/4] Packaging tools...
call npm install --no-audit --no-fund || goto :failed

echo.
echo  [2/4] The interface...
call npm --prefix frontend install --no-audit --no-fund || goto :failed
call npm --prefix frontend run build || goto :failed

echo.
echo  [3/4] The server...
call npm --prefix backend install --omit=dev --no-audit --no-fund || goto :failed

echo.
echo  [4/4] The installer... (this is the slow one)
call npx electron-builder --win nsis portable --x64 || goto :failed

echo.
echo  ================================================
echo   Done. Look in  dist-desktop\
echo.
dir /b dist-desktop\*.exe 2>nul
echo.
echo   Powered by SALJO TECH
echo  ================================================
echo.
pause
exit /b 0

:failed
echo.
echo  ------------------------------------------------
echo   That did not finish. The last message above says
echo   why. The usual causes:
echo.
echo     - no internet on the first run
echo     - a company proxy blocking npm
echo     - antivirus holding the .exe while it is written
echo  ------------------------------------------------
echo.
pause
exit /b 1
