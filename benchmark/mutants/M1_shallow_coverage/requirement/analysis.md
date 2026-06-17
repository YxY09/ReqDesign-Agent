# 需求分析说明

## 项目名称
HospitalOutpatientSystem

## 项目概述
面向三甲医院的门诊管理信息系统，覆盖患者挂号、医生排班、电子病历、处方管理、收费结算、药品库存等核心业务

## 角色

| 角色名称 | 描述 |
|----------|------|
| Patient | 患者 |
| Doctor | 医生 |
| Nurse | 护士 |
| Cashier | 收费员 |
| Pharmacist | 药房人员 |
| Admin | 系统管理员 |

## 功能需求

| 编号 | 名称 | 描述 | 相关角色 | 优先级 |
|------|------|------|----------|--------|
| FUN_ANONYMIZE_DATA | AnonymizeData | 数据脱敏 | A_ADMIN | low |
| FUN_AUDIT_LOG | AuditLog | 操作日志审计 | A_ADMIN | low |
| FUN_BACKUP_DATA | BackupData | 数据备份 | A_ADMIN | low |
| FUN_BOOK_APPOINTMENT | BookAppointment | 在线预约挂号 | A_PATIENT | high |
| FUN_CANCEL_APPOINTMENT | CancelAppointment | 取消预约 | A_PATIENT | medium |
| FUN_GENERATE_REPORT | GenerateReport | 数据统计与报表 | A_ADMIN | low |
| FUN_MANAGE_INVENTORY | ManageInventory | 药品库存管理 | A_PHARMACIST | medium |
| FUN_MANAGE_PERMISSION | ManagePermission | RBAC权限管理 | A_ADMIN | medium |
| FUN_MANAGE_SCHEDULE | ManageSchedule | 医生排班管理 | A_DOCTOR, A_ADMIN | high |
| FUN_ORDER_EXAM | OrderExam | 检查检验 | A_DOCTOR | medium |
| FUN_PRESCRIBE_MEDICATION | PrescribeMedication | 处方管理 | A_DOCTOR, A_PHARMACIST | high |
| FUN_PROCESS_PAYMENT | ProcessPayment | 收费结算 | A_CASHIER | high |
| FUN_QUEUE_MANAGEMENT | QueueManagement | 排队叫号 | A_PATIENT, A_DOCTOR | high |
| FUN_REFUND_PAYMENT | RefundPayment | 退费处理 | A_CASHIER | medium |
| FUN_REGISTER_PATIENT | RegisterPatient | 患者注册与档案 | A_PATIENT | high |
| FUN_SEND_NOTIFICATION | SendNotification | 消息通知 | A_PATIENT | medium |
| FUN_WRITE_MEDICAL_RECORD | WriteMedicalRecord | 书写电子病历 | A_DOCTOR | high |

## 核心实体

### Patient
患者
属性: patientId: String - 患者ID, idCard: String - 身份证号, name: String - 姓名, gender: String - 性别, birthDate: DateTime - 出生日期, phone: String - 电话, address: String - 地址, allergies: String - 过敏史, medicalHistory: String - 既往病史, insuranceNo: String - 医保卡号, createdAt: DateTime - 创建时间

### Registration
挂号记录
属性: regId: String - 挂号ID, patientId: String - 患者ID, doctorId: String - 医生ID, scheduleId: String - 排班ID, regTime: DateTime - 挂号时间, regType: String - 挂号类型, fee: Decimal - 挂号费, status: String - 状态, queueNo: String - 排队号

### Queue
排队队列
属性: queueId: String - 队列ID, currentNo: String - 当前叫号, waitingCount: Integer - 等待人数

### Insurance
医保
属性: insuranceNo: String - 医保卡号, patientId: String - 患者ID, type: String - 医保类型, validFrom: DateTime - 有效期起, validTo: DateTime - 有效期止

### Doctor
医生
属性: doctorId: String - 医生ID, name: String - 姓名, title: String - 职称, department: String - 科室, specialty: String - 专业, licenseNo: String - 执业证号, schedule: Object - 排班信息, createdAt: DateTime - 创建时间

