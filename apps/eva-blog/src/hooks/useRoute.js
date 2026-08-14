import { useEffect, useState } from "react";

export function currentRoute() {
  const hash = window.location.hash || "#/";
  if (window.location.pathname.startsWith("/article/")) return { name: "article" };
  if (window.location.pathname.startsWith("/gallery/")) return { name: "gallery", artworkSlug: decodeURIComponent(window.location.pathname.slice("/gallery/".length)) };
  if (hash.startsWith("#/article/")) return { name: "article" };
  if (hash === "#/archive") return { name: "archive" };
  if (hash === "#/now") return { name: "now" };
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return { name: "gallery", artworkSlug: hash.startsWith("#/gallery/") ? decodeURIComponent(hash.slice("#/gallery/".length)) : null };
  return { name: "home" };
}

export function parseArticleSlugFromLocation() {
  const pathMatch = window.location.pathname.match(/^\/article\/([^/]+)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const match = (window.location.hash || "").match(/^#\/article\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function readLocation() {
  return { route: currentRoute(), selectedSlug: parseArticleSlugFromLocation() };
}

export function useRoute() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const onChange = () => setLocation(readLocation());
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return location;
}
