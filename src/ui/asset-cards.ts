import { type App } from "@modelcontextprotocol/ext-apps";
import {
  assetCardValue,
  payloadText,
  type ToolResultCard,
} from "./card-types.js";
import { normalizeToolResult } from "./normalize-tool-result.js";
import {
  element,
  formatBytes,
  objectValue,
  contentFromResult,
} from "./dom-utils.js";

export interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

export interface ApprovedAssetListItem {
  assetReceiptId: string;
  projectId?: string;
  taskId?: string;
  assetRole?: string;
  destinationPath: string;
  sha256: string;
  width?: number;
  height?: number;
  sourceKind?: string;
  sourceFileId?: string;
  projectReceiptPath?: string;
  supersededByAssetReceiptId?: string;
  current?: boolean;
}

export interface AssetCardContext {
  app: App | null;
  appRoot: HTMLElement;
  isExpanded: () => boolean;
  setExpanded: (expanded: boolean) => void;
  getCard: () => ToolResultCard | null;
  setCard: (card: ToolResultCard | null) => void;
  setPayloadContainer: (el: HTMLElement | null) => void;
  renderSummaryBadge: (card: ToolResultCard) => HTMLElement;
  renderPayloadIfNeeded: () => void;
  unmountPayload: () => void;
  render: () => void;
}

let assetPreviewUrl: string | null = null;
let assetActionStatus: string | null = null;
let assetActionError: string | null = null;
let assetActionBusy = false;

export function resetAssetCardState(): void {
  assetPreviewUrl = null;
  assetActionStatus = null;
  assetActionError = null;
  assetActionBusy = false;
}

export function renderAssetIntakeCard(
  activeCard: ToolResultCard,
  display: ToolDisplay,
  ctx: AssetCardContext,
): void {
  ctx.unmountPayload();

  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: `tool-card asset-intake ${display.tone}`,
  });
  const header = element("div", { className: "asset-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });
  titleGroup.append(
    element("span", { className: "tool-title", text: display.title }),
    element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }),
  );
  header.append(icon, titleGroup, ctx.renderSummaryBadge(activeCard));

  const body = element("div", { className: "asset-body" });
  const preview = renderAssetPreview(activeCard);
  if (preview) body.append(preview);

  const facts = renderAssetFacts(activeCard);
  if (facts.childElementCount > 0) body.append(facts);

  const assets = approvedAssetItems(activeCard);
  if (assets.length > 0) {
    body.append(renderApprovedAssetMatches(activeCard, assets, ctx));
  }

  const nextStage = element("div", { className: "asset-next-stage" });
  nextStage.append(
    element("span", { className: "asset-fact-label", text: "Next stage" }),
    element("span", { text: assetNextStage(activeCard) }),
  );
  body.append(nextStage);

  if (assetActionError) {
    body.append(
      element("div", {
        className: "asset-action-status error",
        text: assetActionError,
      }),
    );
  } else if (assetActionStatus) {
    body.append(
      element("div", {
        className: "asset-action-status",
        text: assetActionStatus,
      }),
    );
  }

  const actions = renderAssetActions(activeCard, ctx);
  section.append(header, body);
  if (actions.childElementCount > 0) section.append(actions);

  if (ctx.isExpanded()) {
    const details = element("div", { className: "tool-body" });
    ctx.setPayloadContainer(details);
    section.append(details);
  }

  main.append(section);
  ctx.appRoot.replaceChildren(main);
  ctx.renderPayloadIfNeeded();
}

function renderAssetPreview(activeCard: ToolResultCard): HTMLElement | null {
  const artifactId = assetString(activeCard, "artifactId");
  if (!artifactId) return null;

  const preview = element("div", { className: "asset-preview" });
  if (assetPreviewUrl) {
    const image = element("img", {
      className: "asset-preview-image",
      title: "Preview generated from the saved artifact",
    });
    image.src = assetPreviewUrl;
    image.alt = `Saved PNG preview for ${activeCard.path ?? artifactId}`;
    preview.append(image);
  } else {
    preview.append(
      element("div", {
        className: "asset-preview-placeholder",
        text: "Saved PNG",
      }),
    );
  }
  return preview;
}

