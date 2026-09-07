@echo off
REM Copyright (c) 2026, Antoine Duval
REM Build the Windows application-loopback audio helper.
REM Run from an "x64 Native Tools Command Prompt for VS 2022", in native\ :
REM   build.bat
REM Requires the Windows SDK 10.0.20348 or newer (audioclientactivationparams.h).

cl /nologo /std:c++17 /EHsc /O2 /W3 audio_loopback.cpp ^
   /Fe:audio_loopback.exe ^
   /link ole32.lib mmdevapi.lib user32.lib
if errorlevel 1 goto :error

if not exist "..\binaries\audio-loopback" mkdir "..\binaries\audio-loopback"
move /y audio_loopback.exe ..\binaries\audio-loopback\win32.exe
del audio_loopback.obj

echo Done! Binary at ..\binaries\audio-loopback\win32.exe
exit /b 0

:error
echo Build failed.
exit /b 1
