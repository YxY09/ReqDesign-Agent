/**
 * OutputScorer — 对已完成运行输出的产物进行质量评分。
 * 无需 LLM 调用 — 纯规则驱动。
 */

export interface ScoreReport {
  entityCoverage: number;        // 0-1：分析结果中的实体在设计中出现的比例
  functionIdCoverage: number;    // 0-1：Fxxx ID 的覆盖率
  constraintIdCoverage: number;  // 0-1：Cxxx ID 的覆盖率
  exceptionIdCoverage: number;   // 0-1：Exxx ID 的覆盖率
  namingConsistency: number;     // 0-1：产物间实体命名的一致性
  testTypeBalance: number;       // 0-1：是否包含正常+异常+边界测试
  overall: number;               // 加权平均
  details: string[];
}

export class OutputScorer {
  /**
   * 对运行输出进行评分。
   */
  static score(
    analysis: Record<string, unknown>,
    designText: string,
    diagrams: Record<string, unknown>,
    testCases: string,
    requirementJson: Record<string, unknown>,
    _requirementText?: string,
  ): ScoreReport {
    const details: string[] = [];
    const d = designText ?? "";
    const t = testCases ?? "";
    const diag = diagrams ?? {};

    // 1. 实体覆盖率：分析结果中的实体有多少出现在设计中？
    const entities = (Array.isArray(analysis.entities)
      ? analysis.entities as Array<Record<string, unknown>>
      : []);
    const entityNames = entities.map((e) => String(e.name ?? "").trim()).filter(Boolean);
    let entityHits = 0;
    for (const name of entityNames) {
      if (d.includes(name)) {
        entityHits++;
      } else {
        details.push(`实体 '${name}' 未在设计文档中出现`);
      }
    }
    const entityCoverage = entityNames.length > 0 ? entityHits / entityNames.length : 1;

    // 2. 功能 ID 覆盖率
    const functions = (Array.isArray(requirementJson.functions)
      ? requirementJson.functions as Array<Record<string, unknown>>
      : []);
    const funcIds = functions.map((f) => String(f.id ?? "").trim()).filter(Boolean);
    let funcHits = 0;
    for (const id of funcIds) {
      if (t.includes(id) || d.includes(id)) funcHits++;
    }
    const functionIdCoverage = funcIds.length > 0 ? funcHits / funcIds.length : 1;

    // 3. 测试中约束 ID 的覆盖率
    const constraints = (Array.isArray(requirementJson.constraints)
      ? requirementJson.constraints as Array<Record<string, unknown>>
      : []);
    const constraintIds = constraints.map((c) => String(c.id ?? "").trim()).filter(Boolean);
    let constraintHits = 0;
    for (const id of constraintIds) {
      if (t.includes(id)) constraintHits++;
      else details.push(`约束 ${id} 未被测试用例覆盖`);
    }
    const constraintIdCoverage = constraintIds.length > 0 ? constraintHits / constraintIds.length : 1;

    // 4. 测试中异常 ID 的覆盖率
    const exceptions = (Array.isArray(requirementJson.exceptions)
      ? requirementJson.exceptions as Array<Record<string, unknown>>
      : []);
    const exceptionIds = exceptions.map((e) => String(e.id ?? "").trim()).filter(Boolean);
    let exceptionHits = 0;
    for (const id of exceptionIds) {
      if (t.includes(id)) exceptionHits++;
      else details.push(`异常 ${id} 未被测试用例覆盖`);
    }
    const exceptionIdCoverage = exceptionIds.length > 0 ? exceptionHits / exceptionIds.length : 1;

    // 5. 命名一致性：检查类图中的实体名是否与分析结果一致
    let classDiagram = String((diag as Record<string, unknown>).class_diagram ?? "");
    if (!classDiagram) {
      const inner = (diag as Record<string, unknown>).diagrams as Record<string, unknown> | undefined;
      if (inner && typeof inner.class_diagram === "string") {
        classDiagram = inner.class_diagram;
      }
    }
    let namingHits = 0;
    let namingTotal = 0;
    if (classDiagram && entityNames.length > 0) {
      for (const name of entityNames) {
        namingTotal++;
        if (classDiagram.includes(name)) {
          namingHits++;
        } else {
          details.push(`类图中未找到实体 '${name}'（可能被改名）`);
        }
      }
    }
    const namingConsistency = namingTotal > 0 ? namingHits / namingTotal : 1;

    // 6. 测试类型平衡
    const hasNormal = /正常/.test(t) || /TC-N-/.test(t);
    const hasError = /异常/.test(t) || /TC-E-/.test(t);
    const hasBoundary = /边界/.test(t) || /TC-B-/.test(t);
    const balanceParts = [hasNormal, hasError, hasBoundary].filter(Boolean).length;
    const testTypeBalance = balanceParts / 3;

    // 综合评分（6 个维度）
    const overall = (
      entityCoverage * 0.20 +
      functionIdCoverage * 0.20 +
      constraintIdCoverage * 0.15 +
      exceptionIdCoverage * 0.10 +
      namingConsistency * 0.20 +
      testTypeBalance * 0.15
    );

    return {
      entityCoverage: Math.round(entityCoverage * 100) / 100,
      functionIdCoverage: Math.round(functionIdCoverage * 100) / 100,
      constraintIdCoverage: Math.round(constraintIdCoverage * 100) / 100,
      exceptionIdCoverage: Math.round(exceptionIdCoverage * 100) / 100,
      namingConsistency: Math.round(namingConsistency * 100) / 100,
      testTypeBalance: Math.round(testTypeBalance * 100) / 100,
      overall: Math.round(overall * 100) / 100,
      details,
    };
  }

  static format(report: ScoreReport): string {
    const lines = [
      `=== 输出质量评分 ===`,
      `实体覆盖(设计):       ${(report.entityCoverage * 100).toFixed(0)}%`,
      `功能ID覆盖率:         ${(report.functionIdCoverage * 100).toFixed(0)}%`,
      `约束ID覆盖率:         ${(report.constraintIdCoverage * 100).toFixed(0)}%`,
      `异常ID覆盖率:         ${(report.exceptionIdCoverage * 100).toFixed(0)}%`,
      `命名一致性:           ${(report.namingConsistency * 100).toFixed(0)}%`,
      `测试类型平衡:         ${(report.testTypeBalance * 100).toFixed(0)}%`,
      `──────────────────`,
      `综合评分:             ${(report.overall * 100).toFixed(0)}/100`,
    ];
    if (report.details.length > 0) {
      lines.push(``, `问题详情:`);
      for (const d of report.details.slice(0, 15)) {
        lines.push(`  - ${d}`);
      }
      if (report.details.length > 15) {
        lines.push(`  ... 还有 ${report.details.length - 15} 个`);
      }
    }
    return lines.join("\n");
  }
}
