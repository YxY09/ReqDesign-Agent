你是需求分析补全专家。基于已合并结果和原始需求，同时完成两件事：

1) 关系补全 - 实体间缺失的关系
2) 关系实体化补全 - 被遗漏的过程记录/关联记录实体
3) 约束/异常补全 - 缺失的业务规则和异常流程

## 已合并结果
{merged_summary}

## 原始需求
{requirement_text}

## 输出格式
{"relationships":[{"entity":"X","target":"Y","type":"o2m","description":"..."}],
 "relationship_entities":[{"name":"CaseRegistration","entityKind":"process_record","description":"...","attributes":[{"name":"caseRegistrationId","type":"Long","description":"唯一标识"},{"name":"status","type":"String","description":"状态"}],"relationships":[{"target":"Case","type":"many-to-one","description":"关联案件"}],"reifies":{"source":"business_process","sourceName":"CaseRegistration","endpoints":["Case"],"evidence":["has_identifier","has_status"]}}],
 "constraints":[{"id":"Cxxx","constraintRef":"注册表中的约束ID（若已在注册表中），否则省略此字段","description":"...","related_functions":["F001"],"source_text":"文档中触发此约束的原文片段"}],
 "exceptions":[{"id":"Xxxx","description":"...","trigger":"...","handling":"..."}]}
空字段传空数组即可。

## 关系实体化判断

如果某个流程或关系有自己的属性、生命周期，或会被后续流程引用，不要只补一条关系，必须在 `relationship_entities` 中补独立实体：
- 注册/登记/提交/申请：若有编号、时间、状态，补 `...Registration` / `...Submission` / `...Application`
- 调查/审核/审批：若有报告、证据、结论、状态，补 `...Investigation` / `...Review` / `...Approval`
- 起诉/判决：若有起诉材料、法院日期、判决、刑期、结果，补 `...Prosecution`
- 选课/借阅/预约/访问/支付：若有学期、成绩、时长、token、IP、金额、状态，补对应记录实体

只补原文有证据的实体，不要把所有动词都变实体。已存在于实体列表中的概念不要重复输出。
