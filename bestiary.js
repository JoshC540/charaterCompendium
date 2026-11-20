/* Bestiary (DM only): monster index, stat cards with Alpha/Boss/Minion templates, named monsters,
   the dragon and elemental builder, the encounter builder and the monster rules.
   The data lives in Supabase (table "bestiary", readable only by admins; see supabase/bestiary.sql),
   so none of it is in the public site files. */
window.HandbookBestiary = function (H) {
  'use strict';
  const { el, md, esc, norm, state, go, render, Notes, $ } = H;

  const TABS = ['beast', 'vol2', 'named', 'forge', 'encounter', 'brules'];
  const LABEL = { beast: 'Volume I', vol2: 'Volume II', named: 'Named monsters', forge: 'Dragons & elementals', encounter: 'Encounters', brules: 'Monster rules' };
  const TIERS = ['Juvenile', 'Adult', 'Elder', 'Ancient', 'Primordial'];
  const STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const COMBAT = ['melee', 'ranged', 'dodge', 'disengage', 'casting'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  let D = null, loading = false, loadErr = '';
  let flash = '';           // one-line confirmation under the card toolbar
  let encQ = '';            // the encounter builder's own search box
  const MECH = new Map();   // live trackers: weak point HP, countdowns, shift modes (this visit only)
  const PAGE_TPL = new Map();   // template toggles per stat block on Volume II pages
  let lastAnchor = '';      // so a deep link scrolls once, not on every redraw

  const sb = () => Notes && Notes.client && Notes.client();
  const user = () => Notes && Notes.user && Notes.user();
  const admin = () => !!(Notes && Notes.isAdmin && Notes.isAdmin());
  const authState = () => (Notes && Notes.status ? Notes.status() : 'ready');

  /* ---------------- hash state ---------------- */

  const KEYS = { mon: 'mon', tpl: 'tpl', bType: 'type', bRole: 'role', bMin: 'kmin', bMax: 'kmax', bSort: 'sort', fam: 'fam', ftier: 'ftier', fl: 'fl', disp: 'disp', rs: 'page' };
  const blank = () => ({ mon: '', tpl: '', bType: '', bRole: '', bMin: '', bMax: '', bSort: '', fam: '', ftier: '', fl: '', disp: '', rs: '' });
  function readHash(p) {
    const on = TABS.includes(state.tab);
    for (const [k, h] of Object.entries(KEYS)) state[k] = on ? (p.get(h) || '') : '';
  }
  function writeHash(p) {
    if (!TABS.includes(state.tab)) return;
    for (const [k, h] of Object.entries(KEYS)) if (state[k]) p.set(h, state[k]);
  }
  Object.assign(state, blank());

  /* ---------------- data ---------------- */

  function init() {
    if (Notes && Notes.onAuth) Notes.onAuth(() => { if (!admin()) D = null; render(); });
  }

  async function load() {
    if (loading || D || !sb() || !admin()) return;
    loading = true; loadErr = '';
    try {
      const r = await sb().from('bestiary').select('key, data');
      if (r.error) throw r.error;
      const m = Object.fromEntries((r.data || []).map(x => [x.key, x.data]));
      if (!m.bestiary || !m.templates || !m.flavours) throw new Error('empty');
      D = prep(m);
    } catch (e) {
      console.warn('Bestiary:', e);
      loadErr = /does not exist|relation|empty|schema cache/i.test(String(e && (e.message || e))) ? 'missing' : (Notes.friendly ? Notes.friendly(e) : String(e.message || e));
    }
    loading = false;
    if (TABS.includes(state.tab) || (state.tab === 'all' && state.q)) render();
  }

  function prep(m) {
    const d = { ...m, creatures: m.bestiary.creatures };
    d.creatures.forEach(c => { c.volume = 1; });
    d.v2 = m['bestiary-2'] || null;
    if (d.v2) {
      d.v2.fam = new Map(d.v2.families.map(f => [f.id, f]));
      d.creatures = d.creatures.concat(d.v2.creatures);
    }
    d.byId = new Map(d.creatures.map(c => [c.id, c]));
    d.byName = new Map(d.creatures.map(c => [c.name.toLowerCase(), c]));
    d.alphaOf = new Map(m.templates.alpha.alphas.map(a => [a.baseId, a]));
    d.flavour = new Map(m.flavours.flavours.map(f => [f.id, f]));
    const v1 = d.creatures.filter(c => c.volume === 1 && c.kind !== 'named');
    d.types = [...new Set(v1.map(c => c.type))];
    d.roles = [...new Set(v1.map(c => c.role))].sort();
    d.tiers = { dragon: d.creatures.filter(c => c.family === 'dragon'), elemental: d.creatures.filter(c => c.family === 'elemental') };
    d.budget = m['kr-budget'].rows;
    // tooltips: statuses, shared rules, roles and rule keywords, all in the doc's own words
    const tips = [];
    const add = (re, title, text) => tips.push({ re, title, text });
    const STATUS_FORMS = {
      burn: ['burn', 'burns'], bleed: ['bleed'], poison: ['poison', 'poisoned', 'poisonous'], disease: ['disease'], madness: ['madness'], wither: ['wither'],
      corrode: ['corrode'], freeze: ['freeze', 'frozen solid'], stun: ['stun', 'stunned', 'stuns', 'paralysis', 'paralysed'], sleep: ['asleep', 'sleep(?= )(?<=\\+\\d+d2 sleep)'],
      blinded: ['blinded', 'dazzled', 'deafened', 'disorientated', 'disorientate', 'disorientates'], charmed: ['charmed', 'charms', 'charm', 'frightened', 'confused'],
      prone: ['prone', 'stagger'], knockback: ['knockback', 'knocked back', 'knocks back'], restrained: ['restrained', 'grabbed', 'entangled', 'crushed'],
    };
    for (const s of m.statuses.statuses) {
      const forms = STATUS_FORMS[s.id] || [s.id];
      add(new RegExp(`\\b(${forms.join('|')})\\b`, 'gi'), s.name, `**Per stack:** ${s.perStack}. **Max:** ${s.max}. **Ends:** ${s.ends}.`);
    }
    for (const r of m.rules.shared) tips.push({ re: /$^/, em: true, title: r.name, text: r.text });
    const gl = new Map();
    const glo = [...m.rules.glossary].sort((a, b) => (b.term === 'Boss Tempo') - (a.term === 'Boss Tempo'));   // before plain "Tempo"
    for (const g of glo) gl.set(g.term, gl.has(g.term) ? gl.get(g.term) + ' ' + g.text : g.text);
    d.gloss = gl;
    for (const [term, text] of gl) {
      if (['Defence', 'Wants', 'Exploit', 'Tell', 'Status dice', 'Effects that end a fight'].includes(term)) continue;
      const word = term === 'Tempo' ? "(?:[A-Z][a-z]+'s |[A-Z][a-z]+’s )?Tempo" : term === 'Recharge' ? '\\d+-turn recharge' : term === 'Solo' ? 'Solo|Defiant \\d' : term.replace(/ /g, '\\s');
      add(new RegExp(`\\b(${word})\\b`, 'g'), term, text);
    }
    if (d.v2) for (const [id, mm] of Object.entries(d.v2.mechanics)) {
      const re = id === 'weak-point' ? /\b(Weak Points?|weak points?)\b/g : id === 'countdown' ? /\b(Countdowns?|countdowns?)\b/g : /\b(Shift)\b/g;
      tips.push({ re, title: mm.name, text: mm.text, link: `#tab=vol2&page=intro&mon=${id}` });
    }
    d.tips = tips;
    return d;
  }

  /* ---------------- text helpers ---------------- */

  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\u0001/g, '<span class="bs-chg">').replace(/\u0002/g, '</span>');

  // wrap known rule words in a tooltip trigger (text outside tags only; first use of each rule per block; longest match wins)
  function tipify(html) {
    if (!D) return html;
    const used = new Set();
    const btn = (k, w) => `<button type="button" class="bs-tip" data-tip="${k}">${w}</button>`;
    const wrap = part => {
      const hits = [];
      D.tips.forEach((t, k) => {
        if (t.em) return;
        const re = new RegExp(t.re.source, t.re.flags.includes('g') ? t.re.flags : t.re.flags + 'g');
        let m;
        while ((m = re.exec(part))) { if (!m[0]) { re.lastIndex++; continue; } hits.push({ s: m.index, e: m.index + m[0].length, k, title: t.title }); }
      });
      hits.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
      let out = '', pos = 0;
      for (const h of hits) {
        if (h.s < pos || used.has(h.title)) continue;
        used.add(h.title);
        const t = D.tips[h.k];
        out += part.slice(pos, h.s) + (t.link ? `<a class="bs-mlink" href="${t.link}" title="${esc(t.title)}: how it works">${part.slice(h.s, h.e)}</a>` : btn(h.k, part.slice(h.s, h.e)));
        pos = h.e;
      }
      return out + part.slice(pos);
    };
    let inBtn = false;
    return html.split(/(<[^>]+>)/).map(part => {
      if (part.startsWith('<')) { if (/^<(button|a)\b/.test(part)) inBtn = true; if (/^<\/(button|a)>/.test(part)) inBtn = false; return part; }
      return inBtn ? part : wrap(part);
    }).join('').replace(/<em>([^<]+)<\/em>/g, (mm, w) => {
      const k = D.tips.findIndex(t => t.em && t.title === w);
      if (k < 0 || used.has(w)) return mm;
      used.add(w);
      return `<em>${btn(k, w)}</em>`;
    });
  }
  const rich = s => tipify(inline(s));
  const krText = k => k == null ? '–' : k === 0.5 ? '½' : Number.isInteger(k) ? k.toLocaleString('en-GB') : String(Math.round(k * 100) / 100);
  const parseKr = s => { s = String(s || '').trim(); if (!s) return null; if (s === '½' || s === '1/2') return 0.5; const n = parseFloat(s); return isNaN(n) ? null : n; };

  // tooltip popover: hover on desktop, tap anywhere
  let tipEl = null;
  function showTip(btn) {
    const t = D && D.tips[+btn.dataset.tip];
    if (!t) return;
    hideTip();
    tipEl = el('div', { class: 'bs-pop', role: 'tooltip' }, el('span', { class: 'bs-pop-t' }, t.title), el('div', { html: inline(t.text) }));
    document.body.append(tipEl);
    const r = btn.getBoundingClientRect(), w = Math.min(340, window.innerWidth - 24);
    tipEl.style.width = w + 'px';
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    tipEl.style.left = left + 'px';
    const below = r.bottom + 8, h = tipEl.offsetHeight;
    tipEl.style.top = (below + h > window.innerHeight - 8 && r.top - h - 8 > 0 ? r.top - h - 8 : below) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    tipEl._for = btn;
  }
  function hideTip() { if (tipEl) { if (tipEl._for) tipEl._for.removeAttribute('aria-expanded'); tipEl.remove(); tipEl = null; } }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.bs-tip');
    if (b) { e.preventDefault(); if (tipEl && tipEl._for === b) { if (tipEl._hover) tipEl._hover = false; else hideTip(); } else showTip(b); return; }
    if (!(e.target.closest && e.target.closest('.bs-pop'))) hideTip();
  });
  document.addEventListener('mouseover', e => { const b = e.target.closest && e.target.closest('.bs-tip'); if (b && matchMedia('(hover: hover)').matches && (!tipEl || tipEl._for !== b)) { showTip(b); if (tipEl) tipEl._hover = true; } });
  document.addEventListener('mouseout', e => { const b = e.target.closest && e.target.closest('.bs-tip'); if (b && tipEl && tipEl._hover && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.bs-pop'))) hideTip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, true);

  /* ---------------- templates ---------------- */

  // dice that are damage (not status d2s, durations, counts of creatures, or healing)
  const notDamage = (before, after) => /^\s*(turns?|rounds?|hours?|healing|trees|[A-Z])/.test(after) || /(heals|drops by|for|by the same)\s*$/.test(before);
  function reDice(text, mode) {
    return text.replace(/(\+?)(\d+)d(\d+)/g, (mm, plus, n, d, off, s) => {
      n = +n; d = +d;
      if (plus && d === 2) {
        if (mode === 'alpha') return `\u0001+${n + 1}d2\u0002`;
        if (mode === 'minion' && n > 1) return '\u0001+1d2\u0002';
        return mm;
      }
      if (notDamage(s.slice(0, off), s.slice(off + mm.length))) return mm;
      if (mode === 'alpha') return `${plus}\u0001${n + 1}d${d}\u0002`;
      if (mode === 'minion') return `${plus}\u0001${Math.floor(n * (d + 1) / 2)}\u0002`;
      return mm;
    });
  }

  const tplList = s => (s || '').split(',').filter(x => ['alpha', 'boss', 'minion'].includes(x));
  function allowed(c, t) {
    if (!c || c.kind === 'named') return false;
    if (t === 'alpha') return c.type !== 'Humanoid' && c.tier !== 'Primordial';
    if (t === 'minion') return c.kr <= D.templates.minion.maxKr;
    return true;
  }
  function cleanTpl(c, list) {
    let l = list.filter(t => allowed(c, t));
    if (l.includes('minion')) l = ['minion'];
    return ['alpha', 'boss', 'minion'].filter(t => l.includes(t));
  }

  // build the creature as it plays with the chosen templates (and flavour, for dragons and elementals)
  function view(c, tpl, forge) {
    const T = D.templates;
    tpl = cleanTpl(c, tpl || []);
    const v = {
      base: c, tpl, forge: forge || null, name: c.name, kr: c.kr, hp: c.hp, defence: c.defence, minHit: c.minHit, speed: c.speed,
      stats: c.stats ? { ...c.stats } : null, combat: c.combat ? { ...c.combat } : null, changed: {}, krWork: [], notes: [], extraTraits: [],
      attacks: c.attacks.map(a => ({ ...a, html: a.text, struck: false })), traits: c.traits.map(t => ({ ...t, html: t.text, struck: false })),
      role: c.role, alpha: null, bossDefiant: 0,
    };
    if (forge) {
      const f = D.flavour.get(forge.fl);
      if (f) {
        v.name = `${c.tier} ${f.name.replace(/^The /, '')} ${c.family === 'dragon' ? 'Dragon' : 'Elemental'}`;
        v.attacks.forEach(a => { a.html = a.html.replace(/flavour status/g, `\u0001${f.statusName}\u0002`); });
        if (c.family === 'elemental') { v.speed = `${c.speed}: \u0001${f.movement}\u0002`; v.changed.speed = true; }
      }
    }
    if (tpl.includes('alpha')) {
      const a = D.alphaOf.get(c.id);
      v.alpha = a || null;
      if (a && !forge) v.name = a.name;
      else v.name = `Alpha ${v.name}`;
      const k0 = v.kr; v.kr = Math.ceil(v.kr * T.alpha.maths.krMultiplier - 1e-9);
      v.krWork.push(`Alpha: KR ${krText(k0)} ×1.5, rounded up = ${krText(v.kr)}`);
      v.hp = Math.ceil(v.hp * T.alpha.maths.hpMultiplier); if (v.defence != null) v.defence += 1; if (v.minHit != null) v.minHit += 2;
      if (v.stats) for (const k of STATS) if (v.stats[k] != null) v.stats[k] = Math.max(1, v.stats[k] - 1);
      if (v.combat) for (const k of COMBAT) if (v.combat[k] != null) v.combat[k] = Math.max(1, v.combat[k] - 1);
      Object.assign(v.changed, { kr: true, hp: true, defence: true, minHit: true, stats: true, combat: true });
      v.attacks.forEach(at => { at.html = reDice(at.html, 'alpha'); });
      if (a) v.extraTraits.push({ tag: 'Alpha', html: a.signatureText }, { tag: 'Alpha', label: 'Divergence', html: a.divergence });
      else v.notes.push({ tag: 'Alpha', html: 'It has **one exaggerated physical divergence** and **one new signature trait**.' });
    }
    if (tpl.includes('boss')) {
      const k0 = v.kr; v.kr = v.kr * T.boss.krMultiplier; v.hp = v.hp * T.boss.hpMultiplier;
      v.krWork.push(`Boss: KR ${krText(k0)} ×2 = ${krText(v.kr)}`);
      v.changed.kr = v.changed.hp = true;
      v.bossDefiant = v.kr >= T.boss.defiantKrThreshold ? T.boss.defiantAt50 : T.boss.defiant;
      v.role = `Solo (Boss)`;
      v.name = v.name + ' (Boss)';
      v.extraTraits.push({ tag: 'Boss', html: `*Solo*, Defiant ${v.bossDefiant}. *Boss Tempo*: one extra action at the end of each round, on top of any Tempo it already has.`, raw: true });
      const rl = T.boss.rules.split('\n').filter(l => /^- \*\*(Phases|Lair actions)\*\*/.test(l)).map(l => l.slice(2));
      for (const l of rl) v.notes.push({ tag: 'Boss', html: l });
    }
    if (tpl.includes('minion')) {
      const k0 = v.kr; v.kr = v.kr / T.minion.krDivisor; v.hp = T.minion.hp;
      v.krWork.push(`Minion: KR ${krText(k0)} ÷5 = ${krText(v.kr)}`);
      v.changed.kr = v.changed.hp = true;
      v.name = v.name + ' (Minion)';
      v.attacks.forEach(at => { if (at.recharge) at.struck = true; else at.html = reDice(at.html, 'minion'); });
      v.traits.forEach(t => { if (t.name && /Tempo/.test(t.name)) t.struck = true; });
      for (const l of T.minion.rules.split('\n').filter(l => /^- (\*\*1 HP|Its attacks)/.test(l))) v.notes.push({ tag: 'Minion', html: l.slice(2) });
      v.notes.push({ tag: 'Minion', html: 'Averages here are rounded down.', fine: true });
    }
    return v;
  }

  /* ---------------- shared bits ---------------- */

  function gate(box, meta) {
    meta.textContent = '';
    if (authState() === 'loading') { box.replaceChildren(el('div', { class: 'empty' }, 'Checking your sign-in…')); return true; }
    if (!user() || !admin()) {
      box.replaceChildren(el('div', { class: 'notes-gate' },
        el('h1', {}, 'The Bestiary'),
        el('p', {}, user() ? 'This part of the handbook is for the DM. Your account doesn’t have DM access.' : 'This part of the handbook is for the DM. Sign in with the DM account to open it.'),
        user() ? null : el('button', { class: 'btn primary', onclick: () => Notes.openSignIn() }, 'Sign in')));
      return true;
    }
    if (!D) {
      if (!loading && !loadErr) load();
      box.replaceChildren(loadErr
        ? el('div', { class: 'empty' }, el('strong', {}, loadErr === 'missing' ? 'The bestiary data isn’t set up yet' : 'Couldn’t load the bestiary'),
          loadErr === 'missing' ? 'Run supabase/bestiary.sql in the Supabase SQL editor, then reload.' : loadErr,
          el('div', {}, el('button', { class: 'mini', onclick: () => { loadErr = ''; load(); render(); } }, 'Try again')))
        : el('div', { class: 'empty' }, 'Opening the bestiary…'));
      return true;
    }
    return false;
  }

  const seg = (opts, cur, pick, label) => el('div', { class: 'seg bs-seg', role: 'group', 'aria-label': label },
    ...opts.map(([v, t, dis, title]) => el('button', { type: 'button', class: cur === v ? 'on' : null, 'aria-pressed': String(cur === v), disabled: !!dis, title: title || null, onclick: () => pick(v) }, t)));

  /* ---------------- index ---------------- */

  function filtered(kind) {
    let list = D.creatures.filter(c => kind === 'named' ? c.kind === 'named' : c.kind !== 'named' && c.volume === 1);
    if (kind !== 'named') {
      if (state.bType) list = list.filter(c => c.type === state.bType);
      if (state.bRole) list = list.filter(c => c.role === state.bRole);
      const lo = parseKr(state.bMin), hi = parseKr(state.bMax);
      if (lo != null) list = list.filter(c => c.kr >= lo);
      if (hi != null) list = list.filter(c => c.kr <= hi);
    }
    const q = norm(state.q);
    if (q) {
      const toks = q.split(' ').filter(Boolean);
      const scored = [];
      for (const c of list) {
        const n = norm(c.name), meta = norm(`${c.type} ${c.typeLine} ${c.role || ''} ${c.family || ''}`);
        let s = 0, ok = true;
        for (const t of toks) {
          if (n.startsWith(t)) s += 30; else if (n.split(' ').some(w => w.startsWith(t))) s += 20; else if (n.includes(t)) s += 10; else if (meta.split(' ').some(w => w.startsWith(t))) s += 3; else if (norm(`${c.tell} ${c.exploit}`).split(' ').some(w => w.startsWith(t))) s += 1; else { ok = false; break; }
        }
        if (ok) scored.push([s + (n === q ? 100 : 0), c]);
      }
      return scored.sort((a, b) => b[0] - a[0] || a[1].kr - b[1].kr).map(x => x[1]);
    }
    const sort = state.bSort || 'kr';
    if (kind === 'named') return list.slice().sort((a, b) => a.volume - b.volume || a.kr - b.kr || a.order - b.order);
    return list.slice().sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === '-kr' ? (a, b) => b.kr - a.kr || a.order - b.order : (a, b) => a.kr - b.kr || a.order - b.order);
  }

  // KR bands for section heads, from the KR budget table (each band runs up to the next one's start)
  function bandOf(k) {
    const rows = D.budget;
    for (let i = rows.length - 1; i >= 0; i--) if (k >= rows[i].krMin) return i;
    return 0;
  }

  function monCard(c, sel, opts = {}) {
    const sub = c.kind === 'named' ? `Built from ${c.builtFrom}${c.templates.length ? ', ' + c.templates.join(' + ') : ''}` : c.volume === 2 ? c.family : `${c.type} · ${c.role}`;
    const open = opts.open || (() => { go({ mon: c.id, tpl: '' }, true); const p = $('#detail'); if (p) p.scrollTop = 0; });
    return el('button', { class: 'card bs-mon' + (sel ? ' sel' : ''), 'data-id': c.id, onclick: open },
      el('div', { class: 'card-top' },
        el('span', { class: 'card-name' }, c.name),
        el('span', { class: 'card-sub' }, sub),
        el('span', { class: 'bs-kr' }, 'KR ' + krText(c.kr))),
      opts.snip ? el('div', { class: 'card-snip', html: opts.snip }) : el('div', { class: 'card-snip' }, c.kind === 'named' && c.bestAs ? c.bestAs : c.description));
  }

  // where a creature's stat block lives
  function linkFor(c, tpl) {
    if (c.volume === 2) return { tab: 'vol2', rs: c.familyId, mon: c.id, tpl: '', q: '' };
    return { tab: c.kind === 'named' ? 'named' : 'beast', mon: c.id, tpl: (tpl || []).join(','), q: '' };
  }
  function openCreature(c, tpl) {
    if (c.volume === 2 && tpl && tpl.length) PAGE_TPL.set(c.id, tpl);
    go(linkFor(c, tpl), true);
  }

  function renderFilters(f) {
    if (!D || state.tab !== 'beast') { f.replaceChildren(); return; }
    const sel = (opts, value, on, label) => {
      const s = el('select', { class: 'select', 'aria-label': label, onchange: e => on(e.target.value) });
      for (const [v, t] of opts) s.append(el('option', { value: v, selected: v === value }, t));
      return s;
    };
    const kr = (key, ph) => el('input', { class: 'bs-krin', type: 'text', inputmode: 'decimal', placeholder: ph, value: state[key], 'aria-label': ph, size: 4,
      onchange: e => go({ [key]: e.target.value.trim() }, false) });
    const any = state.bType || state.bRole || state.bMin || state.bMax || state.bSort;
    f.replaceChildren(
      sel([['', 'All types'], ...D.types.map(t => [t, t])], state.bType, v => go({ bType: v }, false), 'Type'),
      sel([['', 'All roles'], ...D.roles.map(t => [t, t])], state.bRole, v => go({ bRole: v }, false), 'Role'),
      el('span', { class: 'bs-krrange' }, el('span', { class: 'k' }, 'KR'), kr('bMin', 'from'), el('span', { class: 'k' }, 'to'), kr('bMax', 'to')),
      sel([['kr', 'KR, low to high'], ['-kr', 'KR, high to low'], ['name', 'Name, A to Z']], state.bSort || 'kr', v => go({ bSort: v === 'kr' ? '' : v }, false), 'Sort'),
      ...(any ? [el('button', { class: 'mini', onclick: () => go({ bType: '', bRole: '', bMin: '', bMax: '', bSort: '' }, false) }, 'Clear')] : []));
  }

  function renderIndex(box, meta, kind) {
    const list = filtered(kind);
    const kids = [];
    if (kind === 'named') kids.push(el('div', { class: 'notice prose section-intro', html: tipify(md(D.rules.named.split('\n').filter(l => !l.startsWith('|')).join('\n'))) }));
    const grouped = kind !== 'named' && !state.q && (state.bSort || 'kr') !== 'name';
    let last = -1, lastVol = 0;
    const order = state.bSort === '-kr' ? -1 : 1;
    for (const c of list) {
      if (kind === 'named' && !state.q && c.volume !== lastVol) {
        lastVol = c.volume;
        kids.push(el('div', { class: 'section-head' }, `Volume ${c.volume === 1 ? 'I' : 'II'} · ${list.filter(x => x.volume === c.volume).length}`));
        if (c.volume === 2 && D.v2) kids.push(el('div', { class: 'notice prose section-intro', html: tipify(md(D.v2.namedIntro)) }));
      }
      if (grouped) {
        const b = bandOf(c.kr);
        if (b !== last) {
          const inBand = list.filter(x => bandOf(x.kr) === b).map(x => x.kr);
          const lo = Math.min(...inBand), hi = Math.max(...inBand);
          kids.push(el('div', { class: 'section-head' }, lo === hi ? `KR ${krText(lo)}` : order > 0 ? `KR ${krText(lo)}–${krText(hi)}` : `KR ${krText(hi)}–${krText(lo)}`));
          last = b;
        }
      }
      kids.push(monCard(c, state.mon === c.id));
    }
    if (!list.length) kids.push(el('div', { class: 'empty' }, el('strong', {}, 'Nothing found'), state.q ? `No creatures match “${state.q}”.` : 'Try clearing a filter.'));
    meta.textContent = `${list.length} ${kind === 'named' ? 'named monster' : 'creature'}${list.length === 1 ? '' : 's'}`;
    box.replaceChildren(...kids);
  }

  /* ---------------- the stat card ---------------- */

  const statBox = (k, v, chg, tipTerm, note) => el('div', { class: 'bs-num' + (chg ? ' chg' : '') },
    el('span', { class: 'k', html: tipTerm ? tipify(esc(k)) : esc(k) }), el('span', { class: 'v' }, v), note ? el('span', { class: 'n' }, note) : null);

  function harvestNote(kr, name) {
    const god = /Primordial|Archfiend|Colossus|Titan/.test(name);
    const p = D.harvest.parts;
    const silver = n => `${n.toLocaleString('en-GB')} silver`;
    const bits = [`Common part ${silver(kr * p[0].perKr)}`, `reagent ${silver(kr * p[1].perKr)}`];
    if (kr >= 100) bits.push(`legendary core ${(kr * p[2].perKr).toLocaleString('en-GB')} gold`);
    return `At KR ${krText(kr)}: ${bits.join(' · ')}.${god ? ` God-tier core ${(kr * p[3].perKr).toLocaleString('en-GB')} gold.` : ''}`;
  }

  /* ---- Volume II mechanics: weak points, countdowns, shifts ---- */

  const ICON = {
    tell: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>',
    exploit: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/><path d="M10 1v4M10 15v4M1 10h4M15 10h4" stroke="currentColor" stroke-width="1.6"/></svg>',
  };
  const mechLink = (id, label) => el('a', { class: 'bs-mk', href: `#tab=vol2&page=intro&mon=${id}`, title: 'How it works' }, label);

  function weakPoint(c, w, key) {
    const n0 = w.count || 1;
    const box = el('div', { class: 'bs-wp-trk' });
    const draw = () => {
      let st = MECH.get(key);
      if (!st) { st = Array(n0).fill(w.hp); MECH.set(key, st); }
      box.replaceChildren(...st.map((hp, i) => {
        const broken = hp <= 0;
        const inp = el('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: 'dmg', 'aria-label': `Damage to ${w.part}${st.length > 1 ? ' ' + (i + 1) : ''}` });
        const hit = () => { const d = parseInt(inp.value, 10); if (d > 0) { st[i] = Math.max(0, st[i] - d); draw(); } };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); hit(); } });
        return el('div', { class: 'bs-wp-one' + (broken ? ' broken' : '') },
          el('span', { class: 'bs-wp-hp' }, el('b', {}, String(hp)), ` / ${w.hp} HP`),
          el('span', { class: 'bs-wp-bar' }, el('span', { style: `width:${Math.max(0, hp) / w.hp * 100}%` })),
          broken ? el('span', { class: 'bs-wp-broken' }, 'Broken') : el('span', { class: 'bs-wp-in' }, inp, el('button', { type: 'button', class: 'btn small', onclick: hit }, 'Hit')));
      }),
      el('div', { class: 'bs-wp-foot' },
        w.each && !w.count ? el('button', { type: 'button', class: 'mini', onclick: () => { st.push(w.hp); draw(); } }, '+ Track another') : null,
        st.some((h, i) => h !== w.hp) || st.length !== n0 ? el('button', { type: 'button', class: 'mini', onclick: () => { MECH.delete(key); draw(); } }, 'Reset') : null));
    };
    draw();
    return el('div', { class: 'bs-mech wp' },
      el('div', { class: 'bs-mech-h' }, mechLink('weak-point', w.part && /s$/.test(w.part) && w.each ? 'Weak Points' : 'Weak Point'),
        el('span', { class: 'bs-wp-chip' }, el('span', { class: 'nm' }, w.part), el('span', { class: 'hp' }, w.hp != null ? `${w.hp.toLocaleString('en-GB')} HP${w.each ? ' each' : ''}${w.count ? ` ×${w.count}` : ''}` : 'HP in text'))),
      w.hp != null ? box : null);
  }

  function countdown(c, cd, key) {
    const wrap = el('div', { class: 'bs-cd-trk' });
    const draw = () => {
      const n = MECH.has(key) ? MECH.get(key) : cd.count;
      const unit = cd.unit === 'rounds' ? (n === 1 ? 'round' : 'rounds') : n === 1 ? cd.unit.replace(/s$/, '') : cd.unit;
      wrap.replaceChildren(
        el('span', { class: 'bs-die' + (n === 0 ? ' zero' : ''), 'aria-label': `${n} ${unit} left` }, el('span', { class: 'v' }, String(n))),
        el('span', { class: 'bs-cd-txt' }, n === 0 ? el('strong', {}, `${cd.effect} happens now`) : el('span', {}, el('strong', {}, cd.effect), ` in ${n} ${unit}`)),
        el('span', { class: 'bs-cd-btns' },
          el('button', { type: 'button', class: 'btn small', disabled: n === 0, onclick: () => { MECH.set(key, Math.max(0, n - 1)); draw(); } }, 'Tick'),
          n !== cd.count ? el('button', { type: 'button', class: 'mini', onclick: () => { MECH.delete(key); draw(); } }, 'Reset') : null));
    };
    draw();
    return el('div', { class: 'bs-mech cd' }, el('div', { class: 'bs-mech-h' }, mechLink('countdown', 'Countdown')), wrap);
  }

  function shift(c, sh, key) {
    const wrap = el('div', { class: 'bs-sh-modes', role: sh.modes.length > 1 ? 'group' : null, 'aria-label': 'Current mode' });
    const draw = () => {
      const cur = MECH.has(key) ? MECH.get(key) : 0;
      wrap.replaceChildren(...sh.modes.map((m, i) => sh.modes.length > 1
        ? el('button', { type: 'button', class: i === cur ? 'on' : null, 'aria-pressed': String(i === cur), onclick: () => { MECH.set(key, i); draw(); } }, m)
        : el('span', { class: 'one' }, m)),
      sh.modes.length > 1 ? el('span', { class: 'bs-sh-note' }, 'Tap the mode it’s in now') : null);
    };
    draw();
    return el('div', { class: 'bs-mech sh' }, el('div', { class: 'bs-mech-h' }, mechLink('shift', 'Shift')), wrap);
  }

  function mechTrait(c, t, i, inner) {
    const M = c.mechanics;
    if (!M) return null;
    const key = k => `${c.id}:${i}:${k}`;
    const w = M.weakPoints.find(x => x.trait === i), cd = M.countdowns.find(x => x.trait === i), sh = M.shifts.find(x => x.trait === i);
    if (!w && !cd && !sh) return null;
    const widget = w ? weakPoint(c, w, key('wp')) : cd ? countdown(c, cd, key('cd')) : shift(c, sh, key('sh'));
    widget.append(inner);
    return widget;
  }

  function card(v, opts = {}) {
    const c = v.base;
    const named = c.kind === 'named';
    const H = opts.h || 'h1';
    const v2named = named && c.volume === 2;
    // tags beside the KR seal
    const tags = [];
    const tplWord = named ? c.templates.join(' ') : v.tpl.includes('boss') ? (v.tpl.includes('alpha') ? 'Alpha Boss' : 'Boss') : '';
    if (tplWord) tags.push(tplWord);
    if (!named && ['Solo', 'Set piece'].includes(c.role) && !v.tpl.includes('boss')) tags.push(c.role);
    if (named && c.volume === 1 && c.role === 'Solo') tags.push('Solo');
    if (/\bConstruct\b/.test(c.typeLine)) tags.push('Construct');
    // type line: Volume II named monsters name their base creature, linked to its stat block
    let typeLine;
    if (v2named) {
      const base = D.byId.get(c.builtFromId);
      typeLine = el('p', { class: 'bs-type' }, `${c.templates.join(' ')} `,
        base ? el('a', { class: 'bs-baselink', href: '#' + new URLSearchParams(Object.entries(linkFor(base)).filter(([, x]) => x)).toString().replace(/\brs=/, 'page='), onclick: e => { e.preventDefault(); openCreature(base); } }, c.builtFrom) : c.builtFrom);
    } else {
      const tl = c.tags.length ? ', ' + c.tags.join(', ') : '';
      typeLine = el('p', { class: 'bs-type', html: tipify(esc(`${c.type}${tl}`) + (v.role ? ' · ' + esc(v.role) : '')) });
    }
    const head = el('header', { class: 'bs-head' },
      el('div', { class: 'bs-titles' }, el(H, { class: 'bs-name' }, v.name), typeLine),
      el('div', { class: 'bs-krbox' },
        el('div', { class: 'bs-krseal' + (v.changed.kr ? ' chg' : ''), title: v.krWork.join('\n') || null }, el('span', { class: 'k' }, 'KR'), el('span', { class: 'v' }, krText(v.kr))),
        tags.length ? el('div', { class: 'bs-tags' }, ...tags.map(t => el('span', { class: 'bs-ktag' + (/Boss/.test(t) ? ' boss' : '') }, t))) : null));
    const desc = el('p', { class: 'bs-desc', html: inline(c.description) });
    const work = v.krWork.length ? el('p', { class: 'bs-work' }, v.krWork.join(' · ')) : null;
    const num = (val, txt) => val != null ? String(val) : (txt || '—');
    const core = el('div', { class: 'bs-core' },
      statBox('HP', v.hp.toLocaleString('en-GB'), v.changed.hp, false, c.hpNote),
      statBox('Defence', num(v.defence, c.defenceText), v.changed.defence, true),
      statBox('Min hit', num(v.minHit, c.minHitText), v.changed.minHit, true),
      el('div', { class: 'bs-num speed' + (v.changed.speed ? ' chg' : '') }, el('span', { class: 'k' }, 'Speed'), el('span', { class: 'v', html: v.speed != null ? inline(v.speed) : '—' })));
    const stats = v.stats
      ? el('div', { class: 'bs-stats' + (v.changed.stats ? ' chg' : ''), 'aria-label': 'Stats (roll under)' },
        ...STATS.map(k => el('div', { class: 'bs-st' }, el('span', { class: 'k' }, k.toUpperCase()), el('span', { class: 'v' }, v.stats[k] == null ? '–' : String(v.stats[k])))))
      : el('p', { class: 'bs-stats-txt' }, el('span', { class: 'k' }, 'Stats'), ' ', c.statsText);
    const corder = c.combatOrder && c.combatOrder.length ? c.combatOrder : COMBAT.filter(k => v.combat && v.combat[k] != null);
    const combat = v.combat
      ? el('div', { class: 'bs-combat' + (v.changed.combat ? ' chg' : '') },
        ...corder.map(k => el('span', { class: 'bs-cb' }, el('span', { class: 'k' }, cap(k)), ' ', el('span', { class: 'v' }, v.combat[k] == null ? '—' : String(v.combat[k])))))
      : el('p', { class: 'bs-stats-txt' }, el('span', { class: 'k' }, 'Combat'), ' ', c.combatText);
    const line = (a) => {
      const t = a.html;
      const m = t.match(/^(\*[^*]+\*|[^:*]{1,48}?)(\s*\([^)]*\))?(:)\s([\s\S]*)$/) || t.match(/^(\*[^*]+\*)(\s*\([^)]*\))()([\s\S]*)$/);
      const nm = m ? m[1].replace(/^\*|\*$/g, '') : null;
      const rest = m ? m[4].trim() : '';
      const body = m ? `${m[2] ? `<span class="bs-lim">${rich(m[2].trim())}</span>${m[3]}${rest && !/^[.,;]/.test(rest) ? ' ' : ''}` : ''}${rich(rest)}` : rich(t);
      return el('p', { class: 'bs-line' + (a.struck ? ' struck' : '') },
        nm ? el('strong', { class: 'bs-ln', html: tipify(esc(nm)) + (m[2] ? '' : m[3]) }) : null, ' ', el('span', { html: body }),
        a.struck ? el('span', { class: 'bs-off' }, ' Not used as a minion.') : null);
    };
    const traitLine = (t, i) => {
      const m = t.html.match(/^\*([^*]+)\*(\s*\([^)]*\))?([.:]?)\s*([\s\S]*)$/);
      const p = !m ? el('p', { class: 'bs-line' + (t.struck ? ' struck' : ''), html: rich(t.html) })
        : el('p', { class: 'bs-line' + (t.struck ? ' struck' : '') },
          el('em', { class: 'bs-tn', html: tipify(`<em>${esc(m[1])}</em>`).replace(/^<em>|<\/em>$/g, '') + (m[2] ? esc(m[2]) : '') + m[3] }), m[4] && !/^[,;]/.test(m[4]) ? ' ' : null, m[4] ? el('span', { html: rich(m[4]) }) : null,
          t.struck ? el('span', { class: 'bs-off' }, ' Not used as a minion.') : null);
      if (i != null && m && c.mechanics) {
        // the callout shows the mechanic's name and numbers, so only the rest of the line goes under it
        const rest = (m[4] || '').trim();
        const body = rest && rest !== '.' ? el('p', { class: 'bs-line', html: rich(cap(rest)) }) : el('span');
        const w = mechTrait(c, t, i, body);
        if (w) return w;
      }
      return p;
    };
    const extra = v.extraTraits.map(x => { const p = x.label ? el('p', { class: 'bs-line' }, el('strong', { class: 'bs-ln' }, x.label + '.'), ' ', el('span', { html: rich(x.html) })) : x.raw ? el('p', { class: 'bs-line', html: rich(x.html) }) : traitLine({ html: x.html }); p.classList.add('bs-added'); p.prepend(el('span', { class: 'bs-tag' }, x.tag), ' '); return p; });
    const sec = (title, ...kids) => el('section', { class: 'bs-sec' }, el('h2', {}, title), ...kids.flat().filter(Boolean));
    const f = v.forge && D.flavour.get(v.forge.fl);
    const tierN = c.tierNumber || 0;
    const flavourSec = f ? (() => {
      const moveAt = f.godTier ? 4 : 2, upAt = f.godTier ? 5 : 4;
      const rows = [
        ['Status', f.status], ['Immune to', `${f.name} (its own flavour)`], ['Weak to', `${f.weakTo} (double damage)`],
        c.family === 'elemental' ? ['Movement', f.movement] : null, ['Lair effect', f.lair],
        tierN >= moveAt ? ['Signature move', f.signature.cell] : null, tierN >= upAt ? ['Upgrade', f.upgrade.cell] : null,
      ].filter(Boolean);
      const dsp = v.forge.disp && D.disposition.rows.map(r => [r.aspect, r[v.forge.disp.toLowerCase()]]);
      return [sec(`${f.name} flavour`, el('dl', { class: 'bs-dl' }, ...rows.flatMap(([k, t]) => [el('dt', {}, k), el('dd', { html: rich(t) })]))),
        dsp ? sec(v.forge.disp, el('dl', { class: 'bs-dl' }, ...dsp.flatMap(([k, t]) => [el('dt', {}, k), el('dd', { html: rich(t) })]))) : null];
    })() : null;
    const notes = v.notes.length ? el('div', { class: 'bs-notes' }, ...v.notes.map(n => n.fine ? el('p', { class: 'bs-fine' }, n.html) : el('p', {}, el('span', { class: 'bs-tag' }, n.tag), ' ', el('span', { html: rich(n.html) })))) : null;
    const roleWants = (v.role || c.wants) ? el('dl', { class: 'bs-dl' },
      v.role ? el('dt', { html: tipify(esc('Role')) }) : null, v.role ? el('dd', { html: tipify(esc(v.role)) }) : null,
      c.wants ? el('dt', {}, 'Wants') : null, c.wants ? el('dd', { html: rich(c.wants) }) : null) : null;
    const play = el('section', { class: 'bs-play' },
      el('h2', {}, 'How to play it'),
      roleWants,
      c.tactics ? el('p', { class: 'bs-tactics' }, el('span', { class: 'k' }, 'Tactics'), ' ', el('span', { html: rich(c.tactics) })) : null,
      el('div', { class: 'bs-te' },
        el('div', { class: 'bs-tell' }, el('span', { class: 'k', html: ICON.tell + 'Tell' }), el('span', { class: 'v', html: rich(cap(c.tell)) })),
        el('div', { class: 'bs-exploit' }, el('span', { class: 'k', html: ICON.exploit + 'Exploit' }), el('span', { class: 'v', html: rich(cap(c.exploit)) }))));
    const phases = named && c.phases.length ? el('section', { class: 'bs-sec bs-phases' },
      el('h2', {}, 'Phases'),
      el('div', { class: 'bs-phbar', 'aria-hidden': 'true' },
        el('span', { class: 'seg s0' }), el('span', { class: 'seg s1' }), el('span', { class: 'seg s2' }),
        el('span', { class: 'end l' }, 'Full HP'), el('span', { class: 'end r' }, '0'),
        ...c.phases.map((p, i) => el('span', { class: 'mark', style: `left:${100 - parseFloat(p.at)}%` }, el('span', { class: 'lbl' }, `Phase ${i + 1} · ${p.at}`)))),
      el('ol', { class: 'bs-phlist' }, ...c.phases.map((p, i) => el('li', {},
        el('span', { class: 'n' }, String(i + 1)),
        el('span', {}, el('strong', {}, `At ${p.at} HP`), ' ', el('span', { html: rich(p.text) })))))) : null;
    const namedSecs = named ? [
      phases,
      sec('Lair', el('p', { class: 'bs-line', html: rich(c.lair) })),
      sec('Hook', el('p', { class: 'bs-line', html: rich(c.hook) })),
      sec('Loot', el('p', { class: 'bs-line', html: rich(c.loot) })),
    ] : [];
    const harvest = c.harvest ? sec('Harvest', el('p', { class: 'bs-line', html: rich(c.harvest) }), el('p', { class: 'bs-fine' }, harvestNote(v.kr, c.name))) : null;
    // both volumes: Attacks, Traits, (named: Phases, Lair, Hook, Loot), Harvest, then Role / Wants and Tactics with Tell and Exploit
    const body = [sec('Attacks', v.attacks.map(line)), sec('Traits', v.traits.map((t, i) => traitLine(t, i)), extra), notes, flavourSec, ...namedSecs, harvest, play];
    return el('article', { class: 'bs-card' + (opts.print ? ' print' : '') },
      head, desc, work,
      el('div', { class: 'bs-rule' }),
      core, stats, combat,
      el('div', { class: 'bs-rule' }),
      el('div', { class: 'bs-body' }, ...body));
  }

  function toolbar(c, v, forge, setTpl) {
    const tpl = v.tpl;
    setTpl = setTpl || (list => go({ tpl: list.join(',') }, false));
    const toggle = t => {
      const on = tpl.includes(t);
      const ok = allowed(c, t) && !(t === 'minion' && (tpl.includes('alpha') || tpl.includes('boss'))) && !(t !== 'minion' && tpl.includes('minion'));
      const why = !allowed(c, t) ? (t === 'alpha' ? (c.type === 'Humanoid' ? 'Humanoids don’t get Alphas. Use the race’s Prime version instead.' : 'Any creature in this book can be an Alpha, except a Primordial.') : t === 'minion' ? 'Any creature of KR 8 or lower can be run as a minion.' : '') : !ok ? (t === 'minion' ? 'Turn off Alpha and Boss first.' : 'Turn off Minion first.') : '';
      return el('button', { type: 'button', class: 'bs-tpl' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !on && !ok, title: why || null,
        onclick: () => {
          const next = on ? tpl.filter(x => x !== t) : [...tpl, t];
          setTpl(cleanTpl(c, next));
        } }, cap(t));
    };
    const tipBtn = t => el('button', { type: 'button', class: 'bs-tip bs-q', 'data-tip': String(D.tplTip[t]), 'aria-label': `${cap(t)} rules` }, '?');
    const tplRow = c.kind === 'named'
      ? el('p', { class: 'bs-built' }, 'Built from ', el('button', { class: 'linkbtn', onclick: () => c.volume === 2 ? openCreature(D.byId.get(c.builtFromId)) : go(c.flavour ? { tab: 'forge', fam: 'dragon', ftier: c.builtFromId.split('-')[0], fl: slugF(c.flavour), disp: '', tpl: c.templates.map(x => x.toLowerCase()).join(','), mon: '' } : { tab: 'beast', mon: c.builtFromId, tpl: c.templates.map(x => x.toLowerCase()).join(',') }, true) }, c.builtFrom), c.templates.length ? ` with ${c.templates.join(' and ')} applied.` : '.')
      : el('div', { class: 'bs-tpls', role: 'group', 'aria-label': 'Templates' }, el('span', { class: 'k' }, 'Template'), ...['alpha', 'boss', 'minion'].flatMap(t => [toggle(t), tipBtn(t)]));
    return el('div', { class: 'bs-tools' },
      tplRow,
      el('div', { class: 'bs-acts' },
        el('button', { class: 'btn small', onclick: () => { addToEncounter(c, v, forge); } }, 'Add to encounter'),
        el('button', { class: 'btn small', onclick: () => printCard(v) }, 'Print'),
        c.volume === 2 ? el('button', { class: 'btn small', title: 'Copy a link straight to this stat block', onclick: e => copyLink(c, e.currentTarget) }, 'Copy link') : null),
      flash ? el('p', { class: 'notes-msg ok bs-flash', role: 'status' }, flash, ' ', el('button', { class: 'mini', onclick: () => { flash = ''; go({ tab: 'encounter', mon: '' }, true); } }, 'Open the encounter')) : null);
  }
  function copyLink(c, btn) {
    const L = linkFor(c);
    const url = `${location.origin}${location.pathname}#tab=vol2&page=${L.rs}&mon=${L.mon}`;
    const ok = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1500); };
    try { navigator.clipboard.writeText(url).then(ok, () => window.prompt('Copy this link', url)); } catch (e) { window.prompt('Copy this link', url); }
  }
  const slugF = n => (D.flavour.get(n.toLowerCase().replace(/[^a-z0-9]+/g, '-')) || {}).id || '';

  // template rule tooltips sit after the creature tips
  function templateTips() {
    if (D._tt) return;
    D._tt = true;
    const T = D.templates;
    const body = s => s.split('\n').filter(l => !l.startsWith('|')).join('\n');
    D.tplTip = {};
    for (const k of ['alpha', 'boss', 'minion']) D.tplTip[k] = D.tips.push({ re: /$^/, title: T[k].name, text: body(T[k].rules).replace(/\n+/g, ' ') }) - 1;
  }

  function printRoot(v) {
    let root = $('#print-root');
    if (!root) { root = el('div', { id: 'print-root' }); document.body.append(root); }
    root.replaceChildren(el('div', { class: 'bs-printpage' }, card(v, { print: true })));
  }
  function printCard(v) {
    printRoot(v);
    const title = document.title;
    document.title = v.name;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); document.title = title; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
  }

  function renderCreature(pane, c) {
    templateTips();
    const tpl = tplList(state.tpl);
    const v = view(c, tpl);
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => go({ mon: '', tpl: '' }, true) }, '← Back to the bestiary'),
      toolbar(c, v, null),
      card(v));
    document.title = `${v.name} · Bestiary`;
  }

  /* ---------------- dragon and elemental builder ---------------- */

  function forgeState() {
    const fam = state.fam === 'elemental' ? 'elemental' : 'dragon';
    const tier = TIERS.map(t => t.toLowerCase()).includes(state.ftier) ? state.ftier : 'adult';
    const tierName = cap(tier);
    const godOk = ['ancient', 'primordial'].includes(tier);
    let fl = D.flavour.get(state.fl) ? state.fl : 'fire';
    if (D.flavour.get(fl).godTier && !godOk) fl = 'fire';
    const disp = state.disp === 'benevolent' || state.disp === 'malevolent' ? state.disp : 'malevolent';
    const c = D.creatures.find(x => x.family === fam && x.tier === tierName);
    return { fam, tier, fl, disp, c };
  }

  function renderForge(box, meta) {
    templateTips();
    meta.textContent = '';
    const F = forgeState();
    const tpl = cleanTpl(F.c, tplList(state.tpl));
    const forge = { fl: F.fl, disp: cap(F.disp) };
    const v = view(F.c, tpl, forge);
    const godOk = ['ancient', 'primordial'].includes(F.tier);
    const byPath = {};
    for (const f of D.flavours.flavours) (byPath[f.pathKind] = byPath[f.pathKind] || []).push(f);
    const pathName = { Element: 'Elements', Hybrid: 'Hybrids', Sixth: 'Sixth', Magic: 'Magic' };
    const intro = D.rules.categories.find(x => x.id === (F.fam === 'dragon' ? 'dragons' : 'elementals'));
    box.replaceChildren(el('div', { class: 'bs-forge' },
      el('div', { class: 'bs-forge-controls' },
        el('div', { class: 'bs-ctl' }, el('span', { class: 'k' }, 'Build a'), seg([['dragon', 'Dragon'], ['elemental', 'Elemental']], F.fam, x => go({ fam: x }, false), 'Dragon or elemental')),
        el('div', { class: 'bs-ctl' }, el('span', { class: 'k' }, 'Tier'), seg(TIERS.map(t => [t.toLowerCase(), t]), F.tier, x => go({ ftier: x }, false), 'Tier')),
        el('div', { class: 'bs-ctl wide' }, el('span', { class: 'k' }, 'Flavour'),
          el('div', { class: 'bs-flavours' }, ...Object.entries(byPath).map(([p, fs]) => el('div', { class: 'bs-fgroup' },
            el('span', { class: 'bs-fpath' }, pathName[p] || p),
            ...fs.map(f => el('button', { type: 'button', class: 'chip' + (F.fl === f.id ? ' on' : ''), 'aria-pressed': String(F.fl === f.id), disabled: f.godTier && !godOk,
              title: f.godTier && !godOk ? 'Creation and Destruction are god-tier, so they only exist at Ancient and Primordial.' : `${f.status}. Weak to ${f.weakTo}.`,
              onclick: () => go({ fl: f.id }, false) }, f.name)))))),
        el('div', { class: 'bs-ctl' }, el('span', { class: 'k' }, 'Disposition'), seg([['benevolent', 'Benevolent'], ['malevolent', 'Malevolent']], F.disp, x => go({ disp: x }, false), 'Disposition'))),
      el('details', { class: 'shared bs-howto' }, el('summary', {}, F.fam === 'dragon' ? 'How dragons are built' : 'How elementals are built'), el('div', { class: 'prose', html: tipify(md(intro.md)) })),
      el('div', { class: 'bs-forge-card detail-like' }, toolbar(F.c, v, forge), card(v))));
    document.title = `${v.name} · Dragons & elementals`;
  }

  /* ---------------- encounter builder ---------------- */

  const ENC_KEY = 'hb-encounter';
  function encLoad() {
    try { const e = JSON.parse(localStorage.getItem(ENC_KEY) || 'null'); if (e && Array.isArray(e.rows) && Array.isArray(e.party)) return e; } catch (e) { /* storage blocked */ }
    return { party: [1, 1, 1, 1], rows: [] };
  }
  let ENC = encLoad();
  function encSave() { try { localStorage.setItem(ENC_KEY, JSON.stringify(ENC)); } catch (e) { /* kept in memory only */ } }

  function rowView(r) {
    const c = D.byId.get(r.ref);
    if (!c) return null;
    return view(c, r.tpl || [], r.fl ? { fl: r.fl, disp: r.disp || 'Malevolent' } : null);
  }

  function addToEncounter(c, v, forge) {
    const key = r => `${r.ref}|${(r.tpl || []).join(',')}|${r.fl || ''}|${r.disp || ''}`;
    const nr = { ref: c.id, tpl: v.tpl, n: 1, fl: forge ? forge.fl : '', disp: forge ? forge.disp : '' };
    const hit = ENC.rows.find(r => key(r) === key(nr));
    if (hit) hit.n += 1; else ENC.rows.push(nr);
    encSave();
    const total = ENC.rows.reduce((a, r) => a + r.n, 0);
    flash = `Added ${v.name}. The encounter has ${total} creature${total === 1 ? '' : 's'}.`;
    render();
    clearTimeout(addToEncounter.t);
    addToEncounter.t = setTimeout(() => { flash = ''; if (TABS.includes(state.tab)) render(); }, 6000);
  }

  function encMaths() {
    const T = D.templates.group;
    let sum = 0, size = 0;
    const lines = [];
    for (const r of ENC.rows) {
      const v = rowView(r);
      if (!v) continue;
      sum += v.kr * r.n;
      if (!v.tpl.includes('minion')) size += r.n;
      lines.push({ r, v });
    }
    const band = T.bands.find(b => size >= b.min && (b.max == null || size <= b.max));
    const mult = band ? band.multiplier : 1;
    const exact = sum * mult;
    const total = exact >= 1 ? Math.round(exact) : Math.round(exact * 100) / 100;
    const party = ENC.party.reduce((a, l) => a + (l === 0 ? 0.5 : l), 0);
    let verdict = null;
    if (total > 0 && party > 0) {
      const r = party / exact;
      verdict = r >= 1.5 ? 'easy' : r >= 0.75 ? 'fair' : 'deadly';
    }
    return { sum, size, mult, exact, total, party, verdict, lines };
  }

  const VERDICT = {
    easy: ['Easy', 'At double, it’s a comfortable win.'],
    fair: ['Fair', 'Party total equal to the KR means a fair fight that can still go wrong.'],
    deadly: ['Deadly', 'At about half the KR, expect deaths.'],
  };

  function renderEncounter(box, meta) {
    templateTips();
    meta.textContent = '';
    const M = encMaths();
    const save = () => { encSave(); render(); };
    // party
    const party = el('section', { class: 'bs-enc-sec' },
      el('h2', { class: 'section-head' }, 'Party'),
      el('p', { class: 'd-note' }, 'Each adventurer’s level. Level 0 counts as ½.'),
      el('div', { class: 'bs-party' },
        ...ENC.party.map((l, i) => el('label', { class: 'bs-pc' },
          el('span', { class: 'k' }, `Adventurer ${i + 1}`),
          el('input', { type: 'number', min: '0', max: '30', step: '1', value: String(l), inputmode: 'numeric', 'aria-label': `Adventurer ${i + 1} level`,
            onchange: e => { ENC.party[i] = Math.max(0, parseInt(e.target.value, 10) || 0); save(); } }),
          el('button', { type: 'button', class: 'mini', 'aria-label': `Remove adventurer ${i + 1}`, onclick: () => { ENC.party.splice(i, 1); save(); } }, 'Remove'))),
        el('button', { type: 'button', class: 'add-row bs-addpc', onclick: () => { ENC.party.push(ENC.party.length ? ENC.party[ENC.party.length - 1] : 1); save(); } }, '+ Add an adventurer')));
    // creature search
    const q = norm(encQ);
    const hits = q ? D.creatures.filter(c => norm(c.name).includes(q)).sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || a.kr - b.kr).slice(0, 8) : [];
    const search = el('div', { class: 'bs-enc-add' },
      el('input', { type: 'search', class: 'bs-encq', placeholder: 'Add a creature: type a name…', value: encQ, 'aria-label': 'Find a creature to add',
        oninput: e => { encQ = e.target.value; render(); const i = $('.bs-encq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } },
        onkeydown: e => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0]); } } }),
      hits.length ? el('div', { class: 'bs-hits' }, ...hits.map(c => el('button', { type: 'button', class: 'bs-hit', onclick: () => add(c) },
        el('span', { class: 'nm' }, c.name), el('span', { class: 'bs-kr' }, 'KR ' + krText(c.kr))))) : null);
    function add(c) {
      const r = { ref: c.id, tpl: [], n: 1, fl: c.kind === 'tier' ? 'fire' : '', disp: c.kind === 'tier' ? 'Malevolent' : '' };
      const same = ENC.rows.find(x => x.ref === r.ref && !(x.tpl || []).length && (x.fl || '') === r.fl);
      if (same) same.n += 1; else ENC.rows.push(r);
      encQ = ''; save();
      const i = $('.bs-encq'); if (i) i.focus();
    }
    // rows
    const rows = M.lines.map(({ r, v }) => {
      const c = v.base;
      const i = ENC.rows.indexOf(r);
      const tbtn = t => el('button', { type: 'button', class: 'bs-tpl small' + (v.tpl.includes(t) ? ' on' : ''), 'aria-pressed': String(v.tpl.includes(t)), disabled: !allowed(c, t) || (t === 'minion' ? v.tpl.some(x => x !== 'minion') : v.tpl.includes('minion')),
        onclick: () => { const on = v.tpl.includes(t); r.tpl = cleanTpl(c, on ? v.tpl.filter(x => x !== t) : [...v.tpl, t]); save(); } }, cap(t));
      return el('div', { class: 'bs-erow' },
        el('div', { class: 'bs-ename' },
          el('button', { class: 'bs-elink', onclick: () => r.fl ? go({ tab: 'forge', fam: c.family, ftier: c.tier.toLowerCase(), fl: r.fl, disp: (r.disp || '').toLowerCase(), tpl: v.tpl.join(','), mon: '' }, true) : openCreature(c, v.tpl) }, v.name),
          el('span', { class: 'bs-each' }, `KR ${krText(v.kr)} each`)),
        c.kind === 'named' ? el('span', { class: 'bs-etpl' }) : el('div', { class: 'bs-etpl' }, ...['alpha', 'boss', 'minion'].map(tbtn)),
        el('div', { class: 'bs-count' },
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One fewer ${v.name}`, onclick: () => { r.n -= 1; if (r.n < 1) ENC.rows.splice(i, 1); save(); } }, '−'),
          el('span', { class: 'v', 'aria-live': 'polite' }, String(r.n)),
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One more ${v.name}`, onclick: () => { r.n += 1; save(); } }, '+')),
        el('span', { class: 'bs-sub' }, krText(Math.round(v.kr * r.n * 100) / 100)));
    });
    const creatures = el('section', { class: 'bs-enc-sec' },
      el('h2', { class: 'section-head' }, 'Creatures'),
      search,
      rows.length ? el('div', { class: 'bs-erows' }, ...rows) : el('p', { class: 'd-note' }, 'Nothing added yet. Search above, or use “Add to encounter” on any stat card.'),
      rows.length ? el('button', { class: 'mini', onclick: () => { ENC.rows = []; save(); } }, 'Clear the creatures') : null);
    // result
    const V = M.verdict && VERDICT[M.verdict];
    const gaugePos = M.verdict ? Math.max(0, Math.min(100, (Math.log2(M.party / M.exact) + 2) / 4 * 100)) : null;  // ¼× … 4×
    const working = [];
    if (M.lines.length) {
      working.push(`Creatures add up to KR ${krText(Math.round(M.sum * 100) / 100)}.`);
      working.push(M.mult > 1 ? `${M.size} creatures act separately, so ×${M.mult} = ${krText(Math.round(M.exact * 100) / 100)}.` : `${M.size} creature${M.size === 1 ? '' : 's'} acting separately, so no group multiplier.`);
      if (M.lines.some(x => x.v.tpl.includes('minion'))) working.push('Minions don’t count towards group size.');
    }
    const result = el('section', { class: 'bs-result' + (M.verdict ? ' ' + M.verdict : '') },
      el('div', { class: 'bs-res-nums' },
        el('div', { class: 'bs-res-n' }, el('span', { class: 'k' }, 'Encounter KR'), el('span', { class: 'v' }, krText(M.total))),
        el('div', { class: 'bs-res-n' }, el('span', { class: 'k' }, 'Party total'), el('span', { class: 'v' }, krText(M.party))),
        el('div', { class: 'bs-res-n verdict' }, el('span', { class: 'k' }, 'This fight is'), el('span', { class: 'v' }, V ? V[0] : '–'))),
      M.verdict ? el('div', { class: 'bs-gauge', 'aria-hidden': 'true' },
        el('span', { class: 'z deadly' }), el('span', { class: 'z fair' }), el('span', { class: 'z easy' }),
        el('span', { class: 'tick', style: 'left:25%' }, '½×'), el('span', { class: 'tick', style: 'left:50%' }, '1×'), el('span', { class: 'tick', style: 'left:75%' }, '2×'),
        el('span', { class: 'pin', style: `left:${gaugePos}%` })) : null,
      V ? el('p', { class: 'bs-verdict' }, V[1], ' ', el('span', { class: 'hint' }, 'Terrain, surprise and numbers shift the real difficulty, so adjust on the day.')) : el('p', { class: 'bs-verdict hint' }, M.lines.length ? 'Add the party’s levels to see how hard it is.' : 'Add some creatures to see the encounter’s KR.'),
      working.length ? el('p', { class: 'bs-work' }, working.join(' ')) : null,
      el('p', { class: 'bs-fine' }, 'Easy: party total at least 1.5× the KR. Fair: from 0.75× up to 1.5×. Deadly: below 0.75×.'));
    // encounter tables
    const E = D.encounters;
    const linkFor = txt => {
      const t = txt.trim();
      const m = t.match(/^(Juvenile|Adult|Elder|Ancient|Primordial) (.+?) (Dragon|Elemental)$/);
      if (m) { const fl = slugF(m[2].split(' or ')[0].replace(/^Deep$/, 'The Deep')); return () => go({ tab: 'forge', fam: m[3].toLowerCase(), ftier: m[1].toLowerCase(), fl, disp: '', tpl: '', mon: '' }, true); }
      const am = t.match(/^(.+?) \(Alpha\)$/);
      if (am) { const a = D.templates.alpha.alphas.find(x => x.name === am[1]); if (a) return () => go({ tab: 'beast', mon: a.baseId, tpl: 'alpha' }, true); }
      const cands = [t, t.replace(/ (pack|pod|swarm)$/i, ''), t.replace(/s$/, ''), t.replace(/ (pack|pod|swarm)$/i, '').replace(/s$/, '')];
      for (const n of cands) { const c = D.byName.get(n.toLowerCase()); if (c) return () => go({ tab: c.kind === 'named' ? 'named' : 'beast', mon: c.id, tpl: '' }, true); }
      return null;
    };
    const col = M.party ? E.bands.findIndex(b => M.party >= b.min && (b.max == null || M.party <= b.max)) : -1;
    const tables = el('section', { class: 'bs-enc-sec' },
      el('h2', { class: 'section-head' }, E.title),
      el('p', { class: 'd-note' }, E.intro, col >= 0 ? ` Your party’s column is ${E.bands[col].label}.` : ''),
      el('div', { class: 'bs-regions' }, ...E.regions.map(r => el('div', { class: 'bs-region' },
        el('h3', {}, r.name),
        el('div', { class: 'bs-bands' }, ...r.cells.map((cell, k) => el('div', { class: 'bs-band' + (k === col ? ' on' : '') },
          el('span', { class: 'k' }, E.bands[k].label),
          el('div', { class: 'bs-chips' }, ...cell.map(n => { const go2 = linkFor(n); return go2 ? el('button', { class: 'linkbtn small', onclick: go2 }, n) : el('span', { class: 'linkbtn small dim' }, n); })))))))));
    box.replaceChildren(el('div', { class: 'bs-enc' }, result, party, creatures, tables));
    document.title = 'Encounter builder · Bestiary';
  }

  /* ---------------- rules ---------------- */

  function rulePages() {
    if (D._pages) return D._pages;
    const R = D.rules;
    const S = Object.fromEntries(R.sections.map(s => [s.id, s.md]));
    const split = mdText => {   // "### Title" blocks
      const out = {}; let cur = '_intro';
      for (const l of mdText.split('\n')) { const m = l.match(/^### (.+)$/); if (m) { cur = m[1]; out[cur] = ''; } else out[cur] = (out[cur] || '') + l + '\n'; }
      return out;
    };
    const run = split(S.running);
    const pages = [
      { id: 'using', title: 'Using this bestiary', md: S.using },
      { id: 'running', title: 'Running monsters', md: [run._intro, ...['Actions and attacks', 'Reading the new lines', 'Monster Min hit', 'Solo creatures', 'Effects that end a fight'].map(k => `### ${k}\n\n${run[k].trim()}`)].join('\n\n') },
      { id: 'statuses', title: 'Status effects', md: run['Status effects'] },
      { id: 'budget', title: 'KR budget', sub: 'Building and checking a monster', md: run['Building and checking a monster'] },
      { id: 'harvest', title: 'Harvest values', md: run['Harvest values'] },
      { id: 'alpha', title: 'The Alpha template', md: S.alpha },
      { id: 'templates', title: 'Group, Minion and Boss templates', md: S.templates },
      { id: 'flavours', title: 'Flavours and signature moves', md: S.flavours },
      { id: 'disposition', title: 'Disposition', md: S.disposition },
      { id: 'types', title: 'Creature types', md: R.categories.map(c => `### ${c.title}\n\n${c.md}`).join('\n\n') },
      { id: 'index', title: 'Index by Kill Rating', md: null },
    ];
    D._pages = pages;
    return pages;
  }

  function renderRulesList(box, meta) {
    meta.textContent = 'Contents';
    box.replaceChildren(...rulePages().map(p => el('button', { class: 'card toc' + (state.rs === p.id ? ' sel' : ''), onclick: () => { go({ rs: p.id }, true); const d = $('#detail'); if (d) d.scrollTop = 0; } },
      el('span', { class: 'card-name' }, p.title), p.sub ? el('span', { class: 'card-sub' }, p.sub) : null)));
  }

  function renderRulesPage(pane, p) {
    const pages = rulePages();
    const k = pages.indexOf(p);
    let body;
    if (p.id === 'index') {
      body = el('div', { class: 'prose' }, el('div', { class: 'table-wrap' }, el('table', { class: 'bs-index' },
        el('thead', {}, el('tr', {}, el('th', { class: 'nar' }, 'KR'), el('th', {}, 'Creature'), el('th', {}, 'Type'))),
        el('tbody', {}, ...D.rules.index.map(r => { const c = D.byName.get(r.name.toLowerCase()); return el('tr', {}, el('td', { class: 'nar', 'data-label': 'KR' }, krText(r.kr)), el('td', { 'data-label': 'Creature' }, c ? el('button', { class: 'bs-elink', onclick: () => go({ tab: 'beast', mon: c.id, tpl: '' }, true) }, r.name) : r.name), el('td', { 'data-label': 'Type' }, r.type)); })))));
    } else body = el('div', { class: 'prose doc bs-rules', html: tipify(md(p.md)) });
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => go({ rs: '' }, true) }, '← Monster rules'),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Monster rules'), 'Bestiary: Volume I'),
      el('h1', { class: 'd-title' }, p.title),
      body,
      el('nav', { class: 'pager' },
        pages[k - 1] ? el('button', { class: 'pg prev', onclick: () => go({ rs: pages[k - 1].id }, true) }, el('span', { class: 'k' }, '← Previous'), el('span', { class: 'v' }, pages[k - 1].title)) : el('span'),
        pages[k + 1] ? el('button', { class: 'pg next', onclick: () => go({ rs: pages[k + 1].id }, true) }, el('span', { class: 'k' }, 'Next →'), el('span', { class: 'v' }, pages[k + 1].title)) : el('span')));
    document.title = `${p.title} · Monster rules`;
  }

  /* ---------------- Volume II ---------------- */

  const v2Pages = () => !D.v2 ? [] : [
    { id: 'intro', title: D.v2.intro.title, sub: 'Weak Point, Countdown and Shift' },
    { id: 'index', title: 'Index', sub: `All ${D.v2.count} entries by KR` },
    ...D.v2.families.filter(f => f.id !== 'named').map(f => ({ id: f.id, title: f.title, sub: `${f.count} creatures · KR ${krText(f.krMin)}–${krText(f.krMax)}`, family: f })),
    { id: 'named', title: 'Named Monsters', sub: `${D.v2.fam.get('named').count} · KR ${krText(D.v2.fam.get('named').krMin)}–${krText(D.v2.fam.get('named').krMax)}`, family: D.v2.fam.get('named') },
  ];

  // shared search across both volumes: names, families and types, and the Tell and Exploit lines
  function searchHits(q, opts = {}) {
    if (!D) return [];
    const toks = norm(q).split(' ').filter(Boolean);
    if (!toks.length) return [];
    const qn = norm(q);
    const out = [];
    for (const c of D.creatures) {
      if (opts.volume && c.volume !== opts.volume) continue;
      const n = norm(c.name), fam = norm(`${c.family || c.section || ''} ${c.typeLine || ''} ${c.type || ''}`), tell = norm(c.tell), expl = norm(c.exploit);
      let sc = 0, where = 'name';
      const ws = str => str.split(' ');
      for (const t of toks) {
        if (n.startsWith(t)) sc += 30;
        else if (ws(n).some(w => w.startsWith(t))) sc += 20;
        else if (n.includes(t)) sc += 10;
        else if (ws(fam).some(w => w.startsWith(t))) { sc += 4; if (where === 'name') where = 'family'; }
        else if (ws(tell).some(w => w.startsWith(t))) { sc += 1; where = 'tell'; }
        else if (ws(expl).some(w => w.startsWith(t))) { sc += 1; where = 'exploit'; }
        else { sc = -1; break; }
      }
      if (sc < 0) continue;
      if (n === qn) sc += 100;
      else if (toks.length > 1 && (tell.includes(qn) || expl.includes(qn))) sc += 6;
      out.push({ c, score: sc, where, nameHit: sc >= 10 * toks.length });
    }
    return out.sort((a, b) => b.score - a.score || a.c.kr - b.c.kr).slice(0, opts.limit || 60);
  }
  function hitSnip(h, q) {
    const c = h.c;
    if (h.where === 'tell' || h.where === 'exploit') {
      const txt = cap(c[h.where]);
      const toks = norm(q).split(' ').filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      let html = esc(txt.replace(/\*/g, ''));
      if (toks.length) html = html.replace(new RegExp(`(${toks.join('|')})`, 'gi'), '<mark>$1</mark>');
      return `<span class="bs-snipk">${h.where === 'tell' ? 'Tell' : 'Exploit'}:</span> ${html}`;
    }
    return null;
  }
  function hitCard(h, q) {
    const c = h.c;
    const card = monCard(c, false, { open: () => openCreature(c), snip: hitSnip(h, q) });
    card.querySelector('.card-top').prepend(el('span', { class: 'badge bs' }, c.volume === 2 ? 'Bestiary II' : 'Bestiary I'));
    return card;
  }

  function renderV2List(box, meta) {
    if (!D.v2) {
      meta.textContent = '';
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Volume II isn’t set up yet'), 'Run supabase/bestiary-2.sql in the Supabase SQL editor, then reload.'));
      return;
    }
    if (state.q.trim()) {
      const hits = searchHits(state.q, { volume: 2 });
      meta.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} in Volume II`;
      box.replaceChildren(...(hits.length ? hits.map(h => hitCard(h, state.q)) : [el('div', { class: 'empty' }, el('strong', {}, 'Nothing found'), `Nothing in Volume II matches “${state.q}”.`)]));
      return;
    }
    meta.textContent = 'Contents';
    const pages = v2Pages();
    const tocCard = p => el('button', { class: 'card toc' + (state.rs === p.id ? ' sel' : ''), onclick: () => { go({ rs: p.id, mon: '' }, true); const d = $('#detail'); if (d) d.scrollTop = 0; } },
      el('span', { class: 'card-name' }, p.title), p.sub ? el('span', { class: 'card-sub' }, p.sub) : null);
    box.replaceChildren(
      el('div', { class: 'section-head' }, 'Bestiary: Volume II'),
      ...pages.filter(p => ['intro', 'index'].includes(p.id)).map(tocCard),
      el('div', { class: 'section-head' }, `Families · ${pages.filter(p => p.family && p.id !== 'named').length}`),
      ...pages.filter(p => p.family && p.id !== 'named').map(tocCard),
      el('div', { class: 'section-head' }, 'Named monsters'),
      tocCard(pages.find(p => p.id === 'named')));
  }

  // one stat block on a Volume II page, with its own toolbar
  function entry(c) {
    const node = el('section', { class: 'bs-entry', id: 'bs-a-' + c.id });
    const draw = () => {
      const v = view(c, PAGE_TPL.get(c.id) || []);
      node.replaceChildren(toolbar(c, v, null, list => { PAGE_TPL.set(c.id, list); draw(); }), card(v, { h: 'h2' }));
    };
    draw();
    return node;
  }

  function renderV2Page(pane, p) {
    templateTips();
    const pages = v2Pages();
    const k = pages.findIndex(x => x.id === p.id);
    const kicker = el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Volume II'), p.family ? (p.id === 'named' ? 'Named monsters' : 'Family') : 'Bestiary: Volume II');
    let body = [];
    if (p.id === 'intro') body = v2Intro();
    else if (p.id === 'index') body = [indexTable()];
    else {
      const f = p.family;
      const list = f.ids.map(id => D.byId.get(id));
      body = [
        el('div', { class: 'prose bs-lead', html: tipify(md(p.id === 'named' ? D.v2.namedIntro : f.lead)) }),
        el('div', { class: 'onpage bs-onpage' }, el('span', { class: 'k' }, 'On this page'),
          el('div', { class: 'linklist' }, ...list.map(c => el('button', { class: 'linkbtn', onclick: () => { go({ mon: c.id }, false); jump(c.id, true); } }, c.name, el('span', { class: 'bs-tockr' }, ` ${krText(c.kr)}`))))),
        ...list.map(entry),
      ];
    }
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => go({ rs: '', mon: '' }, true) }, '← Volume II contents'),
      kicker,
      el('h1', { class: 'd-title' }, p.title),
      ...body,
      el('nav', { class: 'pager' },
        pages[k - 1] ? el('button', { class: 'pg prev', onclick: () => { go({ rs: pages[k - 1].id, mon: '' }, true); pane.scrollTop = 0; } }, el('span', { class: 'k' }, '← Previous'), el('span', { class: 'v' }, pages[k - 1].title)) : el('span'),
        pages[k + 1] ? el('button', { class: 'pg next', onclick: () => { go({ rs: pages[k + 1].id, mon: '' }, true); pane.scrollTop = 0; } }, el('span', { class: 'k' }, 'Next →'), el('span', { class: 'v' }, pages[k + 1].title)) : el('span')));
    document.title = `${p.title} · Bestiary: Volume II`;
    // deep links: scroll to the stat block (or rule) once
    const target = `${p.id}|${state.mon}`;
    if (state.mon && target !== lastAnchor) { lastAnchor = target; requestAnimationFrame(() => jump(state.mon, false)); }
    if (!state.mon) lastAnchor = '';
  }

  function jump(id, smooth) {
    const t = document.getElementById('bs-a-' + id);
    if (!t) return;
    t.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  }

  function v2Intro() {
    const src = D.v2.intro.md;
    const [before, rest] = src.split('### New in Volume II');
    const [newPart, after] = rest.split('### Family structure');
    const lead = newPart.split('\n').filter(l => l.trim() && !l.startsWith('- ')).join('\n');
    const examples = {
      'weak-point': D.creatures.find(c => c.mechanics && c.mechanics.weakPoints.some(w => w.part === 'Egg sac')),
      countdown: D.creatures.find(c => c.mechanics && c.mechanics.countdowns.some(x => x.effect === 'Hatch')),
      shift: D.creatures.find(c => c.mechanics && c.mechanics.shifts.some(x => x.modes.join('/') === 'Liquid/Solid')) || D.creatures.find(c => c.mechanics && c.mechanics.shifts.length),
    };
    const users = id => D.creatures.filter(c => c.mechanics && (id === 'weak-point' ? c.mechanics.weakPoints : id === 'countdown' ? c.mechanics.countdowns : c.mechanics.shifts).length);
    const demo = (id, c) => {
      if (!c) return null;
      const M = c.mechanics;
      const key = `demo:${id}`;
      const w = id === 'weak-point' ? weakPoint(c, M.weakPoints.find(x => x.part === 'Egg sac') || M.weakPoints[0], key)
        : id === 'countdown' ? countdown(c, M.countdowns.find(x => x.effect === 'Hatch') || M.countdowns[0], key)
          : shift(c, M.shifts.find(x => x.modes.join('/') === 'Liquid/Solid') || M.shifts[0], key);
      w.append(el('p', { class: 'bs-fine' }, 'Example from ', el('a', { href: `#tab=vol2&page=${c.familyId}&mon=${c.id}` }, c.name), '. Try it: the trackers on stat blocks work the same way.'));
      return w;
    };
    return [
      el('div', { class: 'prose doc', html: tipify(md(before)) }),
      el('h2', { class: 'section-head bs-h' }, 'New in Volume II'),
      el('div', { class: 'prose', html: md(lead) }),
      ...Object.entries(D.v2.mechanics).map(([id, mm]) => el('section', { class: 'bs-rulecard', id: 'bs-a-' + id },
        el('h3', {}, mm.name),
        el('div', { class: 'prose', html: tipify(inline(cap(mm.text))) }),
        demo(id, examples[id]),
        el('p', { class: 'bs-fine' }, `Used by ${users(id).length} entries in Volume II.`))),
      el('h2', { class: 'section-head bs-h' }, 'Family structure'),
      el('div', { class: 'prose', html: md(after) }),
    ];
  }

  // the index: sortable, filterable, Volume II or both volumes
  const IDX = { family: '', named: false, both: false, lo: 0, hi: Infinity, sort: 'kr', dir: 1 };
  function indexTable() {
    const wrap = el('div', { class: 'bs-idx' });
    const rowsAll = () => {
      const r2 = D.v2.index.rows.map(r => { const c = D.byName.get(r.name.toLowerCase()); return { kr: r.kr, name: r.name, family: r.named ? 'Named' : r.family, named: r.named, base: r.builtFrom, c, vol: 2 }; });
      if (!IDX.both) return r2;
      const r1 = D.rules.index.map(r => { const c = D.byName.get(r.name.toLowerCase()); return { kr: r.kr, name: r.name, family: r.type, named: false, c, vol: 1 }; })
        .concat(D.creatures.filter(c => c.volume === 1 && c.kind === 'named').map(c => ({ kr: c.kr, name: c.name, family: 'Named', named: true, base: c.builtFrom, c, vol: 1 })));
      return r1.concat(r2);
    };
    const draw = () => {
      const all = rowsAll();
      const krs = [...new Set(all.map(r => r.kr))].sort((a, b) => a - b);
      const loI = Math.max(0, krs.findIndex(k => k >= IDX.lo)), hiI0 = krs.length - 1 - [...krs].reverse().findIndex(k => k <= IDX.hi);
      const hiI = Math.max(loI, Math.min(krs.length - 1, hiI0));
      const fams = [...new Set(all.map(r => r.family))].sort((a, b) => (a === 'Named') - (b === 'Named') || a.localeCompare(b));
      let rows = all.filter(r => (!IDX.family || r.family === IDX.family) && (!IDX.named || r.named) && r.kr >= krs[loI] && r.kr <= krs[hiI]);
      const key = IDX.sort;
      rows.sort((a, b) => (key === 'kr' ? a.kr - b.kr : key === 'vol' ? a.vol - b.vol : String(a[key]).localeCompare(String(b[key]))) * IDX.dir || a.kr - b.kr || a.name.localeCompare(b.name));
      const th = (k, label, cls) => el('th', { class: cls || null, 'aria-sort': IDX.sort === k ? (IDX.dir > 0 ? 'ascending' : 'descending') : 'none' },
        el('button', { type: 'button', class: 'bs-sort', onclick: () => { if (IDX.sort === k) IDX.dir = -IDX.dir; else { IDX.sort = k; IDX.dir = 1; } draw(); } }, label, el('span', { class: 'ar' }, IDX.sort === k ? (IDX.dir > 0 ? ' ▲' : ' ▼') : '')));
      const slider = (which) => el('input', { type: 'range', min: '0', max: String(krs.length - 1), step: '1', value: String(which === 'lo' ? loI : hiI), 'aria-label': which === 'lo' ? 'Lowest KR' : 'Highest KR',
        oninput: e => { const i = +e.target.value; if (which === 'lo') IDX.lo = krs[Math.min(i, hiI)]; else IDX.hi = krs[Math.max(i, loI)]; draw(); const s2 = wrap.querySelector(`input[aria-label="${e.target.getAttribute('aria-label')}"]`); if (s2) s2.focus(); } });
      wrap.replaceChildren(
        el('p', { class: 'd-note' }, D.v2.index.intro),
        el('div', { class: 'bs-idx-f' },
          el('div', { class: 'bs-seg seg', role: 'group', 'aria-label': 'Which volumes' },
            el('button', { type: 'button', class: !IDX.both ? 'on' : null, 'aria-pressed': String(!IDX.both), onclick: () => { IDX.both = false; IDX.family = ''; draw(); } }, 'Volume II'),
            el('button', { type: 'button', class: IDX.both ? 'on' : null, 'aria-pressed': String(IDX.both), onclick: () => { IDX.both = true; IDX.family = ''; draw(); } }, 'Both volumes')),
          (() => { const sl = el('select', { class: 'select', 'aria-label': IDX.both ? 'Family or type' : 'Family', onchange: e => { IDX.family = e.target.value; draw(); } });
            sl.append(el('option', { value: '' }, IDX.both ? 'All families and types' : 'All families'));
            for (const f of fams) sl.append(el('option', { value: f, selected: f === IDX.family }, f === 'Named' ? 'Named monsters' : f));
            return sl; })(),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: IDX.named, onchange: e => { IDX.named = e.target.checked; draw(); } }), 'Named only'),
          el('div', { class: 'bs-range' },
            el('span', { class: 'k' }, 'KR'), el('span', { class: 'v' }, `${krText(krs[loI])} to ${krText(krs[hiI])}`),
            el('div', { class: 'bs-dual', style: `--a:${loI / Math.max(1, krs.length - 1) * 100}%;--b:${hiI / Math.max(1, krs.length - 1) * 100}%` }, slider('lo'), slider('hi'))),
          (IDX.family || IDX.named || IDX.lo > 0 || IDX.hi < Infinity) ? el('button', { class: 'mini', onclick: () => { Object.assign(IDX, { family: '', named: false, lo: 0, hi: Infinity }); draw(); } }, 'Clear') : null),
        el('p', { class: 'result-meta' }, `${rows.length} of ${all.length}`),
        el('div', { class: 'prose' }, el('div', { class: 'table-wrap' }, el('table', { class: 'bs-index' },
          el('thead', {}, el('tr', {}, th('kr', 'KR', 'nar'), th('name', 'Name'), th('family', IDX.both ? 'Family / type' : 'Family'), IDX.both ? th('vol', 'Vol', 'nar') : null)),
          el('tbody', {}, ...rows.map(r => el('tr', { class: r.named ? 'named' : null },
            el('td', { class: 'nar', 'data-label': 'KR' }, krText(r.kr)),
            el('td', { 'data-label': 'Name' }, r.c ? el('a', { class: 'bs-elink', href: '#' + hashOf(r.c), onclick: e => { e.preventDefault(); openCreature(r.c); } }, r.name) : r.name, r.named && r.base ? el('span', { class: 'bs-base' }, ` · ${r.base}`) : null),
            el('td', { 'data-label': IDX.both ? 'Family / type' : 'Family' }, r.named ? el('span', { class: 'bs-ktag boss' }, 'Named') : r.family),
            IDX.both ? el('td', { class: 'nar', 'data-label': 'Volume' }, r.vol === 1 ? 'I' : 'II') : null)))))));
    };
    draw();
    return wrap;
  }
  const hashOf = c => { const L = linkFor(c); const p = new URLSearchParams(); p.set('tab', L.tab); if (L.rs) p.set('page', L.rs); p.set('mon', L.mon); return p.toString(); };

  /* ---------------- entry points used by app.js ---------------- */

  function renderList(box, meta) {
    if (gate(box, meta)) return;
    if (state.tab === 'beast') renderIndex(box, meta, 'beast');
    else if (state.tab === 'vol2') renderV2List(box, meta);
    else if (state.tab === 'named') renderIndex(box, meta, 'named');
    else if (state.tab === 'forge') renderForge(box, meta);
    else if (state.tab === 'encounter') renderEncounter(box, meta);
    else if (state.tab === 'brules') renderRulesList(box, meta);
  }

  // returns true when the detail pane is in use (two-pane layout)
  function renderDetail(pane) {
    const twoPane = ['beast', 'vol2', 'named', 'brules'].includes(state.tab);
    document.body.classList.remove('bs-card-open');
    if (!D || !admin() || !twoPane) {
      document.body.classList.remove('has-detail');
      pane.classList.remove('placeholder');
      pane.replaceChildren();
      document.body.classList.toggle('bs-wide', !!D && ['forge', 'encounter'].includes(state.tab));
      return false;
    }
    document.body.classList.remove('bs-wide');
    if (state.tab === 'vol2') {
      const p = D.v2 && !state.q.trim() ? v2Pages().find(x => x.id === state.rs) : null;
      document.body.classList.toggle('has-detail', !!p);
      pane.classList.toggle('placeholder', !p);
      if (p) renderV2Page(pane, p);
      else { pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a page'), 'Choose a family, the named monsters or the index on the left.')); document.title = 'Volume II · Bestiary'; }
      return true;
    }
    if (state.tab === 'brules') {
      const p = rulePages().find(x => x.id === state.rs);
      document.body.classList.toggle('has-detail', !!p);
      pane.classList.toggle('placeholder', !p);
      if (p) renderRulesPage(pane, p);
      else pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a page'), 'Choose a rules page on the left.'));
      return true;
    }
    const c = state.mon && D.byId.get(state.mon);
    const ok = c && (state.tab === 'named' ? c.kind === 'named' : c.kind !== 'named');
    document.body.classList.toggle('has-detail', !!ok);
    pane.classList.toggle('placeholder', !ok);
    if (!ok) {
      pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, state.tab === 'named' ? 'Pick a named monster' : 'Pick a creature'), 'Its stat card opens here.'));
      document.title = `${LABEL[state.tab]} · Player’s Handbook`;
      return true;
    }
    renderCreature(pane, c);
    document.body.classList.add('bs-card-open');
    return true;
  }

  function onEscape() {
    if (state.tab === 'vol2' && state.rs) { go({ rs: '', mon: '' }, true); return true; }
    if (state.mon) { go({ mon: '', tpl: '' }, true); return true; }
    if (state.rs) { go({ rs: '' }, true); return true; }
    return false;
  }

  // for tests and future tools (combat simulator, price tool)
  const api = { view: (id, tpl, forge) => D && view(D.byId.get(id), tpl, forge), data: () => D, encounter: () => D && encMaths(),
    printPreview: (id, tpl, forge) => { templateTips(); printRoot(view(D.byId.get(id), tpl, forge)); document.body.classList.add('printing'); } };
  window.__bestiary = api;

  // site search (the All tab): DM only, once the data is loaded
  function siteHits(q, limit) {
    if (!admin()) return null;
    if (!D) { if (!loading && !loadErr && sb()) load(); return null; }
    return searchHits(q, { limit: limit || 12 });
  }

  return { init, TABS, LABEL, readHash, writeHash, renderList, renderDetail, renderFilters, onEscape, isAdmin: admin, blankState: blank, siteHits, hitCard };
};
