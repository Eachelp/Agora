@echo off
chcp 949 >nul
cd /d "%~dp0"
title Agora 설치

echo ============================================
echo    Agora 설치 및 바탕화면 실행 버튼 만들기
echo ============================================
echo.

echo [1/3] Node.js 설치 여부 확인 중...
where node >nul 2>nul
if errorlevel 1 goto :nonode
for /f "delims=" %%v in ('node -v') do echo     Node.js %%v 확인됨
echo.
goto :install

:nonode
echo.
echo [안내] Node.js 가 설치되어 있지 않습니다.
echo 방금 다운로드 페이지를 열었습니다. LTS 버전을 설치한 뒤
echo 이 파일 Agora-설치하기.bat 을 다시 더블클릭해 주세요.
start "" https://nodejs.org/ko
echo.
pause
exit /b

:install
echo [2/3] 필요한 구성요소 설치 중입니다. 처음 한 번만 몇 분 걸릴 수 있습니다.
call npm install
if errorlevel 1 goto :installfail
echo     설치 완료
echo.
goto :shortcut

:installfail
echo.
echo [오류] 설치 중 문제가 발생했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
pause
exit /b

:shortcut
echo [3/3] 바탕화면에 Agora 실행 버튼을 만드는 중입니다...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $sh=New-Object -ComObject WScript.Shell; $lnk=$sh.CreateShortcut((Join-Path $d 'Agora.lnk')); $lnk.TargetPath='%~dp0launch-agora.vbs'; $lnk.WorkingDirectory='%~dp0'; $lnk.IconLocation='%~dp0build\icon.ico'; $lnk.Description='Agora'; $lnk.Save()"
if errorlevel 1 goto :shortcutfail
echo     완료
echo.
echo ============================================
echo   설치가 끝났습니다. 이제 바탕화면의 Agora 아이콘을
echo   더블클릭하면 앱이 실행됩니다.
echo ============================================
echo.
pause
exit /b

:shortcutfail
echo.
echo [오류] 바로가기 생성에 실패했습니다.
pause
exit /b
