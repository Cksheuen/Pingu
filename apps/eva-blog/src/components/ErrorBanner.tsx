export interface ErrorBannerProps {
  error: string;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  if (!error) return null;
  return <div className="banner error" role="alert">{error}</div>;
}
