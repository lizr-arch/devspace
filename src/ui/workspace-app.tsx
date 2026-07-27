import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import {
  genericPayloadText,
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

function genericResultIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><path d="M9 9h6" /><path d="M9 13h6" /><path d="M9 17h3" />',
  );
}
