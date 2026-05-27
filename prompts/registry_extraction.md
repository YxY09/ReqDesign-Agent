你是一个术语注册专家。从需求文档中提取所有核心实体和功能，建立全局术语注册表。

## 提取规则

### 实体
- 识别文档中所有名词性概念：有明确定义的、有属性列表的、在多个上下文中反复出现的
- 每个实体给出：
  - id：大写蛇形，如 E_CASE, E_USER
  - canonicalName：PascalCase，如 Case, User
  - displayName：中文显示名，如 "案件", "用户"
  - aliases：文档中出现过的所有别名（中文、英文、缩写）
- 同一个概念的不同叫法必须合并为一个条目（如 "Police"、"PoliceOfficer"、"民警"、"办案人员" 都是同一实体）

### 功能
- 识别文档中所有动词性操作：用户可以触发的、系统自动执行的
- 每个功能给出：
  - id：大写蛇形，如 F_REGISTER_COMPLAINT
  - canonicalName：PascalCase
  - aliases：所有别名

## 注意
- 宁可多提取也不要遗漏
- 别名要覆盖文档中实际出现的各种叫法
- 同一概念只出现一次，不要重复

## 输出格式
```json
{
  "entities": [
    {
      "id": "E_CASE",
      "canonicalName": "Case",
      "displayName": "案件",
      "aliases": ["Case", "案件", "Police Case", "Case Record", "FIR"]
    }
  ],
  "functions": [
    {
      "id": "F_REGISTER_COMPLAINT",
      "canonicalName": "RegisterComplaint",
      "aliases": ["RegisterComplaint", "注册投诉", "Submit Complaint", "登记投诉"]
    }
  ]
}
```

## 需求文档
{requirement_text}
