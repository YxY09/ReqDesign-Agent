# 需求分析说明

## 项目名称
PoliceCaseManagementSystem

## 项目概述
警务案件管理系统，用于案件注册、调查、起诉和搜索，提高警务工作效率和信息安全性

## 角色

| 角色名称 | 描述 |
|----------|------|
| Admin | System administrator with full access rights |
| PoliceOfficer | Police personnel using the system for case management |
| Citizen | Public user reporting cases or accessing public data |
| HelpDesk | Support staff handling system issues and enhancement requests |
| RecordsStaff | Personnel managing case records and documentation |
| ExternalAuditor | Authorized external personnel who audit system activities |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_CUSTOMIZE_UI | CustomizeUI | Customize user interface elements and layouts | A_POLICE_OFFICER, A_ADMIN | low |
| FUN_EXPORT_AUDIT | ExportAudit | Export audit trail data for external review | A_EXTERNAL_AUDITOR, A_ADMIN | medium |
| FUN_INVESTIGATE_CASE | InvestigateCase | Conduct investigation on registered cases | A_POLICE_OFFICER | high |
| FUN_MANAGE_ACCESS | ManageAccess | Configure user access rights to cases | A_ADMIN | high |
| FUN_MANAGE_CONFIG | ManageConfig | Manage system configuration settings | A_ADMIN | medium |
| FUN_PROSECUTE_CASE | ProsecuteCase | Prepare and manage case prosecution | A_POLICE_OFFICER | high |
| FUN_REGISTER_CASE | RegisterCase | Register new police cases in the system | A_CITIZEN, A_POLICE_OFFICER | high |
| FUN_SEARCH_CASE | SearchCase | Search for cases based on various criteria | A_POLICE_OFFICER, A_ADMIN | high |
| FUN_TRACK_DEFECT | TrackDefect | Log and track application defects or enhancement requests | A_HELP_DESK, A_CITIZEN | medium |
| FUN_VIEW_REPORTS | ViewReports | Generate and view system reports | A_POLICE_OFFICER, A_ADMIN | medium |

## 核心实体

### Case
Police case record containing investigation details
属性: caseId: String - Unique identifier for the case, title: String - Brief description of the case, description: String - 案件描述, status: String - Current status of the case, createdAt: DateTime - 创建时间, updatedAt: DateTime - 更新时间, accessControl: Object - 访问控制设置, createdDate: DateTime - Date and time when case was registered, lastAccessed: DateTime - Date and time when case was last accessed

### Suspect
Individual suspected of involvement in a case
属性: suspectId: String - Unique identifier for the suspect, name: String - Full name of the suspect, description: String - Physical description and other details, status: String - 嫌疑人状态

### Property
Physical property or evidence related to a case
属性: propertyId: String - Unique identifier for the property, name: String - 财产名称, description: String - Description of the property, status: String - Current status of the property (evidence, returned, etc.)

### AuditTrail
Record of system activities and access for auditing purposes
属性: auditId: String - Unique identifier for the audit entry, action: String - Description of the action performed, userId: String - User who performed the action, timestamp: DateTime - Date and time when action occurred, details: String - 操作详情

### UserProfile
User account information and preferences
属性: profileId: String - 配置文件唯一标识, userId: String - Unique identifier for the user, uiConfig: Object - 用户界面配置, defaults: Object - 数据输入默认值, uiSettings: Object - User interface preferences, defaultValues: Object - Persistent data entry defaults, languagePreference: String - Selected interface language, name: String - User's full name, role: String - User's role in the system, uiPreferences: Object - User interface customization settings

### AccessControl
Permissions and security attributes for users and groups
属性: controlId: String - Unique identifier for the access control entry, userId: String - 关联的用户, groupId: String - Group identifier, securityAttributes: Object - 安全属性, securityLevel: String - User access privilege level, assignedGroups: List - Groups user belongs to, casePermissions: Object - Case-specific access rights, resourceType: String - Type of resource being controlled (case, report, etc.), permissionLevel: String - Level of access granted, permissions: List - Access permissions list

### Defect
Reported application issue or enhancement request
属性: defectId: String - Unique identifier for the defect, description: String - Detailed description of the issue, status: String - Current status of the defect, category: String - Classification of defect, createdAt: DateTime - 创建时间, reportedDate: DateTime - When issue was logged, priority: String - Priority level for resolution

