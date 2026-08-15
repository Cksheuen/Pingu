import { useState, useEffect } from "react";
import { useLocale } from "../hooks/useLocale";
import { matchesArticleQuery } from "../domain/publicBlog";
import { ArticleCard } from "../components/ArticleCard";
import { EmptyState } from "../components/EmptyState";
import { RichText } from "../components/RichText";
import type { PublicArticle } from "../types";
import type { ArchiveGroup, TagCount, SeriesGroup } from "../hooks/usePublicData";

interface ArchiveViewProps {
  articles: PublicArticle[];
  archives: ArchiveGroup[];
  tags: TagCount[];
  series: SeriesGroup[];
}

export function ArchiveView({ articles, archives, tags, series }: ArchiveViewProps) {
  const { t } = useLocale();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filtered = articles.filter((article) => matchesArticleQuery(article, search));

  const selectTag = (tag: string) => {
    // 与旧版一致：tag 点击立即生效，不等 300ms debounce。
    setSearchInput(tag);
    setSearch(tag);
  };

  return (
    <section className="archive-view route-enter">
      <div className="archive-intro">
        <div>
          <p className="eyebrow">{t("archive.kicker", { count: String(articles.length).padStart(2, "0") })}</p>
          <h1><RichText html={t("archive.title")} /></h1>
        </div>
        <p>{t("archive.intro")}</p>
      </div>
      <label className="archive-search">
        <span>{t("archive.search")}</span>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("archive.placeholder")}
        />
      </label>
      <div className="archive-layout">
        <div className="archive-stream">
          {filtered.length ? (
            filtered.map((article, index) => (
              <ArticleCard key={article.id} article={article} variant={index === 0 ? "archive-feature" : ""} />
            ))
          ) : (
            <EmptyState text={t("archive.empty")} />
          )}
        </div>
        <aside className="archive-index">
          <p className="eyebrow">{t("archive.index")}</p>
          <h2>{t("archive.year")}</h2>
          {archives.map((group) => (
            <div key={group.year} className="index-year">
              <strong>{group.year}</strong>
              <span>{t("archive.notes", { count: group.entries.length })}</span>
            </div>
          ))}
          <h2 className="index-subhead">{t("archive.tag")}</h2>
          <div className="tag-cloud">
            {tags.slice(0, 12).map((tag) => (
              <button key={tag.tag} type="button" onClick={() => selectTag(tag.tag)}>
                {tag.tag} <small>{tag.count}</small>
              </button>
            ))}
          </div>
          {series.length > 0 && (
            <>
              <h2 className="index-subhead">{t("archive.series")}</h2>
              {series.map((s) => (
                <div key={s.title} className="series-index">
                  <strong>{s.title}</strong>
                  <span>{t("archive.parts", { count: s.entries.length })}</span>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
