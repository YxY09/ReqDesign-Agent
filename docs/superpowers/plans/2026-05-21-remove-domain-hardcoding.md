# 硬编码域逻辑清理计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除所有硬编码的特定行业规则，让系统回到通用状态。涉及 generation.ts、evaluation.ts、requirementChecks.ts、scorer.ts、prompts/*.md。

**Architecture:** 清理分两个独立方向并行推进——产线逻辑（generation/evaluation/requirementChecks）和评分逻辑（scorer.ts + config.yaml）。

**Tech Stack:** TypeScript, Vitest

---

## Phase A: 清理产线中的硬编码域规则

### Task A-1: 删除 requirementChecks.ts 中的退款流程

**Files:**
- Delete: `src/shared/requirementChecks.ts`

`requirementChecks.ts` 导出了 `REFUND_FLOW_CONCEPTS`、`REFUND_TEST_CONCEPTS`、`hasConstraint`、`missingConcepts`，全部是电商/退款领域硬编码。没有任何通用价值。

- [ ] **Step 1: 确认所有引用点**

```bash
grep -rn "requirementChecks" src/
```

预期命中：`generation.ts`、`evaluation.ts`。记录具体 import 语句和调用位置。

- [ ] **Step 2: 从 generation.ts 移除所有 requirementChecks 引用**

删除 import，删除 `_checkActivityCoverage()` 中关于 `REFUND_FLOW_CONCEPTS`、`C001` 的检查代码块，删除 `_checkRefundTestCoverage()` 整个方法。

- [ ] **Step 3: 从 evaluation.ts 移除所有 requirementChecks 引用**

删除 import，删除 `_checkActivityDiagramCoverage()` 中关于 `REFUND_FLOW_CONCEPTS`、`C001` 的检查代码块，删除 `_checkTestFlowCoverage()` 整个方法。

- [ ] **Step 4: 删除文件**

```bash
rm src/shared/requirementChecks.ts
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run`
Expected: 测试通过。如果有测试依赖这些检查的存在（断言"必须检测到 C001"），需要一起删除。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove hardcoded domain-specific refund/C001 checks from pipeline"
```

### Task A-2: 删除 generation.ts 和 evaluation.ts 中的 Coupon/C002 检查

**Files:**
- Modify: `src/tools/generation.ts`
- Modify: `src/tools/evaluation.ts`

这两处完全相同的代码（generation.ts:253-254，evaluation.ts:362-369），检查 `Coupon|优惠券` + `C002|支付超时` 组合。

- [ ] **Step 1: 删除 generation.ts 中的 Coupon/C002 检查**

找到 `if (key === "state_diagram" && /Coupon|优惠券/.test(text) && /C002|支付超时/.test(text))` 所在的代码块，整个删除。

- [ ] **Step 2: 删除 evaluation.ts 中的 Coupon/C002 检查**

同上，找到完全相同的代码块，整个删除。

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: 无新增失败。

- [ ] **Step 4: Commit**

```bash
git add src/tools/generation.ts src/tools/evaluation.ts
git commit -m "refactor: remove hardcoded Coupon/C002 domain check from generation and evaluation"
```

---

## Phase B: 配置化 scorer 的领域映射

### Task B-1: 从 scorer.ts 提取硬编码映射到 config.yaml

**Files:**
- Read: `src/benchmark/scorer.ts` (ENTITY_NAME_MAP, FUNCTION_SYNONYMS)
- Modify: `config.yaml` (新增 benchmark 段)
- Modify: `src/benchmark/scorer.ts` (从 config 读取)

- [ ] **Step 1: 在 config.yaml 中新增 benchmark 配置段**

```yaml
benchmark:
  entity_name_map:
    订单: ["Order"]
    商品: ["Product", "Goods", "Item"]
    学生: ["Student"]
    # ... 其余 22 个
  function_synonyms:
    选课: ["课程选择", "选择课程"]
    # ... 其余 30 个
```

- [ ] **Step 2: 修改 scorer.ts 从 config 读取映射**

`ENTITY_NAME_MAP` 和 `FUNCTION_SYNONYMS` 改为函数，接收 config 参数，config 缺失时使用空默认值（不再有硬编码 fallback）。

```typescript
export function getEntityNameMap(config?: BenchmarkConfig): Record<string, string[]> {
  return config?.entityNameMap ?? {};
}
```

- [ ] **Step 3: 更新 BenchmarkRunner 传递 config**

`BenchmarkRunner` 构造时接收 `BenchmarkConfig`，传递给 scorer 的评分函数。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/test_benchmark.test.ts`
Expected: 测试可能需要更新（之前依赖硬编码映射）

