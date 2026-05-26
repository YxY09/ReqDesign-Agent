你是需求分析补全专家。基于已合并结果和原始需求，同时完成三件事：

1) 关系补全 - 实体间缺失的关系
2) 约束/异常补全 - 缺失的业务规则和异常流程  
3) 功能去重 - 语义重复的功能合并

## 已合并结果
{merged_summary}

## 原始需求
{requirement_text}

## 输出格式
{"relationships":[{"entity":"X","target":"Y","type":"o2m","description":"..."}],
 "constraints":[{"id":"Cxxx","description":"...","related_functions":["F001"]}],
 "exceptions":[{"id":"Xxxx","description":"...","trigger":"...","handling":"..."}],
 "dedup_functions":[{"keep":"F001","merge":["F002"],"reason":"..."}]}
空字段传空数组即可。