### Navigation
System navigation structure and user paths
属性: navId: String - Unique identifier for the navigation element, structure: Object - 导航结构, customization: Object - 用户自定义设置, landingPageConfig: Object - Role-specific dashboard setup, recentCases: List - Quick access to frequently used cases, pendingTasks: List - Outstanding action items, path: String - Navigation path or route, label: String - Display label for the navigation element, menuItems: List - Navigation menu items

### Configuration
System configuration settings and parameters
属性: configId: String - Unique identifier for the configuration, name: String - Name of the configuration parameter, value: String - Current value of the parameter, description: String - 配置描述, settings: Object - Configuration values

## 业务约束

- **CON_FUNC_2Q4KED00**: 系统必须在20秒内检索并显示最近2个月内未访问过的案件
- **CON_FUNC_5DRLUE00**: 系统必须在5-8秒内检索并显示最近2个月内访问过的案件
- **CON_FUNC_91KEYV00**: 系统必须可扩展，不得有任何阻止在小或大型警察局使用的特性
- **CON_FUNC_93KA5400**: 系统必须能够同时显示多个实体（案件、嫌疑人）
- **CON_FUNC_ADMIN_USERS_SET_PROFILES_NARL**: Only admin-users can set up profiles and allocate users to groups
- **CON_FUNC_ALLOW_GUI_CUSTOMIZATION_D1SJ**: Allow GUI customization
- **CON_FUNC_ALLOW_PERSISTENT_DATA_ENTRY_RKX7**: Allow persistent data entry defaults
- **CON_FUNC_ALLOW_SOFT_DELETES_7K6L**: Only allow soft deletes
- **CON_FUNC_ALLOW_USERS_MULTIPLE_GROUPS_C4Y4**: Allow users in multiple groups
- **CON_FUNC_APPLY_DATABASE_INDEXES_SEARCH_HZ5A**: Apply database indexes on search columns
- **CON_FUNC_COMPATIBLE_SPECIAL_NEEDS_SOFTWARE_CPE6**: UI compatible with special needs software
- **CON_FUNC_CONSIDER_AGGRESSIVE_PAGE_LOADING_ELXB**: Consider aggressive page loading
- **CON_FUNC_DEPLOY_TIER_ARCHITECTURE_FTPL**: Deploy in 3-tier architecture
- **CON_FUNC_DESIGN_CENTRALIZED_DEPLOYMENT_PMRB**: Design for centralized deployment
- **CON_FUNC_DESIGN_FREQUENT_TRANSACTIONS_MINIMAL_N936**: Design frequent transactions for minimal interactions
- **CON_FUNC_DESIGN_INTUITIVE_USER_INTERFACES_MPXA**: Design intuitive user interfaces
- **CON_FUNC_DEVELOP_OPEN_STANDARDS_5DHB**: Develop on open standards
- **CON_FUNC_DISPLAY_RECORDS_BATCHES_PAGES_NV2O**: Display records in batches/pages
- **CON_FUNC_ENCODE_INCOMING_DATA_YJLG**: Encode incoming data
- **CON_FUNC_FETCH_DISPLAYED_FIELDS_INITIALLY_UTML**: Only fetch displayed fields initially
- **CON_FUNC_FETCH_SEARCH_RESULTS_BATCHES_EJTB**: Fetch search results in batches
- **CON_FUNC_G4HK8D00**: 系统必须在用户选择时发送警报（如电子邮件、短信）当对警报采取任何行动时
- **CON_FUNC_H9BRE900**: 系统必须仅允许超级用户更改组或用户的安全属性
- **CON_FUNC_HOST_STATIC_CONTENT_WEB_Z0UE**: Host static content on web server
- **CON_FUNC_INTERFACES_CUSTOMIZABLE_SAVE_CONFIGURATIONS_X5VR**: Interfaces must be customizable and save configurations in user profile
- **CON_FUNC_JV8JG600**: 系统必须使帮助台用户能够查看按类别、状态和年龄分类的缺陷或增强请求报告
- **CON_FUNC_LEVERAGE_ASYNCHRONOUS_HTTP_SOCKETS_P5LD**: Leverage asynchronous HTTP sockets
- **CON_FUNC_M14V3300**: 系统应能够按工作站和网络地址提供案件操作报告
- **CON_FUNC_MWG37C00**: 系统设计应确保在设备或通信网络故障时不会丢失操作数据
- **CON_FUNC_OFFLINE_MODE_MAINTAIN_DATA_9PBA**: Offline mode must maintain data consistency with central system when reconnected
- **CON_FUNC_OHMHAZ00**: 系统必须能够按案件、用户和时间顺序提供案件操作报告
- **CON_FUNC_PREVENT_CROSS_SITE_SCRIPTING_9KJT**: Prevent cross-site scripting
- **CON_FUNC_PREVENT_SQL_INJECTION_A5J8**: Prevent SQL injection
- **CON_FUNC_PROVIDE_INTUITIVE_USER_FUNCTIONS_W0ZV**: Provide intuitive user functions
- **CON_FUNC_PROVIDE_MEANINGFUL_ERROR_MESSAGES_LSX4**: Provide meaningful error messages
- **CON_FUNC_RUN_MULTIPLE_BROWSERS_DJZO**: Run on multiple browsers
- **CON_FUNC_SANITIZE_USER_INPUTS_U3IO**: Sanitize user inputs
- **CON_FUNC_SSL_M8DA**: 系统应确保通过网络安全传输数据，使用SSL和双向数字签名
- **CON_FUNC_SUPPORT_SECURE_VPN_CONNECTIONS_TLTS**: Support secure VPN connections
- **CON_FUNC_SUPPORT_SOLUTION_ACCESSIBLE_INSIDE_MLIV**: Support solution accessible inside/outside application
- **CON_FUNC_SYSTEM_ALLOW_USERS_TRACK_BSA8**: System must allow users to track submitted defects/enhancements
- **CON_FUNC_SYSTEM_EMPLOY_SINGLE_SET_EY26**: System must employ single set of UI rules for consistent look and feel
- **CON_FUNC_SYSTEM_IMPLEMENTED_USING_SOA_LMI1**: System should be implemented using SOA and modular design
- **CON_FUNC_SYSTEM_MAINTAIN_CASE_PROPERTY_8YNW**: System must maintain case-property relationship integrity when properties are used as evidence
- **CON_FUNC_SYSTEM_PERFORM_SIMPLE_SEARCH_KB95**: System must perform simple search in 5-8 seconds, advanced in 10-15
- **CON_FUNC_SYSTEM_PROVIDE_DETAILED_CONTEXT_PB66**: System must provide detailed context-sensitive help material
- **CON_FUNC_SYSTEM_PROVIDE_INTERFACE_LOGGING_SK7I**: System must provide interface for logging defects/enhancements
- **CON_FUNC_SYSTEM_PROVIDE_ROLE_BASED_CJDR**: System must provide role-based control for functionality
- **CON_FUNC_SYSTEM_TIER_ARCHITECTURE_SEPARATED_T83E**: System should have n-tier architecture with separated layers
- **CON_FUNC_USE_AJAX_IMPROVE_T6WU**: Use AJAX to improve UX
- **CON_FUNC_USE_CACHE_FREQUENT_DATA_1W52**: Use cache for frequent data
- **CON_FUNC_USE_HIERARCHICAL_CACHE_FREQUENT_Q89R**: Use hierarchical cache for frequent searches
- **CON_FUNC_USE_HTTPS_COMMUNICATION_RQDR**: Use HTTPS for communication
- **CON_FUNC_USE_PARAMETERIZED_QUERIES_9HRR**: Use parameterized queries
- **CON_FUNC_USE_STANDARDIZED_FORMATS_METADATA_FN4F**: Use standardized formats and metadata
- **CON_FUNC_USER_INTERFACE_CUSTOMIZATIONS_PRESERVED_D5ZG**: User interface customizations must be preserved during system updates
- **CON_FUNC_VALIDATE_DATA_CLIENT_SERVER_B6CM**: Validate data at client and server
- **CON_FUNC_VALIDATE_INCOMING_DATA_FL0Y**: Validate incoming data
- **CON_FUNC_YKC06500**: 系统必须对无权访问的案件请求提供可配置的响应
- **CON_PERF_PROVIDE_ADEQUATE_RESPONSE_TIMES_XT87**: Provide adequate response times
- **CON_PERF_SUPPORT_LOW_BANDWIDTH_PERFORMANCE_IMM8**: Support low-bandwidth performance
- **CON_SEC_5MOQ5000**: 系统应支持选择性加密存储数据
- **CON_SEC_ALLOW_USERS_SPECIFY_ACCESS_7J48**: Allow users to specify access rights
- **CON_SEC_ENSURE_AUDIT_TRAIL_ACCESSIBLE_JNLJ**: Ensure audit trail accessible to external personnel
- **CON_SEC_GI7HZG00**: 审计跟踪功能激活后，系统必须自动跟踪事件并存储相关信息
- **CON_SEC_LOG_ACCESS_CONTROL_VIOLATIONS_4BA7**: Log access control violations
- **CON_SEC_MOBILE_ACCESS_ENFORCE_SECURITY_XCXG**: Mobile access must enforce the same security controls as desktop access
- **CON_SEC_MULTILINGUAL_SUPPORT_EXTEND_CASE_QWCP**: Multilingual support must extend to all case metadata and audit trail entries
- **CON_SEC_N13AAU00**: 系统必须维护审计跟踪至少与相关案件的寿命一样长
- **CON_SEC_NNPEE800**: 系统应建立在通用用户访问和认证服务上，确保终端用户单点登录
- **CON_SEC_SEARCH_RESULTS_EXCLUDE_UNAUTHORIZED_IGF5**: Search results must exclude unauthorized records
- **CON_SEC_SUPPORT_ACCESS_VIA_MOBILE_OZEA**: Support access via mobile devices
- **CON_SEC_SUPPORT_BROWSER_BASED_ACCESS_8QE7**: Support browser-based access with minimal client requirements
- **CON_SEC_SUPPORT_MULTI_TIER_AUTHENTICATION_KV1B**: Support multi-tier authentication
- **CON_SEC_SUPPORT_MULTIPLE_REMOTE_ACCESS_59O6**: Support multiple remote access types
- **CON_SEC_SUPPORT_PUBLIC_ACCESS_SUBSET_3X1V**: Support public access to subset of data
- **CON_SEC_SUPPORT_SSL_ENCRYPTED_CONNECTIONS_3QN0**: Support SSL encrypted connections
- **CON_SEC_SYSTEM_ABLE_EXPORT_AUDIT_FCJ7**: System must be able to export audit trails for specified cases
- **CON_SEC_SYSTEM_ALLOW_LIMITING_CASE_NHJ8**: System must allow limiting case access to specific users/groups
- **CON_SEC_SYSTEM_MAINTAIN_UNALTERABLE_AUDIT_7WR0**: System must maintain unalterable audit trail
- **CON_SEC_UV9Z5100**: 系统必须将未经授权的案件访问尝试记录到审计跟踪中
- **CON_SEC_VU16BY00**: 系统必须将所有案件访问和相关活动存储在审计跟踪中
- **CON_USAB_USER_INTERFACES_COMPLY_ISO_TDR9**: User interfaces must comply with ISO 9241 standard

