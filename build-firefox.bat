@echo off
chcp 65001 >nul
rem 파이어폭스용 서명 없는 .xpi 를 dist 폴더에 만든다 (개발자 에디션/나이틀리용)
setlocal
cd /d "%~dp0extension"
if not exist "..\dist" mkdir "..\dist"
del /q "..\dist\google-ai-local-bridge-unsigned.xpi" 2>nul
"%SystemRoot%\System32\tar.exe" -a -c -f "..\dist\google-ai-local-bridge.zip" manifest.json background.js content.js || exit /b 1
move /y "..\dist\google-ai-local-bridge.zip" "..\dist\google-ai-local-bridge-unsigned.xpi" >nul
echo 완료: %~dp0dist\google-ai-local-bridge-unsigned.xpi
echo 서명 없는 파일이라 일반 파이어폭스에는 설치되지 않습니다. 일반 파이어폭스는 sign-firefox.bat 으로 서명받으세요.
pause
