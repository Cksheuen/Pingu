import { renderMarkdown } from "../lib/markdown";

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
