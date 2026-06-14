@echo off
rem Launch Forge in dev mode.
rem Unsets ELECTRON_RUN_AS_NODE (set by some shells, e.g. Claude Code's), which
rem would otherwise make electron.exe run as plain Node and crash on startup.
set "ELECTRON_RUN_AS_NODE="
npm run dev
