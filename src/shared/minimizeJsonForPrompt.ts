/**
 * minimizeJsonForPrompt — 精简 analysis.json 用于 LLM prompt 注入。
 * 去掉下游不需要的内部字段，显著减少 prompt 大小。
 */

/**
 * 安全地将值视为数组，如果不是数组则返回空数组。
 */
function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * 精简 analysis.json 用于 LLM prompt 注入
 * 去掉下游不需要的内部字段，显著减少 prompt 大小
 */
export function minimizeForPrompt(
  analysis: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(analysis)); // deep clone

  // 精简 entities：只保留前 5 个 attributes
  for (const e of asArray(result["entities"])) {
    if (Array.isArray(e["attributes"]) && (e["attributes"] as Array<unknown>).length > 5) {
      e["attributes"] = (e["attributes"] as Array<unknown>).slice(0, 5);
      e["_attributes_truncated"] = true;
    }
  }

  // 精简 constraints：去掉内部规范化字段，只保留下游需要的
  for (const c of asArray(result["constraints"])) {
    delete c["normalizedRule"];
    delete c["evidence"];
    delete c["verification"];
    delete c["constraintUid"];
    delete c["canonicalId"];
    delete c["descriptionZh"];
    delete c["canonicalRuleEn"];
    if (c["source_text"] && c["sourceText"] === c["source_text"]) {
      delete c["sourceText"];
    }

    // relatedFunctions 对象数组 → 简单字符串数组
    if (Array.isArray(c["relatedFunctions"])) {
      const related = c["relatedFunctions"] as Array<unknown>;
      if (related.length > 0) {
        c["related_functions"] = related.map((r: unknown) =>
          typeof r === "string" ? r : (r as Record<string, unknown>)["functionId"]
        );
      }
      delete c["relatedFunctions"];
    }
  }

  // 去掉 traceability（如果有）
  delete result["traceability"];
  delete result["__qualityGate"];
  delete result["proposeNewEntities"];
  delete result["proposeNewFunctions"];

  return result;
}
