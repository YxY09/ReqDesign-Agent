# 会议室预约系统设计方案

## 1. 系统概述
本系统旨在为公司提供一个高效、便捷的会议室资源管理与预约平台。其核心目标是实现会议室信息的透明化、预约流程的标准化与自动化，从而提升会议室资源利用率，减少员工预约冲突，并为管理层提供数据支持。

## 2. 系统分层架构
系统采用经典的三层架构，确保职责清晰、易于维护和扩展。

*   **表现层 (Presentation Layer)**
    *   **职责**：负责与用户进行交互，接收用户输入并展示处理结果。提供Web界面或API接口供前端应用（如Web页面、移动端App）调用。处理用户身份验证、会话管理及基本的输入校验。
*   **业务逻辑层 (Business Logic Layer)**
    *   **职责**：系统的核心，负责实现所有业务规则和流程。处理会议室预约、审批、取消等核心业务逻辑，执行约束校验（如时间冲突、审批规则），并协调各模块完成业务操作。
*   **数据访问层 (Data Access Layer)**
    *   **职责**：负责与数据库进行交互，提供数据的持久化存储和读取服务。封装对会议室、预约、用户等数据的增删改查操作，隔离业务逻辑与具体数据存储细节。

## 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| **会议室管理模块** | 负责会议室信息的增删改查，管理会议室设备信息，提供会议室状态查询服务。 | F001, F006, F007 |
| **预约管理模块** | 处理预约申请的创建、取消，执行预约冲突校验，管理预约状态（待审批、已批准、已取消等）。 | F002, F004 |
| **审批管理模块** | 实现预约申请的审批流程，根据规则（如会议室大小）决定是否需要审批，并处理审批动作。 | F003 |
| **用户与权限管理模块** | 管理用户账户、部门信息及角色权限，为其他模块提供用户身份和权限验证服务。 | F005 (支撑) |

## 4. 核心类/接口设计

| 类名 | 职责 | 关键属性 | 关键方法 | 关联的实体 |
|------|------|----------|----------|------------|
| **MeetingRoom** | 会议室实体，描述会议室的基本信息和状态。 | `id`, `name`, `capacity`, `equipmentList`, `availableTimeSlots` | `getAvailableSlots(date)`, `isAvailable(startTime, endTime)`, `updateEquipment(equipment)` | Equipment |
| **Reservation** | 预约记录实体，记录一次预约的详细信息。 | `id`, `roomId`, `userId`, `startTime`, `endTime`, `status`, `createTime` | `create()`, `cancel()`, `approve()`, `reject()` | MeetingRoom, User |
| **User** | 用户实体，区分员工、经理、管理员角色。 | `id`, `name`, `departmentId`, `role`, `email` | `getReservations()`, `getDepartmentReservations()` (经理), `manageRoom()` (管理员) | Department |
| **Approval** | 审批记录实体，关联预约和审批人。 | `id`, `reservationId`, `approverId`, `status`, `comment`, `createTime` | `process(action, comment)` | Reservation, User |
| **ReservationService** | 预约业务逻辑接口，封装预约核心流程。 | - | `applyForReservation(ReservationRequest)`, `cancelReservation(reservationId, userId)`, `checkConflict(roomId, start, end)` | Reservation, MeetingRoom |
| **ApprovalService** | 审批业务逻辑接口，封装审批流程。 | - | `submitForApproval(reservationId)`, `approve(reservationId, approverId)`, `reject(reservationId, approverId, reason)` | Approval, Reservation |

## 5. 数据流说明

1.  **员工预约会议室流程**：
    *   员工通过表现层（Web页面）选择会议室、日期和时间段，提交预约请求。
    *   请求发送至**预约管理模块**。该模块首先调用**会议室管理模块**的`isAvailable()`方法，检查该时间段会议室是否可用（约束C001， C002）。
    *   若可用，根据会议室容量和规则（约束C003， C004）判断是否需要审批。
    *   **无需审批**：直接创建`Reservation`对象，状态设为“已批准”，并通过**数据访问层**持久化到数据库。
    *   **需要审批**：创建`Reservation`对象，状态设为“待审批”，并调用**审批管理模块**的`submitForApproval()`方法创建`Approval`记录。随后，系统可通知相关经理。
    *   处理结果（成功、失败原因）通过表现层反馈给员工。

2.  **部门经理审批流程**：
    *   经理通过表现层查看待审批列表（数据来源于**审批管理模块**查询`Approval`表）。
    *   经理点击“批准”或“拒绝”，请求发送至**审批管理模块**。
    *   该模块更新`Approval`记录状态，并调用**预约管理模块**的相应方法（`approve()`或`reject()`）来更新关联的`Reservation`记录的状态。
    *   审批结果通过表现层反馈给经理，并可通知发起预约的员工。

3.  **数据存储与读取**：
    *   所有实体（MeetingRoom, Reservation, User, Approval）的数据通过**数据访问层**的DAO（Data Access Object）类进行持久化，存储在关系型数据库中。
    *   业务层通过调用DAO的方法进行数据的增删改查，不直接操作数据库。

## 6. 接口设计
模块间通过定义良好的接口进行协作，主要调用关系如下：

*   **预约管理模块** → **会议室管理模块**：
    *   `MeetingRoomService.getRoomDetails(roomId)`: 获取会议室详情。
    *   `MeetingRoomService.isRoomAvailable(roomId, startTime, endTime)`: 检查会议室在指定时间段的可用性。
*   **预约管理模块** → **审批管理模块**：
    *   `ApprovalService.submitForApproval(reservationId)`: 将需要审批的预约提交至审批流。
*   **审批管理模块** → **预约管理模块**：
    *   `ReservationService.updateReservationStatus(reservationId, newStatus)`: 根据审批结果更新预约状态。
*   **所有业务模块** → **用户与权限管理模块**：
    *   `UserService.getUserById(userId)`: 获取用户信息。
    *   `UserService.validateUserPermission(userId, requiredRole)`: 验证用户是否具备执行某操作所需的权限。
*   **所有业务模块** → **数据访问层**：
    *   调用对应的DAO接口（如`ReservationDAO.save(reservation)`, `MeetingRoomDAO.findById(id)`）进行数据操作。