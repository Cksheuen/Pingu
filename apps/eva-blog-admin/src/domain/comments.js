export function isAuthenticated(session) {
  return Boolean(session && session.provider && session.login);
}

export function requireAuthenticated(session) {
  if (!isAuthenticated(session)) {
    throw new Error("A signed-in GitHub user is required.");
  }
}

export function createComment(input, options = {}) {
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
      id: session.id,
      login: session.login,
      name: session.name || session.login,
      avatarUrl: session.avatarUrl || ""
    },
    createdAt: now
  };
}

export function listCommentsForArticle(comments, articleId) {
  return [...comments]
    .filter((comment) => comment.articleId === articleId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function commentId(now) {
  return `comment_${Date.parse(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
