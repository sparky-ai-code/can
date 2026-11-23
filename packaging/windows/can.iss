; Inno Setup script for the Can installer (Windows x64). Built by .github/workflows/installers.yml, or by hand:
;   iscc /DAppVersion=0.2.0 /DStageDir=dist\stage\windows-x64 /DOutDir=dist packaging\windows\can.iss
; The installer is per-user: it needs no administrator rights and installs under %LOCALAPPDATA%\Programs\Can.
; It installs the bundled Node runtime, the app and the can / can-mcp commands, then runs agent-setup.js install,
; which copies the agent skill and registers the MCP server for Claude Code and Claude Desktop. Uninstalling
; reverses all of that.

#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\dist\stage\windows-x64"
#endif
#ifndef OutDir
  #define OutDir "..\..\dist"
#endif

#define AppName "Can"
#define AppPublisher "Sparky AI Code"
#define AppURL "https://github.com/sparky-ai-code/Can"

[Setup]
AppId={{6E2F0C1A-3B7D-4C59-9A41-5D0E8F2B7C13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={localappdata}\Programs\Can
DefaultGroupName=Can
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} {#AppVersion}
OutputDir={#OutDir}
OutputBaseFilename=Can-{#AppVersion}-windows-x64-setup
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}

[Tasks]
Name: "path"; Description: "Add the can and can-mcp commands to my PATH (for terminals and agents that run shell commands)"; Flags: checkedonce

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\scripts\agent-setup.js"" install"; StatusMsg: "Setting up the agent skill and the MCP server..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\scripts\agent-setup.js"" uninstall"; RunOnceId: "CanAgentSetupUninstall"; Flags: runhidden waituntilterminated

[Code]
const
  EnvironmentKey = 'Environment';

// True when Entry is already one of the ;-separated items in PathValue (compared without case).
function PathHasEntry(PathValue, Entry: string): Boolean;
begin
  Result := Pos(';' + Lowercase(Entry) + ';', ';' + Lowercase(PathValue) + ';') > 0;
end;

// PathValue without the item equal to Entry. Every other item is kept as it is, empty ones included,
// so a PATH that ends with ";" comes back exactly as it was.
function PathWithoutEntry(PathValue, Entry: string): string;
var
  Rest, Part: string;
  P: Integer;
  First: Boolean;
begin
  Result := '';
  First := True;
  Rest := PathValue;
  repeat
    P := Pos(';', Rest);
    if P > 0 then
    begin
      Part := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end
    else
    begin
      Part := Rest;
      Rest := '';
    end;
    if Lowercase(Part) <> Lowercase(Entry) then
    begin
      if not First then Result := Result + ';';
      Result := Result + Part;
      First := False;
    end;
  until P = 0;
end;

// Appends Entry to the user PATH. A PATH that ends with ";" keeps that ";" after the new entry, so removing
// the entry later restores the original text.
procedure AddToUserPath(Entry: string);
var
  PathValue: string;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', PathValue) then PathValue := '';
  if PathHasEntry(PathValue, Entry) then Exit;
  if (PathValue = '') or (Copy(PathValue, Length(PathValue), 1) = ';') then
    PathValue := PathValue + Entry + ';'
  else
    PathValue := PathValue + ';' + Entry;
  RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', PathValue);
end;

procedure RemoveFromUserPath(Entry: string);
var
  PathValue: string;
begin
  if RegQueryStringValue(HKCU, EnvironmentKey, 'Path', PathValue) then
    RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', PathWithoutEntry(PathValue, Entry));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('path') then
    AddToUserPath(ExpandConstant('{app}\cmd'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromUserPath(ExpandConstant('{app}\cmd'));
end;
