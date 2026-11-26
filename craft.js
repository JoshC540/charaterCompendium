/* Crafting: an estimate of what it costs to have an item made, or to make it yourself, and what it's worth.
   A simpler, player-facing version of the Market Price Ledger's commission calculator, using the same item list,
   recipes and maths, priced for an ordinary market (your DM may adjust prices for the town you're in).
   No enchantments here: ask the DM. */
window.HandbookCraft = function (H) {
  'use strict';
  const { el, state, render } = H;

  let data = null, loading = false, failed = false;
  const S = { item: 'longsword', q: 2, mats: {}, artisan: '', qty: 1, rent: true, tools: {} };
  try { Object.assign(S, JSON.parse(localStorage.getItem('hb-craft') || '{}')); } catch (e) { /* defaults */ }
  // a shared estimate: #tab=craft&cf=... sets the choices (and is then kept like your own)
  try {
    const cf = new URLSearchParams(location.hash.slice(1)).get('cf');
    if (cf) {
      const j = JSON.parse(cf);
      Object.assign(S, { item: String(j.i || S.item), q: +j.q || S.q, qty: +j.n || 1, mats: j.m || {}, rent: !!j.r, tools: j.t || {}, artisan: j.a || '' });
      try { localStorage.setItem('hb-craft', JSON.stringify(S)); } catch (e) { /* this visit only */ }
      const h = new URLSearchParams(location.hash.slice(1)); h.delete('cf');   // so a reload keeps your own changes
      history.replaceState(null, '', `${location.pathname}${location.search}#${h.toString()}`);
    }
  } catch (e) { /* a broken link: keep the saved choices */ }
  if (typeof S.artisan !== 'string') S.artisan = '';          // older saves kept a yes/no here
  if (!S.tools || typeof S.tools !== 'object') S.tools = {};
  const save = () => { try { localStorage.setItem('hb-craft', JSON.stringify(S)); } catch (e) { /* this visit only */ } };

  // the ledger's constants (Market Price Ledger, crafting tab)
  const RARITY = ['Staple', 'Common', 'Uncommon', 'Rare', 'Very rare', 'Legendary'];
  const QUALITY_TIME = [0.3, 0.5, 1, 1.5, 2, 4, 8, 16];
  const EXOTIC_METAL = 'Exotic metal smithing (per item)', EXOTIC_WOOD = 'Rare-wood carving (per item)';
  const SELL_SHARE = 0.5;   // the ledger's default: a merchant pays half the price
  const GROUP_NAME = { weapons: 'Weapons', armour: 'Armour', clothing: 'Clothing', _vessel: 'Spell vessels' };
  // which Crafting skill (Advancement) works each material, and the tools it needs from the item list
  const BOWYER = /bow|arrows|bolts/;
  const skillFor = (c, itemId) => c === 'metal' ? ['Smithing', "Smith's tools"]
    : c === 'wood' ? (BOWYER.test(itemId) ? ['Fletching & Bowyery', "Woodcarver's tools"] : ['Woodworking', "Carpenter's tools"])
    : c === 'leather' ? ['Leatherworking', "Leatherworker's tools"] : ['Textiles', "Weaver's tools"];
  const HIRE_SHARE = 0.1;   // hiring tools: about a tenth of their price a week

  function load() {
    if (loading || data) return;
    loading = true;
    fetch('content/items.json').then(r => r.json()).then(j => {
      const byId = new Map(j.items.map(i => [i.id, i]));
      const byName = new Map(j.items.map(i => [i.name, i]));
      data = { ...j, byId, byName };
      loading = false;
      if (state.tab === 'craft') render();
    }).catch(() => { loading = false; failed = true; if (state.tab === 'craft') render(); });
  }

  const DEN = [['pp', 1000000], ['gp', 10000], ['sp', 100], ['cp', 1]];
  function coins(cp) {
    let n = Math.max(0, Math.round(cp));
    if (!n) return '0 cp';
    const out = [];
    for (const [k, v] of DEN) { const c = Math.floor(n / v); if (c) { out.push(`${c.toLocaleString('en-GB')} ${k}`); n -= c * v; } }
    return out.slice(0, 3).join(' ');   // three denominations at most: the rest is small change
  }
  const perKg = i => i.cp / (i.kg || 1);
  const matName = m => m.name.replace(/\s*\((1 kg|1 lb|1 sq yd|1 yd)\)$/, '').replace(/ (ingot|plank|stave)$/, '');
  const when = d => d < 14 ? `${d} day${d === 1 ? '' : 's'}` : d < 60 ? `${Math.round(d / 7)} weeks` : `${Math.round(d / 30)} months`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // the skills this item needs, each with its tools, in recipe order
  function skillsOf(rec) {
    const out = [];
    for (const c of data.materialOrder) {
      if (!rec[c]) continue;
      const [skill, toolName] = skillFor(c, S.item);
      const tool = data.byName.get(toolName);
      const have = out.find(s => s.skill === skill);
      if (have) have.mats.push(c); else out.push({ skill, tool, mats: [c] });
    }
    return out;
  }

  function calc() {
    const D = data, base = D.byId.get(S.item), rec = D.recipes[S.item];
    if (!base || !rec) return null;
    const q = D.qualities[S.q] || D.qualities[2];
    const skills = skillsOf(rec);
    const art = skills.some(s => s.skill === S.artisan) ? S.artisan : '';   // remembered per skill, used only if this item needs it
    let std = 0, kgTot = 0, matTotal = 0, ownMats = 0, diff = 1;
    const mats = [], needs = [], notes = [];
    for (const c of D.materialOrder) {
      if (!rec[c]) continue;
      const sd = D.byId.get(D.standardMaterials[c]);
      let m = D.byId.get(S.mats[c]);
      if (!m || m.mat !== c) m = sd;
      const kg = rec[c];
      kgTot += kg; std += kg * perKg(sd);
      const cost = kg * perKg(m);
      matTotal += cost;
      // Artisan: work in your chosen Crafting skill costs half the materials
      const artisan = art && skillFor(c, S.item)[0] === art;
      ownMats += artisan ? cost / 2 : cost;
      mats.push({ c, kg, m, cost, artisan });
      diff = Math.max(diff, D.workmanship[m.tier] || 1);
      for (const n of m.needs || []) if (!needs.includes(n)) needs.push(n);
      if (c === 'metal' && m.tier >= 3 && !needs.includes(EXOTIC_METAL)) needs.push(EXOTIC_METAL);
      if (c === 'wood' && m.tier >= 3 && !needs.includes(EXOTIC_WOOD)) needs.push(EXOTIC_WOOD);
      // the main material's own effect on a weapon or armour (content/items.json "fx")
      const F = base.fight, fx = F && F.mat === c && m.fx && (F.kind === 'weapon' || F.kind === 'armour') ? m.fx[F.kind === 'weapon' ? 'w' : 'a'] : '';
      if (m.id !== sd.id && (m.note || fx)) notes.push([matName(m), [m.note, fx ? `On this ${F.kind === 'weapon' ? 'weapon' : 'armour'}: ${fx}` : ''].filter(Boolean).join(' ')]);
    }
    const labour = Math.max(base.cp * 0.3, base.cp - std);
    const work = labour * q.mult * diff;
    const fees = needs.map(n => { const sv = D.byName.get(n); return { name: n, cost: sv ? sv.cp : 0 }; }).filter(f => f.cost);
    const feeTotal = fees.reduce((a, f) => a + f.cost, 0);
    const baseDays = Math.max(1, Math.ceil(0.6 * Math.sqrt(labour / 100)));
    const days = Math.max(1, Math.ceil(baseDays * QUALITY_TIME[S.q] * diff));
    const n = Math.max(1, Math.min(100, S.qty | 0 || 1));
    const commission = matTotal + work + feeTotal;
    // making it yourself: no wages, but you pay for the workplace and any tools you don't have
    const allDays = days * n;
    const place = rec.metal ? { what: 'forge', item: D.byName.get('Forge rental (day)'), per: 1 }
      : { what: 'workshop', item: D.byName.get('Workshop rental (week)'), per: 7 };
    place.day = place.item ? place.item.cp / place.per : 0;
    const rent = S.rent ? place.day * allDays : 0;
    const weeks = Math.max(1, Math.ceil(allDays / 7));
    const tools = skills.filter(s => s.tool).map(s => {
      const how = S.tools[s.skill] || 'have';
      const hireWeek = Math.max(1, Math.round(s.tool.cp * HIRE_SHARE));
      return { ...s, how, hireWeek, cost: how === 'buy' ? s.tool.cp : how === 'hire' ? hireWeek * weeks : 0 };
    });
    const toolTotal = tools.reduce((a, t) => a + t.cost, 0);
    const ownEach = ownMats + feeTotal;
    const own = ownEach * n + rent + toolTotal;
    const kept = tools.reduce((a, t) => a + (t.how === 'buy' ? t.cost : 0), 0);   // bought tools are yours to keep
    return { base, q, mats, work, diff, fees, feeTotal, matTotal, ownMats, commission, own, days, allDays, weeks, n, place, rent,
      tools, toolTotal, kept, skills, art, value: commission, sells: commission * SELL_SHARE,
      kg: Math.max(kgTot, base.wt || 0), shelf: base.cp, notes };
  }

  function shareLink(btn) {
    const cf = JSON.stringify({ i: S.item, q: S.q, n: S.qty || 1, m: S.mats, r: S.rent ? 1 : 0, t: S.tools, a: S.artisan || '' });
    const url = `${location.origin}${location.pathname}#tab=craft&cf=${encodeURIComponent(cf)}`;
    const ok = () => { btn.textContent = 'Link copied'; setTimeout(() => { btn.textContent = 'Copy a link to this estimate'; }, 1500); };
    try { navigator.clipboard.writeText(url).then(ok, () => window.prompt('Copy this link', url)); } catch (e) { window.prompt('Copy this link', url); }
  }

  function renderList(box, meta) {
    meta.textContent = '';
    document.body.classList.add('cf-wide');
    if (!data) {
      if (!failed) load();
      box.replaceChildren(el('div', { class: 'empty' }, failed ? 'The item list didn’t load. Check your connection and reload.' : 'Opening the item list…'));
      return;
    }
    const D = data;
    // items that have a recipe, grouped
    const groups = new Map();
    for (const id of Object.keys(D.recipes)) {
      const it = D.byId.get(id); if (!it) continue;
      const g = it.vessel ? '_vessel' : it.cat;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    if (!D.recipes[S.item]) S.item = 'longsword';
    const set = patch => { Object.assign(S, patch); save(); render(); };
    const itemSel = el('select', { class: 'select cf-item', id: 'cf-item', onchange: e => set({ item: e.target.value }) });
    for (const [g, list] of groups) {
      const og = el('optgroup', { label: GROUP_NAME[g] || (D.categories[g] || g) });
      for (const it of list) og.append(el('option', { value: it.id, selected: it.id === S.item }, it.name));
      itemSel.append(og);
    }
    const r = calc();
    const rec = D.recipes[S.item];
    const n = r.n;
    const matSel = c => {
      const all = D.items.filter(i => i.mat === c).sort((a, b) => perKg(a) - perKg(b));
      const cur = r.mats.find(x => x.c === c).m.id;
      const s = el('select', { class: 'select', id: `cf-mat-${c}`, onchange: e => { S.mats[c] = e.target.value; save(); render(); } });
      RARITY.forEach((t, ti) => {
        const list = all.filter(m => m.tier === ti);
        if (!list.length) return;
        const og = el('optgroup', { label: t });
        for (const m of list) og.append(el('option', { value: m.id, selected: m.id === cur }, `${matName(m)} · ${coins(perKg(m))}/kg`));
        s.append(og);
      });
      return el('div', { class: 'cf-field' }, el('label', { for: `cf-mat-${c}` }, D.materialLabels[c], el('span', { class: 'cf-kg' }, ` ${rec[c]} kg`)), s);
    };
    const quals = D.qualities.map((q, i) => [i, q]).filter(([i]) => i > 0);   // no one commissions a broken item

    // making it yourself: workplace, tools and the Artisan feat
    const seg = (label, value, on, onclick) => el('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick }, label);
    const toolRow = t => el('div', { class: 'cf-tool' },
      el('span', { class: 'cf-tool-name' }, t.tool.name, el('span', { class: 'cf-kg' }, ` for ${t.skill}`)),
      el('div', { class: 'cf-seg', role: 'group', 'aria-label': t.tool.name },
        seg('I have them', 'have', t.how === 'have', () => { S.tools[t.skill] = 'have'; save(); render(); }),
        seg(`Hire · ${coins(t.hireWeek)}/week`, 'hire', t.how === 'hire', () => { S.tools[t.skill] = 'hire'; save(); render(); }),
        seg(`Buy · ${coins(t.tool.cp)}`, 'buy', t.how === 'buy', () => { S.tools[t.skill] = 'buy'; save(); render(); })));
    const artisan = r.skills.length === 1
      ? el('label', { class: 'toggle cf-art' }, el('input', { type: 'checkbox', checked: r.art === r.skills[0].skill, onchange: e => set({ artisan: e.target.checked ? r.skills[0].skill : '' }) }), `I have the Artisan feat for ${r.skills[0].skill}`)
      : el('div', { class: 'cf-field' }, el('label', { for: 'cf-artisan' }, 'Artisan feat'),
        el('select', { class: 'select', id: 'cf-artisan', onchange: e => set({ artisan: e.target.value }) },
          el('option', { value: '', selected: !r.art }, 'I don’t have it for these skills'),
          ...r.skills.map(s => el('option', { value: s.skill, selected: r.art === s.skill }, `I have it for ${s.skill}`))));
    const own = el('fieldset', { class: 'cf-own' },
      el('legend', {}, 'If you make it yourself'),
      el('p', { class: 'cf-hint cf-skills' }, `Skills: ${r.skills.map(s => s.skill).join(' and ')}.`),
      el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: S.rent, onchange: e => set({ rent: e.target.checked }) }),
        `Rent a ${r.place.what}`, r.place.item ? el('span', { class: 'cf-kg' }, ` · ${coins(r.place.item.cp)} a ${r.place.per === 1 ? 'day' : 'week'}`) : null),
      ...r.tools.map(toolRow),
      artisan);

    const form = el('section', { class: 'cf-form' },
      el('div', { class: 'cf-field' }, el('label', { for: 'cf-item' }, 'Item'), itemSel),
      ...D.materialOrder.filter(c => rec[c]).map(matSel),
      el('div', { class: 'cf-field' }, el('span', { class: 'cf-lbl' }, 'Quality'),
        el('div', { class: 'cf-quals', role: 'group', 'aria-label': 'Quality' }, ...quals.map(([i, q]) => el('button', {
          type: 'button', class: 'chip' + (S.q === i ? ' on' : ''), 'aria-pressed': String(S.q === i), title: q.note, onclick: () => set({ q: i }),
        }, q.name))),
        el('p', { class: 'cf-hint' }, r.q.note)),
      el('label', { class: 'cf-field cf-qty' }, el('span', { class: 'cf-lbl' }, 'How many'),
        el('input', { type: 'number', min: '1', max: '100', step: '1', inputmode: 'numeric', value: String(S.qty || 1), onchange: e => set({ qty: Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)) }) })),
      own);

    const fancy = r.mats.filter(x => x.m.id !== D.standardMaterials[x.c]).map(x => matName(x.m));
    const title = `${r.q.name} ${r.base.name.charAt(0).toLowerCase()}${r.base.name.slice(1)}${fancy.length ? ` (${fancy.join(', ')})` : ''}`;
    const stat = (k, v, sub) => el('div', { class: 'stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v), sub ? el('span', { class: 'cf-sub' }, sub) : null);
    const profit = r.sells * n - (r.own - r.kept);
    const row = (k, text, cost) => el('tr', {}, el('td', {}, el('span', { class: 'cf-k' }, k), text ? ` ${text}` : ''), el('td', { class: 'num' }, coins(cost)));
    const res = el('section', { class: 'cf-result', 'aria-live': 'polite' },
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge prime' }, 'Estimate'), n > 1 ? `${n} of them` : 'One item'),
      el('h2', { class: 'cf-title' }, title),
      el('p', { class: 'cf-est' }, 'Every figure here is an estimate for an ordinary market. Your DM sets the real price. ',
        el('button', { class: 'linkbtn cf-share', title: 'Copy a link that opens this exact estimate', onclick: e => shareLink(e.currentTarget) }, 'Copy a link to this estimate')),
      el('div', { class: 'stats cf-stats' },
        stat('Commission (est.)', `≈ ${coins(r.commission * n)}`, n > 1 ? `${coins(r.commission)} each` : null),
        stat('Make it (est.)', `≈ ${coins(r.own)}`, n > 1 ? 'for all of them' : null),
        stat('Value (est.)', `≈ ${coins(r.value * n)}`, 'what it’s worth'),
        stat('Merchant pays (est.)', `≈ ${coins(r.sells * n)}`, 'if you sell it'),
        stat('Time', `about ${when(r.allDays)}`, n > 1 ? `${when(r.days)} each` : null),
        stat('Weight', `${(r.kg * n < 10 ? (r.kg * n).toFixed(1) : Math.round(r.kg * n).toLocaleString('en-GB'))} kg`)),
      el('h3', { class: 'cf-h' }, 'Commissioning it'),
      el('div', { class: 'prose' }, el('div', { class: 'table-wrap' }, el('table', { class: 'cf-table' },
        el('tbody', {},
          ...r.mats.map(x => row(D.materialLabels[x.c], `${matName(x.m)}, ${x.kg} kg`, x.cost * n)),
          row('Workmanship', `${r.q.name} ×${r.q.mult.toLocaleString('en-GB')}${r.diff > 1 ? `, difficult material ×${r.diff}` : ''}`, r.work * n),
          ...r.fees.map(f => row('Special work', f.name, f.cost * n)),
          el('tr', { class: 'tot' }, el('td', {}, 'Estimated total'), el('td', { class: 'num' }, coins(r.commission * n))))))),
      el('h3', { class: 'cf-h' }, 'Making it yourself'),
      el('div', { class: 'prose' }, el('div', { class: 'table-wrap' }, el('table', { class: 'cf-table cf-own-t' },
        el('tbody', {},
          ...r.mats.map(x => row(D.materialLabels[x.c], `${matName(x.m)}${x.artisan ? ', half for Artisan' : ''}`, (x.artisan ? x.cost / 2 : x.cost) * n)),
          ...r.fees.map(f => row('Special work', f.name, f.cost * n)),
          r.rent ? row(`${r.place.what} rent`, plural(r.allDays, 'day'), r.rent) : null,
          ...r.tools.filter(t => t.cost).map(t => row(t.tool.name, t.how === 'buy' ? 'bought, yours to keep' : `hired, ${plural(r.weeks, 'week')}`, t.cost)),
          el('tr', { class: 'tot' }, el('td', {}, 'Estimated total'), el('td', { class: 'num' }, coins(r.own))))))),
      el('p', { class: 'cf-note' }, `There are no wages, since you do the work, but you need the skill${S.rent ? '' : ` and your own ${r.place.what}`}. `, profit >= 0
          ? `Made and sold to a merchant, ${n > 1 ? 'they’d' : 'it’d'} make about ${coins(profit)}${r.kept ? ', not counting the tools you keep' : ''}.`
          : `Made and sold to a merchant, ${n > 1 ? 'they’d' : 'it’d'} lose about ${coins(-profit)}${r.kept ? ', not counting the tools you keep' : ''}.`),
      r.notes.length ? el('div', { class: 'cf-notes' }, el('h3', {}, 'About the materials'), ...r.notes.map(([nm, t]) => el('p', {}, el('strong', {}, nm + '. '), t))) : null,
      el('p', { class: 'cf-fine' }, `An ordinary ${r.base.name.toLowerCase()} off the shelf: about ${coins(r.shelf)}. Prices are for an ordinary market; your DM may adjust them for the town. Hired tools are about a tenth of their price a week. Enchantments aren’t included: ask your DM.`));
    box.replaceChildren(el('div', { class: 'cf' },
      el('p', { class: 'd-note cf-intro' }, 'Pick an item, its materials and the quality you want, for an estimate of what it costs to have it made or to make it yourself, and what it’s worth.'),
      el('div', { class: 'cf-grid' }, form, res)));
    document.title = 'Crafting · Player’s Handbook';
  }

  return { renderList, init: () => {} };
};
