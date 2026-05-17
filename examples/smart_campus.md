# 智慧校园管理系统需求

## 项目概述

设计一个智慧校园综合管理平台，覆盖学生管理、课程选课、成绩管理、宿舍管理、校园卡充值消费等核心业务。系统需支持高并发选课场景（3000+ 并发），保证选课数据一致性，并提供完善的权限管理。

## 用户角色

### 1. 学生
- 注册登录、选课退课、查看成绩、校园卡充值、宿舍报修、查看课表
- 查看校园公告、提交请假申请、评价教师

### 2. 教师
- 发布课程信息、录入成绩、查看选课学生、发布作业通知
- 审批学生请假、查看教学评估

### 3. 宿管人员
- 宿舍分配管理、报修处理、访客登记、晚归检查

### 4. 财务人员
- 校园卡充值审核、消费流水查询、退款处理、财务报表

### 5. 系统管理员
- 用户权限管理、系统配置、日志审计、数据备份

## 功能需求

### F001: 用户注册登录
- 学号/工号 + 密码注册，支持统一身份认证（CAS）
- 密码登录、短信验证码登录
- 修改个人信息（头像、联系方式、紧急联系人）

### F002: 课程管理
- 教师创建课程（课程名、学分、容量、上课时间、教室）
- 课程审核（教务处审核后发布）
- 课程信息修改和取消

### F003: 选课系统
- 学生浏览可选课程，按学院/教师/时间筛选
- 抢选模式：先到先得，容量满自动关闭
- 每学期最多选 25 学分，同一时间段不可冲突
- 支持退课（开课后 2 周内）
- 选课结果实时显示已选/剩余名额

### F004: 成绩管理
- 教师录入平时成绩、期中成绩、期末成绩（按权重计算总分）
- 成绩发布后学生可查看（GPA 自动计算）
- 成绩申诉流程（学生提交 → 教师审核 → 教务处备案）
- 支持成绩导出（Excel/PDF）

### F005: 校园卡管理
- 校园卡充值（微信/支付宝/银行转账）
- 消费记录查询（食堂、超市、图书馆、打印）
- 挂失和解挂
- 消费限额设置（日消费上限）
- 充值退款申请

### F006: 宿舍管理
- 自动分配宿舍（按学院、性别、年级规则）
- 宿舍调换申请（需审批）
- 报修申请（水电、门窗、网络等分类）
- 报修进度查询和评价
- 访客登记和晚归记录

### F007: 请假系统
- 学生提交请假申请（事假/病假/公假）
- 上传证明材料（病假需医院证明）
- 辅导员/教师审批（多级审批）
- 请假记录查询和统计

### F008: 课表查询
- 学生查看个人课表（按周/月视图）
- 教师查看教学课表
- 空闲教室查询

### F009: 公告通知
- 教务处/学院发布通知（支持推送）
- 按接收对象分类（全体/学院/班级/个人）
- 通知已读未读状态

### F010: 教学评价
- 学生对课程和教师评分（匿名）
- 多维度评价（教学内容、教学方法、教学态度）
- 评价统计和汇总报告

### F011: 数据统计
- 选课统计（各课程选课人数、热门课程排行）
- 成绩统计（班级平均分、及格率、GPA 分布）
- 消费统计（校园卡消费趋势、分类占比）
- 报修统计（各类报修数量、处理时效）

### F012: 系统管理
- 角色权限管理（RBAC）
- 操作日志审计
- 数据备份和恢复
- 系统参数配置（学期时间、选课规则等）

## 业务实体

### 用户（User）
- userId, username, passwordHash, realName, phone, email, role, college, avatarUrl, createdAt

### 课程（Course）
- courseId, courseName, credit, capacity, enrolledCount, teacherId, classroom, schedule, status

### 选课记录（Enrollment）
- enrollmentId, studentId, courseId, semester, enrollTime, status, score, gradePoint

### 校园卡（CampusCard）
- cardId, userId, balance, dailyLimit, status, createdAt, lastTransactionAt

### 交易记录（Transaction）
- transactionId, cardId, amount, type(recharge/consume/refund), location, createdAt

### 宿舍（Dormitory）
- dormId, buildingNo, roomNo, capacity, currentCount, gender, college, status

### 报修单（RepairOrder）
- orderId, dormId, reporterId, category, description, images, status, handlerId, createdAt, completedAt

### 请假申请（LeaveRequest）
- requestId, studentId, type, startDate, endDate, reason, attachments, approverId, status, createdAt

### 公告（Announcement）
- announcementId, title, content, publisherId, targetScope, publishTime, status

### 教学评价（Evaluation）
- evaluationId, courseId, studentId, scores(JSON), comment, isAnonymous, createdAt

## 业务约束

- C001: 选课约束 - 每学期最多 25 学分，时间不可冲突，先到先得不可超额
- C002: 成绩约束 - 各项成绩 0-100 分，权重之和必须为 100%，GPA 按 4.0 制计算
- C003: 校园卡约束 - 日消费不超过限额（默认 200 元），余额不足时交易失败
- C004: 宿舍约束 - 4-6 人/间，按学院和性别分配，调换需审批
- C005: 请假约束 - 病假超 3 天需医院证明，事假超 5 天需院级审批

## 异常流程

- E001: 选课并发冲突 - 多人同时抢最后一门课名额，需加锁保证一人成功
- E002: 成绩录入超时 - 教师批量录入成绩时系统超时，需支持断点续录
- E003: 校园卡盗刷 - 异常消费模式检测（短时间内多地点消费），自动冻结
- E004: 宿舍报修超时 - 报修 72 小时未处理，自动升级告警通知宿管主管
- E005: 数据导入失败 - 批量导入学生/课程数据时格式错误，记录失败行号并继续
