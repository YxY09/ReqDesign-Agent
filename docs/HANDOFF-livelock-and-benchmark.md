# 交接：编排死锁 + benchmark 健壮性（给 Claude Code 联网迭代）

> 背景：本仓库是 ReqDesign-Agent（多智能体 LLM 系统：需求分析→设计→图表→测试，带评审/修复环）。
> 模型走华为云 ModelArts（`config.yaml`: provider=openai, model=DeepSeek-V3,
> base_url=https://api.modelarts-maas.com/openai/v1, key 在 `.env` 的 `OPENAI_API_KEY`）。
> 之前用 Cowork 模式做的是**离线**能做的部分（重写 benchmark 评分、数据集、单测、config）；
> 凡是要**真跑 LLM** 的验证都做不了（沙箱无外网）。所以把以下两件需要联网迭代的事交给 Claude Code。
>
> 运行方式（你的机器有网有 key）：
> ```
> npm run build
> node dist/src/main.js -i benchmark/cases -o output/benchmark --benchmark
> ```
> 单跑某个 case：把该 case 的 .md 放进一个独立目录用 `-i` 指它（gold 固定从 `benchmark/gold_contracts` 配对）。
> 全量单测：`npm test`（不需要 LLM）。

---

## 问题 1（核心 bug，优先）：编排死锁 —— 失败任务 + 仍有 worker 在跑 → 无限 `wait_for_running`

### 现象
跑 `benchmark/cases`（ecommerce + hospital）时，ecommerce 卡死，整轮 hang 住，`summary.final.json` never 写出。
日志 `output/benchmark/run_all.log` 末尾同一句决策重复 100+ 次、每 ~5 秒一轮、无完成标记：
```
decide: strategy=wait_for_running, action=inspect,
  reason=design-1 failed after regeneration budget was exhausted, but workflow work is still running
```
出现频次（grep reason）：`work is still running` ×224、上面那句 ×116。

### 复现链路（来自日志）
1. `design-1` 生成反复失败 → 重生预算耗尽（`maxRegeneratePerTask=1`）。
2. → `escalate_to_replan`，replan add=2（`design-3`、`tests-3`）。
3. `design-3` 回来**自检 24 个问题**仍被保存；`tests-3` 长时间 running。
4. 编排器进入：design-1 已终态 failed + replan 预算也耗尽（`canReplan=false`）+ `runningTasks.length>0`
   → 命中 `wait_for_running` 分支，**永不收敛**到 pause/finish。

### 根因定位
`src/orchestration/policy.ts:192-225`（DeterministicPolicy 处理 `failedTasks`）：
```
if (regenerateCount >= maxRegeneratePerTask) {
  if (canReplan) -> escalate_to_replan
  if (runningTasks.length>0 || evaluatorRunning) -> wait_for_running   // <-- 死锁点 (行 214-219)
  -> pause_for_user
}
```
`wait_for_running` 经 `strategy.ts:80` 映射成 `action=inspect`，而 `runtime.ts:548` 里 `inspect: idle`（空操作，不推进、不取消）。
于是只要还有任意 worker inflight（这里是卡住/超慢的 `tests-3`），就一直走 `wait_for_running`，
既不取消那个 worker、也不收敛——形成活锁。

理论上有两个兜底，但都救不及/可能救不了：
- `runtime.ts:339` `decisionExhausted`（`maxDecisionCount=500`）—— 但 `inspect/idle` 决策是否计入 `decisionCount` 需确认（`state.stores.execution.recordDecision`）；若计入，也要 ~500 轮才断，期间一直空转。
- `runtime.ts:311` `runtimeExhausted(startTime)` 墙钟预算 —— 实测跑了 30+ 分钟仍在转，说明该预算过大或没触发。

### 建议修法（方向，需你联网真跑验证）
当一个任务**终态失败且 replan 预算也耗尽**时，不应无限等"还在跑的 worker"。可选：
1. 进入该分支时，**主动 `cancel` 掉剩余 inflight worker**（`MultiAgentRuntime.cancel()` 已存在，`runtime.ts:221`），再走 `pause_for_user`/finish；或
2. 给"等待 running 收敛"加**有界轮次/墙钟**：等够 N 轮仍未收敛 → 强制 pause_for_user；或
3. 确保 `inspect/idle` 决策**确实计入** `decisionCount`，并把 `maxDecisionCount` 调到合理值，让活锁有硬上限。
建议优先 (1)：终态失败 + 不能 replan，继续耗 LLM 跑补救没意义，cancel + pause 最干净。
注意别误伤"正常等待短任务完成"的场景——只在"有终态失败任务 + 不能 replan"时才强制收敛。

