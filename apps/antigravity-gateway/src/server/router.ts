export interface RouteMatch {
  name: string;
  params: Record<string, string>;
}

interface RouteEntry {
  method: string;
  pathname: string;
  name: string;
}

const ROUTES: RouteEntry[] = [
  { method: "POST", pathname: "/v1/messages", name: "messages" },
  { method: "POST", pathname: "/v1/chat/completions", name: "chat-completions" },
  { method: "POST", pathname: "/v1/responses", name: "responses" },
  { method: "POST", pathname: "/v1/responses/compact", name: "responses-compact" },
  { method: "GET", pathname: "/v1/models", name: "models" },
  { method: "GET", pathname: "/healthz", name: "healthz" }
];

export function route(method: string, pathname: string): RouteMatch | undefined {
  const match = ROUTES.find((entry) => entry.method === method && entry.pathname === pathname);
  return match ? { name: match.name, params: {} } : undefined;
}
