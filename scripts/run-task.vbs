' Launcher for the PCBuilder scheduled tasks: runs an npm script in a hidden window.
'   wscript.exe run-task.vbs <npm-script> <log-file-in-.runtime>
'   e.g. run-task.vbs catalog:prices zol-prices-scheduled.log
'        run-task.vbs catalog:discover zol-discover-scheduled.log
' Running cmd.exe directly shows a console window; closing it kills the task (exit 0xC000013A).
' The project root is the parent of this script's folder, so no non-ASCII path is written here
' (VBScript reads files in the system ANSI code page). Keep this file ASCII-only.
Option Explicit
Dim shell, fso, root, script, logName, cmd
If WScript.Arguments.Count < 2 Then WScript.Quit 64
script = WScript.Arguments(0)
logName = WScript.Arguments(1)
' Only plain npm script names and log file names, nothing that could chain shell commands
If Not ValidName(script) Or Not ValidName(logName) Then WScript.Quit 64
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "cmd /c cd /d """ & root & """ && echo ==== %date% %time% >> .runtime\" & logName & _
      " && npm run " & script & " >> .runtime\" & logName & " 2>&1"
' 0 = hidden window, True = wait, so the task gets the real exit code
WScript.Quit shell.Run(cmd, 0, True)

Function ValidName(value)
  Dim re
  Set re = New RegExp
  re.Pattern = "^[A-Za-z0-9:._-]+$"
  ValidName = re.Test(value)
End Function
