你是一个资深的系统架构师。请根据以下 DesignBrief（设计输入合同），生成系统设计方案。

**禁止输出任何对话性开头**（如"好的"、"我来"、"作为一名"等）。直接输出 JSON，不要有任何前导文字。

## 领域概念模型（Domain Model）

```json
{domain_model_json}
```

领域概念模型是业务骨架的权威来源。设计中的 `kind: "domain"` 类必须一一对应领域概念，不能替代、改名或吞掉领域概念。

## DesignBrief（设计输入合同）

```json
{requirement_json}
```

{requirement_text}

DesignBrief 是设计阶段的需求输入源：
- `designContract.allowedFunctionIds` / `allowedConstraintIds` / `allowedExceptionIds` 是唯一合法的功能、约束、异常 ID。
- 输出中只能使用 `F001` / `C001` / `X001` 这种 display ID，禁止输出 `FUN_*`、`CON_*`、`EXC_*` 内部 ID，也禁止自行重新编号。
- `coverageSkeleton` 是权威覆盖义务清单（功能/约束/异常）。**你不需要输出 coverageMatrix——它由系统从你的 implementation 段落和模块映射自动生成。** 你要做的是**逐条**确保覆盖完整：每条**约束**有 constraintImplementation、每条**异常**有 exceptionImplementation、每个**功能 ID** 都出现在某个 module 的 `functionIds` 里。skeleton 里任何一项没被这样覆盖，就会被判为遗漏。
- `constraints[].anchors` / `exceptions[].anchors` 是必须保留的可验证参数。若 anchors 非空，必须出现在对应 implementation 的 `parametersPreserved`，并且逐字出现在 `implementationMechanism` / `trigger` / `handling` 中。
- `entities[].sourceFunctions` / `sourceConstraints` 是规范化后的来源链接，用它们决定领域类、服务类和模块边界，不要从原始大 JSON 中猜。

## 设计哲学（必读）

DesignBrief 里的**约束**和**异常**是设计的**核心目标**，不是 traceability 表格的附属项。你的输出 schema 把它们放在最前——必须为每条约束、每条异常**独立写完整的实现段落**，不能压缩成一行决策。

约束的 `sourceText` 和 `anchors` 里出现的**每一个数值、单位、算法名、限制值都必须 verbatim 出现在你的设计里**。例如：
- 约束 source_text = "AES/Rijndael (128-bit block, 256-bit key) and Twofish (128-bit block, 256-bit key). A random 128-bit IV is generated on each save."
- 设计里**必须**逐字出现：`AES/Rijndael`、`Twofish`、`128-bit block`、`256-bit key`（出现两次）、`128-bit IV`
- 把这些参数列入 `parametersPreserved`，机制说明（`implementationMechanism`）里也必须逐字出现

**禁止泛化**：禁止写"使用加密算法"、"采用某种格式"、"在合理时间内清除"——这些都丢了关键参数。

## 输出要求

**输出格式：合法 JSON 根对象，禁止输出 Markdown、代码围栏或解释文本。**

根对象字段（按这个顺序输出，**约束/异常实现先于模块/类**）：

```json
{
  "constraintImplementations": [
    {
      "constraintId": "C001",
      "implementationMechanism": "EncryptionEngine 在 Database.save() 中调用 AES/Rijndael (128-bit block, 256-bit key) 或 Twofish (128-bit block, 256-bit key) 对数据库内容加密；每次 save() 调用前生成一个新的随机 128-bit IV 作为加密参数。",
      "parametersPreserved": ["AES/Rijndael", "Twofish", "128-bit block", "256-bit key", "128-bit IV"],
      "trigger": "用户调用 Database.save() 或 saveAs() 时",
      "handling": "EncryptionEngine 用上述算法+随机 IV 加密 Database 字节流，写入 .kdb 文件；旧 IV 丢弃不复用。",
      "affectedModuleIds": ["MOD_SECURITY", "MOD_DATABASE"],
      "affectedClassNames": ["EncryptionEngine", "Database"]
    }
  ],
  "exceptionImplementations": [
    {
      "exceptionId": "X001",
      "trigger": "用户输入 Master Password 但 Database.open() 时密钥派生失败 / 解密失败",
      "handling": "Database.open() 返回 OpenError；UI 显示\"密码错误，数据库无法打开\"；不允许任何 recovery / back-door 路径。",
      "parametersPreserved": [],
      "affectedModuleIds": ["MOD_DATABASE", "MOD_SECURITY"],
      "affectedClassNames": ["Database", "MasterKey"]
    }
  ],
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
      "entityRef": null,
      "domainRefs": []
    },
    {
      "name": "User",
      "kind": "domain",
      "responsibility": "用户领域实体",
      "attributes": [{"name": "id", "type": "string"}, {"name": "username", "type": "string"}],
      "methods": ["validate(): boolean"],
      "entityRef": "User",
      "domainRefs": ["D001"]
    }
  ],
  "dataFlows": [
    {
      "name": "用户登录流程",
      "steps": ["Client → UserService.login()", "UserService → UserRepository.findByUsername()", "返回 JWT Token"],
      "relatedFunctionIds": ["F001"]
    }
  ],
  "supplementaryClasses": []
}
```

