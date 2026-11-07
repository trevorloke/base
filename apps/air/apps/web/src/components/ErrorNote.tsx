import { useRoom } from "../lib/room";

/**
 * An inline error. When the server says a spend cap was reached, it also links to where the cap is raised, so the
 * message isn't a dead end.
 */
export function ErrorNote({ text }: { text: string }) {
  const { openSettings } = useRoom();
  const cap = /spend cap/i.test(text);
  return (
    <div className="card-error" role="alert">
      {text}
      {cap ? (
        <>
          {" "}
          <button type="button" className="linkish strong" onClick={() => openSettings("spend")}>
            Spend caps in Settings
          </button>
        </>
      ) : null}
    </div>
  );
}
