你是一个资深的软件需求分析师。请从以下需求文档中抽取结构化的需求要素。

## 需求文档

{requirement_text}

## 输出要求

请以JSON格式输出，包含以下字段：

```json
{{
  "project_name": "项目名称",
  "project_overview": "项目概述，1-2句话",
  "actors": [
    {{
      "name": "角色名称",
      "description": "角色描述"
    }}
  ],
  "functions": [
    {{
      "id": "F001",
      "name": "功能名称",
      "description": "功能描述",
      "related_actors": ["相关角色"],
      "priority": "高/中/低"
    }}
  ],
  "entities": [
    {{
      "name": "实体名称",
      "description": "实体描述",
      "attributes": ["属性1", "属性2"]
    }}
  ],
  "constraints": [
    {{
      "id": "C001",
      "description": "约束描述",
      "related_functions": ["相关功能"]
    }}
  ],
  "exceptions": [
    {{
      "id": "E001",
      "description": "异常流程描述",
      "trigger": "触发条件",
      "handling": "处理方式"
    }}
  ],
  "non_functional_requirements": [
    {{
      "category": "性能/安全/可用性等",
      "description": "需求描述"
    }}
  ],
  "business_processes": [
    {{
      "name": "流程名称",
      "steps": ["步骤1", "步骤2"],
      "actors": ["参与角色"]
    }}
  ]
}}
```

注意：
1. 只输出JSON，不要输出其他内容
2. 如果需求文档中没有提到某个字段的内容，使用空数组[]
3. 功能ID以F开头，约束ID以C开头，异常ID以E开头，按顺序编号
4. 尽量从需求文本中提取，不要过度推测
