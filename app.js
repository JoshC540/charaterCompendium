/* Character Compendium — loads the markdown files in /content, then provides search, filters and detail views. */
(() => {
  'use strict';

  const FILES = {
    race: 'content/races.md',
    class: 'content/classes.md',
    subclass: 'content/subclasses.md',
    spell: 'content/spells.md',
    adv: 'content/advancement.md',
    god: 'content/gods.md',
    patch: 'content/patch-notes.md',
  };
  const TYPES = ['race', 'class', 'subclass', 'spell', 'adv', 'god', 'patch'];
  const DOC_TYPES = ['adv', 'god', 'patch'];
  const TYPE_LABEL = { all: 'All', race: 'Races', class: 'Classes', subclass: 'Subclasses', spell: 'Spells', adv: 'Advancement', god: 'Gods', notes: 'Notes', chars: 'Characters', patch: 'Patch Notes', settings: 'Settings' };
  const TYPE_ONE = { race: 'Race', class: 'Class', subclass: 'Subclass', spell: 'Spell', adv: 'Advancement', god: 'Book of Gods', patch: 'Patch notes' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const LOCK_SVG = '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke-width="1.6"/></svg>';
  const lockBadge = (cls, label) => el('span', { class: `badge ${cls}`, title: 'Locked', html: LOCK_SVG + esc(label) });
  const slug = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9+]+/g, ' ').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- markdown ---------------- */

  function parseDoc(text) {
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    const groups = [];
    let g = null, e = null, metaMode = false;
    const target = () => e || g;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if ((m = line.match(/^# (.+)$/))) {
        g = { title: m[1].trim(), meta: {}, body: [], entries: [] };
        groups.push(g); e = null; metaMode = true; continue;
      }
      if ((m = line.match(/^## (.+)$/))) {
        if (!g) { g = { title: '', meta: {}, body: [], entries: [] }; groups.push(g); }
        e = { title: m[1].trim(), meta: {}, body: [] };
        g.entries.push(e); metaMode = true; continue;
      }
      if (metaMode && (m = line.match(/^([a-z][a-z ]{0,20}):\s*(.*)$/))) {
        target().meta[m[1].trim()] = m[2].trim(); continue;
      }
      metaMode = false;
      if (target()) target().body.push(line);
    }
    const tidy = arr => arr.join('\n').replace(/^\n+|\n+$/g, '');
    for (const grp of groups) {
      grp.body = tidy(grp.body);
      for (const en of grp.entries) en.body = tidy(en.body);
    }
    return groups;
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  function table(rows) {
    rows = rows.filter(r => !/^[\s|:-]+$/.test(r));   // ignore markdown separator rows like | --- |
    const cells = rows.map(r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
    const cols = Math.max(...cells.map(r => r.length));
    if (cols === 1) return `<div class="callout">${cells.map(r => `<p>${inline(r[0])}</p>`).join('')}</div>`;
    const [head, ...body] = cells;
    const narrow = Array.from({ length: cols }, (_, k) => body.length > 0 && body.every(r => plain(r[k] || '').length <= 6));
    const tr = (r, tag) => `<tr>${Array.from({ length: cols }, (_, k) => `<${tag}${narrow[k] ? ' class="nar"' : ''}>${inline(r[k] || '')}</${tag}>`).join('')}</tr>`;
    // size columns by how much text they hold, so long descriptions get the room
    const wts = Array.from({ length: cols }, (_, k) => narrow[k] ? 0 : Math.sqrt(Math.max(8, body.reduce((n, r) => n + plain(r[k] || '').length, 0) / Math.max(1, body.length))));
    const total = wts.reduce((a, b) => a + b, 0) || 1;
    const colgroup = `<colgroup>${wts.map(w => `<col style="width:${w ? Math.round(w / total * 100) : 1}%">`).join('')}</colgroup>`;
    return `<div class="table-wrap"><table>${colgroup}<thead>${tr(head, 'th')}</thead><tbody>${body.map(r => tr(r, 'td')).join('')}</tbody></table></div>`;
  }

  function md(src) {
    if (!src) return '';
    const out = [];
    let para = [];
    let rows = [];
    const stack = []; // open lists: { depth, tag }
    const flushPara = () => {
      if (!para.length) return;
      const txt = para.join(' ');
      const cls = /^\*\*Unlock:\*\*/.test(txt) ? ' class="unlock"' : '';
      out.push(`<p${cls}>${inline(txt)}</p>`);
      para = [];
    };
    const closeLists = (depth = -1) => {
      while (stack.length && stack[stack.length - 1].depth > depth) { out.push(`</li></${stack.pop().tag}>`); }
    };
    const flushTable = () => { if (rows.length) { out.push(table(rows)); rows = []; } };
    for (const line of src.split('\n')) {
      let m;
      if (/^\s*\|/.test(line)) { flushPara(); closeLists(); rows.push(line); continue; }
      flushTable();
      if (!line.trim()) { flushPara(); closeLists(); continue; }
      if ((m = line.match(/^(#{3,4}) (.+)$/))) {
        flushPara(); closeLists();
        const lvl = m[1].length;
        out.push(`<h${lvl} id="h-${slug(m[2])}">${inline(m[2])}</h${lvl}>`);
        continue;
      }
      if ((m = line.match(/^(\s*)(?:([-*])|\d+\.) (.+)$/))) {
        flushPara();
        const depth = Math.floor(m[1].length / 2);
        const tag = m[2] ? 'ul' : 'ol';
        const top = stack.length ? stack[stack.length - 1].depth : -1;
        if (depth > top) { out.push(`<${tag}><li>`); stack.push({ depth, tag }); }
        else {
          closeLists(depth);
          if (stack.length && stack[stack.length - 1].tag !== tag) { out.push(`</li></${stack.pop().tag}><${tag}><li>`); stack.push({ depth, tag }); }
          else out.push('</li><li>');
        }
        out.push(inline(m[3]));
        continue;
      }
      if (stack.length) { out.push(' ' + inline(line.trim())); continue; }
      para.push(line.trim());
    }
    flushTable(); flushPara(); closeLists();
    return out.join('');
  }

  const plain = s => (s || '').replace(/^#+ /gm, '').replace(/^\s*(?:[-*]|\d+\.) /gm, '').replace(/\|/g, ' ').replace(/\*\*|\*|`/g, '').replace(/\s+/g, ' ').trim();

  /* ---------------- data ---------------- */

  const DB = { items: [], byId: new Map(), raceIntros: {}, subGroups: [], schools: [], sourceIndex: new Map(), classOrder: [], docs: { adv: [], god: [], patch: [] } };

  // first readable paragraph of a body: skips tables, headings and lists
  const firstPara = body => {
    for (const block of (body || '').split(/\n\s*\n/)) {
      const b = block.trim();
      if (!b || /^(\||#|\s*[-*] |\d+\. )/.test(b)) continue;
      return plain(b);
    }
    return '';
  };

  function uniqueId(base) {
    let id = base, i = 2;
    while (DB.byId.has(id)) id = `${base}-${i++}`;
    return id;
  }
  function add(item) {
    item.id = uniqueId(item.id);
    item.order = DB.items.length;
    DB.items.push(item);
    DB.byId.set(item.id, item);
    item._name = norm(item.name);
    item._meta = norm(item.metaText || '');
    item._body = norm(plain(item.bodyText || ''));
    return item;
  }

  function build(raw) {
    // Races
    for (const g of parseDoc(raw.race)) {
      if (g.body) DB.raceIntros[g.title] = g.body;
      const isPrime = /prime/i.test(g.title);
      for (const e of g.entries) {
        add({
          type: 'race', id: `race/${slug(e.title)}`, name: e.title, meta: e.meta, body: e.body, group: g.title,
          prime: isPrime, base: e.meta.base || null,
          metaText: `race ${g.title} ${isPrime ? 'prime primal alpha variant' : ''} ${Object.values(e.meta).join(' ')}`, bodyText: e.body,
          snippet: plain(e.body.split('\n\n')[0]),
        });
      }
    }
    for (const r of DB.items) if (r.type === 'race' && r.prime && r.base) {
      const b = DB.byId.get(`race/${slug(r.base)}`);
      if (b) { b.primeId = r.id; r.baseId = b.id; }
    }
    // Classes
    for (const g of parseDoc(raw.class)) {
      for (const e of g.entries) {
        DB.classOrder.push(e.title);
        add({
          type: 'class', id: `class/${slug(e.title)}`, name: e.title, category: g.title, meta: e.meta, body: e.body,
          metaText: `class ${g.title} ${Object.values(e.meta).join(' ')}`, bodyText: e.body,
          snippet: plain(e.body.split('\n\n')[0]),
        });
      }
    }
    // Subclasses
    for (const g of parseDoc(raw.subclass)) {
      const group = {
        title: g.title, key: slug(g.title), className: g.meta.class || g.title,
        spellsTag: g.meta.spells || null, intro: g.body, items: [],
      };
      DB.subGroups.push(group);
      if (group.spellsTag) DB.sourceIndex.set(group.spellsTag, { classId: `class/${slug(group.className)}`, group });
      for (const e of g.entries) {
        const upcoming = e.meta.status === 'upcoming';
        const sixth = e.meta.sixth === 'yes';
        const it = add({
          type: 'subclass', id: `subclass/${group.key}/${slug(e.title)}`, name: e.title, group, className: group.className,
          upcoming, sixth, spellsTag: e.meta.spells || null, body: e.body,
          metaText: `subclass ${group.title} ${group.className} ${e.meta.spells || ''} ${sixth ? 'sixth locked' : ''}`, bodyText: e.body,
          snippet: upcoming ? (e.body ? plain(e.body) + ' · ' : '') + 'Details not released yet' : plain(e.body.split('\n\n')[0]),
        });
        group.items.push(it);
        if (it.spellsTag) DB.sourceIndex.set(it.spellsTag, { subId: it.id, group });
      }
    }
    // Handbook chapters (Advancement, Gods): every # chapter intro and ## section becomes a readable entry
    for (const t of DOC_TYPES) {
      for (const g of parseDoc(raw[t])) {
        const mk = (name, body, isIntro) => {
          const heads = [...body.matchAll(/^###+ (.+)$/gm)].map(m => m[1]);
          const it = add({
            type: t, id: `${t}/${slug(g.title)}${isIntro ? '' : '/' + slug(name)}`, name, chapter: g.title, body, heads,
            metaText: `${TYPE_LABEL[t]} ${g.title} ${heads.join(' ')}`, bodyText: body,
            snippet: t === 'patch'
              ? plain(((body.match(/^\s*[-*] (.+)$/m) || [])[1]) || firstPara(body))
              : firstPara(body) || (heads.length ? heads.join(' · ') : ''),
          });
          DB.docs[t].push(it);
        };
        if (g.body && g.title !== 'Introduction') mk(g.title, g.body, true);
        for (const e of g.entries) mk(e.title, e.body, false);
      }
    }
    // Spells
    for (const g of parseDoc(raw.spell)) {
      DB.schools.push(g.title);
      for (const e of g.entries) {
        const tier = parseInt((e.title.match(/\d+/) || [0])[0], 10);
        for (const line of e.body.split('\n')) {
          const m = line.match(/^\s*[-*]\s+(.*)$/);
          if (!m) continue;
          const parts = m[1].split('|').map(s => s.trim());
          if (parts.length < 4) { console.warn('Spell line needs 4 fields:', line); continue; }
          const [name, dice, source, ...rest] = parts;
          const desc = rest.join(' | ');
          const sources = source ? source.split(';').map(s => s.trim()).filter(Boolean) : [];
          add({
            type: 'spell', id: `spell/${slug(g.title)}/${tier}/${slug(name)}`, name, school: g.title, tier, dice, sources, desc,
            metaText: `spell ${g.title} tier ${tier} t${tier} ${dice} ${sources.join(' ')}`, bodyText: desc,
            snippet: desc,
          });
        }
      }
    }
  }

  const classItem = name => DB.byId.get(`class/${slug(name)}`);
  const spellsFor = tag => DB.items.filter(i => i.type === 'spell' && i.sources.includes(tag));
  const counts = () => {
    const c = { all: DB.items.length };
    for (const t of TYPES) c[t] = DB.items.filter(i => i.type === t).length;
    return c;
  };
  function schoolsForClass(cls) {
    const magic = (cls.meta.magic || '');
    if (!magic) return [];
    const found = [];
    for (const s of DB.schools) {
      const base = s.replace(/ Magic.*$/, '');
      if (magic.includes(s) || new RegExp(`\\b${base}\\b`).test(magic)) found.push(s);
    }
    if (/Elemental/.test(magic)) for (const s of ['Fire Magic', 'Water Magic', 'Earth Magic', 'Air Magic']) if (DB.schools.includes(s) && !found.includes(s)) found.push(s);
    return found;
  }

  /* ---------------- state ---------------- */

  const state = {
    tab: 'all', q: '', sel: null, ses: '', char: '',
    classCat: '', subClass: '', showUpcoming: true, school: '', tier: 0, source: '',
  };

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.tab = TYPE_LABEL[p.get('tab')] ? p.get('tab') : 'all';
    state.q = p.get('q') || '';
    state.sel = p.get('item') && DB.byId.has(p.get('item')) ? p.get('item') : null;
    state.classCat = p.get('cat') || '';
    state.subClass = p.get('class') || '';
    state.school = p.get('school') || '';
    state.tier = parseInt(p.get('tier') || '0', 10) || 0;
    state.source = p.get('source') || '';
    state.showUpcoming = p.get('announced') !== '0';
    state.ses = state.tab === 'notes' ? (p.get('ses') || '') : '';
    state.char = state.tab === 'chars' ? (p.get('char') || '') : '';
  }
  function hashFor(s = state) {
    const p = new URLSearchParams();
    if (s.tab !== 'all') p.set('tab', s.tab);
    if (s.q) p.set('q', s.q);
    if (s.classCat) p.set('cat', s.classCat);
    if (s.subClass) p.set('class', s.subClass);
    if (s.school) p.set('school', s.school);
    if (s.tier) p.set('tier', s.tier);
    if (s.source) p.set('source', s.source);
    if (!s.showUpcoming) p.set('announced', '0');
    if (s.sel) p.set('item', s.sel);
    if (s.tab === 'notes' && s.ses) p.set('ses', s.ses);
    if (s.tab === 'chars' && s.char) p.set('char', s.char);
    const h = p.toString();
    return h ? '#' + h : location.pathname + location.search;
  }
  function commit(push) {
    const h = hashFor();
    if (h !== (location.hash || location.pathname + location.search)) history[push ? 'pushState' : 'replaceState'](null, '', h);
    render();
  }
  function go(patch, push = true) {
    Object.assign(state, patch);
    commit(push);
  }
  function openItem(id) {
    go({ sel: id }, true);
    const pane = $('#detail');
    pane.scrollTop = 0;
    const i = DB.byId.get(id);
    const tokens = norm(state.q).split(' ').filter(Boolean);
    if (i && i.heads && tokens.length && !tokens.every(t => i._name.includes(t))) {
      const h = i.heads.find(x => tokens.every(t => norm(x).includes(t)));
      if (h) jumpTo(h, false);
    }
  }
  function jumpTo(head, smooth = true) {
    const t = document.getElementById('h-' + slug(head));
    if (!t) return;
    t.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  }
  function showSpells(filters) {
    go({ tab: 'spell', q: '', school: '', tier: 0, source: '', sel: null, ...filters }, true);
    window.scrollTo({ top: 0 });
  }

  /* ---------------- search ---------------- */

  function searchScore(item, qn, tokens) {
    let score = 0;
    for (const t of tokens) {
      const inName = item._name.includes(t);
      const inMeta = item._meta.includes(t);
      const inBody = item._body.includes(t);
      if (!inName && !inMeta && !inBody) return -1;
      if (item._name.startsWith(t)) score += 30;
      else if (new RegExp(`\\b${t.replace(/[+]/g, '\\+')}`).test(item._name)) score += 20;
      else if (inName) score += 10;
      if (inMeta) score += 4;
      if (inBody) score += 1;
    }
    if (item._name === qn) score += 200;
    else if (item._name.includes(qn)) score += 40;
    if (item.type === 'subclass' && item.upcoming) score -= 3;
    if (item.type === 'patch') score -= 6;   // rules first, change logs after
    if (item.heads && item.heads.some(h => norm(h).includes(qn))) score += 25;
    return score;
  }

  function filtered() {
    let items = DB.items;
    if (state.tab !== 'all') items = items.filter(i => i.type === state.tab);
    if (state.tab === 'class' && state.classCat) items = items.filter(i => i.category === state.classCat);
    if (state.tab === 'subclass') {
      if (state.subClass) items = items.filter(i => i.className === state.subClass);
      if (!state.showUpcoming) items = items.filter(i => !i.upcoming);
    }
    if (state.tab === 'spell') {
      if (state.school) items = items.filter(i => i.school === state.school);
      if (state.tier) items = items.filter(i => i.tier === state.tier);
      if (state.source === '__general') items = items.filter(i => !i.sources.length);
      else if (state.source) items = items.filter(i => i.sources.some(s => s === state.source || s.startsWith(state.source + ' –')));
    }
    const qn = norm(state.q);
    if (!qn) return { items, ranked: false };
    const tokens = qn.split(' ').filter(Boolean);
    const scored = [];
    for (const it of items) {
      const s = searchScore(it, qn, tokens);
      if (s >= 0) scored.push([s, it]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].order - b[1].order);
    return { items: scored.map(x => x[1]), ranked: true, tokens };
  }

  function highlight(text, tokens) {
    let html = esc(text);
    if (!tokens || !tokens.length) return html;
    const pats = tokens.filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!pats.length) return html;
    return html.replace(new RegExp(`(${pats.join('|')})`, 'gi'), '<mark>$1</mark>');
  }

  /* ---------------- rendering ---------------- */

  // Top-level groups; the active group shows its own sections in a second row.
  const GROUPS = [
    { key: 'character', label: 'Character', tabs: ['race', 'class', 'subclass', 'spell'] },
    { key: 'rules', label: 'Rules', tabs: ['adv', 'god'] },
    { key: 'table', label: 'Your table', tabs: ['chars', 'notes'] },
  ];
  const lastInGroup = {};
  const groupFor = t => GROUPS.find(g => g.tabs.includes(t)) || null;

  function renderTabs() {
    const c = counts();
    const nav = $('#tabs'), sub = $('#subtabs');
    const cur = groupFor(state.tab);
    if (cur) lastInGroup[cur.key] = state.tab;
    nav.replaceChildren(...GROUPS.map(g => el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(cur === g),
      onclick: () => { const t = lastInGroup[g.key] || g.tabs[0]; go({ tab: t, sel: state.tab === t ? state.sel : null }, true); },
    }, g.label)));
    const subTabs = cur ? cur.tabs : ['patch', 'settings'].includes(state.tab) ? [state.tab] : [];
    sub.hidden = !subTabs.length;
    sub.replaceChildren(...subTabs.map(t => el('button', {
      class: 'subtab', 'aria-current': state.tab === t ? 'page' : null,
      onclick: () => go({ tab: t, sel: state.tab === t ? state.sel : null }, true),
    }, TYPE_LABEL[t], c[t] != null && !DOC_TYPES.includes(t) ? el('span', { class: 'n' }, String(c[t])) : null)));
    const on = sub.querySelector('[aria-current="page"]');
    if (on && (on.offsetLeft < sub.scrollLeft || on.offsetLeft + on.offsetWidth > sub.scrollLeft + sub.clientWidth)) sub.scrollLeft = Math.max(0, on.offsetLeft - 40);
    const gear = $('#gear');
    if (gear) gear.setAttribute('aria-current', state.tab === 'settings' ? 'page' : 'false');
    const head = $('.top');
    if (head) document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px');
  }

  function renderFoot() {
    const f = $('#foot');
    if (!f) return;
    const latest = (DB.docs.patch || []).find(x => x.name !== x.chapter);
    f.replaceChildren(el('div', { class: 'foot-inner' },
      el('span', { class: 'foot-brand' }, 'Player’s Handbook'),
      el('button', { class: 'foot-link', onclick: () => { go({ tab: 'patch', sel: latest ? latest.id : null, q: '' }, true); window.scrollTo(0, 0); } }, 'Patch notes', latest ? el('span', { class: 'n' }, ` · latest ${latest.name}`) : null),
      el('button', { class: 'foot-link', onclick: openSettings }, 'Settings')));
  }

  function select(options, value, onchange, label) {
    const s = el('select', { class: 'select', 'aria-label': label, onchange: e => onchange(e.target.value) });
    for (const o of options) {
      if (o.group) {
        const og = el('optgroup', { label: o.group });
        for (const x of o.items) og.append(el('option', { value: x.value, selected: x.value === value }, x.label));
        s.append(og);
      } else s.append(el('option', { value: o.value, selected: o.value === value }, o.label));
    }
    return s;
  }

  function renderFilters() {
    const f = $('#filters');
    const kids = [];
    if (['notes', 'chars', 'settings'].includes(state.tab)) { f.replaceChildren(); return; }
    if (state.tab === 'class') {
      for (const cat of ['', 'Melee', 'Ranged', 'Magic', 'Other']) {
        kids.push(el('button', { class: 'chip' + (state.classCat === cat ? ' on' : ''), onclick: () => go({ classCat: cat }, false) }, cat || 'All'));
      }
    }
    if (state.tab === 'subclass') {
      const classes = DB.classOrder.filter(c => DB.subGroups.some(g => g.className === c));
      kids.push(select([{ value: '', label: 'All classes' }, ...classes.map(c => ({ value: c, label: c }))], state.subClass, v => go({ subClass: v }, false), 'Class'));
      kids.push(el('label', { class: 'toggle' },
        el('input', { type: 'checkbox', checked: state.showUpcoming, onchange: e => go({ showUpcoming: e.target.checked }, false) }),
        'Show announced (no details yet)'));
    }
    if (state.tab === 'spell') {
      kids.push(select([{ value: '', label: 'All schools' }, ...DB.schools.map(s => ({ value: s, label: s }))], state.school, v => go({ school: v }, false), 'School'));
      kids.push(select(sourceOptions(), state.source, v => go({ source: v }, false), 'Available to'));
      kids.push(el('span', { class: 'filter-sep' }));
      for (const t of [0, 1, 2, 3, 4, 5, 6]) {
        kids.push(el('button', { class: 'chip' + (state.tier === t ? ' on' : ''), onclick: () => go({ tier: t }, false) }, t ? `Tier ${t}` : 'All tiers'));
      }
    }
    f.replaceChildren(...kids);
  }

  function sourceOptions() {
    const all = new Set();
    for (const i of DB.items) if (i.type === 'spell') i.sources.forEach(s => all.add(s));
    const heads = [...new Set([...all].map(s => s.split(' – ')[0]))];
    const opts = [{ value: '', label: 'Anyone / any source' }, { value: '__general', label: 'General school spells only' }];
    for (const h of heads) {
      const subs = [...all].filter(s => s.startsWith(h + ' – ')).map(s => ({ value: s, label: s.split(' – ')[1] }));
      opts.push({ group: h, items: [{ value: h, label: `All ${h} spells` }, ...subs] });
    }
    return opts;
  }

  function cardSub(i) {
    switch (i.type) {
      case 'race': return i.prime ? `Prime variant of ${i.base}` : [i.meta.hp && `HP ${i.meta.hp}`, i.meta.imp && `I.M.P. ${i.meta.imp}`].filter(Boolean).join(' · ');
      case 'class': return [i.category, i.meta.hp && `HP ${i.meta.hp}`, i.meta['hit die'] && `${i.meta['hit die']} hit die`].filter(Boolean).join(' · ');
      case 'subclass': return i.group.title;
      case 'spell': return `Tier ${i.tier} · ${i.school}${i.sources.length ? ' · ' + i.sources.join(', ') : ''}`;
      case 'adv': case 'god': case 'patch': return i.name === i.chapter ? '' : i.chapter;
    }
    return '';
  }

  function card(i, tokens, showType) {
    if (DOC_TYPES.includes(i.type) && !tokens && !showType) {
      return el('button', { class: 'card toc' + (state.sel === i.id ? ' sel' : ''), 'data-id': i.id, onclick: () => openItem(i.id) },
        el('span', { class: 'badge ' + i.type, hidden: true }),
        el('span', { class: 'card-name' }, i.name === i.chapter ? 'Overview' : i.name),
        i.heads.length && i.type !== 'patch' ? el('span', { class: 'card-sub' }, `${i.heads.length} ${i.heads.length === 1 ? 'entry' : 'entries'}`) : null);
    }
    return el('button', {
      class: 'card' + (state.sel === i.id ? ' sel' : '') + (i.upcoming ? ' dim' : ''),
      'data-id': i.id, onclick: () => openItem(i.id),
    },
      el('div', { class: 'card-top' },
        showType ? el('span', { class: `badge ${i.type}` }, TYPE_ONE[i.type]) : null,
        el('span', { class: 'card-name', html: highlight(i.name, tokens) }),
        i.type === 'spell' && i.dice ? el('span', { class: 'dice' }, i.dice) : null,
        i.upcoming ? el('span', { class: 'badge soon' }, 'Coming soon') : null,
        i.sixth ? lockBadge('sixth', 'Sixth') : null,
        i.prime ? lockBadge('prime', 'Prime') : null,
        el('span', { class: 'card-sub' }, cardSub(i))),
      i.snippet ? el('div', { class: 'card-snip' }, i.snippet) : null,
      tokens && i.heads && i.heads.length ? (() => {
        const hits = i.heads.filter(h => tokens.every(t => norm(h).includes(t)));
        return hits.length ? el('div', { class: 'card-hits', html: 'Includes ' + hits.slice(0, 4).map(h => highlight(h, tokens)).join(' · ') }) : null;
      })() : null);
  }

  function sectionKey(i) {
    switch (i.type) {
      case 'race': return i.group;
      case 'class': return i.category;
      case 'subclass': return i.group.title;
      case 'spell': return `${i.school} · Tier ${i.tier}`;
      case 'adv': case 'god': case 'patch': return i.chapter;
    }
    return '';
  }

  function renderHome() {
    const c = counts();
    const tile = (t, hint) => el('button', { class: `home-tile ${t}`, onclick: () => go({ tab: t, sel: null }, true) },
      DOC_TYPES.includes(t)
        ? el('span', { class: 'big' }, String(new Set(DB.docs[t].map(x => x.chapter)).size), el('small', {}, ' chapters'))
        : el('span', { class: 'big' }, String(c[t])),
      el('span', { class: 'lbl' }, TYPE_LABEL[t]), el('span', { class: 'hint' }, hint));
    return [
      el('div', { class: 'home-intro' },
        el('h1', {}, 'The Player’s Handbook'),
        el('p', {}, 'Everything you need to build and grow your character: races, classes, subclasses, spells, advancement and the gods. Search for anything, or open a chapter.')),
      el('div', { class: 'home-grid' },
        tile('race', 'Traits and unlockable feats'),
        tile('class', 'HP, weapons and class traits'),
        tile('subclass', 'Paths, oaths and specialisations'),
        tile('spell', `Across ${DB.schools.length} schools of magic`),
        tile('adv', 'Levelling, soft skills, feats and traits'),
        tile('god', 'The pantheon, courts and faith in play')),
      DB.docs.patch.length ? (() => {
        const latest = DB.docs.patch.find(x => x.name !== x.chapter) || DB.docs.patch[0];
        return el('button', { class: 'home-notes patch', onclick: () => go({ tab: 'patch', sel: latest.id }, true) },
          el('span', { class: 'lbl' }, 'Latest update · ' + latest.name),
          el('span', { class: 'hint' }, latest.snippet || 'See what’s changed in the handbook.'),
          el('span', { class: 'go' }, 'Patch notes →'));
      })() : null,
      el('button', { class: 'home-notes chars', onclick: () => go({ tab: 'chars', sel: null }, true) },
        el('span', { class: 'lbl' }, 'Character builder'),
        el('span', { class: 'hint' }, 'Roll stats, pick a race and class, spend SP, and download a sheet.'),
        el('span', { class: 'go' }, 'Build →')),
      el('button', { class: 'home-notes', onclick: () => go({ tab: 'notes', sel: null }, true) },
        el('span', { class: 'lbl' }, 'Session notes'),
        el('span', { class: 'hint' }, 'The party’s shared notebook, by campaign and session. Sign in to read and write.'),
        el('span', { class: 'go' }, 'Open →')),
      el('p', { class: 'home-tips', html: 'Try searching <code>fire</code>, <code>heal</code>, <code>tier 3</code>, <code>bleed</code> or a class name. Press <code>/</code> to jump to search.' }),
    ];
  }

  function renderResults() {
    renderResultsInner();
    const meta = $('#result-meta');
    if (state.q.trim() && !['all', 'notes', 'settings'].includes(state.tab) && TYPE_LABEL[state.tab]) {
      meta.append(' ', el('button', { class: 'mini', onclick: () => go({ tab: 'all', sel: null }, true) }, `Search everything for “${state.q.trim()}”`));
    }
  }
  function renderResultsInner() {
    const box = $('#results');
    const meta = $('#result-meta');
    if (state.tab === 'settings') { renderSettings(box, meta); return; }
    if (state.tab === 'chars') {
      if (Creator) Creator.renderList(box, meta);
      else { meta.textContent = ''; box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'The character builder is unavailable'), 'creator.js didn’t load.')); }
      return;
    }
    if (state.tab === 'notes') {
      if (Notes) Notes.renderList(box, meta);
      else { meta.textContent = ''; box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Notes are unavailable'), 'notes.js didn’t load.')); }
      return;
    }
    if (state.tab === 'all' && !state.q) {
      meta.textContent = '';
      box.replaceChildren(...renderHome());
      return;
    }
    if (state.tab === 'spell' && !state.q && !state.school && !state.tier && !state.source) {
      meta.textContent = 'Choose a school of magic, or use the filters above.';
      box.replaceChildren(el('div', { class: 'home-grid schools' }, ...DB.schools.map(sc => el('button', { class: 'home-tile spell', onclick: () => go({ school: sc }, true) },
        el('span', { class: 'big' }, String(DB.items.filter(x => x.type === 'spell' && x.school === sc).length), el('small', {}, ' spells')),
        el('span', { class: 'lbl' }, sc)))));
      return;
    }
    const { items, ranked, tokens } = filtered();
    const kids = [];
    const LIMIT = 400;
    let last = null;
    items.slice(0, LIMIT).forEach(i => {
      if (!ranked && state.tab !== 'all') {
        const k = sectionKey(i);
        if (k && k !== last) {
          kids.push(el('div', { class: 'section-head' }, k)); last = k;
          if (i.type === 'race' && DB.raceIntros[k]) kids.push(el('div', { class: 'notice prose section-intro', html: md(DB.raceIntros[k]) }));
        }
      }
      kids.push(card(i, tokens, state.tab === 'all'));
    });
    if (!items.length) {
      kids.push(el('div', { class: 'empty' }, el('strong', {}, 'Nothing found'),
        state.q ? `No ${state.tab === 'all' ? 'entries' : TYPE_LABEL[state.tab].toLowerCase()} match “${state.q}”.` : 'Try clearing a filter.'));
    }
    const n = items.length;
    meta.textContent = (DOC_TYPES.includes(state.tab) && !ranked) ? 'Contents' : n ? `${n} result${n === 1 ? '' : 's'}${n > LIMIT ? ` — showing the first ${LIMIT}, refine your search to see more` : ''}` : '';
    box.replaceChildren(...kids);
  }

  /* ----- detail views ----- */

  const linkBtn = (label, onclick, dim, locked) => el('button', { class: 'linkbtn' + (dim ? ' dim' : ''), onclick, html: esc(label) + (locked ? LOCK_SVG : '') });
  const section = (title, ...kids) => el('section', { class: 'd-section' }, el('h2', {}, title), ...kids);
  const stat = (k, v) => v ? el('div', { class: 'stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v)) : null;

  function spellList(spells) {
    const byTier = new Map();
    for (const s of spells) { if (!byTier.has(s.tier)) byTier.set(s.tier, []); byTier.get(s.tier).push(s); }
    return [...byTier.keys()].sort((a, b) => a - b).map(t => el('div', { class: 'spell-tier' },
      el('h3', {}, `Tier ${t}`),
      ...byTier.get(t).map(s => el('div', { class: 'spell-row', role: 'button', tabindex: '0', onclick: () => openItem(s.id), onkeydown: e => { if (e.key === 'Enter') openItem(s.id); } },
        el('div', { class: 'sr-top' }, el('span', { class: 'nm' }, s.name), s.dice ? el('span', { class: 'dice' }, s.dice) : null),
        el('div', { class: 'ds' }, s.desc)))));
  }

  function detailRace(i) {
    const base = i.baseId && DB.byId.get(i.baseId);
    const prime = i.primeId && DB.byId.get(i.primeId);
    return [
      i.prime ? null : el('div', { class: 'stats' }, stat('HP', i.meta.hp), stat('I.M.P.', i.meta.imp)),
      i.meta.languages ? el('dl', { class: 'kv' }, el('dt', {}, 'Languages'), el('dd', {}, i.meta.languages)) : null,
      el('div', { class: 'prose', html: md(i.body) }),
      base ? section('Base race', el('div', { class: 'linklist' }, linkBtn(base.name, () => openItem(base.id)))) : null,
      i.prime && DB.raceIntros[i.group] ? section('About Primes', el('div', { class: 'shared' }, el('div', { class: 'prose', html: md(DB.raceIntros[i.group]) }))) : null,
      prime ? section('Prime variant', el('p', { class: 'd-note' }, 'A rare, full-strength form of this race that can be born to ordinary parents.'), el('div', { class: 'linklist' }, linkBtn(prime.name, () => openItem(prime.id), false, true))) : null,
    ];
  }

  function detailClass(i) {
    const kv = el('dl', { class: 'kv' });
    for (const [k, label] of [['weapons', 'Weapons'], ['trait', 'Class trait'], ['magic', 'Magic']]) {
      if (i.meta[k]) kv.append(el('dt', {}, label), el('dd', {}, i.meta[k]));
    }
    const groups = DB.subGroups.filter(g => g.className === i.name);
    const schools = schoolsForClass(i);
    return [
      el('div', { class: 'stats' }, stat('HP', i.meta.hp), stat('Hit die', i.meta['hit die']), stat('Defence', i.meta.defence)),
      kv,
      el('div', { class: 'prose', html: md(i.body) }),
      schools.length ? section('Spells', el('div', { class: 'linklist' }, ...schools.map(s => linkBtn(s, () => showSpells({ school: s }))))) : null,
      groups.length ? section('Subclasses', ...groups.map(g => el('div', { class: 'linkgroup' },
        (groups.length > 1 || g.title !== i.name) ? el('h3', {}, g.title) : null,
        el('div', { class: 'linklist' }, ...g.items.map(s => linkBtn(s.name + (s.upcoming ? ' · soon' : ''), () => openItem(s.id), s.upcoming, s.sixth)))))) : null,
    ];
  }

  function detailSubclass(i) {
    const g = i.group;
    const cls = classItem(i.className);
    const own = i.spellsTag ? spellsFor(i.spellsTag) : [];
    const shared = g.spellsTag ? spellsFor(g.spellsTag) : [];
    const siblings = g.items.filter(s => s !== i);
    return [
      i.upcoming
        ? el('div', { class: 'notice' }, 'This subclass has been announced but its details haven’t been released yet.', i.body ? el('div', {}, el('em', {}, plain(i.body))) : null)
        : el('div', { class: 'prose', html: md(i.body) }),
      own.length ? section(`${i.name} spells`, ...spellList(own)) : null,
      (g.intro || shared.length) ? section(`Shared by all ${g.title} subclasses`,
        el('div', { class: 'shared' },
          g.intro ? el('div', { class: 'prose', html: md(g.intro) }) : null,
          shared.length ? el('details', {}, el('summary', {}, `${shared.length} extra ${g.title} spells`), ...spellList(shared)) : null)) : null,
      siblings.length ? section(`Other ${g.title} subclasses`, el('div', { class: 'linklist' }, ...siblings.map(s => linkBtn(s.name, () => openItem(s.id), s.upcoming, s.sixth)))) : null,
      cls ? section('Class', el('div', { class: 'linklist' }, linkBtn(`${cls.name} (${cls.category})`, () => openItem(cls.id)))) : null,
    ];
  }

  function detailSpell(i) {
    const avail = i.sources.map(tag => {
      const ref = DB.sourceIndex.get(tag);
      if (ref && ref.subId) return linkBtn(tag, () => openItem(ref.subId));
      if (ref && ref.classId && DB.byId.has(ref.classId)) return linkBtn(tag, () => openItem(ref.classId));
      return linkBtn(tag, () => showSpells({ source: tag }));
    });
    return [
      el('div', { class: 'stats' }, stat('Tier', String(i.tier)), stat('School', i.school), stat('Dice / effect', i.dice)),
      el('div', { class: 'prose' }, el('p', {}, i.desc)),
      section('Available to', i.sources.length
        ? el('div', { class: 'linklist' }, ...avail)
        : el('p', { class: 'notice' }, `A general ${i.school} spell — any caster with access to ${i.school} can learn it.`)),
      section('More', el('div', { class: 'linklist' },
        linkBtn(`All ${i.school} spells`, () => showSpells({ school: i.school })),
        linkBtn(`Tier ${i.tier} ${i.school}`, () => showSpells({ school: i.school, tier: i.tier })))),
    ];
  }

  function detailDoc(i) {
    const list = DB.docs[i.type];
    const k = list.indexOf(i);
    const prev = list[k - 1], next = list[k + 1];
    const sibs = list.filter(x => x.chapter === i.chapter && x !== i);
    return [
      i.heads.length >= 3 ? el('div', { class: 'onpage' }, el('span', { class: 'k' }, 'On this page'),
        el('div', { class: 'linklist' }, ...i.heads.map(h => linkBtn(h, () => jumpTo(h))))) : null,
      el('div', { class: 'prose doc', html: md(i.body) }),
      sibs.length ? section(`More in ${i.chapter}`, el('div', { class: 'linklist' }, ...sibs.map(s => linkBtn(s.name, () => openItem(s.id))))) : null,
      el('nav', { class: 'pager' },
        prev ? el('button', { class: 'pg prev', onclick: () => openItem(prev.id) }, el('span', { class: 'k' }, '← Previous'), el('span', { class: 'v' }, prev.name)) : el('span'),
        next ? el('button', { class: 'pg next', onclick: () => openItem(next.id) }, el('span', { class: 'k' }, 'Next →'), el('span', { class: 'v' }, next.name)) : el('span')),
    ];
  }

  function renderDetail() {
    const pane = $('#detail');
    const layout = $('.layout');
    if (state.tab !== 'chars') document.body.classList.remove('cc-open');
    if (state.tab === 'settings') {
      layout.classList.add('no-detail');
      pane.replaceChildren();
      document.body.classList.remove('has-detail');
      document.title = 'Settings · Player’s Handbook';
      return;
    }
    if (state.tab === 'chars') {
      const shown = Creator ? Creator.renderDetail(pane) : false;
      layout.classList.toggle('no-detail', !shown);
      if (!state.char) document.title = 'Characters · Player’s Handbook';
      return;
    }
    if (state.tab === 'notes') {
      const shown = Notes ? Notes.renderDetail(pane) : false;
      layout.classList.toggle('no-detail', !shown);
      if (!state.ses) document.title = 'Session notes · Player’s Handbook';
      return;
    }
    const i = state.sel && DB.byId.get(state.sel);
    document.body.classList.toggle('has-detail', !!i);
    const noDetail = !i && state.tab === 'all' && !state.q;
    layout.classList.toggle('no-detail', noDetail);
    pane.classList.toggle('placeholder', !i);
    if (!i) {
      if (noDetail) { pane.replaceChildren(); return; }
      pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick something to read'), 'Select any entry on the left to see the full details here.'));
      return;
    }
    const kicker = [el('span', { class: `badge ${i.type}` }, TYPE_ONE[i.type])];
    if (i.type === 'class') kicker.push(i.category);
    if (i.type === 'race') kicker.push(i.group);
    if (i.type === 'subclass') kicker.push(i.group.title);
    if (i.type === 'spell') kicker.push(`${i.school} · Tier ${i.tier}`);
    if (DOC_TYPES.includes(i.type) && i.name !== i.chapter) kicker.push(i.chapter);
    if (i.upcoming) kicker.push(el('span', { class: 'badge soon' }, 'Coming soon'));
    if (i.sixth) kicker.push(lockBadge('sixth', 'Sixth'));
    if (i.prime) kicker.push(lockBadge('prime', 'Prime variant'));
    const body = { race: detailRace, class: detailClass, subclass: detailSubclass, spell: detailSpell, adv: detailDoc, god: detailDoc, patch: detailDoc }[i.type](i);
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => go({ sel: null }, true) }, '← Back to results'),
      el('div', { class: 'd-kicker' }, ...kicker),
      el('h1', { class: 'd-title' }, i.name),
      ...body.filter(Boolean));
    document.title = `${i.name} · Player’s Handbook`;
  }

  function render() {
    const input = $('#q');
    if (input.value !== state.q) input.value = state.q;
    if (!state.sel) document.title = 'Player’s Handbook';
    renderTabs();
    renderFilters();
    renderResults();
    renderDetail();
    renderFoot();
  }


  /* ---------------- settings ---------------- */

  const SETTINGS = window.HandbookSettings || null;
  function openSettings() { go({ tab: 'settings', sel: null, q: '' }, true); window.scrollTo(0, 0); }
  const SETTING_ROWS = [
    { group: 'Appearance', rows: [
      { key: 'theme', label: 'Theme', options: [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']] },
      { key: 'contrast', label: 'Contrast', help: 'Darker text and stronger borders.', options: [['normal', 'Standard'], ['high', 'High']] },
      { key: 'texture', label: 'Decoration', help: 'Minimal drops the paper texture, corner flourishes and drop caps.', options: [['full', 'Illuminated'], ['minimal', 'Minimal']] },
    ] },
    { group: 'Reading', rows: [
      { key: 'text', label: 'Text size', options: [['small', 'Small'], ['normal', 'Standard'], ['large', 'Large'], ['xl', 'Extra large']] },
      { key: 'font', label: 'Font', help: 'Easy-read uses Atkinson Hyperlegible, a typeface designed for low vision readers. “All” uses it for headings too.', options: [['tome', 'Tome'], ['easy', 'Easy-read'], ['easy-all', 'Easy-read all']] },
      { key: 'spacing', label: 'Line spacing', options: [['normal', 'Standard'], ['relaxed', 'Relaxed']] },
    ] },
    { group: 'Motion', rows: [
      { key: 'motion', label: 'Animations', help: 'Match device follows your system’s reduce motion setting.', options: [['system', 'Match device'], ['reduce', 'Reduce']] },
    ] },
  ];
  function renderSettings(box, meta) {
    meta.textContent = '';
    if (!SETTINGS) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Settings are unavailable'), 'Reload the page and try again.')); return; }
    const cur = SETTINGS.get();
    const status = el('span', { class: 'set-status', role: 'status' }, 'Saved on this device.');
    const seg = row => el('fieldset', { class: 'set-row' },
      el('legend', {}, row.label),
      row.help ? el('span', { class: 'help' }, row.help) : null,
      el('div', { class: 'seg' }, ...row.options.map(([v, label]) => el('label', {},
        el('input', { type: 'radio', name: 'set-' + row.key, value: v, checked: cur[row.key] === v, onchange: () => {
          const ok = SETTINGS.set({ [row.key]: v });
          status.textContent = ok ? 'Saved on this device.' : 'Applied, but this browser won’t let the site save it, so it resets when you reload.';
          renderTabs();
        } }),
        el('span', {}, label)))));
    box.replaceChildren(el('div', { class: 'set-page' },
      el('h1', {}, 'Settings'),
      el('p', {}, 'Change how the handbook looks and reads. Changes apply straight away and are kept on this device.'),
      ...SETTING_ROWS.flatMap(g => [el('h2', { class: 'section-head' }, g.group), el('div', { class: 'set-group' }, ...g.rows.map(seg))]),
      el('h2', { class: 'section-head' }, 'Preview'),
      el('div', { class: 'set-preview prose' },
        el('h2', {}, 'Ember Lash'),
        el('p', { html: '<strong>Tier 1 · Mage (Fire)</strong>. A whip of flame cracks out to 20ft and deals <strong>1d6 fire</strong>. On a hit the target must make a <em>strength save</em> or be pulled 10ft towards you.' })),
      el('div', { class: 'set-foot' },
        el('button', { class: 'mini', onclick: () => { SETTINGS.reset(); renderTabs(); renderSettings(box, meta); } }, 'Reset to defaults'),
        status)));
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    $('#results').replaceChildren(el('div', { class: 'empty' }, 'Loading the handbook…'));
    try {
      const entries = await Promise.all(TYPES.map(async t => {
        const r = await fetch(FILES[t], { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${FILES[t]}: ${r.status}`);
        return [t, await r.text()];
      }));
      build(Object.fromEntries(entries));
    } catch (err) {
      console.error(err);
      $('#results').replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Couldn’t load the content files'),
        'If you opened index.html straight from your disk, serve the folder instead (e.g. GitHub Pages, or `python -m http.server`).'));
      return;
    }
    readHash();
    render();

    let t;
    $('#q').addEventListener('input', e => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(() => go(['chars', 'patch', 'settings'].includes(state.tab) && v.trim() ? { q: v, tab: 'all', sel: null } : { q: v }, false), 80);
    });
    const gearBtn = $('#gear');
    if (gearBtn) gearBtn.addEventListener('click', openSettings);
    $('#q').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.target.value = ''; go({ q: '' }, false); }
      if (e.key === 'Enter') { const first = $('#results .card'); if (first) first.click(); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== $('#q') && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault(); $('#q').focus();
      }
      if (e.key === 'Escape' && document.activeElement !== $('#q') && !document.querySelector('dialog[open]')) {
        if (state.sel) go({ sel: null }, true);
        else if (state.ses && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) go({ ses: '' }, true);
        else if (state.char && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) go({ char: '' }, true);
      }
    });
    $('#home-link').addEventListener('click', e => { e.preventDefault(); go({ tab: 'all', q: '', sel: null, ses: '', classCat: '', subClass: '', school: '', tier: 0, source: '' }, true); });
    window.addEventListener('resize', () => { const h = $('.top'); if (h) document.documentElement.style.setProperty('--head-h', h.offsetHeight + 'px'); });
    if (Notes) Notes.init();
    if (Creator) Creator.init();
    window.addEventListener('popstate', () => { readHash(); render(); });
    window.addEventListener('hashchange', () => { readHash(); render(); });
  }

  const Notes = window.HandbookNotes ? window.HandbookNotes({ el, md, esc, plain, norm, highlight, state, go, render: () => render(), $, createClient: window.__mockCreateClient }) : null;
  const Creator = window.HandbookCreator ? window.HandbookCreator({ el, md, esc, plain, norm, slug, state, go, render: () => render(), $, DB, Notes, openItem: id => { const i = DB.byId.get(id); go({ tab: i ? i.type : 'all', sel: id }, true); } }) : null;
  boot();
})();
