import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import {
  assetCardValue,
  genericPayloadText,
  isAssetIntakeTool,
  isEditTool,
  isExpandableCard,
  isJobTool,
  isProjectMemoryTool,
  isReadTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  isToolName,
  isWorkspaceTool,
  isWriteTool,
  payloadText,
  summaryBadgeText,
  summaryNumber,
  type HostContext,
  type ToolResultCard,
} from "./card-types.js";
import { normalizeToolResult } from "./normalize-tool-result.js";
import { RenderGenerationGate } from "./render-generation.js";
import {
  WORKSPACE_APP_VERSION,
  WorkspaceAppTelemetry,
  errorName as telemetryErrorName,
  resourceType as telemetryResourceType,
  type WorkspaceAppErrorPhase,
} from "./workspace-app-telemetry.js";
import "./workspace-app.css";

interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let assetPreviewUrl: string | null = null;
let assetActionStatus: string | null = null;
let assetActionError: string | null = null;
let assetActionBusy = false;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
const renderGate = new RenderGenerationGate();
const telemetry = new WorkspaceAppTelemetry();
let telemetryPhase: WorkspaceAppErrorPhase = "bootstrap";

window.addEventListener("error", captureWindowError, true);
window.addEventListener("unhandledrejection", (event) => {
  telemetry.capture("unhandled_rejection", telemetryPhase, {
    errorName: telemetryErrorName(event.reason),
  });
});

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: WORKSPACE_APP_VERSION },
    {},
  );

  app.ontoolresult = (result) => {
    telemetryPhase = "tool_result";
    try {
      renderGate.nextResult();
      card = normalizeToolResult(result);
      expanded = false;
      reviewFilesExpanded = false;
      errorMessage = null;
      assetPreviewUrl = null;
      assetActionStatus = null;
      assetActionError = null;
      assetActionBusy = false;
      render();
    } catch (resultError) {
      telemetry.capture("render_error", "tool_result", {
        errorName: telemetryErrorName(resultError),
      });
      errorMessage = "Unable to render this tool result.";
      render();
    } finally {
      telemetryPhase = "render";
    }
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    unmountPayload();
    return {};
  };

  try {
    telemetryPhase = "connect";
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    telemetry.connect(async (diagnostic) => {
      if (!app) throw new Error("Workspace App bridge unavailable");
      const response = await app.callServerTool({
        name: "report_workspace_app_error",
        arguments: { ...diagnostic },
      });
      if (response.isError) {
        throw new Error("Workspace App diagnostic rejected");
      }
    });
  } catch (connectError) {
    telemetry.capture("connect_error", "connect", {
      errorName: telemetryErrorName(connectError),
    });
    connectionError =
      connectError instanceof Error
        ? connectError.message
        : String(connectError);
  } finally {
    telemetryPhase = "render";
  }

  render();
}

