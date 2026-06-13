# ReqDesign-Agent 基准评测数据集

衡量整条多智能体流水线（需求分析 → 设计 → 图表）输出质量的基准集。
评分逻辑已在 `src/benchmark/scorer.ts`，运行器在 `src/benchmark/runBenchmark.ts`，
CLI 入口在 `src/main.ts` 的 `--benchmark`。本目录补齐它缺的那一半——**数据集**。

## 目录结构

```
benchmark/
  cases/<name>.md            # 需求文档（评测输入）
  gold_labels/<name>.json    # 金标准标注（与同名 case 配对；路径被 CLI 硬编码）
  adapters/promise_to_cases.mjs   # 外部公开数据集 PROMISE 的接入脚本
  README.md
```

`runBenchmark.ts` 会读取 `cases/` 下每个 `<name>.md`，在 `gold_labels/` 找同名
`<name>.json`，跑完整流水线后用混合方式打分（覆盖度走 LLM，图语法/图结构/一致性走确定性）。

## 金标准（gold）字段

每个 `gold_labels/<name>.json` 为下列字符串数组（缺省视为 0 个，不计入该项总分）：

| 字段 | 含义 | 喂给的评分项 |
|------|------|--------------|
| `expected_actors` | 期望识别的角色 | coverage (LLM) |
| `expected_functions` | 期望覆盖的功能 | coverage (LLM) |
| `expected_entities` | 期望识别的实体 | coverage (LLM) + 一致性(确定性) |
| `expected_constraints` | 期望覆盖的业务约束 | coverage (LLM) |
| `expected_exceptions` | 期望覆盖的异常 | coverage (LLM) |
| `expected_processes` | 期望体现的业务流程 | coverage (LLM) |

评分采用**混合**设计（见 `src/benchmark/scorer.ts`）：

- **覆盖度 coverage（LLM-judge，权重 0.5）**：把 gold 期望项与系统输出交给 LLM 逐项判定是否被语义覆盖（释义/同义/翻译都算），语言无关、对措辞鲁棒。
- **图语法 diagram_syntax（确定性，0.2）**：Mermaid 校验通过比例。
- **图结构 diagram_structure（确定性，0.15）**：活动图有起止/分支/流转、状态图有初态/迁移/状态数。
- **一致性 consistency（确定性，0.15）**：分析出的实体是否出现在类图/行为图中（归一化匹配，语言无关）。

综合分 = 加权和，≥ 80 记为通过。**只有 coverage 走 LLM，其余三项纯离线确定性。**

## 数据来源

### 1) 原生中文参考集（开箱即用）

| case | 来源 | 域 |
|------|------|----|
| `ecommerce_order_system` | `examples/ecommerce_order_system.md` | B2C 电商订单 |
| `hospital_mgmt` | `examples/hospital_mgmt.md` | 三甲医院门诊 |

这两个用例**手工标注**，覆盖全部 6 个 gold 字段，是当前**最完整的测量基准**。
可按同样格式继续补 `examples/` 里的其余文档。

### 2) 外部公开数据集 —— PROMISE NFR

- **数据集**：PROMISE NFR（Cleland-Huang et al. 2007；Lima et al. 2019 扩展）。
  625 条带标签的需求句（255 功能 / 370 非功能，11 个 NFR 子类）。
- **获取**：通过 Hugging Face datasets-server 取 JSON（无需 git/二进制下载）：
  `https://datasets-server.huggingface.co/rows?dataset=MariaIsabel/PROMISE_NFR_translated&config=default&split=train&offset=0&length=100`
  （该镜像为西班牙语，CC-BY-4.0；英文原版在 PROMISE/tera-PROMISE 仓库）。
- **接入**：存成 CSV 后运行
  `node benchmark/adapters/promise_to_cases.mjs <promise.csv>`，
  按项目（PROJECT 1–15）拆成 `cases/promise_p<NN>.md` + `gold_labels/promise_p<NN>.json`。

**重要限制**：PROMISE 只有“需求句 + F/NFR 标签”，没有角色/实体/异常/流程，
因此派生 gold 只能填 `expected_functions`（F 行）和 `expected_constraints`（NFR 行），
其余 4 项为空、不计入覆盖度。（语言不再是问题——coverage 由 LLM 评判，语言无关。）
**PROMISE 适合作为“功能/NFR 覆盖”的探针；要全维度评测请用原生参考集或自建 gold。**

## 运行

> 前提：`config.yaml` 配好可用的 LLM provider + API key。基准会真实调用 LLM **两处**：
> 跑流水线生成产物，以及给 coverage 维度打分（judge 复用同一个 `LLMClient`）。

```bash
npm run build
node dist/src/main.js -i benchmark/cases -o output/benchmark --benchmark
# 或开发态：
npx tsx src/main.ts -i benchmark/cases -o output/benchmark --benchmark
```

报告写到 `output/benchmark/benchmark_report.{json,md}`，并打印通过数与平均综合分。
gold 目录路径在 CLI 中硬编码为 `benchmark/gold_labels`。

不依赖 LLM 的数据集自检（gold 结构 + 评分接线 + PROMISE 适配器）见
`tests/test_benchmark_dataset.test.ts`，`npm test` 即可跑。

## 引用

- A. Ferrari, G. O. Spagnolo, S. Gnesi. *PURE: A Dataset of Public Requirements Documents.* IEEE RE 2017.
- J. Cleland-Huang et al. *The Detection and Classification of Non-Functional Requirements...* 2007（PROMISE NFR）。
- M. Lima et al. *Software requirements classification (PROMISE_exp).* 2019。
