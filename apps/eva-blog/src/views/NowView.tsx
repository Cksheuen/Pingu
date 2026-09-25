import { useLocale } from "../hooks/useLocale";
import { describeLocalizedStatus } from "../services/locale";
import { EmptyState } from "../components/EmptyState";
import { HeroSection } from "../components/HeroSection";
import type { PublicStatus } from "../types";
import type { HeroProps } from "../hooks/heroTypes";

interface NowViewProps extends HeroProps {
  publicStatuses: PublicStatus[];
}

export function NowView({ publicStatuses, heroRef, heroTabRefs, heroTextItems }: NowViewProps) {
  const { t, locale, formatDate } = useLocale();

  const localizedKind = (kind: string) => {
    if (kind === "song") return t("status.listening");
    if (kind === "work") return t("status.working");
    if (kind === "token") return t("status.token");
    return t("status.active");
  };

  return (
    <>
      <HeroSection
        heroRef={heroRef}
        heroTabRefs={heroTabRefs}
        heroTextItems={heroTextItems}
        kicker={t("now.kicker")}
        titleHtml={t("now.title")}
        intro={t("now.intro")}
        primaryHref="#/archive"
        primaryLabel={t("now.heroCta")}
        secondaryHref="#/gallery"
        secondaryLabel={t("now.heroCtaSecondary")}
      />
      <section className="now-view route-enter">
        <div className="now-timeline">
          {publicStatuses.length ? (
            publicStatuses.map((status, index) => (
              <article key={status.id} className="now-entry">
                <span className="now-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="now-entry-main">
                  <div className="now-entry-meta">
                    <span>{localizedKind(status.kind || "")}</span>
                    <time>{formatDate(status.updatedAt || status.createdAt)}</time>
                  </div>
                  <h2>{status.title || describeLocalizedStatus(status, locale)}</h2>
                  <p>{status.details || describeLocalizedStatus(status, locale)}</p>
                  {status.meta && (
                    <div className="signal-meta">
                      {Object.entries(status.meta)
                        .filter(([key]) => ["track", "artist", "service", "usagePercent", "unit"].includes(key))
                        .map(([key, value]) => (
                          <span key={key}>{t(`status.meta.${key}`)}: {String(value)}</span>
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
    </>
  );
}
