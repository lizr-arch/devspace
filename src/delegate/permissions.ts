import type {
  DelegateContract,
  AutonomyMode,
  GlobalState,
  SystemStatus,
} from "./schemas.js";

export type RiskLevel = "low" | "medium" | "high";

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  triggerNeedUser: boolean;
  triggerSafetyStop: boolean;
}

export interface RiskAssessment {
  level: RiskLevel;
  factors: string[];
  recommendation: "proceed" | "caution" | "stop";
}

const HIGH_RISK_ACTIONS = [
  "delete_large_code",
  "change_architecture",
  "introduce_new_dependency",
  "modify_contract",
  "use_real_api_keys",
  "publish_externally",
  "bypass_tests",
  "expand_scope",
  "modify_config_files",
  "delete_multiple_files",
];

const MEDIUM_RISK_ACTIONS = [
  "refactor_module",
  "add_new_file",
  "modify_existing_file",
  "run_tests",
  "install_dependency",
];

export function checkPermission(
  action: string,
  contract: DelegateContract,
  currentMode: AutonomyMode,
): PermissionCheckResult {
  if (contract.cannot_do.some((item) => action.includes(item))) {
    return {
      allowed: false,
      reason: `Action "${action}" is explicitly forbidden by delegate contract`,
      triggerNeedUser: true,
      triggerSafetyStop: false,
    };
  }

  if (contract.can_do.some((item) => action.includes(item))) {
    return {
      allowed: true,
      reason: `Action "${action}" is explicitly allowed`,
      triggerNeedUser: false,
      triggerSafetyStop: false,
    };
  }

  if (isHighRiskAction(action)) {
    if (contract.acceptable_risk_level === "high") {
      return {
        allowed: true,
        reason: `High risk action allowed due to high risk tolerance`,
        triggerNeedUser: false,
        triggerSafetyStop: false,
      };
    }

    return {
      allowed: false,
      reason: `High risk action "${action}" requires user approval`,
      triggerNeedUser: true,
      triggerSafetyStop: false,
    };
  }

  return {
    allowed: true,
    reason: `Action "${action}" is within acceptable scope`,
    triggerNeedUser: false,
    triggerSafetyStop: false,
  };
}

export function isHighRiskAction(action: string): boolean {
  return HIGH_RISK_ACTIONS.some((risk) => action.toLowerCase().includes(risk));
}

export function isMediumRiskAction(action: string): boolean {
  return MEDIUM_RISK_ACTIONS.some((risk) =>
    action.toLowerCase().includes(risk),
  );
}

export function assessRisk(
  action: string,
  contract: DelegateContract,
  consecutiveFailures: number,
): RiskAssessment {
  const factors: string[] = [];
  let level: RiskLevel = "low";

  if (isHighRiskAction(action)) {
    factors.push("High risk action detected");
    level = "high";
  } else if (isMediumRiskAction(action)) {
    factors.push("Medium risk action detected");
    level = "medium";
  }

  if (consecutiveFailures >= 2) {
    factors.push(`${consecutiveFailures} consecutive failures`);
    level = "high";
  }

  if (contract.acceptable_risk_level === "low" && level !== "low") {
    factors.push("Contract requires low risk but action is higher risk");
    level = "high";
  }

  let recommendation: "proceed" | "caution" | "stop";
  if (level === "high") {
    recommendation = "stop";
  } else if (level === "medium") {
    recommendation = "caution";
  } else {
    recommendation = "proceed";
  }

  return { level, factors, recommendation };
}

export function shouldTriggerNeedUser(
  action: string,
  contract: DelegateContract,
  state: GlobalState,
  consecutiveFailures: number,
): boolean {
  if (
    contract.must_trigger_need_user.some((condition) =>
      action.includes(condition),
    )
  ) {
    return true;
  }

  if (
    action.includes("change_architecture") ||
    action.includes("modify_contract")
  ) {
    return true;
  }

  if (
    action.includes("expand_scope") ||
    action.includes("introduce_new_dependency")
  ) {
    return true;
  }

  if (
    action.includes("use_real_api_keys") ||
    action.includes("publish_externally")
  ) {
    return true;
  }

  if (
    action.includes("delete_large_code") ||
    action.includes("delete_multiple_files")
  ) {
    return true;
  }

  if (consecutiveFailures >= 2) {
    return true;
  }

  return false;
}

export function shouldTriggerSafetyStop(
  action: string,
  contract: DelegateContract,
): boolean {
  if (action.includes("bypass_tests") || action.includes("skip_validation")) {
    return true;
  }

  if (action.includes("publish_externally") || action.includes("deploy")) {
    return true;
  }

  if (
    action.includes("delete_large_code") &&
    contract.acceptable_risk_level !== "high"
  ) {
    return true;
  }

  if (
    action.includes("modify_contract") ||
    action.includes("modify_stop_conditions")
  ) {
    return true;
  }

  return false;
}

export function canEnterMode(
  targetMode: AutonomyMode,
  contract: DelegateContract | null,
  state: GlobalState,
): { allowed: boolean; reason: string } {
  if (targetMode === "manual") {
    return { allowed: true, reason: "Manual mode is always allowed" };
  }

  if (targetMode === "guided") {
    return { allowed: true, reason: "Guided mode is always allowed" };
  }

  if (!contract) {
    return {
      allowed: false,
      reason: "Delegate contract is required for delegate/free mode",
    };
  }

  if (targetMode === "delegate") {
    return { allowed: true, reason: "Delegate mode authorized by contract" };
  }

  if (targetMode === "free") {
    if (contract.acceptable_risk_level === "low") {
      return {
        allowed: false,
        reason: "Free mode requires medium or high risk tolerance",
      };
    }
    return { allowed: true, reason: "Free mode authorized by contract" };
  }

  return { allowed: false, reason: "Unknown mode" };
}

export function getNextStatus(
  currentStatus: SystemStatus,
  action: string,
  verdict?: string,
): SystemStatus {
  switch (currentStatus) {
    case "BRAINSTORM":
      return "FREEZE_HANDOFF";
    case "FREEZE_HANDOFF":
      return "READY_TO_DELEGATE";
    case "READY_TO_DELEGATE":
      return "DELEGATE_RUNNING";
    case "DELEGATE_RUNNING":
      return "LOCAL_EXECUTING";
    case "LOCAL_EXECUTING":
      return "LOCAL_REPORTED";
    case "LOCAL_REPORTED":
      return "COACH_REVIEWING";
    case "COACH_REVIEWING":
      if (verdict === "PASS" || verdict === "PASS_WITH_WARNINGS") {
        return "NEXT_TASK_CREATED";
      }
      if (verdict === "NEEDS_FIX") {
        return "LOCAL_EXECUTING";
      }
      if (verdict === "DONE") {
        return "DONE";
      }
      if (verdict === "BLOCKED") {
        return "BLOCKED";
      }
      if (verdict === "NEED_USER") {
        return "NEED_USER";
      }
      if (verdict === "SAFETY_STOP") {
        return "SAFETY_STOP";
      }
      if (verdict === "BUDGET_STOP") {
        return "BUDGET_STOP";
      }
      return "COACH_REVIEWING";
    case "NEXT_TASK_CREATED":
      return "LOCAL_EXECUTING";
    default:
      return currentStatus;
  }
}
