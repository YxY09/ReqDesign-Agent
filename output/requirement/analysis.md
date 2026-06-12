# 需求分析说明

## 项目名称
CCTNS

## 项目概述
CCTNS V1.0 is a system designed to improve crime investigation and criminal detection processes for police personnel.

## 角色

| 角色名称 | 描述 |
|----------|------|
| Admin | Administrator with full system access |
| PoliceOfficer | Police personnel responsible for case investigation |
| Citizen | Public user who can register complaints |
| HelpDesk | Support staff handling user issues |
| RecordsStaff | Staff managing case records |
| Auditor | External auditor reviewing system activities |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_CONFIGURE_SYSTEM | ConfigureSystem | 配置系统参数 | A_ADMIN | high |
| FUN_CUSTOMIZE_UI | CustomizeUI | 自定义用户界面 | A_CITIZEN, A_ADMIN | medium |
| FUN_EXPORT_AUDIT | ExportAudit | Exports audit trails for specified cases | A_AUDITOR, A_ADMIN | low |
| FUN_INVESTIGATE_CASE | InvestigateCase | Facilitates the investigation process after complaint registration | A_POLICE_OFFICER | high |
| FUN_MANAGE_ACCESS | ManageAccess | 管理访问控制 | A_ADMIN, A_POLICE_OFFICER | high |
| FUN_MANAGE_USER | ManageUser | 管理用户配置 | A_ADMIN | high |
| FUN_PROSECUTE_CASE | ProsecuteCase | 起诉案件，记录与法院的互动 | A_POLICE_OFFICER | high |
| FUN_REGISTER_CASE | RegisterCase | Allows citizens to register complaints with police | A_CITIZEN, A_POLICE_OFFICER | high |
| FUN_SEARCH_CASE | SearchCase | Allows searching for cases | A_POLICE_OFFICER, A_ADMIN | medium |
| FUN_SEND_ALERT | SendAlert | 发送警报通知 | A_CITIZEN, A_POLICE_OFFICER | medium |
| FUN_TRACK_DEFECT | TrackDefect | Allows users to log and track defects or enhancement requests | A_CITIZEN, A_HELP_DESK | medium |

## 核心实体

### Case
Police case record
属性: caseId: String - Unique identifier for the case, status: String - Current status of the case, createdAt: DateTime - Date and time when case was created

### Suspect
Person suspected of involvement in a case
属性: suspectId: String - Unique identifier for the suspect, name: String - Name of the suspect

### Property
Property involved in a case
属性: propertyId: String - Unique identifier for the property, description: String - Description of the property

### CaseRegistration
Record of a case registration
属性: registrationId: String - Unique identifier for the registration, registrationDate: DateTime - Date and time of registration, complaintDetails: String - Details of the complaint

### CaseInvestigation
Record of a case investigation
属性: investigationId: String - Unique identifier for the investigation, startDate: DateTime - Date and time investigation started, endDate: DateTime - Date and time investigation completed, findings: String - Investigation findings

### AuditTrail
Record of system activities
属性: auditId: String - Unique identifier for the audit record, action: String - Action performed, timestamp: DateTime - Date and time of action, userId: String - User who performed action, eventType: String - 事件类型（创建/读取/更新/删除）, caseId: String - 关联的案件ID, details: String - 操作详情

### CaseProsecution
案件起诉记录
属性: prosecutionId: String - 起诉记录唯一标识, courtInteractionDetails: String - 法院互动详情, date: DateTime - 互动日期

### SearchResult
搜索结果
属性: searchId: String - 搜索唯一标识, criteria: String - 搜索条件, resultCount: Integer - 结果数量

### UserProfile
用户配置文件，存储用户个性化设置
属性: uiSettings: Object - 用户界面配置设置, defaultValues: Object - 数据输入的持久默认值, username: String - 用户登录名, role: String - 用户角色, securityLevel: Integer - 安全级别

### Configuration
系统配置参数
属性: stateSpecificData: Object - 州特定数据配置, businessRules: Object - 业务规则配置

### DefectRequest
缺陷或增强请求
属性: title: String - 请求标题, description: String - 详细描述, category: String - 分类（缺陷/增强）, status: String - 当前状态, submittedAt: DateTime - 提交时间, submittedBy: String - 提交用户ID

### Alert
警报通知
属性: type: String - 警报类型（邮件/SMS）, content: String - 警报内容, sentAt: DateTime - 发送时间, status: String - 发送状态, recipientId: String - 接收用户ID

### AccessViolation
访问违规记录
属性: timestamp: DateTime - 违规发生时间, attemptedAccess: String - 尝试访问的资源, outcome: String - 访问结果

## 业务约束

