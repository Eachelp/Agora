@echo off
chcp 949 >nul
cd /d "%~dp0"
title Agora 업데이트

echo ============================================
echo    Agora 최신 버전으로 업데이트
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 goto :nogit

echo [1/2] GitHub에서 최신 코드 받는 중...
call git pull
if errorlevel 1 goto :pullfail
echo.

echo [2/2] 변경된 구성요소 반영 중...
call npm install
if errorlevel 1 goto :installfail
echo.

echo ============================================
echo   업데이트 완료. 바탕화면 Agora 아이콘으로
echo   그대로 실행하시면 됩니다.
echo ============================================
echo.
pause
exit /b

:nogit
echo.
echo [안내] git 이 설치되어 있지 않습니다.
echo https://git-scm.com 에서 설치한 뒤 다시 실행해 주세요.
pause
exit /b

:pullfail
echo.
echo [오류] 코드를 받는 중 문제가 발생했습니다.
echo 인터넷 연결을 확인하거나, 로컬에서 파일을 직접 수정했다면
echo 충돌이 있을 수 있습니다.
pause
exit /b

:installfail
echo.
echo [오류] 구성요소 설치 중 문제가 발생했습니다.
pause
exit /b
