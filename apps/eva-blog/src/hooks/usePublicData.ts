import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/api";
import type { Comment, PublicArticle, PublicArtwork, PublicStatus } from "../types";

export interface ArchiveGroup {
  year: string;
  entries: PublicArticle[];
}

export interface TagCount {
  tag: string;
  count: number;
  slug: string;
}

export interface SeriesGroup {
  title: string;
  slug: string;
  order?: number;
  entries: PublicArticle[];
}

export interface PublicData {
  articles: PublicArticle[];
  artworks: PublicArtwork[];
  archives: ArchiveGroup[];
  tags: TagCount[];
  series: SeriesGroup[];
  publicStatuses: PublicStatus[];
  loading: boolean;
  error: string;
  setError: (error: string) => void;
  commentsByArticle: Map<string, Comment[]>;
  commentsLoading: Set<string>;
  loadComments: (articleId: string) => Promise<void>;
  addComment: (articleId: string, comment: Comment) => void;
}

export function usePublicData(): PublicData {
  const [articles, setArticles] = useState<PublicArticle[]>([]);
  const [artworks, setArtworks] = useState<PublicArtwork[]>([]);
  const [archives, setArchives] = useState<ArchiveGroup[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [series, setSeries] = useState<SeriesGroup[]>([]);
  const [publicStatuses, setPublicStatuses] = useState<PublicStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [commentsByArticle, setCommentsByArticle] = useState<Map<string, Comment[]>>(() => new Map());
  const [commentsLoading, setCommentsLoading] = useState<Set<string>>(() => new Set());
  const requestedRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    async function refreshPublicData(): Promise<void> {
      setLoading(true);
      try {
        const [articles, publicStatuses, archives, tags, series, artworks] = await Promise.all([
          requestJson<PublicArticle[]>("/api/articles"),
          requestJson<PublicStatus[]>("/api/status"),
          requestJson<ArchiveGroup[]>("/api/archives"),
          requestJson<TagCount[]>("/api/tags"),
          requestJson<SeriesGroup[]>("/api/series"),
          requestJson<PublicArtwork[]>("/api/artworks"),
        ]);
        if (cancelled) return;
        setArticles(Array.isArray(articles) ? articles : []);
        setPublicStatuses(Array.isArray(publicStatuses) ? publicStatuses : []);
        setArchives(Array.isArray(archives) ? archives : []);
        setTags(Array.isArray(tags) ? tags : []);
        setSeries(Array.isArray(series) ? series : []);
        setArtworks(Array.isArray(artworks) ? artworks : []);
        setLoading(false);
        setError("");
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setError(error instanceof Error ? error.message : String(error));
      }
    }
    refreshPublicData();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadComments = useCallback(async (articleId: string): Promise<void> => {
    if (requestedRef.current.has(articleId)) return;
    requestedRef.current.add(articleId);
    setCommentsLoading((current) => new Set(current).add(articleId));
    try {
      const comments = await requestJson<Comment[]>(`/api/articles/${encodeURIComponent(articleId)}/comments`);
      setCommentsByArticle((current) => new Map(current).set(articleId, Array.isArray(comments) ? comments : []));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommentsLoading((current) => {
        const next = new Set(current);
        next.delete(articleId);
        return next;
      });
    }
  }, []);

  const addComment = useCallback((articleId: string, comment: Comment): void => {
    setCommentsByArticle((current) => new Map(current).set(articleId, [...(current.get(articleId) || []), comment]));
  }, []);

  return {
    articles,
    artworks,
    archives,
    tags,
    series,
    publicStatuses,
    loading,
    error,
    setError,
    commentsByArticle,
    commentsLoading,
    loadComments,
    addComment,
  };
}
