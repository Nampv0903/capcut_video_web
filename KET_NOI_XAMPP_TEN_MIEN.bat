@echo off
chcp 65001 >nul
title Cau Hinh XAMPP Noi Ten Mien vao LMautoedit
cd /d "%~dp0"

echo ====================================================================
echo    🌐 TU DONG CAU HINH XAMPP APACHE NOI TEN MIEN VAO LMAUTOEDIT
echo ====================================================================
echo.

set "XAMPP_DIR=C:\xampp"
if not exist "%XAMPP_DIR%\apache\conf\httpd.conf" (
    set /p XAMPP_DIR="Nhap thu muc cai XAMPP (mac dinh C:\xampp): "
)

if not exist "%XAMPP_DIR%\apache\conf\httpd.conf" (
    echo [LOI] Khong tim thay XAMPP tai %XAMPP_DIR%!
    pause
    exit /b 1
)

set /p DOMAIN_NAME="Nhap ten mien cua dai ca (vi du: lmautoedit.com): "
if "%DOMAIN_NAME%"=="" (
    echo [LOI] Dai ca chua nhap ten mien!
    pause
    exit /b 1
)

echo.
echo [1/2] Dang bat mod_proxy, mod_proxy_http va mod_proxy_wstunnel trong httpd.conf...
powershell -NoProfile -Command ^
  "$conf = '%XAMPP_DIR%\apache\conf\httpd.conf'; " ^
  "$txt = Get-Content $conf -Raw; " ^
  "$txt = $txt -replace '#LoadModule proxy_module modules/mod_proxy.so', 'LoadModule proxy_module modules/mod_proxy.so'; " ^
  "$txt = $txt -replace '#LoadModule proxy_http_module modules/mod_proxy_http.so', 'LoadModule proxy_http_module modules/mod_proxy_http.so'; " ^
  "$txt = $txt -replace '#LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so', 'LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so'; " ^
  "$txt = $txt -replace '#LoadModule rewrite_module modules/mod_rewrite.so', 'LoadModule rewrite_module modules/mod_rewrite.so'; " ^
  "Set-Content -Path $conf -Value $txt -Encoding UTF8"

echo [2/2] Dang them cau hinh VirtualHost cho ten mien %DOMAIN_NAME%...
set "VHOST_FILE=%XAMPP_DIR%\apache\conf\extra\httpd-vhosts.conf"

(
echo.
echo # === LMautoedit Reverse Proxy cho %DOMAIN_NAME% ===
echo ^<VirtualHost *:80^>
echo     ServerName %DOMAIN_NAME%
echo     ServerAlias www.%DOMAIN_NAME%
echo     ProxyPreserveHost On
echo     ProxyRequests Off
echo.
echo     RewriteEngine On
echo     RewriteCond %%{HTTP:Upgrade} =websocket [NC]
echo     RewriteRule /(.*) ws://127.0.0.1:3000/$1 [P,L]
echo.
echo     ProxyPass / http://127.0.0.1:3000/
echo     ProxyPassReverse / http://127.0.0.1:3000/
echo ^</VirtualHost^>
) >> "%VHOST_FILE%"

echo.
echo ====================================================================
echo ✅ HOAN TAT! Dai ca chi can:
echo    1. Tro DNS ten mien %DOMAIN_NAME% (A Record) ve IP cua VPS.
echo    2. Mo XAMPP Control Panel -> Bam Stop roi Start lai Apache.
echo    3. Bam chay file CHAY_SERVER.bat.
echo ====================================================================
pause
