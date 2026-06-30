export interface OutputSnapshot {
  goal: string;
  requirementJson: Record<string, unknown>;
  requirementText: string;
  domainModelJson: Record<string, unknown>;
  designText: string;
  diagrams: Record<string, unknown>;
  testCases: string;
  reviewResult: Record<string, unknown> | null;
  hasOutput: boolean;
}
