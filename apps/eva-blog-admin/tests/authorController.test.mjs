import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorController } from "../src/authorController.js";

function article(overrides = {}) {
  return {
    id: "article_1",
    title: "Field notes",
    slug: "field-notes",
    content: "A private draft body.",
    tags: ["notes"],
    status: "draft",
    updatedAt: "2026-08-12T09:00:00.000Z",
    readingMinutes: 1,
    excerpt: "A private draft body.",
    summary: null,
    ...overrides
  };
}

test("author controller only loads inventory for an allowlisted author", async () => {
  let inventoryRequests = 0;
  const controller = createAuthorController({
    api: {
      async getSession() {
        return { author: false, user: { login: "reader" } };
      },
      async listArticles() {
        inventoryRequests += 1;
        return [article()];
      }
    }
  });

  await controller.initialize();
  const state = controller.getState();

  assert.equal(state.authorized, false);
  assert.equal(state.session.login, "reader");
  assert.equal(state.articles.length, 0);
  assert.equal(inventoryRequests, 0);
});

test("author controller selects inventory, saves drafts, and publishes the returned article", async () => {
  const saved = [];
  const api = {
    async getSession() {
      return { author: true, user: { login: "eva-author" } };
    },
    async listArticles() {
      return [article({ id: "older", updatedAt: "2026-08-11T09:00:00.000Z" }), article()];
    },
    async saveArticle(input) {
      saved.push(input);
      return article({ ...input, id: "article_2", status: input.publish ? "published" : "draft", updatedAt: "2026-08-12T10:00:00.000Z" });
    },
    async publishArticle(id) {
      return article({ id, status: "published", updatedAt: "2026-08-12T11:00:00.000Z" });
    },
    async logout() {
      return {};
    }
  };
  const controller = createAuthorController({ api });

  await controller.initialize();
  assert.equal(controller.getState().selectedArticle.id, "article_1");

  await controller.saveArticle({ title: "Launch note", content: "A new draft." });
  assert.equal(saved[0].publish, false);
  assert.equal(controller.getState().selectedArticle.id, "article_2");
  assert.match(controller.getState().notice, /Draft saved/);

  await controller.publishArticle("article_2");
  assert.equal(controller.getState().selectedArticle.status, "published");
  assert.match(controller.getState().notice, /published/i);

  await controller.logout();
  assert.equal(controller.getState().articles.length, 0);
  assert.equal(controller.getState().session, null);
  assert.equal(controller.getState().authorized, false);
});

test("author controller imports Markdown through the same draft-save flow and retains errors for the view", async () => {
  const submissions = [];
  const controller = createAuthorController({
    parseMarkdown(filename, markdown) {
      return { title: filename, content: markdown, slug: "imported-note" };
    },
    api: {
      async getSession() {
        return { author: true, user: { login: "eva-author" } };
      },
      async listArticles() {
        return [];
      },
      async saveArticle(input) {
        submissions.push(input);
        throw new Error("Storage unavailable.");
      }
    }
  });

  await controller.initialize();
  await controller.importMarkdown("imported-note.md", "# Imported note");

  assert.equal(submissions[0].publish, false);
  assert.match(controller.getState().error, /Storage unavailable/);
  assert.equal(controller.getState().busy, false);
});