相关单测：`tests/test_policy.test.ts`、`tests/test_remediation.test.ts`、`tests/test_orchestration.test.ts`、`tests/test_replan.test.ts`（改完先跑这些）。

### 验证（联网）
重跑 `benchmark/cases`，确认 ecommerce 不再无限 `wait_for_running`，最终要么 pause/finish、要么被记 error，且 `summary.final.json` 能写出来、hospital 也跑到。

---

## 问题 2（benchmark 健壮性，便宜且可离线测）：runner 无 per-case 超时

### 现象
`BenchmarkRunner.runCase`（`src/benchmark/runBenchmark.ts`）里直接 `await runtime.run(...)`，**没有墙钟超时**。
所以问题 1 那种卡死会让**整轮 hang 死**：ecommerce 卡住→hospital 不跑→报告不出。

### 建议修法
给 `runCase` 加 per-case 墙钟超时：`Promise.race([runtime.run(...), timeout])`；
超时则 `runtime.cancel("benchmark case timeout")` + 该 case 记 `status:"error"` + **继续下一个 case**。
`runAll` 已经是跑完所有 case 才写报告，所以只要 runCase 能返回，报告就照常出。
超时值建议做成 `config.yaml` 的 `benchmark.case_timeout_seconds`（默认给个大值如 3600，0=不限）。
为可测，把 runtime 工厂做成可注入（构造函数可选参数），单测里注入一个"永不 resolve 的假 runtime" + 小超时，断言返回 error 且 cancel 被调用。

可完全离线单测（`tests/test_benchmark.test.ts` / `test_benchmark_scorer.test.ts` 同款 mock 风格）。

---

## 问题 3（更深的质量杠杆，可选）：analyze 过度抽取

实测：ecommerce 分析抽 18 实体/34 约束，hospital 14 实体/34 约束（gold 才 5–10/6）。
后果：拖慢（每次 analyze 多次 ~60s LLM 调用，曾触发 worker 超时）、拉低一致性（类图盖不全）、催生跨产物漂移
（设计层冒出 `MessageNotification`/`Appointment` 等不在分析里的类——见 hospital `review/result.json` 的 6 条 major）。
方向：收紧 analyze 的约束/实体抽取 prompt 与上限，speed + precision 一起涨。需联网 A/B 跑 benchmark 对比。

---

## 已完成 / 现状（别重做）
- benchmark 现在是 **v2 证据式评分**：基于 `benchmark/gold_contracts/` 的义务契约，对 design/tests 做 0~3 rubric 打分，再聚合为 `gold_obligation_coverage` / `traceability_truthfulness` / `test_effectiveness` / `design_depth` / `final_score`。见 `src/benchmark/qualityJudge.ts`、`benchmark/README.md`。
- 系统终审（review gate）会单独记录；v2 质量分不直接折叠 review gate，只作为独立信号写入 `review.json`。
- 数据集：`benchmark/cases/` + `benchmark/gold_contracts/`（ecommerce、hospital 等手工整理 obligation）；旧 Phase‑1 的 `gold_labels/` 与 PROMISE 适配器已移除。
- `config.yaml`: `worker_timeout_seconds` 已 900→2400（hospital 因此能跑完）。
- 全量单测绿（`npm test`）。
- **一次成功基线**：hospital 单跑 = coverage 90.3 / syntax 100 / structure 100 / consistency 66 / overall 90.1，但被自评门记**否**（6 个未决 major）。ecommerce 尚无干净结果（就是被问题 1 卡住）。

## 环境注意
- 仓库源码基本是 **CRLF**；改文件请保持，别整体重排行尾（会产生巨大无意义 diff）。
- `tsconfig.json` 把 `tests/` 排除在 tsc 之外（测试用 vitest/esbuild 跑），`benchmark/*.mjs` 也不在 tsc 范围。
- 注意：之前在 Cowork 沙箱里为测连通性对 `node_modules` 装过 undici/rollup（`--no-save`），可能动到 esbuild 版本导致 `tsx` 抽风；若 `npx tsx`/`vitest` 报 esbuild 版本不匹配，`npm install` 一下即可恢复。用 `node dist/...`（先 `npm run build`）不受影响。
