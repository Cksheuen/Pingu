import type { Comment, Session } from "../types";

type SessionLike = {
  id?: string | number;
  login?: string;
  name?: string;
  avatarUrl?: string;
  provider?: string;
};

export function isAuthenticated(session: SessionLike | null | undefined): boolean {
  return Boolean(session && session.provider && session.login);
}

export function requireAuthenticated(session: SessionLike | null | undefined): asserts session is SessionLike {
  if (!isAuthenticated(session)) {
    throw new Error("A signed-in GitHub user is required.");
  }
}

export interface CreateCommentInput {
  id?: string;
  articleId: string;
  body?: string;
  session: SessionLike;
}

export function createComment(input: CreateCommentInput, options: { now?: string } = {}): Comment {
  const session = input.session;
  requireAuthenticated(session);

  const body = String(input.body || "").trim();
  if (!body) {
    throw new Error("Comment body is required.");
  }
  if (body.length > 1200) {
    throw new Error("Comment body must be 1200 characters or fewer.");
  }

  const now = options.now || new Date().toISOString();
  return {
    id: input.id || commentId(now),
    articleId: input.articleId,
    body,
    author: {
      id: session.id as string | number,
      login: session.login as string,
      name: session.name || (session.login as string),
      avatarUrl: session.avatarUrl || ""
    },
    createdAt: now
  };
}

export function listCommentsForArticle<T extends { articleId?: string; createdAt?: string }>(comments: T[], articleId: string): T[] {
  return [...comments]
    .filter((comment) => comment.articleId === articleId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function commentId(now: string): string {
  return `comment_${Date.parse(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type { Session };
