@echo off
chcp 65001 >nul
title Cai Dat Tu Dong Moi Truong VPS cho LMautoedit
cd /d "%~dp0"

echo ====================================================================
echo    🛠️ TU DONG CAI DAT MOI TRUONG VPS CHO LMAUTOEDIT (1-CLICK)
echo ====================================================================
echo.

:: 1. Kiem tra va cai dat Node.js LTS
where node >nul 2>&1
if errorlevel 1 (
    echo [1/4] Chua co Node.js -> Dang tai va cai dat Node.js LTS tu dong...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$url = 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'; " ^
      "$out = Join-Path $env:TEMP 'node_installer.msi'; " ^
      "Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; " ^
      "Start-Process msiexec.exe -ArgumentList '/i', $out, '/qn', '/norestart' -Wait"
    set "PATH=%PATH%;C:\Program Files\nodejs"
    echo    ✅ Da cai xong Node.js!
) else (
    echo [1/4] ✅ Da co san Node.js.
)

:: 2. Kiem tra va cai dat Google Chrome
if not exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    if not exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
        echo [2/4] Chua co Google Chrome -> Dang tai va cai dat Chrome tu dong...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
          "$url = 'https://dl.google.com/chrome/install/latest/chrome_installer.exe'; " ^
          "$out = Join-Path $env:TEMP 'chrome_installer.exe'; " ^
          "Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; " ^
          "Start-Process -FilePath $out -ArgumentList '/silent', '/install' -Wait"
        echo    ✅ Da cai xong Google Chrome!
    ) else (
        echo [2/4] ✅ Da co san Google Chrome.
    )
) else (
    echo [2/4] ✅ Da co san Google Chrome.
)

:: 3. Kiem tra va cai dat FFmpeg + FFprobe
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo [3/4] Chua co FFmpeg -> Dang tai FFmpeg + FFprobe tu dong...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'; " ^
      "$zipPath = Join-Path $env:TEMP 'ffmpeg.zip'; " ^
      "$extractDir = 'C:\ffmpeg'; " ^
      "Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing; " ^
      "Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force; " ^
      "$binDir = (Get-ChildItem -Path $extractDir -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1).DirectoryName; " ^
      "if ($binDir) { " ^
      "  Copy-Item (Join-Path $binDir 'ffmpeg.exe') -Destination 'C:\Windows\System32\ffmpeg.exe' -Force; " ^
      "  Copy-Item (Join-Path $binDir 'ffprobe.exe') -Destination 'C:\Windows\System32\ffprobe.exe' -Force; " ^
      "}"
    echo    ✅ Da cai xong FFmpeg va FFprobe!
) else (
    echo [3/4] ✅ Da co san FFmpeg va FFprobe.
)

:: 4. Cai thu vien npm va mo cong Firewall 80 & 3000
echo [4/4] Dang cai dat thu vien Node.js (npm install) va mo cong Firewall (80, 3000)...
call "C:\Program Files\nodejs\npm.cmd" install 2>nul || call npm install

netsh advfirewall firewall delete rule name="LMautoedit_Port_3000" >nul 2>&1
netsh advfirewall firewall delete rule name="LMautoedit_Port_80" >nul 2>&1
netsh advfirewall firewall add rule name="LMautoedit_Port_3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
netsh advfirewall firewall add rule name="LMautoedit_Port_80" dir=in action=allow protocol=TCP localport=80 >nul 2>&1

echo.
echo ====================================================================
echo 🎉 HOAN TAT CAI DAT VPS!
echo 👉 Buoc tiep theo:
echo    1. Chay file CHAY_SERVER.bat de khoi dong web 24/7.
echo    2. Mo web http://localhost:3000 tren VPS, bam nut "Tai khoan CapCut"
echo       tren goc phai de dang nhap tai khoan CapCut 1 lan duy nhat.
echo ====================================================================
pause
