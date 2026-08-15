import { renderMarkdown } from "../lib/markdown";

export interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
