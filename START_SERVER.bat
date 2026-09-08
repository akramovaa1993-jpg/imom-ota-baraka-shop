@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   IMOM OTA BARAKA - Telegram server
echo ==========================================
if not exist node_modules (
  echo Kerakli paketlar o'rnatilmoqda...
  call npm install
  if errorlevel 1 goto :error
)
echo.
echo Server ishga tushmoqda: http://localhost:3000
echo To'xtatish uchun CTRL+C bosing.
echo.
call npm start
exit /b
:error
echo.
echo Xatolik: Node.js/npm o'rnatilganini tekshiring.
pause