- **CON_FUNC_2RR8SR00**: 界面必须尽可能可定制或用户可配置
- **CON_FUNC_82M2LE00**: 系统必须能够在5-8秒内执行简单搜索
- **CON_FUNC_CCV71Y00**: 系统必须只允许管理员用户设置用户配置文件并将用户分配到组
- **CON_FUNC_INEY5700**: 系统必须能够发送警报（如电子邮件、短信）给选择接收的用户
- **CON_FUNC_LVE7BQ00**: 系统必须只允许超级用户更改组或用户的安全属性
- **CON_FUNC_NEVER_SHOW_INACCESSIBLE_RECORDS_FZPR**: Never show inaccessible records in search results
- **CON_FUNC_NNI3W000**: 系统必须允许数据输入有持久默认值
- **CON_FUNC_PERFORM_SIMPLE_SEARCH_WITHIN_TEE9**: Perform simple search within 5-8 seconds
- **CON_FUNC_PROVIDE_CONTEXT_SENSITIVE_HELP_5S58**: Provide context-sensitive help for all UI actions
- **CON_FUNC_PROVIDE_INTERFACE_LOGGING_DEFECTS_UTPV**: Provide interface for logging defects/enhancements
- **CON_FUNC_WBH12K00**: 系统应提供基于角色的功能控制
- **CON_FUNC_WWHGA800**: 系统必须采用单一的用户界面规则集
- **CON_FUNC_YQEFFJ00**: 系统必须允许用户成为多个组的成员
- **CON_FUNC_Z6XNK300**: 系统必须允许用户将案件访问限制为指定用户或用户组
- **CON_SEC_EXPORT_AUDIT_TRAILS_SPECIFIED_7DBG**: Export audit trails for specified cases
- **CON_SEC_MAINTAIN_UNALTERABLE_AUDIT_TRAIL_BXDD**: Maintain unalterable audit trail
- **CON_SEC_PBZNZM00**: 系统必须跟踪事件而不需要人工干预，并将信息存储在审计跟踪中
- **CON_SEC_UHM14D00**: 系统必须将未经授权的案件访问尝试记录在审计跟踪中

## 异常流程

- **EXC_INDUZN00**: 审计跟踪导出失败 (触发: 导出审计跟踪时发生错误, 处理: 记录错误日志，显示错误消息并提示用户重试)
- **EXC_N4FYX900**: 用户尝试访问无权查看的案件 (触发: 用户请求访问权限不足的案件, 处理: 记录到审计跟踪，并向用户显示适当错误消息)
- **EXC_IUOTOB00**: 用户尝试访问无权限的案件 (触发: 用户尝试查看或搜索无权限的案件, 处理: 记录在审计跟踪中，并向用户显示适当错误消息)
- **EXC_CASE_FOUND**: Case not found (触发: User searches for non-existent case, 处理: Show appropriate error message)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT**: Unauthorized access attempt (触发: User attempts to access case without permission, 处理: Log attempt in audit trail and show appropriate error message)
- **EXC_DF5BUD00**: 未经授权的访问尝试 (触发: 用户尝试访问无权限的案件, 处理: 记录在审计跟踪中，并根据配置显示不同的响应)
- **EXC_820FV600**: 案件未找到 (触发: 用户搜索或访问不存在的案件, 处理: 显示错误消息，提示案件不存在)

## 非功能需求

- **performance**: System must perform simple search within 5-8 seconds
- **security**: System must maintain unalterable audit trail
- **usability**: User interfaces should comply with Standard ISO 9241
- **可用性**: 用户界面应符合ISO 9241标准

## 业务流程

### CaseRegistration

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. Citizen submits complaint
2. System generates case reference
3. Case is assigned to investigating officer

### CaseInvestigation

参与角色: A_POLICE_OFFICER

1. Officer reviews case details
2. Officer records evidence
3. Officer updates case status
4. System logs investigation activities

### 案件起诉流程

参与角色: A_POLICE_OFFICER

1. 选择案件
2. 记录法院互动
3. 保存起诉记录

### 案件搜索流程

参与角色: A_POLICE_OFFICER

1. 输入搜索条件
2. 执行搜索
3. 查看结果

### 界面自定义流程

参与角色: A_CITIZEN, A_ADMIN

1. 登录系统
2. 访问设置页面
3. 调整界面元素
4. 保存配置

### 系统配置流程

参与角色: A_ADMIN

1. 管理员登录
2. 访问配置模块
3. 更新配置参数
4. 保存更改

### 缺陷跟踪流程

参与角色: A_CITIZEN, A_HELP_DESK

1. 用户提交缺陷或增强请求
2. 系统记录请求
3. 帮助台处理请求
4. 系统更新请求状态
5. 系统通知用户处理结果

### 审计导出流程

参与角色: A_AUDITOR

1. 审计员选择案件
2. 系统生成审计报告
3. 系统导出报告
4. 审计员下载报告

### 警报发送流程

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. 用户配置警报接收方式
2. 系统事件触发警报
3. 系统发送警报
4. 系统记录发送状态