### Schedule
排班
属性: scheduleId: String - 排班ID, doctorId: String - 医生ID, department: String - 科室, date: DateTime - 日期, timeSlot: String - 时间段, maxPatients: Integer - 最大患者数, bookedCount: Integer - 已预约数, status: String - 状态

### MedicalRecord
病历
属性: recordId: String - 病历ID, regId: String - 挂号记录ID, doctorId: String - 医生ID, chiefComplaint: String - 主诉, presentIllness: String - 现病史, physicalExam: String - 体格检查, diagnosis: String - 诊断(ICD-10), treatmentPlan: String - 治疗方案, createdAt: DateTime - 创建时间

### Prescription
处方
属性: prescriptionId: String - 处方ID, recordId: String - 病历ID, type: String - 类型(西药/中药), status: String - 状态, totalPrice: Decimal - 总价, doctorId: String - 医生ID, pharmacistId: String - 药剂师ID, createdAt: DateTime - 创建时间

### PrescriptionItem
处方项
属性: itemId: String - 明细ID, prescriptionId: String - 处方ID, drugId: String - 药品ID, dosage: String - 剂量, frequency: String - 频次, route: String - 用法, days: Integer - 天数, quantity: Integer - 数量, price: Decimal - 单价

### ExamOrder
检查单
属性: orderId: String - 检查单ID, recordId: String - 病历ID, examType: String - 检查类型, examName: String - 检查名称, status: String - 状态, result: String - 结果, reportDoctorId: String - 报告医生ID, appointmentTime: DateTime - 预约时间, completedTime: DateTime - 完成时间

### Drug
药品
属性: drugId: String - 药品ID, name: String - 名称, spec: String - 规格, manufacturer: String - 厂家, category: String - 类别, unit: String - 单位, price: Decimal - 价格, stock: Integer - 库存, safetyStock: Integer - 安全库存, expiryDate: DateTime - 有效期

### Payment
收费记录
属性: paymentId: String - 收费ID, regId: String - 挂号ID, items: JSON - 收费项目, totalAmount: Decimal - 总金额, insuranceAmount: Decimal - 医保支付, selfPayAmount: Decimal - 自费金额, payMethod: String - 支付方式, status: String - 状态, operatorId: String - 操作员ID, createdAt: DateTime - 创建时间

### Inventory
库存
属性: inventoryId: String - 库存ID, drugId: String - 药品ID, quantity: Integer - 数量, batchNo: String - 批号, expiryDate: DateTime - 有效期, lastUpdated: DateTime - 最后更新时间

### MedicalReport
检查报告
属性: reportId: String - 报告ID, orderId: String - 检查单ID, content: String - 内容, abnormalValues: String - 异常值, createdAt: DateTime - 创建时间, reviewedAt: DateTime - 审核时间

### AuditLog
审计日志
属性: logId: String - 日志ID, action: String - 操作, operatorId: String - 操作员ID, targetType: String - 目标类型, targetId: String - 目标ID, timestamp: DateTime - 时间戳, details: String - 详情

### MedicalRecordItem
MedicalRecord中的处方明细行,记录数量和关联信息
属性: medicalRecordItemId: Long - MedicalRecordItem唯一标识, medicalRecordId: Long - 所属MedicalRecordID, prescriptionId: Long - PrescriptionID, quantity: Integer - 数量

### PrescriptionReview
处方审核记录
属性: reviewId: Long - 审核记录ID, status: String - 审核状态（通过/驳回）, comment: String - 审核意见

### RefundApplication
退费申请记录
属性: applicationId: Long - 申请ID, status: String - 审批状态, reason: String - 退费原因

## 业务约束

