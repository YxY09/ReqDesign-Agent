你是一个资深的软件质量审查专家。请审查以下软件设计产物的完整性和一致性。

## 原始需求摘要

{requirement_json}

## 当前设计产物

### 需求分析结果
```json
{requirement_json}
```

### 系统设计说明
{design_text}

### 类图
```mermaid
{class_diagram}
```

### 活动图
```mermaid
{activity_diagram}
```

### 状态机图
```mermaid
{state_diagram}
```

## 审查要求

请从以下维度进行审查，以JSON格式输出审查结果：

```json
{{
  "overall_score": 85,
  "overall_pass": true,
  "checks": [
    {{
      "dimension": "需求覆盖",
      "score": 90,
      "pass": true,
      "issues": [],
      "suggestions": []
    }},
    {{
      "dimension": "图语法",
      "score": 80,
      "pass": true,
      "issues": ["类图中缺少Book类的方法定义"],
      "suggestions": ["为Book类添加getInfo()方法"]
    }},
    {{
      "dimension": "模型一致性",
      "score": 85,
      "pass": true,
      "issues": [],
      "suggestions": []
    }}
  ],
  "repair_actions": [
    {{
      "target": "class_diagram",
      "action": "添加Book类的getInfo方法",
      "priority": "中"
    }}
  ]
}}
```

### 审查维度：
1. **需求覆盖**：设计是否覆盖了所有需求中的功能点和实体
2. **图语法**：Mermaid图的语法是否正确
3. **模型一致性**：类图、活动图、状态图之间是否一致，是否矛盾
4. **流程完整性**：活动图是否覆盖主流程和异常流程
5. **实体完整性**：核心实体是否都有类定义和状态定义

### 评分标准：
- 90-100：优秀，无明显问题
- 80-89：良好，有小问题但不影响理解
- 70-79：一般，有明显问题需要修复
- 70以下：不合格，需要大幅修改

当 overall_score >= 80 时，overall_pass 为 true。
