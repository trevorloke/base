import Image from "next/image";

/**
 * next/image for an image whose address comes from settings. Files in public/
 * are optimized; uploaded images on another host are served as they are, since
 * no remote image hosts are configured. Width and height set the aspect ratio
 * so nothing shifts while the image loads.
 */
export function SiteImage(props: { src: string; alt: string; width: number; height: number; sizes?: string; className?: string; priority?: boolean }) {
  const local = props.src.startsWith("/") && !props.src.startsWith("//");
  return (
    <Image
      src={props.src}
      alt={props.alt}
      width={props.width}
      height={props.height}
      sizes={props.sizes}
      className={props.className}
      priority={props.priority}
      unoptimized={!local}
    />
  );
}
