import { AdminPage } from "@/components/admin/content/AdminPage";
import { MediaCard, MediaUpload } from "@/components/admin/content/MediaLibrary";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listMedia } from "@/lib/server/content-admin";

export default async function MediaAdmin() {
  await requireAdmin("content");
  const items = await listMedia(getDb(), { limit: 300 });
  return (
    <AdminPage
      title="Media library"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro={
        env.storageEnabled
          ? "Images and files for posts, events, products and settings. Uploads go to Supabase Storage."
          : "Images and files for posts, events, products and settings. Uploads are stored in this site's public/uploads folder until Supabase Storage is configured (see Integrations)."
      }
    >
      <MediaUpload />
      {items.length === 0 ? (
        <p className="empty-state">Nothing uploaded yet.</p>
      ) : (
        <ul className="media-grid">
          {items.map((m) => (
            <MediaCard key={m.id} item={{ id: m.id, url: m.url, alt: m.alt, filename: m.filename, mime: m.mime, size: m.size, width: m.width, height: m.height, uploadedBy: m.uploadedBy, createdAt: m.createdAt.toISOString() }} />
          ))}
        </ul>
      )}
    </AdminPage>
  );
}
