export function ArtworkImage({ artwork, className }) {
  const asset = artwork.assets?.[0];
  if (asset) {
    return <img className={className} src={asset.src} alt={asset.altText || artwork.altText || artwork.title} loading="lazy" />;
  }
  return (
    <div className={`${className} artwork-placeholder`} aria-label={artwork.altText || artwork.title}>
      <span>{artwork.title.slice(0, 1)}</span>
    </div>
  );
}
