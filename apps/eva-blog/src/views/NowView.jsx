import { useLocale } from "../hooks/useLocale.jsx";
import { describeLocalizedStatus } from "../services/locale.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { RichText } from "../components/RichText.jsx";

export function NowView({ publicStatuses }) {
  const { t, locale, formatDate } = useLocale();

  const localizedKind = (kind) => {
    if (kind === "song") return t("status.listening");
    if (kind === "work") return t("status.working");
    if (kind === "token") return t("status.token");
    return t("status.active");
  };

  return (
    <section className="now-view route-enter">
      <div className="now-intro">
        <p className="eyebrow">{t("now.kicker")}</p>
        <h1><RichText html={t("now.title")} /></h1>
        <p>{t("now.intro")}</p>
      </div>
      <div className="now-timeline">
        {publicStatuses.length ? (
          publicStatuses.map((status, index) => (
            <article key={status.id} className="now-entry">
              <span className="now-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="now-entry-main">
                <div className="now-entry-meta">
                  <span>{localizedKind(status.kind)}</span>
                  <time>{formatDate(status.updatedAt || status.createdAt)}</time>
                </div>
                <h2>{status.title || describeLocalizedStatus(status, locale)}</h2>
                <p>{status.details || describeLocalizedStatus(status, locale)}</p>
                {status.meta && (
                  <div className="signal-meta">
                    {Object.entries(status.meta)
                      .filter(([key]) => ["track", "artist", "service", "usagePercent", "unit"].includes(key))
                      .map(([key, value]) => (
                        <span key={key}>{t(`status.meta.${key}`)}: {value}</span>
                      ))}
                  </div>
                )}
              </div>
            </article>
          ))
        ) : (
          <EmptyState text={t("now.empty")} />
        )}
      </div>
    </section>
  );
}
