@echo off
setlocal
rem Swap in the staged guest-session patch. Build it first with:
rem   node tools\patch-guest-session.mjs apply
rem Then quit DSH Desktop completely and run this file.
set "HERE=%~dp0"
set "ARCHIVE=D:\DeepSeek Harness\resources\app.asar"
set "NODE=node"
where node >nul 2>nul || set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%ARCHIVE%.patched" (
  echo.
  echo Nothing staged: run "node tools\patch-guest-session.mjs apply" first.
  echo.
  pause
  exit /b 1
)

tasklist /fi "imagename eq DeepSeek Harness.exe" 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo.
  echo DSH Desktop is still running. Quit it completely first, then run this file again.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%HERE%patch-guest-session.mjs" apply --archive "%ARCHIVE%" --commit
if errorlevel 1 (
  echo.
  echo Commit failed. app.asar is untouched; app.asar.orig still holds the original.
)
echo.
pause
