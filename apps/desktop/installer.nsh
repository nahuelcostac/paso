; Additions to electron-builder's one-click NSIS installer for Paso (packaging-config.mjs, `nsis.include`).
!include FileFunc.nsh

; Paso installs to <per-user Programs>\Paso. electron-builder names the folder after the package name, paso-desktop,
; and an upgrade reuses the folder the previous install recorded: 0.1.0-rc.1 installed to Programs\paso-desktop. Either
; way the folder becomes Paso. The previous version's uninstaller still runs first, from where it was installed, so the
; upgrade leaves one install, one uninstall entry and one set of shortcuts.
!macro customInit
  ${GetFileName} "$INSTDIR" $R0
  ${If} $R0 == "paso-desktop"
    ${GetParent} "$INSTDIR" $R1
    StrCpy $INSTDIR "$R1\Paso"
  ${EndIf}
!macroend

; electron-builder keeps a copy of the installer in %LOCALAPPDATA%\paso-desktop-updater for electron-updater's
; differential downloads. Paso has no automatic updates yet (ESC-11), so the copy is removed, and its folder if empty.
!macro customInstall
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
  RMDir "$R0"
!macroend
