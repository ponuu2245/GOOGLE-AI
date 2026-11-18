@echo off
chcp 65001 >nul
rem 윈도우 로그인 때 서버를 창 없이 자동 실행. 사용법: autostart-on.bat "열 폴더"
cd /d "%~dp0"
if not "%~1"=="" (echo %~1> root.txt)
if not exist root.txt (echo 열 폴더를 적어 주세요: autostart-on.bat "E:\내폴더" & exit /b 1)
echo Set s=CreateObject("WScript.Shell"):s.Run "wscript ""%~dp0start-hidden.vbs""",0,False> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\google-ai-bridge.vbs"
echo 자동 실행 등록 완료. 열 폴더:
type root.txt
