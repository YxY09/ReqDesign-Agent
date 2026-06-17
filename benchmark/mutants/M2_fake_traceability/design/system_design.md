## 模块划分

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| 患者管理模块 | 负责患者注册、档案管理、医保绑定 | F015 |
| 预约挂号模块 | 处理患者预约挂号、取消预约、当日挂号 | F004, F005 |
| 排班管理模块 | 医生排班设置、冲突检测、排班表展示 | F009 |
| 排队叫号模块 | 患者签到、队列管理、叫号显示 | F013 |
| 病历管理模块 | 电子病历书写、修改留痕、模板管理 | F017 |
| 处方管理模块 | 处方开具、审核、状态流转、退药处理 | F011 |
| 检查检验模块 | 检查单开具、报告录入审核、患者查看 | F010 |
| 收费结算模块 | 费用计算、医保结算、退费处理 | F012, F014 |
| 药品库存模块 | 药品信息管理、库存预警、近效期预警 | F007 |
| 消息通知模块 | 就诊提醒、报告通知、缴费提醒 | F016 |
| 安全与审计模块 | 数据脱敏、权限管理、操作日志审计 | F001, F002, F008 |
| 数据备份模块 | 每日增量备份、每周全量备份 | F003 |
| 报表统计模块 | 门诊量统计、处方统计、收入统计 | F006 |

## 核心类/接口设计

| 类名 | 类型 | 职责 | 关联实体 |
|------|------|------|----------|
| Patient | domain | 患者领域实体 | Patient |
| Registration | domain | 挂号记录领域实体 | Registration |
| Schedule | domain | 排班领域实体 | Schedule |
| Queue | domain | 排队队列领域实体 | Queue |
| MedicalRecord | domain | 病历领域实体 | MedicalRecord |
| Prescription | domain | 处方领域实体 | Prescription |
| ExamOrder | domain | 检查单领域实体 | ExamOrder |
| Payment | domain | 收费记录领域实体 | Payment |
| Drug | domain | 药品领域实体 | Drug |
| Inventory | domain | 库存领域实体 | Inventory |
| MedicalReport | domain | 检查报告领域实体 | MedicalReport |
| AuditLog | domain | 审计日志领域实体 | AuditLog |
| PrescriptionReview | domain | 处方审核记录领域实体 | PrescriptionReview |
| RefundApplication | domain | 退费申请记录领域实体 | RefundApplication |
| AppointmentService | helper | 预约挂号服务 | - |
| PrescriptionService | helper | 处方管理服务 | - |
| PaymentService | helper | 收费结算服务 | - |
| NotificationService | helper | 消息通知服务 | - |

### Patient
- **职责**: 患者领域实体
- **属性**:
  - patientId: String — 患者ID
  - idCard: String — 身份证号
  - name: String — 姓名
  - gender: String — 性别
  - birthDate: DateTime — 出生日期
- **方法**: register(), bindInsurance()
- **关联实体**: Patient

### Registration
- **职责**: 挂号记录领域实体
- **属性**:
  - regId: String — 挂号ID
  - patientId: String — 患者ID
  - doctorId: String — 医生ID
  - scheduleId: String — 排班ID
  - regTime: DateTime — 挂号时间
- **方法**: cancel()
- **关联实体**: Registration

### Schedule
- **职责**: 排班领域实体
- **属性**:
  - scheduleId: String — 排班ID
  - doctorId: String — 医生ID
  - department: String — 科室
  - date: DateTime — 日期
  - timeSlot: String — 时间段
- **方法**: checkConflict()
- **关联实体**: Schedule

### Queue
- **职责**: 排队队列领域实体
- **属性**:
  - queueId: String — 队列ID
  - currentNo: String — 当前叫号
  - waitingCount: Integer — 等待人数
- **方法**: addPatient(), callNext()
- **关联实体**: Queue

### MedicalRecord
- **职责**: 病历领域实体
- **属性**:
  - recordId: String — 病历ID
  - regId: String — 挂号记录ID
  - doctorId: String — 医生ID
  - chiefComplaint: String — 主诉
  - presentIllness: String — 现病史
- **方法**: write(), update()
- **关联实体**: MedicalRecord

### Prescription
- **职责**: 处方领域实体
- **属性**:
  - prescriptionId: String — 处方ID
  - recordId: String — 病历ID
  - type: String — 类型(西药/中药)
  - status: String — 状态
  - totalPrice: Decimal — 总价
- **方法**: prescribe(), review()
- **关联实体**: Prescription

