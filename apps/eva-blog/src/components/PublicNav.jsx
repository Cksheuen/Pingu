import { useLocale } from "../hooks/useLocale.jsx";

const LINKS = [
  ["/", "nav.reader"],
  ["/archive", "nav.archive"],
  ["/now", "nav.now"],
  ["/gallery", "nav.gallery"],
];

export function PublicNav({ route }) {
  const { t } = useLocale();
  return (
    <nav className="public-nav" aria-label={t("nav.label")}>
      {LINKS.map(([path, key]) => {
        const active = (path === "/" && route.name === "home") || (path !== "/" && route.name === path.slice(1));
        return (
          <a key={path} className={active ? "active" : ""} href={`#${path}`}>
            {t(key)}
          </a>
        );
      })}
    </nav>
  );
}
