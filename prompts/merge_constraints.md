你是一个约束补全专家。以下是已完成的需求分析结果。请仔细扫描原始需求文档，找出所有尚未被提取的业务规则、约束条件和异常流程。

## 已提取的约束
{existing_constraints}

## 已提取的异常
{existing_exceptions}

## 实体列表
{entity_names}

## 功能列表
{function_names}

## 原始需求文档
{requirement_text}

## 扫描指南

逐段扫描文档，重点关注以下句式：
- "必须/应当/shall/must/required" → 业务约束
- "不得/禁止/cannot/must not/不允许" → 禁止约束
- "如果...则/if...then" → 条件规则或异常
- "只有...才/only" → 前置条件
- "超过X次/within X days/at least/at most" → 阈值规则
- "自动/automatically" → 系统自动触发的规则
- 数据完整性要求（唯一性、必填、格式）

## 输出格式

输出 JSON：
```json
{
  "constraints": [{"id": "CX0NN", "description": "约束描述", "related_functions": ["F001"]}],
  "exceptions": [{"id": "XX0NN", "description": "异常描述", "trigger": "触发条件", "handling": "处理方式"}]
}
```

如果找不到任何缺失的约束或异常，输出空：`{"constraints": [], "exceptions": []}`
