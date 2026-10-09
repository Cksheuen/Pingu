import type { ReactNode } from "react";

export function SectionHeader({ title, embedded = false, children }: {
  title: string;
  embedded?: boolean;
  children?: ReactNode;
}) {
  const Heading = embedded ? "h2" : "h1";
  return <header className={embedded ? "section-header" : "page-header"}>
    <Heading className={embedded ? "section-title" : "page-title"}>{title}</Heading>
    {children && <div className="network-actions">{children}</div>}
  </header>;
}
