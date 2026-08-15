import test from "node:test";
import assert from "node:assert/strict";
import { getAuthContract, getGitHubOAuthStartUrl } from "../api/contracts";

test("GitHub auth contract exposes production routes without a mock login", () => {
  const contract = getAuthContract();

  assert.equal(contract.provider, "github");
  assert.equal(contract.startRoute, "GET /api/auth/github/start?redirect=/");
  assert.equal(contract.callbackRoute, "GET /api/auth/github/callback?code=...&state=...");
  // AuthContract 未声明 devMockRoute（公开契约不含 mock 登录），用宽松访问保持断言语义
  assert.equal((contract as unknown as Record<string, unknown>).devMockRoute, undefined);
  assert.deepEqual(contract.requiredScopes, ["read:user"]);
  assert.match(getGitHubOAuthStartUrl({ baseUrl: "https://eva.example", redirectPath: "/article/demo" }), /^https:\/\/eva\.example\/api\/auth\/github\/start/);
});
