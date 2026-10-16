@echo off
cd /d "%~dp0"
py -3 scripts\first_run.py %*
if errorlevel 1 pause
