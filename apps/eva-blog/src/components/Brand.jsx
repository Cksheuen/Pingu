import { useLocale } from "../hooks/useLocale.jsx";

export function Brand({ onClick }) {
  const { t } = useLocale();
  return (
    <a className="brand" href="#/" aria-label={t("brand.home")} onClick={onClick}>
      <img className="brand-mark" src="/public/assets/blog-cover.png" alt="" />
      <span>
        <strong>Eva Blog</strong>
        <small>{t("brand.tagline")}</small>
      </span>
    </a>
  );
}
