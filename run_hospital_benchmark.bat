@echo off
cd /d "C:\Learn\Day-Learn\ReqDesign-Agent"
if not exist output\benchmark mkdir output\benchmark
set LOG=output\benchmark\run_hospital.log
echo ___BENCHMARK_START___ %DATE% %TIME%> %LOG%
echo [build] tsc compiling...>> %LOG%
call npm run build>> %LOG% 2>&1
echo [run] hospital case (this calls the LLM, ~10-25 min)...>> %LOG%
call node dist\src\main.js -i benchmark/cases_hospital -o output/benchmark --benchmark>> %LOG% 2>&1
echo [exit] code %ERRORLEVEL% at %TIME%>> %LOG%
echo ___BENCHMARK_DONE___>> %LOG%
