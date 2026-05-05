# 图书管理系统设计方案

## 1. 系统概述
本系统是一个面向高校图书馆的图书借阅与管理平台，旨在为学生提供便捷的图书检索、借阅和归还服务，同时为管理员提供高效的图书资源管理与借阅监控工具。系统通过信息化手段提升图书馆的运营效率和用户体验。

## 2. 系统分层架构
系统采用经典的三层架构，确保职责清晰、易于维护和扩展。

- **表现层 (Presentation Layer)**
    - **职责**：负责与用户进行交互，接收用户请求并展示处理结果。为学生和管理员提供不同的操作界面。
    - **技术选型**：可采用Web前端框架（如Vue.js, React）构建单页面应用（SPA）。

- **业务逻辑层 (Business Logic Layer)**
    - **职责**：处理核心业务逻辑，包括用户认证、图书借阅规则校验（如借阅数量、期限）、数据一致性维护等。是系统的核心。
    - **技术选型**：可采用Java（Spring Boot）、Python（Django）等后端框架实现。

- **数据访问层 (Data Access Layer)**
    - **职责**：负责与数据库进行交互，执行数据的持久化（存储）、查询、更新和删除操作，为业务逻辑层提供数据支持。
    - **技术选型**：可采用ORM框架（如Hibernate, MyBatis）或直接使用SQL操作关系型数据库（如MySQL, PostgreSQL）。

## 3. 模块划分
根据功能需求，系统划分为以下核心模块：

| 模块名称 | 职责描述 | 对应功能 |
|----------|----------|----------|
| 用户管理模块 | 处理用户（学生、管理员）的注册、登录、身份验证和权限管理。 | F001, F002 |
| 图书管理模块 | 提供图书信息的增、删、改、查功能，以及面向学生的图书搜索服务。 | F003, F007 |
| 借阅管理模块 | 核心业务模块，处理图书的借出、归还、记录查询，并强制执行借阅规则（数量、期限、并发）。 | F004, F005, F006, F008 |

## 4. 核心类/接口设计
以下为核心实体类及关键业务类的设计。

| 类名 | 职责 | 关键属性 | 关键方法 | 关联实体 |
|------|------|----------|----------|----------|
| **Student** | 学生用户实体 | `studentId` (学号), `password` (密码), `borrowedBooks` (当前借阅图书列表) | `register()`, `login()`, `getBorrowHistory()` | BorrowRecord |
| **Admin** | 管理员用户实体 | `adminId` (账号), `password` (密码), `role` (角色) | `login()`, `addBook()`, `deleteBook()`, `updateBook()` | Book |
| **Book** | 图书实体 | `bookId` (ID), `title` (书名), `author` (作者), `isbn` (ISBN), `status` (状态：可借/已借出) | `borrow()`, `returnBook()`, `updateInfo()` | BorrowRecord |
| **BorrowRecord** | 借阅记录实体 | `recordId` (ID), `student` (关联学生), `book` (关联图书), `borrowDate` (借阅日期), `dueDate` (应还日期), `returnDate` (实际归还日期) | `create()`, `isOverdue()` | Student, Book |
| **BorrowService** | 借阅业务逻辑服务 | - | `borrowBook(studentId, bookId)`, `returnBook(recordId)`, `checkBorrowLimit(studentId)`, `calculateFine(recordId)` | Student, Book, BorrowRecord |
| **BookService** | 图书业务逻辑服务 | - | `searchBooks(keyword)`, `addBook(bookInfo)`, `updateBook(bookId, bookInfo)`, `deleteBook(bookId)` | Book |

## 5. 数据流说明

1.  **用户请求处理流程**：
    - 用户（学生/管理员）通过表现层界面发起请求（如登录、搜索图书）。
    - 请求被路由到业务逻辑层对应的控制器（Controller）。
    - 控制器调用相应的服务（Service）处理业务逻辑。
    - 服务层可能调用数据访问层（DAO/Repository）进行数据库操作。
    - 处理结果逐层返回，最终由表现层渲染并展示给用户。

2.  **核心业务数据存储与读取路径**：
    - **图书借阅**：学生发起借阅请求 -> `BorrowService.borrowBook()` -> 检查学生借阅数量（查询`Student.borrowedBooks`）和图书状态（查询`Book.status`） -> 若通过，更新`Book.status`为“已借出”，创建`BorrowRecord`记录，并将图书添加到`Student.borrowedBooks` -> 所有变更通过数据访问层持久化到数据库。
    - **图书归还**：学生发起归还请求 -> `BorrowService.returnBook()` -> 根据`recordId`找到记录，更新`Book.status`为“可借”，更新`BorrowRecord.returnDate`，并从`Student.borrowedBooks`中移除 -> 持久化变更。

3.  **模块间数据传递**：
    - **表现层 -> 业务层**：传递用户输入参数（如学号、密码、图书ID）。
    - **业务层内部**：`BorrowService`需要调用`Student`和`Book`的数据来执行业务规则校验。
    - **业务层 -> 数据层**：传递实体对象或查询条件，用于数据库的CRUD操作。
    - **数据层 -> 业务层**：返回查询到的实体对象或操作结果。

## 6. 接口设计
模块间通过定义良好的接口进行协作，降低耦合度。

- **用户管理模块接口**：
    - `UserAuthInterface.authenticate(username, password): User`：用于验证用户身份，返回用户对象（学生或管理员）。
    - `UserAuthInterface.getStudentById(studentId): Student`：根据学号获取学生信息。

- **图书管理模块接口**：
    - `BookQueryInterface.searchBooks(criteria): List<Book>`：根据条件（书名、作者、ISBN）搜索图书。
    - `BookQueryInterface.getBookById(bookId): Book`：根据ID获取图书详情。
    - `BookMutationInterface.updateBookStatus(bookId, status): void`：更新图书状态（供借阅模块调用）。

- **借阅管理模块接口**：
    - `BorrowInterface.borrowBook(studentId, bookId): BorrowRecord`：执行借阅操作，返回借阅记录。
    - `BorrowInterface.returnBook(recordId): void`：执行归还操作。
    - `BorrowInterface.getStudentBorrowRecords(studentId): List<BorrowRecord>`：获取学生借阅记录。
    - `BorrowInterface.getAllBorrowRecords(): List<BorrowRecord>`：获取所有借阅记录（管理员用）。

**调用关系示例**：`BorrowService`在执行`borrowBook`时，会调用`UserAuthInterface.getStudentById`获取学生信息，并调用`BookQueryInterface.getBookById`获取图书信息，校验通过后调用`BookMutationInterface.updateBookStatus`和自身的数据访问层完成记录创建。