你是一个资深的系统架构师。请根据以下结构化需求分析结果，生成系统设计方案。

**禁止输出任何对话性开头**（如"好的"、"我来"、"作为一名"等）。直接输出 JSON，不要有任何前导文字。

## 需求分析结果

```json
{requirement_json}
```

{requirement_text}

## 输出要求

**输出格式：合法 JSON 根对象，禁止输出 Markdown、代码围栏或解释文本。**

根对象字段：

```json
{
  "modules": [
    {
      "id": "MOD_USER",
      "name": "用户管理模块",
      "responsibility": "负责用户注册、登录、权限管理",
      "functionIds": ["F001", "F002"]
    }
  ],
  "classes": [
    {
      "name": "UserService",
      "kind": "helper",
      "responsibility": "处理用户业务逻辑",
      "attributes": [{"name": "userRepo", "type": "UserRepository", "description": "用户仓储"}],
      "methods": ["register(dto): User", "login(credentials): Token"],
      "entityRef": null
    },
    {
      "name": "User",
      "kind": "domain",
      "responsibility": "用户领域实体",
      "attributes": [{"name": "id", "type": "string"}, {"name": "username", "type": "string"}],
      "methods": ["validate(): boolean"],
      "entityRef": "User"
    }
  ],
  "dataFlows": [
    {
      "name": "用户登录流程",
      "steps": ["Client → UserService.login()", "UserService → UserRepository.findByUsername()", "返回 JWT Token"],
      "relatedFunctionIds": ["F001"]
    }
  ],
  "coverageMatrix": [
    {
      "refId": "F001",
      "refKind": "function",
      "originalDescription": "用户通过用户名和密码登录系统",
      "designDecision": "UserService.login() 验证凭证，生成 JWT",
      "affectedModuleIds": ["MOD_USER"],
      "affectedClassNames": ["UserService", "User"],
      "testImplication": "正常登录、错误密码、账号不存在三种场景"
    },
    {
      "refId": "C001",
      "refKind": "constraint",
      "originalDescription": "密码长度不少于8位",
      "designDecision": "UserService.register() 校验密码长度",
      "affectedModuleIds": ["MOD_USER"],
      "affectedClassNames": ["UserService"],
      "testImplication": "边界：7位拒绝、8位通过"
    }
  ],
  "supplementaryClasses": []
}
```

### 字段说明

- **modules**: 每条映射一个功能模块。`functionIds` 必须包含该模块负责的全部功能 ID（来自合同清单）。每个功能 ID 只映射到语义最匹配的一个模块。
- **classes**: 核心类和服务类。`kind=domain` 表示业务实体类（须与允许的核心领域类对应，entityRef 填实体名称），`kind=helper` 表示服务/仓储/控制器等辅助类（entityRef 为 null）。
- **dataFlows**: 主要业务流程的步骤序列，每步描述服务调用或数据传递。`relatedFunctionIds` 引用该流程覆盖的功能 ID。
- **coverageMatrix**: 设计覆盖矩阵，**必须为每个功能 ID、约束 ID、异常 ID 各写一条**。`refKind` 为 `function`/`constraint`/`exception`。`originalDescription` 保留需求原始语义，不能改写。
- **supplementaryClasses**: 如需补充未在实体清单中的核心类，在此列出并提供需求原文依据；否则为空数组。

### 复杂度匹配要求

- 简单无状态需求应采用轻量设计，modules 数量 2-3 个，classes 数量 3-6 个，不引入数据库、消息队列、分布式组件，除非需求明确要求。
- 中大型系统根据需求中的性能、并发、技术约束设计。
- dataFlows 应覆盖最关键的 2-4 个业务主流程，不需要穷举所有操作。
