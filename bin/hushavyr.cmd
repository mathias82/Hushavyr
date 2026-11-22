@echo off
rem hushavyr: private AI code review in the terminal. Runs dist\terminal\repl.js with Node 18+,
rem or with the editor runtime (HUSHAVYR_NODE, set by the VS Code extension) when Node is missing.
setlocal
set "CLI=%~dp0..\dist\terminal\repl.js"
where node >nul 2>nul || goto editor
node "%CLI%" %*
exit /b %ERRORLEVEL%
:editor
if not defined HUSHAVYR_NODE goto missing
set ELECTRON_RUN_AS_NODE=1
"%HUSHAVYR_NODE%" "%CLI%" %*
exit /b %ERRORLEVEL%
:missing
echo hushavyr: Node.js 18 or later was not found. Install it from https://nodejs.org, or run hushavyr from the VS Code terminal. 1>&2
exit /b 127
