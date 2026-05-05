# 会议室预约系统设计方案

## 1. 系统概述
本系统旨在为企业提供一个高效、便捷的会议室资源管理平台。通过该系统，员工可以方便地查看会议室状态并提交预约申请，部门经理能够对本部门的预约进行审批，系统管理员则可对会议室资源进行统一维护。系统的核心目标是优化会议室资源利用率，简化预约流程，并确保预约规则的严格执行。

## 2. 系统分层架构
系统采用经典的三层架构，确保职责清晰、易于维护和扩展。

*   **表现层 (Presentation Layer)**
    *   **职责**：负责与用户的直接交互，接收用户输入并展示系统输出。包括Web页面、移动端界面或API接口。本层不包含业务逻辑，仅负责数据的格式化和展示。
*   **业务逻辑层 (Business Logic Layer)**
    *   **职责**：系统的核心，处理所有业务规则和流程。包括预约冲突检查、审批流程控制、取消规则验证等。该层协调数据访问层完成数据的持久化，并为表现层提供服务接口。
*   **数据访问层 (Data Access Layer)**
    *   **职责**：负责与数据库或其他数据存储进行交互，执行数据的增删改查操作。为业务逻辑层提供统一的数据访问接口，屏蔽底层数据存储的具体实现细节。

## 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| 用户管理模块 | 处理用户（员工、经理、管理员）的登录、认证、权限管理及信息维护。 | F001, F002, F003, F004, F005, F006, F007 (所有功能的基础) |
| 会议室管理模块 | 负责会议室信息的增删改查，以及会议室设备的配置与管理。 | F006, F007 |
| 预约管理模块 | 核心业务模块，处理会议室浏览、预约申请提交、预约取消、预约记录查询等。 | F001, F002, F004, F005 |
| 审批管理模块 | 处理部门经理对本部门大型会议室预约申请的审批流程。 | F003, F005 |

## 4. 核心类/接口设计

| 类名 | 职责 | 关键属性 | 关键方法 | 关联的实体 |
|------|------|----------|----------|------------|
| `User` | 系统用户基类，表示所有类型的用户。 | `userId`, `name`, `department`, `role` (员工/经理/管理员) | `login()`, `logout()`, `getProfile()` | 员工, 部门经理, 系统管理员 |
| `MeetingRoom` | 会议室实体，描述会议室资源。 | `roomId`, `name`, `capacity`, `location`, `status` (可用/维护中) | `getAvailableTimeSlots(date)`, `updateInfo()`, `addEquipment()` | 会议室, 设备 |
| `Equipment` | 会议室设备实体。 | `equipmentId`, `type` (投影仪/白板等), `status` (正常/故障), `roomId` | `updateStatus()`, `getDetails()` | 设备 |
| `Reservation` | 预约记录实体，核心业务对象。 | `reservationId`, `date`, `timeSlot`, `roomId`, `employeeId`, `status` (待审批/已批准/已取消/已完成), `createTime` | `create()`, `cancel()`, `approve()`, `reject()` | 预约记录, 会议室, 员工 |
| `ReservationService` | 预约业务逻辑服务接口。 | - | `browseRooms(date)`, `submitReservation(request)`, `cancelReservation(id, userId)`, `getMyReservations(userId)` | - |
| `ApprovalService` | 审批业务逻辑服务接口。 | - | `getPendingApprovals(managerId)`, `approveReservation(reservationId)`, `rejectReservation(reservationId, reason)` | - |
| `RoomManagementService` | 会议室管理服务接口。 | - | `addRoom(roomInfo)`, `updateRoom(roomId, info)`, `deleteRoom(roomId)`, `manageEquipment(roomId, equipment)` | - |

## 5. 数据流说明

1.  **员工预约流程**：
    *   员工通过表现层（如Web页面）选择日期，调用`ReservationService.browseRooms()`。
    *   服务层查询`MeetingRoom`表及关联的`Equipment`表，返回可用会议室列表。
    *   员工选择会议室和时间段，提交预约请求。
    *   `ReservationService.submitReservation()`执行：
        *   检查会议室在该时间段是否已被预约（查询`Reservation`表，约束C001）。
        *   检查预约时间是否合法（约束C002，异常E002）。
        *   根据会议室容量判断是否需要审批（约束C003， C004）。
        *   若无需审批，直接创建状态为“已批准”的`Reservation`记录并保存。
        *   若需要审批，创建状态为“待审批”的`Reservation`记录并保存，同时通知相关经理。
    *   结果通过表现层反馈给员工。

2.  **经理审批流程**：
    *   经理登录后，`ApprovalService.getPendingApprovals()`查询其部门下状态为“待审批”的预约记录。
    *   经理进行批准或拒绝操作。
    *   `ApprovalService`更新对应`Reservation`记录的状态，并将结果通知给预约员工。

3.  **取消预约流程**：
    *   员工发起取消请求，`ReservationService.cancelReservation()`检查是否在会议开始前2小时内（异常E003）。
    *   若在期限内，更新`Reservation`记录状态为“已取消”。

4.  **数据存储路径**：
    *   所有实体数据（`User`, `MeetingRoom`, `Equipment`, `Reservation`）通过数据访问层持久化到关系型数据库。
    *   业务逻辑层通过数据访问层的接口（如`ReservationRepository`, `RoomRepository`）进行数据的读写。

## 6. 接口设计
模块间通过定义良好的服务接口进行协作：

*   **预约管理模块** 调用：
    *   `UserManagementService.getUserInfo(userId)`：获取预约人信息。
    *   `RoomManagementService.getRoomDetails(roomId)`：获取会议室详情以检查容量和设备。
    *   `ApprovalService.triggerApproval(reservationId)`：当需要审批时，触发审批流程。
*   **审批管理模块** 调用：
    *   `ReservationService.updateReservationStatus(reservationId, newStatus)`：更新预约状态。
    *   `UserManagementService.getDepartmentEmployees(departmentId)`：获取本部门员工信息以筛选预约。
*   **会议室管理模块** 为其他模块提供：
    *   `RoomManagementService.getRoomAvailability(roomId, date)`：供预约模块查询可用性。
    *   `RoomManagementService.getRoomList()`：供预约模块和表现层获取会议室列表。