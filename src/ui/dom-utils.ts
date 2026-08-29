export function element<K extends keyof HTMLElementTagNameMap>(
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

export function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

export function folderIcon(): string {
  return iconSvg(
    '<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />',
  );
}

export function fileIcon(): string {
  return iconSvg(
    '<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />',
  );
}

export function filePlusIcon(): string {
  return iconSvg(
    '<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />',
  );
}

export function editIcon(): string {
  return iconSvg(
    '<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />',
  );
}

export function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}

export function filesIcon(): string {
  return iconSvg(
    '<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />',
  );
}

export function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}

export function listIcon(): string {
  return iconSvg(
    '<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />',
  );
}

export function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}

export function reviewIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />',
  );
}

export function projectMemoryIcon(): string {
  return iconSvg(
    '<path d="M7 5.5A3.5 3.5 0 0 1 10.5 2H12v20h-1.5A3.5 3.5 0 0 1 7 18.5V18a3.5 3.5 0 0 1 0-7v-.5a3.5 3.5 0 0 1 0-5Z" /><path d="M17 5.5A3.5 3.5 0 0 0 13.5 2H12v20h1.5a3.5 3.5 0 0 0 3.5-3.5V18a3.5 3.5 0 0 0 0-7v-.5a3.5 3.5 0 0 0 0-5Z" />',
  );
}

export function jobIcon(): string {
  return iconSvg(
    '<path d="M5 7h14v12H5z" /><path d="M9 7V4h6v3" /><path d="M9 12h6" /><path d="M9 16h4" />',
  );
}

export function assetIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><circle cx="9" cy="9" r="1.5" /><path d="m7 17 4-4 2.5 2.5L16 13l2 2" />',
  );
}

export function approvedAssetIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="m8 12 2.5 2.5L16 9" />');
}

export function genericResultIcon(): string {
  return iconSvg(
    '<path d="M5 4h14v16H5z" /><path d="M9 9h6" /><path d="M9 13h6" /><path d="M9 17h3" />',
  );
}

export function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }

  return chevron;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function contentFromResult(result: {
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
