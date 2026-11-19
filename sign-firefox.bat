@echo off
chcp 65001 >nul
rem 모질라(AMO)에 비공개(unlisted)로 서명받아 일반 파이어폭스에 영구 설치할 수 있는 .xpi 를 dist 폴더에 받는다.
rem 키는 이 창에서만 쓰고 파일에 저장하지 않는다.
setlocal
cd /d "%~dp0"

if "%AMO_JWT_ISSUER%"=="" set /p AMO_JWT_ISSUER=JWT issuer (user:12345:67 형태) 입력:
if "%AMO_JWT_SECRET%"=="" set /p AMO_JWT_SECRET=JWT secret 입력:
if "%AMO_JWT_ISSUER%"=="" goto nokey
if "%AMO_JWT_SECRET%"=="" goto nokey
rem issuer 는 user: 로 시작해야 한다. 숫자만 붙여 넣어도 되게 앞에 붙여 준다
if /i not "%AMO_JWT_ISSUER:~0,5%"=="user:" set "AMO_JWT_ISSUER=user:%AMO_JWT_ISSUER%"

if not exist "%~dp0dist" mkdir "%~dp0dist"
call npx --yes web-ext@8 sign ^
  --source-dir "%~dp0extension" ^
  --artifacts-dir "%~dp0dist" ^
  --channel unlisted ^
  --api-key "%AMO_JWT_ISSUER%" ^
  --api-secret "%AMO_JWT_SECRET%"
rem 더블클릭으로 실행하면 끝나자마자 창이 닫히므로, 결과를 읽을 수 있게 pause 로 멈춘다
if errorlevel 1 (
  echo 서명 실패. 위 오류를 확인하세요. 같은 버전은 두 번 서명되지 않으니 manifest.json 의 version 을 올려서 다시 하세요.
  pause
  exit /b 1
)
echo 서명 완료. 아래 파일 중 -unsigned 가 아닌 것을 파이어폭스 창에 끌어다 놓으면 설치됩니다.
dir /b "%~dp0dist\*.xpi"
pause
exit /b 0

:nokey
echo 키가 없습니다. README 의 "파이어폭스 영구 설치" 를 보고 키를 먼저 받으세요.
pause
exit /b 1
