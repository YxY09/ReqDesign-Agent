# 需求分析说明

## 项目名称
CCTNS

## 项目概述
CCTNS V1.0 is a system designed to improve crime investigation and criminal detection by providing value to police personnel and citizens through automation and efficient information exchange.

## 角色

| 角色名称 | 描述 |
|----------|------|
| Admin | Administrator with full system access and configuration privileges |
| PoliceOfficer | Police personnel responsible for investigating cases |
| Citizen | General public user who can register complaints |
| HelpDesk | Support staff handling defects and enhancement requests |
| Auditor | External auditor who can examine audit trails |
| RecordsStaff | Records room staff managing case documentation |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_ACCESS_CONTROL | AccessControl | Manage access control for cases | A_ADMIN | high |
| FUN_CUSTOMIZE_INTERFACE | CustomizeInterface | Customize user interface settings | A_CITIZEN, A_ADMIN | medium |
| FUN_EXPORT_AUDIT_TRAIL | ExportAuditTrail | Exports audit trails for specified cases | A_AUDITOR | medium |
| FUN_GENERATE_REPORT | GenerateReport | Generate reports on system activity | A_ADMIN, A_AUDITOR | medium |
| FUN_INVESTIGATE_CASE | InvestigateCase | Facilitates the investigation process after complaint registration | A_POLICE_OFFICER | high |
| FUN_MANAGE_USER_PROFILE | ManageUserProfile | Manage user profiles and group assignments | A_ADMIN, A_CITIZEN | high |
| FUN_PROSECUTE_CASE | ProsecuteCase | Handle prosecution for a case | A_POLICE_OFFICER | high |
| FUN_REGISTER_CASE | RegisterCase | Allows citizens to register complaints with police | A_CITIZEN, A_POLICE_OFFICER | high |
| FUN_SEARCH_CASE | SearchCase | Search for cases | A_POLICE_OFFICER, A_ADMIN | high |
| FUN_TRACK_DEFECT | TrackDefect | Allows users to log and track defects or enhancement requests | A_HELP_DESK | medium |

## 核心实体

### Case
Police case record containing investigation details
属性: caseId: String - Unique identifier for the case, status: String - Current status of the case, createdAt: DateTime - Date and time when the case was created, title: String - Title of the case, updatedAt: DateTime - Date and time when the case was last updated

### Suspect
Person suspected of involvement in a case
属性: suspectId: String - Unique identifier for the suspect, name: String - Full name of the suspect, status: String - Current status of the suspect

### Document
Document or file associated with a case
属性: documentId: String - Unique identifier for the document, type: String - Type of document (e.g., evidence, report), title: String - Title of the document

### AuditTrail
Record of actions taken on critical entities
属性: action: String - Type of action performed, timestamp: DateTime - Date and time of the action, actionType: String - 操作类型(创建/读取/更新/删除), userId: String - User who performed the action, entityId: String - 被操作的实体ID, entityType: String - 被操作的实体类型, auditId: String - Unique identifier for the audit entry

### Property
Property related to a case
属性: propertyId: String - Unique identifier for the property, description: String - Description of the property, status: String - Current status of the property

### SearchResult
Result of a search query
属性: resultId: String - 结果唯一标识, items: List - 搜索结果项列表, query: String - Search query, results: List - List of matching cases

### UserProfile
User configuration and settings
属性: interfacePreferences: Object - 用户界面偏好设置, lastModified: DateTime - 最后修改时间, userId: String - Unique identifier for the user, securityLevel: String - 安全级别, privileges: List - 权限列表, uiConfig: Object - 用户界面配置, role: String - User role, uiSettings: Object - User interface preferences

### Complaint
Complaint filed by a citizen
属性: id: String - 投诉ID, description: String - Description of the complaint, status: String - Current status of the complaint, complaintId: String - Unique identifier for the complaint

## 业务约束

