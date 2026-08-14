function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

export function renderMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let codeOpen = false;
  for (const line of lines) {
    if (line.startsWith("```")) { if (listOpen) { html.push("</ul>"); listOpen = false; } html.push(codeOpen ? "</code></pre>" : "<pre><code>"); codeOpen = !codeOpen; continue; }
    if (codeOpen) { html.push(escapeHtml(line) + "\n"); continue; }
    if (!line.trim()) { if (listOpen) { html.push("</ul>"); listOpen = false; } continue; }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) { html.push(`<figure class="manuscript-image"><img src="${safeUrl(image[2])}" alt="${escapeAttr(image[1])}" loading="lazy"><figcaption>${escapeHtml(image[1])}</figcaption></figure>`); continue; }
    if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) { if (listOpen) { html.push("</ul>"); listOpen = false; } const depth = line.match(/^#+/)[0].length; const text = line.slice(depth + 1); html.push(`<h${Math.min(3, depth)} id="${escapeAttr(slugify(text))}">${escapeHtml(text)}</h${Math.min(3, depth)}>`); }
    else if (line.startsWith("- ")) { if (!listOpen) { html.push("<ul>"); listOpen = true; } html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`); }
    else { if (listOpen) { html.push("</ul>"); listOpen = false; } html.push(`<p>${inlineMarkdown(line)}</p>`); }
  }
  if (listOpen) html.push("</ul>");
  if (codeOpen) html.push("</code></pre>");
  return html.join("");
}

export function inlineMarkdown(value) {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function outlineFromContent(content) {
  return String(content || "").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    return match ? [{ depth: match[1].length, text: match[2], id: slugify(match[2]) }] : [];
  });
}

export function slugify(value) {
  return String(value || "section").toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

export function safeUrl(value) {
  const url = String(value || "").trim();
  return /^(https?:\/\/|\/|\.\/)/i.test(url) ? escapeAttr(url) : "";
}
