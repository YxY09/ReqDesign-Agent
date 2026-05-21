/**
 * 共享的需求检查辅助函数，供 GenerationTool 和 EvaluationTool 使用。
 */

/** 检查需求 JSON 是否暗示退款/退货流程。 */
export function requiresRefundFlow(requirementJson: Record<string, unknown>): boolean {
  const functions = Array.isArray(requirementJson.functions)
    ? (requirementJson.functions as Array<Record<string, unknown>>)
    : [];
  return functions.some((item) =>
    /退款|退货|售后|refund|return/i.test(
      `${String(item.name ?? "")} ${String(item.description ?? "")}`,
    ),
  );
}

/** 检查需求 JSON 是否具有给定 ID 的约束。 */
export function hasConstraint(requirementJson: Record<string, unknown>, id: string): boolean {
  const constraints = Array.isArray(requirementJson.constraints)
    ? (requirementJson.constraints as Array<Record<string, unknown>>)
    : [];
  return constraints.some((item) => String(item.id ?? "").trim() === id);
}

/** 找出列表中哪些概念标签在给定文本中缺失。 */
export function missingConcepts(text: string, concepts: Array<[string, RegExp]>): string[] {
  return concepts
    .filter(([, pattern]) => !pattern.test(text))
    .map(([label]) => label);
}

/** 活动图和测试流覆盖率检查共享的标准退款流程概念列表。 */
export const REFUND_FLOW_CONCEPTS: Array<[string, RegExp]> = [
  ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
  ["商家审核", /商家.*审核|审核.*(通过|拒绝)/],
  ["填写退货物流", /(物流|运单|快递).*(填写|录入|提交)|(填写|录入|提交).*(物流|运单|快递)/],
  ["仓库验收", /仓库.*验收|验收.*(通过|失败)/],
  ["退款到账", /退款.*(到账|成功|原路|返回)|(到账|原路返回)/],
];

/** 专门用于测试流覆盖率的退款流程概念列表（正则略有不同）。 */
export const REFUND_TEST_CONCEPTS: Array<[string, RegExp]> = [
  ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
  ["商家审核通过", /商家.*审核.*(通过|同意)|(通过|同意).*退款/],
  ["填写物流单号", /(物流单号|退货物流|快递单号|运单号)/],
  ["仓库验收", /仓库.*验收|验收.*(通过|成功)/],
  ["退款到账", /退款.*(到账|成功|原路返回|72)/],
];
