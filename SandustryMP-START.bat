@echo off
title SandustryMP by Cr0ss0vr
rem Place this file in the main Sandustry game folder (next to Sandustry.exe).
rem It removes app.asar if Steam has restored it (otherwise the game will load the version without the mod),
rem then launches the game.
if exist "%~dp0resources\app.asar" (
    echo Steam restored app.asar - removing it so the mod works...
    del /f /q "%~dp0resources\app.asar"
)
start "" "%~dp0Sandustry.exe"
