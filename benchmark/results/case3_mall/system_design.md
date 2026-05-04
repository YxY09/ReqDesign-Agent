# 在线商城订单系统设计方案

## 1. 系统概述
本系统是一个面向电商平台的订单管理系统，旨在为顾客、商家和平台管理员提供一个稳定、高效的交易处理平台。系统核心目标是实现从商品浏览、下单支付到订单管理、退款处理的完整业务闭环，并确保在高并发场景下的数据一致性与系统可靠性。

## 2. 系统分层架构
系统采用经典的分层架构，确保职责清晰、易于维护和扩展。

- **表现层 (Presentation Layer)**
  - **职责**：负责与用户（顾客、商家、管理员）的交互，接收请求并返回响应。提供Web页面、移动端API接口。
  - **技术选型**：可采用Spring MVC或类似框架构建RESTful API。

- **业务逻辑层 (Business Logic Layer)**
  - **职责**：处理核心业务逻辑，包括用户认证、商品管理、购物车、订单处理、支付集成、退款流程等。是系统的核心。
  - **技术选型**：基于Spring Boot构建微服务或模块化单体应用，使用事务管理确保业务操作的原子性。

- **数据访问层 (Data Access Layer)**
  - **职责**：负责与数据库、缓存等数据存储进行交互，提供数据的持久化和读取服务。
  - **技术选型**：使用MyBatis或JPA进行ORM映射，结合Redis作为缓存层提升性能。

- **基础设施层 (Infrastructure Layer)**
  - **职责**：提供通用的技术支持，如消息队列（用于异步处理，如订单超时取消）、第三方服务集成（支付网关、短信服务）、日志、监控等。

## 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| **用户管理模块** | 处理用户（顾客、商家）的注册、登录、信息维护和权限管理。 | F001 |
| **商品管理模块** | 提供商品信息的展示、搜索和详情查看功能。 | F002 |
| **购物车模块** | 管理用户的临时购物车，支持商品的增删改查。 | F003 |
| **订单核心模块** | 处理订单的创建、状态流转（待支付、已支付、已发货、已完成、已取消）、查询和管理。 | F004, F005, F006 |
| **支付模块** | 集成第三方支付渠道，处理支付请求、回调和状态同步。 | F004 |
| **退款模块** | 处理退款申请的提交、商家审核、退款执行和状态跟踪。 | F007, F008 |
| **库存服务模块** | 管理商品库存，在下单时进行库存预扣和释放，确保库存数据一致性。 | F004 (C002) |
| **消息与调度模块** | 处理异步任务，如订单超时自动取消（C001）、支付结果通知等。 | C001 |

## 4. 核心类/接口设计

| 类名 | 职责 | 关键属性 | 关键方法 | 关联的实体 |
|------|------|----------|----------|------------|
| **User** | 用户实体，代表顾客或商家。 | `id`, `username`, `passwordHash`, `phoneNumber`, `role` | `register()`, `login()`, `updateProfile()` | - |
| **Product** | 商品实体。 | `id`, `name`, `description`, `price`, `stockQuantity` | `getDetails()`, `deductStock(quantity)`, `restoreStock(quantity)` | - |
| **ShoppingCart** | 购物车实体，关联用户。 | `id`, `userId`, `items` (List<CartItem>) | `addItem(product, quantity)`, `updateItemQuantity(productId, quantity)`, `removeItem(productId)`, `clear()` | User, Product |
| **Order** | 订单实体，核心业务对象。 | `id`, `userId`, `orderItems` (List<OrderItem>), `totalAmount`, `status` (PENDING_PAYMENT, PAID, SHIPPED, COMPLETED, CANCELLED, REFUNDING), `createTime`, `paymentId` | `create()`, `cancel()`, `updateStatus(newStatus)`, `calculateTotal()` | User, Product, Payment |
| **Payment** | 支付记录实体。 | `id`, `orderId`, `amount`, `paymentMethod`, `transactionId`, `status` (PENDING, SUCCESS, FAILED) | `initiate()`, `handleCallback(callbackData)`, `queryStatus()` | Order |
| **Refund** | 退款记录实体。 | `id`, `orderId`, `refundAmount`, `reason`, `status` (PENDING, APPROVED, REJECTED, COMPLETED), `applyTime` | `apply(orderId, reason)`, `approve()`, `reject()`, `executeRefund()` | Order, Payment |
| **InventoryService** (接口) | 库存服务接口，用于解耦订单与库存。 | - | `checkAndDeductStock(productId, quantity)`, `restoreStock(productId, quantity)` | Product |
| **PaymentService** (接口) | 支付服务接口，用于解耦订单与具体支付实现。 | - | `createPayment(order)`, `processPaymentCallback(callbackData)` | Payment |

