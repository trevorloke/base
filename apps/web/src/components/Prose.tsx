/** Plain-text body with blank lines between paragraphs. */
export function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      {text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  );
}
