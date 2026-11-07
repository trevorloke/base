import type { CallToAction, MastodonVisibility, Network, PostKind, Privacy, VariantOptions } from "../../types";
import { duration, NETWORK_MAX_MEDIA, NETWORK_MAX_VIDEO_SECONDS, NETWORK_NEEDS_MEDIA, networkLabel, postKindLabel } from "../../lib/format";
import type { MediaItem } from "./MediaTray";

/**
 * TikTok's content-posting audit asks for choices the shared VariantOptions has no field for (the music
 * confirmation is a gate in the composer, never sent). Kept beside the options, per variant.
 */
export interface TikTokExtras {
  disclose: boolean;
  yourBrand: boolean;
  branded: boolean;
  musicOk: boolean;
}

export const NO_TIKTOK: TikTokExtras = { disclose: false, yourBrand: false, branded: false, musicOk: false };

/** Networks that refuse a post without a title. */
const TITLE_NETS = new Set<Network>(["youtube", "reddit", "pinterest", "wordpress", "ghost", "lemmy", "zalo"]);
/** Networks that take a title (or subject line) but fall back to the post's first line without one. */
const OPTIONAL_TITLE_NETS = new Set<Network>(["wechat", "mailchimp", "kit", "tumblr"]);
const TITLE_MAX: Partial<Record<Network, number>> = { youtube: 100, reddit: 300, pinterest: 100, ghost: 255, lemmy: 200, zalo: 150, wechat: 64, mailchimp: 150, kit: 150 };
const TITLE_PLACEHOLDER: Partial<Record<Network, string>> = {
  youtube: "What the video is about",
  reddit: "A title the subreddit will read",
  pinterest: "What the pin shows",
  wordpress: "The post's headline",
  ghost: "The post's headline",
  lemmy: "A title the community will read",
  zalo: "The article's headline",
  wechat: "Article title (标题); empty uses the first line",
  mailchimp: "Subject line; empty uses the first line",
  kit: "Subject line; empty uses the first line",
  tumblr: "A heading above the post (optional)",
};
const FIRST_COMMENT_NETS = new Set<Network>(["instagram", "facebook", "linkedin", "youtube", "reddit"]);
const LINK_NETS = new Set<Network>(["facebook", "linkedin", "pinterest", "reddit"]);
const POLL_NETS = new Set<Network>(["x", "mastodon", "telegram"]);
const POLL_LIMITS: Partial<Record<Network, { options: number; chars: number }>> = {
  x: { options: 4, chars: 25 },
  mastodon: { options: 4, chars: 50 },
  telegram: { options: 10, chars: 100 },
};
const POLL_DURATIONS: [number, string][] = [
  [60, "1 hour"],
  [360, "6 hours"],
  [1440, "1 day"],
  [4320, "3 days"],
  [10080, "7 days"],
];
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]+$/i;

const CTA_LABEL: Record<CallToAction, string> = {
  BOOK: "Book",
  ORDER: "Order online",
  SHOP: "Shop",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  CALL: "Call now",
};

const TIKTOK_PRIVACY: [Privacy, string][] = [
  ["public", "Everyone"],
  ["friends", "Friends (followers you follow back)"],
  ["followers", "Followers"],
  ["self", "Only me"],
];

const MASTODON_VISIBILITY: [MastodonVisibility, string][] = [
  ["public", "Public"],
  ["unlisted", "Quiet public"],
  ["private", "Followers only"],
  ["direct", "Mentioned people only"],
];

/** Whether a network has fields of its own beyond the text (link tracking, when on, is shown for every network regardless). */
export function hasOptions(network: Network, kinds: string[]): boolean {
  return selectableKinds(kinds).length > 1 || TITLE_NETS.has(network) || OPTIONAL_TITLE_NETS.has(network) || FIRST_COMMENT_NETS.has(network) || LINK_NETS.has(network) || POLL_NETS.has(network) || ["tiktok", "mastodon", "google_business"].includes(network);
}

