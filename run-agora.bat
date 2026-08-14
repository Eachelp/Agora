@echo off
chcp 949 >nul
cd /d "%~dp0"
echo Agora 실행 중입니다. 이 창을 닫지 마세요.
echo 앱을 끄려면 Agora 창을 닫으세요.
echo.
call npm start
if errorlevel 1 goto :fail
exit /b

:fail
echo.
echo [오류] 문제가 발생했습니다.
echo 먼저 Agora-설치하기.bat 를 한 번 실행했는지 확인하세요.
pause
