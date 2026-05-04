# 图书管理系统设计方案

### 1. 系统概述
本系统旨在为高校图书馆提供一个数字化的图书管理平台，以提升图书管理效率和学生借阅体验。系统将实现图书信息的在线管理、学生自助借阅与归还、以及全面的借阅记录追踪，从而优化图书馆的服务流程和资源利用率。

### 2. 系统分层架构
系统采用经典的三层架构，确保职责分离、高内聚低耦合，便于开发、维护和扩展。

- **表现层 (Presentation Layer)**
    - **职责**：负责与用户（学生、管理员）的直接交互，包括接收用户输入、展示处理结果和系统状态。提供Web界面或API接口。
    - **技术选型建议**：前端可采用Vue.js/React等框架构建单页面应用（SPA），后端提供RESTful API。

- **业务逻辑层 (Business Logic Layer)**
    - **职责**：系统的核心，处理所有业务规则和流程。包括用户认证、图书搜索逻辑、借阅/归还的规则校验（如借阅上限、图书状态、超期计算）、以及数据一致性保障。
    - **技术选型建议**：使用Java/Spring Boot、Python/Django或Node.js/Express等后端框架实现。

- **数据访问层 (Data Access Layer)**
    - **职责**：负责与数据库进行交互，执行数据的持久化（存储、读取、更新、删除）操作。为业务逻辑层提供统一的数据访问接口，隔离业务逻辑与具体数据库实现。
    - **技术选型建议**：使用ORM框架（如Hibernate, SQLAlchemy, Sequelize）或直接编写SQL语句。数据库可采用MySQL、PostgreSQL等关系型数据库。

### 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| **用户管理模块** | 处理学生用户的注册、登录、身份验证和会话管理。 | F001 |
| **图书管理模块** | 提供图书信息的增删改查（CRUD）功能，以及面向学生的图书搜索服务。 | F002, F006 |
| **借阅管理模块** | 核心业务模块，处理图书借阅、归还的完整流程，包括规则校验（约束C001-C004）、状态更新、超期计算和罚款标记。管理借阅记录。 | F003, F004, F005, F007 |

### 4. 核心类/接口设计
以下是系统中的核心实体类和业务服务类设计。

| 类名 | 职责 | 关键属性 | 关键方法 | 关联的实体 |
|------|------|----------|----------|------------|
| **User** | 用户实体，存储用户基本信息。 | `id` (主键), `username` (学号), `password` (加密存储), `role` (角色：STUDENT/ADMIN), `maxBorrowLimit` (最大借阅数，如5) | `register()`, `login()`, `getProfile()` | BorrowRecord |
| **Book** | 图书实体，存储图书详细信息及状态。 | `id` (主键), `title`, `author`, `isbn`, `status` (状态：AVAILABLE/BORROWED) | `add()`, `update()`, `delete()`, `search()` | BorrowRecord |
| **BorrowRecord** | 借阅记录实体，记录一次借阅行为。 | `id` (主键), `userId`, `bookId`, `borrowDate`, `dueDate`, `returnDate`, `status` (状态：BORROWED/RETURNED/OVERDUE) | `create()`, `updateReturn()`, `checkOverdue()` | User, Book |
| **UserService** | 用户业务服务，处理用户相关逻辑。 | - | `registerUser(UserDTO)`, `authenticateUser(String username, String password)` | User |
| **BookService** | 图书业务服务，处理图书管理逻辑。 | - | `addBook(BookDTO)`, `updateBook(BookDTO)`, `deleteBook(Long id)`, `searchBooks(String keyword)` | Book |
| **BorrowService** | 借阅业务服务，处理核心借阅/归还逻辑。 | - | `borrowBook(Long userId, Long bookId)`, `returnBook(Long recordId)`, `getUserBorrowRecords(Long userId)`, `getAllBorrowRecords()` | User, Book, BorrowRecord |

### 5. 数据流说明
**1. 用户借阅图书流程：**
1.  **表现层**：学生在前端界面选择图书并点击“借阅”，前端将`userId`和`bookId`发送至后端API。
2.  **业务逻辑层**：
    - `BorrowService.borrowBook()`方法被调用。
    - 首先调用`UserService`验证用户身份及借阅资格（是否达到上限C002）。
    - 调用`BookService`查询图书状态，检查是否可借（C001）。
    - 校验通过后，创建`BorrowRecord`对象，设置借阅日期、应还日期（当前日期+30天）。
    - 更新`Book`的状态为`BORROWED`。
    - 将`BorrowRecord`和更新后的`Book`信息传递给数据层。
3.  **数据访问层**：在同一个数据库事务中，将新的`BorrowRecord`插入`borrow_record`表，并更新`book`表中对应图书的状态。
4.  **返回**：操作成功，业务层返回成功信息；若校验失败（如图书已借出E001、达到上限E002），则返回相应的错误提示。

**2. 管理员查看所有借阅记录流程：**
1.  **表现层**：管理员点击“借阅管理”，前端向后端API请求所有借阅记录。
2.  **业务逻辑层**：`BorrowService.getAllBorrowRecords()`方法被调用，该方法可能包含分页、排序逻辑。
3.  **数据访问层**：执行SQL查询，从`borrow_record`表联合`user`和`book`表获取完整的借阅记录列表。
4.  **返回**：数据层将查询结果集返回给业务层，业务层将其封装为DTO列表，最终通过表现层展示给管理员。

**核心数据存储路径：**
- 用户数据 -> `user`表
- 图书数据 -> `book`表
- 借阅记录 -> `borrow_record`表（外键关联`user`和`book`）

### 6. 接口设计
模块间通过定义良好的接口进行调用，主要接口如下：

- **表现层 -> 业务逻辑层 (RESTful API)**
    - `POST /api/auth/register`：用户注册
    - `POST /api/auth/login`：用户登录
    - `GET /api/books?keyword={keyword}`：搜索图书
    - `POST /api/borrows`：借阅图书 (Body: `{userId, bookId}`)
    - `PUT /api/borrows/{recordId}/return`：归还图书
    - `GET /api/users/{userId}/borrows`：获取用户借阅记录
    - `GET /api/admin/books`：管理员获取图书列表
    - `POST /api/admin/books`：管理员添加图书
    - `PUT /api/admin/books/{id}`：管理员修改图书
    - `DELETE /api/admin/books/{id}`：管理员删除图书
    - `GET /api/admin/borrows`：管理员获取所有借阅记录

- **业务逻辑层内部接口 (Service层方法调用)**
    - `UserService.authenticateUser()` 被 `BorrowService.borrowBook()` 调用，以验证用户。
    - `BookService.getBookById()` 被 `BorrowService.borrowBook()` 和 `returnBook()` 调用，以获取和更新图书状态。
    - 所有Service层方法均可被对应的Controller（表现层）调用。