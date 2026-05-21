/**
 * Shared requirement-check helper functions used by both GenerationTool and EvaluationTool.
 */

/** Check whether the requirement JSON implies a refund/return flow. */
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

/** Check whether the requirement JSON has a constraint with the given ID. */
export function hasConstraint(requirementJson: Record<string, unknown>, id: string): boolean {
  const constraints = Array.isArray(requirementJson.constraints)
    ? (requirementJson.constraints as Array<Record<string, unknown>>)
    : [];
  return constraints.some((item) => String(item.id ?? "").trim() === id);
}

/** Find which concept labels from the list are missing in the given text. */
export function missingConcepts(text: string, concepts: Array<[string, RegExp]>): string[] {
  return concepts
    .filter(([, pattern]) => !pattern.test(text))
    .map(([label]) => label);
}

/** Standard refund flow concept list shared by activity-diagram and test-flow coverage checks. */
export const REFUND_FLOW_CONCEPTS: Array<[string, RegExp]> = [
  ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
  ["商家审核", /商家.*审核|审核.*(通过|拒绝)/],
  ["填写退货物流", /(物流|运单|快递).*(填写|录入|提交)|(填写|录入|提交).*(物流|运单|快递)/],
  ["仓库验收", /仓库.*验收|验收.*(通过|失败)/],
  ["退款到账", /退款.*(到账|成功|原路|返回)|(到账|原路返回)/],
];

/** Refund flow concept list used specifically by test-flow coverage (slightly different regex). */
export const REFUND_TEST_CONCEPTS: Array<[string, RegExp]> = [
  ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
  ["商家审核通过", /商家.*审核.*(通过|同意)|(通过|同意).*退款/],
  ["填写物流单号", /(物流单号|退货物流|快递单号|运单号)/],
  ["仓库验收", /仓库.*验收|验收.*(通过|成功)/],
  ["退款到账", /退款.*(到账|成功|原路返回|72)/],
];