function renderAssetFacts(activeCard: ToolResultCard): HTMLElement {
  const facts = element("dl", { className: "asset-facts" });
  const width = assetNumber(activeCard, "width");
  const height = assetNumber(activeCard, "height");
  const bytes = assetNumber(activeCard, "bytes");
  const humanApproval = assetObject(activeCard, "humanApproval");
  const approval =
    humanApproval?.status === "passed" && humanApproval.actor === "human_user"
      ? "human passed"
      : undefined;
  const entries: Array<[string, string | undefined]> = [
    ["Outcome", assetString(activeCard, "outcome")],
    [
      "Dimensions",
      width !== undefined && height !== undefined
        ? `${width} × ${height}`
        : undefined,
    ],
    ["Bytes", bytes === undefined ? undefined : formatBytes(bytes)],
    [
      "Source",
      assetString(activeCard, "sourceKind") ??
        assetString(activeCard, "source"),
    ],
    ["File", assetString(activeCard, "sourceFileName")],
    ["SHA-256", assetString(activeCard, "sha256")],
    ["Artifact", assetString(activeCard, "artifactId")],
    ["Import receipt", assetString(activeCard, "importReceiptId")],
    ["Asset receipt", assetString(activeCard, "assetReceiptId")],
    [
      "Receipt file",
      assetString(activeCard, "assetReceiptPath") ??
        assetString(activeCard, "projectReceiptPath"),
    ],
    ["Approval", approval],
    ["Supersedes", assetString(activeCard, "supersedesAssetReceiptId")],
    ["Superseded by", assetString(activeCard, "supersededByAssetReceiptId")],
    ["Previous SHA", assetString(activeCard, "previousSha256")],
    ["Previous artifact", assetString(activeCard, "previousArtifactId")],
    ["Rollback snapshot", assetString(activeCard, "displacedTrashId")],
  ];
  for (const [label, value] of entries) {
    if (!value) continue;
    facts.append(
      element("dt", { className: "asset-fact-label", text: label }),
      element("dd", {
        className:
          label.includes("SHA") || label.includes("receipt")
            ? "asset-fact-value mono"
            : "asset-fact-value",
        text: value,
        title: value,
      }),
    );
  }
  return facts;
}

function renderApprovedAssetMatches(
  activeCard: ToolResultCard,
  assets: ApprovedAssetListItem[],
  ctx: AssetCardContext,
): HTMLElement {
  const container = element("div", { className: "asset-matches" });
  const visibleAssets = assets.slice(0, 8);
  container.append(
    element("div", {
      className: "asset-section-title",
      text: `${assets.length} approved ${assets.length === 1 ? "asset" : "assets"}`,
    }),
  );
  for (const asset of visibleAssets) {
    const row = element("div", {
      className: `asset-match ${asset.current === false ? "superseded" : ""}`,
    });
    const details = element("div", { className: "asset-match-details" });
    details.append(
      element("span", {
        className: "asset-match-role",
        text: asset.assetRole ?? asset.destinationPath,
      }),
      element("span", {
        className: "asset-match-path",
        text: asset.destinationPath,
        title: asset.destinationPath,
      }),
      element("span", {
        className: "asset-match-sha",
        text: `${asset.sha256.slice(0, 12)}… · ${asset.current === false ? "superseded" : "current"}`,
        title: asset.sha256,
      }),
    );
    row.append(details);
    if (asset.current !== false && asset.sourceFileId) {
      const recover = element("button", {
        className: "review-action",
        type: "button",
        text: "Choose file",
        disabled:
          assetActionBusy ||
          !window.openai?.selectFiles ||
          !window.openai.getFileDownloadUrl,
        title:
          window.openai?.selectFiles && window.openai.getFileDownloadUrl
            ? "Select this exact approved file from ChatGPT File Library"
            : "ChatGPT File Library is unavailable in this host",
      });
      recover.addEventListener("click", () => {
        void recoverFromFileLibrary(activeCard, asset, ctx);
      });
      row.append(recover);
    }
    container.append(row);
  }
  if (visibleAssets.length < assets.length) {
    container.append(
      element("div", {
        className: "asset-fact-label",
        text: `${assets.length - visibleAssets.length} more matches are available in the structured result. Narrow the query to recover one exact asset.`,
      }),
    );
  }
  return container;
}

function renderAssetActions(
  activeCard: ToolResultCard,
  ctx: AssetCardContext,
): HTMLElement {
  const actions = element("div", { className: "asset-actions" });
  const artifactId = assetString(activeCard, "artifactId");
  const workspaceId =
    activeCard.workspaceId ?? assetString(activeCard, "workspaceId");
  if (artifactId && workspaceId) {
    const preview = element("button", {
      className: "review-action",
      type: "button",
      text: assetPreviewUrl ? "Refresh preview" : "Preview saved PNG",
      disabled: assetActionBusy,
    });
    preview.addEventListener("click", () => {
      void loadSavedArtifactPreview(activeCard, workspaceId, artifactId, ctx);
    });
    actions.append(preview);
  }

  if (activeCard.payload || activeCard.structuredContent !== undefined) {
    const details = element("button", {
      className: "review-action",
      type: "button",
      text: ctx.isExpanded() ? "Hide details" : "Show details",
    });
    details.addEventListener("click", () => {
      ctx.setExpanded(!ctx.isExpanded());
      ctx.render();
    });
    actions.append(details);
  }
  return actions;
}

