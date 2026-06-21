# ReqDesign-Agent Benchmark v2

本目录是 **Benchmark v2** 的数据集与辅助文件。v2 采用“证据式”评测：
先过 Layer‑0 sanity gate，再用基于 gold contract 的 LLM judge 对产出的
`design/system_design.md` + `tests/test_cases.json` + traceability 证据逐条打分。

旧的 Phase‑1 混合打分（`src/benchmark/scorer.ts`、`gold_labels/`）已移除。

## 目录结构

```
benchmark/
  cases/<id>.md                  # 需求文档（评测输入）
  gold_contracts/<id>.json       # Phase‑2 gold contract（与 case 同名配对）
  mutants/M1~M5/                 # 用于验证 judge 判别力的变体集
  pure_raw/                      # PURE 数据集原始 SRS 文本
  results/                       # 评测运行输出（gitignored）
  README.md
```

只有同时存在 `cases/<id>.md` 与 `gold_contracts/<id>.json` 的 case 才会被 v2 runner 评测；
缺少 gold contract 的 case 会被跳过。

## Gold Contract 格式

`gold_contracts/<id>.json` 是手工整理的义务（obligation）列表：

```json
{
  "case_id": "<id>",
  "source_language": "zh|en",
  "canonical_language": "en",
  "obligations": [
    {
      "id": "C-001",
      "type": "constraint",
      "severity": "major",
      "source_span": "需求原文摘录",
      "expected_design_evidence": ["设计必须体现的具体规则/触发条件/处理行为"],
      "expected_test_evidence": ["测试必须断言的可检查行为"],
      "anti_patterns": ["看起来像覆盖但不得分的写法"]
    }
  ]
}
```

ID 约定：
- `C-NNN`：业务约束
- `F-NNN`：功能需求
- `X-NNN`：异常/失败流程

Judge 按 `source_span` 和证据文本做语义匹配，而不是按生成的 trace ID 匹配。

## 评分维度

`src/benchmark/resultStore.ts` 定义了四个质量维度：

| 维度 | 含义 |
|------|------|
| `gold_obligation_coverage` | 对 gold contract 义务的覆盖程度 |
| `traceability_truthfulness` | 追溯链（义务→设计→测试）是否语义真实 |
| `test_effectiveness` | 测试有效性（结合 `benchmark/mutants/` 变体验证） |
| `design_depth` | 设计深度（Rubric 0~3 分聚合） |
| `final_score` | 上述维度的综合分 |

系统的 `review_gate`（终审 major issue）会单独记录，但不混入质量分。

## 当前数据集

### 原生中文 case（来自 `examples/`）

| case | 来源 | 域 |
|------|------|----|
| `ecommerce_order_system` | `examples/ecommerce_order_system.md` | B2C 电商订单 |
| `hospital_mgmt` | `examples/hospital_mgmt.md` | 三甲医院门诊 |
| `smart_campus` | `examples/smart_campus.md` | 智慧校园 |
| `mid_complex_system` | `examples/mid_complex_system.md` | 在线图书管理 |

`benchmark/cases/` 下的这些文件与 `examples/` 逐字一致。

### PURE 公开数据集

- 原始文件：`benchmark/pure_raw/*.txt`
- 已转换 case：`pure_keepass`、`pure_qheadache`
- 来源：PURE Plain Dataset (Ferrari et al., IEEE RE 2017), CC‑BY 4.0

### PROMISE NFR

PROMISE NFR 数据集的简单 F/NFR 覆盖探针（旧 `gold_labels` 格式）已随 Phase‑1 一起移除。
如需重新接入，需要把每条需求改写成 v2 的 gold contract。

## Mutants

`benchmark/mutants/` 包含 5 个变体，每个都是基于 hospital case 的产物做手脚：

| 变体 | 破坏点 |
|------|--------|
| `M1_shallow_coverage` | 只保留 ID/关键词，剥离具体数值规则与边界测试 |
| `M2_fake_traceability` | 追溯矩阵声称覆盖，但引用的测试断言 unrelated |
| `M3_missing_exception` | 删除异常路径与异常测试 |
| `M4_hallucinated_test` | 测试 target 写过敏拦截，断言却是审计日志/库存 |
| `M5_wrong_design_decision` | 设计与 gold 相反（如抗生素跳过主任审核） |

每个变体都有 `expected_scores.json`，说明该变体应在哪些 obligation 上被判低分。

## 运行

```bash
npm run build
node dist/src/main.js --benchmark -i benchmark/cases -o benchmark/results
```

常用选项：
- `--mode eval --n 3`：eval 模式，每个 case 跑 3 次
- `--case <id>`：只跑一个 case
- `--resume --benchmark-id <id>`：续跑
- `--gold-dir <path>`：自定义 gold contract 目录（默认 `benchmark/gold_contracts`）

报告位置：`benchmark/results/<benchmark_id>/summary.final.json`。

## 相关代码

| 文件 | 作用 |
|------|------|
| `src/benchmark/benchmarkRunner.ts` | v2 runner |
| `src/benchmark/compareRunner.ts` | baseline vs Agent 对比 |
| `src/benchmark/goldObligation.ts` | Gold contract 类型与校验 |
| `src/benchmark/qualityJudge.ts` | 证据式 judge |
| `src/benchmark/sanityGate.ts` | Layer‑0 sanity gate |
| `src/benchmark/resultStore.ts` | 结果存储与质量分定义 |
| `src/benchmark/judgeClient.ts` | judge 所需的最小 LLM 接口 |

## 引用

- A. Ferrari, G. O. Spagnolo, S. Gnesi. *PURE: A Dataset of Public Requirements Documents.* IEEE RE 2017.
- J. Cleland-Huang et al. *The Detection and Classification of Non-Functional Requirements...* 2007（PROMISE NFR）。
- M. Lima et al. *Software requirements classification (PROMISE_exp).* 2019。
