import { renderMarkdown } from "../lib/markdown.js";

export function Markdown({ content }) {
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