- **CON_FUNC_1XPI2A00**: 检查报告需经医生审核后才能发布
- **CON_FUNC_2BXAU800**: 病历修改留痕（修改原因、修改时间、修改人）
- **CON_FUNC_2O863600**: 护士执行医嘱需核对患者身份
- **CON_FUNC_6GG8FK00**: 退药需医生确认后退回库存
- **CON_FUNC_8AYEEO00**: 检查已做不可退费
- **CON_FUNC_8DR1ZU00**: 连续夜班不超过3天
- **CON_FUNC_ANAPF400**: 过期药品不可发出
- **CON_FUNC_DJ0G2K00**: 已发药品不可退费（特殊审批除外）
- **CON_FUNC_EFK8XS00**: 近效期药品预警（有效期 < 3 个月）
- **CON_FUNC_ESMQCU00**: 关键操作全程留痕
- **CON_FUNC_G7QA2J00**: 单张处方药品种类不超过5种
- **CON_FUNC_HOQSD200**: 医生每周工作不超过5天
- **CON_FUNC_NLK5YG00**: 处方状态必须按顺序流转（开立 → 审核 → 收费 → 发药）
- **CON_FUNC_OTGDRM00**: 每位医生每日限号50个
- **CON_FUNC_R2229A00**: 同一医生不可同时排两个科室
- **CON_FUNC_RWLWLQ00**: 医生不可查看收费明细
- **CON_FUNC_UU96SS00**: 同一患者同日同科限挂1次
- **CON_FUNC_V12RWY00**: 处方审核规则（配伍禁忌、过敏检查、用量上限）
- **CON_SEC_11R4W000**: 收费员不可修改病历
- **CON_SEC_278NRO00**: 患者敏感信息加密存储

## 异常流程

- **EXC_I55RS100**: 挂号并发冲突 (触发: 多人抢同一号源, 处理: 保证不超发)
- **EXC_IK6SC300**: 过敏检测 (触发: 患者对某药品过敏, 处理: 开方时自动拦截提醒)
- **EXC_JTEW0R00**: 检查设备故障 (触发: 预约的检查设备临时故障, 处理: 自动改约并通知患者)
- **EXC_KEZQTE00**: 收费系统故障 (触发: 收费系统故障, 处理: 缓存交易记录，故障恢复后批量同步)
- **EXC_EY2AKD00**: 药品配伍禁忌 (触发: 开方时检测到禁忌组合, 处理: 弹窗警告并阻止提交)
- **EXC_MFI8HE00**: 处方审核不通过 (触发: 药师审核发现配伍禁忌或超量, 处理: 退回修改并通知医生)
- **EXC_OGMI1200**: 医保结算失败 (触发: 医保系统连接超时或账户异常, 处理: 转为自费并提示患者后续报销)
- **EXC_BW46RT00**: 药品库存实时变化导致发药失败 (触发: 处方审核通过后库存不足, 处理: 通知医生更换药品并记录缺货)

## 非功能需求

- **性能**: 支持日均5000+门诊量
- **安全**: 符合HIPAA等隐私保护要求

## 业务流程

### 挂号流程

参与角色: A_PATIENT

1. 查询号源
2. 选择医生和时段
3. 提交挂号
4. 生成挂号记录
5. 进入排队队列

### 排队叫号流程

参与角色: A_PATIENT, A_DOCTOR

1. 患者签到
2. 系统分配队列位置
3. 大屏显示当前叫号
4. 医生叫号
5. 过号处理

### 医生排班流程

参与角色: A_DOCTOR, A_ADMIN

1. 设置排班规则
2. 排班冲突检测
3. 临时调班申请
4. 排班表展示

### 处方管理流程

参与角色: A_DOCTOR, A_PHARMACIST

1. 开具处方
2. 处方审核
3. 处方收费
4. 处方发药

### 就诊流程

参与角色: A_PATIENT, A_DOCTOR

1. 患者签到
2. 排队叫号
3. 医生接诊
4. 书写病历
5. 开具处方/检查单

### 收费流程

参与角色: A_CASHIER

1. 查询待缴费项目
2. 计算费用
3. 医保结算
4. 自费支付
5. 生成收费记录

### 发药流程

参与角色: A_PHARMACIST

1. 审核处方
2. 检查库存
3. 配药
4. 发药
5. 更新库存
