@echo off
node --experimental-strip-types --no-warnings "%~dp0src\cli\main.ts" %*
