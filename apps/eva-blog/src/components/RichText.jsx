// 仅用于 4 个含 HTML 的 i18n key（home/archive/now/gallery 的 title）。
export function RichText({ text }) {
  return <span dangerouslySetInnerHTML={{ __html: text }} />;
}
