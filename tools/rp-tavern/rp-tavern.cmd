@echo off
setlocal
set "UV_PROJECT_ENVIRONMENT=%LOCALAPPDATA%\rp-tavern\venv"
set "RP_TAVERN_UV_EXE="
where uv.exe >nul 2>nul && set "RP_TAVERN_UV_EXE=uv.exe"
if not defined RP_TAVERN_UV_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\Scripts\uv.exe" set "RP_TAVERN_UV_EXE=%LOCALAPPDATA%\Programs\Python\Python312\Scripts\uv.exe"
if not defined RP_TAVERN_UV_EXE if exist "C:\LegacyD\Python\Python312\Scripts\uv.exe" set "RP_TAVERN_UV_EXE=C:\LegacyD\Python\Python312\Scripts\uv.exe"
if not defined RP_TAVERN_UV_EXE (
  echo RP Tavern TUI requires uv. Install it from https://docs.astral.sh/uv/ and retry.
  exit /b 1
)
"%RP_TAVERN_UV_EXE%" run --frozen --project "%~dp0." "%~dp0rp_tavern_tui.py" %*

