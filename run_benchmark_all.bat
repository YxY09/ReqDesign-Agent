@echo off
cd /d "C:\Learn\Day-Learn\ReqDesign-Agent"
if not exist output\benchmark mkdir output\benchmark
set LOG=output\benchmark\run_all.log
echo ___BENCHMARK_START___ %DATE% %TIME%> %LOG%
echo [build] tsc compiling...>> %LOG%
call npm run build>> %LOG% 2>&1
echo [run] all cases (ecommerce + hospital, calls LLM, ~30-50 min)...>> %LOG%
call node dist\src\main.js -i benchmark/cases -o output/benchmark --benchmark>> %LOG% 2>&1
echo [exit] code %ERRORLEVEL% at %TIME%>> %LOG%
echo ___BENCHMARK_DONE___>> %LOG%
