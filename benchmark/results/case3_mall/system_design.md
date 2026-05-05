# 在线商城订单系统设计方案

## 1. 系统概述
本系统是一个面向在线商城的订单管理系统，旨在为顾客、商家和平台管理员提供一个完整的订单生命周期管理平台。系统的核心目标是实现从商品浏览、下单支付到订单管理、退款处理的全流程业务闭环，并确保在高并发场景下的数据一致性与系统稳定性。

## 2. 系统分层架构
系统采用经典的分层架构，确保各层职责清晰，便于维护和扩展。

*   **表现层 (Presentation Layer)**：负责处理用户交互，包括Web前端和移动端界面。接收用户请求，调用业务层接口，并将结果以友好的方式呈现给用户。
*   **业务层 (Business Layer)**：系统的核心，包含所有业务逻辑和规则。负责处理用户注册、商品管理、购物车、订单创建、支付、退款等核心业务流程。该层将调用数据层进行数据持久化，并可能通过消息队列与其他服务进行异步通信。
*   **数据层 (Data Layer)**：负责数据的持久化存储和访问。包括关系型数据库（如MySQL）用于存储核心业务数据（用户、商品、订单），以及缓存（如Redis）用于提升热点数据（如商品信息、购物车）的访问性能。
*   **基础设施层 (Infrastructure Layer)**：提供通用的技术支撑，包括消息队列（如RabbitMQ/Kafka，用于处理订单超时取消等异步任务）、文件存储（用于商品图片）、第三方服务集成（如支付网关、短信服务）等。

## 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| 用户管理模块 | 处理顾客和商家的注册、登录、信息维护和权限管理。 | F001 |
| 商品管理模块 | 负责商品信息的增删改查、分类管理、库存管理。 | F002 |
| 购物车模块 | 管理顾客的购物车，包括商品的添加、删除、数量修改。 | F003 |
| 订单处理模块 | 核心业务模块，负责订单的创建、状态流转（待支付、已支付、已发货、已完成、已取消）、取消逻辑。 | F004, F005, F006 |
| 支付模块 | 集成第三方支付渠道，处理支付请求、支付回调、记录支付状态。 | F004 |
| 退款模块 | 处理退款申请、商家审核、退款执行和记录。 | F007, F008 |
| 平台管理模块 | 为管理员提供用户管理、数据统计、纠纷处理等后台功能。 | (隐含于管理员角色) |

## 4. 核心类/接口设计
以下是系统中的核心实体类及其设计：

| 类名 | 职责 | 关键属性 | 关键方法 | 关联实体 |
|------|------|----------|----------|----------|
| **User** | 用户基类，存储通用用户信息。 | `id`, `username`, `phone`, `email`, `role` (Customer/Merchant/Admin) | `register()`, `login()`, `updateProfile()` | - |
| **Customer** | 顾客实体，继承自User。 | `userId`, `defaultAddress` | `addToCart()`, `placeOrder()`, `applyRefund()` | User, Order, Cart |
| **Merchant** | 商家实体，继承自User。 | `userId`, `shopName`, `shopStatus` | `manageProduct()`, `confirmOrder()`, `processRefund()` | User, Product, Order |
| **Product** | 商品实体。 | `id`, `name`, `category`, `price`, `stock`, `merchantId` | `updateInfo()`, `deductStock()`, `restoreStock()` | Merchant, Category |
| **Cart** | 购物车实体。 | `id`, `customerId`, `items` (List<CartItem>) | `addItem()`, `removeItem()`, `updateQuantity()`, `clear()` | Customer, CartItem |
| **CartItem** | 购物车项。 | `id`, `cartId`, `productId`, `quantity` | - | Cart, Product |
| **Order** | 订单实体。 | `id`, `customerId`, `merchantId`, `status` (PENDING_PAYMENT, PAID, SHIPPED, COMPLETED, CANCELLED), `totalAmount`, `createTime` | `create()`, `pay()`, `cancel()`, `ship()`, `complete()` | Customer, Merchant, OrderItem |
| **OrderItem** | 订单项。 | `id`, `orderId`, `productId`, `quantity`, `price` | - | Order, Product |
| **PaymentRecord** | 支付记录实体。 | `id`, `orderId`, `paymentMethod`, `status` (PENDING, SUCCESS, FAILED), `transactionId` | `initiatePayment()`, `handleCallback()` | Order |
| **RefundRecord** | 退款记录实体。 | `id`, `orderId`, `amount`, `status` (PENDING, APPROVED, REJECTED, COMPLETED), `applyTime` | `apply()`, `approve()`, `reject()`, `processRefund()` | Order, PaymentRecord |

## 5. 数据流说明
**1. 用户下单支付流程：**
1.  **表现层**：顾客在前端选择购物车商品，点击“下单”。
2.  **业务层 (订单处理模块)**：
    *   接收请求，校验购物车商品库存（调用**商品管理模块**的`deductStock()`）。
    *   创建`Order`和`OrderItem`记录，状态为`PENDING_PAYMENT`。
    *   调用**支付模块**的`initiatePayment()`，生成支付单据。
    *   返回支付信息给前端。
3.  **业务层 (支付模块)**：与第三方支付网关交互，处理支付。
4.  **数据层**：订单、支付记录写入数据库；商品库存扣减。
5.  **异步流程**：支付成功回调后，**支付模块**更新`PaymentRecord`状态，并通知**订单处理模块**将`Order`状态更新为`PAID`。同时，启动一个延迟消息（如30分钟），用于处理订单超时未支付自动取消（约束C001）。

**2. 退款流程：**
1.  **表现层**：顾客在前端对已完成订单申请退款。
2.  **业务层 (退款模块)**：
    *   校验退款期限（7天，约束E003）。
    *   创建`RefundRecord`，状态为`PENDING`。
    *   通知商家。
3.  **业务层 (退款模块)**：商家审核通过后，调用`processRefund()`。
4.  **业务层 (支付模块)**：调用第三方支付接口执行原路退款（约束C004），更新`PaymentRecord`。
5.  **业务层 (订单处理模块)**：根据退款结果，可能更新`Order`状态。
6.  **数据层**：退款记录、支付记录状态更新。

**模块间数据传递**：主要通过服务接口调用（同步）和消息队列（异步）进行。例如，订单模块通过接口调用商品模块检查库存；支付成功事件通过消息队列通知订单模块更新状态。

## 6. 接口设计
模块间主要接口定义如下（采用伪代码描述）：

```java
// 商品管理模块提供给订单处理模块的接口
interface ProductService {
    // 检查并扣减库存
    boolean checkAndDeductStock(Long productId, int quantity);
    // 恢复库存（用于订单取消）
    void restoreStock(Long productId, int quantity);
}

// 支付模块提供给订单处理模块的接口
interface PaymentService {
    // 发起支付
    PaymentInfo initiatePayment(Long orderId, BigDecimal amount, String paymentMethod);
    // 查询支付状态
    PaymentStatus queryPaymentStatus(Long paymentId);
}

// 订单处理模块提供给退款模块的接口
interface OrderService {
    // 根据订单ID获取订单详情
    Order getOrderById(Long orderId);
    // 更新订单状态
    void updateOrderStatus(Long orderId, OrderStatus newStatus);
}

// 退款模块提供给商家管理后台的接口
interface RefundService {
    // 商家审核退款申请
    void approveRefund(Long refundId);
    void rejectRefund(Long refundId, String reason);
}
```