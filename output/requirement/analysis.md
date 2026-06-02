# 需求分析说明

## 项目名称
PoliceCaseManagementSystem

## 项目概述
A system for police to manage case registration, investigation, and prosecution processes with citizen interaction capabilities.

## 角色

| 角色名称 | 描述 |
|----------|------|
| Admin | System administrator with full access rights |
| PoliceOfficer | Investigating officer handling cases |
| Citizen | General public user who can file complaints |
| HelpDesk | Support staff handling user issues |
| Auditor | External auditor reviewing system activities |
| RecordsStaff | Staff managing case records |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_ACCESS_CONTROL | AccessControl | Manage access to cases and functionality | A_ADMIN | high |
| FUN_CONFIGURE_APPLICATION | ConfigureApplication | Configure system settings and parameters | A_ADMIN | low |
| FUN_CUSTOMIZE_UI | CustomizeUI | Customize user interface elements | All | low |
| FUN_EXPORT_AUDIT_TRAIL | ExportAuditTrail | Export audit trail data for review | A_AUDITOR | low |
| FUN_INVESTIGATE_CASE | InvestigateCase | Conduct case investigations | A_POLICE_OFFICER | high |
| FUN_LOG_DEFECT | LogDefect | Log system defects or enhancement requests | A_CITIZEN, A_POLICE_OFFICER | low |
| FUN_MANAGE_USER_PROFILE | ManageUserProfile | Manage user profiles and access rights | A_ADMIN | medium |
| FUN_NAVIGATE | Navigate | System navigation functionality | All | low |
| FUN_PROSECUTE_CASE | ProsecuteCase | Handle case prosecution | A_POLICE_OFFICER | high |
| FUN_REGISTER_CASE | RegisterCase | Register new police cases | A_CITIZEN, A_POLICE_OFFICER | high |
| FUN_SEARCH_CASE | SearchCase | Search for cases with basic or advanced criteria | A_POLICE_OFFICER, A_CITIZEN | medium |
| FUN_SEND_ALERT | SendAlert | Send alerts via email or SMS | System | medium |
| FUN_TRACK_CASE | TrackCase | Track case status and progress | A_CITIZEN, A_POLICE_OFFICER | medium |
| FUN_TRACK_DEFECT | TrackDefect | Track status of submitted defects or requests | A_HELP_DESK | low |

## 核心实体

### Case
Police case record
属性: caseId: String - Unique case identifier, status: String - Current case status, registrationDate: DateTime - 注册日期, description: String - Case details, title: String - Case title, createdAt: DateTime - 创建时间, updatedAt: DateTime - 更新时间, createdDate: DateTime - Date case was created, lastAccessed: DateTime - Last access date

### Suspect
Person suspected of crime
属性: suspectId: String - Unique suspect identifier, name: String - Suspect name, identificationNumber: String - 身份证号, age: Integer - 年龄, gender: String - 性别, description: String - Suspect details

### Property
Property involved in case
属性: propertyId: String - Unique property identifier, description: String - Property details, value: Decimal - 财产价值, name: String - 财产名称

### Document
Case-related documents
属性: documentId: String - Unique document identifier, title: String - 文档标题, content: Binary - Document content, type: String - Document type

### AuditTrail
System activity audit records
属性: auditId: String - Unique audit record identifier, action: String - Action performed, timestamp: DateTime - When action occurred, userId: String - User who performed action, entityType: String - Type of entity affected, entityId: String - Identifier of affected entity

### UserProfile
User account and preferences
属性: userId: String - Unique user identifier, role: String - User role, preferences: Object - User interface preferences, uiPreferences: Object - 用户界面偏好设置, language: String - 用户首选语言, username: String - 用户名

### Complaint
Citizen complaints
属性: complaintId: String - Unique complaint identifier, description: String - Complaint details, status: String - 投诉状态, title: String - 投诉标题

