@echo off
chcp 949 >nul
cd /d "%~dp0"
title Agora 업데이트
setlocal

echo ============================================
echo              Agora 업데이트
echo ============================================
echo.

rem ---- 사전 점검: git, 저장소, 브랜치 ----
where git >nul 2>nul
if errorlevel 1 goto :nogit

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :notrepo

set BRANCH=
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
if /i not "%BRANCH%"=="main" goto :notmain

set OLDVER=
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set OLDVER=%%v
if "%OLDVER%"=="" set OLDVER=알 수 없음

rem ---- 로컬 변경이 있으면 덮어쓰지 않고 멈춥니다 ----
set DIRTY=0
for /f "delims=" %%s in ('git status --porcelain') do set DIRTY=1
if "%DIRTY%"=="1" goto :dirty

echo 현재 버전: Agora %OLDVER%
echo.
echo [1/3] 최신 버전 확인 중...
git fetch origin main
if errorlevel 1 goto :fetchfail

set BEHIND=0
for /f "delims=" %%n in ('git rev-list --count HEAD..origin/main') do set BEHIND=%%n
if "%BEHIND%"=="0" goto :uptodate

set OLDLOCK=
for /f "delims=" %%h in ('git hash-object package-lock.json') do set OLDLOCK=%%h

echo [2/3] 프로그램 업데이트 중...
git pull --ff-only origin main
if errorlevel 1 goto :pullfail

set NEWVER=
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set NEWVER=%%v
if "%NEWVER%"=="" set NEWVER=알 수 없음

set NEWLOCK=
for /f "delims=" %%h in ('git hash-object package-lock.json') do set NEWLOCK=%%h
if "%OLDLOCK%"=="%NEWLOCK%" goto :skipnpm

echo [3/3] 패키지 업데이트 중...
call npm install
if errorlevel 1 goto :installfail
goto :done

:skipnpm
echo [3/3] 패키지 변경 없음 - 건너뜁니다
goto :done

:done
echo.
echo ============================================
echo   Agora %OLDVER% 에서 %NEWVER% 로 업데이트 완료
echo ============================================
echo [OK] 프로그램 업데이트
echo [OK] 패키지 반영
echo [OK] 설정 보존 - 대화와 설정은 사용자 폴더의 .agora 에 있어 영향이 없습니다
echo.
echo 바탕화면 Agora 아이콘으로 그대로 실행하시면 됩니다.
pause
exit /b

:uptodate
echo.
echo 이미 최신 버전입니다. Agora %OLDVER%
pause
exit /b

:nogit
echo [안내] git 이 설치되어 있지 않습니다.
echo Agora-설치하기.bat 을 실행하면 설치를 도와드립니다.
echo 또는 https://git-scm.com 에서 직접 설치할 수 있습니다.
pause
exit /b

:notrepo
echo [안내] 이 폴더는 ZIP으로 내려받은 폴더라 자동 업데이트를 할 수 없습니다.
echo GitHub에서 새 ZIP을 내려받아 폴더를 교체하거나,
echo git clone 으로 다시 받으면 다음부터 자동 업데이트가 가능합니다.
pause
exit /b

:notmain
echo [안내] 현재 %BRANCH% 브랜치에서 작업 중이라 자동 업데이트를 건너뜁니다.
echo 개발용 체크아웃을 보호하기 위한 안전장치입니다.
pause
exit /b

:dirty
echo [안내] 이 폴더에 직접 수정된 파일이 있어 안전을 위해 업데이트를 중단합니다.
echo.
git status --short
echo.
echo 위 변경이 본인 작업이 아니라면 폴더를 새로 받는 것이 가장 안전합니다.
echo 본인 작업이라면 변경을 정리한 뒤 다시 실행해 주세요.
pause
exit /b

:fetchfail
echo.
echo [오류] 최신 버전 확인에 실패했습니다. 인터넷 연결을 확인해 주세요.
pause
exit /b

:pullfail
echo.
echo [오류] 업데이트를 적용하지 못했습니다.
echo 이 폴더의 기록이 원격과 달라졌을 수 있습니다. 폴더를 새로 받는 것이 가장 안전합니다.
pause
exit /b

:installfail
echo.
echo [오류] 패키지 반영 중 문제가 발생했습니다.
echo 인터넷 연결을 확인한 뒤 Agora-업데이트.bat 을 다시 실행해 주세요.
pause
exit /b