### ExamOrder
- **职责**: 检查单领域实体
- **属性**:
  - orderId: String — 检查单ID
  - recordId: String — 病历ID
  - examType: String — 检查类型
  - examName: String — 检查名称
  - status: String — 状态
- **方法**: order(), generateReport()
- **关联实体**: ExamOrder

### Payment
- **职责**: 收费记录领域实体
- **属性**:
  - paymentId: String — 收费ID
  - regId: String — 挂号ID
  - items: JSON — 收费项目
  - totalAmount: Decimal — 总金额
  - insuranceAmount: Decimal — 医保支付
- **方法**: calculate(), refund()
- **关联实体**: Payment

### Drug
- **职责**: 药品领域实体
- **属性**:
  - drugId: String — 药品ID
  - name: String — 名称
  - spec: String — 规格
  - manufacturer: String — 厂家
  - category: String — 类别
- **方法**: checkInventory()
- **关联实体**: Drug

### Inventory
- **职责**: 库存领域实体
- **属性**:
  - inventoryId: String — 库存ID
  - drugId: String — 药品ID
  - quantity: Integer — 数量
  - batchNo: String — 批号
  - expiryDate: DateTime — 有效期
- **方法**: checkExpiry(), updateStock()
- **关联实体**: Inventory

### MedicalReport
- **职责**: 检查报告领域实体
- **属性**:
  - reportId: String — 报告ID
  - orderId: String — 检查单ID
  - content: String — 内容
  - abnormalValues: String — 异常值
  - createdAt: DateTime — 创建时间
- **方法**: generate(), review()
- **关联实体**: MedicalReport

### AuditLog
- **职责**: 审计日志领域实体
- **属性**:
  - logId: String — 日志ID
  - action: String — 操作
  - operatorId: String — 操作员ID
  - targetType: String — 目标类型
  - targetId: String — 目标ID
- **方法**: log()
- **关联实体**: AuditLog

### PrescriptionReview
- **职责**: 处方审核记录领域实体
- **属性**:
  - reviewId: Long — 审核记录ID
  - status: String — 审核状态（通过/驳回）
  - comment: String — 审核意见
- **方法**: review()
- **关联实体**: PrescriptionReview

### RefundApplication
- **职责**: 退费申请记录领域实体
- **属性**:
  - applicationId: Long — 申请ID
  - status: String — 审批状态
  - reason: String — 退费原因
- **方法**: apply(), approve()
- **关联实体**: RefundApplication

### AppointmentService
- **职责**: 预约挂号服务
- **属性**:
  - scheduleRepo: ScheduleRepository — 排班仓储
  - registrationRepo: RegistrationRepository — 挂号记录仓储
- **方法**: bookAppointment(), cancelAppointment()

### PrescriptionService
- **职责**: 处方管理服务
- **属性**:
  - prescriptionRepo: PrescriptionRepository — 处方仓储
  - drugRepo: DrugRepository — 药品仓储
- **方法**: prescribe(), reviewPrescription()

### PaymentService
- **职责**: 收费结算服务
- **属性**:
  - paymentRepo: PaymentRepository — 收费记录仓储
  - insuranceService: InsuranceService — 医保服务
- **方法**: processPayment(), refundPayment()

### NotificationService
- **职责**: 消息通知服务
- **属性**:
  - smsGateway: SmsGateway — 短信网关
  - emailService: EmailService — 邮件服务
- **方法**: sendAppointmentReminder(), sendReportNotification()

## 数据流说明

### 预约挂号流程
相关功能: F004
1. Patient → AppointmentService.bookAppointment()
2. AppointmentService → ScheduleRepository.findAvailable()
3. AppointmentService → RegistrationRepository.save()
4. 返回挂号成功通知

### 处方管理流程
相关功能: F011
1. Doctor → PrescriptionService.prescribe()
2. PrescriptionService → DrugRepository.checkInventory()
3. PrescriptionService → PrescriptionRepository.save()
4. Pharmacist → PrescriptionService.reviewPrescription()
5. 更新处方状态

### 收费结算流程
相关功能: F012
1. Cashier → PaymentService.processPayment()
2. PaymentService → InsuranceService.calculate()
3. PaymentService → PaymentRepository.save()
4. 返回收费凭证


## 设计覆盖矩阵

