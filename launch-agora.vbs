Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' npm을 거치면 cmd → npm(node) → electron.cmd → node 순으로 프로세스를 네 번 더
' 띄운 뒤에야 electron이 시작한다. 이 PC에서 npm 기동만 0.35~0.5초였다. 설치된
' 바이너리가 있으면 그것을 직접 실행해 창이 그만큼 빨리 뜨게 한다.
electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electronExe) Then
  shell.Run """" & electronExe & """ """ & scriptDir & """", 0, False
Else
  ' 아직 설치 전(node_modules 없음)이면 기존 경로로 둔다 — 안내 문구가 거기 있다.
  shell.Run "cmd /c npm start", 0, False
End If
