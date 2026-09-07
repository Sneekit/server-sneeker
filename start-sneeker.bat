@echo off
rem Autostart wrapper for start-bot.sh.
rem
rem start-bot.sh stays the source of truth for preflight checks, single-instance
rem enforcement and launching node; this file exists only because Windows
rem startup mechanisms (Task Scheduler, the Startup folder) can't run a .sh.
rem
rem Safe to double-click. Registered as a scheduled task, see README.

setlocal

rem start-bot.sh cds to its own directory, so it only needs an absolute path —
rem no reliance on the working directory we're invoked with. MSYS wants forward
rem slashes, so flip them.
set "SNEEKER_DIR=%~dp0"
set "SNEEKER_DIR=%SNEEKER_DIR:\=/%"

set "BASH_EXE=%SNEEKER_BASH%"
if not defined BASH_EXE if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LocalAppData%\Programs\Git\bin\bash.exe"

if not defined BASH_EXE (
  echo ERROR: Git Bash not found. Install Git for Windows, or point SNEEKER_BASH at bash.exe.>&2
  exit /b 1
)

rem -l so the login shell builds a full PATH; start-bot.sh aborts without node.
"%BASH_EXE%" -lc "'%SNEEKER_DIR%start-bot.sh'"
exit /b %ERRORLEVEL%
