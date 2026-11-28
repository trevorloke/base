// Website → News (/website/news, /website/news/:id): the site's news posts.
//   The list, newest first: title, published (and when) or a draft, its
//   first lines. One yellow "New post".
//   A post (WA decision 27): its title, picture (what it shows, the spot to
//   keep in view), the words (Markdown in the body font, with a small
//   toolbar and pictures) beside the post as it will look (≥ 1,100 px; Write
//   · See it tabs on smaller screens), a short summary made from the words
//   until someone types in it, its address. A post has no separate draft once it's out:
//   saving a published post changes it on the site — so a draft's yellow
//   button is "Publish" (with "Save draft" beside it) and a published one's
//   is "Save changes" (with "Unpublish"). ⋯ → View on the site, Delete
//   (Undo brings it back).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { ImageField, TextField, uploadSitePicture } from '../components/site/Fields.jsx';
import { useWidth } from '../components/site/builder/usePreview.js';
import { renderMarkdown } from '@base-win/shared/markdown';
import { POST_FIELDS, knownPictures, newUndescribed, summaryFrom } from '@base-win/shared/site/pictures';
import '../components/site/posts.css';
import { day, useSite, useSitePost, useSitePosts, useSiteRefresh } from '../components/site/useSite.js';
import { rebaseForm, slugInput, slugify } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';

