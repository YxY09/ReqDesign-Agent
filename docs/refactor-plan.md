# ReqDesign-Agent 重构计划

> 生成日期: 2026-05-21
> 来源: 4 路并行 scout 深度代码审查
> 状态: 第一批执行中

---

## 第一批：基础设施强化

| # | 问题 | 文件 | 计划 |
|---|------|------|------|
| 1 | RetryConfig 扩展 | `src/config.ts` | Task 1 |
| 2 | withRetry 工具函数 | `src/utils/retry.ts` | Task 2 |
| 3 | chat() 集成 retry | `src/llmClient.ts` | Task 3 |
| 4 | AbortController 超时 | `src/llmClient.ts` | Task 4 |
| 5 | Config zod 严格验证 | `src/config.ts`, `src/configSchema.ts` | Task 5 |
| 6 | XML Parser 替换库 | `src/xmlParser.ts` | Task 6 |
| 7 | 清理 OCR 硬编码 | 确认 | Task 7 |
| 8 | 全量测试 + 类型检查 | — | Task 8 |

## 第二批：消除重复（待规划）

- P0-2: Generators 代码重复
- P0-3: Tools 层统一接口
- P1-1: 编排层模块合并
- P1-5: 共享工具去重

## 第三批：运行时安全（待规划）

- P0-4: Memory TTL 过期
- P1-2: State mutation 保护
