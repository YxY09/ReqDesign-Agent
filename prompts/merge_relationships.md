你是一个关系补全专家。以下是已合并的实体列表。请分析原始需求文档，找出实体之间缺失的关系。

只输出关系补丁，不要重写实体定义。只输出你认为确实存在但当前缺失的关系。

## 已有实体

{merged_entities}

## 原始需求

{requirement_text}

## 输出格式

输出 JSON 数组，每个元素：
```json
{"entity": "源实体名", "target": "目标实体名", "type": "one-to-one|one-to-many|many-to-one|many-to-many", "description": "关系描述"}
```

如果无法推断任何缺失关系，输出空数组 []。
