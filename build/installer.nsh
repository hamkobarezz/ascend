; Ascend installer look: instead of the grey Windows progress bar, fade in the Ascend splash
; (build/installer-splash.bmp, made by scripts/make-installer-splash.js), install silently,
; then open the app, which continues with the same screen animated.
; Command-line silent installs (/S) are left alone: no splash and no auto-launch.

!ifndef BUILD_UNINSTALLER
  Var ascendSplash

  !macro customInit
    ${IfNot} ${Silent}
      InitPluginsDir
      File "/oname=$PLUGINSDIR\splash.bmp" "${BUILD_RESOURCES_DIR}\installer-splash.bmp"
      ; show for 1.6 s, fade in 0.35 s, fade out 0.3 s, no transparent colour
      advsplash::show 1600 350 300 -1 "$PLUGINSDIR\splash"
      Pop $0
      StrCpy $ascendSplash "1"
      SetSilent silent
    ${EndIf}
  !macroend

  !macro customInstall
    ; $launchLink is the Start-menu shortcut (or the exe), set by the template just before this macro.
    ${If} $ascendSplash == "1"
      ExecShell "open" "$launchLink"
    ${EndIf}
  !macroend
!endif