- [ ] **Step 5: Commit**

```bash
git add config.yaml src/benchmark/scorer.ts src/benchmark/runBenchmark.ts
git commit -m "refactor: move entity/function maps from scorer.ts to config.yaml"
```

---

## Phase C: 清理 prompt 模板中的领域示例

### Task C-1: 清洗 prompts/state_diagram.md

**Files:**
- Modify: `prompts/state_diagram.md`

删除硬编码的"订单/库存"状态图示例，替换为抽象的流程描述。

- [ ] **Step 1: 替换领域示例**

```markdown
# 旧：
state "订单" as Order {
    [*] --> 待支付
    待支付 --> 已支付 : 支付成功
}

# 新（通用描述）：
使用清晰的中文状态名表示实体在不同阶段的状态转换。
每个状态转换必须有触发条件说明。
避免将不同实体的状态混在一个图中。
```

- [ ] **Step 2: Commit**

```bash
git add prompts/state_diagram.md
git commit -m "docs: replace domain-specific examples in state_diagram prompt with generic guidance"
```

### Task C-2: 清洗 prompts/requirement_analysis.md

**Files:**
- Modify: `prompts/requirement_analysis.md`

删除 "交易与凭证类：支付记录、退款记录、发票、物流单" 等电商导向描述，替换为通用业务对象分类指引。

- [ ] **Step 1: 替换**

```markdown
# 旧：
业务对象如: 交易与凭证类：支付记录、退款记录、发票、物流单等

# 新：
业务对象：识别需求中描述的所有核心实体，包括但不限于用户角色、业务数据、
操作记录、凭证单据等。根据需求文本实际内容提取，不要引入需求中未提及的类型。
```

- [ ] **Step 2: Commit**

```bash
git add prompts/requirement_analysis.md
git commit -m "docs: remove e-commerce bias from requirement_analysis prompt"
```

### Task C-3: 清洗 prompts/generator.md 和 evaluator.md 中的约束 ID 引用

**Files:**
- Modify: `prompts/generator.md`
- Modify: `prompts/evaluator.md`

搜索 `X001`、`E001` 等约束 ID 模式引用，确认是否有硬编码的约束编号规则。如果发现依赖具体 ID 格式的指令，改为通用描述。

- [ ] **Step 1: 搜索并评估**

Run: `grep -n "X00\|E00\|C00\|约束.*ID\|constraint.*id" prompts/generator.md prompts/evaluator.md`

- [ ] **Step 2: 根据发现决定处理方式**

如果只是示例（如"约束如 X001"），删除具体 ID，改为"约束如 C001"。如果有基于 ID 格式的规则（如"E 开头是异常、C 开头是约束"），保留——这是通用命名约定，不是特定领域。

- [ ] **Step 3: Commit**

```bash
git add prompts/generator.md prompts/evaluator.md
git commit -m "docs: remove specific constraint ID references from generator/evaluator prompts"
```

---

## Phase D: 最终验证

- [ ] **Step 1: 全局搜索确认无残留**

```bash
grep -rn "Coupon\|优惠券\|C002\|支付超时\|REFUND_FLOW" src/ --include="*.ts"
grep -rn "C001.*订单总数量\|订单总数量.*99\|订单金额.*99999" src/ --include="*.ts"
```
Expected: 零结果。

- [ ] **Step 2: 运行全部测试**

Run: `npx vitest run`
Expected: 全部通过。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 确认 scorer 在空配置下不崩**

模拟 `ENTITY_NAME_MAP` 为空时 fuzzyMatch 是否安全。

---

## 自检清单

- [ ] `grep "优惠券\|Coupon\|C001\|C002\|REFUND_FLOW" src/` 零结果
- [ ] `requirementChecks.ts` 已删除
- [ ] `generation.ts` 不再 import requirementChecks
- [ ] `evaluation.ts` 不再 import requirementChecks
- [ ] `scorer.ts` 不再硬编码实体/功能映射
- [ ] `config.yaml` 包含 benchmark 配置段
- [ ] prompt 模板无电商/医疗/教育示例
- [ ] 全部测试通过
