export function ReadingProgress({ progressRef }) {
  return (
    <div className="reading-progress" aria-hidden="true">
      <span ref={progressRef} />
    </div>
  );
}