### SearchResult
Search query results
属性: searchId: String - 搜索唯一标识, query: String - 搜索查询, resultCount: Integer - 结果数量, resultId: String - 结果ID, items: List - 结果项列表, queryId: String - Unique query identifier, results: List - List of matching items

## 业务约束

- **CON_FUNC_1BAKC800**: 系统必须确保所有错误消息都是有意义的，以便用户能够适当地采取行动。
- **CON_FUNC_ADMINS_SET_USER_PROFILES_PZCG**: Only admins can set up user profiles
- **CON_FUNC_PLANNED_DOWNTIME_EXCEED_SPECIFIED_9TTB**: Planned downtime must not exceed specified limits
- **CON_FUNC_SYSTEM_AVAILABLE_SPECIFIED_HOURS_HCK3**: System must be available during specified hours
- **CON_FUNC_SYSTEM_PROVIDE_DETAILED_CONTEXT_PB66**: System must provide detailed context-sensitive help material
- **CON_FUNC_SYSTEM_PROVIDE_INTERFACE_LOGGING_CVQW**: System must provide interface for logging defects
- **CON_FUNC_SYSTEM_RESTORABLE_WITHIN_SPECIFIED_FU5F**: System must be restorable within specified time after failure
- **CON_FUNC_SYSTEM_SCALABLE_DIFFERENT_POLICE_QLYH**: System must be scalable for different police station sizes
- **CON_FUNC_SYSTEM_SEND_ALERTS_ACTIONS_MEQI**: System must send alerts when actions are taken
- **CON_FUNC_SYSTEM_SUPPORT_MULTILINGUAL_INTERFACE_9JEO**: System must support multilingual interface
- **CON_FUNC_SYSTEM_SUPPORT_OFFLINE_OPERATION_9MXN**: System must support offline operation with critical functionality
- **CON_FUNC_UNPLANNED_DOWNTIME_EXCEED_SPECIFIED_M82F**: Unplanned downtime must not exceed specified limits
- **CON_FUNC_USER_INTERFACE_CUSTOMIZABLE_SAVED_V6CO**: User interface must be customizable and saved in user profile
- **CON_FUNC_VKFDIF00**: 系统必须能够在5-8秒内执行简单搜索，在10-15秒内执行高级搜索（多个搜索条件），无论存储容量或系统中的案件数量如何。
- **CON_PERF_SYSTEM_MAINTAIN_CASE_RETRIEVAL_5OK1**: System must maintain case retrieval performance standards
- **CON_PERF_SYSTEM_PROVIDE_ADEQUATE_RESPONSE_2US4**: System must provide adequate response times under standard and peak conditions
- **CON_SEC_AUDIT_TRAIL_DATA_MAINTAINED_HNV3**: Audit trail data must be maintained for at least the life of the case
- **CON_SEC_GFUDBQ00**: 系统必须能够维护一个不可更改的审计跟踪，自动捕获和存储关于关键实体（案件、嫌疑人、财产等）的所有操作（创建/读取/更新/删除）的信息。
- **CON_SEC_HTTPS_SSL_HTTP_OZXC**: 系统必须使用HTTPS作为通信协议，即通过加密的安全套接字层（SSL）的HTTP。
- **CON_SEC_SECURITY_ATTRIBUTE_CHANGES_MADE_FM6A**: Security attribute changes can only be made by super-users
- **CON_SEC_SYSTEM_ALLOW_LIMITING_CASE_5GU5**: System must allow limiting case access

## 异常流程