- **CON_DATA_SYSTEM_MAINTAIN_CASE_DATA_AWQ7**: System must maintain case data integrity during prosecution process
- **CON_FUNC_ADMIN_SET_USER_PROFILES_L1DC**: Only admin can set up user profiles and groups
- **CON_FUNC_ALLOW_USERS_BELONG_MULTIPLE_BN8A**: Allow users to belong to multiple groups
- **CON_FUNC_AUTOMATICALLY_TRACK_EVENTS_WITHOUT_5PBF**: Automatically track events without manual intervention
- **CON_FUNC_AVOID_HORIZONTAL_SCROLLING_SPGU**: Avoid horizontal scrolling
- **CON_FUNC_AVOID_SPLASH_SCREENS_UNLESS_OMQB**: Avoid splash screens unless useful
- **CON_FUNC_CASE_DATA_RECOVERABLE_SYSTEM_AUUC**: All case data must be recoverable after system failure
- **CON_FUNC_CASES_ACCESSIBLE_OFFLINE_CRITICAL_HY7N**: Cases must be accessible offline with critical functionality
- **CON_FUNC_DESIGN_NAVIGATION_SELF_DESCRIPTIVE_DQ2K**: Design navigation to be self-descriptive
- **CON_FUNC_DISPLAY_MULTIPLE_ENTITIES_SIMULTANEOUSLY_211Y**: Display multiple entities simultaneously
- **CON_FUNC_EMPLOY_CONSISTENT_RULES_Q01P**: Employ consistent UI rules
- **CON_FUNC_MAKE_INTERFACES_CUSTOMIZABLE_KPKV**: Make interfaces customizable
- **CON_FUNC_MINIMIZE_NAVIGATION_STEPS_B41U**: Minimize navigation steps
- **CON_FUNC_MINIMIZE_VERTICAL_SCROLLING_B1VM**: Minimize vertical scrolling
- **CON_FUNC_PRODUCE_MEANINGFUL_ERROR_MESSAGES_KKES**: Produce meaningful error messages
- **CON_FUNC_PROVIDE_INTERFACE_LOGGING_DEFECTS_AMXC**: Provide interface for logging defects
- **CON_FUNC_PROVIDE_ROLE_BASED_CONTROL_NUUL**: Provide role-based control for functionality
- **CON_FUNC_PROVIDE_TEXT_ALTERNATIVES_NON_5K9F**: Provide text alternatives for non-text media
- **CON_FUNC_SEND_ALERTS_USERS_ACTIONS_XNJM**: Send alerts to users when actions are taken
- **CON_FUNC_SHOW_USERS_LOCATION_NAVIGATION_SVNZ**: Show users their location in navigation
- **CON_FUNC_SUITABLE_USERS_SPECIAL_NEEDS_4ESE**: UI must be suitable for users with special needs
- **CON_FUNC_SYSTEM_PROVIDE_DETAILED_CONTEXT_PB66**: System must provide detailed context-sensitive help material
- **CON_FUNC_USER_INTERFACE_SUPPORT_MULTILINGUAL_QKE9**: User interface must support multilingual capabilities
- **CON_PERF_SEARCH_FUNCTIONALITY_MAINTAIN_PERFORMANCE_SOBX**: Search functionality must maintain performance regardless of data volume
- **CON_SEC_AUDIT_TRAIL_DATA_CANNOT_MJB5**: Audit trail data cannot be modified or deleted
- **CON_SEC_CAPTURE_STORE_ACCESS_CONTROL_DQCQ**: Capture and store access control violations
- **CON_SEC_EXPORT_AUDIT_TRAILS_SPECIFIED_7DBG**: Export audit trails for specified cases
- **CON_SEC_MAINTAIN_AUDIT_TRAIL_CASE_P2OY**: Maintain audit trail for case lifetime
- **CON_SEC_NEVER_INCLUDE_UNAUTHORIZED_RECORDS_7RBF**: Never include unauthorized records in search results
- **CON_SEC_OFFER_ALTERNATIVE_ACCESS_PATHS_2HSD**: Offer alternative access paths
- **CON_SEC_SUPER_USER_CHANGE_SECURITY_J9UH**: Only super-user can change security attributes
- **CON_SEC_SYSTEM_ALLOW_LIMITING_CASE_URAC**: System must allow limiting case access to specified users/groups
- **CON_SEC_SYSTEM_MAINTAIN_UNALTERABLE_AUDIT_Q4V6**: System must maintain unalterable audit trail
- **CON_USAB_COMPLY_ISO_XE8L**: UI must comply with ISO 9241
- **CON_USAB_ICT_ACCESSIBILITY_STANDARD_F8FC**: ICT accessibility standard

