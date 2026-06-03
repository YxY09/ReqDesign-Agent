# 需求分析说明

## 项目名称
CCTNS

## 项目概述
CCTNS V1.0 is a police case management system focusing on crime investigation and criminal detection, providing value to police personnel and citizens.

## 角色

| 角色名称 | 描述 |
|----------|------|
| Admin | Administrator with privileges to manage user profiles and system configurations |
| PoliceOfficer | Law enforcement personnel who investigate and manage cases |
| Citizen | Public user who may report cases or access limited case information |
| HelpDesk | Support staff who handle defect reports and enhancement requests |
| Auditor | External personnel who review system activity and audit trails |
| RecordsStaff | Staff responsible for maintaining case records |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_CONFIGURE_ACCESS | ConfigureAccess | Configure case access permissions | A_ADMIN | high |
| FUN_EXPORT_AUDIT_TRAIL | ExportAuditTrail | Export audit trails for specified cases | A_AUDITOR, A_ADMIN | medium |
| FUN_GENERATE_REPORT | GenerateReport | Generate reports on defects or cases | Admin, Auditor | medium |
| FUN_INVESTIGATE_CASE | InvestigateCase | Police initiates investigation process after complaint registration | A_POLICE_OFFICER | high |
| FUN_LOG_DEFECT | LogDefect | Log system defects or enhancement requests | A_CITIZEN, A_POLICE_OFFICER | medium |
| FUN_MANAGE_USER_PROFILE | ManageUserProfile | Manage user profiles and configurations | A_ADMIN | high |
| FUN_PROSECUTE_CASE | ProsecuteCase | Initiate prosecution for a case | PoliceOfficer | high |
| FUN_REGISTER_CASE | RegisterCase | Citizens can register complaints with police | A_CITIZEN, A_POLICE_OFFICER | high |
| FUN_SEARCH_CASE | SearchCase | Search for cases based on various criteria | A_POLICE_OFFICER, A_ADMIN | high |
| FUN_TRACK_DEFECT | TrackDefect | Track submitted defects or enhancement requests | A_CITIZEN, A_HELP_DESK | medium |

## 核心实体

### Case
Police case record
属性: caseId: String - Unique identifier for the case, status: String - Current status of the case, createdDate: DateTime - Date when case was registered, lastAccessed: DateTime - Date and time when case was last accessed, title: String - Title of the case, description: String - Detailed description of the case, createdAt: DateTime - Date and time when case was created

### Suspect
Person suspected in a case
属性: suspectId: String - Unique identifier for the suspect, name: String - Full name of suspect, status: String - Current status in investigation, description: String - Description of the suspect

### Property
Property involved in a case
属性: propertyId: String - Unique identifier for the property, description: String - Description of the property, value: Decimal - Estimated value of the property, status: String - Current status of the property

### AuditTrail
Record of system activities
属性: eventId: String - Unique identifier for the event, eventType: String - Type of event (create/read/update/delete), timestamp: DateTime - Date and time of the action, userId: String - User who performed the action, auditId: String - Unique identifier for the audit record, action: String - Action performed (create/read/update/delete), entityType: String - Type of entity affected, entityId: String - Identifier of affected entity, details: String - Additional details about the action

### UserProfile
User profile and access configuration
属性: userId: String - Unique identifier for the user, role: String - User role (admin, police, etc), uiPreferences: Object - User interface customization settings, preferences: Object - User interface preferences, username: String - User login name, groups: List - Groups the user belongs to, name: String - Name of the user, groupMemberships: List - Groups the user belongs to

### Defect
System defect or enhancement request
属性: defectId: String - Unique identifier for the defect, description: String - Description of the defect, status: String - Current status of the defect, priority: String - Priority level of the defect, createdAt: DateTime - 创建时间, title: String - Defect title, reportedBy: String - User who reported the defect, reportedAt: DateTime - Date and time when defect was reported, category: String - Category of the defect

### Document
Document or file related to a case
属性: documentId: String - Unique identifier for the document, type: String - Type of the document, content: Object - Document content or reference, title: String - Document title, createdAt: DateTime - When the document was created, name: String - Name of the document, size: Long - Size of the document in bytes, uploadedAt: DateTime - Date and time when document was uploaded

## 业务约束

