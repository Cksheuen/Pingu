import { useLocale } from "../hooks/useLocale.jsx";
import { Brand } from "./Brand.jsx";
import { PublicNav } from "./PublicNav.jsx";
import { LocaleSwitch } from "./LocaleSwitch.jsx";

export function SiteHeader({ route, condensed = false, onBrandClick }) {
  const { t } = useLocale();
  return (
    <header className={condensed ? "topbar is-condensed" : "topbar"}>
      <Brand onClick={onBrandClick} />
      <PublicNav route={route} />
      <div className="topbar-tools">
        <div className="public-label">
          <span className="signal-dot" />
          {t("public.readOnly")}
        </div>
        <LocaleSwitch />
      </div>
    </header>
  );
}