/** Poll is a toggle of its own, so it never shows as a kind. */
function selectableKinds(kinds: string[]): string[] {
  return kinds.filter((k) => k !== "poll");
}

/** Which attachments a network takes by default: what fits, documents only where they post (LinkedIn). */
export function defaultPick(network: Network, items: MediaItem[]): string[] {
  const usable = items.filter((m) => m.status !== "failed" && (m.kind !== "document" || network === "linkedin"));
  if (network === "youtube") {
    const v = usable.find((m) => m.kind === "video");
    return v ? [v.id] : [];
  }
  return usable.slice(0, NETWORK_MAX_MEDIA[network]).map((m) => m.id);
}

/**
 * The server's rules, said before sending: media where a network needs it, titles, subreddits, boards,
 * TikTok's required choices, and what each post kind needs.
 */
export function variantProblems(network: Network, kinds: string[], o: VariantOptions, tt: TikTokExtras, media: MediaItem[]): string[] {
  const label = networkLabel(network);
  const out: string[] = [];
  const ready = media.filter((m) => m.status === "ready");
  const videos = ready.filter((m) => m.kind === "video");
  const kind = (o.kind ?? selectableKinds(kinds)[0] ?? "post") as PostKind;

  if (NETWORK_NEEDS_MEDIA.has(network) && !media.length) {
    out.push(network === "youtube" ? "YouTube needs a video" : network === "tiktok" ? "TikTok needs a video or photos" : network === "wechat" || network === "zalo" ? `${label} articles need a cover image` : `${label} needs an image or video`);
  }
  if (network === "youtube" && media.length && !videos.length) out.push("YouTube needs a video, not an image");
  if (media.length > NETWORK_MAX_MEDIA[network]) out.push(`${label} takes at most ${NETWORK_MAX_MEDIA[network]} ${NETWORK_MAX_MEDIA[network] === 1 ? "attachment" : "attachments"}`);
  if (network !== "linkedin" && media.some((m) => m.kind === "document")) out.push(`${label} can't post a PDF`);
  const cap = kind === "short" ? 180 : NETWORK_MAX_VIDEO_SECONDS[network];
  const long = videos.find((m) => cap && m.durationSeconds && m.durationSeconds > cap);
  if (long && cap) out.push(`${kind === "short" ? "Shorts" : label} take videos up to ${duration(cap)}; this one is ${duration(long.durationSeconds)}`);

  // Say which network: with several selected, "A carousel needs…" leaves the person hunting for the variant.
  if ((kind === "reel" || kind === "video" || kind === "short") && media.length && !videos.length) out.push(`${label} ${postKindLabel(kind).toLowerCase()}: attach a video file, not an image`);
  if (kind === "carousel" && media.length < 2) out.push(`${label} carousel needs at least 2 images or videos`);
  if (kind === "story" && media.length !== 1) out.push(`${label} story takes exactly 1 image or video`);

  if (TITLE_NETS.has(network) || OPTIONAL_TITLE_NETS.has(network)) {
    const t = (o.title ?? "").trim();
    const max = TITLE_MAX[network];
    if (!t && TITLE_NETS.has(network)) out.push(`${label} needs a title`);
    else if (max && [...t].length > max) out.push(`${label} ${network === "mailchimp" || network === "kit" ? "subject lines" : "titles"} are at most ${max} characters`);
  }
  if (network === "reddit") {
    const sub = (o.subreddit ?? "").trim();
    if (!sub) out.push("Reddit needs a subreddit");
    else if (!SUBREDDIT_RE.test(sub)) out.push("That subreddit name isn't valid (letters, numbers and _ only)");
    if (kind === "link" && !(o.link ?? "").trim()) out.push("A Reddit link post needs the link");
  }
  if (network === "pinterest" && !(o.boardId ?? "").trim()) out.push("Pinterest needs a board");
  if (o.link && o.link.trim() && !URL_RE.test(o.link.trim())) out.push(`The ${label} link isn't a full web address (https://…)`);
  if (network === "google_business" && o.callToAction && o.callToAction !== "CALL" && !(o.link ?? "").trim()) out.push("The call to action needs a link");

  if (network === "tiktok") {
    if (!o.privacy) out.push("Choose who can see it on TikTok");
    if (tt.disclose && !tt.yourBrand && !tt.branded) out.push("Say whether the TikTok promotes your brand, another brand, or both");
    if (tt.branded && o.privacy === "self") out.push("Branded content on TikTok can't be set to Only me");
    if (!tt.musicOk) out.push(tt.branded ? "Agree to TikTok's Branded Content Policy and Music Usage Confirmation" : "Agree to TikTok's Music Usage Confirmation");
  }

  if (o.poll) {
    const filled = o.poll.options.filter((x) => x.trim());
    const lim = POLL_LIMITS[network];
    if (filled.length < 2) out.push(`The ${label} poll needs at least 2 choices`);
    if (lim && o.poll.options.some((x) => x.length > lim.chars)) out.push(`${label} poll choices are at most ${lim.chars} characters`);
    if (network === "x" && media.length) out.push("X polls can't carry media");
  }
  return out;
}

