@echo off
rem keep venv in user-writable dir (Program Files is read-only)
set "UV_PROJECT_ENVIRONMENT=%LOCALAPPDATA%\xtw\venv"
set "XTW_UV_EXE="
where uv.exe >nul 2>nul && set "XTW_UV_EXE=uv.exe"
if not defined XTW_UV_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\Scripts\uv.exe" set "XTW_UV_EXE=%LOCALAPPDATA%\Programs\Python\Python312\Scripts\uv.exe"
if not defined XTW_UV_EXE if exist "C:\LegacyD\Python\Python312\Scripts\uv.exe" set "XTW_UV_EXE=C:\LegacyD\Python\Python312\Scripts\uv.exe"
if not defined XTW_UV_EXE (
  echo xtw requires uv. Install it from https://docs.astral.sh/uv/ and retry.
  exit /b 1
)
"%XTW_UV_EXE%" run --frozen --project "%~dp0." "%~dp0xtw.py" %*
