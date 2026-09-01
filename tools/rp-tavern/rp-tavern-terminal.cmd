@echo off
cd /d %~dp0
title RP Tavern TUI
call "%~dp0rp-tavern.cmd" %*
if errorlevel 1 (
  echo.
  echo RP Tavern TUI exited with an error. Press any key to close.
  pause >nul
)

