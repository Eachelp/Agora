@echo off
chcp 949 >nul
cd /d "%~dp0"
title Agora 설치
setlocal

echo ============================================
echo                Agora Setup
echo ============================================
echo.
echo 실행 환경을 확인합니다...
echo.

set NEED_NODE=0
set HAS_GIT=1
set HAS_WINGET=1
set HAS_CODEX=1
set HAS_CLAUDE=1
set HAS_AGY=1

where winget >nul 2>nul
if errorlevel 1 set HAS_WINGET=0

where git >nul 2>nul
if errorlevel 1 goto :git_missing
for /f "delims=" %%v in ('git --version') do echo [OK] %%v
goto :check_node
:git_missing
set HAS_GIT=0
echo [미설치] Git - Agora-업데이트 기능에 필요합니다

:check_node
where node >nul 2>nul
if errorlevel 1 goto :node_missing
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
for /f "delims=" %%v in ('call npm -v') do echo [OK] npm %%v
goto :check_codex
:node_missing
set NEED_NODE=1
echo [미설치] Node.js - Agora 실행에 반드시 필요합니다

:check_codex
where codex >nul 2>nul
if errorlevel 1 goto :codex_missing
echo [OK] Codex CLI
goto :check_claude
:codex_missing
set HAS_CODEX=0
echo [미설치] Codex CLI

:check_claude
where claude >nul 2>nul
if errorlevel 1 goto :claude_missing
echo [OK] Claude Code
goto :check_agy
:claude_missing
set HAS_CLAUDE=0
echo [미설치] Claude Code

:check_agy
where agy >nul 2>nul
if errorlevel 1 goto :agy_missing
echo [OK] Antigravity CLI
goto :env_done
:agy_missing
set HAS_AGY=0
echo [미설치] Antigravity CLI

:env_done
echo.

rem ---- Node.js가 없으면 여기서 설치를 안내하고 종료합니다 ----
if "%NEED_NODE%"=="0" goto :node_ready
echo Node.js가 없으면 Agora를 실행할 수 없습니다.
if "%HAS_WINGET%"=="0" goto :node_manual
choice /c YN /m "winget으로 Node.js LTS를 지금 설치할까요"
if errorlevel 2 goto :node_manual
echo.
echo Node.js LTS를 설치합니다. 승인 창이 뜨면 허용해 주세요...
winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo Node.js 설치가 끝났습니다. 새 설치를 인식시키기 위해
echo 이 창을 닫고 Agora-설치하기.bat 을 다시 더블클릭해 주세요.
pause
exit /b
:node_manual
echo.
echo Node.js 다운로드 페이지를 엽니다. LTS 버전을 설치한 뒤
echo Agora-설치하기.bat 을 다시 더블클릭해 주세요.
start "" https://nodejs.org/ko
pause
exit /b
:node_ready

rem ---- Git은 없어도 설치는 진행되지만, 업데이트를 위해 설치를 권합니다 ----
if "%HAS_GIT%"=="1" goto :git_ready
echo Git이 없으면 Agora-업데이트를 사용할 수 없습니다.
if "%HAS_WINGET%"=="0" goto :git_manual
choice /c YN /m "winget으로 Git을 지금 설치할까요"
if errorlevel 2 goto :git_manual
winget install --id Git.Git --accept-source-agreements --accept-package-agreements
echo Git 설치가 끝났습니다. 새 창부터 사용할 수 있습니다.
echo.
goto :git_ready
:git_manual
echo 나중에 https://git-scm.com 에서 설치할 수 있습니다.
echo.
:git_ready

rem ---- AI CLI는 선택 설치입니다. 없어도 Agora는 실행됩니다 ----
if "%HAS_CODEX%"=="1" goto :codex_ready
choice /c YN /m "Codex CLI를 지금 설치할까요"
if errorlevel 2 goto :codex_ready
call npm install -g @openai/codex
if errorlevel 1 echo [경고] Codex CLI 설치에 실패했습니다. 나중에 다시 시도할 수 있습니다.
echo.
:codex_ready

if "%HAS_CLAUDE%"=="1" goto :claude_ready
choice /c YN /m "Claude Code를 지금 설치할까요"
if errorlevel 2 goto :claude_ready
call npm install -g @anthropic-ai/claude-code
if errorlevel 1 echo [경고] Claude Code 설치에 실패했습니다. 나중에 다시 시도할 수 있습니다.
echo.
:claude_ready

if "%HAS_AGY%"=="1" goto :agy_ready
echo [안내] Antigravity CLI는 자동 설치를 지원하지 않습니다.
echo Antigravity 앱을 설치한 뒤 안내에 따라 agy CLI를 활성화해 주세요.
echo.
:agy_ready

rem ---- Agora 의존성 설치 ----
echo Agora 구성요소를 설치합니다. 처음 한 번은 몇 분 걸릴 수 있습니다...
call npm install
if errorlevel 1 goto :installfail
echo [OK] 구성요소 설치 완료
echo.

rem ---- 바탕화면 바로가기 ----
echo 바탕화면에 Agora 바로가기를 만드는 중...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $sh=New-Object -ComObject WScript.Shell; $lnk=$sh.CreateShortcut((Join-Path $d 'Agora.lnk')); $lnk.TargetPath='%~dp0launch-agora.vbs'; $lnk.WorkingDirectory='%~dp0'; $lnk.IconLocation='%~dp0build\icon.ico'; $lnk.Description='Agora'; $lnk.Save()"
if errorlevel 1 goto :shortcutfail
echo [OK] 바로가기 생성 완료
echo.

echo ============================================
echo   Agora 설치가 완료되었습니다.
echo   바탕화면에 Agora 바로가기를 만들었습니다.
echo ============================================
echo.
echo 아무 키나 누르면 Agora를 실행합니다.
pause >nul
start "" "%~dp0launch-agora.vbs"
exit /b

:installfail
echo.
echo [오류] 설치 중 문제가 발생했습니다.
echo 인터넷 연결을 확인한 뒤 Agora-설치하기.bat 을 다시 실행해 주세요.
pause
exit /b

:shortcutfail
echo.
echo [오류] 바로가기 생성에 실패했습니다.
echo 바로가기 없이도 run-agora.bat 으로 실행할 수 있습니다.
pause
exit /b