const blank = { title: '', slug: '', excerpt: '', body: '', image: { url: '', alt: '' } };
const formOf = (p) => ({ title: p.title || '', slug: p.slug || '', excerpt: p.excerpt || '', body: p.body || '', image: p.image?.url ? { ...p.image, alt: p.image.alt || '' } : { url: '', alt: '' } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function PostList({ say }) {
  const q = useSitePosts();
  const navigate = useNavigate();
  const online = useOnline();
  const refresh = useSiteRefresh();
  const location = useLocation();
  const posts = q.data?.posts || [];
  // Deleted from its editor: said here, with Undo (site.post.restore).
  const deleted = location.state?.deleted;
  useEffect(() => {
    if (!deleted) return;
    navigate('.', { replace: true, state: null });
    say(`Deleted “${deleted.title}”`, {
      undo: async () => {
        try {
          const back = await action('site.post.restore', { id: deleted.id });
          await refresh(['site-posts'], ['site']);
          say(back.post.slug === deleted.slug ? `“${deleted.title}” is back` : `“${deleted.title}” is back, at /news/${back.post.slug}`);
        } catch (e) { say(e.message); }
      },
    });
  }, [deleted, navigate, refresh, say]);
  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>News</h1>
        {online && <button type="button" className="btn btn-primary ops-tap" onClick={() => navigate('/website/news/new')}>New post</button>}
      </div>
      <WebsiteTabs />
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && posts.length === 0 && <p className="ops-empty">No news yet. Posts show on the site’s News page and in its News sections.</p>}
      {posts.length > 0 && (
        <ul className="wb-rows">
          {posts.map((p) => (
            <li key={p.id} className="wb-row wb-row--post">
              {p.image?.url ? <img className="wb-row__pic" src={at(p.image.url)} alt="" loading="lazy" /> : <span className="wb-row__pic" aria-hidden="true" />}
              <div className="wb-row__main">
                <Link className="wb-row__name" to={`/website/news/${p.id}`}>{p.title}</Link>
                <span className="wb-row__sub">
                  {p.status === 'published'
                    ? <span className="chip chip-ok">Published {day(p.published_at)}</span>
                    : <span className="chip ops-chip-muted">Draft</span>}
                  {p.excerpt && <span className="wb-row__excerpt">{p.excerpt}</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PostEditor({ id, say }) {
  const isNew = id === 'new';
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const q = useSitePost(isNew ? null : id);
  const siteQ = useSite();
  const [form, setForm] = useState(isNew ? blank : null);
  const [post, setPost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The words on screen, as they are now (a slow answer is merged into them).
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    const p = q.data?.post;
    if (!p || q.isFetching || post?.id === p.id) return;
    setPost(p);
    // Just made, with words typed while it was being made: those.
    const carried = location.state?.form;
    setForm(carried && typeof carried === 'object' ? { ...formOf(p), ...carried } : formOf(p));
    if (carried) navigate('.', { replace: true, state: null });
  }, [q.data, q.isFetching, post?.id, location.state, navigate]);
  useEffect(() => () => { if (!isNew) qc.invalidateQueries({ queryKey: ['site-post', id] }); }, [qc, id, isNew]);
  const dirty = useMemo(() => (form && (isNew ? Boolean(form.title.trim() || form.body.trim()) : post && !same(form, formOf(post)))), [form, post, isNew]);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // The words: the summary follows them while nobody has typed in it (it is
  // empty, or still what the words before made).
  const setBody = (v) => setForm((f) => ({ ...f, body: v, excerpt: !f.excerpt.trim() || f.excerpt === summaryFrom(f.body) ? summaryFrom(v) : f.excerpt }));
  const width = useWidth();
  const beside = width >= 1100;
  const [tab, setTab] = useState('write');
  // A picture new to the site needs its description (WA 26): found here
  // before anything is sent, the box opened, as the server would refuse.
  const pictureProblem = (sent, going) => {
    if (!going) return null;
    const known = live && post ? knownPictures({ image: post.image, body: post.body }) : new Set();
    return newUndescribed(POST_FIELDS, sent, known);
  };
  const showProblem = (p, sent) => {
    setTab('write');
    if (!p.md) {
      setError('The picture: describe it for people who can’t see it');
      setTimeout(() => document.getElementById('wb-p-image-alt')?.focus(), 0);
      return;
    }
    setError('The post: a picture in it has no description');
    setTimeout(() => {
      const el = document.getElementById('wb-p-body');
      if (!el) return;
      const at = sent.body.indexOf(`](${p.url}`);
      const open = at >= 0 ? sent.body.lastIndexOf('![', at) + 2 : 0;
      el.focus();
      el.setSelectionRange(open, Math.max(open, at));
    }, 0);
  };
  const live = post?.status === 'published';
  const siteRoot = (siteQ.data?.urls?.site || '/site/').replace(/\/$/, '');

  // Save (and, with publish, put it on the site).
  const save = async ({ publish = null } = {}) => {
    if (!form.title.trim()) { setError('Give the post a title'); return null; }
    setBusy(true);
    setError(null);
    // What goes; whatever is typed while it's out stays (and stays "Not saved yet").
    const sent = form;
    const pic = pictureProblem(sent, publish === true || (live && publish === null));
    if (pic) { setBusy(false); showProblem(pic, sent); return null; }
    try {
      const res = await action('site.post.save', {
        ...(isNew ? {} : { id }), title: sent.title.trim(), slug: sent.slug.trim() || undefined,
        excerpt: sent.excerpt, body: sent.body, image: sent.image?.url ? sent.image : { url: '', alt: '' },
      });
      let p = res.post;
      if (publish !== null) p = (await action('site.post.publish', { id: p.id, published: publish })).post;
      setPost(p);
      const next = rebaseForm(formRef.current, sent, formOf(p));
      setForm(next);
      qc.setQueryData(['site-post', p.id], { post: p });
      refresh(['site-posts'], ['site']);
      say(publish === true ? 'Published — it’s on the site' : publish === false ? 'Unpublished — it’s a draft now' : live ? 'Saved — the site has the change' : 'Saved as a draft');
      if (isNew) navigate(`/website/news/${p.id}`, { replace: true, state: same(next, formOf(p)) ? null : { form: next } });
      return p;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await action('site.post.delete', { id });
      await refresh(['site-posts'], ['site']);
      navigate('/website/news', { replace: true, state: { deleted: { id, title: post?.title || form.title, slug: post?.slug } } });
    } catch (e) { setError(e.message); setBusy(false); }
  };

  if (!isNew && noSignal(q)) return <div className="wb-page"><NoSignal /></div>;
  if (!isNew && q.isError) {
    return (
      <div className="wb-page">
        <Link className="ops-back" to="/website/news">← News</Link>
        <p className="error" role="alert">{q.error.status === 404 ? 'That post is gone — it may have been deleted.' : q.error.message}</p>
      </div>
    );
  }
  if (!form) return <div className="wb-page"><p className="muted">Loading…</p></div>;

  return (
    <div className={`wb-page${beside ? ' wb-page--wide' : ''}`}>
      <Link className="ops-back" to="/website/news">← News</Link>
      <div className="wb-build__head">
        <div className="wb-build__title">
          <h1>{isNew ? 'New post' : form.title || 'Untitled post'}</h1>
          {post && (
            <span className="wb-build__meta">
              <span className="wb-row__addr">/news/{post.slug}</span>
              {live ? <span className="chip chip-ok">Published {day(post.published_at)}</span> : <span className="chip ops-chip-muted">Draft</span>}
              {dirty && <span className="wb-saved" data-state="blocked">Not saved yet</span>}
            </span>
          )}
        </div>
        <div className="wb-build__actions">
          {live ? (
            <>
              <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => save({ publish: false })}>Unpublish</button>
              <button type="button" className="btn btn-primary ops-tap" disabled={busy || !online || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save changes'}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn ops-tap" disabled={busy || !online || (!dirty && !isNew)} onClick={() => save()}>Save draft</button>
              <button type="button" className="btn btn-primary ops-tap" disabled={busy || !online} onClick={() => save({ publish: true })}>{busy ? 'Saving…' : 'Publish'}</button>
            </>
          )}
          {post && (
            <MoreMenu label="More for this post" items={[
              live && { label: 'View on the site', href: `${siteRoot}/news/${post.slug}`, external: true },
              { label: 'Delete this post', onClick: remove, danger: true },
            ]} />
          )}
        </div>
      </div>
      {error && <p className="wb-alert" role="alert">{error}</p>}
      {!beside && (
        <div className="wb-post__tabs" role="group" aria-label="Write or see the post">
          <button type="button" className="btn wb-tap" aria-pressed={tab === 'write'} onClick={() => setTab('write')}>Write</button>
          <button type="button" className="btn wb-tap" aria-pressed={tab === 'see'} onClick={() => setTab('see')}>See it</button>
        </div>
      )}
      <div className={`wb-post${beside ? ' wb-post--beside' : ''}`}>
      <div className="card wb-editor" hidden={!beside && tab !== 'write'}>
        <TextField id="wb-p-title" label="Title" max={160} value={form.title} onChange={(v) => set('title', v)} />
        <ImageField id="wb-p-image" label="Picture" value={form.image} onChange={(v) => set('image', v)} />
        <div className="wb-md wb-post__write">
          <MarkdownField id="wb-p-body" label="The post" value={form.body} rows={14} onChange={setBody} upload={uploadSitePicture}
            links={(siteQ.data?.pages || []).map((p) => ({ label: p.title, url: p.slug === 'home' ? '/' : `/${p.slug}` }))} />
        </div>
        <TextField id="wb-p-excerpt" label="Short summary (shown in lists and shares)" max={400} multiline value={form.excerpt} onChange={(v) => set('excerpt', v)} />
        <div className="field wb-field">
          <label htmlFor="wb-p-slug">Address</label>
          <div className="wb-slug">
            <span className="wb-slug__root" aria-hidden="true">/news/</span>
            <input id="wb-p-slug" className="input" maxLength={60} autoComplete="off" spellCheck={false} value={form.slug}
              placeholder={slugify(form.title) || 'made-from-the-title'} onChange={(e) => set('slug', slugInput(e.target.value))} />
          </div>
          {live && <p className="wb-field__hint">Changing it changes the live address: links to the old one stop working.</p>}
        </div>
      </div>
      {(beside || tab === 'see') && <PostLook form={form} post={post} />}
      </div>
    </div>
  );
}

// The post as it will look: the site's post layout drawn from the words as
// they are typed (shared/markdown.js, the site's own renderer).
function PostLook({ form, post }) {
  const f = form.image?.focus;
  const when = post?.status === 'published' ? `Published ${day(post.published_at)}` : 'Not on the site yet';
  return (
    <section className="wb-postpv" aria-label="The post as it will look">
      <p className="wb-postpv__when">{when}</p>
      <h2 className="wb-postpv__title">{form.title.trim() || 'Your post’s title'}</h2>
      {form.excerpt.trim() && <p className="wb-postpv__lede">{form.excerpt}</p>}
      {form.image?.url && (
        <img className="wb-postpv__pic" src={at(form.image.url)} alt={form.image.decorative ? '' : form.image.alt || ''}
          style={f ? { objectPosition: `${f.x}% ${f.y}%` } : undefined} />
      )}
      {/* eslint-disable-next-line react/no-danger -- the site's own safe renderer: every character is escaped first */}
      <div className="ws-prose wb-postpv__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(form.body) || '<p class="muted">The words you write show here.</p>' }} />
    </section>
  );
}

// The toast lives here, so it outlasts a move between the list and a post.
export default function WebsitePosts() {
  const { id } = useParams();
  const { toast, say, clear } = useToast();
  return (
    <>
      {id ? <PostEditor key={id} id={id} say={say} /> : <PostList say={say} />}
      <Toast toast={toast} onClear={clear} />
    </>
  );
}
