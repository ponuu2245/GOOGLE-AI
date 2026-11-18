@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\google-ai-bridge.vbs" 2>nul
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3006 -State Listen -EA SilentlyContinue | %% { Stop-Process -Id $_.OwningProcess -Force }"
echo 자동 실행 해제, 실행 중인 서버도 껐습니다.
