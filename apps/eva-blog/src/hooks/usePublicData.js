import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/api.js";

export function usePublicData() {
  const [articles, setArticles] = useState([]);
  const [artworks, setArtworks] = useState([]);
  const [archives, setArchives] = useState([]);
  const [tags, setTags] = useState([]);
  const [series, setSeries] = useState([]);
  const [publicStatuses, setPublicStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [commentsByArticle, setCommentsByArticle] = useState(() => new Map());
  const [commentsLoading, setCommentsLoading] = useState(() => new Set());
  const requestedRef = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    async function refreshPublicData() {
      setLoading(true);
      try {
        const [articles, publicStatuses, archives, tags, series, artworks] = await Promise.all([
          requestJson("/api/articles"),
          requestJson("/api/status"),
          requestJson("/api/archives"),
          requestJson("/api/tags"),
          requestJson("/api/series"),
          requestJson("/api/artworks"),
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

  const loadComments = useCallback(async (articleId) => {
    if (requestedRef.current.has(articleId)) return;
    requestedRef.current.add(articleId);
    setCommentsLoading((current) => new Set(current).add(articleId));
    try {
      const comments = await requestJson(`/api/articles/${encodeURIComponent(articleId)}/comments`);
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

  const addComment = useCallback((articleId, comment) => {
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
