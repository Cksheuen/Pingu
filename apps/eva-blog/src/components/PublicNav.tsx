import { useLocale } from "../hooks/useLocale";
import type { RefObject } from "react";
import type { Route } from "../types";

const LINKS = [
  ["/", "nav.reader"],
  ["/archive", "nav.archive"],
  ["/now", "nav.now"],
  ["/gallery", "nav.gallery"],
];

export interface PublicNavProps {
  route: Route;
  navLinkRefs: RefObject<(HTMLAnchorElement | null)[]>;
}

export function PublicNav({ route, navLinkRefs }: PublicNavProps) {
  const { t } = useLocale();
  return (
    <nav className="public-nav" aria-label={t("nav.label")}>
      {LINKS.map(([path, key], i) => {
        const active = (path === "/" && route.name === "home") || (path !== "/" && route.name === path.slice(1));
        return (
          <a
            key={path}
            ref={(el) => { if (navLinkRefs) navLinkRefs.current[i] = el; }}
            className={active ? "active" : ""}
            href={`#${path}`}
          >
            {t(key)}
          </a>
        );
      })}
    </nav>
  );
}
