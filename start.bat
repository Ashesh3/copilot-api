@echo off
echo ================================================
echo GitHub Copilot API Server with Operator Dashboard
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

if not defined COPILOT_API_KEY_AUTH (
    echo COPILOT_API_KEY_AUTH is required for dashboard setup.
    echo Set it to a long random value in this terminal, then run start.bat again.
    exit /b 1
)

echo Starting server...
echo The operator dashboard will open automatically after the server starts
echo.

start "" "http://127.0.0.1:4141/dashboard"
bun run dev start --host 127.0.0.1 --api-key-auth

pause
