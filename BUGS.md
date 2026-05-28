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
- 状态: DONE

### BUG-5: NFR 中英重复
- 文件: src/generators/merge.ts
- 根因: _mergeByCategory 按原文 category 去重
- 修复: 加中英文映射
- 状态: DONE

## Round 3

### BUG-6: Help Module 缺失
- 根因: Registry 没覆盖 Help 章节
- 状态: DONE

### BUG-7: Design 约束覆盖不全
- 根因: 提示词问题
- 状态: DONE

## Round 4 — 残留质量问题

### BUG-8: _normalizeForMatch 不处理 Unicode 弯引号
- 文件: src/generators/merge.ts
- 根因: LLM 用直引号 'unalterable'，XML 用弯引号 “unalterable”，normalize 不统一
- 修复: 加 Unicode 引号/撇号统一化（弯→直）
- 状态: TODO

### BUG-9: 约束 3-way 去重失败
- 文件: src/generators/merge.ts
- 根因: 3 个分析任务各提取同一条约束（如安全属性修改权限），去重只做 2-way 比较
- 修复: 改去重逻辑支持 N-way
- 状态: TODO

### BUG-10: 异常中英重复
- 文件: src/generators/merge.ts
- 根因: X005(AuditExportFailure) 和 X008(审计导出失败) 是中英文重复
- 修复: 异常去重也用 source_text 比较和跨语言映射
- 状态: TODO

### BUG-11: LLM 编造 source_text
- 文件: prompts/requirement_analysis_constraints.md
- 根因: 约束提示词没禁止编造引用
- 修复: 加"找不到原文引用时留空，不要编造"
- 状态: TODO

### BUG-12: 异常覆盖率低
- 文件: prompts/test_generation.md 或相关
- 根因: 测试提示词没要求每个异常至少一个测试
- 修复: 加"每个异常至少一个测试用例"
- 状态: TODO

## Round 4 — 残留质量问题

### BUG-8: _normalizeForMatch 不处理 Unicode 弯引号
- 文件: src/generators/merge.ts
- 根因: LLM 用直引号，XML 用弯引号，normalize 不统一
- 修复: 加 Unicode 引号/撇号统一化
- 状态: TODO

### BUG-9: 约束 3-way 去重失败
- 文件: src/generators/merge.ts
- 根因: 多个分析任务各提同一条约束，去重只做 pairwise
- 修复: 改去重逻辑支持 N-way
- 状态: TODO

### BUG-10: 异常中英重复
- 文件: src/generators/merge.ts
- 根因: 异常去重没覆盖跨语言
- 修复: 扩展跨语言去重到异常
- 状态: TODO

### BUG-11: LLM 编造 source_text
- 文件: prompts/requirement_analysis_constraints.md
- 根因: 约束提示词没禁止编造引用
- 修复: 加禁止编造指令
- 状态: TODO

### BUG-12: 异常覆盖率低
- 文件: prompts/测试生成相关
- 根因: 测试提示词没要求每个异常至少一个测试
- 修复: 加覆盖要求
- 状态: TODO
