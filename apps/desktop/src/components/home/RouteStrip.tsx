import { Fragment } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "../Skeleton";
import { t } from "../../lib/i18n";
import type { RouteStep } from "../../lib/route-summary";

interface RouteStripProps {
  steps: RouteStep[];
  ruleGroup: string | null;
}

export function RouteStrip({ steps, ruleGroup }: RouteStripProps) {
  return <nav className="route-strip" aria-label={t("workspace.route")}>
    <div className="route-hops">
      {steps.map((step, index) => {
        const name = step.label ?? t(step.labelKey ?? "route.unknown");
        const content = <>
          {step.loading ? <Skeleton width="64px" height="16px" />
            : <span className="route-hop-name" title={name}>{name}</span>}
          {step.captionKey && <small>{t(step.captionKey)}</small>}
          {step.skipped && <span className="pill pill-muted">{t("route.fallback")}</span>}
        </>;
        return <Fragment key={step.id}>
          {index > 0 && <span className="route-arrow" aria-hidden="true">→</span>}
          {step.path
            ? <Link className="route-hop" to={step.path} data-skipped={step.skipped}>{content}</Link>
            : <span className="route-endpoint">{content}</span>}
        </Fragment>;
      })}
    </div>
    <Link className="route-rule-link" to="/routing" title={ruleGroup ?? undefined}>
      {t("route.rules")} · {ruleGroup ?? "—"}
    </Link>
  </nav>;
}