### 字段说明

- **constraintImplementations**（必填，关键）：每条约束一个独立段落。
  - `constraintId`：必须来自 DesignBrief 的 `designContract.allowedConstraintIds`（如 C001/C003）。
  - **不要输出 `sourceTextVerbatim` 字段**——系统会从 DesignBrief 的 `sourceText` 读取约束原文，重复输出会浪费篇幅。
  - `implementationMechanism`：用具体设计语言说明这条规则怎么实现——涉及哪个模块/类/方法/算法/数据路径。**source_text 中所有的算法名、数值、单位都必须 verbatim 出现在这里**。
  - `parametersPreserved`：至少包含 DesignBrief 对应约束的全部 `anchors`，并补充从该约束 `source_text` 中提取的所有可验证参数（算法名 / 数值+单位 / 限制值 / 文件扩展名 / 关键词组）。例如 `["AES/Rijndael", "Twofish", "256-bit key", "128-bit IV", ".kdb", "10 seconds", "single instance"]`。**漏掉一个就会被设计检查器拒绝**。
  - `trigger` / `handling`：规则在系统中何时被触发、触发后发生什么具体行为。
  - 即便约束很短（如"组必须有名称"），也必须独立出一段，至少说明在哪个类/方法里校验、违反时如何响应。

- **exceptionImplementations**（必填）：每条异常一个独立段落，同上要求。`exceptionId` 必须来自 `designContract.allowedExceptionIds`。**不要输出 `sourceTextVerbatim` 字段**。`parametersPreserved` 通常为空数组，但若 DesignBrief `anchors` 非空或 `sourceText` 含数值（如"3 次失败后锁定"）则必填。

- **modules**：每条映射一个功能模块。`functionIds` 必须包含该模块负责的全部功能 ID（来自 `designContract.allowedFunctionIds`）。每个功能 ID 只映射到语义最匹配的一个模块。

- **classes**：核心类和服务类。`kind=domain` 表示业务实体类（须与 `designContract.allowedEntityNames` 对应，entityRef 填实体名称），`kind=helper` 表示服务/仓储/控制器等辅助类（entityRef 为 null）。`domainRefs` 填写该类对应的领域概念模型 D-ID（如 `["D001", "D002"]`），`kind=domain` 的类必须至少引用一个 D-ID，`kind=helper` 的类填空数组。

- **dataFlows**：主要业务流程的步骤序列，每步描述服务调用或数据传递。`relatedFunctionIds` 引用该流程覆盖的功能 ID。

- **coverageMatrix**：**不要输出。** 系统会从你的 constraintImplementations / exceptionImplementations（约束、异常）和 modules 的 functionIds（功能）自动派生这张 traceability 索引表。你只要保证三件事：每条约束有 implementation 段落、每条异常有 implementation 段落、每个功能 ID 都被某个 module 的 functionIds 收纳。

- **supplementaryClasses**：如需补充未在实体清单中的核心类，在此列出并提供需求原文依据；否则为空数组。

### 复杂度匹配要求

- 简单无状态需求应采用轻量设计，modules 数量 2-3 个，classes 数量 3-6 个，不引入数据库、消息队列、分布式组件，除非需求明确要求。
- 中大型系统根据需求中的性能、并发、技术约束设计。
- dataFlows 应覆盖最关键的 2-4 个业务主流程，不需要穷举所有操作。

### 自检（输出前必做）

1. DesignBrief `coverageSkeleton` 给出的**每一个约束 ID** 是否都在 constraintImplementations 中？少一个就重写。
2. DesignBrief `coverageSkeleton` 给出的**每一个异常 ID** 是否都在 exceptionImplementations 中？少一个就重写。
3. `parametersPreserved` 列出的每个参数是否都**逐字**出现在 `implementationMechanism` 或 `handling` 中？少一个就补全。
4. `implementationMechanism` 是否回答了"哪个类/方法/算法+具体参数实现这条规则"？只写"系统会处理"等空话就是没回答。
5. 输出 JSON 中是否出现 `FUN_`、`CON_`、`EXC_`？出现就重写为 DesignBrief 的 display ID。
6. 是否多余输出了 `sourceTextVerbatim` 字段？有则删除（系统会自动从 `source_text` 读取，重复输出是浪费）。
7. **领域模型覆盖**：领域概念模型中的每个 entity/value_object 概念是否都有对应的 `kind=domain` 类？该类的 `domainRefs` 是否包含对应 D-ID？
8. 设计中是否有 `kind=domain` 类的名称与领域模型概念名不一致？如不一致必须改为领域模型中的名称。
