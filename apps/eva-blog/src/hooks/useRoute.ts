import { useEffect, useState } from "react";
import type { Route, RouteLocation } from "../types";

export function currentRoute(): Route {
  const hash = window.location.hash || "#/";
  if (window.location.pathname.startsWith("/article/")) return { name: "article" };
  if (window.location.pathname.startsWith("/gallery/")) return { name: "gallery", artworkSlug: decodeURIComponent(window.location.pathname.slice("/gallery/".length)) };
  if (hash.startsWith("#/article/")) return { name: "article" };
  if (hash === "#/archive") return { name: "archive" };
  if (hash === "#/now") return { name: "now" };
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return { name: "gallery", artworkSlug: hash.startsWith("#/gallery/") ? decodeURIComponent(hash.slice("#/gallery/".length)) : null };
  return { name: "home" };
}

export function parseArticleSlugFromLocation(): string | null {
  const pathMatch = window.location.pathname.match(/^\/article\/([^/]+)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const match = (window.location.hash || "").match(/^#\/article\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function readLocation(): RouteLocation {
  return { route: currentRoute(), selectedSlug: parseArticleSlugFromLocation() };
}

export function useRoute(): RouteLocation {
  const [location, setLocation] = useState<RouteLocation>(readLocation);
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
