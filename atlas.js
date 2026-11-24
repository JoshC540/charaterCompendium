/* The Atlas: places, factions, people, creatures, items and lore the party uncovers.
   The DM writes every entry and decides when each one is revealed. Players are only ever sent revealed entries
   (row-level security in supabase/setup.sql), and the DM's private notes sit in a separate table only the DM can read. */
window.HandbookAtlas = function (H) {
  'use strict';
  const { el, md, esc, norm, state, go, render, Notes } = H;

  const KINDS = [['place', 'Places', 'Place'], ['faction', 'Factions', 'Faction'], ['person', 'People', 'Person'], ['creature', 'Creatures', 'Creature'], ['item', 'Items', 'Item'], ['lore', 'Lore', 'Lore']];
  const KIND = Object.fromEntries(KINDS.map(([k, p, s]) => [k, { plural: p, one: s }]));

  let rows = null, dm = new Map(), loading = false, loadErr = '', loadedAt = 0;
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
      if (admin()) {
        const n = await sb().from('atlas_dm').select('*');
        dm = new Map(((n && n.data) || []).map(x => [x.id, x.notes || '']));
      }
      loadedAt = Date.now();
    } catch (e) {
      loadErr = /does not exist|relation|schema cache/i.test(String(e && (e.message || e))) ? 'missing' : friendly(e);
      rows = null;
    }
    loading = false;
    if (state.tab === 'atlas') render();
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

  const draftOf = r => r ? { id: r.id, kind: r.kind, name: r.name, region: r.region || '', image_url: r.image_url || '', summary: r.summary || '', notes: dm.get(r.id) || '', revealed: !!r.revealed }
    : { id: null, kind: kind || 'place', name: '', region: '', image_url: '', summary: '', notes: '', revealed: false };
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
        field('Picture', el('input', { type: 'url', value: e.image_url, maxlength: 500, placeholder: 'https://… (optional)', oninput: set('image_url') }), 'A link to an image hosted elsewhere.'),
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
      r.image_url ? el('figure', { class: 'at-img' }, el('img', { src: r.image_url, alt: r.name, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: ev => { ev.target.closest('figure').remove(); } })) : null,
      r.summary ? el('div', { class: 'prose at-prose', html: linked(md(r.summary)) }) : el('p', { class: 'd-note' }, admin() ? 'Nothing written yet.' : 'Nothing more is known yet.'),
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

  function onEscape() {
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

  return { init, renderList, renderDetail, onEscape, siteHits, KIND };
};
