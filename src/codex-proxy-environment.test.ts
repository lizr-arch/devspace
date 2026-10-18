import assert from "node:assert/strict";
import { codexChildEnvironment, parseMacSystemHttpProxy, parseMacSystemHttpProxies } from "./codex-proxy-environment.js";

const system = [
  "<dictionary> {",
  "  HTTPSProxy : 127.0.0.1",
  "  HTTPSPort : 7897",
  "  HTTPSEnable : 1",
  "  HTTPProxy : 127.0.0.1",
  "  HTTPPort : 7897",
  "  HTTPEnable : 1",
  "  ProxyAutoConfigEnable : 0",
  "}",
].join("\n");

assert.equal(parseMacSystemHttpProxy(system), "http://127.0.0.1:7897");
assert.equal(parseMacSystemHttpProxy(system.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1")), undefined,
  "PAC must not be approximated as a fixed proxy");
assert.equal(parseMacSystemHttpProxy("HTTPSEnable : 1\nHTTPSProxy : bad host\nHTTPSPort : 7897"), undefined);
assert.equal(parseMacSystemHttpProxy("HTTPSEnable : 1\nHTTPSProxy : proxy.local\nHTTPSPort : 70000"), undefined);

const derived = codexChildEnvironment({ PATH: "/usr/bin" }, system, "darwin");
assert.equal(derived.HTTPS_PROXY, "http://127.0.0.1:7897");
assert.equal(derived.ALL_PROXY, derived.HTTPS_PROXY);
assert.equal(derived.NO_PROXY, "localhost,127.0.0.1,::1,*.local");
assert.equal(derived.PATH, "/usr/bin");

const explicit = codexChildEnvironment({ HTTPS_PROXY: "http://explicit:1234", PATH: "/bin" }, system, "darwin");
assert.equal(explicit.HTTPS_PROXY, "http://explicit:1234", "explicit proxy settings remain authoritative");
assert.equal(explicit.HTTP_PROXY, "http://127.0.0.1:7897", "missing HTTP scheme inherits system configuration");
const partial = codexChildEnvironment({ HTTP_PROXY: "http://http-only:8080" }, system, "darwin");
assert.equal(partial.HTTP_PROXY, "http://http-only:8080");
assert.equal(partial.HTTPS_PROXY, "http://127.0.0.1:7897", "missing scheme inherits the system proxy");
const differentSystem = system.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : secure-proxy.local")
  .replace("HTTPSPort : 7897", "HTTPSPort : 8443");
assert.deepEqual(parseMacSystemHttpProxies(differentSystem), {
  http: "http://127.0.0.1:7897", https: "http://secure-proxy.local:8443",
});
const split = codexChildEnvironment({ HTTP_PROXY: "http://explicit-http:8080" }, differentSystem, "darwin");
assert.equal(split.HTTPS_PROXY, "http://secure-proxy.local:8443", "HTTPS inherits its own system endpoint");
const otherPlatform = codexChildEnvironment({}, system, "linux");
assert.equal(otherPlatform.HTTPS_PROXY, undefined);

process.stdout.write("codex proxy environment: PASS\n");
