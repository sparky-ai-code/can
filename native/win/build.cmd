@echo off
rem Builds native\win\build\can-memcap.exe with the .NET Framework 4 C# compiler that ships with Windows.
setlocal
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo ENOENT: csc.exe not found at "%CSC%". Next: enable the .NET Framework 4.8 feature in Windows Features, then rerun this script.
  exit /b 1
)
if not exist "%~dp0build" mkdir "%~dp0build"
"%CSC%" /nologo /optimize /platform:x64 /target:exe /out:"%~dp0build\can-memcap.exe" "%~dp0CanMemcap.cs"
if errorlevel 1 (
  echo EINVAL: csc.exe failed on CanMemcap.cs. Next: read the compiler errors above and fix the source.
  exit /b 1
)
echo built "%~dp0build\can-memcap.exe"
exit /b 0
