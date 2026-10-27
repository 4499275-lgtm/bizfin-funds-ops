// 领域类型：与产品基线《通联企业收入勾兑平台 V2 产品设计》保持一致
export type PaymentStatus = "支付成功" | "待确定";

export interface PaymentCompany {
  id: string;
  version: number;
  name: string;
  aliases: string[];
  feeRateBps: number;
  fixedFeeCents: number;
  calculationLevel: "PER_ORDER" | "BATCH_TOTAL";
  rounding: "HALF_UP" | "FLOOR" | "CEIL";
  effectiveFrom: string;
  enabled: boolean;
}

export interface Rule {
  id: string;
  version: number;
  layer: 1 | 2 | 3;
  name: string;
  strategy: string;
  priority: number;
  enabled: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
  params: Record<string, any>;
  conditionText: string;
  actionText: string;
  description: string;
}

export interface NonReceivableType {
  id: string;
  name: string;
  category: string;
  autoRule: string;
  approvalRequired: boolean;
  evidenceRequired: boolean;
  enabled: boolean;
}

export interface ClosurePolicy {
  id: string;
  version: number;
  name: string;
  description: string;
}

export interface Statement {
  id: string;
  accountId: string;
  reconDate: string;
  bankSerialNo: string;
  bookingDate: string;
  bookingTime: string;
  payerName: string;
  payerAccount: string;
  payerBank: string;
  memo: string;
  amountCents: number;
  currency: string;
  settlementGroupKey: string;
}

export interface OrderSnapshot {
  id: string;
  sourceSystem: string;
  externalOrderId: string;
  orderNo: string;
  customerCode: string;
  customerName: string;
  amountCents: number;
  paymentStatus: PaymentStatus;
  paymentCompanyId: string;
  paymentSuccessDate: string;
  businessDate: string;
  version: number;
}

export interface MoneyIdentity {
  id: string;
  statementId: string;
  version: number;
  signature: string;
  status: "IDENTIFIED" | "UNIDENTIFIED";
  sourceType: string;            // 支付公司清算款 | 非业务入账 | 银行转账 | ""
  paymentCompanyId: string;
  ruleId: string;
  ruleVersion: number;
  evidence: string;
  decidedAt: string;
}

export interface StatementPart { statementId: string; amountCents: number; }
export interface TargetPart { targetType: "BUSINESS_ORDER"; targetId: string; amountCents: number; }

export interface MatchGroup {
  id: string;
  status: "CONFIRMED" | "REVERSED";
  origin: "AUTO" | "MANUAL";
  ruleId: string;
  ruleVersion: number;
  relationType: "1:1" | "1:N" | "N:1" | "N:N";
  edgeMode: "DIRECT" | "GROUP_TOTAL";
  note: string;
  createdAt: string;
  createdBy: string;
  statementParts: StatementPart[];
  targetParts: TargetPart[];
}

export interface AllocationDecision {
  id: string;
  statementId: string;
  version: number;
  signature: string;
  status: "CONFIRMED" | "PENDING" | "NEED_REVIEW" | "REVERSED";
  coverage: "NONE" | "PARTIAL" | "FULL";
  targetType: "BUSINESS_ORDER" | "NON_RECEIVABLE_TYPE" | "UNRESOLVED";
  targetIds: string[];
  groupIds: string[];
  ruleId: string;
  ruleVersion: number;
  basis: string;
  decidedAt: string;
  decidedBy: string;
}

export interface ExceptionEvent {
  id: string;
  fingerprint: string;
  type: string;
  ruleId: string;
  ruleVersion: number;
  statementIds: string[];
  orderIds: string[];
  actualCents: number;
  expectedCents: number;
  differenceCents: number;
  location: string;
  responsibility: string;
  basis: string;
  route: string;
  severity: "高" | "中" | "低";
  blocking: boolean;
  status: "DETECTED" | "PROCESSING" | "CLOSED";
  version: number;
  detectedAt: string;
  processingAt?: string;
  closedAt?: string;
  closedReason?: string;
  closeEvidence?: string;
  history: Array<{ version: number; status: string; basis: string; changedAt: string; actor?: string }>;
}

export interface TrustedStatus {
  id: string;
  statementId: string;
  version: number;
  signature: string;
  status: "Processing" | "Closed" | "Blocked";
  identityId?: string;
  identityVersion?: number;
  allocationDecisionId?: string;
  allocationDecisionVersion?: number;
  openExceptionIds: string[];
  policyId: string;
  policyVersion: number;
  basis: string;
  evaluatedAt: string;
}

export interface IdentifyOutcome {
  status: "IDENTIFIED" | "UNIDENTIFIED";
  sourceType: string;
  paymentCompanyId: string;
  ruleId: string;
  ruleVersion: number;
  evidence: string;
}

export const OPEN_EXCEPTION_STATUSES = ["DETECTED", "PROCESSING"] as const;
