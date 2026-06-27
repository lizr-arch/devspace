import type { DelegateContract, AutonomyMode, GlobalState } from "./schemas.js";
import {
  checkPermission,
  shouldTriggerNeedUser,
  assessRisk,
  type RiskLevel,
} from "./permissions.js";

export interface ProxyDecision {
  action: "accept" | "reject" | "escalate";
  reason: string;
  risk_level: RiskLevel;
}

export interface ProxyContext {
  contract: DelegateContract;
  mode: AutonomyMode;
  state: GlobalState;
  consecutive_failures: number;
}

export class UserProxyAgent {
  private context: ProxyContext;
  private decisionLog: Array<{
    timestamp: string;
    action: string;
    decision: ProxyDecision;
    context: string;
  }> = [];

  constructor(context: ProxyContext) {
    this.context = context;
  }

  evaluateTask(taskDescription: string): ProxyDecision {
    const risk = assessRisk(
      taskDescription,
      this.context.contract,
      this.context.consecutive_failures,
    );

    if (
      shouldTriggerNeedUser(
        taskDescription,
        this.context.contract,
        this.context.state,
        this.context.consecutive_failures,
      )
    ) {
      const decision: ProxyDecision = {
        action: "escalate",
        reason: "High-risk action requires user approval",
        risk_level: risk.level,
      };
      this.logDecision(taskDescription, decision);
      return decision;
    }

    const permission = checkPermission(
      taskDescription,
      this.context.contract,
      this.context.mode,
    );

    if (!permission.allowed) {
      const decision: ProxyDecision = {
        action: "reject",
        reason: permission.reason,
        risk_level: risk.level,
      };
      this.logDecision(taskDescription, decision);
      return decision;
    }

    if (risk.recommendation === "stop") {
      const decision: ProxyDecision = {
        action: "escalate",
        reason: `Risk assessment recommends stopping: ${risk.factors.join(", ")}`,
        risk_level: risk.level,
      };
      this.logDecision(taskDescription, decision);
      return decision;
    }

    const decision: ProxyDecision = {
      action: "accept",
      reason: `Task accepted. Risk level: ${risk.level}`,
      risk_level: risk.level,
    };
    this.logDecision(taskDescription, decision);
    return decision;
  }

  answerCoachQuestion(question: string): string {
    if (
      question.toLowerCase().includes("architecture") ||
      question.toLowerCase().includes("design")
    ) {
      return "I cannot make architecture decisions. This requires user input. Please trigger NEED_USER.";
    }

    if (
      question.toLowerCase().includes("scope") ||
      question.toLowerCase().includes("expand")
    ) {
      return "I cannot expand scope. This requires user approval. Please trigger NEED_USER.";
    }

    if (
      question.toLowerCase().includes("priority") ||
      question.toLowerCase().includes("order")
    ) {
      return "I can accept the proposed priority order within the agreed plan.";
    }

    return "I accept this task within the delegate contract boundaries.";
  }

  getDecisionLog(): Array<{
    timestamp: string;
    action: string;
    decision: ProxyDecision;
    context: string;
  }> {
    return [...this.decisionLog];
  }

  private logDecision(context: string, decision: ProxyDecision): void {
    this.decisionLog.push({
      timestamp: new Date().toISOString(),
      action: context,
      decision,
      context: `Mode: ${this.context.mode}, Risk tolerance: ${this.context.contract.acceptable_risk_level}`,
    });
  }
}
