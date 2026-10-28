@echo off
chcp 65001 >nul
title LMautoedit — Server 24/7
cd /d "%~dp0"

echo ========================================================
echo    🚀 KHOI DONG HE THONG LMAUTOEDIT TREN VPS (24/7)
echo ========================================================
echo.

:: 1. Kiem tra va cai dat thu vien neu chua co node_modules
if not exist "node_modules\" (
    echo [1/3] Dang cai dat thu vien Node.js lan dau...
    call npm install
)

:: 2. Mo cong Firewall 3000 & 80 tren Windows VPS (neu chay quyen Admin)
netsh advfirewall firewall show rule name="LMautoedit_Port_3000" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="LMautoedit_Port_3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
    netsh advfirewall firewall add rule name="LMautoedit_Port_80" dir=in action=allow protocol=TCP localport=80 >nul 2>&1
)

:loop
echo [%date% %time%] Dang chay LMautoedit Server tai http://localhost:3000 ...
node server.js
echo.
echo [!] Server vua dung, tu dong khoi dong lai sau 3 giay...
timeout /t 3 >nul
goto loop