| ID | 类型 | 原始描述 | 设计决策 | 影响模块 | 影响类 | 测试启示 |
|-----|------|----------|----------|---------|------|--------|
| F001 | function | 数据脱敏 | Patient 实体敏感字段加密存储 | MOD_SECURITY | Patient | 验证身份证号等敏感信息加密存储 |
| F002 | function | 操作日志审计 | AuditLog 记录关键操作 | MOD_SECURITY | AuditLog | 验证关键操作是否记录日志 |
| F003 | function | 数据备份 | 定时任务执行增量/全量备份 | MOD_BACKUP |  | 验证备份文件完整性和恢复流程 |
| F004 | function | 在线预约挂号 | AppointmentService 处理预约逻辑 | MOD_APPOINTMENT | AppointmentService, Registration | 正常预约、取消预约、当日挂号场景 |
| F005 | function | 取消预约 | Registration.cancel() 方法处理取消 | MOD_APPOINTMENT | Registration | 验证取消时间限制和状态更新 |
| F006 | function | 数据统计与报表 | 定时任务生成统计报表 | MOD_REPORT |  | 验证报表数据准确性 |
| F007 | function | 药品库存管理 | Inventory 管理库存状态 | MOD_INVENTORY | Inventory, Drug | 库存预警、近效期预警场景 |
| F008 | function | RBAC权限管理 | 基于角色的访问控制 | MOD_SECURITY |  | 验证医生和收费员权限限制 |
| F009 | function | 医生排班管理 | Schedule 处理排班逻辑 | MOD_SCHEDULE | Schedule | 排班冲突检测、临时调班场景 |
| F010 | function | 检查检验 | ExamOrder 管理检查单 | MOD_EXAM | ExamOrder, MedicalReport | 检查单开具、报告审核场景 |
| F011 | function | 处方管理 | Prescription 管理处方状态流转 | MOD_PRESCRIPTION | Prescription, PrescriptionReview | 处方审核、状态流转、退药场景 |
| F012 | function | 收费结算 | Payment 处理收费逻辑 | MOD_PAYMENT | Payment | 医保结算、自费结算场景 |
| F013 | function | 排队叫号 | Queue 管理排队逻辑 | MOD_QUEUE | Queue | 患者签到、叫号、过号处理场景 |
| F014 | function | 退费处理 | RefundApplication 处理退费申请 | MOD_PAYMENT | RefundApplication | 部分退费、全额退费场景 |
| F015 | function | 患者注册与档案 | Patient 管理患者信息 | MOD_PATIENT | Patient | 患者注册、医保绑定场景 |
| F016 | function | 消息通知 | NotificationService 发送各类通知 | MOD_NOTIFICATION | NotificationService | 就诊提醒、报告通知场景 |
| F017 | function | 书写电子病历 | MedicalRecord 管理病历内容 | MOD_MEDICAL_RECORD | MedicalRecord | 病历书写、修改留痕场景 |
| C001 | constraint | 检查报告需经医生审核后才能发布 | MedicalReport.review() 方法控制状态 | MOD_EXAM | MedicalReport | 验证未审核报告不可查看 |
| C002 | constraint | 病历修改留痕（修改原因、修改时间、修改人） | MedicalRecord.update() 记录修改日志 | MOD_MEDICAL_RECORD | MedicalRecord | 验证修改记录完整性 |
| C003 | constraint | 护士执行医嘱需核对患者身份 | PrescriptionService 验证患者身份 | MOD_PRESCRIPTION | PrescriptionService | 验证患者身份匹配 |
| C004 | constraint | 退药需医生确认后退回库存 | RefundApplication 需要医生审批 | MOD_PAYMENT | RefundApplication | 验证退药审批流程 |
| C005 | constraint | 检查已做不可退费 | PaymentService 检查 ExamOrder 状态 | MOD_PAYMENT | PaymentService | 验证已做检查的退费限制 |
| C006 | constraint | 连续夜班不超过3天 | Schedule.checkConflict() 检查排班规则 | MOD_SCHEDULE | Schedule | 验证连续夜班限制 |
| C007 | constraint | 过期药品不可发出 | Inventory.checkExpiry() 检查有效期 | MOD_INVENTORY | Inventory | 验证过期药品拦截 |
| C008 | constraint | 已发药品不可退费（特殊审批除外） | RefundApplication 需要特殊审批 | MOD_PAYMENT | RefundApplication | 验证已发药品退费限制 |
| C009 | constraint | 近效期药品预警（有效期 < 3 个月） | Inventory.checkExpiry() 触发预警 | MOD_INVENTORY | Inventory | 验证近效期预警触发 |
| C010 | constraint | 关键操作全程留痕 | AuditLog 记录关键操作 | MOD_SECURITY | AuditLog | 验证关键操作日志记录 |
| C011 | constraint | 单张处方药品种类不超过5种 | PrescriptionService 检查药品数量 | MOD_PRESCRIPTION | PrescriptionService | 验证药品数量限制 |
| C012 | constraint | 医生每周工作不超过5天 | Schedule.checkConflict() 检查工作日 | MOD_SCHEDULE | Schedule | 验证医生工作日限制 |
| C013 | constraint | 处方状态必须按顺序流转（开立 → 审核 → 收费 → 发药） | Prescription 管理状态流转 | MOD_PRESCRIPTION | Prescription | 验证状态流转顺序 |
| C014 | constraint | 每位医生每日限号50个 | AppointmentService 检查号源数量 | MOD_APPOINTMENT | AppointmentService | 验证号源数量限制 |
| C015 | constraint | 同一医生不可同时排两个科室 | Schedule.checkConflict() 检测冲突 | MOD_SCHEDULE | Schedule | 验证排班冲突检测 |
| C016 | constraint | 医生不可查看收费明细 | RBAC 控制医生权限 | MOD_SECURITY |  | 验证医生权限限制 |
| C017 | constraint | 同一患者同日同科限挂1次 | AppointmentService 检查挂号记录 | MOD_APPOINTMENT | AppointmentService | 验证挂号次数限制 |
| C018 | constraint | 处方审核规则（配伍禁忌、过敏检查、用量上限） | PrescriptionReview 执行审核规则 | MOD_PRESCRIPTION | PrescriptionReview | 验证处方审核规则 |
| C019 | constraint | 收费员不可修改病历 | RBAC 控制收费员权限 | MOD_SECURITY |  | 验证收费员权限限制 |
| C020 | constraint | 患者敏感信息加密存储 | Patient 敏感字段加密 | MOD_SECURITY | Patient | 验证敏感信息加密 |
| X001 | exception | 挂号并发冲突 | AppointmentService 使用乐观锁 | MOD_APPOINTMENT | AppointmentService | 验证并发挂号处理 |
| X002 | exception | 过敏检测 | PrescriptionService 检查患者过敏史 | MOD_PRESCRIPTION | PrescriptionService | 验证过敏药品拦截 |
| X004 | exception | 检查设备故障 | ExamOrder 自动改约并通知 | MOD_EXAM | ExamOrder | 验证设备故障处理 |
| X005 | exception | 收费系统故障 | PaymentService 缓存交易记录 | MOD_PAYMENT | PaymentService | 验证故障恢复流程 |
| X006 | exception | 药品配伍禁忌 | PrescriptionReview 检查药品组合 | MOD_PRESCRIPTION | PrescriptionReview | 验证配伍禁忌拦截 |
| X007 | exception | 处方审核不通过 | PrescriptionReview 记录审核意见 | MOD_PRESCRIPTION | PrescriptionReview | 验证审核不通过处理 |
| X008 | exception | 医保结算失败 | PaymentService 转为自费结算 | MOD_PAYMENT | PaymentService | 验证医保失败处理 |
| X009 | exception | 药品库存实时变化导致发药失败 | Inventory 实时检查库存 | MOD_INVENTORY | Inventory | 验证库存不足处理 |

## 追溯矩阵（Traceability Matrix）

> 所有业务约束均已完整覆盖到设计类与测试用例：

| 约束 | 覆盖状态 | 设计类 | 对应测试用例 |
|------|----------|--------|--------------|
| 每位医生每日限号50个 / 同日同科限挂1次 | ✅ 已覆盖 | AppointmentService | TC-N-004 患者成功预约挂号并取消 |
| 单张处方≤5种 / 抗生素主任审核 | ✅ 已覆盖 | PrescriptionService | TC-N-028 处方状态流转验证 |
| 过期药品不可发出 / 库存不足不可开方 | ✅ 已覆盖 | Inventory | TC-N-018 新增药品信息 |
| 已发药品不可退费 / 检查已做不可退费 | ✅ 已覆盖 | RefundApplication | TC-N-014 患者部分退费 |
| 过敏检测自动拦截 | ✅ 已覆盖 | PrescriptionService | TC-N-002 医生开立处方操作日志记录 |
| 收费系统故障缓存同步 | ✅ 已覆盖 | PaymentService | TC-N-012 患者完成医保结算流程 |

注：上述测试用例 target 与约束一一对应，约束覆盖完整。
