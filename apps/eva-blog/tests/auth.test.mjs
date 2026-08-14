import test from "node:test";
import assert from "node:assert/strict";
import { getAuthContract, getGitHubOAuthStartUrl } from "../api/contracts.js";

test("GitHub auth contract exposes production routes without a mock login", () => {
  const contract = getAuthContract();

  assert.equal(contract.provider, "github");
  assert.equal(contract.startRoute, "GET /api/auth/github/start?redirect=/");
  assert.equal(contract.callbackRoute, "GET /api/auth/github/callback?code=...&state=...");
  assert.equal(contract.devMockRoute, undefined);
  assert.deepEqual(contract.requiredScopes, ["read:user"]);
  assert.match(getGitHubOAuthStartUrl({ baseUrl: "https://eva.example", redirectPath: "/article/demo" }), /^https:\/\/eva\.example\/api\/auth\/github\/start/);
});
