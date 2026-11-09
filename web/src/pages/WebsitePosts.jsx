// Website → News (/website/news, /website/news/:id): the site's news posts.
//   The list, newest first: title, published (and when) or a draft, its
//   first lines. One yellow "New post".
//   A post: its title, picture (and what it shows), a short excerpt (lists
//   and shares use it), the words (Markdown, with a small toolbar and
//   pictures), its address. A post has no separate draft once it's out:
//   saving a published post changes it on the site — so a draft's yellow
//   button is "Publish" (with "Save draft" beside it) and a published one's
//   is "Save changes" (with "Unpublish"). ⋯ → View on the site, Delete
//   (Undo brings it back).
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { at } from '../base.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { ImageField, TextField, uploadSitePicture } from '../components/site/Fields.jsx';
import { day, useSite, useSitePost, useSitePosts, useSiteRefresh } from '../components/site/useSite.js';
import { slugInput, slugify } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';

const blank = { title: '', slug: '', excerpt: '', body: '', image: { url: '', alt: '' } };
const formOf = (p) => ({ title: p.title || '', slug: p.slug || '', excerpt: p.excerpt || '', body: p.body || '', image: { url: p.image?.url || '', alt: p.image?.alt || '' } });
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
  const qc = useQueryClient();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const q = useSitePost(isNew ? null : id);
  const siteQ = useSite();
  const [form, setForm] = useState(isNew ? blank : null);
  const [post, setPost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const p = q.data?.post;
    if (!p || q.isFetching || post?.id === p.id) return;
    setPost(p);
    setForm(formOf(p));
  }, [q.data, q.isFetching, post?.id]);
  useEffect(() => () => { if (!isNew) qc.invalidateQueries({ queryKey: ['site-post', id] }); }, [qc, id, isNew]);
  const dirty = useMemo(() => (form && (isNew ? Boolean(form.title.trim() || form.body.trim()) : post && !same(form, formOf(post)))), [form, post, isNew]);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const live = post?.status === 'published';
  const siteRoot = (siteQ.data?.urls?.site || '/site/').replace(/\/$/, '');

  // Save (and, with publish, put it on the site).
  const save = async ({ publish = null } = {}) => {
    if (!form.title.trim()) { setError('Give the post a title'); return null; }
    setBusy(true);
    setError(null);
    try {
      const res = await action('site.post.save', {
        ...(isNew ? {} : { id }), title: form.title.trim(), slug: form.slug.trim() || undefined,
        excerpt: form.excerpt, body: form.body, image: form.image?.url ? form.image : { url: '', alt: '' },
      });
      let p = res.post;
      if (publish !== null) p = (await action('site.post.publish', { id: p.id, published: publish })).post;
      setPost(p);
      setForm(formOf(p));
      qc.setQueryData(['site-post', p.id], { post: p });
      refresh(['site-posts'], ['site']);
      say(publish === true ? 'Published — it’s on the site' : publish === false ? 'Unpublished — it’s a draft now' : live ? 'Saved — the site has the change' : 'Saved as a draft');
      if (isNew) navigate(`/website/news/${p.id}`, { replace: true });
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
    <div className="wb-page">
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
      <div className="card wb-editor">
        <TextField id="wb-p-title" label="Title" max={160} value={form.title} onChange={(v) => set('title', v)} />
        <ImageField id="wb-p-image" label="Picture" value={form.image} onChange={(v) => set('image', v)} />
        <TextField id="wb-p-excerpt" label="Excerpt (in lists and when it’s shared)" max={400} multiline value={form.excerpt} onChange={(v) => set('excerpt', v)} />
        <div className="wb-md">
          <MarkdownField id="wb-p-body" label="The post" value={form.body} rows={14} onChange={(v) => set('body', v)} upload={uploadSitePicture}
            links={(siteQ.data?.pages || []).map((p) => ({ label: p.title, url: p.slug === 'home' ? '/' : `/${p.slug}` }))} />
        </div>
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
    </div>
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