- **EXC_YPGXB500**: 案件检索超时 (触发: 案件检索时间超过规定阈值, 处理: 系统返回超时错误，建议用户优化搜索条件或稍后重试)
- **EXC_IUOTOB00**: 用户尝试访问无权限的案件 (触发: 用户请求访问或搜索无权限的案件, 处理: 系统记录在审计跟踪中，并根据配置显示不同级别的响应)
- **EXC_IUOTOB00_2**: 用户尝试访问无权限的案件 (触发: 用户请求访问或搜索无权限的案件, 处理: 系统根据配置提供不同级别的响应：显示标题和元数据、仅显示案件存在、不显示任何信息)
- **EXC_N7KH6A00**: 用户尝试执行无权限的操作 (触发: 用户尝试执行超出其权限范围的操作, 处理: 系统记录违规行为到审计跟踪，并向用户显示有意义的错误消息)
- **EXC_ATTEMPT_MODIFY_AUDIT_TRAIL**: Attempt to modify audit trail data (触发: User or system attempts to modify audit trail records, 处理: System must reject modification attempts and log the violation)
- **EXC_CASE_FOUND**: Case not found (触发: Requested case does not exist or user has no access, 处理: Display appropriate message based on security settings)
- **EXC_CASE_RETRIEVAL_TIMEOUT**: Case retrieval timeout (触发: Case retrieval exceeds performance thresholds, 处理: System must notify user and suggest alternative search criteria)
- **EXC_CUSTOMIZATION_SAVE_FAILURE**: Customization save failure (触发: Failure to save UI customization to user profile, 处理: System must revert to default settings and notify user)
- **EXC_OFFLINE_DATA_SYNCHRONIZATION_CONFLICT**: Offline data synchronization conflict (触发: Conflicting changes made during offline operation, 处理: System must flag conflicts for manual resolution by authorized users)
- **EXC_SEARCH_RETURNS_RESULTS**: Search returns no results (触发: No cases match search criteria, 处理: Display informative message and suggest alternative searches)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT**: Unauthorized access attempt (触发: User attempts to access case without permission, 处理: Log attempt in audit trail and show appropriate message)
- **EXC_UNAUTHORIZED_PROFILE_MODIFICATION_ATTEMPT**: Unauthorized profile modification attempt (触发: Non-superuser attempts to modify security attributes, 处理: System must reject changes and log the attempt)

## 非功能需求

- **性能**: 系统必须能够在5-8秒内执行简单搜索，在10-15秒内执行高级搜索
- **安全**: 系统必须使用HTTPS作为通信协议
- **可用性**: 系统必须提供详细的上下文相关帮助材料
- **可扩展性**: 系统应设计为可扩展，以适应小型和大型警察局的不同需求
- **可访问性**: 系统用户界面必须适合有特殊需求的用户
- **Usability**: User interfaces must comply with ISO 9241 standards
- **Architecture**: System must be implemented using SOA
- **Reliability**: System must work in offline mode for critical functionality

## 业务流程

### CaseRegistration

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. Citizen submits complaint
2. Police officer registers case
3. System generates case ID

### CaseInvestigation

参与角色: A_POLICE_OFFICER

1. Police officer initiates investigation
2. System records investigation details
3. Police officer updates case status

### CaseProsecution

参与角色: A_POLICE_OFFICER

1. Police officer interfaces with court
2. System records court interactions
3. Police officer updates case status

### 公民信息交换流程

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. 公民提交信息或请求
2. 警务人员处理请求
3. 系统发送响应给公民

### 案件导航流程

参与角色: A_POLICE_OFFICER

1. 警务人员查看分配的案件
2. 系统显示相关警报和任务
3. 警务人员执行任务

### 案件注册流程

参与角色: A_POLICE_OFFICER

1. 填写案件信息
2. 提交案件
3. 系统验证
4. 案件创建

### 案件调查流程

参与角色: A_POLICE_OFFICER

1. 分配调查员
2. 收集证据
3. 记录调查结果
4. 更新案件状态

### 案件起诉流程

参与角色: A_POLICE_OFFICER

1. 准备起诉材料
2. 提交起诉
3. 系统记录
4. 更新案件状态

### 缺陷报告流程

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. 填写缺陷报告
2. 提交报告
3. 系统记录
4. 分配帮助台人员

### DefectReporting

参与角色: Citizen, PoliceOfficer, HelpDesk

1. Identify defect or enhancement
2. Log details in system
3. Submit for tracking
4. Receive confirmation
5. Monitor status updates
