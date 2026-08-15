// 仅用于 4 个含 HTML 的 i18n key（home/archive/now/gallery 的 title）。
interface RichTextProps {
  html: string;
}

export function RichText({ html }: RichTextProps) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
