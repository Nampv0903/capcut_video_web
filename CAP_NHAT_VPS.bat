@echo off
chcp 65001 >nul
title LMautoedit — Cap Nhat Code Moi Nhat Tu GitHub
cd /d "%~dp0"

echo ========================================================
echo    🔄 CAP NHAT CODE LMAUTOEDIT MOI NHAT TREN VPS
echo ========================================================
echo.

if exist ".git\" (
    echo [1/2] Dang keo ban cap nhat moi nhat tu GitHub (git pull)...
    git fetch origin main
    git reset --hard origin/main
) else (
    echo [1/2] Dang tai ban cap nhat moi nhat tu GitHub...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Nampv0903/capcut_video_web/main/src/capcutBrowserBot.js' -OutFile 'src\capcutBrowserBot.js' -UseBasicParsing; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Nampv0903/capcut_video_web/main/server.js' -OutFile 'server.js' -UseBasicParsing; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Nampv0903/capcut_video_web/main/public/app.js' -OutFile 'public\app.js' -UseBasicParsing"
)

echo [2/2] Dang khoi dong lai Server de ap dung code moi...
taskkill /F /IM node.exe >nul 2>&1
echo.
echo ✅ Da cap nhat xong! Neu cua so CHAY_SERVER.bat dang mo, Server se tu khoi dong lai sau 3 giay.
pause
