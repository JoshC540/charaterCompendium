/* Bestiary (DM only): monster index, stat cards with Alpha/Boss/Minion templates, named monsters,
   the dragon and elemental builder, the encounter builder and the monster rules.
   The data lives in Supabase (table "bestiary", readable only by admins; loaded by bestiary.sql in the bestiary-data folder, which stays out of this repo),
   so none of it is in the public site files. */
window.HandbookBestiary = function (H) {
  'use strict';
  const { el, md, esc, norm, state, go, render, Notes, $ } = H;
  const statusMd = H.statusMd || (() => '');

  const TABS = ['session', 'beast', 'vol2', 'vol3', 'named', 'forge', 'encounter', 'fight', 'lab', 'brules'];
  const LABEL = { beast: 'Volume I', vol2: 'Volume II', vol3: 'Volume III', named: 'Named monsters', forge: 'Dragons & elementals', encounter: 'Encounters', fight: 'Combat tracker', lab: 'Balance lab', brules: 'Monster rules', session: 'Session' };
  const TIERS = ['Juvenile', 'Adult', 'Elder', 'Ancient', 'Primordial'];
  const STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const COMBAT = ['melee', 'ranged', 'dodge', 'disengage', 'casting'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  let D = null, loading = false, loadErr = '';
  let flash = '';           // one-line confirmation under the card toolbar
  let encQ = '';            // the encounter builder's own search box
  const MECH = new Map();   // live trackers: weak point HP, countdowns, shift modes (this visit only)
  const PAGE_TPL = new Map();   // template toggles per stat block on Volume II and III pages
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
      // status effects live in content/statuses.json, shared with the players' Core rules page
      const stj = (H.statuses && H.statuses()) || await fetch('content/statuses.json', { cache: 'no-cache' }).then(x => x.ok ? x.json() : null).catch(() => null);
      if (stj) m.statuses = stj;
      for (const st of (m.statuses && m.statuses.statuses) || []) if (st.effect == null) st.effect = st.perStack;   // an older table
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
    d.v3 = m['bestiary-3'] || null;
    if (d.v3) {
      d.v3.fac = new Map(d.v3.factions.map(f => [f.id, f]));
      d.v3.party = new Map(d.v3.rivals.parties.map(p => [p.id, p]));
      d.v3.pow = new Map(d.v3.powers.map(p => [p.id, p]));
      d.creatures = d.creatures.concat(d.v3.creatures);
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
      burn: ['burn', 'burns'], bleed: ['bleed'], poisoned: ['poison', 'poisoned', 'poisonous'], disease: ['disease'], madness: ['madness'], wither: ['wither'],
      corrode: ['corrode'], freeze: ['freeze', 'frozen solid'], stun: ['stun', 'stunned', 'stuns'], paralysis: ['paralysis', 'paralysed'], sleep: ['asleep', 'sleep(?= )(?<=\\+\\d+d2 sleep)'],
      blinded: ['blinded', 'dazzled', 'deafened', 'disorientated', 'disorientate', 'disorientates'], charm: ['charmed', 'charms', 'charm'], fear: ['frightened'], confusion: ['confused', 'confusion'],
      staggered: ['stagger', 'staggered', 'staggers'], prone: ['prone'], knockback: ['knockback', 'knocked back', 'knocks back'], restrained: ['restrained', 'grabbed', 'entangled', 'crushed'],
      exhaustion: ['exhaustion'], toxic: [],
    };
    for (const s of m.statuses.statuses) {
      const forms = STATUS_FORMS[s.id] || [s.id];
      const lv = s.levels ? ' ' + s.levels.map((t, i) => `**${i + 1}:** ${t}.`).join(' ') : '';
      if (forms.length) add(new RegExp(`\\b(${forms.join('|')})\\b`, 'gi'), s.name, `${s.effect}.${lv} **Max:** ${s.max}. **Ends:** ${s.ends}.`);
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
    if (d.v3) {
      // Volume III's four rules link to its intro; its shared traits get tooltips in its own words
      for (const [id, r] of Object.entries(d.v3.rules)) if (['command', 'loadout'].includes(id)) tips.push({ re: new RegExp(`\\b(${r.name})\\b`, 'g'), title: r.name, text: r.text, link: `#tab=vol3&page=intro&mon=${id}` });
      const dom = d.v3.pow.get('domain'), vd = d.v3.pow.get('void');
      const divine = dom && dom.lead.split('\n').find(l => l.includes('**Divine**'));
      if (divine) tips.push({ re: /$^/, em: true, title: 'Divine', text: divine });
      for (const t of (vd ? vd.callout : [])) tips.push({ re: /$^/, em: true, title: t.name, text: t.text });
      const mt = d.v3.templates.rows.find(r => r.name === 'Mounted');
      if (mt) tips.push({ re: /$^/, em: true, title: 'Mounted', text: mt.text });
      for (const f of d.v3.factions) if (f.trait) tips.push({ re: /$^/, em: true, title: f.trait.name, text: f.trait.text });
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
    if (t === 'alpha') return !/humanoid/i.test(c.type || '') && c.kind !== 'rival' && c.tier !== 'Primordial';
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
          loadErr === 'missing' ? 'Run bestiary.sql (in the bestiary-data download) in the Supabase SQL editor, then reload.' : loadErr,
          el('div', {}, el('button', { class: 'mini', onclick: () => { loadErr = ''; load(); render(); } }, 'Try again')))
        : el('div', { class: 'empty' }, 'Opening the bestiary…'));
      return true;
    }
    return false;
  }

  const seg = (opts, cur, pick, label) => el('div', { class: 'seg bs-seg', role: 'group', 'aria-label': label },
    ...opts.map(([v, t, dis, title]) => el('button', { type: 'button', class: cur === v ? 'on' : null, 'aria-pressed': String(cur === v), disabled: !!dis, title: title || null, onclick: () => pick(v) }, t)));

  /* ---------------- KR range slider ----------------
     Two thumbs over the KR values that actually exist, so every step lands on a real KR.
     It never redraws itself while you drag: onInput gets each move, onChange the final values. */
  function krSlider(values, lo, hi, { onInput, onChange, label } = {}) {
    const n = values.length - 1;
    const idx = (v, up) => { if (v == null) return up ? n : 0; let i = values.findIndex(x => x >= v); if (i < 0) i = n; if (up && values[i] > v && i > 0) i--; return i; };
    let a = idx(lo, false), b = Math.max(a, idx(hi, true));
    const out = el('span', { class: 'v', 'aria-live': 'polite' });
    const track = el('div', { class: 'bs-dual' });
    const mk = which => el('input', { type: 'range', min: '0', max: String(n), step: '1', value: String(which === 'lo' ? a : b),
      'aria-label': which === 'lo' ? 'Lowest KR' : 'Highest KR', 'aria-valuetext': `KR ${krText(values[which === 'lo' ? a : b])}` });
    const inLo = mk('lo'), inHi = mk('hi');
    const paint = () => {
      out.textContent = a === 0 && b === n ? `Any (${krText(values[0])} to ${krText(values[n])})` : `${krText(values[a])} to ${krText(values[b])}`;
      track.style.setProperty('--a', `${n ? a / n * 100 : 0}%`);
      track.style.setProperty('--b', `${n ? b / n * 100 : 100}%`);
      inLo.setAttribute('aria-valuetext', `KR ${krText(values[a])}`); inHi.setAttribute('aria-valuetext', `KR ${krText(values[b])}`);
      inLo.classList.toggle('top', a >= n - 1 || a === b);   // so the low thumb can still be grabbed at the top end
    };
    const vals = () => [values[a], values[b], a === 0 && b === n];
    inLo.addEventListener('input', () => { a = Math.min(+inLo.value, b); inLo.value = a; paint(); if (onInput) onInput(...vals()); });
    inHi.addEventListener('input', () => { b = Math.max(+inHi.value, a); inHi.value = b; paint(); if (onInput) onInput(...vals()); });
    const done = () => { if (onChange) onChange(...vals()); };
    inLo.addEventListener('change', done); inHi.addEventListener('change', done);
    track.append(inLo, inHi);
    paint();
    return el('div', { class: 'bs-range' }, el('span', { class: 'k' }, label || 'KR'), track, out);
  }

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
    const sub = c.kind === 'named' ? `Built from ${c.builtFrom}${c.templates.length ? ', ' + c.templates.join(' + ') : ''}` : c.volume === 2 ? c.family : c.volume === 3 ? (c.kind === 'rival' ? `${c.className} · ${c.party}` : c.faction || c.section) : `${c.type} · ${c.role}`;
    const open = opts.open || (() => { go({ mon: c.id, tpl: '' }, true); const p = $('#detail'); if (p) p.scrollTop = 0; });
    return el('button', { class: 'card bs-mon' + (sel ? ' sel' : ''), 'data-id': c.id, onclick: open },
      el('div', { class: 'card-top' },
        el('span', { class: 'card-name' }, c.name),
        el('span', { class: 'card-sub' }, sub),
        el('span', { class: 'bs-kr' }, 'KR ' + krText(c.kr))),
      opts.snip ? el('div', { class: 'card-snip', html: opts.snip }) : el('div', { class: 'card-snip' }, c.kind === 'named' && c.bestAs ? c.bestAs : c.description));
  }

  // where a creature's stat block lives
  const v3PageOf = c => c.kind === 'named' ? 'named' : c.kind === 'rival' ? c.partyId : c.pemmaroth ? 'pemmaroth' : c.factionId || c.sectionId;
  function linkFor(c, tpl) {
    if (c.volume === 2) return { tab: 'vol2', rs: c.familyId, mon: c.id, tpl: '', q: '' };
    if (c.volume === 3) return { tab: 'vol3', rs: v3PageOf(c), mon: c.id, tpl: '', q: '' };
    return { tab: c.kind === 'named' ? 'named' : 'beast', mon: c.id, tpl: (tpl || []).join(','), q: '' };
  }
  function openCreature(c, tpl) {
    if (c.volume >= 2 && tpl && tpl.length) PAGE_TPL.set(c.id, tpl);
    go(linkFor(c, tpl), true);
  }

  function renderFilters(f) {
    if (!D || state.tab !== 'beast') { f.replaceChildren(); return; }
    const sel = (opts, value, on, label) => {
      const s = el('select', { class: 'select', 'aria-label': label, onchange: e => on(e.target.value) });
      for (const [v, t] of opts) s.append(el('option', { value: v, selected: v === value }, t));
      return s;
    };
    const krs = [...new Set(D.creatures.filter(c => c.volume === 1 && c.kind !== 'named').map(c => c.kr))].sort((a, b) => a - b);
    const any = state.bType || state.bRole || state.bMin || state.bMax || state.bSort;
    f.replaceChildren(
      sel([['', 'All types'], ...D.types.map(t => [t, t])], state.bType, v => go({ bType: v }, false), 'Type'),
      sel([['', 'All roles'], ...D.roles.map(t => [t, t])], state.bRole, v => go({ bRole: v }, false), 'Role'),
      krSlider(krs, parseKr(state.bMin), parseKr(state.bMax), { onChange: (lo, hi, all) => go(all ? { bMin: '', bMax: '' } : { bMin: lo === krs[0] ? '' : String(lo), bMax: hi === krs[krs.length - 1] ? '' : String(hi) }, false) }),
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
    command: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 2v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 3h11l-3 4 3 4H4z" fill="currentColor"/></svg>',
  };
  const mechLink = (id, label) => el('a', { class: 'bs-mk', href: `#tab=vol2&page=intro&mon=${id}`, title: 'How it works' }, label);

  // the combat tracker saves its trackers with the fight
  function mechChanged(key) { if (key.startsWith('fight:')) fightSave(); }

  function weakPoint(c, w, key) {
    const n0 = w.count || 1;
    const box = el('div', { class: 'bs-wp-trk' });
    const draw = () => {
      let st = MECH.get(key);
      if (!st) { st = Array(n0).fill(w.hp); MECH.set(key, st); }
      box.replaceChildren(...st.map((hp, i) => {
        const broken = hp <= 0;
        const inp = el('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: 'dmg', 'aria-label': `Damage to ${w.part}${st.length > 1 ? ' ' + (i + 1) : ''}` });
        const hit = () => { const d = parseInt(inp.value, 10); if (d > 0) { st[i] = Math.max(0, st[i] - d); draw(); mechChanged(key); } };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); hit(); } });
        return el('div', { class: 'bs-wp-one' + (broken ? ' broken' : '') },
          el('span', { class: 'bs-wp-hp' }, el('b', {}, String(hp)), ` / ${w.hp} HP`),
          el('span', { class: 'bs-wp-bar' }, el('span', { style: `width:${Math.max(0, hp) / w.hp * 100}%` })),
          broken ? el('span', { class: 'bs-wp-broken' }, 'Broken') : el('span', { class: 'bs-wp-in' }, inp, el('button', { type: 'button', class: 'btn small', onclick: hit }, 'Hit')));
      }),
      el('div', { class: 'bs-wp-foot' },
        w.each && !w.count ? el('button', { type: 'button', class: 'mini', onclick: () => { st.push(w.hp); draw(); mechChanged(key); } }, '+ Track another') : null,
        st.some((h, i) => h !== w.hp) || st.length !== n0 ? el('button', { type: 'button', class: 'mini', onclick: () => { MECH.delete(key); draw(); mechChanged(key); } }, 'Reset') : null));
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
          el('button', { type: 'button', class: 'btn small', disabled: n === 0, onclick: () => { MECH.set(key, Math.max(0, n - 1)); draw(); mechChanged(key); } }, 'Tick'),
          n !== cd.count ? el('button', { type: 'button', class: 'mini', onclick: () => { MECH.delete(key); draw(); mechChanged(key); } }, 'Reset') : null));
    };
    draw();
    return el('div', { class: 'bs-mech cd' }, el('div', { class: 'bs-mech-h' }, mechLink('countdown', 'Countdown')), wrap);
  }

  function shift(c, sh, key) {
    const wrap = el('div', { class: 'bs-sh-modes', role: sh.modes.length > 1 ? 'group' : null, 'aria-label': 'Current mode' });
    const draw = () => {
      const cur = MECH.has(key) ? MECH.get(key) : 0;
      wrap.replaceChildren(...sh.modes.map((m, i) => sh.modes.length > 1
        ? el('button', { type: 'button', class: i === cur ? 'on' : null, 'aria-pressed': String(i === cur), onclick: () => { MECH.set(key, i); draw(); mechChanged(key); } }, m)
        : el('span', { class: 'one' }, m)),
      sh.modes.length > 1 ? el('span', { class: 'bs-sh-note' }, 'Tap the mode it’s in now') : null);
    };
    draw();
    return el('div', { class: 'bs-mech sh' }, el('div', { class: 'bs-mech-h' }, mechLink('shift', 'Shift')), wrap);
  }

  function mechTrait(c, t, i, inner, prefix) {
    const M = c.mechanics;
    if (!M) return null;
    const key = k => `${prefix || c.id}:${i}:${k}`;
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
    const v2named = named && c.volume >= 2;
    const v3 = c.volume === 3;
    // tags beside the KR seal
    const tags = [];
    const tplWord = named ? c.templates.join(' ') : v.tpl.includes('boss') ? (v.tpl.includes('alpha') ? 'Alpha Boss' : 'Boss') : '';
    if (tplWord) tags.push(tplWord);
    if (!named && ['Solo', 'Set piece'].includes(c.role) && !v.tpl.includes('boss')) tags.push(c.role);
    if (named && c.volume === 1 && c.role === 'Solo') tags.push('Solo');
    if (/\bConstruct\b/.test(c.typeLine)) tags.push('Construct');
    if (v3 && c.defiant && !v.tpl.includes('boss')) tags.push(`Defiant ${c.defiant}`);
    // type line: Volume II named monsters name their base creature, linked to its stat block
    let typeLine;
    if (v2named) {
      const base = D.byId.get(c.builtFromId);
      typeLine = el('p', { class: 'bs-type' }, `${c.templates.join(' ')} `,
        base ? el('a', { class: 'bs-baselink', href: '#' + new URLSearchParams(Object.entries(linkFor(base)).filter(([, x]) => x)).toString().replace(/\brs=/, 'page='), onclick: e => { e.preventDefault(); openCreature(base); } }, c.builtFrom) : c.builtFrom);
    } else if (c.kind === 'rival') {
      const p = D.v3 && D.v3.party.get(c.partyId);
      typeLine = el('p', { class: 'bs-type' }, `${c.className}, level ${c.level} · `,
        p ? el('a', { class: 'bs-baselink', href: `#tab=vol3&page=${p.id}`, onclick: e => { e.preventDefault(); go({ tab: 'vol3', rs: p.id, mon: '' }, true); } }, p.title) : c.party);
    } else {
      const tl = c.tags.length ? ', ' + c.tags.join(', ') : '';
      typeLine = el('p', { class: 'bs-type', html: tipify(esc(`${c.type}${tl}`) + (v.role ? ' · ' + esc(v.role) : '')) });
    }
    const tagRow = v3 && !opts.print ? v3Tags(c) : null;
    const head = el('header', { class: 'bs-head' },
      el('div', { class: 'bs-titles' }, el(H, { class: 'bs-name' }, v.name), typeLine, tagRow),
      el('div', { class: 'bs-krbox' },
        el('div', { class: 'bs-krseal' + (v.changed.kr ? ' chg' : ''), title: v.krWork.join('\n') || null }, el('span', { class: 'k' }, 'KR'), el('span', { class: 'v' }, krText(v.kr))),
        tags.length ? el('div', { class: 'bs-tags' }, ...tags.map(t => el('span', { class: 'bs-ktag' + (/Boss/.test(t) ? ' boss' : '') }, t))) : null));
    const desc = c.description ? el('p', { class: 'bs-desc', html: inline(c.description) }) : null;
    const work = v.krWork.length ? el('p', { class: 'bs-work' }, v.krWork.join(' · ')) : null;
    const num = (val, txt) => val != null ? String(val) : (txt || '—');
    const core = el('div', { class: 'bs-core' },
      statBox('HP', c.hpText && !v.changed.hp ? c.hpText : v.hp.toLocaleString('en-GB'), v.changed.hp, false, c.hpNote),
      statBox('Defence', num(v.defence, c.defenceText), v.changed.defence, true, c.defenceNote),
      statBox('Min hit', num(v.minHit, c.minHitText), v.changed.minHit, true, c.minHitNote),
      el('div', { class: 'bs-num speed' + (v.changed.speed ? ' chg' : '') }, el('span', { class: 'k' }, 'Speed'), el('span', { class: 'v', html: v.speed != null ? inline(v.speed) : '—' })));
    const stats = v.stats
      ? el('div', { class: 'bs-stats' + (v.changed.stats ? ' chg' : ''), 'aria-label': 'Stats (roll under)' },
        ...STATS.map(k => el('div', { class: 'bs-st' }, el('span', { class: 'k' }, k.toUpperCase()), el('span', { class: 'v' }, v.stats[k] == null ? '–' : String(v.stats[k])))))
      : c.statsText ? el('p', { class: 'bs-stats-txt' }, el('span', { class: 'k' }, 'Stats'), ' ', c.statsText) : null;
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
        const w = mechTrait(c, t, i, body, opts.mechKey);
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
    // Volume III: a leader's Command line comes first and stands out; Loadout is a row of options
    const command = c.command ? el('section', { class: 'bs-sec bs-command' },
      el('h2', {}, el('span', { class: 'ic', html: ICON.command }), opts.print ? 'Command' : el('a', { href: '#tab=vol3&page=intro&mon=command', title: 'How Command works' }, 'Command')),
      ...c.command.map(o => traitLine({ html: o.text }))) : null;
    const loadout = c.loadout ? el('section', { class: 'bs-sec bs-loadout' },
      el('h2', {}, opts.print ? 'Loadout' : el('a', { href: '#tab=vol3&page=intro&mon=loadout', title: 'How Loadout works' }, 'Loadout')),
      el('div', { class: 'bs3-opts' }, c.loadout.lead ? el('span', { class: 'lead', html: rich(c.loadout.lead) }) : null,
        ...c.loadout.options.map(o => {
          // an option that names a creature (a Volume II beast, say) links to its stat block
          const nm = (o.match(/\(([^)]+)\)$/) || [])[1] || o;
          const t = !opts.print && D.byName.get(nm.toLowerCase());
          return t ? el('a', { class: 'bs3-opt', href: '#' + hashOf(t), onclick: e => { e.preventDefault(); openCreature(t); }, html: inline(o) }) : el('span', { class: 'bs3-opt', html: rich(o) });
        }))) : null;
    const harvest = c.harvest ? sec('Harvest', el('p', { class: 'bs-line', html: rich(c.harvest) }), el('p', { class: 'bs-fine' }, harvestNote(v.kr, c.name))) : null;
    // both volumes: Attacks, Traits, (named: Phases, Lair, Hook, Loot), Harvest, then Role / Wants and Tactics with Tell and Exploit
    const body = [command, sec('Attacks', v.attacks.map(line)), v.traits.length || extra.length ? sec('Traits', v.traits.map((t, i) => traitLine(t, i)), extra) : null, loadout, notes, flavourSec, ...namedSecs, harvest, play];
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
      ? el('p', { class: 'bs-built' }, 'Built from ', el('button', { class: 'linkbtn', onclick: () => c.volume >= 2 ? openCreature(D.byId.get(c.builtFromId)) : go(c.flavour ? { tab: 'forge', fam: 'dragon', ftier: c.builtFromId.split('-')[0], fl: slugF(c.flavour), disp: '', tpl: c.templates.map(x => x.toLowerCase()).join(','), mon: '' } : { tab: 'beast', mon: c.builtFromId, tpl: c.templates.map(x => x.toLowerCase()).join(',') }, true) }, c.builtFrom), c.templates.length ? ` with ${c.templates.join(' and ')} applied.` : '.')
      : el('div', { class: 'bs-tpls', role: 'group', 'aria-label': 'Templates' }, el('span', { class: 'k' }, 'Template'), ...['alpha', 'boss', 'minion'].flatMap(t => [toggle(t), tipBtn(t)]));
    return el('div', { class: 'bs-tools' },
      tplRow,
      el('div', { class: 'bs-acts' },
        el('button', { class: 'btn small', onclick: () => { addToEncounter(c, v, forge); } }, 'Add to encounter'),
        el('button', { class: 'btn small', onclick: () => printCard(v) }, 'Print'),
        el('button', { class: 'btn small', title: 'Copy the stat block as plain text, for Discord or a virtual tabletop', onclick: e => copyText(v, e.currentTarget) }, 'Copy as text'),
        c.volume >= 2 ? el('button', { class: 'btn small', title: 'Copy a link straight to this stat block', onclick: e => copyLink(c, e.currentTarget) }, 'Copy link') : null),
      flash ? el('p', { class: 'notes-msg ok bs-flash', role: 'status' }, flash, ' ', el('button', { class: 'mini', onclick: () => { flash = ''; go({ tab: 'encounter', mon: '' }, true); } }, 'Open the encounter')) : null);
  }
  // the printable card, read back as plain text
  function cardText(v) {
    const box = el('div', { class: 'bs-printpage', style: 'position:fixed;left:-10000px;top:0;width:720px', 'aria-hidden': 'true' }, card(v, { print: true }));
    document.body.append(box);
    box.querySelectorAll('input, select, textarea, .btn, .mini, .bs-step, .bs-phbar, .bs-phlist .n').forEach(n => n.remove());
    // number grids become one line each: "HP 10 · Defence 0 · Min hit 0 · Speed 50 ft"
    for (const g of box.querySelectorAll('.bs-core, .bs-stats, .bs-combat')) {
      const parts = [...g.children].map(x => { const k = x.querySelector('.k'), v = x.querySelector('.v'); return k && v ? `${k.textContent.trim()} ${v.textContent.trim()}` : x.textContent.trim(); }).filter(Boolean);
      g.replaceWith(el('p', {}, parts.join(' · ')));
    }
    let t = box.innerText;
    box.remove();
    const cap = w => w.charAt(0) + w.slice(1).toLowerCase();
    return t.replace(/\bKR\s*\n\s*/g, 'KR ')
      .replace(/^(ROLE|WANTS|TELL|EXPLOIT|TACTICS)\s*\n?\s*/gm, (m, w) => `${cap(w)}: `)
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function copyText(v, btn) {
    const t = cardText(v);
    const ok = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy as text'; }, 1500); };
    try { navigator.clipboard.writeText(t).then(ok, () => window.prompt('Copy this stat block', t)); } catch (e) { window.prompt('Copy this stat block', t); }
  }
  function copyLink(c, btn) {
    const L = linkFor(c);
    const url = `${location.origin}${location.pathname}#tab=${L.tab}&page=${L.rs}&mon=${L.mon}`;
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

  // KR of any list of rows: { ref, n, tpl } (the same rules as the builder)
  function krOfRows(rows) {
    const T = D.templates.group;
    let sum = 0, size = 0;
    for (const r of rows) { const v = rowView(r); if (!v) continue; sum += v.kr * r.n; if (!v.tpl.includes('minion')) size += r.n; }
    const band = T.bands.find(b => size >= b.min && (b.max == null || size <= b.max));
    const mult = band ? band.multiplier : 1;
    return { sum, size, mult, exact: sum * mult };
  }
  const roundKr = x => x >= 1 ? Math.round(x) : Math.round(x * 100) / 100;
  const groupOf = c => c.volume === 3 ? (c.kind === 'rival' ? c.party : c.faction || c.section) : c.volume === 2 ? c.family : c.type;
  const volOf = c => `Vol ${['', 'I', 'II', 'III'][c.volume]}`;
  const baseGroup = c => c.kind === 'named' && c.volume >= 2 && D.byId.get(c.builtFromId) ? groupOf(D.byId.get(c.builtFromId)) : groupOf(c);

  /* ---- encounter suggester: ready-made groups for the party's budget ----
     Bands follow the builder's verdicts: easy = party 1.5×–2× the KR, fair = around 1× (0.85×–1.2×), deadly = 0.5×–0.7×.
     Creatures come from one family (Volume II) or type (Volume I), so each group hangs together. */
  const SUG = { vol: 'both', fam: '', named: false, seed: { easy: 1, fair: 1, deadly: 1 } };
  const WIN = { easy: [1 / 2, 1 / 1.5], fair: [1 / 1.2, 1 / 0.85], deadly: [1 / 0.7, 1 / 0.5] };
  // if nothing fits the sweet spot (very small parties, narrow families), anything with the right verdict will do
  const WIDE = { easy: [1 / 4, 1 / 1.5], fair: [1 / 1.4999, 1 / 0.7501], deadly: [1 / 0.7499, 1 / 0.34] };
  function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  function sugPool() {
    return D.creatures.filter(c => c.kind !== 'tier' && (c.kind !== 'named' || SUG.named)
      && (SUG.vol === 'both' || c.volume === +SUG.vol)
      && (!SUG.fam || baseGroup(c) === SUG.fam));
  }
  function suggest(P, level, wide) {
    const pool = sugPool();
    const groups = new Map();
    for (const c of pool) { const g = baseGroup(c); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const [lo, hi] = [P * (wide ? WIDE : WIN)[level][0], P * (wide ? WIDE : WIN)[level][1]];
    const ok = x => x >= lo && x <= hi;
    const R = rng(SUG.seed[level] * 7919 + Math.round(P * 13) + level.length * 101);
    const pick = arr => arr[Math.floor(R() * arr.length)];
    const found = [];
    const seen = new Set();
    const keep = (rows, shape, g) => {
      const k = krOfRows(rows);
      if (!ok(k.exact)) return;
      const id = rows.map(r => `${r.n}${r.ref}${r.tpl.join('')}`).sort().join('|');
      if (seen.has(id)) return;
      seen.add(id); found.push({ rows, shape, group: g, ...k });
    };
    const gkeys = [...groups.keys()];
    if (!gkeys.length) return null;
    for (let t = 0; t < 900 && found.length < 24; t++) {
      const g = pick(gkeys), cs = groups.get(g), plain = cs.filter(c => c.kind !== 'named');
      const shape = pick(['solo', 'solo', 'pack', 'leader', 'boss', 'minions']);
      if (shape === 'solo') { const c = pick(cs); keep([{ ref: c.id, n: 1, tpl: [] }], c.kind === 'named' ? 'Named monster' : 'One creature', g); }
      else if (!plain.length) continue;
      else if (shape === 'pack') { const c = pick(plain), n = 2 + Math.floor(R() * 5); keep([{ ref: c.id, n, tpl: [] }], 'A pack', g); }
      else if (shape === 'leader') {
        const a = pick(plain), lesser = plain.filter(x => x.kr < a.kr);
        if (!lesser.length) continue;
        const b = pick(lesser), n = 2 + Math.floor(R() * 4);
        keep([{ ref: a.id, n: 1, tpl: [] }, { ref: b.id, n, tpl: [] }], 'A leader and followers', g);
      } else if (shape === 'boss') { const c = pick(plain); if (allowed(c, 'boss')) keep([{ ref: c.id, n: 1, tpl: ['boss'] }], 'A boss', g); }
      else {
        const a = pick(cs), small = plain.filter(x => x.id !== a.id && allowed(x, 'minion'));
        if (!small.length) continue;
        const b = pick(small), m = 3 + Math.floor(R() * 6);
        keep([{ ref: a.id, n: 1, tpl: a.kind === 'named' ? [] : ['boss'] }, { ref: b.id, n: m, tpl: ['minion'] }], a.kind === 'named' ? 'A named monster and minions' : 'A boss and minions', g);
      }
    }
    if (!found.length) return wide ? null : suggest(P, level, true);
    return found[Math.floor(R() * found.length)];
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

  // which Volume II families appear in each Pemmaroth region's encounter table (by terrain)
  const REGION_FAMILIES = {
    'pherontia, green north': ['Beasts of the Wilds', 'Sky and Storm', 'The Frostlands', 'Lightborn', 'Dreamborn', 'Groves and Thickets'],
    'pherontia, dark south': ['Rot and Mould', 'The Restless Dead', 'Blood and Bone', 'Shadow-touched', 'Swarms and Hives', 'Tricksters and Shapeshifters'],
    'the worm desert': ['Dunes and Wastes', 'Wyrms and Drakes', 'Timeworn'],
    'coasts and open sea': ['Rivers, Reefs and Mires', 'Sky and Storm', 'Giants and Titanfolk'],
    'caves, ruins and the deep': ['Beasts of the Deep Places', 'Clockwork and Arcane Constructs', 'Crystalline', 'Living Metal', 'Planar Wanderers', 'Timeworn'],
  };
  const TBL = { vol: 'both', open: new Set() };

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
    const hits = q ? D.creatures.filter(c => norm(c.name).includes(q) || norm(groupOf(c) || '').startsWith(q)).sort((a, b) => (norm(b.name).includes(q) - norm(a.name).includes(q)) || (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || a.kr - b.kr).slice(0, 10) : [];
    const search = el('div', { class: 'bs-enc-add' },
      el('input', { type: 'search', class: 'bs-encq', placeholder: 'Add a creature: type a name…', value: encQ, 'aria-label': 'Find a creature to add',
        oninput: e => { encQ = e.target.value; render(); const i = $('.bs-encq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } },
        onkeydown: e => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0]); } } }),
      hits.length ? el('div', { class: 'bs-hits' }, ...hits.map(c => el('button', { type: 'button', class: 'bs-hit', onclick: () => add(c) },
        el('span', { class: 'nm' }, c.name), el('span', { class: 'bs-hitg' }, `${volOf(c)} · ${c.kind === 'named' ? 'Named' : c.kind === 'tier' ? 'Dragons & elementals' : groupOf(c)}`), el('span', { class: 'bs-kr' }, 'KR ' + krText(c.kr))))) : null);
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
          el('span', { class: 'bs-each' }, `KR ${krText(v.kr)} each · ${volOf(c)}, ${c.kind === 'named' ? 'named' : c.kind === 'tier' ? 'dragons & elementals' : groupOf(c)}`)),
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
    // suggestions
    const groupsAll = [...new Set(D.creatures.filter(c => c.kind === 'creature' || c.kind === 'rival').map(c => `${c.volume}|${groupOf(c)}`))];
    const famSel = el('select', { class: 'select', 'aria-label': 'Family or type', onchange: e => { SUG.fam = e.target.value; if (SUG.fam) SUG.vol = 'both'; save(); } });
    famSel.append(el('option', { value: '' }, 'Any family or type'));
    for (const [vol, label] of [['3', 'Volume III factions, parties and sections'], ['2', 'Volume II families'], ['1', 'Volume I types']]) {
      if (SUG.vol !== 'both' && SUG.vol !== vol) continue;
      const og = el('optgroup', { label });
      for (const g of groupsAll.filter(x => x.startsWith(vol + '|')).map(x => x.slice(2)).sort()) og.append(el('option', { value: g, selected: g === SUG.fam }, g));
      famSel.append(og);
    }
    const sugCard = level => {
      const res = M.party > 0 ? suggest(M.party, level) : null;
      const [lab] = VERDICT[level];
      const reroll = el('button', { type: 'button', class: 'mini', onclick: () => { SUG.seed[level] += 1; render(); } }, 'Another');
      if (!res) return el('div', { class: `bs-sug ${level}` }, el('div', { class: 'bs-sug-h' }, el('span', { class: 'lvl' }, lab), reroll),
        el('p', { class: 'd-note' }, M.party > 0 ? (() => {
          const ks = sugPool().map(c => c.kr);
          return ks.length ? `Nothing in this pool makes a ${lab.toLowerCase()} fight for a party total of ${krText(M.party)}: ${SUG.fam || 'it'} runs from KR ${krText(Math.min(...ks))} to ${krText(Math.max(...ks))}. Try another family, or any.` : 'Nothing matches these filters.';
        })() : 'Add the party’s levels first.'));
      const lines = res.rows.map(r => { const v = rowView(r); return el('li', {}, el('span', { class: 'n' }, `${r.n} ×`), ' ', el('button', { class: 'bs-elink', onclick: () => openCreature(v.base, r.tpl) }, v.name), el('span', { class: 'bs-each' }, ` KR ${krText(v.kr)}`)); });
      const use = replace => { ENC.rows = replace ? [] : ENC.rows; for (const r of res.rows) { const same = ENC.rows.find(x => x.ref === r.ref && (x.tpl || []).join() === r.tpl.join() && !x.fl); if (same) same.n += r.n; else ENC.rows.push({ ...r, tpl: [...r.tpl], fl: '', disp: '' }); } save(); };
      return el('div', { class: `bs-sug ${level}` },
        el('div', { class: 'bs-sug-h' }, el('span', { class: 'lvl' }, lab), el('span', { class: 'kr' }, `KR ${krText(roundKr(res.exact))}`), reroll),
        el('p', { class: 'bs-sug-g' }, `${res.shape} · ${res.group}`),
        el('ul', { class: 'bs-sug-l' }, ...lines),
        el('p', { class: 'bs-fine' }, res.mult > 1 ? `${krText(Math.round(res.sum * 100) / 100)} × ${res.mult} for ${res.size} creatures` : res.rows.some(r => r.tpl.includes('minion')) ? 'Minions don’t count towards group size.' : 'No group multiplier.'),
        el('div', { class: 'bs-sug-btns' }, el('button', { type: 'button', class: 'btn small primary', onclick: () => use(true) }, 'Use this'), el('button', { type: 'button', class: 'btn small', onclick: () => use(false) }, 'Add to the encounter')));
    };
    const volSeg = el('div', { class: 'bs-seg seg', role: 'group', 'aria-label': 'Which volumes' },
      ...[['both', 'All'], ['1', 'Vol I'], ['2', 'Vol II'], ['3', 'Vol III']].map(([k, t]) => el('button', { type: 'button', class: SUG.vol === k ? 'on' : null, 'aria-pressed': String(SUG.vol === k), onclick: () => { SUG.vol = k; if (SUG.fam && !groupsAll.includes(`${k}|${SUG.fam}`) && k !== 'both') SUG.fam = ''; render(); } }, t)));
    const suggestions = el('section', { class: 'bs-enc-sec bs-enc-sug' },
      el('h2', { class: 'section-head' }, 'Suggested encounters'),
      el('p', { class: 'd-note' }, `Ready-made groups for a party total of ${krText(M.party)}, using the same maths as above. Pick a family to set the scene, or leave it open.`),
      el('div', { class: 'bs-sug-f' }, volSeg, famSel,
        el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: SUG.named, onchange: e => { SUG.named = e.target.checked; render(); } }), 'Named monsters'),
        el('button', { type: 'button', class: 'mini', onclick: () => { for (const k in SUG.seed) SUG.seed[k] += 1; render(); } }, 'Shuffle all')),
      el('div', { class: 'bs-sugs' }, sugCard('easy'), sugCard('fair'), sugCard('deadly')));
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
      M.lines.length ? el('div', { class: 'bs-run' },
        FIGHT && FIGHT.list.length && !replaceAsk
          ? [el('button', { class: 'btn small primary', onclick: () => go({ tab: 'fight', mon: '' }, true) }, 'Open the combat tracker'), el('button', { class: 'mini', onclick: () => { replaceAsk = true; render(); } }, 'Run this encounter instead')]
          : replaceAsk
            ? [el('span', { class: 'bs-fine' }, 'This replaces the fight in the tracker.'), el('button', { class: 'btn small primary', onclick: () => { replaceAsk = false; fightRestored = true; fightFromEncounter(); go({ tab: 'fight', mon: '' }, true); } }, 'Replace it'), el('button', { class: 'mini', onclick: () => { replaceAsk = false; render(); } }, 'Cancel')]
            : [el('button', { class: 'btn small primary', onclick: () => { fightRestored = true; fightFromEncounter(); go({ tab: 'fight', mon: '' }, true); } }, 'Run this fight')], LAB && M.party > 0 ? el('button', { class: 'mini', onclick: () => go({ tab: 'lab', mon: '', rs: '' }, true) }, 'Test it in the balance lab') : null) : null,
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
    // Volume II families sit in the regions that suit their terrain; named monsters stay unplaced on purpose
    const famsIn = r => (REGION_FAMILIES[r.name.toLowerCase()] || []);
    const v2In = (r, b) => !D.v2 ? [] : D.creatures.filter(c => c.volume === 2 && c.kind === 'creature' && famsIn(r).includes(c.family) && c.kr >= b.min && (b.max == null || c.kr <= b.max)).sort((x, y) => x.kr - y.kr || x.name.localeCompare(y.name));
    const show = TBL.vol;
    const cellKids = (r, k, cell) => {
      const b = E.bands[k];
      const v1 = show === '2' ? [] : cell.map(n => { const go2 = linkFor(n); return go2 ? el('button', { class: 'linkbtn small', onclick: go2 }, n) : el('span', { class: 'linkbtn small dim' }, n); });
      const v2all = show === '1' ? [] : v2In(r, b);
      const key = `${r.name}|${k}`;
      const cap2 = show === 'both' && !TBL.open.has(key) ? 6 : Infinity;
      const v2 = v2all.slice(0, cap2).map(c => el('button', { class: 'linkbtn small v2', title: `KR ${krText(c.kr)} · Volume II · ${c.family}`, onclick: () => openCreature(c) }, c.name));
      const more = v2all.length > cap2 ? el('button', { type: 'button', class: 'mini bs-more', onclick: () => { TBL.open.add(key); render(); } }, `+${v2all.length - cap2} more from Volume II`) : null;
      return [...v1, ...v2, more].filter(Boolean);
    };
    const tables = el('section', { class: 'bs-enc-sec' },
      el('h2', { class: 'section-head' }, E.title),
      el('p', { class: 'd-note' }, E.intro, col >= 0 ? ` Your party’s column is ${E.bands[col].label}.` : ''),
      D.v2 ? el('div', { class: 'bs-sug-f' },
        el('div', { class: 'bs-seg seg', role: 'group', 'aria-label': 'Which volumes' },
          ...[['both', 'Both volumes'], ['1', 'Volume I'], ['2', 'Volume II']].map(([k, t]) => el('button', { type: 'button', class: TBL.vol === k ? 'on' : null, 'aria-pressed': String(TBL.vol === k), onclick: () => { TBL.vol = k; render(); } }, t))),
        el('span', { class: 'bs-key' }, el('span', { class: 'linkbtn small' }, 'Volume I'), el('span', { class: 'linkbtn small v2' }, 'Volume II'))) : null,
      el('div', { class: 'bs-regions' }, ...E.regions.map(r => el('div', { class: 'bs-region' },
        el('h3', {}, r.name),
        D.v2 && show !== '1' ? el('p', { class: 'bs-region-f' }, 'Volume II: ', famsIn(r).join(', '), '.') : null,
        el('div', { class: 'bs-bands' }, ...r.cells.map((cell, k) => el('div', { class: 'bs-band' + (k === col ? ' on' : '') },
          el('span', { class: 'k' }, E.bands[k].label),
          el('div', { class: 'bs-chips' }, ...cellKids(r, k, cell)))))))),
      D.v2 && show !== '1' ? el('p', { class: 'bs-fine' }, 'Volume II families are placed by terrain. Its named monsters aren’t tied to any region, so they aren’t listed here.') : null);
    // the result card sticks beside the party and creatures only, never over the sections below
    result.classList.add('bs-enc-res'); tables.classList.add('bs-enc-full');
    box.replaceChildren(el('div', { class: 'bs-enc' },
      el('div', { class: 'bs-enc-top' }, result, el('div', { class: 'bs-enc-main' }, party, creatures)),
      suggestions, tables));
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
      { id: 'statuses', title: 'Status effects', md: statusMd(D.statuses) || run['Status effects'] },
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
      const n = norm(c.name), fam = norm(`${c.family || c.section || ''} ${c.faction || ''} ${c.party || ''} ${c.className || ''} ${c.domain || ''} ${c.throne || ''} ${c.flavour || ''} ${c.typeLine || ''} ${c.type || ''}`), tell = norm(c.tell), expl = norm(c.exploit);
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
    card.querySelector('.card-top').prepend(el('span', { class: 'badge bs' }, `Bestiary ${['', 'I', 'II', 'III'][c.volume]}`));
    return card;
  }

  function renderV2List(box, meta) {
    if (!D.v2) {
      meta.textContent = '';
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Volume II isn’t set up yet'), 'Run bestiary-2.sql (in the bestiary-data download) in the Supabase SQL editor, then reload.'));
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
    else if (p.id === 'index') body = [indexTable(2)];
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

  // the index: sortable, filterable; one volume (II or III) or all three
  const IDXS = {};
  function indexTable(home) {
    home = home || 2;
    const IDX = IDXS[home] = IDXS[home] || { family: '', named: false, divine: false, all: false, lo: null, hi: null, sort: 'kr', dir: 1 };
    const wrap = el('div', { class: 'bs-idx' });
    const v3By = new Map();
    if (D.v3) for (const c of D.creatures) if (c.volume === 3) v3By.set(`${c.name}|${c.kind === 'rival' ? 'Rivals' : c.kind === 'named' ? 'Named' : c.section}`, c);
    const rows2 = () => !D.v2 ? [] : D.v2.index.rows.map(r => { const c = D.byName.get(r.name.toLowerCase()); return { kr: r.kr, name: r.name, family: r.named ? 'Named' : r.family, named: r.named, base: r.builtFrom, c, vol: 2 }; });
    const rows3 = () => !D.v3 ? [] : D.v3.index.rows.map(r => { const c = v3By.get(`${r.name}|${r.section}`); return { kr: r.kr, name: r.name, family: r.section, named: r.section === 'Named', base: c && c.kind === 'named' ? c.builtFrom : r.party ? r.party : null, c, vol: 3, divine: !!(c && c.divine) }; });
    const rows1 = () => D.rules.index.map(r => { const c = D.byName.get(r.name.toLowerCase()); return { kr: r.kr, name: r.name, family: r.type, named: false, c, vol: 1 }; })
      .concat(D.creatures.filter(c => c.volume === 1 && c.kind === 'named').map(c => ({ kr: c.kr, name: c.name, family: 'Named', named: true, base: c.builtFrom, c, vol: 1 })));
    const rowsAll = () => IDX.all ? rows1().concat(rows2(), rows3()) : home === 3 ? rows3() : rows2();
    const VOL = ['', 'I', 'II', 'III'];
    const famHead = IDX.all ? 'Family / section' : home === 3 ? 'Section' : 'Family';
    const build = () => {      // filters: rebuilt only when the volume changes
      const all = rowsAll();
      const krs = [...new Set(all.map(r => r.kr))].sort((a, b) => a - b);
      const fams = [...new Set(all.map(r => r.family))].sort((a, b) => (a === 'Named') - (b === 'Named') || a.localeCompare(b));
      const meta = el('p', { class: 'result-meta' });
      const tableBox = el('div', { class: 'prose' });
      const clear = el('button', { class: 'mini', onclick: () => { Object.assign(IDX, { family: '', named: false, divine: false, lo: null, hi: null }); build(); } }, 'Clear');
      const showDivine = home === 3 || IDX.all;
      const draw = () => {
        let rows = all.filter(r => (!IDX.family || r.family === IDX.family) && (!IDX.named || r.named) && (!IDX.divine || r.divine) && (IDX.lo == null || r.kr >= IDX.lo) && (IDX.hi == null || r.kr <= IDX.hi));
        const key = IDX.sort;
        rows.sort((a, b) => (key === 'kr' ? a.kr - b.kr : key === 'vol' ? a.vol - b.vol : String(a[key]).localeCompare(String(b[key]))) * IDX.dir || a.kr - b.kr || a.name.localeCompare(b.name));
        const th = (k, label, cls) => el('th', { class: cls || null, 'aria-sort': IDX.sort === k ? (IDX.dir > 0 ? 'ascending' : 'descending') : 'none' },
          el('button', { type: 'button', class: 'bs-sort', onclick: () => { if (IDX.sort === k) IDX.dir = -IDX.dir; else { IDX.sort = k; IDX.dir = 1; } draw(); } }, label, el('span', { class: 'ar' }, IDX.sort === k ? (IDX.dir > 0 ? ' ▲' : ' ▼') : '')));
        meta.textContent = `${rows.length} of ${all.length}`;
        clear.hidden = !(IDX.family || IDX.named || IDX.divine || IDX.lo != null || IDX.hi != null);
        tableBox.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'bs-index' },
          el('thead', {}, el('tr', {}, th('kr', 'KR', 'nar'), th('name', 'Name'), th('family', famHead), IDX.all ? th('vol', 'Volume', 'nar') : null)),
          el('tbody', {}, ...rows.map(r => el('tr', { class: r.named ? 'named' : null },
            el('td', { class: 'nar', 'data-label': 'KR' }, krText(r.kr)),
            el('td', { 'data-label': 'Name' }, r.c ? el('a', { class: 'bs-elink', href: '#' + hashOf(r.c), onclick: e => { e.preventDefault(); openCreature(r.c); } }, r.name) : r.name, r.base ? el('span', { class: 'bs-base' }, ` · ${r.base}`) : null, r.divine ? el('span', { class: 'bs3-tag div sm' }, 'Divine') : null),
            el('td', { 'data-label': famHead }, r.named ? el('span', { class: 'bs-ktag boss' }, 'Named') : r.family),
            IDX.all ? el('td', { class: 'nar', 'data-label': 'Volume' }, VOL[r.vol]) : null))))));
      };
      const famSel = el('select', { class: 'select', 'aria-label': famHead, onchange: e => { IDX.family = e.target.value; draw(); } });
      famSel.append(el('option', { value: '' }, IDX.all ? 'All families, types and sections' : home === 3 ? 'All sections' : 'All families'));
      for (const f of fams) famSel.append(el('option', { value: f, selected: f === IDX.family }, f === 'Named' ? 'Named' : f));
      const volBtn = (allv, label) => el('button', { type: 'button', class: IDX.all === allv ? 'on' : null, 'aria-pressed': String(IDX.all === allv), onclick: () => { if (IDX.all === allv) return; IDX.all = allv; IDX.family = ''; IDX.lo = IDX.hi = null; build(); } }, label);
      wrap.replaceChildren(
        el('p', { class: 'd-note' }, home === 3 ? D.v3.index.intro : D.v2.index.intro),
        el('div', { class: 'bs-idx-f' },
          el('div', { class: 'bs-seg seg', role: 'group', 'aria-label': 'Which volumes' }, volBtn(false, home === 3 ? 'Volume III' : 'Volume II'), volBtn(true, 'All volumes')),
          famSel,
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: IDX.named, onchange: e => { IDX.named = e.target.checked; draw(); } }), 'Named only'),
          showDivine ? el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: IDX.divine, onchange: e => { IDX.divine = e.target.checked; draw(); } }), 'Divine only') : null,
          krSlider(krs, IDX.lo, IDX.hi, { onInput: (lo, hi, any) => { IDX.lo = any ? null : lo; IDX.hi = any ? null : hi; draw(); } }),
          clear),
        meta, tableBox);
      draw();
    };
    build();
    return wrap;
  }
  const hashOf = c => { const L = linkFor(c); const p = new URLSearchParams(); p.set('tab', L.tab); if (L.rs) p.set('page', L.rs); p.set('mon', L.mon); return p.toString(); };

  /* ---------------- Volume III: Peoples and Powers ---------------- */

  // links out of the bestiary: a Throne to its god in the Book of Gods, a flavour to its subclass
  function godHref(name) {
    const DB = H.db && H.db();
    const it = DB && DB.items.find(i => i.type === 'god' && (i.name === name || i.name.startsWith(name + ',') || i.name.startsWith(name + ' ')));
    return it ? `#tab=god&item=${encodeURIComponent(it.id)}` : null;
  }
  function flavourHref(fl) {
    const DB = H.db && H.db();
    if (!DB) return null;
    const want = [fl, (fl.match(/\(([^)]+)\)/) || [])[1]].filter(Boolean).map(x => x.toLowerCase());
    for (const [tag, ref] of DB.sourceIndex) {
      const tail = tag.split(' – ').pop().toLowerCase();
      if (ref.subId && want.includes(tail)) return `#tab=subclass&item=${encodeURIComponent(ref.subId)}`;
    }
    return null;
  }
  const v3Go = (rs, mon) => e => { if (e) e.preventDefault(); go({ tab: 'vol3', rs, mon: mon || '' }, true); if (!mon) { const d = $('#detail'); if (d) d.scrollTop = 0; } };

  // the tag row under a Volume III name: faction, domain, Throne or flavour, and Divine
  function v3Tags(c) {
    const t = [];
    const chip = (label, cls, href, onclick, title) => href || onclick
      ? el('a', { class: 'bs3-tag ' + cls, href: href || '#', onclick: onclick || null, title: title || null }, label)
      : el('span', { class: 'bs3-tag ' + cls }, label);
    if (c.factionId) t.push(chip(c.faction, 'fac', `#tab=vol3&page=${c.factionId}`, v3Go(c.factionId), 'This faction’s page'));
    else if (c.kind === 'named' && c.sourceId) t.push(chip(c.factionName, 'fac', `#tab=vol3&page=${c.sourceId}`, v3Go(c.sourceId)));
    if (c.domain) t.push(chip(c.domain, 'dom'));
    if (c.throne) { const h = godHref(c.throne); t.push(chip(c.throne, 'throne', h, null, h ? `${c.throne} in the Book of Gods` : null)); }
    if (c.flavour) { const h = flavourHref(c.flavour); t.push(chip(c.flavour, 'flav', h, null, h ? `The ${c.flavour} subclass` : null)); }
    if (c.divine) t.push(chip('Divine', 'div', `#tab=vol3&page=domain&mon=divine`, v3Go('domain', 'divine'), 'What Divine means'));
    if (c.sectionId === 'void') t.push(chip('Void', 'void', `#tab=vol3&page=void&mon=void-traits`, v3Go('void', 'void-traits'), 'The three void traits'));
    if (c.pemmaroth) t.push(chip('Pemmaroth', 'pem'));
    return t.length ? el('p', { class: 'bs3-tags' }, ...t) : null;
  }

  const v3Pages = () => {
    const V = D.v3;
    if (!V) return [];
    const kr = ids => { const ks = ids.map(id => D.byId.get(id).kr); return `KR ${krText(Math.min(...ks))}–${krText(Math.max(...ks))}`; };
    return [
      { id: 'intro', title: V.intro.title, sub: 'Command, Break, Terms and Loadout', part: 'top' },
      { id: 'templates', title: 'Templates', sub: `${V.templates.rows.length} new templates`, part: 'top' },
      { id: 'toolkit', title: 'GM Toolkit', sub: 'Faction encounters, taming and mounts, traps', part: 'top' },
      { id: 'index', title: 'Index', sub: `All ${V.count} entries by KR`, part: 'top' },
      ...V.factions.map(f => ({ id: f.id, title: f.title, sub: `9 ranks · ${kr(f.ids)}${f.trait ? ' · ' + f.trait.name : ''}`, part: 'peoples', faction: f })),
      { id: 'rivals', title: 'Rival Adventuring Parties', sub: 'Rival rules, and the six parties', part: 'rivals' },
      ...V.rivals.parties.map(p => ({ id: p.id, title: p.title, sub: `Level ${p.level} · party KR ${p.kr}`, part: 'rivals', party: p })),
      ...V.powers.map(p => ({ id: p.id, title: p.title, sub: `${p.ids.length} · ${kr(p.ids)}`, part: 'powers', power: p })),
      { id: 'named', title: 'Named Leaders', sub: `${V.named.ids.length} · ${kr(V.named.ids)}`, part: 'named' },
      { id: 'pemmaroth', title: 'Pemmaroth', sub: `${V.pemmaroth.ids.length} · campaign spoilers`, part: 'pemmaroth' },
    ];
  };

  function renderV3List(box, meta) {
    if (!D.v3) {
      meta.textContent = '';
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Volume III isn’t set up yet'), 'Run bestiary-3.sql (in the bestiary-data download) in the Supabase SQL editor, then reload.'));
      return;
    }
    if (state.q.trim()) {
      const hits = searchHits(state.q, { volume: 3 });
      meta.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} in Volume III`;
      box.replaceChildren(...(hits.length ? hits.map(h => hitCard(h, state.q)) : [el('div', { class: 'empty' }, el('strong', {}, 'Nothing found'), `Nothing in Volume III matches “${state.q}”.`)]));
      return;
    }
    meta.textContent = 'Contents';
    const pages = v3Pages();
    const tocCard = p => el('button', { class: 'card toc' + (state.rs === p.id ? ' sel' : '') + (p.party ? ' sub' : ''), onclick: () => { go({ rs: p.id, mon: '' }, true); const d = $('#detail'); if (d) d.scrollTop = 0; } },
      el('span', { class: 'card-name' }, p.title), p.sub ? el('span', { class: 'card-sub' }, p.sub) : null);
    const part = (k, label) => { const ps = pages.filter(p => p.part === k); return [el('div', { class: 'section-head' }, label), ...ps.map(tocCard)]; };
    box.replaceChildren(
      ...part('top', 'Bestiary: Volume III'),
      ...part('peoples', 'Part One: Peoples · 12 factions'),
      ...part('rivals', 'Part Two: Rivals'),
      ...part('powers', 'Part Three: Powers'),
      ...part('named', 'Part Four: Named Leaders'),
      ...part('pemmaroth', 'Appendix'));
  }

  // a rules callout: a faction-wide trait, the rival rules, Divine, the void traits
  const callout = (cls, title, kids, id) => el('section', { class: 'bs3-callout ' + cls, id: id ? 'bs-a-' + id : null }, el('h2', {}, title), ...kids);

  // the Song: a counter from 0 to 6 (the Hungering Choir's cult-wide trait)
  function songTracker(key, onChange) {
    const wrap = el('div', { class: 'bs3-song' });
    const draw = () => {
      const n = MECH.has(key) ? MECH.get(key) : 0;
      const set = x => { MECH.set(key, Math.max(0, Math.min(6, x))); draw(); if (onChange) onChange(MECH.get(key)); };
      wrap.replaceChildren(
        el('span', { class: 'k' }, 'The Song'),
        el('div', { class: 'bs3-notes', role: 'group', 'aria-label': `The Song: ${n} of 6` },
          ...Array.from({ length: 6 }, (_, i) => el('button', { type: 'button', class: 'bs3-note' + (i < n ? ' on' : ''), 'aria-label': `Set the Song to ${i + 1}`, onclick: () => set(i + 1 === n ? i : i + 1) }))),
        el('span', { class: 'v' }, n ? `+${n} damage on all Choir attacks` : 'Silent'),
        el('span', { class: 'bs3-song-btns' },
          el('button', { type: 'button', class: 'btn small', disabled: n >= 6, onclick: () => set(n + 1) }, '+1 at the start of the round'),
          n ? el('button', { type: 'button', class: 'mini', onclick: () => set(0) }, 'Reset') : null));
    };
    draw();
    return wrap;
  }

  // load a recipe or a rival party into the encounter builder
  function encFrom(items, replace) {
    if (replace) ENC.rows = [];
    for (const it of items) {
      if (!it.id || !it.n) continue;
      const c = D.byId.get(it.id);
      const tpl = (it.minion || it.minionAssumed) && c && allowed(c, 'minion') ? ['minion'] : [];
      const same = ENC.rows.find(x => x.ref === it.id && (x.tpl || []).join() === tpl.join() && !x.fl);
      if (same) same.n += it.n; else ENC.rows.push({ ref: it.id, tpl, n: it.n, fl: '', disp: '' });
    }
    encSave();
    go({ tab: 'encounter', mon: '', rs: '' }, true);
  }

  function rankLadder(list) {
    return el('nav', { class: 'bs3-ladder', 'aria-label': 'Ranks, cheapest first' },
      ...list.map((c, i) => el('button', { type: 'button', class: 'bs3-rung', style: `--h:${18 + i * 6}px`, onclick: () => { go({ mon: c.id }, false); jump(c.id, true); } },
        el('span', { class: 'bar' }), el('span', { class: 'kr' }, krText(c.kr)), el('span', { class: 'nm' }, c.name))));
  }

  function factionPage(f) {
    const list = f.ids.map(id => D.byId.get(id));
    const named = (f.named || []).map(id => D.byId.get(id));
    const link = it => {
      const c = it.id && D.byId.get(it.id);
      return el('li', {}, el('span', { class: 'n' }, it.n ? String(it.n) : ''),
        el('span', { class: 'w' }, c ? el('a', { href: '#' + hashOf(c), onclick: e => { e.preventDefault(); go({ mon: c.id }, false); jump(c.id, true); } }, it.name) : el('span', {}, it.name),
          it.minion ? el('span', { class: 'bs3-min' }, 'minions') : null),
        el('span', { class: 'kr' }, c ? krText(c.kr) : ''));
    };
    const recipes = el('div', { class: 'bs3-recipes' }, ...f.recipes.map(r => el('div', { class: 'bs3-recipe' },
      el('div', { class: 'h' }, el('span', { class: 'k' }, 'Recipe'), el('span', { class: 'kr' }, `KR ${r.kr}`)),
      el('ul', {}, ...r.items.map(link)),
      el('div', { class: 'bs-sug-btns' },
        el('button', { type: 'button', class: 'btn small primary', onclick: () => encFrom(r.items, true) }, 'Use this'),
        el('button', { type: 'button', class: 'btn small', title: 'Add these to the encounter you have', onclick: () => encFrom(r.items, false) }, 'Add')))));
    const ov = el('section', { class: 'bs3-overview' },
      el('dl', { class: 'bs3-ovl' },
        el('dt', {}, 'Wants'), el('dd', { html: rich(f.wants) }),
        el('dt', {}, 'How they fight'), el('dd', { html: rich(f.fight) }),
        el('dt', {}, el('a', { href: '#tab=vol3&page=intro&mon=break', onclick: v3Go('intro', 'break') }, 'Break')), el('dd', { html: rich(f.break) }),
        el('dt', {}, el('a', { href: '#tab=vol3&page=intro&mon=terms', onclick: v3Go('intro', 'terms') }, 'Terms')), el('dd', { html: rich(f.terms) })),
      el('h2', { class: 'bs3-sub' }, 'Recipes'), recipes,
      named.length ? el('p', { class: 'bs3-named' }, el('span', { class: 'k' }, 'Named leaders'), ' ',
        ...named.flatMap((c, i) => [i ? ', ' : '', el('a', { href: '#' + hashOf(c), onclick: e => { e.preventDefault(); openCreature(c); } }, c.name), el('span', { class: 'bs-each' }, ` KR ${krText(c.kr)}`)])) : null);
    const trait = f.trait ? callout('trait', f.trait.name, [
      el('p', { class: 'bs3-kind' }, cap(f.trait.kind)),
      el('div', { class: 'prose', html: rich(cap(f.trait.text)) }),
      f.id === 'hungering-choir' ? songTracker('song:page') : null]) : null;
    return [
      el('div', { class: 'prose bs-lead', html: tipify(md(f.lead)) }),
      ov, trait,
      el('h2', { class: 'section-head bs-h' }, 'Ranks'),
      rankLadder(list),
      ...list.map(entry)];
  }

  function rivalsPage() {
    const R = D.v3.rivals;
    return [
      el('div', { class: 'prose bs-lead', html: tipify(md(R.lead)) }),
      callout('rules', 'Rival rules', [el('dl', { class: 'bs3-ovl' }, ...R.rules.flatMap(r => [el('dt', {}, r.name), el('dd', { html: rich(r.text) })]))], 'rival-rules'),
      el('div', { class: 'bs3-parties' }, ...R.parties.map(p => el('a', { class: 'bs3-party', href: `#tab=vol3&page=${p.id}`, onclick: v3Go(p.id) },
        el('span', { class: 'nm' }, p.title), el('span', { class: 'lv' }, `Level ${p.level} · party KR ${p.kr}`),
        el('span', { class: 'who' }, p.ids.map(id => D.byId.get(id).className).join(' · ')))))];
  }

  function partyPage(p) {
    const list = p.ids.map(id => D.byId.get(id));
    return [
      el('p', { class: 'bs3-plv' }, el('span', {}, `Level ${p.level}`), el('span', {}, `Party KR ${p.kr}`), el('a', { href: '#tab=vol3&page=rivals&mon=rival-rules', onclick: v3Go('rivals', 'rival-rules') }, 'Rival rules')),
      el('div', { class: 'prose bs-lead', html: tipify(md(p.lead)) }),
      el('p', { class: 'bs3-hook' }, el('span', { class: 'k' }, 'Hook'), ' ', el('span', { html: rich(p.hook) })),
      el('div', { class: 'bs-sug-btns' },
        el('button', { type: 'button', class: 'btn small primary', onclick: () => encFrom(list.map(c => ({ id: c.id, n: 1 })), true) }, 'Use this party as the encounter'),
        el('button', { type: 'button', class: 'btn small', onclick: () => encFrom(list.map(c => ({ id: c.id, n: 1 })), false) }, 'Add to the encounter')),
      el('div', { class: 'bs3-members' }, ...list.map(entry))];
  }

  function powersPage(p) {
    const list = p.ids.map(id => D.byId.get(id));
    const lead = p.lead.split('\n');
    let pre = p.lead, divine = null;
    if (p.id === 'domain') {
      const k = lead.findIndex(l => l.includes('**Divine**'));
      if (k >= 0) { divine = lead[k]; pre = lead.filter((_, i) => i !== k).join('\n'); }
    }
    if (p.id === 'void') pre = lead.filter(l => !/^Void creatures share/.test(l)).join('\n');
    const shared = p.id === 'void' ? callout('void', 'Void creatures share three traits', [el('dl', { class: 'bs3-ovl' }, ...p.callout.flatMap(t => [el('dt', {}, t.name), el('dd', { html: rich(t.text) })]))], 'void-traits') : null;
    return [
      el('div', { class: 'prose bs-lead', html: tipify(md(pre)) }),
      divine ? callout('divine', 'Divine', [el('div', { class: 'prose', html: rich(divine) })], 'divine') : null,
      shared,
      el('div', { class: 'onpage bs-onpage' }, el('span', { class: 'k' }, 'On this page'),
        el('div', { class: 'linklist' }, ...list.map(c => el('button', { class: 'linkbtn', onclick: () => { go({ mon: c.id }, false); jump(c.id, true); } }, c.name, el('span', { class: 'bs-tockr' }, ` ${krText(c.kr)}`))))),
      ...list.map(entry)];
  }

  function listPage(lead, ids) {
    const list = ids.map(id => D.byId.get(id));
    return [
      el('div', { class: 'prose bs-lead', html: tipify(md(lead)) }),
      el('div', { class: 'onpage bs-onpage' }, el('span', { class: 'k' }, 'On this page'),
        el('div', { class: 'linklist' }, ...list.map(c => el('button', { class: 'linkbtn', onclick: () => { go({ mon: c.id }, false); jump(c.id, true); } }, c.name, el('span', { class: 'bs-tockr' }, ` ${krText(c.kr)}`))))),
      ...list.map(entry)];
  }

  function v3Intro() {
    const src = D.v3.intro.md;
    const [before, rest] = src.split('### New in Volume III');
    const [, after] = rest.split('### Reading a faction');
    const lead = rest.split('### Reading a faction')[0].split('\n').filter(l => l.trim() && !/^\*\*(Command|Break|Terms|Loadout)\.\*\*/.test(l)).join('\n');
    const where = { command: c => c.command, loadout: c => c.loadout };
    return [
      el('div', { class: 'prose doc', html: tipify(md(before)) }),
      el('h2', { class: 'section-head bs-h' }, 'New in Volume III'),
      lead ? el('div', { class: 'prose', html: md(lead) }) : null,
      ...Object.entries(D.v3.rules).map(([id, r]) => el('section', { class: 'bs-rulecard bs3-rule ' + id, id: 'bs-a-' + id },
        el('h3', {}, id === 'command' ? el('span', { class: 'ic', html: ICON.command }) : null, r.name),
        el('div', { class: 'prose', html: tipify(inline(cap(r.text))) }),
        where[id] ? el('p', { class: 'bs-fine' }, `In ${D.creatures.filter(c => c.volume === 3 && where[id](c)).length} stat blocks in Volume III.`) : null)),
      el('h2', { class: 'section-head bs-h' }, 'Reading a faction'),
      el('div', { class: 'prose', html: tipify(md(after)) }),
    ];
  }

  function v3Templates() {
    const T = D.v3.templates;
    return [
      el('div', { class: 'prose bs-lead', html: tipify(md(T.lead)) }),
      el('div', { class: 'prose' }, el('div', { class: 'table-wrap' }, el('table', { class: 'bs3-tpl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Template'), el('th', { class: 'nar' }, 'KR'), el('th', {}, 'What changes'))),
        el('tbody', {}, ...T.rows.map(r => el('tr', {}, el('td', { 'data-label': 'Template' }, el('strong', {}, r.name)), el('td', { class: 'nar', 'data-label': 'KR' }, r.kr), el('td', { 'data-label': 'What changes', html: rich(r.text) }))))))),
    ];
  }

  const TAME = { sort: 'wild', dir: 1 };
  function v3Toolkit() {
    const K = D.v3.toolkit;
    const tameBox = el('div', { class: 'prose' });
    const drawTame = () => {
      const rows = K.mounts.slice().sort((a, b) => {
        const k = TAME.sort;
        const x = k === 'wild' ? a.wildness - b.wildness : k === 'mount' ? (a.mount === 'No') - (b.mount === 'No') || a.mount.localeCompare(b.mount) : a[k].localeCompare(b[k]);
        return x * TAME.dir || a.name.localeCompare(b.name);
      });
      const th = (k, label, cls) => el('th', { class: cls || null, 'aria-sort': TAME.sort === k ? (TAME.dir > 0 ? 'ascending' : 'descending') : 'none' },
        el('button', { type: 'button', class: 'bs-sort', onclick: () => { if (TAME.sort === k) TAME.dir = -TAME.dir; else { TAME.sort = k; TAME.dir = 1; } drawTame(); } }, label, el('span', { class: 'ar' }, TAME.sort === k ? (TAME.dir > 0 ? ' ▲' : ' ▼') : '')));
      tameBox.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'bs-index bs3-tame' },
        el('thead', {}, el('tr', {}, th('name', 'Creature'), th('wild', 'Wildness', 'nar'), th('mount', 'Mount'), th('notes', 'Notes'))),
        el('tbody', {}, ...rows.map(r => { const c = r.id && D.byId.get(r.id); return el('tr', {},
          el('td', { 'data-label': 'Creature' }, c ? el('a', { class: 'bs-elink', href: '#' + hashOf(c), onclick: e => { e.preventDefault(); openCreature(c); } }, r.name) : r.name),
          el('td', { class: 'nar', 'data-label': 'Wildness' }, el('span', { class: 'bs3-wild w' + r.wildness, title: `Wildness ${r.wildness} of 5` }, String(r.wildness))),
          el('td', { 'data-label': 'Mount' }, r.mount),
          el('td', { 'data-label': 'Notes' }, r.notes)); })))));
    };
    drawTame();
    const val = (k, v) => el('div', { class: 'bs3-tv' }, el('span', { class: 'k' }, k), el('span', { class: 'v', html: v ? rich(v) : '—' }));
    return [
      el('h2', { class: 'section-head bs-h', id: 'bs-a-building' }, 'Building a faction encounter'),
      el('ol', { class: 'bs3-steps' }, ...K.steps.map(t => el('li', { html: rich(t) }))),
      K.stepsAfter ? el('p', { class: 'd-note' }, K.stepsAfter) : null,
      el('h2', { class: 'section-head bs-h', id: 'bs-a-taming' }, 'Taming and mounts'),
      el('div', { class: 'prose', html: tipify(md(K.tamingLead)) }),
      tameBox,
      el('h2', { class: 'section-head bs-h', id: 'bs-a-traps' }, 'Traps and hazards'),
      el('div', { class: 'prose', html: tipify(md(K.trapsLead)) }),
      el('div', { class: 'bs3-traps' }, ...K.traps.map(t => el('article', { class: 'bs3-trap' },
        el('div', { class: 'h' }, el('h3', {}, t.name), el('span', { class: 'bs-kr' }, `KR ${t.kr}`)),
        el('div', { class: 'bs3-tvs' }, val('Find', t.find), val('Disarm', t.disarm), val('Break', t.break)),
        el('p', { class: 'bs-line', html: rich(cap(t.effect)) })))),
    ];
  }

  function renderV3Page(pane, p) {
    templateTips();
    const pages = v3Pages();
    const k = pages.findIndex(x => x.id === p.id);
    const kick = { top: 'Bestiary: Volume III', peoples: 'Part One: Peoples', rivals: 'Part Two: Rivals', powers: 'Part Three: Powers', named: 'Part Four: Named Leaders', pemmaroth: 'Appendix' }[p.part];
    let body = [];
    if (p.id === 'intro') body = v3Intro();
    else if (p.id === 'templates') body = v3Templates();
    else if (p.id === 'toolkit') body = v3Toolkit();
    else if (p.id === 'index') body = [indexTable(3)];
    else if (p.faction) body = factionPage(p.faction);
    else if (p.id === 'rivals') body = rivalsPage();
    else if (p.party) body = partyPage(p.party);
    else if (p.power) body = powersPage(p.power);
    else if (p.id === 'named') body = listPage(D.v3.named.lead, D.v3.named.ids);
    else if (p.id === 'pemmaroth') body = [el('p', { class: 'bs3-spoil' }, 'Campaign spoilers: this appendix is tied to the current Pemmaroth campaign. Like the rest of the bestiary, only the DM account can see it.'), ...listPage(D.v3.pemmaroth.lead, D.v3.pemmaroth.ids)];
    const wrap = el('div', { class: 'bs3-page' + (p.id === 'void' ? ' bs3-voidpage' : '') + (p.party ? ' bs3-partypage' : '') },
      el('button', { class: 'back', onclick: () => go({ rs: '', mon: '' }, true) }, '← Volume III contents'),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Volume III'), kick),
      el('h1', { class: 'd-title' }, p.title),
      ...body.filter(Boolean),
      el('nav', { class: 'pager' },
        pages[k - 1] ? el('button', { class: 'pg prev', onclick: () => { go({ rs: pages[k - 1].id, mon: '' }, true); pane.scrollTop = 0; } }, el('span', { class: 'k' }, '← Previous'), el('span', { class: 'v' }, pages[k - 1].title)) : el('span'),
        pages[k + 1] ? el('button', { class: 'pg next', onclick: () => { go({ rs: pages[k + 1].id, mon: '' }, true); pane.scrollTop = 0; } }, el('span', { class: 'k' }, 'Next →'), el('span', { class: 'v' }, pages[k + 1].title)) : el('span')));
    pane.replaceChildren(wrap);
    document.title = `${p.title} · Bestiary: Volume III`;
    const target = `3|${p.id}|${state.mon}`;
    if (state.mon && target !== lastAnchor) { lastAnchor = target; requestAnimationFrame(() => jump(state.mon, false)); }
    if (!state.mon) lastAnchor = '';
  }

  /* ---------------- combat tracker ----------------
     A manual tracker for running a fight at the table: initiative order, rounds and turns, HP, status stacks,
     weak points, countdowns, shifts, recharges, Defiant, phases at 66% and 33%, lair actions, and the spoils.
     Nothing is rolled for you. Everything is saved in this browser, so a reload doesn't lose the fight. */
  const FIGHT_KEY = 'hb-fight';
  let FIGHT = (() => { try { const f = JSON.parse(localStorage.getItem(FIGHT_KEY) || 'null'); if (f && Array.isArray(f.list)) return f; } catch (e) { /* none */ } return null; })();
  let fightRestored = false, fightQ = '', fightMsg = '', replaceAsk = false;
  // saved characters to bring into the fight (the DM can see everyone's)
  let partyPick = false, partyRows = null, partyErr = '';
  async function loadParty() {
    partyErr = ''; render();
    const c = Notes.client();
    const [ch, cp] = await Promise.all([
      c.from('characters').select('id, name, owner_id, campaign_id, data').order('name', { ascending: true }),
      c.from('campaigns').select('id, name')]);
    if (ch.error) { partyErr = Notes.friendly(ch.error); partyRows = []; render(); return; }
    const camps = new Map(((cp && cp.data) || []).map(x => [x.id, x.name]));
    partyRows = (ch.data || []).map(r => ({ id: r.id, name: r.name, level: (r.data && r.data.level) | 0, camp: camps.get(r.campaign_id) || 'Not in a campaign', max: H.charHp ? H.charHp(r.data) : 0 }));
    if (H.Play) H.Play.load(partyRows.map(r => r.id));
    render();
  }
  function addChar(r) {
    if (FIGHT.list.some(f => f.charId === r.id)) return;
    FIGHT.list.push({ id: fid(), kind: 'pc', charId: r.id, name: r.name, level: r.level, max: r.max, init: null, statuses: {}, down: false, note: '' });
    fightSave(); render();
  }
  function partyPanel() {
    if (!partyRows) return el('div', { class: 'ft-party' }, el('p', { class: 'bs-fine' }, 'Opening the saved characters…'));
    const groups = new Map();
    for (const r of partyRows) { if (!groups.has(r.camp)) groups.set(r.camp, []); groups.get(r.camp).push(r); }
    return el('div', { class: 'ft-party' },
      partyErr ? el('p', { class: 'notes-msg' }, partyErr) : null,
      partyRows.length ? null : el('p', { class: 'bs-fine' }, 'No saved characters yet. Players save theirs in Characters.'),
      ...[...groups].map(([camp, rs]) => el('div', { class: 'ft-pg' },
        el('div', { class: 'k' }, camp, rs.length > 1 ? el('button', { class: 'mini', onclick: () => { for (const r of rs) addChar(r); } }, 'Add them all') : null),
        ...rs.map(r => { const inFight = FIGHT.list.some(f => f.charId === r.id); return el('button', { type: 'button', class: 'bs-hit' + (inFight ? ' on' : ''), disabled: inFight, onclick: () => addChar(r) },
          el('span', { class: 'nm' }, r.name), el('span', { class: 'bs-hitg' }, `Level ${r.level} · max HP ${r.max || '–'}`), el('span', { class: 'bs-kr' }, inFight ? 'In the fight' : 'Add')); }))),
      el('p', { class: 'bs-fine' }, 'Their HP, statuses and uses stay in sync with each player’s live sheet (Characters → Play).'));
  }
  /* Players can follow the fight on their phones (fight_view): the order, whose turn it is, statuses, and enemies'
     health in words only. Sent a moment after each change while the DM has a campaign picked for it. */
  let shareT = null, shareErr = '', sharedTo = '';
  function healthWord(f) {
    if (f.kind === 'monster') { const m = f.max || 1; return f.hp <= 0 ? 'Down' : f.hp >= m ? 'Unhurt' : f.hp > m / 2 ? 'Hurt' : 'Badly hurt'; }
    return isDown(f) ? 'Down' : null;
  }
  function shareView() {
    const stl = ((H.statuses && H.statuses()) || {}).statuses || [];
    const sName = id => (stl.find(x => x.id === id) || {}).name || id;
    return { active: true, started: !!FIGHT.started, round: FIGHT.round || 0, at: new Date().toISOString(),
      order: order().filter(f => f.kind !== 'lair').map(f => {
        const L = linked(f) ? liveOf(f) : null;
        return { name: f.name, side: f.kind === 'pc' ? 'party' : 'foe', charId: f.charId || null, now: !!FIGHT.started && f.id === FIGHT.cur,
          health: healthWord(f), hp: L ? L.hp : null, max: L ? L.max : null,
          saves: L && L.max && L.hp <= 0 && L.saves && ((L.saves.pass | 0) || (L.saves.fail | 0)) ? { pass: L.saves.pass | 0, fail: L.saves.fail | 0 } : null,
          statuses: Object.entries(stsOf(f) || {}).filter(([, n]) => n > 0).map(([id, n]) => n > 1 ? `${sName(id)} ×${n}` : sName(id)) };
      }) };
  }
  function shareFight(now) {
    const to = FIGHT && FIGHT.share ? FIGHT.share : '';
    clearTimeout(shareT);
    if (!to && !sharedTo) return;
    shareT = setTimeout(async () => {
      const off = sharedTo && sharedTo !== to ? sharedTo : '';
      if (off) await sb().from('fight_view').upsert({ campaign_id: off, data: { active: false }, updated_at: new Date().toISOString() });
      if (to) {
        const r = await sb().from('fight_view').upsert({ campaign_id: to, data: FIGHT && FIGHT.list.length ? shareView() : { active: false }, updated_at: new Date().toISOString() });
        shareErr = r.error ? (/fight_view|does not exist|schema cache/i.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to let players follow fights.' : String(r.error.message)) : '';
      }
      sharedTo = to;
    }, now ? 0 : 700);
  }
  let shareCamps = null, shareLiveKey = '';
  function shareBox() {
    // a player's HP, death saves or statuses changed on their own sheet: pass it on to the players' view
    if (FIGHT && FIGHT.share) {
      const k = JSON.stringify(order().filter(linked).map(f => { const L = liveOf(f) || {}; return [f.id, L.hp, L.max, L.saves, L.statuses]; }));
      if (k !== shareLiveKey) { const first = !shareLiveKey; shareLiveKey = k; if (!first) shareFight(); }
    }
    if (!shareCamps) { shareCamps = []; sb().from('campaigns').select('id, name').order('name', { ascending: true }).then(r => { shareCamps = r.data || []; render(); }); }
    if (!shareCamps.length) return null;
    return el('div', { class: 'ft-share' },
      el('label', {}, 'Players follow it in ', el('select', { class: 'select', 'aria-label': 'Campaign whose players can follow this fight', onchange: e => { FIGHT.share = e.target.value; fightSave(); render(); } },
        el('option', { value: '' }, 'nobody (hidden)'), ...shareCamps.map(c => el('option', { value: c.id, selected: FIGHT.share === c.id }, c.name)))),
      el('span', { class: 'bs-fine' }, FIGHT.share ? 'They see the order, whose turn it is, statuses, and enemies as unhurt, hurt, badly hurt or down.' : ''),
      shareErr ? el('span', { class: 'notes-msg' }, shareErr) : null);
  }
  function fightSave() {
    shareFight();
    if (!FIGHT) { try { localStorage.removeItem(FIGHT_KEY); } catch (e) { /* ignore */ } return; }
    FIGHT.mech = [...MECH.entries()].filter(([k]) => k.startsWith('fight:'));
    try { localStorage.setItem(FIGHT_KEY, JSON.stringify(FIGHT)); } catch (e) { /* this visit only */ }
  }
  function fightRestore() {
    if (fightRestored || !FIGHT) return;
    fightRestored = true;
    for (const [k, v] of FIGHT.mech || []) MECH.set(k, v);
    const OLD = { poison: 'poisoned', charmed: 'charm' };   // ids from the old Volume I status table
    for (const f of FIGHT.list) for (const [a, b] of Object.entries(OLD)) if (f.statuses && f.statuses[a]) { f.statuses[b] = (f.statuses[b] || 0) + f.statuses[a]; delete f.statuses[a]; }
  }
  const fid = () => 'f' + Math.random().toString(36).slice(2, 8);
  const fview = f => { const c = D.byId.get(f.ref); return c ? view(c, f.tpl || [], f.fl ? { fl: f.fl, disp: f.disp || 'Malevolent' } : null) : null; };
  const isBossy = f => { const c = f.ref && D.byId.get(f.ref); return !!c && (c.kind === 'named' || (f.tpl || []).includes('boss')); };
  function monster(ref, tpl, fl, disp, label) {
    const c = D.byId.get(ref);
    const f = { id: fid(), kind: 'monster', ref, tpl: tpl || [], fl: fl || '', disp: disp || '', name: label, init: null, statuses: {}, rech: {}, defiantUsed: 0, seenPhase: 0, note: '' };
    const v = fview(f);
    f.max = f.hp = v ? v.hp : 1;
    if (!f.name) f.name = v ? v.name : c.name;
    return f;
  }
  // chars: saved characters ({ id, name, level, max }) to fight as themselves, linked to their live sheets
  function fightFromEncounter(chars) {
    const list = [];
    if (chars && chars.length) for (const r of chars) list.push({ id: fid(), kind: 'pc', charId: r.id, name: r.name, level: r.level, max: r.max, init: null, statuses: {}, down: false, note: '' });
    else ENC.party.forEach((lvl, i) => list.push({ id: fid(), kind: 'pc', name: `Adventurer ${i + 1}`, level: lvl, init: null, statuses: {}, down: false, note: '' }));
    for (const r of ENC.rows) {
      const c = D.byId.get(r.ref); if (!c) continue;
      const v = rowView(r);
      for (let k = 1; k <= r.n; k++) list.push(monster(r.ref, r.tpl, r.fl, r.disp, r.n > 1 ? `${v.name} ${k}` : v.name));
    }
    for (const k of [...MECH.keys()]) if (k.startsWith('fight:')) MECH.delete(k);
    FIGHT = { round: 0, cur: null, list, started: false };
    syncLair(); fightSave();
  }
  function syncLair() {
    const need = FIGHT.list.some(f => f.kind === 'monster' && isBossy(f));
    const has = FIGHT.list.find(f => f.kind === 'lair');
    if (need && !has) FIGHT.list.push({ id: fid(), kind: 'lair', name: 'Lair actions', init: 20, statuses: {} });
    if (!need && has) FIGHT.list = FIGHT.list.filter(f => f.kind !== 'lair');
  }
  const order = () => FIGHT.list.map((f, i) => [f, i]).sort((a, b) => ((b[0].init ?? -1e9) - (a[0].init ?? -1e9)) || a[1] - b[1]).map(x => x[0]);
  // an adventurer linked to a saved character: its HP and statuses live on the character's sheet (play.js)
  const linked = f => f.kind === 'pc' && f.charId && H.Play;
  function liveOf(f) {
    if (!linked(f)) return null;
    const p = H.Play.get(f.charId) || {};
    const max = p.max || f.max || 0;
    return { hp: p.hp == null ? max : p.hp, max, temp: p.temp | 0, statuses: p.statuses || {}, saves: p.saves || null };
  }
  const stsOf = f => { const L = liveOf(f); return L ? L.statuses : f.statuses || {}; };
  const isDown = f => f.kind === 'monster' ? f.hp <= 0 : f.kind === 'pc' ? (linked(f) ? (liveOf(f).max > 0 && liveOf(f).hp <= 0) : !!f.down) : false;
  function startTurn(f) {
    if (!f) return;
    f.readyNow = [];
    if (f.kind === 'monster') for (const k of Object.keys(f.rech || {})) if (f.rech[k] > 0) { f.rech[k] -= 1; if (!f.rech[k]) f.readyNow.push(k); }
  }
  const stOf = id => D.statuses.statuses.find(x => x.id === id);
  const stCap = id => { const n = parseInt((stOf(id) || {}).max, 10); return isNaN(n) ? Infinity : n; };
  // what happens at the start of a combatant's turn, from its statuses (and recharges for monsters)
  function turnNotes(f) {
    const out = [];
    const L = liveOf(f);
    const hpKnown = f.kind === 'monster' || !!(L && L.max);
    const maxOf = L ? L.max : f.max;
    for (const [id, n] of Object.entries(stsOf(f))) {
      if (!(n > 0)) continue;
      const s0 = stOf(id); if (!s0) continue;
      const x = n > 1 ? ` ×${n}` : '';
      if (id === 'bleed') {
        const per = hpKnown ? Math.max(1, Math.round(maxOf * 0.005)) : 0;
        out.push(hpKnown ? { text: `Bleed${x}: loses ${n * per} HP`, dmg: n * per } : { text: `Bleed${x}: loses 0.5% of max HP (at least 1) per stack` });
      } else if (id === 'burn') { const d = 3 * Math.min(n, 5); out.push({ text: `Burn${x}: loses ${d} HP`, dmg: hpKnown ? d : 0 }); }
      else if (id === 'toxic') out.push({ text: 'Toxic: takes 5 damage', dmg: hpKnown ? 5 : 0 });
      else if (id === 'stun') out.push({ text: 'Stunned: misses its action this turn' });
      else if (id === 'sleep') out.push({ text: 'Asleep: misses this turn. Damage wakes it' });
      else if (id === 'paralysis') out.push({ text: 'Paralysed: can’t move, but can still take certain actions' });
      else if (id === 'madness') out.push({ text: `Madness${x}: roll a d20. ${n} or under, it acts randomly` });
      else if (id === 'freeze') out.push({ text: 'Freeze: rolled dice count for half' });
      else if (id === 'exhaustion' && s0.levels) { const l = Math.min(n, s0.levels.length); out.push({ text: `Exhaustion ${l}: ${s0.levels[l - 1]}` }); }
    }
    if (f.kind === 'monster' && f.readyNow && f.readyNow.length) {
      const v = fview(f);
      const names = f.readyNow.map(i => v && v.attacks[i] ? v.attacks[i].name : null).filter(Boolean);
      if (names.length) out.push({ text: `Ready again: ${names.join(', ')}` });
    }
    return out;
  }
  function step(dir) {
    const o = order().filter(f => !isDown(f));
    if (!o.length) return;
    if (!FIGHT.started) { FIGHT.started = true; FIGHT.round = 1; FIGHT.cur = o[0].id; startTurn(o[0]); fightSave(); render(); return; }
    let i = o.findIndex(f => f.id === FIGHT.cur);
    if (i < 0) i = dir > 0 ? -1 : 0;
    let j = i + dir;
    if (j >= o.length) { j = 0; FIGHT.round += 1; }
    if (j < 0) { j = o.length - 1; FIGHT.round = Math.max(1, FIGHT.round - 1); }
    FIGHT.cur = o[j].id;
    if (dir > 0) startTurn(o[j]);
    fightSave();
    go({ mon: FIGHT.cur }, false);
  }
  const phaseOf = f => f.max ? (f.hp / f.max <= 0.33 ? 2 : f.hp / f.max <= 0.66 ? 1 : 0) : 0;
  function hurt(f, d, what) {
    if (f.kind !== 'monster') return;
    FIGHT.undo = (FIGHT.undo || []).slice(-29);
    FIGHT.undo.push({ id: f.id, hp: f.hp, what: what || (d >= 0 ? `${d} damage to ${f.name}` : `${-d} healing on ${f.name}`), tick: FIGHT.tickKey || '' });
    FIGHT.tickKey = '';
    const v = fview(f);
    if (d > 0 && v && v.tpl.includes('minion')) f.hp = 0;
    else f.hp = Math.max(0, Math.min(f.max, f.hp - d));
    fightSave();
  }

  function statusChips(f, small) {
    const st = D.statuses.statuses;
    return Object.entries(stsOf(f)).filter(([, n]) => n > 0).map(([id, n]) => {
      const s = st.find(x => x.id === id);
      const tip = D.tips.findIndex(t => t.title === (s ? s.name : id));
      return el('span', { class: 'ft-st' + (small ? ' small' : '') }, tip >= 0 && !small ? el('button', { type: 'button', class: 'bs-tip', 'data-tip': String(tip) }, s ? s.names[0] : id) : (s ? s.names[0] : id), n > 1 ? el('b', {}, ` ×${n}`) : null);
    });
  }

  function renderFightList(box, meta) {
    templateTips(); fightRestore();
    meta.textContent = '';
    if (!FIGHT || !FIGHT.list.length) {
      box.replaceChildren(el('div', { class: 'notes-gate ft-empty' },
        el('h1', {}, 'Combat tracker'),
        el('p', {}, 'Build an encounter, then run it here: initiative, rounds, HP, statuses, weak points, countdowns and phases, all in one place.'),
        ENC.rows.length ? el('button', { class: 'btn primary', onclick: () => { fightFromEncounter(); render(); } }, 'Run the current encounter') : null,
        el('button', { class: 'btn', onclick: () => go({ tab: 'encounter', mon: '' }, true) }, ENC.rows.length ? 'Change the encounter' : 'Build an encounter')));
      return;
    }
    const o = order();
    const cur = FIGHT.cur;
    const hits = norm(fightQ) ? D.creatures.filter(c => norm(c.name).includes(norm(fightQ))).sort((a, b) => a.kr - b.kr).slice(0, 6) : [];
    const head = el('div', { class: 'ft-head' },
      el('div', { class: 'ft-round' }, el('span', { class: 'k' }, 'Round'), el('span', { class: 'v' }, FIGHT.started ? String(FIGHT.round) : '–')),
      el('div', { class: 'ft-btns' },
        el('button', { class: 'btn small', onclick: () => render(), title: 'Put everyone in initiative order' }, 'Sort'),
        FIGHT.started ? el('button', { class: 'btn small', onclick: () => step(-1), 'aria-label': 'Previous turn' }, '← Back') : null,
        FIGHT.undo && FIGHT.undo.length ? el('button', { class: 'btn small', title: `Undo ${FIGHT.undo[FIGHT.undo.length - 1].what}`, onclick: () => {
          const u = FIGHT.undo.pop(); const t = FIGHT.list.find(x => x.id === u.id); if (t) t.hp = u.hp; if (u.tick && FIGHT.ticked === u.tick) FIGHT.ticked = ''; fightSave(); render();
        } }, '↶ Undo') : null,
        el('button', { class: 'btn small primary', onclick: () => step(1) }, FIGHT.started ? 'Next turn →' : 'Start the fight')),
      shareBox(),
      el('p', { class: 'ft-hint' }, FIGHT.started ? 'Statuses and recharge timers are checked at the start of each creature’s own turn. Change an initiative any time, then press Sort.' : 'Type everyone’s initiative (Enter moves to the next), then start. Highest goes first; ties keep their order.'));
    const now = FIGHT.started ? FIGHT.list.find(x => x.id === cur) : null;
    const notes = now ? turnNotes(now) : [];
    const key = now ? `${FIGHT.round}:${now.id}` : '';
    const tick = notes.reduce((a, x) => a + (x.dmg || 0), 0);
    const turnBox = notes.length ? el('div', { class: 'ft-turn', role: 'status' },
      el('span', { class: 'k' }, `Start of ${now.name}’s turn`),
      el('ul', {}, ...notes.map(x => el('li', {}, x.text))),
      tick ? (FIGHT.ticked === key ? el('span', { class: 'bs-fine' }, `${tick} damage applied`)
        : el('button', { class: 'btn small primary', onclick: () => {
          if (linked(now)) H.Play.change(now.charId, -tick); else { FIGHT.tickKey = key; hurt(now, tick, `${tick} status damage to ${now.name}`); }
          FIGHT.ticked = key; fightSave(); render(); } }, `Apply ${tick} damage`)) : null) : null;
    const rows = o.map((f, k) => {
      const v = f.kind === 'monster' ? fview(f) : null;
      const down = isDown(f);
      const ph = f.kind === 'monster' && isBossy(f) ? phaseOf(f) : 0;
      return el('div', { class: 'ft-row ' + f.kind + (f.id === cur ? ' cur' : '') + (down ? ' down' : '') + (state.mon === f.id ? ' sel' : ''), 'data-id': f.id },
        f.kind === 'lair' ? el('span', { class: 'ft-init fixed', title: 'Lair actions always come on initiative 20' }, '20') : el('input', { class: 'ft-init', type: 'number', inputmode: 'numeric', value: f.init == null ? '' : String(f.init), placeholder: '–', 'aria-label': `Initiative for ${f.name}`,
          // saved as you type; the order updates when you press Sort or start the fight, so tabbing between boxes isn't interrupted
          onchange: e => { const n = e.target.value.trim(); f.init = n === '' ? null : Number(n); fightSave(); },
          onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.dispatchEvent(new Event('change')); const all = [...document.querySelectorAll('input.ft-init')]; const nx = all[all.indexOf(e.target) + 1]; if (nx) nx.focus(); else e.target.blur(); } } }),
        el('button', { class: 'ft-main', onclick: () => go({ mon: f.id }, true) },
          el('span', { class: 'ft-name' }, f.id === cur ? el('span', { class: 'ft-now' }, 'Now') : null, f.name),
          f.kind === 'monster' ? el('span', { class: 'ft-hp' },
            el('span', { class: 'ft-bar' }, el('span', { style: `width:${f.max ? Math.max(0, f.hp) / f.max * 100 : 0}%` }),
              isBossy(f) ? el('span', { class: 'ft-mk', style: 'left:66%' }) : null, isBossy(f) ? el('span', { class: 'ft-mk', style: 'left:33%' }) : null),
            el('span', { class: 'ft-hpn' }, `${f.hp.toLocaleString('en-GB')} / ${f.max.toLocaleString('en-GB')}`)) : null,
          f.kind === 'lair' ? el('span', { class: 'ft-sub' }, 'Initiative 20, when fought at home') : null,
          linked(f) ? (() => { const L = liveOf(f); return el('span', { class: 'ft-hp' },
            el('span', { class: 'ft-bar pc' }, el('span', { style: `width:${L.max ? Math.max(0, L.hp) / L.max * 100 : 0}%` })),
            el('span', { class: 'ft-hpn' }, `${L.hp} / ${L.max || '–'}${L.temp ? ` +${L.temp}` : ''}`),
            L.max && L.hp <= 0 ? el('span', { class: 'ft-saves' }, (L.saves && L.saves.pass >= 3) ? 'Stable' : (L.saves && L.saves.fail >= 3) ? 'Dead' : `Death saves ${(L.saves && L.saves.pass) | 0} passed, ${(L.saves && L.saves.fail) | 0} failed`) : null); })()
            : f.kind === 'pc' ? el('span', { class: 'ft-sub' }, `Level ${f.level ?? '–'}${f.down ? ' · down' : ''}`) : null,
          el('span', { class: 'ft-chips' }, ...statusChips(f, true),
            ph > (f.seenPhase || 0) ? el('span', { class: 'ft-alert' }, `Phase ${ph}!`) : ph ? el('span', { class: 'ft-ph' }, `Phase ${ph}`) : null,
            v && Object.values(f.rech || {}).some(x => x > 0) ? el('span', { class: 'ft-ph' }, 'Recharging') : null)));
    });
    const add = el('div', { class: 'ft-add' },
      el('input', { type: 'search', class: 'bs-encq ft-q', placeholder: 'Add a creature mid-fight…', value: fightQ, 'aria-label': 'Add a creature',
        oninput: e => { fightQ = e.target.value; render(); const i = $('.ft-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } }),
      hits.length ? el('div', { class: 'bs-hits' }, ...hits.map(c => el('button', { type: 'button', class: 'bs-hit', onclick: () => {
        const same = FIGHT.list.filter(f => f.ref === c.id).length;
        FIGHT.list.push(monster(c.id, [], c.kind === 'tier' ? 'fire' : '', c.kind === 'tier' ? 'Malevolent' : '', same ? `${c.name} ${same + 1}` : ''));
        fightQ = ''; syncLair(); fightSave(); render();
      } }, el('span', { class: 'nm' }, c.name), el('span', { class: 'bs-hitg' }, `${volOf(c)} · ${groupOf(c) || 'Named'}`), el('span', { class: 'bs-kr' }, 'KR ' + krText(c.kr))))) : null,
      el('div', { class: 'ft-addbtns' },
        H.Play && Notes && Notes.client() ? el('button', { class: 'mini', onclick: () => { partyPick = !partyPick; if (partyPick) loadParty(); else render(); } }, partyPick ? 'Close the character list' : '+ Add saved characters') : null,
        el('button', { class: 'mini', onclick: () => { FIGHT.list.push({ id: fid(), kind: 'pc', name: `Adventurer ${FIGHT.list.filter(f => f.kind === 'pc').length + 1}`, init: null, statuses: {}, down: false, note: '' }); fightSave(); render(); } }, '+ Add an adventurer'),
        el('button', { class: 'mini', onclick: () => { FIGHT.ended = true; fightSave(); go({ mon: '' }, true); } }, 'End the fight'),
        el('button', { class: 'mini', onclick: () => go({ tab: 'encounter', mon: '' }, true) }, 'Back to the encounter')));
    if (H.Play) H.Play.watch(FIGHT.list.filter(linked).map(f => f.charId));
    // the Hungering Choir's Song, while any Choir member is in the fight
    const choir = FIGHT.list.some(f => { const c = f.ref && D.byId.get(f.ref); return c && c.factionId === 'hungering-choir'; });
    const song = choir ? songTracker('fight:song', () => fightSave()) : null;
    box.replaceChildren(el('div', { class: 'ft' }, head, turnBox, song, el('div', { class: 'ft-rows' }, ...rows), add, partyPick ? partyPanel() : null));
    meta.textContent = `${o.filter(f => f.kind === 'monster' && !isDown(f)).length} creatures standing · ${o.filter(f => f.kind === 'monster' && isDown(f)).length} down`;
  }

  function renderFightDetail(pane) {
    fightRestore();
    if (!FIGHT) { pane.replaceChildren(); return false; }
    if (FIGHT.ended && !state.mon) { pane.replaceChildren(...spoils()); return true; }
    const f = FIGHT.list.find(x => x.id === state.mon) || FIGHT.list.find(x => x.id === FIGHT.cur);
    if (!f) { pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a combatant'), 'Their card and trackers open here.')); return true; }
    const back = el('button', { class: 'back', onclick: () => go({ mon: '' }, true) }, '← Initiative order');
    const remove = el('button', { class: 'mini', onclick: () => { FIGHT.list = FIGHT.list.filter(x => x !== f); if (FIGHT.cur === f.id) FIGHT.cur = null; syncLair(); fightSave(); go({ mon: '' }, true); } }, 'Remove from the fight');
    const stAdd = (() => {
      const sel = el('select', { class: 'select', 'aria-label': 'Add a status' });
      sel.append(el('option', { value: '' }, 'Add a status…'));
      for (const s0 of D.statuses.statuses) sel.append(el('option', { value: s0.id }, s0.name));
      sel.addEventListener('change', () => { if (!sel.value) return; f.statuses[sel.value] = Math.min(stCap(sel.value), (f.statuses[sel.value] || 0) + 1); fightSave(); render(); });
      return sel;
    })();
    const stList = Object.entries(f.statuses || {}).filter(([, n]) => n > 0).map(([id, n]) => {
      const s0 = D.statuses.statuses.find(x => x.id === id);
      return el('div', { class: 'ft-strow' },
        el('span', { class: 'nm' }, s0 ? s0.name : id),
        el('span', { class: 'bs-count' },
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One fewer ${id}`, onclick: () => { f.statuses[id] = n - 1; if (f.statuses[id] <= 0) delete f.statuses[id]; fightSave(); render(); } }, '−'),
          el('span', { class: 'v' }, String(n)),
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One more ${id}`, disabled: n >= stCap(id), onclick: () => { f.statuses[id] = Math.min(stCap(id), n + 1); fightSave(); render(); } }, '+')),
        s0 ? el('span', { class: 'ft-stx' }, `${s0.effect.replace(/\.$/, '')}.${s0.levels ? ` Level ${Math.min(n, s0.levels.length)}: ${s0.levels[Math.min(n, s0.levels.length) - 1]}.` : ''} Max: ${s0.max}. Ends: ${s0.ends.replace(/\.$/, '')}.`) : null);
    });
    const statuses = el('section', { class: 'bs-sec ft-sec' }, el('h2', {}, 'Statuses'), ...stList, stAdd);
    if (linked(f)) {
      pane.replaceChildren(back,
        el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Adventurer'), f.id === FIGHT.cur ? 'Their turn' : `Level ${f.level ?? '–'}`),
        el('h1', { class: 'd-title' }, f.name),
        H.Play.sheet({ id: f.charId, name: f.name, maxHp: f.max || 0, canEdit: true, compact: true }),
        el('label', { class: 'ft-namefield' }, el('span', { class: 'k' }, 'Tracker notes'), el('textarea', { rows: '2', onchange: e => { f.note = e.target.value; fightSave(); } }, f.note || '')),
        el('p', { class: 'bs-fine' }, el('a', { href: `#tab=chars&char=${encodeURIComponent(f.charId)}` }, 'Open the full character'), ' · changes here show on the player’s sheet.'),
        remove);
      return true;
    }
    if (f.kind === 'pc') {
      pane.replaceChildren(back,
        el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Adventurer'), f.id === FIGHT.cur ? 'Their turn' : ''),
        el('label', { class: 'ft-namefield' }, el('span', { class: 'k' }, 'Name'), el('input', { type: 'text', value: f.name, onchange: e => { f.name = e.target.value.trim() || f.name; fightSave(); render(); } })),
        el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!f.down, onchange: e => { f.down = e.target.checked; fightSave(); render(); } }), 'Down (skipped in the turn order)'),
        statuses,
        el('label', { class: 'ft-namefield' }, el('span', { class: 'k' }, 'Notes'), el('textarea', { rows: '3', onchange: e => { f.note = e.target.value; fightSave(); } }, f.note || '')),
        remove);
      return true;
    }
    if (f.kind === 'lair') {
      const lairs = FIGHT.list.filter(x => x.kind === 'monster' && isBossy(x)).map(x => { const c = D.byId.get(x.ref); return [x.name, c.kind === 'named' ? c.lair : (D.templates.boss.rules.split('\n').find(l => /Lair actions/.test(l)) || '').slice(2)]; });
      pane.replaceChildren(back, el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Lair'), 'Initiative 20'), el('h1', { class: 'd-title' }, 'Lair actions'),
        ...lairs.map(([n, t]) => el('section', { class: 'bs-sec' }, el('h2', {}, n), el('p', { class: 'bs-line', html: rich(t) }))));
      return true;
    }
    const c = D.byId.get(f.ref), v = fview(f);
    const dmg = el('input', { type: 'number', min: '0', inputmode: 'numeric', placeholder: 'amount', 'aria-label': 'Damage or healing' });
    const apply = sign => { const n = parseInt(dmg.value, 10); if (n > 0) { hurt(f, sign * n); render(); } };
    dmg.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(1); } });
    const ph = isBossy(f) ? phaseOf(f) : 0;
    const phases = c.kind === 'named' ? c.phases : null;
    const phaseNote = ph ? el('div', { class: 'ft-phase' + (ph > (f.seenPhase || 0) ? ' new' : '') },
      el('strong', {}, `Phase ${ph} · below ${ph === 1 ? '66%' : '33%'} HP`), ' ',
      phases && phases[ph - 1] ? el('span', { html: rich(phases[ph - 1].text) }) : el('span', { html: rich((D.templates.boss.rules.split('\n').find(l => /\*\*Phases\*\*/.test(l)) || '').slice(2)) }),
      ph > (f.seenPhase || 0) ? el('button', { class: 'mini', onclick: () => { f.seenPhase = ph; fightSave(); render(); } }, 'Done') : null) : null;
    const defiant = v.bossDefiant || (c.kind === 'named' ? (c.defiant || (c.kr >= 50 ? 3 : 2)) : c.defiant || 0);
    const rech = v.attacks.map((a, i) => [a, i]).filter(([a]) => a.recharge && !a.struck);
    const tools = el('section', { class: 'ft-tools' },
      el('div', { class: 'ft-hpbig' },
        el('span', { class: 'k' }, 'HP'), el('span', { class: 'v' }, `${f.hp.toLocaleString('en-GB')}`, el('small', {}, ` / ${f.max.toLocaleString('en-GB')}`)),
        el('span', { class: 'ft-bar big' }, el('span', { style: `width:${f.max ? f.hp / f.max * 100 : 0}%` }), isBossy(f) ? el('span', { class: 'ft-mk', style: 'left:66%' }) : null, isBossy(f) ? el('span', { class: 'ft-mk', style: 'left:33%' }) : null)),
      el('div', { class: 'ft-dmg' }, dmg,
        el('button', { class: 'btn small primary', onclick: () => apply(1) }, 'Damage'),
        el('button', { class: 'btn small', onclick: () => apply(-1) }, 'Heal'),
        f.hp <= 0 ? el('button', { class: 'mini', onclick: () => { hurt(f, f.hp - f.max, `bringing back ${f.name}`); render(); } }, 'Bring back') : null),
      v.tpl.includes('minion') ? el('p', { class: 'bs-fine' }, 'Minion: any hit that deals damage kills it.') : null,
      phaseNote,
      defiant ? el('div', { class: 'ft-def' }, el('span', { class: 'k', html: tipify('Defiant') }), ...Array.from({ length: defiant }, (_, i) =>
        el('button', { type: 'button', class: 'ft-pip' + (i < (f.defiantUsed || 0) ? ' used' : ''), 'aria-label': `Defiant use ${i + 1}`, onclick: () => { f.defiantUsed = i < (f.defiantUsed || 0) ? i : i + 1; fightSave(); render(); } })),
        el('span', { class: 'bs-fine' }, `${defiant - (f.defiantUsed || 0)} left`)) : null,
      rech.length ? el('div', { class: 'ft-rech' }, el('span', { class: 'k' }, 'Recharges'), ...rech.map(([a, i]) => {
        const left = (f.rech || {})[i] || 0;
        return el('div', { class: 'ft-rrow' + (left ? ' wait' : '') }, el('span', { class: 'nm' }, a.name),
          left ? el('span', { class: 'ft-rl' }, `ready in ${left} turn${left === 1 ? '' : 's'}`) : el('span', { class: 'ft-rl ok' }, 'Ready'),
          el('button', { class: 'btn small', onclick: () => { f.rech = f.rech || {}; f.rech[i] = a.recharge; fightSave(); render(); } }, 'Used'),
          left ? el('button', { class: 'mini', onclick: () => { f.rech[i] = 0; fightSave(); render(); } }, 'Ready now') : null);
      })) : null,
      statuses,
      el('label', { class: 'ft-namefield' }, el('span', { class: 'k' }, 'Notes'), el('textarea', { rows: '2', onchange: e => { f.note = e.target.value; fightSave(); } }, f.note || '')));
    pane.replaceChildren(back,
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, f.id === FIGHT.cur ? 'Its turn' : 'In the fight'), f.name),
      tools,
      el('div', { class: 'bs-rule' }),
      card(v, { h: 'h2', mechKey: `fight:${f.id}` }),
      el('div', { class: 'ft-foot' }, remove));
    document.title = `${f.name} · Combat tracker`;
    return true;
  }

  function spoils() {
    const dead = FIGHT.list.filter(f => f.kind === 'monster' && f.hp <= 0);
    const by = new Map();
    for (const f of dead) {
      const v = fview(f); if (!v) continue;
      const kr = v.tpl.includes('minion') ? v.base.kr : v.kr;   // a minion is still the whole animal
      const k = `${f.ref}|${kr}`;
      if (!by.has(k)) by.set(k, { c: v.base, kr, n: 0, name: v.base.name }); by.get(k).n++;
    }
    const P = D.harvest.parts;
    return [
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge bs' }, 'Fight over'), `${FIGHT.round} round${FIGHT.round === 1 ? '' : 's'}`),
      el('h1', { class: 'd-title' }, 'Spoils'),
      dead.length ? el('p', { class: 'd-note' }, 'What can be harvested from the fallen. Values are from the Harvest values table; the DM decides which parts count as common, reagents or cores.') : el('p', { class: 'd-note' }, 'Nothing fell in this fight.'),
      ...[...by.values()].map(x => el('section', { class: 'bs-sec' },
        el('h2', {}, `${x.n} × ${x.name}`),
        el('p', { class: 'bs-line', html: rich(x.c.harvest || x.c.loot || 'No harvest listed.') }),
        el('p', { class: 'bs-fine' }, `At KR ${krText(x.kr)}: common part ${(x.kr * P[0].perKr).toLocaleString('en-GB')} silver · reagent ${(x.kr * P[1].perKr).toLocaleString('en-GB')} silver${x.kr >= 100 ? ` · legendary core ${(x.kr * P[2].perKr).toLocaleString('en-GB')} gold` : ''}.`))),
      el('div', { class: 'bs-sug-btns' },
        el('button', { class: 'btn small', onclick: () => { FIGHT.ended = false; fightSave(); render(); } }, 'Back to the fight'),
        el('button', { class: 'btn small primary', onclick: () => { for (const k of [...MECH.keys()]) if (k.startsWith('fight:')) MECH.delete(k); FIGHT = null; fightSave(); go({ mon: '' }, true); } }, 'Clear the tracker')),
    ];
  }

  /* ---------------- entry points used by app.js ---------------- */

  function renderList(box, meta) {
    if (gate(box, meta)) return;
    const VOLS = [['beast', 'Volume I'], ['vol2', 'Volume II'], ['vol3', 'Volume III'], ['named', 'Named monsters']];
    if (VOLS.some(v => v[0] === state.tab)) {
      if (state.tab === 'beast') renderIndex(box, meta, 'beast');
      else if (state.tab === 'vol2') renderV2List(box, meta);
      else if (state.tab === 'vol3') renderV3List(box, meta);
      else renderIndex(box, meta, 'named');
      // one Bestiary page: the volumes are a switch at the top rather than four tabs
      box.prepend(el('div', { class: 'bs-vols', role: 'group', 'aria-label': 'Volume' }, ...VOLS.map(([t, label]) =>
        el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.tab === t), onclick: () => { if (state.tab !== t) go({ tab: t, sel: null, mon: '', tpl: '', rs: '' }, true); } }, label))));
    }
    else if (state.tab === 'forge') renderForge(box, meta);
    else if (state.tab === 'encounter') renderEncounter(box, meta);
    else if (state.tab === 'fight') renderFightList(box, meta);
    else if (state.tab === 'lab') { if (LAB) LAB.renderList(box, meta); }
    else if (state.tab === 'session') { if (SESSION) SESSION.renderList(box, meta); }
    else if (state.tab === 'brules') renderRulesList(box, meta);
  }

  // returns true when the detail pane is in use (two-pane layout)
  function renderDetail(pane) {
    const twoPane = ['beast', 'vol2', 'vol3', 'named', 'brules', 'fight'].includes(state.tab);
    document.body.classList.remove('bs-card-open', 'bs3-roster');
    if (!D || !admin() || !twoPane) {
      document.body.classList.remove('has-detail');
      pane.classList.remove('placeholder');
      pane.replaceChildren();
      document.body.classList.toggle('bs-wide', !!D && ['forge', 'encounter', 'lab', 'session'].includes(state.tab));
      return false;
    }
    document.body.classList.remove('bs-wide');
    if (state.tab === 'fight') {
      const open = !!(FIGHT && state.mon && FIGHT.list.some(f => f.id === state.mon));
      document.body.classList.toggle('has-detail', open);
      pane.classList.toggle('placeholder', !open);
      return renderFightDetail(pane);
    }
    if (state.tab === 'vol2') {
      const p = D.v2 && !state.q.trim() ? v2Pages().find(x => x.id === state.rs) : null;
      document.body.classList.toggle('has-detail', !!p);
      pane.classList.toggle('placeholder', !p);
      if (p) renderV2Page(pane, p);
      else { pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a page'), 'Choose a family, the named monsters or the index on the left.')); document.title = 'Volume II · Bestiary'; }
      return true;
    }
    if (state.tab === 'vol3') {
      const p = D.v3 && !state.q.trim() ? v3Pages().find(x => x.id === state.rs) : null;
      document.body.classList.toggle('has-detail', !!p);
      pane.classList.toggle('placeholder', !p);
      document.body.classList.toggle('bs3-roster', !!(p && p.party));   // a rival party: room for its members side by side
      if (p) renderV3Page(pane, p);
      else { pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a page'), 'Choose a faction, a rival party, a Powers section, the named leaders or the index on the left.')); document.title = 'Volume III · Bestiary'; }
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
    if ((state.tab === 'vol2' || state.tab === 'vol3') && state.rs) { go({ rs: '', mon: '' }, true); return true; }
    if (state.mon) { go({ mon: '', tpl: '' }, true); return true; }
    if (state.rs) { go({ rs: '' }, true); return true; }
    return false;
  }

  // the balance lab (lab.js) works from the same data and the same encounter
  const LAB = window.HandbookLab ? window.HandbookLab({ el, go, render, Notes, fightStats: H.fightStats,
    B: { data: () => D, view: (c, tpl, forge) => view(c, tpl, forge), rowView, encounter: () => ENC, encMaths, open: (c, tpl) => openCreature(c, tpl), krText } }) : null;

  // the session screen (session.js): planned encounters go through the same builder and tracker
  const SESSION = window.HandbookSession ? window.HandbookSession({ el, go, render, Notes, Play: H.Play, Atlas: H.Atlas, Dice: H.Dice, Table: H.Table, charHp: H.charHp, statuses: H.statuses,
    B: { data: () => D, rowView, krText,
      encounter: () => ENC,
      mathsFor: enc => { const keep = ENC; ENC = enc; try { return encMaths(); } finally { ENC = keep; } },
      useEncounter: enc => { ENC = { party: enc.party.slice(), rows: JSON.parse(JSON.stringify(enc.rows)) }; encSave(); },
      startFight: (enc, chars, camp) => {
        ENC = { party: chars.length ? chars.map(c => c.level) : enc.party.slice(), rows: JSON.parse(JSON.stringify(enc.rows)) }; encSave();
        fightRestored = true; fightFromEncounter(chars); if (camp && FIGHT) { FIGHT.share = camp; fightSave(); } go({ tab: 'fight', mon: '' }, true);
      } } }) : null;

  // for tests and future tools (combat simulator, price tool)
  const api = { view: (id, tpl, forge) => D && view(D.byId.get(id), tpl, forge), data: () => D, encounter: () => D && encMaths(),
    suggest: (P, level, opts) => { Object.assign(SUG, opts || {}); const r = suggest(P, level); return r && { ...r, verdict: P / r.exact >= 1.5 ? 'easy' : P / r.exact >= 0.75 ? 'fair' : 'deadly' }; },
    cardText: v => cardText(v), printPreview: (id, tpl, forge) => { templateTips(); printRoot(view(D.byId.get(id), tpl, forge)); document.body.classList.add('printing'); } };
  window.__bestiary = api;

  // site search (the All tab): DM only, once the data is loaded
  function siteHits(q, limit) {
    if (!admin()) return null;
    if (!D) { if (!loading && !loadErr && sb()) load(); return null; }
    return searchHits(q, { limit: limit || 12 });
  }

  return { init, TABS, LABEL, readHash, writeHash, renderList, renderDetail, renderFilters, onEscape, isAdmin: admin, blankState: blank, siteHits, hitCard };
};
