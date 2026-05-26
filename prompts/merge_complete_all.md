你是一个需求分析补全专家。以下是已完成合并的需求分析结果。请一次性完成以下三项任务：

1. **关系补全**：分析实体间的缺失关系
2. **约束补全**：扫描缺失的业务规则和异常流程
3. **功能去重**：识别语义重复的功能并合并

## 实体列表
{merged_entities}

## 功能列表
{functions_summary}

## 已有约束
{existing_constraints}

## 已有异常
{existing_exceptions}

## 原始需求文档
{requirement_text}

## 扫描指南

### 关系补全
- 根据需求文档中的业务流程推断实体间关系
- 只输出确实存在但当前缺失的关系
- 关系类型：one-to-one, one-to-many, many-to-one, many-to-many

### 约束补全
逐段扫描文档，重点关注以下句式：
- "必须/应当/shall/must/required" → 业务约束
- "不得/禁止/cannot/must not/不允许" → 禁止约束
- "如果...则/if...then" → 条件规则或异常
- "只有...才/only" → 前置条件
- "超过X次/within X days/at least/at most" → 阈值规则
- "自动/automatically" → 系统自动触发的规则
- 数据完整性要求（唯一性、必填、格式）

### 功能去重
- 只有语义相同或高度相似的功能才合并
- name 不同但描述同一业务操作 → 合并
- 有细微差异的不同功能不要合并

## 输出格式

直接输出 JSON，不要用 markdown 代码块包裹，不要输出其他内容：

```json
{
  "relationships": [
    {"entity": "源实体名", "target": "目标实体名", "type": "one-to-one|one-to-many|many-to-one|many-to-many", "description": "关系描述"}
  ],
  "constraints": [
    {"id": "CX0NN", "description": "约束描述", "related_functions": ["F001"]}
  ],
  "exceptions": [
    {"id": "XX0NN", "description": "异常描述", "trigger": "触发条件", "handling": "处理方式"}
  ],
  "dedup_functions": [
    {"keep": "保留的功能ID或name", "merge": ["要合并的功能ID1"], "reason": "合并原因"}
  ]
}
```

如果某部分没有发现任何补充，对应字段输出空数组 []。