## 5. 数据流说明

### 5.1 用户下单支付流程
1.  **请求**：顾客在前端（表现层）提交订单。
2.  **业务处理**：
    - **订单核心模块**接收请求，调用**购物车模块**获取商品信息。
    - 调用**库存服务模块**的`checkAndDeductStock`接口，进行库存预扣（C002）。若库存不足，返回异常（E002）。
    - 创建`Order`对象，状态为`PENDING_PAYMENT`，并持久化到数据库。
    - 调用**支付模块**的`createPayment`接口，生成支付记录，并调用第三方支付网关获取支付凭证。
3.  **响应**：将支付凭证返回给前端，引导用户完成支付。
4.  **异步回调**：用户支付成功后，支付网关回调系统的支付通知接口。
    - **支付模块**验证签名，更新`Payment`状态为`SUCCESS`。
    - **支付模块**通过消息队列通知**订单核心模块**。
    - **订单核心模块**更新`Order`状态为`PAID`，并触发后续流程（如通知商家）。
5.  **超时处理**：**消息与调度模块**定时扫描`PENDING_PAYMENT`状态超过30分钟的订单，调用其`cancel()`方法，并通知**库存服务模块**释放库存。

### 5.2 核心数据存储与读取
- **用户、商品、订单、支付、退款**等核心业务数据存储在**关系型数据库（如MySQL）** 中，通过数据访问层进行操作。
- **商品信息、热门商品列表**等读多写少的数据，可缓存在**Redis**中，由商品管理模块维护缓存一致性。
- **购物车数据**可选择存储在Redis中以提高读写性能，或与用户数据一同存储在数据库中。

### 5.3 模块间数据传递
- 模块间主要通过**服务接口调用**和**消息队列**传递数据。
- **同步调用**：如订单模块调用库存服务、支付服务，通常传递核心业务对象（如订单ID、商品ID、数量）或DTO。
- **异步消息**：如支付成功通知、订单状态变更事件，通过消息队列（如RabbitMQ, Kafka）传递事件消息，实现模块间解耦和最终一致性。

## 6. 接口设计
模块间主要接口调用关系如下：

| 调用方模块 | 被调用方模块 | 接口/方法 | 说明 |
|------------|--------------|-----------|------|
| **订单核心模块** | **库存服务模块** | `InventoryService.checkAndDeductStock(productId, quantity)` | 下单时检查并预扣库存。 |
| **订单核心模块** | **库存服务模块** | `InventoryService.restoreStock(productId, quantity)` | 订单取消或支付失败时释放库存。 |
| **订单核心模块** | **支付模块** | `PaymentService.createPayment(order)` | 创建支付单，发起支付。 |
| **支付模块** | **订单核心模块** | `Order.updateStatus(PAID)` (通过消息或直接调用) | 支付成功后，更新订单状态。 |
| **退款模块** | **订单核心模块** | `Order.getOrderDetails(orderId)` | 获取订单信息以处理退款。 |
| **退款模块** | **支付模块** | `PaymentService.refund(paymentId, amount)` | 执行原路退款操作。 |
| **购物车模块** | **商品管理模块** | `Product.getDetails(productId)` | 获取商品信息以展示在购物车。 |
| **所有模块** | **用户管理模块** | `UserService.getUserInfo(userId)` | 获取当前操作用户的信息和权限。 |