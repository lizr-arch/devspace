import { execFileSync } from "node:child_process";

const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1,*.local";

/** Return a verified HTTP proxy from macOS SystemConfiguration, or no guess. */
export function parseMacSystemHttpProxies(output: string): { http?: string; https?: string } {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort|ProxyAutoConfigEnable)\s*:\s*(.*?)\s*$/);
    if (match) values.set(match[1]!, match[2]!);
  }
  // PAC requires evaluating an executable configuration; never approximate it.
  if (values.get("ProxyAutoConfigEnable") === "1") return {};
  const result: { http?: string; https?: string } = {};
  for (const [prefix, key] of [["HTTP", "http"], ["HTTPS", "https"]] as const) {
    if (values.get(`${prefix}Enable`) !== "1") continue;
    const host = values.get(`${prefix}Proxy`);
    const port = Number(values.get(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@?#]/.test(host)) continue;
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    result[key] = `http://${hostname}:${port}`;
  }
  return result;
}

export function parseMacSystemHttpProxy(output: string): string | undefined {
  const proxies = parseMacSystemHttpProxies(output);
  return proxies.https ?? proxies.http;
}

/** Keep explicit process proxy settings authoritative; fill only launchd's gap. */
export function codexChildEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  systemProxyOutput?: string,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...base };
  const needsSchemeFallback = !result.HTTPS_PROXY && !result.https_proxy ||
    !result.HTTP_PROXY && !result.http_proxy;
  if (needsSchemeFallback && platform === "darwin") {
    let configuration = systemProxyOutput;
    if (configuration === undefined) {
      try {
        configuration = execFileSync("/usr/sbin/scutil", ["--proxy"], {
          encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"],
        });
      } catch { configuration = ""; }
    }
    const proxies = parseMacSystemHttpProxies(configuration);
    if (proxies.http || proxies.https) {
      if (!result.HTTP_PROXY && !result.http_proxy && proxies.http) {
        result.HTTP_PROXY = proxies.http;
        result.http_proxy = proxies.http;
      }
      if (!result.HTTPS_PROXY && !result.https_proxy && proxies.https) {
        result.HTTPS_PROXY = proxies.https;
        result.https_proxy = proxies.https;
      }
      if (!result.ALL_PROXY && !result.all_proxy && proxies.http && proxies.http === proxies.https) {
        result.ALL_PROXY = proxies.http;
        result.all_proxy = proxies.http;
      }
    }
  }
  if (!result.NO_PROXY && !result.no_proxy) {
    result.NO_PROXY = DEFAULT_NO_PROXY;
    result.no_proxy = DEFAULT_NO_PROXY;
  }
  return result;
}