async function loadSavedArtifactPreview(
  activeCard: ToolResultCard,
  workspaceId: string,
  artifactId: string,
  ctx: AssetCardContext,
): Promise<void> {
  if (!ctx.app) return;
  assetActionBusy = true;
  assetActionError = null;
  assetActionStatus = "Creating a short-lived preview from the saved artifact…";
  ctx.render();
  try {
    const response = await ctx.app.callServerTool({
      name: "publish_artifact",
      arguments: {
        workspaceId,
        artifactId,
        purpose: "review",
      },
    });
    if (response.isError)
      throw new Error(payloadText(contentFromResult(response)));
    const structured = objectValue(response.structuredContent);
    const url = structured?.url;
    if (typeof url !== "string" || !url.startsWith("http")) {
      throw new Error("Preview URL was not returned.");
    }
    const currentCard = ctx.getCard();
    if (currentCard === activeCard && assetString(currentCard, "artifactId") === artifactId) {
      assetPreviewUrl = url;
      assetActionStatus =
        "Preview loaded from the saved artifact. It is not provenance.";
    }
  } catch (previewError) {
    assetActionError =
      previewError instanceof Error
        ? previewError.message
        : "Unable to load the saved artifact preview.";
  } finally {
    assetActionBusy = false;
    ctx.render();
  }
}

async function recoverFromFileLibrary(
  activeCard: ToolResultCard,
  asset: ApprovedAssetListItem,
  ctx: AssetCardContext,
): Promise<void> {
  const openai = window.openai;
  const workspaceId =
    activeCard.workspaceId ?? assetString(activeCard, "workspaceId");
  if (
    !ctx.app ||
    !workspaceId ||
    !asset.sourceFileId ||
    !openai?.selectFiles ||
    !openai.getFileDownloadUrl
  ) {
    assetActionError =
      "ChatGPT File Library is unavailable; use the model-facing recovery tool with the exact registered file.";
    ctx.render();
    return;
  }

  assetActionBusy = true;
  assetActionError = null;
  assetActionStatus = "Waiting for an exact File Library selection…";
  ctx.render();
  try {
    const selected = await openai.selectFiles();
    if (selected.length !== 1) {
      throw new Error("Select exactly one approved PNG.");
    }
    const file = selected[0];
    if (file.fileId !== asset.sourceFileId) {
      throw new Error(
        "Selected file ID does not match the approved receipt. Recovery stopped.",
      );
    }
    if (file.mimeType && file.mimeType !== "image/png") {
      throw new Error("Selected file is not a PNG. Recovery stopped.");
    }
    const { downloadUrl } = await openai.getFileDownloadUrl({
      fileId: file.fileId,
    });
    if (!downloadUrl?.startsWith("https://")) {
      throw new Error("ChatGPT did not return a secure temporary file URL.");
    }
    const response = await ctx.app.callServerTool({
      name: "recover_approved_asset",
      arguments: {
        workspaceId,
        assetReceiptId: asset.assetReceiptId,
        file: {
          download_url: downloadUrl,
          file_id: file.fileId,
          mime_type: file.mimeType,
          file_name: file.fileName,
        },
      },
    });
    if (response.isError) {
      throw new Error(
        payloadText(contentFromResult(response)) || "Recovery was rejected.",
      );
    }
    ctx.setCard(normalizeToolResult(response));
    ctx.setExpanded(false);
    assetPreviewUrl = null;
    assetActionStatus = "Approved asset recovered and verified exactly.";
  } catch (recoveryError) {
    assetActionError =
      recoveryError instanceof Error
        ? recoveryError.message
        : "Unable to recover the approved asset.";
  } finally {
    assetActionBusy = false;
    ctx.render();
  }
}

export function approvedAssetItems(
  activeCard: ToolResultCard,
): ApprovedAssetListItem[] {
  const assets =
    (activeCard as unknown as Record<string, unknown>).assets ??
    objectValue(activeCard.structuredContent)?.assets;
  if (!Array.isArray(assets)) return [];
  return assets.filter(isApprovedAssetListItem);
}

function isApprovedAssetListItem(
  value: unknown,
): value is ApprovedAssetListItem {
  const item = objectValue(value);
  return (
    typeof item?.assetReceiptId === "string" &&
    typeof item.destinationPath === "string" &&
    typeof item.sha256 === "string"
  );
}

function assetNextStage(activeCard: ToolResultCard): string {
  if (activeCard.tool === "import_png") {
    return "Technical import only; archive explicit human approval before production.";
  }
  if (activeCard.tool === "find_approved_assets") {
    return approvedAssetItems(activeCard).length > 0
      ? "Verify the authoritative receipt, or choose the exact registered File Library item to recover."
      : "No authoritative asset matched; do not substitute a visually similar file.";
  }
  if (activeCard.tool === "reindex_approved_assets") {
    return "Query and verify rebuilt receipts before resuming production.";
  }
  return assetCardValue(activeCard, "readyForPipeline") === true
    ? "Ready for the project’s declared pipeline; no production step was started automatically."
    : "Pipeline blocked until receipt, current file, SHA, dimensions, and supersession state all verify.";
}

export function assetString(
  activeCard: ToolResultCard,
  key: string,
): string | undefined {
  const value = assetCardValue(activeCard, key);
  return typeof value === "string" && value ? value : undefined;
}

export function assetNumber(
  activeCard: ToolResultCard,
  key: string,
): number | undefined {
  const value = assetCardValue(activeCard, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function assetObject(
  activeCard: ToolResultCard,
  key: string,
): Record<string, unknown> | undefined {
  return objectValue(assetCardValue(activeCard, key));
}