/** What goes on the wire: empty strings dropped, the kind only where there is a choice, TikTok's toggles mapped. */
export function wireOptions(network: Network, kinds: string[], o: VariantOptions, tt: TikTokExtras, linkTracking = true): VariantOptions | undefined {
  const out: VariantOptions = {};
  const sel = selectableKinds(kinds);
  if (o.poll && o.poll.options.filter((x) => x.trim()).length) {
    out.poll = { options: o.poll.options.map((x) => x.trim()).filter(Boolean), durationMinutes: o.poll.durationMinutes };
    if (kinds.includes("poll")) out.kind = "poll";
  } else if (sel.length > 1) out.kind = (o.kind ?? sel[0]) as PostKind;
  const str = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  const title = str(o.title);
  if (title) out.title = title;
  const link = str(o.link);
  if (link) out.link = link;
  if (o.privacy) out.privacy = o.privacy;
  else if (network === "youtube") out.privacy = "public";
  const board = str(o.boardId);
  if (board) out.boardId = board;
  const sub = str(o.subreddit)?.replace(/^\/?r\//i, "");
  if (sub) out.subreddit = sub;
  const flair = str(o.flairId);
  if (flair) out.flairId = flair;
  const fc = str(o.firstComment);
  if (fc) out.firstComment = fc;
  if (o.tags?.length) out.tags = o.tags.map((t) => t.trim()).filter(Boolean);
  const cw = str(o.contentWarning);
  if (cw) out.contentWarning = cw;
  if (o.visibility) out.visibility = o.visibility;
  if (o.callToAction) out.callToAction = o.callToAction;
  // With tracking off for the workspace there is nothing to opt out of, and no campaign to tag.
  if (linkTracking && o.trackLinks === false) out.trackLinks = false;
  else if (linkTracking) {
    const campaign = str(o.campaign);
    if (campaign) out.campaign = campaign;
  }
  if (network === "tiktok") {
    out.allowComments = !!o.allowComments;
    out.allowDuet = !!o.allowDuet;
    out.allowStitch = !!o.allowStitch;
    out.brandedContent = tt.disclose && tt.branded;
    out.brandOrganic = tt.disclose && tt.yourBrand;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The options panel under one variant: only the fields this network reads. */
export function NetworkOptions({
  network,
  kinds,
  value,
  tiktok,
  onChange,
  onTikTok,
  linkTracking = true,
}: {
  network: Network;
  kinds: string[];
  value: VariantOptions;
  tiktok: TikTokExtras;
  onChange: (o: VariantOptions) => void;
  onTikTok: (t: TikTokExtras) => void;
  /** False when the server has no short-link base or the workspace turned tracking off: no "Track links" then. */
  linkTracking?: boolean;
}) {
  const label = networkLabel(network);
  const sel = selectableKinds(kinds);
  // Nothing of its own and no link tracking: no empty options box.
  if (!linkTracking && !hasOptions(network, kinds)) return null;
  const kind = value.kind ?? sel[0] ?? "post";
  const set = (p: Partial<VariantOptions>) => onChange({ ...value, ...p });
  const id = (f: string) => `opt-${network}-${f}`;
  const pollLim = POLL_LIMITS[network] ?? { options: 4, chars: 100 };
  const tracking = value.trackLinks !== false;
  const setTracking = (on: boolean) => {
    const next: VariantOptions = { ...value };
    if (on) delete next.trackLinks;
    else next.trackLinks = false;
    onChange(next);
  };

  return (
    <div className="cv-opts" aria-label={`${label} options`}>
      {sel.length > 1 && !value.poll ? (
        <div className="opt-row">
          <span className="opt-label">Post as</span>
          <div className="seg seg-wide seg-small" role="radiogroup" aria-label={`${label} post kind`}>
            {sel.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className="seg-btn" onClick={() => set({ kind: k as PostKind })}>
                {postKindLabel(k)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {TITLE_NETS.has(network) || OPTIONAL_TITLE_NETS.has(network) ? (
        <label className="opt-field" htmlFor={id("title")}>
          <span className="opt-label">
            {network === "mailchimp" || network === "kit" ? "Subject line" : "Title"}
            {TITLE_NETS.has(network) ? <span className="opt-req"> required</span> : null}
          </span>
          <input
            id={id("title")}
            className="input"
            value={value.title ?? ""}
            maxLength={(TITLE_MAX[network] ?? 300) + 20}
            placeholder={TITLE_PLACEHOLDER[network] ?? "Title"}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
      ) : null}

      {network === "youtube" ? (
        <>
          <div className="opt-row">
            <span className="opt-label">Visibility</span>
            <div className="seg seg-wide seg-small" role="radiogroup" aria-label="YouTube visibility">
              {(
                [
                  ["public", "Public"],
                  ["unlisted", "Unlisted"],
                  ["private", "Private"],
                ] as [Privacy, string][]
              ).map(([p, l]) => (
                <button key={p} type="button" role="radio" aria-checked={(value.privacy ?? "public") === p} className="seg-btn" onClick={() => set({ privacy: p })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <label className="opt-field" htmlFor={id("tags")}>
            <span className="opt-label">Tags</span>
            <input
              id={id("tags")}
              className="input"
              placeholder="cold brew, home coffee"
              value={(value.tags ?? []).join(", ")}
              onChange={(e) => set({ tags: e.target.value.split(",").map((t) => t.trimStart()) })}
            />
          </label>
        </>
      ) : null}

      {network === "tiktok" ? (
        <div className="opt-tiktok">
          <p className="muted small">TikTok asks the creator's privacy settings when posting. Choose who can see it; nothing is picked for you.</p>
          <label className="opt-field" htmlFor={id("privacy")}>
            <span className="opt-label">
              Who can see this <span className="opt-req">required</span>
            </span>
            <select id={id("privacy")} className="select" value={value.privacy ?? ""} onChange={(e) => set({ privacy: (e.target.value || undefined) as Privacy | undefined })}>
              <option value="" disabled>
                Choose…
              </option>
              {TIKTOK_PRIVACY.map(([p, l]) => (
                <option key={p} value={p} disabled={p === "self" && tiktok.branded}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="opt-row opt-checks">
            <span className="opt-label">Let people</span>
            <label className="check">
              <input type="checkbox" checked={!!value.allowComments} onChange={(e) => set({ allowComments: e.target.checked })} /> Comment
            </label>
            <label className="check">
              <input type="checkbox" checked={!!value.allowDuet} onChange={(e) => set({ allowDuet: e.target.checked })} /> Duet
            </label>
            <label className="check">
              <input type="checkbox" checked={!!value.allowStitch} onChange={(e) => set({ allowStitch: e.target.checked })} /> Stitch
            </label>
          </div>
          <div className="opt-commercial">
            <label className="check">
              <input type="checkbox" checked={tiktok.disclose} onChange={(e) => onTikTok({ ...tiktok, disclose: e.target.checked, ...(e.target.checked ? {} : { yourBrand: false, branded: false }) })} />
              <span>
                <span className="strong">Disclose commercial content</span>
                <span className="muted small"> · the video promotes a brand, product or service</span>
              </span>
            </label>
            {tiktok.disclose ? (
              <div className="opt-sub">
                <label className="check">
                  <input type="checkbox" checked={tiktok.yourBrand} onChange={(e) => onTikTok({ ...tiktok, yourBrand: e.target.checked })} />
                  <span>
                    Your brand <span className="muted small">· you're promoting yourself or your own business</span>
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={tiktok.branded} onChange={(e) => onTikTok({ ...tiktok, branded: e.target.checked })} />
                  <span>
                    Branded content <span className="muted small">· you're promoting another brand or a third party</span>
                  </span>
                </label>
                {tiktok.yourBrand || tiktok.branded ? (
                  <p className="small opt-note">TikTok will label it “{tiktok.branded ? "Paid partnership" : "Promotional content"}”.</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <label className="check opt-music">
            <input type="checkbox" checked={tiktok.musicOk} onChange={(e) => onTikTok({ ...tiktok, musicOk: e.target.checked })} />
            <span>
              I agree to TikTok's{" "}
              {tiktok.branded ? (
                <>
                  <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">
                    Branded Content Policy
                  </a>{" "}
                  and{" "}
                </>
              ) : null}
              <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">
                Music Usage Confirmation
              </a>
            </span>
          </label>
        </div>
      ) : null}

      {network === "pinterest" ? (
        <label className="opt-field" htmlFor={id("board")}>
          <span className="opt-label">
            Board <span className="opt-req">required</span>
          </span>
          <input id={id("board")} className="input" placeholder="Board name or id" value={value.boardId ?? ""} onChange={(e) => set({ boardId: e.target.value })} />
        </label>
      ) : null}

      {network === "reddit" ? (
        <div className="opt-pair">
          <label className="opt-field" htmlFor={id("sub")}>
            <span className="opt-label">
              Subreddit <span className="opt-req">required</span>
            </span>
            <span className="input-prefix">
              <span className="mono muted">r/</span>
              <input
                id={id("sub")}
                className="input"
                placeholder="Coffee"
                spellCheck={false}
                value={value.subreddit ?? ""}
                onChange={(e) => set({ subreddit: e.target.value.replace(/^\/?r\//i, "").replace(/\s/g, "") })}
              />
            </span>
          </label>
          <label className="opt-field" htmlFor={id("flair")}>
            <span className="opt-label">Flair</span>
            <input id={id("flair")} className="input" placeholder="If the subreddit asks for one" value={value.flairId ?? ""} onChange={(e) => set({ flairId: e.target.value })} />
          </label>
        </div>
      ) : null}

      {LINK_NETS.has(network) && (network !== "reddit" || kind === "link") ? (
        <label className="opt-field" htmlFor={id("link")}>
          <span className="opt-label">
            {network === "pinterest" ? "Destination link" : "Link"}
            {network === "reddit" ? <span className="opt-req"> required</span> : null}
          </span>
          <input id={id("link")} className="input" type="url" placeholder="https://…" value={value.link ?? ""} onChange={(e) => set({ link: e.target.value })} />
        </label>
      ) : null}

      {network === "google_business" ? (
        <div className="opt-pair">
          <label className="opt-field" htmlFor={id("cta")}>
            <span className="opt-label">Call to action</span>
            <select id={id("cta")} className="select" value={value.callToAction ?? ""} onChange={(e) => set({ callToAction: (e.target.value || undefined) as CallToAction | undefined })}>
              <option value="">None</option>
              {(Object.keys(CTA_LABEL) as CallToAction[]).map((c) => (
                <option key={c} value={c}>
                  {CTA_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          {value.callToAction && value.callToAction !== "CALL" ? (
            <label className="opt-field" htmlFor={id("ctalink")}>
              <span className="opt-label">
                Button link <span className="opt-req">required</span>
              </span>
              <input id={id("ctalink")} className="input" type="url" placeholder="https://…" value={value.link ?? ""} onChange={(e) => set({ link: e.target.value })} />
            </label>
          ) : null}
        </div>
      ) : null}

      {network === "mastodon" ? (
        <div className="opt-pair">
          <label className="opt-field" htmlFor={id("cw")}>
            <span className="opt-label">Content warning</span>
            <input id={id("cw")} className="input" placeholder="Shown before the post opens" value={value.contentWarning ?? ""} onChange={(e) => set({ contentWarning: e.target.value })} />
          </label>
          <label className="opt-field" htmlFor={id("vis")}>
            <span className="opt-label">Visibility</span>
            <select id={id("vis")} className="select" value={value.visibility ?? "public"} onChange={(e) => set({ visibility: e.target.value as MastodonVisibility })}>
              {MASTODON_VISIBILITY.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {POLL_NETS.has(network) ? (
        value.poll ? (
          <div className="opt-poll">
            <div className="opt-row">
              <span className="opt-label">Poll</span>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => set({ poll: undefined })}>
                Remove poll
              </button>
            </div>
            {value.poll.options.map((choice, i) => (
              <div key={i} className="opt-poll-row">
                <input
                  className="input"
                  placeholder={`Choice ${i + 1}`}
                  aria-label={`${label} poll choice ${i + 1}`}
                  value={choice}
                  onChange={(e) => set({ poll: { ...value.poll!, options: value.poll!.options.map((c, j) => (j === i ? e.target.value : c)) } })}
                />
                <span className={`mono variant-count${choice.length > pollLim.chars ? " over" : ""}`}>
                  {choice.length}/{pollLim.chars}
                </span>
                {value.poll!.options.length > 2 ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => set({ poll: { ...value.poll!, options: value.poll!.options.filter((_, j) => j !== i) } })}>
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <div className="opt-row">
              {value.poll.options.length < pollLim.options ? (
                <button type="button" className="btn btn-ghost btn-small" onClick={() => set({ poll: { ...value.poll!, options: [...value.poll!.options, ""] } })}>
                  Add a choice
                </button>
              ) : null}
              <label className="opt-inline">
                <span className="opt-label">Runs for</span>
                <select className="select select-small" value={value.poll.durationMinutes} onChange={(e) => set({ poll: { ...value.poll!, durationMinutes: Number(e.target.value) } })}>
                  {POLL_DURATIONS.map(([m, l]) => (
                    <option key={m} value={m}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : (
          <div className="opt-row">
            <button type="button" className="btn btn-ghost btn-small opt-addpoll" onClick={() => set({ poll: { options: ["", ""], durationMinutes: 1440 } })}>
              Add a poll
            </button>
          </div>
        )
      ) : null}

      {FIRST_COMMENT_NETS.has(network) ? (
        <label className="opt-field" htmlFor={id("fc")}>
          <span className="opt-label">First comment</span>
          <textarea
            id={id("fc")}
            className="textarea"
            rows={1}
            placeholder="Posted as the first comment right after (links, hashtags, credits)"
            value={value.firstComment ?? ""}
            onChange={(e) => set({ firstComment: e.target.value })}
          />
        </label>
      ) : null}

      {linkTracking ? (
        <div className="opt-row opt-links">
          <label className="check" title="Wrap links in Starsign short links with UTM tags, so clicks are counted">
            <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} /> Track links
          </label>
          {tracking ? (
            <label className="opt-inline opt-campaign" htmlFor={id("campaign")}>
              <span className="opt-label">Campaign</span>
              <input id={id("campaign")} className="input" placeholder="Workspace default" maxLength={100} value={value.campaign ?? ""} onChange={(e) => set({ campaign: e.target.value })} />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