## 异常流程

- **EXC_85Q1U900**: 案件不存在 (触发: 尝试访问不存在的案件, 处理: 显示错误消息并记录到审计跟踪)
- **EXC_UIHVWC00**: 审计跟踪功能未激活 (触发: 尝试导出审计跟踪但功能未激活, 处理: 显示错误消息并提示激活审计功能)
- **EXC_D5KK5Z00**: 搜索超时 (触发: 搜索操作超过规定时间, 处理: 终止搜索并显示超时错误)
- **EXC_QBBURV00**: 用户未登录 (触发: 尝试执行需要登录的操作, 处理: 重定向到登录页面)
- **EXC_UDDJFZ00**: 用户无权访问案件 (触发: 用户尝试访问没有权限的案件, 处理: 根据配置显示不同级别的响应（显示标题和元数据/仅显示存在/完全不显示）)
- **EXC_AUDIT_EXPORT_FAILURE**: Audit export failure (触发: Error during audit trail export, 处理: Notify administrator and preserve original audit data)
- **EXC_AUDIT_TRAIL_EXPORT_FAILURE**: Audit trail export failure (触发: Error during audit trail export process, 处理: Log error and notify administrator)
- **EXC_CASE_FOUND**: Case not found (触发: Requested case does not exist, 处理: Show meaningful error message)
- **EXC_CASE_REGISTRATION_FAILS_DUE**: Case registration fails due to missing mandatory property evidence (触发: When registering case without linking required property evidence, 处理: System should prevent submission and highlight missing evidence requirements)
- **EXC_CASE_RETRIEVAL_TIMEOUT**: Case retrieval timeout (触发: Case retrieval exceeds performance thresholds, 处理: Notify user and suggest alternative actions)
- **EXC_DEFECT_SUBMISSION_ERROR**: Defect submission error (触发: Required fields missing in defect report, 处理: Show meaningful error message with guidance)
- **EXC_DEFECT_TRACKING_SYSTEM_UNAVAILABLE**: Defect tracking system unavailable (触发: Defect tracking subsystem is offline, 处理: Queue requests and process when system is available)
- **EXC_MOBILE_DEVICE_FAILS_AUTHENTICATION**: Mobile device fails authentication during critical operation (触发: When network drops during mobile authentication process, 处理: Preserve operation data locally and require re-authentication when connection resumes)
- **EXC_MULTILINGUAL_CONTENT_UNAVAILABLE_SPECIFIC**: Multilingual content unavailable for specific case metadata (触发: When viewing case details in unsupported language, 处理: Fallback to primary language with visual indication of untranslated content)
- **EXC_OFFLINE_MODIFICATIONS_CONFLICT_CENTRAL**: Offline modifications conflict with central system updates (触发: When synchronizing offline changes that conflict with central updates, 处理: Present conflict resolution interface to investigator with audit trail of both versions)
- **EXC_SEARCH_TIMEOUT**: Search timeout (触发: Search takes longer than allowed time, 处理: Show timeout message and suggest refining search)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT_CASE**: Unauthorized access attempt to case (触发: User attempts to access case without proper permissions, 处理: Log attempt in audit trail and display configured response)
- **EXC_UNAUTHORIZED_CASE_ACCESS_ATTEMPT**: Unauthorized case access attempt (触发: User tries to access restricted case, 处理: Log violation and show configured response)
- **EXC_UNAUTHORIZED_CASE_ACCESS_ATTEMPT_2**: Unauthorized case access attempt (触发: User attempts to access case without permission, 处理: Log attempt in audit trail and show configured response)
- **EXC_USER_INTERFACE_CUSTOMIZATION_DATA**: User interface customization data corruption (触发: When loading corrupted UI customization preferences, 处理: Revert to default interface with notification and option to restore last valid configuration)