- **CON_FUNC_ADMINS_SET_USER_PROFILES_PZCG**: Only admins can set up user profiles
- **CON_FUNC_DESIGN_PREVENT_DATA_LOSS_MSQB**: Design to prevent data loss in case of failure
- **CON_FUNC_ENSURE_SECURE_DATA_TRANSMISSION_4TZ8**: Ensure secure data transmission with SSL and 2-way digital signatures
- **CON_FUNC_HARD_DELETES_SOFT_DELETES_U9VL**: No hard deletes, only soft deletes
- **CON_FUNC_IMPLEMENT_USING_SOA_MODULAR_9NDO**: Implement using SOA and modular design
- **CON_FUNC_PERFORM_ADVANCED_SEARCH_WITHIN_M632**: Perform advanced search within 10-15 seconds
- **CON_FUNC_PREVENT_CROSS_SITE_SCRIPTING_4CYU**: Prevent cross-site scripting
- **CON_FUNC_PREVENT_SQL_INJECTION_9BDL**: Prevent SQL injection
- **CON_FUNC_PROVIDE_CONTEXT_SENSITIVE_HELP_5S58**: Provide context-sensitive help for all UI actions
- **CON_FUNC_PROVIDE_INTERFACE_LOGGING_DEFECTS_AMXC**: Provide interface for logging defects
- **CON_FUNC_RETRIEVE_DISPLAY_RECENTLY_ACCESSED_12RX**: Retrieve and display not recently accessed cases within 20 seconds
- **CON_FUNC_RETRIEVE_DISPLAY_RECENTLY_ACCESSED_41WP**: Retrieve and display recently accessed cases within 5-8 seconds
- **CON_FUNC_RUN_MULTIPLE_BROWSERS_DJZO**: Run on multiple browsers
- **CON_FUNC_SUPPORT_MULTILINGUAL_INTERFACE_HD4F**: Support multilingual interface
- **CON_FUNC_SUPPORT_SECURE_VPN_CONNECTIONS_TLTS**: Support secure VPN connections
- **CON_FUNC_SYSTEM_ALLOW_USERS_CUSTOMIZE_FJON**: The system must allow users to customize the user interface, including menu contents, layout of screens, use of function keys, on-screen colours, fonts and font sizes.
- **CON_FUNC_SYSTEM_ENSURE_TEXT_RESIZABLE_EVO7**: The system must ensure that text is resizable by the user, using functions provided by the user agent or other appropriate means.
- **CON_FUNC_SYSTEM_PROVIDE_REPORTS_ACTIONS_J9NF**: The system must provide reports for actions on cases organized by workstation and (where technically appropriate) by network address.
- **CON_FUNC_SYSTEM_PROVIDE_SITE_MAP_W3N2**: The system must provide a site map showing the structure of the site in an overview form.
- **CON_FUNC_SYSTEM_SCALABLE_5TAK**: System must be scalable
- **CON_FUNC_SYSTEM_SEND_ALERTS_EMAIL_OKAY**: The system must send alerts (e.g., email, SMS) to the user if the user chooses to whenever any action has been taken on the alert.
- **CON_FUNC_USE_HTTPS_COMMUNICATION_PROTOCOL_H3TO**: Use HTTPS as communication protocol
- **CON_FUNC_VALIDATE_DATA_CLIENT_SERVER_B6CM**: Validate data at client and server
- **CON_FUNC_WORK_OFFLINE_MODE_CRITICAL_R4ZT**: Work in offline mode with critical functionality
- **CON_PERF_DESIGN_SATISFACTORY_PERFORMANCE_LOW_SF44**: Design for satisfactory performance on low-bandwidth
- **CON_SEC_ALLOW_LIMITING_CASE_ACCESS_O7KY**: Allow limiting case access to specified users/groups
- **CON_SEC_BUILD_COMMON_USER_ACCESS_ANXR**: Build on common User Access and Authentication Service
- **CON_SEC_DESIGN_BROWSER_BASED_ACCESS_SW9Y**: Design for browser-based access with minimal client requirements
- **CON_SEC_SUPPORT_MULTI_TIER_AUTHENTICATION_KV1B**: Support multi-tier authentication
- **CON_SEC_SUPPORT_MULTIPLE_TYPES_COMMUNICATION_3PU1**: Support multiple types of communication services for remote access
- **CON_SEC_SUPPORT_SELECTIVE_ENCRYPTION_STORED_1PAV**: Support selective encryption of stored data
- **CON_SEC_SUPPORT_SSL_ENCRYPTED_CONNECTIONS_3QN0**: Support SSL encrypted connections
- **CON_SEC_SYSTEM_MAINTAIN_UNALTERABLE_AUDIT_7WR0**: System must maintain unalterable audit trail
- **CON_SEC_TRACK_EVENTS_AUTOMATICALLY_AUDIT_2MH9**: Track events automatically in audit trail

## 异常流程