function captureWindowError(event: Event): void {
  if (event instanceof ErrorEvent) {
    telemetry.capture("script_error", telemetryPhase, {
      errorName: telemetryErrorName(event.error),
    });
    return;
  }
  telemetry.capture("resource_error", telemetryPhase, {
    resourceType: telemetryResourceType(event.target),
  });
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    renderEmpty(
      errorMessage ?? "Waiting for a tool result.",
      errorMessage ? "error" : "muted",
    );
    return;
  }

  const display = getToolDisplay(card);
  if (isAssetIntakeTool(card.tool)) {
    renderAssetIntakeCard(card, display);
    return;
  }
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: `tool-card ${display.tone}`,
  });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", {
    className: "tool-title",
    text: display.title,
  });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  toolMain.append(title, label);

  button.append(
    icon,
    toolMain,
    renderSummaryBadge(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

interface ApprovedAssetListItem {
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

function renderAssetIntakeCard(
  activeCard: ToolResultCard,
  display: ToolDisplay,
): void {
  unmountPayload();

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
  header.append(icon, titleGroup, renderSummaryBadge(activeCard));

  const body = element("div", { className: "asset-body" });
  const preview = renderAssetPreview(activeCard);
  if (preview) body.append(preview);

  const facts = renderAssetFacts(activeCard);
  if (facts.childElementCount > 0) body.append(facts);

  const assets = approvedAssetItems(activeCard);
  if (assets.length > 0) {
    body.append(renderApprovedAssetMatches(activeCard, assets));
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

  const actions = renderAssetActions(activeCard);
  section.append(header, body);
  if (actions.childElementCount > 0) section.append(actions);

  if (expanded) {
    const details = element("div", { className: "tool-body" });
    currentPayloadContainer = details;
    section.append(details);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
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
        void recoverFromFileLibrary(activeCard, asset);
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

function renderAssetActions(activeCard: ToolResultCard): HTMLElement {
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
      void loadSavedArtifactPreview(activeCard, workspaceId, artifactId);
    });
    actions.append(preview);
  }

  if (activeCard.payload || activeCard.structuredContent !== undefined) {
    const details = element("button", {
      className: "review-action",
      type: "button",
      text: expanded ? "Hide details" : "Show details",
    });
    details.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
    actions.append(details);
  }
  return actions;
}

async function loadSavedArtifactPreview(
  activeCard: ToolResultCard,
  workspaceId: string,
  artifactId: string,
): Promise<void> {
  if (!app) return;
  assetActionBusy = true;
  assetActionError = null;
  assetActionStatus = "Creating a short-lived preview from the saved artifact…";
  render();
  try {
    const response = await app.callServerTool({
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
    if (card === activeCard && assetString(card, "artifactId") === artifactId) {
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
    render();
  }
}

async function recoverFromFileLibrary(
  activeCard: ToolResultCard,
  asset: ApprovedAssetListItem,
): Promise<void> {
  const openai = window.openai;
  const workspaceId =
    activeCard.workspaceId ?? assetString(activeCard, "workspaceId");
  if (
    !app ||
    !workspaceId ||
    !asset.sourceFileId ||
    !openai?.selectFiles ||
    !openai.getFileDownloadUrl
  ) {
    assetActionError =
      "ChatGPT File Library is unavailable; use the model-facing recovery tool with the exact registered file.";
    render();
    return;
  }

  assetActionBusy = true;
  assetActionError = null;
  assetActionStatus = "Waiting for an exact File Library selection…";
  render();
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
    const response = await app.callServerTool({
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
    card = normalizeToolResult(response);
    expanded = false;
    assetPreviewUrl = null;
    assetActionStatus = "Approved asset recovered and verified exactly.";
  } catch (recoveryError) {
    assetActionError =
      recoveryError instanceof Error
        ? recoveryError.message
        : "Unable to recover the approved asset.";
  } finally {
    assetActionBusy = false;
    render();
  }
}

function approvedAssetItems(
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

function assetString(
  activeCard: ToolResultCard,
  key: string,
): string | undefined {
  const value = assetCardValue(activeCard, key);
  return typeof value === "string" && value ? value : undefined;
}

function assetNumber(
  activeCard: ToolResultCard,
  key: string,
): number | undefined {
  const value = assetCardValue(activeCard, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function assetObject(
  activeCard: ToolResultCard,
  key: string,
): Record<string, unknown> | undefined {
  return objectValue(assetCardValue(activeCard, key));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentFromResult(result: {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}): { content?: Array<{ type: "text" | "image"; text?: string }> } {
  return {
    content: result.content
      ?.filter((item) => item.type === "text" || item.type === "image")
      .map((item) => ({
        type: item.type as "text" | "image",
        text: item.text,
      })),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(
    element("section", { className: `empty ${tone}`, text: message }),
  );
  appRoot.replaceChildren(main);
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (
    !card ||
    !currentPayloadContainer ||
    (!expanded && !isReviewTool(card.tool))
  )
    return;

  const target = currentPayloadContainer;
  const activeCard = card;
  const renderToken = renderGate.beginPayload(activeCard, target);

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (isWorkspaceTool(activeCard.tool)) {
    renderPrePayload(
      target,
      workspacePayloadText(activeCard),
      "open_workspace",
    );
    return;
  }

  if (shouldUseHeavyPayload(activeCard)) {
    if (currentPayload) {
      currentPayload.update({ card: activeCard, hostContext, errorMessage });
      return;
    }

    setPayloadLoading(target, true);

    try {
      const { mountHeavyPayload } = await import("./heavy-payload.js");
      if (
        !renderGate.isCurrent(renderToken, card, currentPayloadContainer) ||
        !expanded
      ) {
        return;
      }

      setPayloadLoading(target, false);
      currentPayload = mountHeavyPayload(target, {
        card: activeCard,
        hostContext,
        errorMessage,
      });
    } catch (loadError) {
      if (
        !renderGate.isCurrent(renderToken, card, currentPayloadContainer) ||
        !expanded
      ) {
        return;
      }

      setPayloadLoading(target, false);
      telemetry.capture("render_error", "payload_load", {
        errorName: telemetryErrorName(loadError),
      });
      renderStatus(
        target,
        loadError instanceof Error
          ? loadError.message
          : "Unable to load details.",
        "error",
      );
    }
    return;
  }

  if (isReviewTool(activeCard.tool)) {
    const visibleFileCount = reviewFilesExpanded
      ? undefined
      : Math.max(3, (activeCard.files ?? []).slice(0, 3).length);

    if (currentPayload) {
      currentPayload.update({
        card: activeCard,
        hostContext,
        errorMessage,
        visibleFileCount,
      });
      return;
    }

    renderStatus(target, "Loading review...");

    try {
      const { mountReviewPayload } = await import("./review-payload.js");
      if (!renderGate.isCurrent(renderToken, card, currentPayloadContainer)) {
        return;
      }

      currentPayload = mountReviewPayload(target, {
        card: activeCard,
        hostContext,
        errorMessage,
        visibleFileCount,
      });
    } catch (loadError) {
      if (!renderGate.isCurrent(renderToken, card, currentPayloadContainer)) {
        return;
      }
      telemetry.capture("render_error", "payload_load", {
        errorName: telemetryErrorName(loadError),
      });
      renderStatus(
        target,
        loadError instanceof Error
          ? loadError.message
          : "Unable to load review.",
        "error",
      );
    }
    return;
  }

  const text = isToolName(activeCard.tool)
    ? payloadText(activeCard.payload)
    : genericPayloadText(activeCard);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, activeCard.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return (
    isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool)
  );
}

function unmountPayload(): void {
  renderGate.invalidatePayload();
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(
    element("div", { className: `status ${tone}`, text: message }),
  );
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(
    element("pre", { className: `text-payload ${tool}`, text }),
  );
}

function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const summary = card.summary ?? {};

  if (isReviewTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Review diff statistics");
    stats.append(
      element("span", {
        className: "add",
        text: `+${String(summary.additions ?? 0)}`,
      }),
      element("span", {
        className: "remove",
        text: `-${String(summary.removals ?? 0)}`,
      }),
    );
    return stats;
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", {
        className: "add",
        text: `+${String(summary.additions ?? 0)}`,
      }),
      element("span", {
        className: "remove",
        text: `-${String(summary.removals ?? 0)}`,
      }),
    );
    return stats;
  }

  if (isWorkspaceTool(card.tool)) {
    const agentsFiles = summaryNumber(summary, "agentsFiles") ?? 0;
    const skills = summaryNumber(summary, "skills") ?? 0;
    const group = element("span", { className: "badge-group" });
    group.setAttribute("aria-label", "Workspace summary");

    const agentsBadge = element("span", {
      className: `badge ${agentsFiles > 0 ? "success" : "muted"}`,
      text: agentsFiles > 0 ? "AGENTS.md" : "No AGENTS.md",
    });
    if (agentsFiles > 0) {
      agentsBadge.insertAdjacentHTML("afterbegin", checkCircleIcon());
    }

    group.append(
      agentsBadge,
      element("span", { className: "badge", text: `${skills} skills` }),
    );
    return group;
  }

  if (isShellTool(card.tool)) {
    return element("span", {
      className: "badge",
      text: `ran · ${summaryBadgeText(card)}`,
    });
  }

  if (isJobTool(card.tool)) {
    return element("span", {
      className: `badge ${summary.status === "succeeded" ? "success" : ""}`,
      text: String(summary.status ?? "job"),
    });
  }

  if (isProjectMemoryTool(card.tool)) {
    return element("span", {
      className: `badge ${card.success === false ? "" : "success"}`,
      text: card.success === false ? "failed" : "SHADOW",
    });
  }

  if (!isToolName(card.tool)) {
    return element("span", {
      className: `badge ${card.success === false ? "" : "success"}`,
      text: card.success === false ? "failed" : "succeeded",
    });
  }

  if (isSearchTool(card.tool)) {
    return element("span", {
      className: "badge",
      text: summaryBadgeText(card),
    });
  }

  return element("span", {
    className: "badge",
    text: summaryBadgeText(card),
  });
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const summary = card.summary ?? {};
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card review" });
  const header = element("div", { className: "review-header" });
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
  header.append(icon, titleGroup, renderSummaryBadge(card));

  const body = element("div", { className: "review-summary" });
  currentPayloadContainer = body;

  const actions = element("div", { className: "review-actions" });
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      reviewFilesExpanded = true;
      render();
    });
    actions.append(showMore);
  }

  section.append(header, body);
  if (actions.childElementCount > 0) {
    section.append(actions);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }

  return chevron;
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;

  chevron.classList.toggle("loading", loading);
  chevron.innerHTML = loading
    ? iconSvg('<circle cx="12" cy="12" r="8" />')
    : iconSvg('<path d="m6 9 6 6 6-6" />');

  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content
        ? `${path}\n\n${content}`
        : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);

  switch (card.tool) {
    case "open_workspace":
    case "resume_workspace":
      return {
        icon: folderIcon(),
        title: "Workspace",
        label,
        tone: "workspace",
      };
    case "project_memory_preflight":
      return {
        icon: projectMemoryIcon(),
        title: "Project Memory",
        label,
        tone: "project-memory",
      };
    case "import_png":
      return {
        icon: assetIcon(),
        title: "PNG Intake",
        label,
        tone: "asset",
      };
    case "archive_approved_image":
      return {
        icon: approvedAssetIcon(),
        title: "Approved Asset",
        label,
        tone: "asset approved",
      };
    case "find_approved_assets":
      return {
        icon: searchIcon(),
        title: "Approved Assets",
        label,
        tone: "asset",
      };
    case "verify_approved_asset":
      return {
        icon: approvedAssetIcon(),
        title: "Verify Approved Asset",
        label,
        tone: "asset",
      };
    case "recover_approved_asset":
      return {
        icon: assetIcon(),
        title: "Recovered Asset",
        label,
        tone: "asset approved",
      };
    case "reindex_approved_assets":
      return {
        icon: filesIcon(),
        title: "Asset Registry",
        label,
        tone: "asset",
      };
    case "read_file":
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write_file":
    case "write":
      return {
        icon: filePlusIcon(),
        title: "Write File",
        label,
        tone: "write",
      };
    case "edit_file":
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "grep_files":
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "find_files":
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "list_directory":
    case "ls":
      return {
        icon: listIcon(),
        title: "List Directory",
        label,
        tone: "directory",
      };
    case "run_shell":
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "show_changes":
      return {
        icon: reviewIcon(),
        title: "Show Changes",
        label,
        tone: "review",
      };
    case "start_job":
    case "start_capture":
    case "poll_job":
    case "cancel_job":
      return { icon: jobIcon(), title: "Job", label, tone: "job" };
    default:
      return {
        icon: genericResultIcon(),
        title: "Tool Result",
        label,
        tone: card.success === false ? "error" : "generic",
      };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0
      ? "No changes since last review"
      : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (isJobTool(card.tool)) {
    const jobId = card.summary?.jobId;
    const status = card.summary?.status;
    if (jobId && status) return `${String(jobId)} · ${String(status)}`;
    if (jobId) return String(jobId);
  }
  if (isProjectMemoryTool(card.tool)) {
    return card.workspaceId ?? card.tool;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }

  return card.tool;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node)
    node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined)
    node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined)
    node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

function folderIcon(): string {
  return iconSvg(
    '<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />',
  );
}

function fileIcon(): string {
  return iconSvg(
    '<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />',
  );
}

function filePlusIcon(): string {
  return iconSvg(
    '<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />',
  );
}

function editIcon(): string {
  return iconSvg(
    '<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />',
  );
}

function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}

function filesIcon(): string {
  return iconSvg(
    '<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />',
  );
}

function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}

