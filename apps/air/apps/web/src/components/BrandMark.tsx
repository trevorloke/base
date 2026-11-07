import { useState } from "react";
import { useBrand } from "../lib/brand";

/** The workspace's logo, when its brand has one. A logo that fails to load quietly disappears. */
export function BrandMark({ className = "brand-logo-img" }: { className?: string }) {
  const brand = useBrand();
  const [failed, setFailed] = useState<string | null>(null);
  if (!brand.logoUrl || failed === brand.logoUrl) return null;
  return <img className={className} src={brand.logoUrl} alt={brand.name ? `${brand.name} logo` : "Logo"} onError={() => setFailed(brand.logoUrl)} />;
}
