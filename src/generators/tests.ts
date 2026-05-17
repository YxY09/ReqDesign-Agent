/**
 * TestCaseGenerator — normal/exception/boundary test case generation.
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";

export class TestCaseGenerator {
  private llm: LLMClient;
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.promptTemplate = loadPrompt(
      "test_case.md",
      "请根据以下需求和设计生成测试用例：\n\n{requirement_json}\n\n{design_text}",
    );
  }

  async generate(
    requirementJson: Record<string, unknown>,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
  ): Promise<string> {
    if (!requirementJson && requirementText) {
      requirementJson = { _direct_mode: true, raw_requirement: requirementText };
    } else if (!requirementJson || typeof requirementJson !== "object") {
      throw new Error("需求JSON不能为空且必须是字典类型");
    }
    designText = designText || "";

    let reqStr = JSON.stringify(requirementJson, null, 2);
    reqStr = reqStr.replace(/\{design_text\}/g, "");
    const safeDesign = designText.replace(/\{requirement_json\}/g, "").replace(/\{design_text\}/g, "");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{design_text\}/g, safeDesign);

    const result = await this.llm.generateText(prompt, systemPrompt ?? "");
    return result;
  }

  static validateTestCases(testCases: string, requirementJson: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if (!testCases?.trim()) {
      warnings.push("测试用例为空");
      return warnings;
    }
    if (!requirementJson || typeof requirementJson !== "object") {
      warnings.push("需求分析结果为空");
      return warnings;
    }

    if (!testCases.includes("|")) {
      warnings.push("测试用例缺少表格格式");
    }

    if (!testCases.includes("正常")) warnings.push("缺少正常场景测试");
    if (!testCases.includes("异常")) warnings.push("缺少异常场景测试");
    if (!testCases.includes("边界")) warnings.push("缺少边界场景测试");

    const collectIds = (items: unknown): Array<{ id: string; name: string }> => {
      if (!Array.isArray(items)) return [];
      const results: Array<{ id: string; name: string }> = [];
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const id = String(rec.id ?? "").trim();
          const name = String(rec.name ?? "").trim();
          if (id || name) results.push({ id, name });
        } else if (typeof item === "string" && item.trim()) {
          results.push({ id: "", name: item.trim() });
        }
      }
      return results;
    };

    const extractRefs = (text: string, prefix: "F" | "E"): string[] => {
      const refs = new Set<string>();
      const re = new RegExp(`\\b${prefix}\\d{3}\\b`, "g");
      for (const match of text.matchAll(re)) {
        refs.add(match[0]);
      }
      return [...refs];
    };

    const functionItems = collectIds(requirementJson["functions"]);
    const exceptionItems = collectIds(requirementJson["exceptions"]);
    const functionIds = new Set(functionItems.map((item) => item.id).filter(Boolean));
    const exceptionIds = new Set(exceptionItems.map((item) => item.id).filter(Boolean));
    const referencedFunctionIds = extractRefs(testCases, "F");
    const referencedExceptionIds = extractRefs(testCases, "E");

    const functions = requirementJson["functions"];
    if (Array.isArray(functions)) {
      for (const func of functions) {
        if (typeof func === "object" && func !== null) {
          const rec = func as Record<string, unknown>;
          const fid = String(rec.id || "").trim();
          const name = String(rec.name || "").trim();
          if (fid && !testCases.includes(fid)) {
            const label = `${fid} ${name}`.trim();
            warnings.push(`功能 ${label} 未被测试用例覆盖`);
          } else if (!fid && name && !testCases.includes(name)) {
            warnings.push(`功能 ${name} 未被测试用例覆盖`);
          }
        } else {
          const name = String(func);
          if (name && !testCases.includes(name)) {
            warnings.push(`功能 ${name} 未被测试用例覆盖`);
          }
        }
      }
    }

    for (const fid of referencedFunctionIds) {
      if (!functionIds.has(fid)) {
        warnings.push(`测试用例引用了未定义的功能 ID: ${fid}`);
      }
    }

    for (const eid of referencedExceptionIds) {
      if (!exceptionIds.has(eid)) {
        warnings.push(`测试用例引用了未定义的异常 ID: ${eid}`);
      }
    }

    if (exceptionItems.length > 0) {
      for (const item of exceptionItems) {
        if (!item.id) continue;
        const idFound = referencedExceptionIds.includes(item.id);
        const nameFound = item.name ? testCases.includes(item.name) : false;
        if (!idFound && !nameFound) {
          warnings.push(`异常 ${item.id}${item.name ? ` (${item.name})` : ""} 未被测试用例覆盖`);
        }
      }
    }

    return warnings;
  }

  static countTestCases(testCases: string): Record<string, number> {
    const counts = { "正常场景": 0, "异常场景": 0, "边界场景": 0, "总计": 0 };
    if (!testCases?.trim()) return counts;

    let other = 0;
    for (const line of testCases.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("|")) continue;
      const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const stripped = cells.join("").replace(/-/g, "").trim();
      if (!stripped) continue;

      if (line.includes("正常")) counts["正常场景"]++;
      else if (line.includes("异常")) counts["异常场景"]++;
      else if (line.includes("边界")) counts["边界场景"]++;
      else if (line.includes("TC-")) other++;
    }

    counts["总计"] = counts["正常场景"] + counts["异常场景"] + counts["边界场景"] + other;
    return counts;
  }
}
