@echo off
cd /d %~dp0
title xtw
echo xtw - X(Twitter) terminal reader
echo   xtw            TUI mode (default)
echo   xtw feed [N]   For you timeline
echo   xtw latest [N] Following timeline
echo   xtw tweet ^<id^> read a tweet + replies
echo   xtw search ^<q^> search tweets
echo   xtw login      export cookies from debug browser (one-time)
echo.
cmd /k
