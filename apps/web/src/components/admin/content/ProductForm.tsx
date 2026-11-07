"use client";

import { useState } from "react";
import { saveProduct } from "@/app/admin/(secure)/content/products/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { Checkbox, TextField } from "@/components/forms/Field";
import { centsToDollars } from "./fields";
import { ImageField } from "./ImageField";
import { MarkdownEditor } from "./MarkdownEditor";
import { TitleSlugFields } from "./TitleSlugFields";
import { useCmsForm } from "./useCmsForm";

export type ProductFormValues = {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  tileLabel: string;
  tileBackground: string;
  tileForeground: string;
  imageUrl: string | null;
  active: boolean;
  sortOrder: number;
};

export function ProductForm({ product }: { product?: ProductFormValues }) {
  const form = useCmsForm(saveProduct);
  const { state } = form;
  const [tile, setTile] = useState({ label: product?.tileLabel ?? "", bg: product?.tileBackground ?? "#003979", fg: product?.tileForeground ?? "#FFF100" });
  return (
    <form key={form.key} action={form.action} className="cms-form">
      {product && <input type="hidden" name="id" value={product.id} />}
      <TitleSlugFields titleLabel="Product name" defaultTitle={form.text("title", product?.name)} defaultSlug={form.text("slug", product?.slug)} urlPrefix="/shop#" titleError={fieldError(state, "title")} slugError={fieldError(state, "slug")} titleMax={120} />
      <div className="form-row">
        <TextField id="price" name="price" label="Price in dollars" required inputMode="decimal" defaultValue={form.text("price", product ? centsToDollars(product.priceCents) : "")} placeholder="20.00" error={fieldError(state, "price")} style={{ maxWidth: 180 }} />
        <TextField id="sortOrder" name="sortOrder" type="number" step={1} min={0} max={1000} label="Sort order (lowest first)" defaultValue={form.text("sortOrder", product?.sortOrder ?? 0)} error={fieldError(state, "sortOrder")} style={{ maxWidth: 180 }} />
      </div>
      <MarkdownEditor id="description" name="description" label="Description" defaultValue={form.text("description", product?.description)} maxLength={5000} rows={6} error={fieldError(state, "description")} />

      <h2>How it looks in the shop</h2>
      <p className="hint">A photo replaces the coloured tile when one is set.</p>
      <ImageField defaultUrl={form.text("imageUrl", product?.imageUrl)} showAlt={false} urlError={fieldError(state, "imageUrl")} />
      <div className="form-row">
        <TextField id="tileLabel" name="tileLabel" label="Tile text" required maxLength={60} value={tile.label} onChange={(e) => setTile({ ...tile, label: e.target.value })} error={fieldError(state, "tileLabel")} />
        <div className="field">
          <span className="field-label">Tile preview</span>
          <div className="tile-preview" style={{ background: tile.bg, color: tile.fg }} aria-hidden="true">
            {tile.label || "Tile text"}
          </div>
        </div>
      </div>
      <div className="color-row">
        <TextField id="tileBackground" name="tileBackground" type="color" label="Tile background" value={tile.bg} onChange={(e) => setTile({ ...tile, bg: e.target.value })} error={fieldError(state, "tileBackground")} />
        <TextField id="tileForeground" name="tileForeground" type="color" label="Tile text colour" value={tile.fg} onChange={(e) => setTile({ ...tile, fg: e.target.value })} error={fieldError(state, "tileForeground")} />
      </div>
      <Checkbox name="active" defaultChecked={form.checked("active", product ? product.active : true)}>
        For sale (shown in the shop)
      </Checkbox>
      <Notice state={state} />
      <div className="cms-publish">
        <SubmitButton className="btn btn--accent">{product ? "Save changes" : "Add product"}</SubmitButton>
      </div>
    </form>
  );
}