## 非功能需求

- **性能**: 系统必须在5-8秒内执行简单搜索，在10-15秒内执行高级搜索
- **安全**: 系统必须保持不可更改的审计跟踪
- **可用性**: 系统用户界面必须适合有特殊需求的用户
- **可扩展性**: 系统必须可扩展，不得有任何阻止在小或大型警察局使用的特性
- **Usability**: UI complies with ISO 9241 accessibility standards
- **Auditability**: System must maintain complete and unalterable audit trails
- **Accessibility**: System must comply with accessibility standards and guidelines

## 业务流程

### 案件注册流程

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. 公民提交投诉
2. 警务人员审核
3. 生成案件记录
4. 通知相关人员

### 案件调查流程

参与角色: A_POLICE_OFFICER

1. 分配调查人员
2. 收集证据
3. 记录调查结果
4. 更新案件状态

### 案件起诉流程

参与角色: A_POLICE_OFFICER

1. 准备起诉材料
2. 提交法院
3. 记录法院反馈
4. 更新案件状态

### 案件搜索流程

参与角色: A_POLICE_OFFICER, A_ADMIN

1. 输入搜索条件
2. 执行搜索
3. 过滤结果
4. 显示匹配案件

### 缺陷跟踪流程

参与角色: A_CITIZEN, A_HELP_DESK

1. 用户提交缺陷
2. 帮助台分类
3. 分配处理人员
4. 更新状态
5. 通知用户

### DefectReporting

参与角色: A_CITIZEN, A_HELP_DESK

1. User identifies issue
2. Submit defect report
3. Help desk categorizes
4. Track resolution status
5. Notify user of updates

### AuditInspection

参与角色: A_ADMIN, A_EXTERNAL_AUDITOR

1. Select cases for audit
2. Generate audit report
3. Export trail data
4. Analyze system activity

### CaseRegistration

参与角色: A_POLICE_OFFICER, A_CITIZEN

1. Enter case details
2. Verify information
3. Submit case
4. Generate case number

### CaseInvestigation

参与角色: A_POLICE_OFFICER

1. Review case details
2. Collect evidence
3. Interview witnesses
4. Update case status

### AuditReview

参与角色: A_EXTERNAL_AUDITOR, A_ADMIN

1. Select audit criteria
2. Generate report
3. Review activities
4. Export findings

### DefectManagement

参与角色: HelpDesk

1. LogDefect
2. AssignPriority
3. TrackResolution
