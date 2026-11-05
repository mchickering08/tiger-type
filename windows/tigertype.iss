; Inno Setup script for the Tiger Type Windows installer.
; GitHub Actions runs this automatically. See .github/workflows/windows-installer.yml.
; It expects the built server (with jre\ and languagetool\ inside) at ..\dist\TigerTypeServer.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{6F1B2C8E-7D4A-4E3B-9C21-5A0F7E3D9B11}
AppName=Tiger Type
AppVersion={#AppVersion}
AppPublisher=GCDS Student Government
DefaultDirName={localappdata}\Programs\Tiger Type
DefaultGroupName=Tiger Type
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TigerTypeSetup
SetupIconFile=tigertype.ico
UninstallDisplayIcon={app}\TigerTypeServer.exe
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Put a Tiger Type shortcut on the desktop"; Flags: unchecked

[Files]
Source: "..\dist\TigerTypeServer\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Tiger Type Server"; Filename: "{app}\TigerTypeServer.exe"
Name: "{autodesktop}\Tiger Type Server"; Filename: "{app}\TigerTypeServer.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\TigerTypeServer.exe"; Description: "Start Tiger Type now"; Flags: nowait postinstall skipifsilent
