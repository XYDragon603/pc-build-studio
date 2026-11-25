' Launcher for scheduled task PCBuilder-RefreshPrices: runs "npm run catalog:prices" in a hidden window.
' Running cmd.exe directly shows a console window; closing it kills the task (exit 0xC000013A, no prices refreshed).
' The project root is the parent of this script's folder, so no non-ASCII path is written here
' (VBScript reads files in the system ANSI code page). Keep this file ASCII-only.
Option Explicit
Dim shell, fso, root, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "cmd /c cd /d """ & root & """ && echo ==== %date% %time% >> .runtime\zol-prices-scheduled.log" & _
      " && npm run catalog:prices >> .runtime\zol-prices-scheduled.log 2>&1"
' 0 = hidden window, True = wait, so the task gets the real exit code
WScript.Quit shell.Run(cmd, 0, True)
