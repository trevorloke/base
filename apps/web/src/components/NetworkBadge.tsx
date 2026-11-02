import { networkLabel } from "../lib/format";

/** Text-only network badge. Color comes from the per-network token; no logos. */
export function NetworkBadge({ network, title, className }: { network: string; title?: string; className?: string }) {
  return (
    <span className={`netbadge${className ? ` ${className}` : ""}`} data-network={network} title={title ?? networkLabel(network)}>
      {networkLabel(network)}
    </span>
  );
}
