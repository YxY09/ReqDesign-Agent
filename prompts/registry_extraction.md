你是一个术语注册专家。从需求文档中提取所有核心实体和角色，建立全局术语注册表。

## 提取规则

### 实体
- 识别文档中所有名词性概念：有明确定义的、有属性列表的、在多个上下文中反复出现的
- 每个实体给出：
  - id：大写蛇形，如 E_CASE, E_USER
  - canonicalName：PascalCase，如 Case, User
  - displayName：中文显示名，如 "案件", "用户"
  - aliases：文档中出现过的所有别名（中文、英文、缩写）
- 同一个概念的不同叫法必须合并为一个条目（如 "Police"、"PoliceOfficer"、"民警"、"办案人员" 都是同一实体）

### 角色
- 识别文档中所有与系统交互的角色：用户类型、管理员、外部系统
- 每个角色给出：
  - id：大写蛇形，如 A_ADMIN, A_STUDENT
  - canonicalName：PascalCase，如 Admin, Student
  - displayName：中文显示名，如 "管理员", "学生"
  - aliases：文档中出现过的所有别名（中文、英文、缩写）
- 同一个角色的不同叫法必须合并为一个条目（如 "Admin"、"Administrator"、"管理员"、"超级用户" 都是同一角色）

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
  "actors": [
    {
      "id": "A_ADMIN",
      "canonicalName": "Admin",
      "displayName": "管理员",
      "aliases": ["Admin", "Administrator", "管理员", "超级用户"]
    }
  ]
}
```

## 需求文档
{requirement_text}
