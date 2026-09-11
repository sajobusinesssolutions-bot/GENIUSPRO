@echo off
REM ============================================================
REM  Genius POS - updater
REM  Replaces program files from a new genius-pos.zip
REM  KEEPS your data (backend\data) and settings untouched.
REM ============================================================
setlocal
echo.
echo  Genius POS - Updater
echo  ------------------------------
set /p ZIPPATH="Drag the new genius-pos.zip here and press Enter: "
set ZIPPATH=%ZIPPATH:"=%
if not exist "%ZIPPATH%" ( echo Zip not found: %ZIPPATH% & pause & exit /b 1 )

echo Backing up your data...
if exist backend\data xcopy /e /i /y backend\data "%TEMP%\genius-data-backup" >nul

echo Extracting update...
powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '%ZIPPATH%' -DestinationPath '%TEMP%\genius-update'"

echo Applying update (program files only)...
REM The update ships source, not a prebuilt bundle, so the old build must go —
REM otherwise the server keeps serving it and nothing appears to have changed.
REM start.bat rebuilds automatically on the next run.
if exist frontend\dist rmdir /s /q frontend\dist
xcopy /e /y "%TEMP%\genius-update\genius-pos\backend" backend\ >nul
if exist frontend\src rmdir /s /q frontend\src
xcopy /e /i /y "%TEMP%\genius-update\genius-pos\frontend\src" frontend\src\ >nul
copy /y "%TEMP%\genius-update\genius-pos\frontend\index.html" frontend\index.html >nul
copy /y "%TEMP%\genius-update\genius-pos\frontend\package.json" frontend\package.json >nul
copy /y "%TEMP%\genius-update\genius-pos\frontend\vite.config.js" frontend\vite.config.js >nul
copy /y "%TEMP%\genius-update\genius-pos\start.bat" start.bat >nul
copy /y "%TEMP%\genius-update\genius-pos\CHANGELOG.txt" CHANGELOG.txt >nul 2>nul
copy /y "%TEMP%\genius-update\genius-pos\update.bat" update.bat >nul 2>nul

echo Restoring your data...
if exist "%TEMP%\genius-data-backup" xcopy /e /i /y "%TEMP%\genius-data-backup" backend\data >nul

echo Refreshing server packages (first run after update may take a minute)...
cd backend & call npm install --no-audit --no-fund --loglevel=error & cd ..

echo.
echo  Update complete. Start the app with start.bat
pause
