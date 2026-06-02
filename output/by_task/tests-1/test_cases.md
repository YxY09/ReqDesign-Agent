```json
{
  "ops": [
    {
      "action": "append",
      "path": "test_cases",
      "items": [
        {
          "id": "TC-F001-001",
          "title": "CustomizeUI - 保存界面配置",
          "type": "正常",
          "target": "F001",
          "preconditions": "用户已登录",
          "steps": [
            "修改屏幕布局",
            "调整配色方案",
            "保存配置到用户配置文件"
          ],
          "expected_result": "界面配置保存成功且立即生效",
          "priority": "P1"
        },
        {
          "id": "TC-F001-002",
          "title": "CustomizeUI - 会话间配置保留",
          "type": "边界",
          "target": "F001",
          "preconditions": "用户已保存UI配置",
          "steps": [
            "注销后重新登录"
          ],
          "expected_result": "自定义配置保留不变",
          "priority": "P1"
        },
        {
          "id": "TC-F002-001",
          "title": "ExportAudit - 审计数据导出",
          "type": "正常",
          "target": "F002",
          "preconditions": "审计功能已激活，管理员已登录",
          "steps": [
            "选择审计数据范围",
            "生成审计报告",
            "下载审计跟踪数据"
          ],
          "expected_result": "审计数据完整导出且格式标准化",
          "priority": "P1"
        },
        {
          "id": "TC-F002-002",
          "title": "ExportAudit - 审计数据完整性验证",
          "type": "边界",
          "target": "F002",
          "preconditions": "存在审计数据",
          "steps": [
            "尝试修改导出的审计数据"
          ],
          "expected_result": "原始审计数据保持未更改",
          "priority": "P0"
        },
        {
          "id": "TC-F003-001",
          "title": "InvestigateCase - 案件调查记录",
          "type": "正常",
          "target": "F003",
          "preconditions": "案件状态为'新案件'，调查人员已登录",
          "steps": [
            "添加调查记录",
            "关联证据到案件",
            "更新调查状态"
          ],
          "expected_result": "案件调查记录完整且状态更新",
          "priority": "P0"
        },
        {
          "id": "TC-F003-002",
          "title": "InvestigateCase - 案件调查权限验证",
          "type": "异常",
          "target": "F003",
          "preconditions": "用户无调查权限",
          "steps": [
            "尝试访问案件调查功能"
          ],
          "expected_result": "阻止访问并记录安全事件",
          "priority": "P1"
        },
        {
          "id": "TC-F004-001",
          "title": "ManageAccess - 用户权限设置",
          "type": "正常",
          "target": "F004",
          "preconditions": "管理员已登录",
          "steps": [
            "设置用户/组权限",
            "配置访问违规响应"
          ],
          "expected_result": "访问权限正确设置且安全属性更新记录",
          "priority": "P0"
        },
        {
          "id": "TC-F004-002",
          "title": "ManageAccess - 权限变更审计",
          "type": "边界",
          "target": "F004",
          "preconditions": "存在权限变更记录",
          "steps": [
            "查看访问违规日志"
          ],
          "expected_result": "权限变更和违规尝试被正确记录",
          "priority": "P1"
        },
        {
          "id": "TC-F007-001",
          "title": "RegisterCase - 案件注册",
          "type": "正常",
          "target": "F007",
          "preconditions": "警务人员已登录",
          "steps": [
            "填写案件信息",
            "提交案件注册"
          ],
          "expected_result": "案件成功注册且状态为'新案件'",
          "priority": "P0"
        },
        {
          "id": "TC-F007-002",
          "title": "RegisterCase - 必填字段验证",
          "type": "异常",
          "target": "F007",
          "preconditions": "警务人员已登录",
          "steps": [
            "尝试提交缺少必填字段的案件"
          ],
          "expected_result": "阻止提交并高亮缺失字段",
          "priority": "P0"
        },
        {
          "id": "TC-F008-001",
          "title": "SearchCase - 案件搜索",
          "type": "正常",
          "target": "F008",
          "preconditions": "用户已登录",
          "steps": [
            "输入搜索条件",
            "执行案件搜索"
          ],
          "expected_result": "返回符合搜索条件的案件列表",
          "priority": "P0"
        },
        {
          "id": "TC-F008-002",
          "title": "SearchCase - 搜索权限验证",
          "type": "边界",
          "target": "F008",
          "preconditions": "存在受限案件",
          "steps": [
            "使用不同权限账户搜索案件"
          ],
          "expected_result": "搜索结果符合用户权限级别",
          "priority": "P1"
        },
        {
          "id": "TC-F009-001",
          "title": "TrackDefect - 缺陷提交",
          "type": "正常",
          "target": "F009",
          "preconditions": "用户已登录",
          "steps": [
            "填写缺陷报告",
            "提交缺陷"
          ],
          "expected_result": "缺陷成功提交且状态更新",
          "priority": "P1"
        },
        {
          "id": "TC-F009-002",
          "title": "TrackDefect - 缺陷状态跟踪",
          "type": "边界",
          "target": "F009",
          "preconditions": "存在已提交缺陷",
          "steps": [
            "更新缺陷状态"
          ],
          "expected_result": "缺陷状态正确更新且记录变更历史",
          "priority": "P1"
        },
        {
          "id": "TC-EXC-001",
          "title": "EXC_AUDIT_EXPORT_FAILURE - 审计导出失败处理",
          "type": "异常",
          "target": "EXC_AUDIT_EXPORT_FAILURE",
          "preconditions": "审计功能已激活",
          "steps": [
            "模拟审计导出失败场景"
          ],
          "expected_result": "显示有意义的错误信息并记录失败事件",
          "priority": "P1"
        },
        {
          "id": "TC-EXC-002",
          "title": "EXC_CASE_REGISTRATION_FAILS_DUE - 案件注册失败处理",
          "type": "异常",
          "target": "EXC_CASE_REGISTRATION_FAILS_DUE",
          "preconditions": "警务人员已登录",
          "steps": [
            "模拟案件注册失败场景"
          ],
          "expected_result": "显示失败原因并提供恢复指导",
          "priority": "P1"
        },
        {
          "id": "TC-EXC-003",
          "title": "EXC_DEFECT_TRACKING_SYSTEM_UNAVAILABLE - 缺陷系统不可用处理",
          "type": "异常",
          "target": "EXC_DEFECT_TRACKING_SYSTEM_UNAVAILABLE",
          "preconditions": "用户已登录",
          "steps": [
            "模拟缺陷系统不可用场景"
          ],
          "expected_result": "显示系统维护信息并记录故障",
          "priority": "P1"
        },
        {
          "id": "TC-EXC-004",
          "title": "EXC_SEARCH_TIMEOUT - 搜索超时处理",
          "type": "异常",
          "target": "EXC_SEARCH_TIMEOUT",
          "preconditions": "系统中有大量案件数据",
          "steps": [
            "执行复杂搜索触发超时"
          ],
          "expected_result": "显示超时提示并提供简化搜索建议",
          "priority": "P1"
        },
        {
          "id": "TC-CON-020",
          "title": "CON_FUNC_ALLOW_GUI_CUSTOMIZATION_D1SJ - GUI自定义验证",
          "type": "边界",
          "target": "CON_FUNC_ALLOW_GUI_CUSTOMIZATION_D1SJ",
          "preconditions": "用户已登录",
          "steps": [
            "尝试自定义GUI元素"
          ],
          "expected_result": "允许GUI自定义且不影响其他用户",
          "priority": "P1"
        },
        {
          "id": "TC-CON-021",
          "title": "CON_FUNC_SANITIZE_USER_INPUTS_U3IO - 输入清理验证",
          "type": "边界",
          "target": "CON_FUNC_SANITIZE_USER_INPUTS_U3IO",
          "preconditions": "系统运行中",
          "steps": [
            "输入包含潜在危险字符的内容"
          ],
          "expected_result": "输入被正确清理且无害化",
          "priority": "P0"
        },
        {
          "id": "TC-CON-022",
          "title": "CON_SEC_LOG_ACCESS_CONTROL_VIOLATIONS_4BA7 - 访问违规日志验证",
          "type": "边界",
          "target": "CON_SEC_LOG_ACCESS_CONTROL_VIOLATIONS_4BA7",
          "preconditions": "存在受限资源",
          "steps": [
            "尝试未经授权访问受限资源"
          ],
          "expected_result": "访问被阻止且违规尝试被记录",
          "priority": "P0"
        },
        {
          "id": "TC-CON-023",
          "title": "CON_SEC_SUPPORT_SSL_ENCRYPTED_CONNECTIONS_3QN0 - SSL连接验证",
          "type": "边界",
          "target": "CON_SEC_SUPPORT_SSL_ENCRYPTED_CONNECTIONS_3QN0",
          "preconditions": "系统配置为强制SSL",
          "steps": [
            "尝试通过非加密连接访问敏感数据"
          ],
          "expected_result": "连接被拒绝或重定向到安全连接",
          "priority": "P0"
        },
        {
          "id": "TC-CON-024",
          "title": "CON_FUNC_USE_PARAMETERIZED_QUERIES_9HRR - 参数化查询验证",
          "type": "边界",
          "target": "CON_FUNC_USE_PARAMETERIZED_QUERIES_9HRR",
          "preconditions": "系统运行中",
          "steps": [
            "尝试通过输入进行SQL注入"
          ],
          "expected_result": "注入尝试被阻止且查询安全执行",
          "priority": "P0"
        }
      ]
    }
  ]
}
```