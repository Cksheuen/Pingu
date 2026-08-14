import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorApi } from "../src/services/authorApi.js";

test("author API keeps the private session cookie and serializes article writes", async () => {
  const calls = [];
  const api = createAuthorApi({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify({ id: "article_1", status: "draft" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const article = await api.saveArticle({ title: "Private draft", content: "Body", publish: false });

  assert.equal(article.id, "article_1");
  assert.equal(calls[0].path, "/api/articles");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "Private draft", content: "Body", publish: false });
});

test("author API surfaces the Worker error message", async () => {
  const api = createAuthorApi({
    fetchImpl: async () => new Response(JSON.stringify({ error: "GitHub author required." }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    })
  });

  await assert.rejects(api.listArticles(), /GitHub author required/);
});
