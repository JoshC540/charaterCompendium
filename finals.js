/* Final classes: DM-only until the DM lets a player see them.
   The text lives in Supabase (the `finals` table, loaded from the separate finals-data folder, never this repo).
   A player reads a class's finals once the DM ticks that class (or "every class") for them under "Who can see them";
   the database enforces it (supabase/setup.sql: finals, final_access). The four new Mage schools are public now: Handbook → Spells and Subclasses. */
window.HandbookFinals = function (H) {
  'use strict';
  const { el, state, go, render, Notes } = H;

  const sb = () => Notes && Notes.client && Notes.client();
  const user = () => Notes && Notes.user && Notes.user();
  const admin = () => !!(Notes && Notes.isAdmin && Notes.isAdmin());
  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : String((e && e.message) || e));
  const missing = e => /does not exist|schema cache|relation .* not|could not find/i.test(String((e && e.message) || e || ''));
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '');
  const CATS = [['melee', 'Melee'], ['ranged', 'Ranged'], ['other', 'Other'], ['magic', 'Magic']];

  /* ---------- who can see what ---------- */
  let access = null, accessFor = '', accessBusy = false;   // rows of final_access (the DM gets everyone's)
  let profiles = [];
  async function loadAccess() {
    const u = user();
    if (accessBusy || !sb() || !u) return;
    accessBusy = true;
    const r = await sb().from('final_access').select('user_id, class_id');
    if (admin()) { const p = await sb().from('profiles').select('id, display_name, is_admin'); profiles = (p && p.data) || []; }
    accessBusy = false;
    access = r.error ? [] : (r.data || []); accessFor = u.id;
    render();
  }
  const mine = () => { const u = user(); return u && access ? access.filter(a => a.user_id === u.id) : []; };
  // the tab shows for the DM, and for a player the DM has let in
  function visible() {
    const u = user();
    if (!u) return false;
    if (admin()) return true;
    if (accessFor !== u.id) { loadAccess(); return false; }
    return mine().length > 0;
  }

  /* ---------- the text ---------- */
  let rows = null, rowsFor = '', loadErr = '', busy = false, msg = '', msgOk = false, q = '';
  async function load() {
    const u = user();
    if (busy || !sb() || !u) return;
    busy = true;
    const r = await sb().from('finals').select('id, kind, class_id, sort, data').order('sort', { ascending: true });
    busy = false;
    if (r.error) { loadErr = missing(r.error) ? 'missing' : friendly(r.error); rows = []; }
    else { loadErr = ''; rows = r.data || []; }
    rowsFor = u.id;
    render();
  }
  const classes = () => (rows || []).filter(r => r.kind === 'class').map(r => r.data);
  function findFinal(id) {
    for (const c of classes()) { const f = (c.finals || []).find(x => x.id === id); if (f) return { c, f }; }
    return null;
  }
  const say = (t, ok) => { msg = t; msgOk = !!ok; };
  const msgBox = () => msg ? el('p', { class: 'notes-msg' + (msgOk ? ' ok' : ''), role: 'status' }, msg) : null;

  /* ---------- list ---------- */
  function gate(box) {
    if (!user()) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Final classes'), 'Sign in to read them.')); return false; }
    if (rowsFor !== user().id) { load(); if (admin() || accessFor !== user().id) loadAccess(); box.replaceChildren(el('div', { class: 'empty' }, 'Opening the final classes…')); return false; }
    if (loadErr) {
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, loadErr === 'missing' ? 'Final classes aren’t set up yet' : 'Couldn’t load the final classes'),
        loadErr === 'missing' ? (admin() ? 'Run the latest supabase/setup.sql in the Supabase SQL editor, then the three files in finals-data, then reload.' : 'The DM hasn’t switched them on yet.') : loadErr));
      return false;
    }
    if (!rows.length) {
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, admin() ? 'No final classes loaded yet' : 'Nothing to see yet'),
        admin() ? 'Supabase dashboard → SQL Editor: run finals-data/finals-1.sql, finals-2.sql and finals-3.sql, then reload.' : 'Your DM hasn’t let you see any final classes yet.'));
      return false;
    }
    return true;
  }
  const matches = (c, f) => {
    if (!q) return true;
    const t = norm(q);
    return [c.name, f.name, f.subclass, ...((f.abilities || []).concat(f.base_abilities || []).map(a => a.name))].some(x => norm(x).includes(t));
  };
  function renderList(box, meta) {
    meta.textContent = '';
    if (!gate(box)) return;
    const row = (pick, name, sub, extra) => el('button', { type: 'button', class: 'tb-row fc-row' + (state.pick === pick ? ' on' : ''), 'aria-current': state.pick === pick ? 'true' : null, onclick: () => { say(''); go({ pick }, true); } },
      el('span', { class: 'nm' }, name), sub ? el('span', { class: 'sub' }, sub) : null, extra || null);
    const cls = classes();
    const groups = CATS.map(([k, label]) => {
      const list = cls.filter(c => c.category === k).map(c => ({ c, fs: (c.finals || []).filter(f => matches(c, f)) })).filter(x => x.fs.length || (!q && x.c));
      if (!list.length) return null;
      return el('section', { class: 'tb-grp' }, el('h2', { class: 'section-head' }, label),
        ...list.map(({ c, fs }) => el('div', { class: 'fc-class' },
          el('button', { type: 'button', class: 'fc-cname' + (state.pick === 'class:' + c.id ? ' on' : ''), onclick: () => { say(''); go({ pick: 'class:' + c.id }, true); } }, c.name),
          el('div', { class: 'tb-rows' }, ...fs.map(f => row(f.id, f.name, f.subclass))))));
    }).filter(Boolean);
    const n = cls.reduce((a, c) => a + (c.finals || []).length, 0);
    box.replaceChildren(el('div', { class: 'tb-list fc-list' },
      el('div', { class: 'tb-head' }, el('h1', { class: 'tb-title' }, 'Final classes'),
        admin() ? el('button', { class: 'btn small' + (state.pick === 'access' ? ' primary' : ''), onclick: () => { say(''); go({ pick: 'access' }, true); } }, 'Who can see them') : null),
      el('p', { class: 'd-note' }, admin()
        ? `${n} finals across ${cls.length} classes. Only you see them, and the players you let in under “Who can see them”.`
        : `The final classes your DM has let you see (${n}).`),
      el('label', { class: 'fc-search' }, el('span', { class: 'sr-only' }, 'Find a final class'),
        el('input', { type: 'search', class: 'search-in', placeholder: 'Find a final, a subclass or an ability', value: q, oninput: e => { q = e.target.value; const pos = e.target.selectionStart; render(); const i = document.querySelector('.fc-search input'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (er) { /* fine */ } } } })),
      ...groups,
      !groups.length ? el('div', { class: 'empty' }, 'Nothing matches that.') : null));
  }

  /* ---------- reading ---------- */
  const tagB = t => t ? el('span', { class: 'fc-tag' }, t) : null;
  const ability = a => el('div', { class: 'fc-ab' },
    el('h4', {}, a.name, ' ', tagB(a.tag)),
    a.upgrades ? el('p', { class: 'fc-up' }, `Upgrades “${a.upgrades}”`) : null,
    el('p', {}, a.text));
  const tiers = sp => Object.keys(sp || {}).sort((a, b) => +a - +b).map(t => el('div', { class: 'fc-tier' },
    el('h4', {}, `Tier ${t}`),
    el('ul', {}, ...(sp[t] || []).map(s => el('li', {}, el('strong', {}, s.name), s.tag ? el('span', { class: 'fc-tag' }, s.tag) : null, `: ${s.text}`)))));
  const section = (title, ...kids) => el('section', { class: 'd-section' }, el('h2', {}, title), ...kids);
  const back = () => el('button', { class: 'back', onclick: () => go({ pick: '' }, true) }, '← Final classes');
  const dmBadge = () => admin() ? el('span', { class: 'badge fc-dm' }, 'DM only') : null;
  const prose = paras => el('div', { class: 'prose' }, ...(paras || []).map(p => el('p', {}, p)));

  function finalView(pane, c, f) {
    pane.replaceChildren(...[
      back(),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge' }, `${c.name} final`), f.subclass ? el('span', {}, f.subclass) : null, dmBadge()),
      el('h1', { class: 'd-title' }, f.name),
      f.quote ? el('blockquote', { class: 'fc-quote' }, `“${f.quote}”`) : null,
      prose(f.flavour),
      f.format === 'caster' ? section('Base abilities', ...(f.base_abilities || []).map(ability)) : section('Abilities', ...(f.abilities || []).map(ability)),
      f.format === 'caster' && f.spells ? section('Spells', ...tiers(f.spells)) : null,
      (c.generics || []).length ? section(`Every ${c.name} final also gets`, ...c.generics.map(g => ability({ name: g.name, text: g.text }))) : null,
      f.closer ? el('p', { class: 'fc-closer' }, f.closer) : null,
      el('p', { class: 'fc-more' }, 'More ', el('button', { class: 'linkish', onclick: () => go({ pick: 'class:' + c.id }, true) }, `${c.name} finals`)),
    ].filter(Boolean));
    document.title = `${f.name} · Final classes · Player’s Handbook`;
  }
  function classView(pane, c) {
    pane.replaceChildren(...[
      back(),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge' }, CATS.find(x => x[0] === c.category) ? CATS.find(x => x[0] === c.category)[1] : 'Class'), dmBadge()),
      el('h1', { class: 'd-title' }, `${c.name} finals`),
      (c.generics || []).length ? section('Every final of this class gets', ...c.generics.map(g => ability({ name: g.name, text: g.text }))) : null,
      section('The finals', el('div', { class: 'tb-rows' }, ...(c.finals || []).map(f => el('button', { type: 'button', class: 'tb-row fc-row', onclick: () => go({ pick: f.id }, true) },
        el('span', { class: 'nm' }, f.name), el('span', { class: 'sub' }, [f.subclass, f.quote ? `“${f.quote.length > 90 ? f.quote.slice(0, 88).replace(/\s+\S*$/, '') + '…' : f.quote}”` : ''].filter(Boolean).join(' · ')))))),
    ].filter(Boolean));
    document.title = `${c.name} finals · Player’s Handbook`;
  }


  /* ---------- the DM: who can see them ---------- */
  let saving = false;
  const openWho = new Set();   // whose box stays open while ticks save
  async function setAccess(uid, cid, on) {
    saving = true; render();
    const r = on ? await sb().from('final_access').insert({ user_id: uid, class_id: cid })
      : await sb().from('final_access').delete().eq('user_id', uid).eq('class_id', cid);
    saving = false;
    if (r.error) say(missing(r.error) ? 'Run the latest supabase/setup.sql first.' : friendly(r.error));
    else say('Saved. It changes what they see the next time they open the page.', true);
    accessFor = ''; await loadAccess();
  }
  function accessView(pane) {
    if (!admin()) return false;
    if (accessFor !== user().id) { loadAccess(); pane.replaceChildren(back(), el('div', { class: 'empty' }, 'Loading…')); return true; }
    const players = profiles.filter(p => !p.is_admin).sort((a, b) => a.display_name.localeCompare(b.display_name));
    const has = (uid, cid) => access.some(a => a.user_id === uid && a.class_id === cid);
    const cls = classes();
    const summary = uid => has(uid, '*') ? 'Every final class' : (() => { const l = cls.filter(c => has(uid, c.id)).map(c => c.name); return l.length ? l.join(', ') : 'None'; })();
    pane.replaceChildren(...[
      back(),
      el('div', { class: 'd-kicker' }, dmBadge()),
      el('h1', { class: 'd-title' }, 'Who can see them'),
      el('p', { class: 'd-note' }, 'Tick a class to let a player read its finals, or “Every final class”.'),
      msgBox(),
      !players.length ? el('div', { class: 'empty' }, 'No player accounts yet.') : null,
      ...players.map(p => el('details', { class: 'fc-who', open: openWho.has(p.id), ontoggle: e => { if (e.target.open) openWho.add(p.id); else openWho.delete(p.id); } },
        el('summary', {}, el('strong', {}, p.display_name), el('span', { class: 'bs-fine' }, ` · ${summary(p.id)}`)),
        el('label', { class: 'toggle fc-all' }, el('input', { type: 'checkbox', disabled: saving, checked: has(p.id, '*'), onchange: e => setAccess(p.id, '*', e.target.checked) }), ' Every final class'),
        ...CATS.map(([k, label]) => {
          const list = cls.filter(c => c.category === k);
          return list.length ? el('fieldset', { class: 'fc-pick' }, el('legend', {}, label),
            ...list.map(c => el('label', { class: 'toggle' }, el('input', { type: 'checkbox', disabled: saving || has(p.id, '*'), checked: has(p.id, '*') || has(p.id, c.id), onchange: e => setAccess(p.id, c.id, e.target.checked) }), ' ', c.name))) : null;
        }))),
    ].filter(Boolean));
    document.title = 'Who can see the final classes · Player’s Handbook';
    return true;
  }

  function renderDetail(pane) {
    const p = state.pick;
    if (!user() || !p || rowsFor !== user().id || !rows) return false;
    if (p === 'access') return accessView(pane);
    if (p.startsWith('class:')) { const c = classes().find(x => x.id === p.slice(6)); if (c) { classView(pane, c); return true; } }
    else { const hit = findFinal(p); if (hit) { finalView(pane, hit.c, hit.f); return true; } }
    pane.replaceChildren(back(), el('div', { class: 'empty' }, 'That final class isn’t here.'));
    return true;
  }

  function init() {
    if (Notes && Notes.onAuth) Notes.onAuth(() => { rows = null; rowsFor = ''; access = null; accessFor = ''; profiles = []; q = ''; say(''); if (user()) loadAccess(); });
    if (user()) loadAccess();
    else setTimeout(() => { if (user()) loadAccess(); }, 2500);
  }

  return { init, visible, renderList, renderDetail };
};
