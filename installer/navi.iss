; Gerar com: build.ps1 (passa /DAppVersion=x.y.z)
#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif

[Setup]
; Mesmo AppId do Des_Atento e do Navi: instalar o N.avi atualiza a instalação antiga (não mude).
AppId={{B7C1D8E2-4F3A-4C55-9A61-5D0E7A2F9C14}
AppName=N.avi
AppVersion={#AppVersion}
AppPublisher=N.avi
; Instalação por usuário: atualizar não pede administrador.
PrivilegesRequired=lowest
DefaultDirName={autopf}\N.avi
DefaultGroupName=N.avi
; Sempre na pasta nova, mesmo que a instalação antiga (Des_Atento, Navi) esteja em outra: o Inno reaproveitaria
; a pasta anterior, e o N.avi ficaria dentro de "Des_Atento". A pasta antiga é limpa no fim (ver [Code]).
UsePreviousAppDir=no
DisableProgramGroupPage=yes
OutputDir=..\dist
; O nome do arquivo continua o mesmo: as versões já instaladas procuram "Navi_Setup.exe" para se atualizar.
OutputBaseFilename=Navi_Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\navi.exe
WizardImageFile=..\assets\wizard.bmp
WizardSmallImageFile=..\assets\wizard_small.bmp
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "Iniciar com o Windows (necessário para o Monitoramento medir o dia todo)"; GroupDescription: "Opções:"; Flags: unchecked

[InstallDelete]
; Restos das versões antigas (Des_Atento e Navi): o executável antigo e os atalhos com o nome antigo.
Type: files; Name: "{app}\des_atento.exe"
Type: files; Name: "{group}\Des_Atento.lnk"
Type: files; Name: "{group}\Navi.lnk"
Type: files; Name: "{autodesktop}\Des_Atento.lnk"
Type: files; Name: "{autodesktop}\Navi.lnk"
Type: files; Name: "{userprograms}\Des_Atento\Des_Atento.lnk"
Type: dirifempty; Name: "{userprograms}\Des_Atento"
Type: files; Name: "{userprograms}\Navi\Navi.lnk"
Type: dirifempty; Name: "{userprograms}\Navi"

[Files]
Source: "..\target\release\navi.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\N.avi"; Filename: "{app}\navi.exe"
Name: "{autodesktop}\N.avi"; Filename: "{app}\navi.exe"; Tasks: desktopicon

[Registry]
; Início automático: os valores antigos apontavam para a pasta antiga; saem, e o novo aponta para o executável daqui.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "Des_Atento"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "Navi"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "N.avi"; ValueData: """{app}\navi.exe"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Instalação normal: caixa "Abrir o N.avi".
Filename: "{app}\navi.exe"; Description: "Abrir o N.avi"; Flags: nowait postinstall skipifsilent
; Atualização silenciosa feita pelo próprio app: reabre automaticamente.
Filename: "{app}\navi.exe"; Flags: nowait; Check: WizardSilent


[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7C1D8E2-4F3A-4C55-9A61-5D0E7A2F9C14}_is1';

var
  OldAppDir: String;

{ Pasta da instalação anterior (mesmo AppId), lida antes de esta instalação trocar o registro. }
function FindPreviousAppDir(): String;
var
  Path: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', Path) or
     RegQueryStringValue(HKLM, UninstallKey, 'Inno Setup: App Path', Path) then
    Result := RemoveBackslashUnlessRoot(Trim(Path));
end;

function InitializeSetup(): Boolean;
begin
  OldAppDir := FindPreviousAppDir();
  Result := True;
end;

{ Limpa a pasta da instalação antiga quando a nova foi para outra pasta. Só apaga o que um instalador nosso
  pôs lá (os executáveis e o desinstalador, que o registro já não usa mais); a pasta só sai se ficar vazia, e a
  pasta de dados (%APPDATA%\Navi) nunca é tocada. }
procedure RemoveOldInstall();
var
  NewDir: String;
begin
  if OldAppDir = '' then
    Exit;
  NewDir := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  if CompareText(OldAppDir, NewDir) = 0 then
    Exit;
  { O app antigo pode ainda estar fechando: tenta algumas vezes antes de desistir. }
  DelayDeleteFile(OldAppDir + '\navi.exe', 12);
  DelayDeleteFile(OldAppDir + '\des_atento.exe', 12);
  DeleteFile(OldAppDir + '\unins000.exe');
  DeleteFile(OldAppDir + '\unins000.dat');
  DeleteFile(OldAppDir + '\unins000.msg');
  RemoveDir(OldAppDir);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RemoveOldInstall();
end;
