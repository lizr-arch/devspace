import type { ToolResultCard } from "./card-types.js";

export interface PayloadRenderToken {
  resultGeneration: number;
  payloadGeneration: number;
  card: ToolResultCard;
  container: HTMLElement;
}

export class RenderGenerationGate {
  private resultGeneration = 0;
  private payloadGeneration = 0;

  nextResult(): void {
    this.resultGeneration += 1;
    this.payloadGeneration += 1;
  }

  beginPayload(
    card: ToolResultCard,
    container: HTMLElement,
  ): PayloadRenderToken {
    this.payloadGeneration += 1;
    return {
      resultGeneration: this.resultGeneration,
      payloadGeneration: this.payloadGeneration,
      card,
      container,
    };
  }

  invalidatePayload(): void {
    this.payloadGeneration += 1;
  }

  isCurrent(
    token: PayloadRenderToken,
    card: ToolResultCard | null,
    container: HTMLElement | null,
  ): boolean {
    return (
      token.resultGeneration === this.resultGeneration &&
      token.payloadGeneration === this.payloadGeneration &&
      token.card === card &&
      token.container === container
    );
  }
}
