import { motion, useReducedMotion } from "framer-motion";
import type { RefObject } from "react";
import { useLocale } from "../hooks/useLocale";
import { RichText } from "./RichText";
import type { PublicArticle } from "../types";
import type { HeroTextMotion } from "../hooks/useHeroMorph";

export interface HomeHeroProps {
  article: PublicArticle | null;
  heroRef: RefObject<HTMLElement | null>;
  heroTabRefs: RefObject<(HTMLAnchorElement | null)[]>;
  heroTextItems: HeroTextMotion[];
}

const HERO_TABS = [
  ["/", "nav.reader"],
  ["/archive", "nav.archive"],
  ["/now", "nav.now"],
  ["/gallery", "nav.gallery"],
];

// 入场：逐元素 stagger，统一 easeOutQuint 曲线
const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.12 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 26 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } },
};

const reducedItemVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
};

export function HomeHero({ article, heroRef, heroTabRefs, heroTextItems }: HomeHeroProps) {
  const { t } = useLocale();
  const reduced = useReducedMotion();
  const item = reduced ? reducedItemVariants : itemVariants;

  // 拆分标题为两行，分别独立动画
  const titleParts = t("home.title").split(/<br\s*\/?>/i);

  // 顺序与 useHeroMorph 的 EXIT_WINDOWS 一一对应
  const items = [
    <p className="eyebrow">{t("home.kicker")}</p>,
    <span className="h1-line">{titleParts[0]}</span>,
    <span className="h1-line"><RichText html={titleParts[1] || ""} /></span>,
    <p className="hero-intro">{t("home.intro")}</p>,
    <div className="hero-actions">
      <a className="primary-link" href={article ? `#/article/${encodeURIComponent(article.slug)}` : "#/archive"}>
        {t(article ? "home.latest" : "home.archive")} <span>↗</span>
      </a>
      <a className="text-link" href="#/gallery">{t("home.gallery")}</a>
    </div>,
  ];

  return (
    <section ref={heroRef} className="home-hero">
      <div className="hero-bg">
        <div className="hero-bg-overlay" />
      </div>
      <div className="hero-copy">
        {/* 入场动画（挂载时）与滚动淡出（useHeroMorph 每元素独立）作用在不同层级，互不冲突 */}
        <motion.div initial="hidden" animate="show" variants={containerVariants}>
          {items.map((child, i) => (
            <motion.div
              key={i}
              className="hero-exit-layer"
              style={{
                opacity: heroTextItems[i].opacity,
                y: heroTextItems[i].y,
                x: heroTextItems[i].x,
                scale: heroTextItems[i].scale,
                letterSpacing: heroTextItems[i].letterSpacing,
                rotate: heroTextItems[i].rotate,
              }}
            >
              <motion.div variants={item}>{child}</motion.div>
            </motion.div>
          ))}
        </motion.div>
        {/* 原始 tabs 仅作布局占位，flying tabs 会覆盖在上面。
            保持在动画容器之外，避免入场 transform 影响起飞位置测量 */}
        <nav className="hero-tabs" aria-hidden="true" style={{ opacity: 0 }}>
          {HERO_TABS.map(([path, key], i) => (
            <a
              key={path}
              ref={(el) => { if (heroTabRefs) heroTabRefs.current[i] = el; }}
              href={`#${path}`}
              tabIndex={-1}
            >
              {t(key)}
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}
