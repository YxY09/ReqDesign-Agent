# Bug Fix TODO

## Round 1

### BUG-1: 质量门 cross_reference_integrity 误报
- 文件: src/shared/analysisQualityGate.ts
- 根因: check #6 用 entity name 匹配 relationship target，但 fixCrossReferences 已把 target 转成 canonical ID。E001 != "Case" -> 误报
- 修复: 同时用 entity ID 和 entity name 匹配
- 状态: DONE

### BUG-2: review/report.md 空文件
- 文件: src/runtime.ts
- 根因: saveReviewReport("", result) 硬编码空字符串
- 修复: 从 result.json issues 生成 Markdown 报告
- 状态: DONE

### BUG-3: repair patch 没持久化到 test_cases.json
- 文件: src/runtime.ts
- 根因: repair 后的 artifact 没保存，保存的是 repair 前版本
- 修复: 调查 repair→save 流程
- 状态: DONE

## Round 2

### BUG-4: 约束跨语言重复
- 文件: src/generators/merge.ts
- 根因: Jaccard 对中英混合无效
- 修复: 比较 source_text 是否指向同一段原文
- 状态: TODO

### BUG-5: NFR 中英重复
- 文件: src/generators/merge.ts
- 根因: _mergeByCategory 按原文 category 去重
- 修复: 加中英文映射
- 状态: TODO

## Round 3

### BUG-6: Help Module 缺失
- 根因: Registry 没覆盖 Help 章节
- 状态: TODO

### BUG-7: Design 约束覆盖不全
- 根因: 提示词问题
- 状态: TODO
