@echo off
title Genius POS
cd /d "%~dp0"

echo ============================================
echo   Genius POS - till, stock ^& books
echo ============================================
echo.

REM ── 1) Check Node.js is installed ──────────────────────────
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo.
  echo Please install Node.js LTS from:  https://nodejs.org
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo Node.js %%v found.

REM ── 2) Install backend dependencies on first run ───────────
if not exist "backend\node_modules" (
  echo.
  echo First-time setup: installing dependencies...
  echo This happens only once and needs internet access.
  cd backend
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
  cd ..
)

REM ── 3) Build the web app if the source has changed ─────────
REM Updates ship source, not a bundle. This used to ask "does dist exist",
REM which after the very first build was always yes - so the server went on
REM serving whatever was compiled on the day the shop was installed, and no
REM update ever reached the screen. needs-build.cjs fingerprints the source
REM and compares it with what was last built.
cd frontend
node needs-build.cjs
if errorlevel 1 (
  echo.
  echo Building the app... this takes a minute and needs internet access.
  echo It only happens when something has changed.
  if not exist "node_modules" call npm install --no-audit --no-fund
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed. Check your internet connection and try again.
    cd ..
    pause
    exit /b 1
  )
  node needs-build.cjs --stamp
  echo Build complete.
)

REM A component that is used but never defined builds perfectly well and then
REM blanks the screen the moment React reaches it - which is exactly what
REM happened with the trial banner. This finds that in a second. It warns
REM rather than stops: a checker is not worth keeping a shop shut for.
node check-components.mjs
if errorlevel 1 (
  echo.
  echo [WARNING] Some screens reference something that does not exist.
  echo           They will show an error instead of loading. Reported above.
  echo.
)

REM A button that calls an address the server does not serve builds perfectly
REM well too, and answers 404 the first time somebody presses it. The Parties
REM screen's Delete did exactly that for months.
node check-routes.mjs
if errorlevel 1 (
  echo.
  echo [WARNING] Some screens call an address the server does not answer.
  echo           Those buttons will fail. Reported above.
  echo.
)

REM Every setting the setup wizard writes has to exist on the server, which
REM ignores a key it does not know - so a typo does nothing and looks fine.
node check-setup-keys.mjs
if errorlevel 1 (
  echo.
  echo [WARNING] The setup wizard writes a setting the server does not know.
  echo.
)
cd ..

REM ── 4) Prepare the database (skips automatically if already done) ─
REM No sample data. For a demo shop instead, run:  cd backend ^&^& node seed.js --demo
cd backend

REM The key that signs sessions. Made once on this machine and kept in
REM data\session.key. Without it the server falls back to a development key
REM that every copy shares - and this window prints the shop's LAN address a
REM few lines below, so anyone on that Wi-Fi could forge an admin token.
for /f "usebackq delims=" %%k in (`node shared\firstrun.js --key`) do set "JWT_SECRET=%%k"
if not defined JWT_SECRET (
  echo [ERROR] Could not create the session key. Check that data\ is writable.
  cd ..
  pause
  exit /b 1
)

REM Money-maths self-check. These are fast, need no internet, and guard the
REM calculations that carry real shillings. If they ever fail, something is
REM wrong with tax, unit conversion or costing — don't take sales until it's fixed.
node test\run.js
if errorlevel 1 (
  echo.
  echo [STOP] The money-maths self-check failed. Not starting.
  echo        Please report this — the calculations may be wrong.
  cd ..
  pause
  exit /b 1
)

REM Set the shop up if it has not been: the company, the roles, the chart of
REM accounts - and no logins. The first screen in the browser asks who you are
REM and what password you want, so there is never a moment where a working
REM password exists that nobody chose.
node -e "require('./shared/firstrun').ensureSeeded().catch(e=>{console.error(e.message);process.exit(1)})"
if errorlevel 1 (
  echo [ERROR] Could not set up the first accounts.
  cd ..
  pause
  exit /b 1
)
cd ..

REM ── 5) Start the server and open the browser ───────────────
echo.
echo Starting Genius POS at http://localhost:3000
echo.
echo Other devices on the same Wi-Fi / LAN can open:
for /f "tokens=14" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do echo    http://%%a:3000
echo (If blocked on other devices, allow Node.js in Windows Firewall)
echo.
echo On the FIRST run the browser asks who you are: your name, the name you
echo will sign in with, and a password you choose. After that it is a normal
echo sign-in screen, and you add the rest of your staff under Settings ^> Users.
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C here to stop the server.
echo.
start "" http://localhost:3000
cd backend
node server.js
pause
