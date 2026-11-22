import {strict as assert} from "node:assert";
import {test} from "node:test";
import {formatReport, redactSettings} from "../../vscode/issueReport";

test("issue report never contains endpoints, paths or private registries", () => {
  const settings = {ollamaEndpoint: "http://gpu.corp.example:11434", fixMavenCache: "/Users/someone/.m2", fixGoModCache: "",
    ollamaModel: "qwen2.5-coder:7b", fixNodeImage: "registry.corp.example/node:24", fixGoImage: "golang:1.24",
    timeoutSeconds: 120, mandatoryLocalOnly: true, cloudEscalation: {provider: "x"}, language: "~/secret"};
  assert.deepEqual(redactSettings(settings), {ollamaEndpoint: "non-loopback", fixMavenCache: "set", fixGoModCache: "default",
    ollamaModel: "qwen2.5-coder:7b", fixNodeImage: "private-registry", fixGoImage: "golang:1.24",
    timeoutSeconds: 120, mandatoryLocalOnly: true, cloudEscalation: "custom", language: "custom"});
  assert.equal(redactSettings({ollamaEndpoint: "http://127.0.0.1:11434"}).ollamaEndpoint, "loopback");
  const body = formatReport({extension: "1.0.0", vscode: "1.99.0", os: "darwin", memoryGb: 32, settings, tools: {ollama: true}, problem: "scan hangs"});
  assert.ok(body.includes("scan hangs") && body.includes("ollama yes"));
  assert.ok(!/corp\.example|\/Users\//.test(body));
});
