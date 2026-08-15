import { motion } from "framer-motion";
import type { MouseEvent, RefObject } from "react";
import { useLocale } from "../hooks/useLocale";
import { PublicNav } from "./PublicNav";
import { LocaleSwitch } from "./LocaleSwitch";
import type { Route } from "../types";
import type { HeroMorphResult } from "../hooks/useHeroMorph";

export interface SiteHeaderProps {
  route: Route;
  isHome: boolean;
  headerMotion: HeroMorphResult["header"];
  brandSlotRef: RefObject<HTMLDivElement | null>;
  navLinkRefs: RefObject<(HTMLAnchorElement | null)[]>;
  artworkSrc: string;
  onBrandClick: (e: MouseEvent) => void;
}

export function SiteHeader({ route, isHome, headerMotion, brandSlotRef, navLinkRefs, artworkSrc, onBrandClick }: SiteHeaderProps) {
  const { t } = useLocale();
  return (
    <motion.header
      className="topbar"
      style={{
        opacity: isHome ? headerMotion.opacity : 1,
        pointerEvents: isHome ? headerMotion.pointerEvents : "auto",
      }}
    >
      <a className="brand" href="#/" aria-label={t("brand.home")} onClick={onBrandClick}>
        <div ref={brandSlotRef} className="brand-slot">
          <img className="brand-mark" src={artworkSrc} alt="" />
        </div>
      </a>
      <PublicNav route={route} navLinkRefs={navLinkRefs} />
      <div className="topbar-tools">
        <LocaleSwitch />
      </div>
    </motion.header>
  );
}
