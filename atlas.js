/* The Atlas: places, factions, people, creatures, items and lore the party uncovers.
   The DM writes every entry and decides when each one is revealed. Players are only ever sent revealed entries
   (row-level security in supabase/setup.sql), and the DM's private notes sit in a separate table only the DM can read. */
window.HandbookAtlas = function (H) {
  'use strict';
  const { el, md, esc, norm, state, go, render, Notes } = H;

  const KINDS = [['place', 'Places', 'Place'], ['faction', 'Factions', 'Faction'], ['person', 'People', 'Person'], ['creature', 'Creatures', 'Creature'], ['item', 'Items', 'Item'], ['lore', 'Lore', 'Lore']];
  const KIND = Object.fromEntries(KINDS.map(([k, p, s]) => [k, { plural: p, one: s }]));

  let rows = null, dm = new Map(), pins = [], loading = false, loadErr = '', loadedAt = 0;
  let placing = '', pinDraft = null, pinPick = '';   // the map the DM is placing pins on, and the spot just clicked
  const mapOnly = new Map(), mapNames = new Map();     // per map: the one kind of pin shown, and whether every name is shown
  let kind = '', find = '';
  let edit = null;          // the entry being written: { id|null, kind, name, region, image_url, summary, notes, revealed }
  let msg = '', busy = false, delAsk = false;

  const sb = () => Notes && Notes.client && Notes.client();
  const user = () => Notes && Notes.user && Notes.user();
  const admin = () => !!(Notes && Notes.isAdmin && Notes.isAdmin());
  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : String((e && e.message) || e));

  function init() {
    if (Notes && Notes.onAuth) Notes.onAuth(() => { rows = null; dm = new Map(); edit = null; msg = ''; if (state.tab === 'atlas') render(); });
  }

  async function load(force) {
    if (loading || !sb() || !user()) return;
    if (rows && !force && Date.now() - loadedAt < 60000) return;
    loading = true; loadErr = '';
    try {
      const r = await sb().from('atlas').select('*').order('name', { ascending: true });
      if (r.error) throw r.error;
      rows = r.data || [];
      const pr = await sb().from('atlas_pins').select('*');
      pins = pr.error ? [] : pr.data || [];   // (an older setup.sql has no pins table: maps just show without them)
      if (admin()) {
        const n = await sb().from('atlas_dm').select('*');
        dm = new Map(((n && n.data) || []).map(x => [x.id, x.notes || '']));
      }
      loadedAt = Date.now();
      signPictures();
    } catch (e) {
      loadErr = /does not exist|relation|schema cache/i.test(String(e && (e.message || e))) ? 'missing' : friendly(e);
      rows = null;
    }
    loading = false;
    if (state.tab === 'atlas' || (state.tab === 'all' && !state.q)) render();
  }

  /* ---------- pictures ----------
     Uploaded pictures live in the private "atlas" storage bucket; the page asks for short-lived links to the ones this
     person may see (the storage rules only hand them out for revealed entries, or to the DM). Older entries may still
     use a picture link (image_url) instead. */
  const signed = new Map();   // path → { url, until }
  async function signPictures() {
    const now = Date.now();
    const want = (rows || []).map(r => r.image_path).filter(p => p && !(signed.get(p) && signed.get(p).until > now + 60000));
    if (!want.length || !sb().storage) return;
    const r = await sb().storage.from('atlas').createSignedUrls(want, 3600);
    if (r.error || !r.data) return;
    for (const x of r.data) if (x && x.signedUrl && !x.error) signed.set(x.path, { url: x.signedUrl, until: now + 3600 * 1000 });
    if (state.tab === 'atlas' || state.tab === 'session') render();
  }
  const pictureOf = r => r.image_path ? (signed.get(r.image_path) || {}).url || null : r.image_url || null;
  const hasPicture = r => !!(r.image_path || r.image_url);

  // big photos are shrunk in the browser before they're sent: at most 2400px on the long side, as WebP (JPEG if the browser can't)
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => cv.toBlob(res, 'image/webp', 0.85));
    if (blob && blob.type === 'image/webp') return { blob, ext: 'webp', type: 'image/webp', w, h };
    const jpg = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.88));
    return { blob: jpg, ext: 'jpg', type: 'image/jpeg', w, h };
  }
  async function takeFile(file) {
    if (!edit || !file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) { msg = 'That isn’t a picture this can use. Try a PNG, JPEG, WebP or GIF.'; render(); return; }
    if (file.size > 40 * 1024 * 1024) { msg = 'That file is over 40 MB. Try a smaller copy.'; render(); return; }
    msg = 'Preparing the picture…'; render();
    try {
      const out = await shrink(file);
      if (out.blob.size > 8 * 1024 * 1024) { msg = 'Even shrunk, that picture is over 8 MB. Try a smaller one.'; render(); return; }
      if (edit.preview) URL.revokeObjectURL(edit.preview);
      edit.file = out; edit.preview = URL.createObjectURL(out.blob); edit.dropPic = false; edit.image_url = '';
      msg = `Ready: ${out.w} × ${out.h}, ${Math.max(1, Math.round(out.blob.size / 1024))} KB. It uploads when you save.`;
    } catch (e) { msg = 'Couldn’t read that picture.'; }
    render();
  }

  const byId = id => rows && rows.find(r => r.id === id);
  const regions = () => [...new Set((rows || []).map(r => (r.region || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const hay = r => norm(`${r.name} ${r.region || ''} ${r.summary || ''}`);

  // [[Name]] becomes a link when that entry is visible to whoever is reading; otherwise it stays plain text
  function linked(html) {
    const names = new Map((rows || []).map(r => [esc(r.name).toLowerCase(), r]));
    return html.replace(/\[\[([^\]]{1,120})\]\]/g, (m, t) => {
      const [target, shown] = t.split('|');
      const hit = names.get(target.trim().toLowerCase());
      const label = (shown || target).trim();
      return hit ? `<a class="at-link" href="#tab=atlas&amp;ent=${encodeURIComponent(hit.id)}">${label}</a>` : label;
    });
  }
  const mentions = r => (rows || []).filter(x => x.id !== r.id && new RegExp(`\\[\\[\\s*${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\|[^\\]]*)?\\]\\]`, 'i').test(x.summary || ''));

  /* ---------------- list ---------------- */

  function renderList(box, meta) {
    meta.textContent = '';
    if (!user()) {
      box.replaceChildren(el('div', { class: 'notes-gate' },
        el('h1', {}, 'The Atlas'),
        el('p', {}, 'Places, factions, people, creatures, items and lore your party has uncovered. Sign in to read it.'),
        el('button', { class: 'btn primary', onclick: () => Notes.openSignIn() }, 'Sign in')));
      return;
    }
    if (!rows) {
      if (!loading && !loadErr) load();
      box.replaceChildren(loadErr
        ? el('div', { class: 'empty' }, el('strong', {}, loadErr === 'missing' ? 'The atlas isn’t set up yet' : 'Couldn’t open the atlas'),
          loadErr === 'missing' ? (admin() ? 'Run the latest supabase/setup.sql in the Supabase SQL editor, then reload.' : 'The DM hasn’t switched it on yet.') : loadErr,
          el('div', {}, el('button', { class: 'mini', onclick: () => { loadErr = ''; load(true); render(); } }, 'Try again')))
        : el('div', { class: 'empty' }, 'Opening the atlas…'));
      return;
    }
    load();   // refresh in the background when it's been a while
    const q = norm(find.trim());
    const shown = rows.filter(r => (!kind || r.kind === kind) && (!q || hay(r).includes(q)));
    const count = k => rows.filter(r => r.kind === k).length;
    const chips = el('div', { class: 'at-kinds', role: 'group', 'aria-label': 'What to show' },
      el('button', { type: 'button', class: 'at-kind' + (!kind ? ' on' : ''), 'aria-pressed': String(!kind), onclick: () => { kind = ''; render(); } }, 'Everything', el('span', { class: 'n' }, String(rows.length))),
      ...KINDS.filter(([k]) => count(k)).map(([k, p]) => el('button', { type: 'button', class: 'at-kind' + (kind === k ? ' on' : ''), 'aria-pressed': String(kind === k), onclick: () => { kind = kind === k ? '' : k; render(); } }, p, el('span', { class: 'n' }, String(count(k))))));
    const search = el('input', { type: 'search', class: 'at-find', placeholder: 'Find in the atlas…', value: find, 'aria-label': 'Find in the atlas',
      oninput: e => { find = e.target.value; clearTimeout(search._t); search._t = setTimeout(() => { render(); const f = document.querySelector('.at-find'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 120); } });
    // grouped by kind, then by region
    const groups = KINDS.filter(([k]) => !kind || kind === k).map(([k, p]) => {
      const inK = shown.filter(r => r.kind === k);
      if (!inK.length) return null;
      const byReg = new Map();
      for (const r of inK) { const g = (r.region || '').trim(); if (!byReg.has(g)) byReg.set(g, []); byReg.get(g).push(r); }
      const regs = [...byReg.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      return el('section', { class: 'at-group' },
        el('h2', { class: 'section-head' }, p),
        ...regs.map(g => el('div', { class: 'at-reg' },
          g && (regs.length > 1 || g) ? el('div', { class: 'at-regk' }, g) : null,
          ...byReg.get(g).map(r => el('button', { type: 'button', class: 'at-row' + (state.ent === r.id ? ' on' : '') + (r.revealed ? '' : ' hidden'), 'aria-current': state.ent === r.id ? 'true' : null, onclick: () => { edit = null; delAsk = false; msg = ''; go({ ent: r.id }, true); } },
            el('span', { class: 'nm' }, r.name),
            r.revealed ? null : el('span', { class: 'at-hid' }, 'Hidden'),
            r.summary ? el('span', { class: 'at-sn' }, snippet(r.summary)) : null)))));
    }).filter(Boolean);
    const empty = !rows.length
      ? el('div', { class: 'empty' }, el('strong', {}, admin() ? 'Nothing in the atlas yet' : 'Nothing uncovered yet'),
        admin() ? 'Add places, factions, people, creatures, items and lore. Each one stays hidden until you reveal it.' : 'As your party learns about the world, the DM adds it here.')
      : !shown.length ? el('div', { class: 'empty' }, el('strong', {}, 'Nothing matches'), 'Try another word, or show everything.') : null;
    const hidden = admin() ? rows.filter(r => !r.revealed).length : 0;
    box.replaceChildren(el('div', { class: 'at' },
      el('div', { class: 'at-top' },
        el('h1', { class: 'at-title' }, 'The Atlas'),
        admin() ? el('button', { class: 'btn small primary', onclick: () => startEdit(null) }, '+ New entry') : null),
      el('p', { class: 'd-note' }, admin()
        ? `Everything here is hidden from players until you reveal it.${hidden ? ` ${hidden} of ${rows.length} ${rows.length === 1 ? 'entry is' : 'entries are'} hidden now.` : rows.length ? ' Everything is revealed.' : ''}`
        : 'Places, factions, people, creatures, items and lore your party has uncovered.'),
      rows.length ? el('div', { class: 'at-tools' }, search, chips) : null,
      empty, ...groups));
    document.title = 'Atlas · Player’s Handbook';
  }
  function snippet(s) {
    const t = String(s).replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a).replace(/[*#`|>_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > 110 ? t.slice(0, 108).replace(/\s+\S*$/, '') + '…' : t;
  }

  /* ---------------- detail ---------------- */

  const draftOf = r => r ? { id: r.id, kind: r.kind, name: r.name, region: r.region || '', image_url: r.image_url || '', image_path: r.image_path || null, summary: r.summary || '', notes: dm.get(r.id) || '', revealed: !!r.revealed, file: null, preview: null, dropPic: false }
    : { id: null, kind: kind || 'place', name: '', region: '', image_url: '', image_path: null, summary: '', notes: '', revealed: false, file: null, preview: null, dropPic: false };
  function startEdit(r) {
    edit = draftOf(r);
    msg = ''; delAsk = false;
    go({ ent: r ? r.id : 'new' }, true);
  }

  async function saveEdit() {
    const e = edit;
    e.name = e.name.trim(); e.region = e.region.trim(); e.image_url = e.image_url.trim();
    if (!e.name) { msg = 'Give it a name.'; render(); return; }
    if (e.image_url && !/^https:\/\//i.test(e.image_url)) { msg = 'The picture needs a link starting https://'; render(); return; }
    busy = true; msg = ''; render();
    const row = { kind: e.kind, name: e.name, region: e.region || null, image_url: e.image_url || null, summary: e.summary, revealed: e.revealed };
    try {
      let id = e.id;
      if (id) { const r = await sb().from('atlas').update(row).eq('id', id); if (r.error) throw r.error; }
      else { const r = await sb().from('atlas').insert(row).select().single(); if (r.error) throw r.error; id = r.data.id; }
      const had = dm.has(id);
      if (e.notes.trim() || had) { const r = await sb().from('atlas_dm').upsert({ id, notes: e.notes }); if (r.error) throw r.error; }
      // the picture: upload a new one, or take the old one away (a pasted link replaces an upload too)
      const old = e.image_path;
      if (e.file) {
        const path = `${id}/${Date.now().toString(36)}.${e.file.ext}`;
        const up = await sb().storage.from('atlas').upload(path, e.file.blob, { contentType: e.file.type, upsert: false });
        if (up.error) throw new Error(/bucket|not found/i.test(String(up.error.message)) ? 'Run the latest supabase/setup.sql to switch on picture uploads.' : up.error.message);
        const r = await sb().from('atlas').update({ image_path: path, image_url: null }).eq('id', id); if (r.error) throw r.error;
        if (old && old !== path) await sb().storage.from('atlas').remove([old]);
      } else if (old && (e.dropPic || e.image_url)) {
        const r = await sb().from('atlas').update({ image_path: null }).eq('id', id); if (r.error) throw r.error;
        await sb().storage.from('atlas').remove([old]);
      }
      if (e.preview) URL.revokeObjectURL(e.preview);
      busy = false; edit = null;
      await load(true);
      msg = 'Saved.';
      go({ ent: id }, true);
    } catch (err) { busy = false; msg = friendly(err); render(); }
  }

  async function setRevealed(r, on) {
    busy = true; render();
    const res = await sb().from('atlas').update({ revealed: on }).eq('id', r.id);
    busy = false;
    if (res.error) { msg = friendly(res.error); render(); return; }
    msg = on ? 'Revealed. Players can read it now.' : 'Hidden from players again.';
    await load(true);
  }
  async function remove(r) {
    busy = true; render();
    const res = await sb().from('atlas').delete().eq('id', r.id);
    busy = false; delAsk = false;
    if (res.error) { msg = friendly(res.error); render(); return; }
    if (r.image_path) await sb().storage.from('atlas').remove([r.image_path]);
    msg = ''; await load(true); go({ ent: '' }, true);
  }

  function editor(pane) {
    const e = edit;
    const field = (label, kid, hint) => el('label', { class: 'at-f' }, el('span', { class: 'k' }, label), kid, hint ? el('span', { class: 'bs-fine' }, hint) : null);
    const set = k => ev => { e[k] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value; };
    const regList = el('datalist', { id: 'at-regions' }, ...regions().map(g => el('option', { value: g })));
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => { edit = null; go({ ent: e.id || '' }, true); } }, e.id ? '← Back to the entry' : '← The Atlas'),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge notes' }, e.id ? 'Editing' : 'New entry')),
      el('h1', { class: 'd-title' }, e.id ? e.name || 'Untitled' : 'A new atlas entry'),
      el('form', { class: 'at-form', onsubmit: ev => { ev.preventDefault(); saveEdit(); } },
        el('div', { class: 'at-row2' },
          field('Kind', el('select', { class: 'select', onchange: set('kind') }, ...KINDS.map(([k, , one]) => el('option', { value: k, selected: e.kind === k }, one)))),
          field('Name', el('input', { type: 'text', value: e.name, maxlength: 120, required: true, oninput: set('name') }))),
        field('Region', el('input', { type: 'text', value: e.region, maxlength: 80, list: 'at-regions', placeholder: 'Optional: where it belongs', oninput: set('region') }), 'Entries are grouped by region. Pick an existing one or type a new one.'),
        regList,
        pictureField(e),
        field('What the players learn', el('textarea', { rows: 10, maxlength: 20000, oninput: set('summary') }, e.summary), 'Write [[Another entry]] to link to it; the link only works for players once that entry is revealed too. **Bold**, *italics*, lists and ### headings work.'),
        el('div', { class: 'at-dmbox' },
          field('Your notes (only you see these)', el('textarea', { rows: 6, maxlength: 20000, oninput: set('notes') }, e.notes), 'Secrets, plans, what they haven’t found out yet. These are never sent to players.')),
        el('label', { class: 'toggle at-rev' }, el('input', { type: 'checkbox', checked: e.revealed, onchange: set('revealed') }), 'Revealed to players'),
        msg ? el('p', { class: 'notes-msg', role: 'status' }, msg) : null,
        el('div', { class: 'at-btns' },
          el('button', { type: 'submit', class: 'btn primary', disabled: busy }, busy ? 'Saving…' : e.id ? 'Save' : 'Add it'),
          el('button', { type: 'button', class: 'btn', onclick: () => { edit = null; msg = ''; go({ ent: e.id || '' }, true); } }, 'Cancel'))));
    document.title = `${e.id ? 'Editing' : 'New entry'} · Atlas`;
  }

  function pictureField(e) {
    const showing = e.preview || (!e.dropPic && (e.image_path ? (signed.get(e.image_path) || {}).url : null));
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'at-file', 'aria-label': 'Choose a picture', onchange: ev => takeFile(ev.target.files && ev.target.files[0]) });
    const drop = el('div', { class: 'at-drop', tabindex: '0', role: 'button', 'aria-label': 'Upload a picture: choose a file or drop one here',
      onclick: () => input.click(), onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } },
      ondragover: ev => { ev.preventDefault(); ev.currentTarget.classList.add('over'); }, ondragleave: ev => ev.currentTarget.classList.remove('over'),
      ondrop: ev => { ev.preventDefault(); ev.currentTarget.classList.remove('over'); takeFile(ev.dataTransfer.files && ev.dataTransfer.files[0]); } },
      showing ? el('img', { src: showing, alt: 'The picture for this entry' }) : null,
      el('span', { class: 'at-drop-t' }, showing ? 'Choose another picture, or drop one here' : 'Upload a picture or map: choose a file, or drop one here'));
    return el('div', { class: 'at-f' }, el('span', { class: 'k' }, 'Picture'), drop, input,
      el('div', { class: 'at-picrow' },
        (e.preview || (e.image_path && !e.dropPic)) ? el('button', { type: 'button', class: 'mini', onclick: () => { if (e.preview) URL.revokeObjectURL(e.preview); e.file = null; e.preview = null; e.dropPic = true; render(); } }, 'Remove the picture') : null,
        el('details', { class: 'at-link-alt', open: !!e.image_url && !e.image_path || null }, el('summary', {}, 'Or use a link to a picture hosted elsewhere'),
          el('input', { type: 'url', value: e.image_url, maxlength: 500, placeholder: 'https://…', 'aria-label': 'Picture link', oninput: ev => { e.image_url = ev.target.value; } }))),
      el('span', { class: 'bs-fine' }, 'Pictures are stored privately: players can only load one once its entry is revealed. Big photos are shrunk before uploading.'));
  }

  function renderDetail(pane) {
    const id = state.ent;
    if (!user() || !rows || !id) { document.body.classList.remove('has-detail'); pane.replaceChildren(); return false; }
    document.body.classList.add('has-detail');
    pane.classList.remove('placeholder');
    if (admin() && edit && ((id === 'new' && !edit.id) || edit.id === id)) { editor(pane); return true; }
    if (id === 'new') {
      if (!admin()) { pane.replaceChildren(); document.body.classList.remove('has-detail'); return false; }
      edit = draftOf(null); editor(pane); return true;
    }
    const r = byId(id);
    if (!r) {
      pane.replaceChildren(el('button', { class: 'back', onclick: () => go({ ent: '' }, true) }, '← The Atlas'),
        el('div', { class: 'empty' }, el('strong', {}, 'Not in the atlas'), 'This entry doesn’t exist, or it hasn’t been revealed yet.'));
      return true;
    }
    const k = KIND[r.kind] || KIND.lore;
    const back = mentions(r);
    const notes = admin() ? dm.get(r.id) || '' : '';
    const when = t => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    pane.replaceChildren(...[
      el('button', { class: 'back', onclick: () => go({ ent: '' }, true) }, '← The Atlas'),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge at-badge ' + r.kind }, k.one), r.region ? el('span', {}, r.region) : null,
        admin() ? el('span', { class: 'at-state ' + (r.revealed ? 'on' : 'off') }, r.revealed ? `Revealed ${when(r.revealed_at)}` : 'Hidden from players') : null),
      el('h1', { class: 'd-title' }, r.name),
      hasPicture(r) ? mapFigure(r) : null,
      r.summary ? el('div', { class: 'prose at-prose', html: linked(md(r.summary)) }) : el('p', { class: 'd-note' }, admin() ? 'Nothing written yet.' : 'Nothing more is known yet.'),
      onMaps(r),
      back.length ? el('section', { class: 'd-section' }, el('h2', {}, 'Mentioned in'),
        el('div', { class: 'at-back' }, ...back.map(x => el('a', { class: 'at-link', href: `#tab=atlas&ent=${encodeURIComponent(x.id)}` }, x.name)))) : null,
      admin() ? el('section', { class: 'd-section at-dm' }, el('h2', {}, 'Your notes'),
        notes ? el('div', { class: 'prose', html: linked(md(notes)) }) : el('p', { class: 'd-note' }, 'None. Players never see this section.')) : null,
      msg ? el('p', { class: 'notes-msg' + (/^(Saved|Revealed|Hidden)/.test(msg) ? ' ok' : ''), role: 'status' }, msg) : null,
      admin() ? el('div', { class: 'at-btns' },
        el('button', { class: 'btn small primary', disabled: busy, onclick: () => setRevealed(r, !r.revealed) }, r.revealed ? 'Hide it again' : 'Reveal to players'),
        el('button', { class: 'btn small', onclick: () => startEdit(r) }, 'Edit'),
        delAsk
          ? [el('span', { class: 'bs-fine' }, 'Delete it for good?'), el('button', { class: 'btn small danger', disabled: busy, onclick: () => remove(r) }, 'Delete'), el('button', { class: 'mini', onclick: () => { delAsk = false; render(); } }, 'Keep it')]
          : el('button', { class: 'mini', onclick: () => { delAsk = true; render(); } }, 'Delete')) : null,
      el('p', { class: 'bs-fine at-upd' }, `Last changed ${when(r.updated_at)}.`)].filter(Boolean));
    document.title = `${r.name} · Atlas`;
    return true;
  }

  /* ---------- maps: pins on an entry's picture ----------
     Pins are numbered and listed in a key under the map, so a busy map stays readable: one name shows at a time
     (pointing at a pin, or at its line in the key), unless "Show all names" is on. Enlarge opens the map full screen
     with zoom, where crowded pins spread apart. */
  const NAMES_AT = 8;   // with this many pins or fewer, every name shows by default
  function mapPins(r, revealedOnly) {
    const all = pins.filter(p => p.map_id === r.id && byId(p.entry_id) && (!revealedOnly || byId(p.entry_id).revealed)).map(p => ({ p, e: byId(p.entry_id) }));
    const order = Object.fromEntries(KINDS.map(([k], i) => [k, i]));
    all.sort((a, b) => (order[a.e.kind] ?? 9) - (order[b.e.kind] ?? 9) || a.e.name.localeCompare(b.e.name));
    all.forEach((x, i) => { x.n = i + 1; });
    const only = mapOnly.get(r.id) || '';
    return { all, shown: only ? all.filter(x => x.e.kind === only) : all, only };
  }
  const namesOn = (r, n) => mapNames.has(r.id) ? mapNames.get(r.id) : n <= NAMES_AT;

  function pinEl(x, onHover) {
    const { p, e, n } = x;
    return el('a', { class: 'at-pin' + (e.revealed ? '' : ' hid'), 'data-pin': p.id, href: `#tab=atlas&ent=${encodeURIComponent(e.id)}`,
      style: `left:${p.x}%;top:${p.y}%`, 'aria-label': `${n}: ${e.name}${e.revealed ? '' : ' (hidden)'}`,
      onmouseenter: onHover ? () => onHover(p.id, true) : null, onmouseleave: onHover ? () => onHover(p.id, false) : null,
      onfocus: onHover ? () => onHover(p.id, true) : null, onblur: onHover ? () => onHover(p.id, false) : null },
      el('span', { class: 'num', 'aria-hidden': 'true' }, String(n)), el('span', { class: 'lbl', 'aria-hidden': 'true' }, e.name));
  }
  // light up one pin (and its line in the key); the rest fade
  function lightUp(root, id, on) {
    if (!root) return;
    root.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    root.querySelectorAll('.at-mapbox').forEach(b => b.classList.toggle('focus', !!on));
    if (on) root.querySelectorAll(`[data-pin="${id}"]`).forEach(x => x.classList.add('hl'));
  }

  // bare: for the table screen (no tools, and only what players may see, even when the DM is signed in)
  function mapFigure(r, opts) {
    const bare = !!(opts && opts.bare);
    const isPlacing = !bare && admin() && placing === r.id;
    const { all, shown, only } = mapPins(r, bare);
    const names = namesOn(r, shown.length);
    const src = pictureOf(r);
    if (!src) { signPictures(); return el('figure', { class: 'at-img at-map' }, el('p', { class: 'd-note' }, 'Opening the picture…')); }
    const img = el('img', { src, alt: all.length ? `Map: ${r.name}` : r.name, loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false',
      onerror: ev => { const f = ev.target.closest('figure'); if (f) f.replaceChildren(el('p', { class: 'd-note' }, 'The picture couldn’t be loaded.')); } });
    let fig = null;
    const hover = (id, on) => lightUp(fig, id, on);
    const box = el('div', { class: 'at-mapbox' + (isPlacing ? ' placing' : '') + (names ? ' names' : ''),
      onclick: isPlacing ? ev => {
        if (ev.target.closest('.at-pin')) return;
        const b = ev.currentTarget.getBoundingClientRect();
        pinDraft = { x: Math.round((ev.clientX - b.left) / b.width * 1000) / 10, y: Math.round((ev.clientY - b.top) / b.height * 1000) / 10 };
        render();
      } : null },
      img,
      ...(isPlacing ? all : shown).map(x => pinEl(x, hover)),
      isPlacing && pinDraft ? el('span', { class: 'at-pin draft', style: `left:${pinDraft.x}%;top:${pinDraft.y}%`, 'aria-hidden': 'true' }) : null);
    const kids = [box];

    if (!isPlacing && !bare) {
      const kindsHere = KINDS.filter(([k]) => all.some(x => x.e.kind === k));
      const tools = el('div', { class: 'at-maptools' },
        el('button', { type: 'button', class: 'mini', onclick: ev => openZoom(r, ev.currentTarget) }, 'Enlarge'),
        all.length ? el('button', { type: 'button', class: 'mini', 'aria-pressed': String(names), onclick: () => { mapNames.set(r.id, !names); render(); } }, names ? 'Hide the names' : 'Show all names') : null,
        kindsHere.length > 1 ? el('div', { class: 'at-kinds at-mapkinds', role: 'group', 'aria-label': 'Pins to show' },
          el('button', { type: 'button', class: 'at-kind' + (!only ? ' on' : ''), 'aria-pressed': String(!only), onclick: () => { mapOnly.delete(r.id); render(); } }, 'All pins', el('span', { class: 'n' }, String(all.length))),
          ...kindsHere.map(([k, pl]) => { const c = all.filter(x => x.e.kind === k).length; return el('button', { type: 'button', class: 'at-kind' + (only === k ? ' on' : ''), 'aria-pressed': String(only === k), onclick: () => { if (only === k) mapOnly.delete(r.id); else mapOnly.set(r.id, k); render(); } }, pl, el('span', { class: 'n' }, String(c))); })) : null);
      kids.push(tools);
      const keyLine = x => el('li', { 'data-pin': x.p.id },
          el('a', { href: `#tab=atlas&ent=${encodeURIComponent(x.e.id)}`, class: x.e.revealed ? null : 'hid',
            onmouseenter: () => hover(x.p.id, true), onmouseleave: () => hover(x.p.id, false), onfocus: () => hover(x.p.id, true), onblur: () => hover(x.p.id, false) },
            el('span', { class: 'num' }, String(x.n)), el('span', { class: 'nm' }, x.e.name), x.e.revealed ? null : el('span', { class: 'bs-fine' }, ' (hidden)')));
      const keyKinds = KINDS.filter(([k]) => shown.some(x => x.e.kind === k));
      if (shown.length) kids.push(el('div', { class: 'at-key', role: 'group', 'aria-label': 'On this map' },
        ...keyKinds.map(([k, pl]) => el('div', { class: 'at-keyg' },
          keyKinds.length > 1 ? el('h3', { class: 'at-keyh' }, pl) : null,
          el('ol', {}, ...shown.filter(x => x.e.kind === k).map(keyLine))))));
    }

    if (bare && shown.length) kids.push(el('ol', { class: 'at-key' }, ...shown.map(x => el('li', {}, el('span', { class: 'num' }, String(x.n)), el('span', { class: 'nm' }, x.e.name)))));
    if (admin() && !bare) {
      if (!isPlacing) kids.push(el('div', { class: 'at-mapbar' }, el('button', { type: 'button', class: 'mini', onclick: () => { placing = r.id; pinDraft = null; pinPick = ''; render(); } }, all.length ? `Edit the pins (${all.length})` : 'Use as a map: place pins')));
      else {
        const others = rows.filter(x => x.id !== r.id);
        const addPin = async () => {
          if (!pinDraft || !pinPick) return;
          busy = true; render();
          const res = await sb().from('atlas_pins').insert({ map_id: r.id, entry_id: pinPick, x: pinDraft.x, y: pinDraft.y });
          busy = false;
          if (res.error) { msg = /atlas_pins|does not exist|schema cache/i.test(String(res.error.message)) ? 'Run the latest supabase/setup.sql to switch on map pins.' : friendly(res.error); render(); return; }
          pinDraft = null; pinPick = ''; msg = ''; await load(true);
        };
        kids.push(el('div', { class: 'at-mapbar placing' },
          el('p', { class: 'bs-fine' }, pinDraft ? 'Which entry goes here?' : 'Click the picture where a pin should go. Players see a pin once both this map and its entry are revealed.'),
          pinDraft ? el('div', { class: 'at-pinadd' },
            el('select', { class: 'select', 'aria-label': 'Entry for this pin', onchange: e => { pinPick = e.target.value; } },
              el('option', { value: '' }, 'Pick an entry…'), ...others.map(x => el('option', { value: x.id, selected: pinPick === x.id }, `${x.name}${x.revealed ? '' : ' (hidden)'}`))),
            el('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: addPin }, 'Pin it'),
            el('button', { type: 'button', class: 'mini', onclick: () => { pinDraft = null; render(); } }, 'Not there')) : null,
          all.length ? el('ul', { class: 'at-pinlist' }, ...all.map(x => el('li', { 'data-pin': x.p.id, onmouseenter: () => hover(x.p.id, true), onmouseleave: () => hover(x.p.id, false) },
            el('span', {}, `${x.n}. ${x.e.name}`),
            el('button', { type: 'button', class: 'mini', 'aria-label': `Remove the pin for ${x.e.name}`, disabled: busy, onclick: async () => { busy = true; render(); const res = await sb().from('atlas_pins').delete().eq('id', x.p.id); busy = false; if (res.error) { msg = friendly(res.error); render(); return; } await load(true); } }, 'Remove')))) : null,
          el('button', { type: 'button', class: 'btn small', onclick: () => { placing = ''; pinDraft = null; render(); } }, 'Done')));
      }
    }
    fig = el('figure', { class: 'at-img at-map' }, ...kids);
    return fig;
  }

  /* ---------- the map full screen, with zoom ----------
     Built straight into the page (not through render()), so zooming and panning keep their place.
     Drag or swipe to move around; pinch, Ctrl + scroll, or the + and − buttons to zoom. */
  let zoomClose = null;
  function openZoom(r, opener) {
    if (zoomClose) zoomClose();
    const { shown } = mapPins(r);
    let names = namesOn(r, shown.length), z = 1;
    const MIN = 1, MAX = 6;
    // 100% shows the whole map in the window
    const fitW = () => { const a = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.5; return Math.max(1, Math.min(pane.clientWidth, pane.clientHeight * a)); };
    const img = el('img', { src: pictureOf(r), alt: `Map: ${r.name}`, draggable: 'false', referrerpolicy: 'no-referrer' });
    const box = el('div', { class: 'at-mapbox' + (names ? ' names' : '') }, img, ...shown.map(x => pinEl(x, null)));
    const pane = el('div', { class: 'at-zoompane', tabindex: '0', 'aria-label': 'The map: drag to move around' }, box);
    const pct = el('span', { class: 'at-zoompct', 'aria-live': 'polite' }, '100%');
    const nameBtn = el('button', { type: 'button', class: 'mini', 'aria-pressed': String(names) }, names ? 'Hide the names' : 'Show all names');
    const closeBtn = el('button', { type: 'button', class: 'btn small' }, 'Close');
    const outBtn = el('button', { type: 'button', class: 'btn small at-zb', 'aria-label': 'Zoom out' }, '−');
    const inBtn = el('button', { type: 'button', class: 'btn small at-zb', 'aria-label': 'Zoom in' }, '+');
    const wrap = el('div', { class: 'at-zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Map: ${r.name}` },
      el('div', { class: 'at-zoombar' }, el('strong', { class: 'at-zoomt' }, r.name), outBtn, pct, inBtn, nameBtn, closeBtn), pane);

    // zoom about a point in the pane (default: its centre), keeping that point still
    function setZoom(nz, cx, cy) {
      nz = Math.max(MIN, Math.min(MAX, nz));
      const pr = pane.getBoundingClientRect();
      if (cx == null) { cx = pr.width / 2; cy = pr.height / 2; }
      const fx = (pane.scrollLeft + cx) / box.offsetWidth, fy = (pane.scrollTop + cy) / box.offsetHeight;
      z = nz; box.style.width = Math.round(fitW() * z) + 'px';
      pane.scrollLeft = fx * box.offsetWidth - cx; pane.scrollTop = fy * box.offsetHeight - cy;
      pct.textContent = Math.round(z * 100) + '%';
      outBtn.disabled = z <= MIN; inBtn.disabled = z >= MAX;
    }
    outBtn.onclick = () => setZoom(z / 1.5);
    inBtn.onclick = () => setZoom(z * 1.5);
    nameBtn.onclick = () => { names = !names; box.classList.toggle('names', names); nameBtn.setAttribute('aria-pressed', String(names)); nameBtn.textContent = names ? 'Hide the names' : 'Show all names'; };
    pane.addEventListener('wheel', ev => {
      if (!ev.ctrlKey && !ev.metaKey) return;   // plain scrolling moves around; Ctrl + scroll (or a trackpad pinch) zooms
      ev.preventDefault();
      const pr = pane.getBoundingClientRect();
      setZoom(z * Math.exp(-ev.deltaY * 0.0025), ev.clientX - pr.left, ev.clientY - pr.top);
    }, { passive: false });
    // drag to pan (mouse, pen or one finger); two fingers pinch to zoom
    const pts = new Map(); let moved = 0, pinch = null;
    pane.addEventListener('pointerdown', ev => { if (ev.button > 0) return; pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); moved = pts.size > 1 ? 99 : 0; pinch = null; });
    pane.addEventListener('pointermove', ev => {
      const was = pts.get(ev.pointerId); if (!was) return;
      if (pts.size === 1) {
        const dx = ev.clientX - was.x, dy = ev.clientY - was.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) { pane.scrollLeft -= dx; pane.scrollTop -= dy; if (!pane.hasPointerCapture(ev.pointerId)) pane.setPointerCapture(ev.pointerId); }
        pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      } else if (pts.size === 2) {
        pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), pr = pane.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - pr.left, my = (a.y + b.y) / 2 - pr.top;
        if (pinch) { setZoom(z * d / pinch.d, mx, my); pane.scrollLeft -= mx - pinch.mx; pane.scrollTop -= my - pinch.my; }
        pinch = { d, mx, my };
      }
    });
    const up = ev => { pts.delete(ev.pointerId); if (pts.size < 2) pinch = null; };
    pane.addEventListener('pointerup', up); pane.addEventListener('pointercancel', up);
    pane.addEventListener('click', ev => { if (moved > 4) { ev.preventDefault(); ev.stopPropagation(); } }, true);   // a drag isn't a click on a pin
    pane.addEventListener('keydown', ev => {
      const step = 60;
      if (ev.key === '+' || ev.key === '=') { setZoom(z * 1.5); ev.preventDefault(); }
      else if (ev.key === '-' || ev.key === '_') { setZoom(z / 1.5); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { pane.scrollLeft -= step; ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { pane.scrollLeft += step; ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { pane.scrollTop -= step; ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { pane.scrollTop += step; ev.preventDefault(); }
    });

    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
      if (ev.key === 'Tab') {   // keep Tab inside the dialog
        const f = [...wrap.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (ev.shiftKey && i <= 0) { f[f.length - 1].focus(); ev.preventDefault(); }
        else if (!ev.shiftKey && i === f.length - 1) { f[0].focus(); ev.preventDefault(); }
      }
    };
    const onHash = () => close(true);
    function close(navigating) {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('resize', onResize);
      document.documentElement.classList.remove('at-zooming');
      wrap.remove(); zoomClose = null;
      if (!navigating && opener && opener.isConnected) opener.focus();
    }
    closeBtn.onclick = () => close();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', onHash);
    document.documentElement.classList.add('at-zooming');
    document.body.append(wrap);
    zoomClose = close;
    const start = () => setZoom(1);
    const onResize = () => setZoom(z);
    window.addEventListener('resize', onResize);
    if (img.complete) start(); else img.addEventListener('load', start, { once: true });
    closeBtn.focus();
  }

  // the maps this entry is pinned on
  function onMaps(r) {
    const maps = [...new Set(pins.filter(p => p.entry_id === r.id).map(p => p.map_id))].map(byId).filter(Boolean);
    return maps.length ? el('section', { class: 'd-section' }, el('h2', {}, 'On the map'),
      el('div', { class: 'at-back' }, ...maps.map(m => el('a', { class: 'at-link', href: `#tab=atlas&ent=${encodeURIComponent(m.id)}` }, m.name)))) : null;
  }

  function onEscape() {
    if (placing) { placing = ''; pinDraft = null; render(); return true; }
    if (edit) { edit = null; msg = ''; go({ ent: state.ent === 'new' ? '' : state.ent }, true); return true; }
    if (state.ent) { go({ ent: '' }, true); return true; }
    return false;
  }

  // site search: revealed entries for players, everything for the DM (whatever the database sent)
  function siteHits(q) {
    if (!rows) { if (user() && !loading && !loadErr) load(); return []; }
    const n = norm(q.trim());
    if (!n) return [];
    return rows.filter(r => hay(r).includes(n)).slice(0, 12);
  }

  // for the session screen
  const api = {
    rows: () => rows,
    load: () => load(),
    reveal: async (id, on) => {
      const res = await sb().from('atlas').update({ revealed: on }).eq('id', id);
      if (res.error) return friendly(res.error);
      await load(true);
      const r = byId(id);
      return on ? `Revealed ${r ? r.name : 'it'}. Players can read it now.` : `Hidden ${r ? r.name : 'it'} from players again.`;
    },
  };

  // a revealed map, for the table screen
  function figure(id, opts) {
    const r = byId(id);
    if (!r || !r.revealed || !hasPicture(r)) return null;
    return mapFigure(r, opts);
  }

  return { init, renderList, renderDetail, onEscape, siteHits, KIND, api, figure };
};
