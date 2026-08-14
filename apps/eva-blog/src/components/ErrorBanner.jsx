export function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="banner error" role="alert">{error}</div>;
}
