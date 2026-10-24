import type { ReactNode } from "react";

export function SectionHeader({ title, children }: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="section-header">
      <h2 className="section-title">{title}</h2>
      {children && <div className="network-actions">{children}</div>}
    </header>
  );
}