function listIcon(): string {
  return iconSvg(
    '<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />',
  );
}

function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}

function reviewIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />',
  );
}

function projectMemoryIcon(): string {
  return iconSvg(
    '<path d="M7 5.5A3.5 3.5 0 0 1 10.5 2H12v20h-1.5A3.5 3.5 0 0 1 7 18.5V18a3.5 3.5 0 0 1 0-7v-.5a3.5 3.5 0 0 1 0-5Z" /><path d="M17 5.5A3.5 3.5 0 0 0 13.5 2H12v20h1.5a3.5 3.5 0 0 0 3.5-3.5V18a3.5 3.5 0 0 0 0-7v-.5a3.5 3.5 0 0 0 0-5Z" />',
  );
}

function jobIcon(): string {
  return iconSvg(
    '<path d="M5 7h14v12H5z" /><path d="M9 7V4h6v3" /><path d="M9 12h6" /><path d="M9 16h4" />',
  );
}

function assetIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><circle cx="9" cy="9" r="1.5" /><path d="m7 17 4-4 2.5 2.5L16 13l2 2" />',
  );
}

function approvedAssetIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="m8 12 2.5 2.5L16 9" />');
}

function genericResultIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><path d="M9 9h6" /><path d="M9 13h6" /><path d="M9 17h3" />',
  );
}
