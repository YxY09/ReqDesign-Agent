# 医院门诊管理系统需求

## 项目概述

设计一个面向三甲医院的门诊管理信息系统，覆盖患者挂号、医生排班、电子病历、处方管理、收费结算、药品库存等核心业务。系统需支持日均 5000+ 门诊量，保证医疗数据安全合规（符合 HIPAA 等隐私保护要求）。

## 用户角色

### 1. 患者
- 在线预约挂号、查看排队叫号、查看检查报告、在线缴费、评价就诊体验

### 2. 医生
- 查看患者信息、书写电子病历、开具处方、开具检查单、查看排班

### 3. 护士
- 患者分诊导诊、采集生命体征、执行医嘱、输液管理

### 4. 收费员
- 挂号收费、处方收费、退费处理、日结对账

### 5. 药房人员
- 药品入库、处方审核发药、库存盘点、药品预警

### 6. 系统管理员
- 用户权限管理、系统配置、数据备份、审计日志

## 功能需求

### F001: 患者注册与档案
- 身份证号注册，建立健康档案（过敏史、既往病史、家族病史）
- 支持医保卡绑定
- 就诊卡管理（挂失、补办）

### F002: 在线预约挂号
- 按科室/医生/日期查询号源
- 选择就诊时段（上午/下午，精确到 30 分钟）
- 号源限制（每位医生每日限号 50 个）
- 取消预约（就诊前 2 小时可取消）
- 支持当日挂号（余号实时更新）

### F003: 医生排班管理
- 科室主任设置排班规则（轮班、固定班、替班）
- 排班冲突检测（同一医生不可同时排两个科室）
- 支持临时调班申请（需审批）
- 排班表按周/月视图展示

### F004: 排队叫号
- 患者签到后自动进入队列
- 按预约时间 + 签到时间排序
- 大屏显示当前叫号、等待人数
- 支持过号重排（自动排到当前号后第 3 位）

### F005: 电子病历
- 医生书写主诉、现病史、体格检查、诊断、治疗方案
- 支持 ICD-10 编码诊断
- 处方关联（中药/西药/检查单）
- 病历模板（按科室预设常用模板）
- 病历修改留痕（修改原因、修改时间、修改人）

### F006: 处方管理
- 西药处方（药品、剂量、用法、频次、天数）
- 中药处方（药材、剂量、煎法、服法）
- 处方审核规则（配伍禁忌、过敏检查、用量上限）
- 处方状态流转（开立 → 审核 → 收费 → 发药）
- 退药流程（已发药需医生确认后退回）

### F007: 检查检验
- 开具检查单（血常规、CT、MRI、B超等）
- 检查预约和排队
- 报告录入和审核
- 患者查看报告（异常值标红提示）

### F008: 收费结算
- 挂号费、诊查费、检查费、药品费分项计算
- 医保结算（自动识别医保范围、计算自付比例）
- 自费结算（微信/支付宝/现金/银行卡）
- 退费流程（部分退费、全额退费，需审批）
- 日结对账（收费员交班时汇总）

### F009: 药品库存管理
- 药品信息管理（名称、规格、厂家、批号、有效期）
- 入库管理（采购入库、退货出库）
- 库存预警（低于安全库存自动生成采购建议）
- 近效期药品预警（有效期 < 3 个月）
- 药品盘点（实盘与系统库存差异报告）

### F010: 数据统计与报表
- 门诊量统计（按科室/医生/时段）
- 处方统计（药品使用频率、抗生素使用率）
- 收入统计（日/周/月收入，医保/自费占比）
- 患者满意度分析

### F011: 消息通知
- 就诊提醒（挂号成功、就诊前 1 天、叫号提醒）
- 报告通知（检查报告出结果后推送）
- 缴费提醒（待缴费项目通知）

### F012: 系统管理
- RBAC 权限管理（医生不可查看收费明细、收费员不可修改病历）
- 操作日志审计（关键操作全程留痕）
- 数据备份（每日增量 + 每周全量）
- 数据脱敏（患者敏感信息加密存储）

## 业务实体

### 患者（Patient）
- patientId, idCard, name, gender, birthDate, phone, address, allergies, medicalHistory, insuranceNo, createdAt

### 医生（Doctor）
- doctorId, name, title, department, specialty, licenseNo, schedule, createdAt

### 排班（Schedule）
- scheduleId, doctorId, department, date, timeSlot, maxPatients, bookedCount, status

### 挂号记录（Registration）
- regId, patientId, doctorId, scheduleId, regTime, regType, fee, status, queueNo

### 病历（MedicalRecord）
- recordId, regId, doctorId, chiefComplaint, presentIllness, physicalExam, diagnosis(ICD-10), treatmentPlan, createdAt

### 处方（Prescription）
- prescriptionId, recordId, type(西药/中药), status, totalPrice, doctorId, pharmacistId, createdAt

### 处方项（PrescriptionItem）
- itemId, prescriptionId, drugId, dosage, frequency, route, days, quantity, price

### 药品（Drug）
- drugId, name, spec, manufacturer, category, unit, price, stock, safetyStock, expiryDate

### 检查单（ExamOrder）
- orderId, recordId, examType, examName, status, result, reportDoctorId, appointmentTime, completedTime

### 收费记录（Payment）
- paymentId, regId, items(JSON), totalAmount, insuranceAmount, selfPayAmount, payMethod, status, operatorId, createdAt

## 业务约束

- C001: 挂号约束 - 每位医生每日限号 50，同一患者同日同科限挂 1 次
- C002: 处方约束 - 单张处方药品种类不超过 5 种，抗生素需主任医师审核
- C003: 药品约束 - 过期药品不可发出，库存不足不可开方，麻醉药品需双签
- C004: 退费约束 - 已发药品不可退费（特殊审批除外），检查已做不可退费
- C005: 排班约束 - 医生每周工作不超过 5 天，连续夜班不超过 3 天

## 异常流程

- E001: 挂号并发冲突 - 多人抢同一号源，需保证不超发
- E002: 药品配伍禁忌 - 开方时检测到禁忌组合，弹窗警告并阻止提交
- E003: 过敏检测 - 患者对某药品过敏，开方时自动拦截提醒
- E004: 检查设备故障 - 预约的检查设备临时故障，自动改约并通知患者
- E005: 收费系统故障 - 缓存交易记录，故障恢复后批量同步