## 异常流程

- **EXC_Q7LRJX00**: 用户尝试访问被拒绝访问的案件 (触发: 用户尝试访问权限外的案件, 处理: 记录违规行为到审计跟踪)
- **EXC_UDDJFZ00**: 用户无权访问案件 (触发: 用户尝试访问无权限的案件, 处理: 记录审计跟踪并显示错误消息)
- **EXC_CASE_FOUND**: Case not found (触发: User searches for non-existent case, 处理: Show error message and suggest alternative actions)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT**: Unauthorized access attempt to case (触发: User attempts to access case without permission, 处理: Log violation in audit trail and show error message)
- **EXC_ACCESS_OFFLINE_MODE_NOT**: Attempt to access case in offline mode when not cached locally (触发: User tries to access case data without network connection when data not pre-cached, 处理: System should display clear error message indicating offline data not available and prompt to reconnect)
- **EXC_MULTILINGUAL_INTERFACE_RESOURCE_NOT**: Multilingual interface resource not available (触发: Selected language pack not installed or corrupted, 处理: Fall back to default language and notify administrator)
- **EXC_SEARCH_TIMEOUT_DUE_OVERLOAD**: Search timeout due to system overload (触发: Complex search query exceeds maximum allowed time, 处理: Cancel search and suggest simplified query parameters)
- **EXC_MODIFY_DURING_PROSECUTION_PHASE**: Attempt to modify case during prosecution phase (触发: User tries to edit case data after prosecution has begun, 处理: Block modifications and log attempt in audit trail)
- **EXC_OFFLINE_DATA_SYNCHRONIZATION_CONFLICT**: Offline data synchronization conflict (触发: Conflicting changes detected during offline-to-online synchronization, 处理: Flag conflict for administrator resolution and preserve both versions)

## 非功能需求

- **performance**: System must provide adequate response times under standard and peak conditions
- **security**: System must maintain unalterable audit trails
- **usability**: User interfaces must comply with ISO 9241 standards
- **可用性**: 系统用户界面必须适合有特殊需求的用户
- **标准合规**: 用户界面应符合ISO 9241标准
- **合规**: 系统用户界面必须符合ISO 9241标准
- **Scalability**: System must scale for small and large police stations
- **Architecture**: Service Oriented Architecture (SOA) with modular design
- **Accessibility**: UI must be suitable for users with special needs

## 业务流程

### CaseRegistration

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. Register complaint
2. Assign case number
3. Notify police officer

### CaseInvestigation

参与角色: A_POLICE_OFFICER

1. Review case details
2. Gather evidence
3. Identify suspects
4. Update case status

### 起诉流程

参与角色: A_POLICE_OFFICER

1. 案件调查
2. 准备起诉材料
3. 提交法院
4. 记录法院反馈

### 搜索流程

参与角色: A_POLICE_OFFICER, A_ADMIN

1. 输入搜索条件
2. 执行搜索
3. 查看结果
4. 选择案件查看详情

### 界面定制流程

参与角色: A_CITIZEN, A_ADMIN

1. 用户登录系统
2. 访问界面设置
3. 调整界面元素
4. 保存配置

### 审计跟踪导出流程

参与角色: A_AUDITOR

1. 选择案件
2. 请求导出审计跟踪
3. 系统生成审计报告
4. 下载审计报告

### 用户权限管理流程

参与角色: A_ADMIN

1. 管理员登录
2. 选择用户
3. 设置权限
4. 保存配置

### CaseProsecution

参与角色: A_POLICE_OFFICER

1. PrepareCharges
2. FileWithCourt
3. TrackCourtDates
4. UpdateCaseStatus

### DefectTracking

参与角色: A_CITIZEN, A_HELP_DESK

1. LogDefect
2. AssignPriority
3. Investigate
4. Resolve
5. NotifyUser