- **EXC_IUOTOB00**: 用户尝试访问无权限的案件 (触发: 用户请求访问或搜索无权访问的案件, 处理: 根据配置提供不同级别的响应：显示标题和元数据/仅显示案件存在/不显示任何信息)
- **EXC_CASE_FOUND**: Case not found (触发: Search returns no results, 处理: Inform user and suggest alternative search criteria)
- **EXC_CASE_FOUND_2**: Case not found (触发: User tries to access a non-existent case, 处理: Show error message)
- **EXC_CASE_FOUND_SEARCH**: Case not found in search (触发: User searches for a case that doesn't exist or they can't access, 处理: Return appropriate message without revealing existence of restricted cases)
- **EXC_INVALID_SEARCH_CRITERIA**: Invalid search criteria (触发: User provides invalid search parameters, 处理: Show validation errors)
- **EXC_OFFLINE_MODE_LIMITATIONS**: Offline mode limitations (触发: System is operating in offline mode, 处理: Provide limited functionality with appropriate warnings)
- **EXC_SYSTEM_FAILS_RESIZE_TEXT**: System fails to resize text as requested by the user. (触发: The user agent does not support text resizing or the system encounters an error., 处理: Display a message indicating that text resizing is not supported and provide alternative options (e.g., zooming the entire page).)
- **EXC_SYSTEM_FAILS_SEND_ALERT**: System fails to send an alert when an action is taken on a defect. (触发: The system encounters an error while trying to send an alert (e.g., email server down)., 处理: Log the error in the audit trail and retry sending the alert at a later time. Notify the system administrator if the issue persists.)
- **EXC_SYSTEM_OFFLINE**: System offline (触发: Network connection lost, 处理: Continue operation in offline mode with limited functionality)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT**: Unauthorized access attempt (触发: User tries to access case without proper rights, 处理: Log attempt in audit trail, show appropriate error message)
- **EXC_UNAUTHORIZED_ACCESS_ATTEMPT_CASE**: Unauthorized access attempt to case (触发: User attempts to access a case they don't have rights to, 处理: Log in audit trail and provide appropriate response based on configuration)
- **EXC_UNAUTHORIZED_CASE_ACCESS_ATTEMPT**: Unauthorized case access attempt (触发: User tries to access a case they don't have permission for, 处理: Log in audit trail and show appropriate message)
- **EXC_USER_ATTEMPTS_ACCESS_CASE**: User attempts to access a case that is not assigned to them. (触发: User tries to access a case they do not have permission to view., 处理: Log the attempt in the audit trail and display a message indicating that access is denied.)
- **EXC_USER_ATTEMPTS_CUSTOMIZE_BEYOND**: User attempts to customize UI beyond allowed parameters. (触发: User tries to modify UI elements that are not configurable., 处理: Display an error message indicating which elements cannot be modified and provide a list of configurable options.)
- **EXC_USER_ATTEMPTS_GENERATE_REPORT**: User attempts to generate a report with invalid parameters. (触发: User provides invalid or conflicting parameters for report generation., 处理: Display an error message with a list of valid parameters and examples of correct usage.)

## 非功能需求

- **performance**: System must provide adequate response times under standard and peak conditions
- **security**: System must prevent SQL injection and cross-site scripting
- **availability**: System must be available during specified hours with minimal downtime
- **usability**: User interfaces must comply with ISO 9241 standards
- **scalability**: System must work in small and large police stations
- **安全性**: 系统必须记录用户尝试访问无权限案件的行为
- **Reliability**: Operational data must not be lost in case of equipment or communication network failure

## 业务流程

### CaseRegistration

参与角色: A_CITIZEN, A_POLICE_OFFICER

1. Citizen submits complaint
2. Police officer reviews complaint
3. Case is registered in system
4. Confirmation is sent to citizen

### CaseInvestigation

参与角色: A_POLICE_OFFICER

1. Police officer accesses case
2. Evidence is collected
3. Suspects are identified
4. Case status is updated
5. Findings are recorded

### 案件起诉流程

参与角色: PoliceOfficer

1. 记录法庭交互
2. 更新案件状态
3. 跟踪起诉进度

### 案件搜索流程

参与角色: PoliceOfficer

1. 输入搜索条件
2. 执行搜索
3. 查看结果
4. 自定义结果视图

### 缺陷管理流程

参与角色: A_CITIZEN, A_POLICE_OFFICER, A_HELP_DESK

1. 记录缺陷
2. 跟踪缺陷状态
3. 解决缺陷

### 用户配置流程

参与角色: A_ADMIN

1. 管理员创建用户配置文件
2. 分配用户到组
3. 设置访问权限

### DefectHandling

参与角色: Citizen, HelpDesk

1. LogDefect
2. AssignDefect
3. InvestigateDefect
4. ResolveDefect

### CaseRegistrationProcess

参与角色: A_POLICE_OFFICER

1. RegisterCase
2. AssignCase
3. InitiateInvestigation

### CaseInvestigationProcess

参与角色: A_POLICE_OFFICER

1. ReviewCase
2. GatherEvidence
3. InterviewWitnesses
4. IdentifySuspects

### DefectManagementProcess

参与角色: A_HELP_DESK

1. LogDefect
2. AssignDefect
3. ResolveDefect
4. NotifyUser

### AuditReviewProcess

参与角色: A_AUDITOR

1. ExportAuditTrail
2. AnalyzeAuditData
3. GenerateAuditReport
