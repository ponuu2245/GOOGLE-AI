' 창 없이 로컬 서버를 켠다. 열 폴더는 같은 폴더의 root.txt 첫 줄.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
root = Trim(fso.OpenTextFile(dir & "\root.txt", 1).ReadLine)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node """ & dir & "\server.js"" """ & root & """ > """ & dir & "\server.log"" 2>&1", 0, False
