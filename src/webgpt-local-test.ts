const VERSIONED_WORKSPACE_APP_URI =
  /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/;

export const WEBGPT_TEST_HOST_ENTRY = "webgpt-test-host.html";

export function isWorkspaceAppTestResourceUri(
  resourceUri: string,
  currentResourceUri: string,
  legacyResourceUri: string,
): boolean {
  return (
    resourceUri === currentResourceUri ||
    resourceUri === legacyResourceUri ||
    VERSIONED_WORKSPACE_APP_URI.test(resourceUri)
  );
}

export function prepareWebGptTestHostHtml(html: string): string {
  return html.replace(/<head>/i, '<head><base href="/app-test/">');
}

export const WEBGPT_TEST_PROBE_JAVASCRIPT = `(() => {
  const source = "devspace-webgpt-test-probe";
  let snapshotQueued = false;
  const send = (event, detail = {}) => {
    window.parent.postMessage({ source, event, ...detail }, "*");
  };
  const snapshot = () => {
    snapshotQueued = false;
    send("snapshot", {
      text: (document.body?.innerText || "").slice(0, 12000),
      height: Math.ceil(document.documentElement?.scrollHeight || 0),
    });
  };
  const queueSnapshot = () => {
    if (snapshotQueued) return;
    snapshotQueued = true;
    queueMicrotask(snapshot);
  };
  window.addEventListener("error", (event) => {
    const target = event.target;
    const resourceUrl =
      target && typeof target === "object" && "src" in target
        ? String(target.src || "")
        : target && typeof target === "object" && "href" in target
          ? String(target.href || "")
          : "";
    send("error", {
      message: event.message || "resource_error",
      resourceUrl,
    });
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    send("error", {
      message:
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason || "unhandled_rejection"),
    });
  });
  new MutationObserver(queueSnapshot).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  window.addEventListener("DOMContentLoaded", queueSnapshot);
  send("ready");
  queueSnapshot();
})();`;

export const WEBGPT_TEST_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' data: blob:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;
