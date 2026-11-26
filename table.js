/* Your table: shops, the guild's contract board, handouts, the next session, and the table screen.
   Shops: the DM opens a shop with stock and prices; players buy from a character's purse straight away (it waits on
   the sheet to add to their inventory), and offer things to sell, which the DM accepts or turns down.
   Contracts: the DM posts them, the party takes one on, and the DM's "Done" pays the reward into the party account.
   Handouts: the DM shows a letter or picture; it pops up on players' screens and stays under Notes.
   Next session: the DM offers dates, players answer yes, maybe or no, and the DM picks one.
   Table screen: a page for a TV at the table (turn order, the dice, a map, the latest handout).
   Everything that matters goes through the database's rules (supabase/setup.sql). */
window.HandbookTable = function (H) {
  'use strict';
  const { el, state, go, render, Notes } = H;

  const sb = () => Notes && Notes.client && Notes.client();
  const user = () => Notes && Notes.user && Notes.user();
  const admin = () => !!(Notes && Notes.isAdmin && Notes.isAdmin());
  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : String((e && e.message) || e));
  const missing = e => /does not exist|schema cache|relation .* not|could not find the function/i.test(String((e && e.message) || e || ''));
  const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* this visit only */ } };
  const SETUP = 'Run the latest supabase/setup.sql in the Supabase SQL editor, then reload.';

  /* ---------- money ---------- */
  const fmt = cp => {
    const n = Math.abs(Number(cp) || 0);
    const out = [[Math.floor(n / 1000000), 'pp'], [Math.floor(n % 1000000 / 10000), 'gp'], [Math.floor(n % 10000 / 100), 'sp'], [n % 100, 'cp']]
      .filter(([v]) => v).map(([v, k]) => `${v.toLocaleString('en-GB')} ${k}`);
    return (cp < 0 ? '−' : '') + (out.join(' ') || '0 cp');
  };
  // "12 gp 5 sp", "40" (gold), "3pp" → copper; null if it doesn't read as money
  function parseCoin(s) {
    const t = String(s || '').toLowerCase().replace(/,/g, '').trim();
    if (!t) return 0;
    const RATE = { pp: 1000000, gp: 10000, sp: 100, cp: 1 };
    let cp = 0;
    let rest = t.replace(/(\d+(?:\.\d+)?)\s*(pp|gp|sp|cp)\b/g, (m, n, k) => { cp += Math.round(Number(n) * RATE[k]); return ' '; });
    if (/^\s*\d+(\.\d+)?\s*$/.test(rest)) { cp += Math.round(Number(rest) * RATE.gp); rest = ''; }
    return rest.trim() ? null : cp;
  }
  const day = t => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const when = t => { const d = new Date(t); return isNaN(d) ? String(t || '') : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ---------- campaigns (shared by every page here) ---------- */
  const CAMP_KEY = 'hb-table-camp';
  let camps = null, campsBusy = false, campsErr = '', campId = lsGet(CAMP_KEY);
  let profiles = [];
  async function loadCamps() {
    if (campsBusy || !sb() || !user()) return;
    campsBusy = true;
    const [r, p] = await Promise.all([sb().from('campaigns').select('id, name').order('name', { ascending: true }), sb().from('profiles').select('id, display_name')]);
    campsBusy = false;
    if (r.error) { campsErr = friendly(r.error); camps = []; render(); return; }
    camps = r.data || []; profiles = (p && p.data) || [];
    if (!camps.some(c => c.id === campId)) campId = camps[0] ? camps[0].id : '';
    render();
  }
  const nameOf = id => (profiles.find(p => p.id === id) || {}).display_name || 'Someone';
  function pickCamp(id) { campId = id; lsSet(CAMP_KEY, id); shops = null; jobs = null; mine = null; next = null; msg = ''; render(); }
  const campSel = () => camps && camps.length > 1 ? el('label', { class: 'tb-camp' }, el('span', { class: 'k' }, 'Campaign'),
    el('select', { class: 'select', onchange: e => pickCamp(e.target.value) }, ...camps.map(c => el('option', { value: c.id, selected: c.id === campId }, c.name)))) : null;
  // the common start of a page: signed in, campaigns loaded, one chosen
  function gate(box, title, blurb) {
    if (!user()) {
      box.replaceChildren(el('div', { class: 'notes-gate' }, el('h1', {}, title), el('p', {}, blurb), el('button', { class: 'btn primary', onclick: () => Notes.openSignIn() }, 'Sign in')));
      return false;
    }
    if (!camps) { loadCamps(); box.replaceChildren(el('div', { class: 'empty' }, 'Opening your campaigns…')); return false; }
    if (campsErr) { box.replaceChildren(el('div', { class: 'empty' }, campsErr)); return false; }
    if (!camps.length) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'No campaign yet'), admin() ? 'Create one on the Notes tab first.' : 'Your DM adds you to a campaign.')); return false; }
    return true;
  }
  let msg = '', msgOk = false, busy = false;
  const say = (t, ok) => { msg = t; msgOk = !!ok; };
  const msgBox = () => msg ? el('p', { class: 'notes-msg' + (msgOk ? ' ok' : ''), role: 'status' }, msg) : null;

  /* ---------- the item list (for stocking shops and pricing) ---------- */
  let ledger = null, ledgerBusy = false;
  function loadLedger() {
    if (ledger || ledgerBusy) return;
    ledgerBusy = true;
    fetch('content/items.json').then(r => r.json()).then(j => { ledger = j; ledgerBusy = false; render(); }).catch(() => { ledgerBusy = false; });
  }
  const NOT_SOLD = new Set(['services', 'hire', 'craft', 'temple', 'arcane', 'info', 'leisure']);
  const ledgerItems = () => ledger ? ledger.items.filter(i => !NOT_SOLD.has(i.cat)) : [];
  const QUALS = () => (ledger && ledger.qualities) || [{ name: 'Normal', mult: 1 }];
  const qMult = q => { const Q = QUALS().find(x => x.name === q); return Q ? Number(Q.mult) || 1 : 1; };
  const ledgerItem = ref => ledger && ref ? ledger.items.find(i => i.id === ref) || null : null;
  /* materials: the same scaling as the character sheet (creator.js, "materials"). Gear is drawn up in steel, oak,
     cured leather or wool; each tier better alternately adds +1 damage and a bigger die, and for armour +1 Min hit and
     +20% temp HP per tier, +1 Defence every two (body armour and shields). Price: the item's, plus the difference in
     what its main material costs per kg. */
  const STD = { metal: 'steel-ingot-1-lb', wood: 'oak-plank', leather: 'cured-leather-hide', cloth: 'wool-cloth-1-sq-yd' };
  const matItem = id => ledger && id ? ledger.items.find(x => x.id === id && x.mat) || null : null;
  const stdMat = cls => matItem(((ledger && ledger.standardMaterials) || STD)[cls]);
  const perKg = m => m && Number(m.kg) ? Number(m.cp) / Number(m.kg) : 0;
  const matLabel = m => m ? m.name.replace(/\s*\((?:1 [^)]*|bundle|unfinished|thick)\)\s*$/i, '').replace(/ (ingot|plank|stave|cloth)$/i, '') : '';
  const DIES = [2, 4, 6, 8, 10, 12, 20];
  function scaleDice(dice, step) {
    if (!step || !dice) return dice;
    const m = String(dice).match(/^(\d*)d(\d+)(.*)$/i);
    const dieSteps = Math.trunc(step / 2), flat = step - 2 * dieSteps;
    if (!m) { const n = parseInt(dice, 10); return isNaN(n) ? dice : String(Math.max(1, n + step)); }
    let i = DIES.indexOf(parseInt(m[2], 10)), die = parseInt(m[2], 10), spare = i < 0 ? dieSteps : 0;
    if (i >= 0) { const want = i + dieSteps; i = Math.max(0, Math.min(DIES.length - 1, want)); spare = want - i; die = DIES[i]; }
    const rest = m[3] || '', k = rest.match(/^([+-]\d+)$/);
    const mod = (k ? parseInt(k[1], 10) : 0) + flat + spare * 2;
    const tail = k || !rest ? (mod ? (mod > 0 ? `+${mod}` : `${mod}`) : '') : rest + (flat ? (flat > 0 ? `+${flat}` : `${flat}`) : '');
    return `${m[1]}d${die}${tail}`;
  }
  // an item's fighting numbers in a material (and how many tiers that is from the standard)
  function fightIn(f, matId) {
    if (!f) return null;
    const M = matItem(matId || f.material), S = f.mat ? stdMat(f.mat) : null;
    if (!M || !S || M.mat !== f.mat) return { ...f, step: 0, matName: '' };
    const fx = M.fx && M.fx[f.kind === 'weapon' ? 'w' : 'a'];
    const step = Number(M.tier) - Number(S.tier), out = { ...f, step, matName: matLabel(M), ...(fx ? { fx } : {}) };
    if (!step) return out;
    if (f.kind === 'weapon') out.dice = scaleDice(f.dice, step);
    else if (f.kind === 'armour') {
      out.thp = Math.max(0, Math.round((f.thp | 0) * (1 + 0.2 * step)));
      if (f.slot === 'body' || f.slot === 'shield' || f.slot === 'mount') { out.minHit = Math.max(0, (f.minHit | 0) + step); out.def = Math.max(0, (f.def | 0) + Math.trunc(step / 2)); }
    }
    return out;
  }
  // the item list's price for something made of another material
  function priceIn(L, matId) {
    const f = L && L.fight, M = matItem(matId), S = f && f.mat ? stdMat(f.mat) : null;
    if (!L) return 0;
    if (!f || !M || !S || !f.kg) return L.cp;
    const cp = Math.max(Math.round(L.cp / 2), Math.round(L.cp + f.kg * (perKg(M) - perKg(S))));
    // a round figure: to the copper under a silver, the silver under 100 gold, the gold above
    return cp < 100 ? cp : cp < 1000000 ? Math.round(cp / 100) * 100 : Math.round(cp / 10000) * 10000;
  }
  const matOptions = (cls, cur) => {
    const S = stdMat(cls), all = (ledger ? ledger.items : []).filter(x => x.mat === cls);
    const tiers = [...new Set(all.map(x => Number(x.tier)))].sort((a, b) => a - b);
    return tiers.map(t => el('optgroup', { label: `Tier ${t}` }, ...all.filter(x => Number(x.tier) === t).sort((a, b) => (S && b.id === S.id) - (S && a.id === S.id) || matLabel(a).localeCompare(matLabel(b)))
      .map(m => { const st = Number(m.tier) - Number(S ? S.tier : 0); return el('option', { value: m.id, selected: m.id === cur }, `${matLabel(m)}${S && m.id === S.id ? ' (standard)' : st ? ` (${st > 0 ? '+' : '−'}${Math.abs(st)})` : ''}`); })));
  };

  /* ---------- the player's characters in this campaign ---------- */
  let mine = null, mineFor = '', mineBusy = false;
  async function loadMine() {
    if (mineBusy) return;
    mineBusy = true;
    const id = campId;
    const r = await sb().from('characters').select('id, name, owner_id, campaign_id, data').eq('campaign_id', id).order('name', { ascending: true });
    mineBusy = false;
    if (id !== campId) return;
    mine = (r.data || []).filter(c => admin() || c.owner_id === (user() || {}).id);
    mineFor = id;
    render();
  }
  const AS_KEY = 'hb-shop-as';
  let asChar = lsGet(AS_KEY), purse = null, purseFor = '';
  async function loadPurse(ch) {
    purseFor = ch;
    const r = await sb().from('money_tx').select('amount_cp').eq('campaign_id', campId).eq('character_id', ch);
    if (purseFor !== ch) return;
    purse = r.error ? null : (r.data || []).reduce((a, x) => a + Number(x.amount_cp || 0), 0);
    render();
  }

  /* ================= shops ================= */
  let shops = null, shopsFor = '', shopsErr = '', shopsBusy = false;
  let stock = [], offers = [], slog = [];
  let shopEdit = null, stockDraft = { name: '', q: 'Normal', qty: '', price: '', notes: '', mat: '' }, sellPick = '', sellQty = 1, sellAsk = '';
  async function loadShops() {
    if (shopsBusy) return;
    shopsBusy = true;
    const id = campId;
    const s = await sb().from('shops').select('*').eq('campaign_id', id).order('name', { ascending: true });
    if (s.error) { shopsBusy = false; shopsErr = missing(s.error) ? 'missing' : friendly(s.error); shops = []; shopsFor = id; render(); return; }
    const ids = (s.data || []).map(x => x.id);
    const [k, o, l] = await Promise.all([
      ids.length ? sb().from('shop_stock').select('*').in('shop_id', ids).order('name', { ascending: true }) : Promise.resolve({ data: [] }),
      sb().from('shop_offers').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
      sb().from('shop_log').select('*').eq('campaign_id', id).order('id', { ascending: false }).limit(40),
    ]);
    shopsBusy = false;
    if (id !== campId) return;
    shops = s.data || []; stock = k.data || []; offers = o.data || []; slog = l.data || []; shopsErr = ''; shopsFor = id;
    render();
  }
  const shopOf = id => (shops || []).find(s => s.id === id) || null;

  function shopsList(box, meta) {
    meta.textContent = '';
    if (!gate(box, 'Shops', 'Buy and sell at the shops your DM opens for your campaign. Sign in to visit them.')) return;
    if (shopsFor !== campId) { loadShops(); box.replaceChildren(el('div', { class: 'empty' }, 'Opening the shops…')); return; }
    if (shopsErr) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, shopsErr === 'missing' ? 'Shops aren’t set up yet' : 'Couldn’t open the shops'), shopsErr === 'missing' ? (admin() ? SETUP : 'The DM hasn’t switched them on yet.') : shopsErr)); return; }
    const pend = id => offers.filter(o => o.shop_id === id && o.status === 'pending').length;
    box.replaceChildren(el('div', { class: 'tb-list' },
      el('div', { class: 'tb-head' }, el('h1', { class: 'tb-title' }, 'Shops'), campSel(),
        admin() ? el('button', { class: 'btn small primary', onclick: () => { shopEdit = { name: '', place: '', blurb: '', price_pct: 100, sell_pct: 50, open: false }; go({ pick: 'new' }, true); } }, '+ New shop') : null),
      el('p', { class: 'd-note' }, admin() ? 'Players see a shop once you open it. Buying takes coin from the character’s purse at once; selling is an offer you accept or turn down.' : 'Buy with your character’s purse. What you buy waits on your character sheet to add to your inventory.'),
      shops.length ? el('div', { class: 'tb-rows' }, ...shops.map(s => el('button', { type: 'button', class: 'tb-row' + (state.pick === s.id ? ' on' : '') + (s.open ? '' : ' hidden'), 'aria-current': state.pick === s.id ? 'true' : null, onclick: () => { shopEdit = null; say(''); go({ pick: s.id }, true); } },
        el('span', { class: 'nm' }, s.name), s.place ? el('span', { class: 'sub' }, s.place) : null,
        admin() ? el('span', { class: 'tb-badge ' + (s.open ? 'on' : 'off') }, s.open ? 'Open' : 'Closed') : null,
        admin() && pend(s.id) ? el('span', { class: 'tb-badge warn' }, `${pend(s.id)} to answer`) : null)))
        : el('div', { class: 'empty' }, admin() ? 'No shops yet. Make one for the town the party is in.' : 'No shops are open right now.')));
  }

  function shopDetail(pane) {
    const id = state.pick;
    if (!user() || !id || shopsFor !== campId || !shops) return false;
    if (id === 'new' || (admin() && shopEdit && shopEdit.id === id)) { if (!admin()) return false; shopEditor(pane); return true; }
    const s = shopOf(id);
    if (!s) { pane.replaceChildren(el('button', { class: 'back', onclick: () => go({ pick: '' }, true) }, '← Shops'), el('div', { class: 'empty' }, 'That shop isn’t open.')); return true; }
    loadLedger();
    if (mineFor !== campId) loadMine();
    const chars = mine || [];
    if (!chars.some(c => c.id === asChar) && chars[0]) asChar = chars[0].id;
    if (asChar && purseFor !== asChar) loadPurse(asChar);
    const me = chars.find(c => c.id === asChar) || null;
    const rows = stock.filter(k => k.shop_id === s.id);
    const buy = async (k, n) => {
      if (!me) { say('Choose who’s buying first.'); render(); return; }
      busy = true; render();
      const r = await sb().rpc('shop_buy', { st: k.id, ch: me.id, n });
      busy = false;
      if (r.error) say(friendly(r.error));
      else say(`Bought ${n > 1 ? n + ' × ' : ''}${k.name} for ${r.data}. It’s waiting on ${me.name}’s sheet: open it and choose Add to my inventory.`, true);
      purseFor = ''; await loadShops();
    };
    const stockRows = rows.map(k => {
      const nIn = el('input', { type: 'number', class: 'num', min: '1', max: String(k.qty == null ? 999 : Math.max(1, k.qty)), value: '1', 'aria-label': `How many ${k.name}` });
      const L = ledgerItem(k.ref), f = fightIn(k.gear && k.gear.kind ? k.gear : L && L.fight, k.gear && k.gear.material);
      // quality adds to damage, and to Defence for body armour and shields (as on the character sheet)
      const sh = Number((QUALS().find(q => q.name === k.quality) || {}).shift) || 0;
      const def = f && f.kind === 'armour' ? (f.def | 0) + (f.slot === 'body' || f.slot === 'shield' ? sh : 0) : 0;
      const stats = f && f.kind === 'weapon' ? `${f.dice ? f.dice + (sh ? `+${sh}` : '') : 'no damage'} · ${f.stat}` : f && f.kind === 'armour' ? [def ? `Defence +${def}` : '', f.minHit ? `Min hit ${f.minHit}` : '', f.thp ? `${f.thp} temp HP` : ''].filter(Boolean).join(' · ') : '';
      return el('div', { class: 'tb-stock' + (k.qty === 0 ? ' out' : '') },
        el('span', { class: 'nm' }, k.name, (k.quality && k.quality !== 'Normal') || (f && (f.step || f.fx)) ? el('span', { class: 'q' }, ` (${[f && (f.step || f.fx) ? f.matName : '', k.quality !== 'Normal' ? k.quality : ''].filter(Boolean).join(', ')})`) : null,
          stats || k.notes ? el('span', { class: 'sub' }, [stats, k.notes].filter(Boolean).join(' · ')) : null,
          f && f.fx ? el('span', { class: 'sub fx' }, f.fx) : null),
        el('span', { class: 'pr' }, fmt(k.price_cp)),
        el('span', { class: 'left' }, k.qty == null ? '' : k.qty === 0 ? 'Sold out' : `${k.qty} left`),
        k.qty === 0 ? el('span') : el('span', { class: 'buy' }, nIn, el('button', { class: 'btn small primary', disabled: busy || !me, onclick: () => buy(k, Math.max(1, parseInt(nIn.value, 10) || 1)) }, 'Buy')));
    });
    // selling: something from the character's inventory, at the shop's share of its price
    const inv = me && me.data && Array.isArray(me.data.items) ? me.data.items.filter(x => x.name && x.qty > 0) : [];
    const pick = inv.find(x => x.id === sellPick) || null;
    const L = pick ? ledgerItem(pick.ref) : null;
    const worth = pick && L ? Math.floor(priceIn(L, pick.m || (L.fight && L.fight.material)) * qMult(pick.q || 'Normal') * (s.sell_pct / 100)) : null;
    const myOffers = offers.filter(o => o.shop_id === s.id && o.status === 'pending' && (admin() || chars.some(c => c.id === o.character_id)));
    const sell = async () => {
      if (!me || !pick) return;
      const n = Math.max(1, Math.min(pick.qty, sellQty | 0));
      const askCp = sellAsk.trim() ? parseCoin(sellAsk) : worth != null ? worth * n : null;
      if (askCp == null) { say('Write a price like 12 gp 5 sp.'); render(); return; }
      busy = true; render();
      const item = { name: pick.name, notes: pick.notes || '', ...(pick.ref ? { ref: pick.ref } : {}), ...(pick.q ? { q: pick.q } : {}), ...(pick.m ? { m: pick.m } : {}), ...(pick.g && pick.gc ? { g: pick.g } : {}) };
      const r = await sb().rpc('shop_offer', { sh: s.id, ch: me.id, item, n, ask: askCp });
      if (r.error) { busy = false; say(friendly(r.error)); render(); return; }
      // it leaves the sheet while the offer stands (it comes back if the DM turns it down)
      const data = JSON.parse(JSON.stringify(me.data));
      const it = data.items.find(x => x.id === pick.id);
      if (it) { it.qty -= n; if (it.qty <= 0) data.items = data.items.filter(x => x.id !== pick.id); }
      const u = await sb().from('characters').update({ data, updated_at: new Date().toISOString() }).eq('id', me.id);
      busy = false;
      if (!u.error) try { window.dispatchEvent(new CustomEvent('hb-character-changed', { detail: { id: me.id } })); } catch (e) { /* older browsers */ }
      say(u.error ? `Offered, but the sheet couldn’t be updated (${friendly(u.error)}): take ${pick.name} off it yourself.` : `Offered ${n > 1 ? n + ' × ' : ''}${pick.name} for ${fmt(askCp)}. The DM accepts or turns it down; if not, it goes back on your sheet.`, !u.error);
      sellPick = ''; sellAsk = ''; sellQty = 1; mine = null; mineFor = ''; await loadShops();
    };
    const answer = async (o, yes) => { busy = true; render(); const r = await sb().rpc('shop_offer_answer', { oid: o.id, accept: yes }); busy = false; say(r.error ? friendly(r.error) : yes ? `Paid ${fmt(o.ask_cp)} for ${o.item.name}.` : `Turned down: ${o.item.name} goes back to the sheet.`, !r.error); await loadShops(); };
    const takeBack = async o => { busy = true; render(); const r = await sb().rpc('shop_offer_cancel', { oid: o.id }); busy = false; say(r.error ? friendly(r.error) : `${o.item.name} is back on the sheet.`, !r.error); await loadShops(); };
    const charName = id => (chars.find(c => c.id === id) || {}).name || 'A character';
    pane.replaceChildren(...[
      el('button', { class: 'back', onclick: () => go({ pick: '' }, true) }, '← Shops'),
      el('div', { class: 'd-kicker' }, s.place ? el('span', {}, s.place) : null, admin() ? el('span', { class: 'tb-badge ' + (s.open ? 'on' : 'off') }, s.open ? 'Open to players' : 'Closed') : null,
        admin() ? el('span', { class: 'bs-fine' }, `Prices ${s.price_pct}% of the item list · buys at ${s.sell_pct}%`) : null),
      el('h1', { class: 'd-title' }, s.name),
      s.blurb ? el('p', { class: 'tb-blurb' }, s.blurb) : null,
      msgBox(),
      chars.length ? el('div', { class: 'tb-as' },
        el('label', {}, el('span', { class: 'k' }, admin() ? 'For' : 'Buying as'),
          el('select', { class: 'select', onchange: e => { asChar = e.target.value; lsSet(AS_KEY, asChar); purse = null; purseFor = ''; sellPick = ''; render(); } }, ...chars.map(c => el('option', { value: c.id, selected: c.id === asChar }, c.name)))),
        purse != null ? el('span', { class: 'tb-purse' }, `Purse: ${fmt(purse)}`) : null)
        : mine ? el('p', { class: 'd-note' }, admin() ? 'No characters in this campaign yet.' : 'You need a character in this campaign to buy here. Your DM adds characters to a campaign in Party money.') : null,
      el('h2', { class: 'section-head' }, 'For sale'),
      stockRows.length ? el('div', { class: 'tb-stocks' }, ...stockRows) : el('p', { class: 'd-note' }, 'Nothing on the shelves.'),
      me ? el('h2', { class: 'section-head' }, 'Sell something') : null,
      me ? el('div', { class: 'tb-sell' },
        inv.length ? el('div', { class: 'tb-form' },
          el('label', {}, el('span', { class: 'k' }, 'From your inventory'), el('select', { class: 'select', onchange: e => { sellPick = e.target.value; sellAsk = ''; sellQty = 1; render(); } },
            el('option', { value: '' }, 'Choose…'), ...inv.map(x => el('option', { value: x.id, selected: x.id === sellPick }, `${x.name}${x.q ? ` (${x.q})` : ''}${x.qty > 1 ? ` ×${x.qty}` : ''}`)))),
          pick && pick.qty > 1 ? el('label', {}, el('span', { class: 'k' }, 'How many'), el('input', { type: 'number', class: 'num', min: '1', max: String(pick.qty), value: String(sellQty), onchange: e => { sellQty = Math.max(1, Math.min(pick.qty, parseInt(e.target.value, 10) || 1)); render(); } })) : null,
          pick ? el('label', {}, el('span', { class: 'k' }, 'Asking'), el('input', { type: 'text', value: sellAsk, placeholder: worth != null ? fmt(worth * Math.max(1, sellQty)) : 'e.g. 5 gp', 'aria-label': 'Asking price', oninput: e => { sellAsk = e.target.value; } })) : null,
          pick ? el('button', { class: 'btn small', disabled: busy, onclick: sell }, 'Offer it') : null)
          : el('p', { class: 'd-note' }, `${me.name} has nothing in their inventory to sell.`),
        pick ? el('p', { class: 'hint' }, worth != null ? `The shop pays ${s.sell_pct}% of the item list’s price: ${fmt(worth)} each. You can ask for more or less; the DM decides.` : 'This isn’t on the item list, so write what you’re asking for it; the DM decides.') : null) : null,
      myOffers.length ? el('h2', { class: 'section-head' }, admin() ? 'Offers to answer' : 'Your offers') : null,
      myOffers.length ? el('div', { class: 'tb-offers' }, ...myOffers.map(o => el('div', { class: 'tb-offer' },
        el('span', { class: 'nm' }, `${charName(o.character_id)}: ${o.qty > 1 ? o.qty + ' × ' : ''}${o.item.name}${o.item.q ? ` (${o.item.q})` : ''}`),
        el('span', { class: 'pr' }, fmt(o.ask_cp)),
        admin() ? el('span', { class: 'btns' }, el('button', { class: 'btn small primary', disabled: busy, onclick: () => answer(o, true) }, 'Pay it'), el('button', { class: 'btn small', disabled: busy, onclick: () => answer(o, false) }, 'Turn it down'))
          : el('button', { class: 'mini', disabled: busy, onclick: () => takeBack(o) }, 'Take it back')))) : null,
      admin() ? stockEditor(s) : null,
      slog.some(x => x.shop_id === s.id) ? el('details', { class: 'tb-log' }, el('summary', {}, 'Recent sales'),
        el('ul', {}, ...slog.filter(x => x.shop_id === s.id).slice(0, 20).map(x => el('li', {}, `${day(x.created_at)}: ${charName(x.character_id)} ${x.kind === 'buy' ? 'bought' : 'sold'} ${x.qty > 1 ? x.qty + ' × ' : ''}${x.item} for ${fmt(x.total_cp)}`)))) : null,
      admin() ? el('div', { class: 'tb-actions' },
        el('button', { class: 'btn small', onclick: () => { shopEdit = { ...s }; render(); } }, 'Edit the shop'),
        el('button', { class: 'btn small' + (s.open ? '' : ' primary'), disabled: busy, onclick: async () => { busy = true; const r = await sb().from('shops').update({ open: !s.open }).eq('id', s.id); busy = false; say(r.error ? friendly(r.error) : s.open ? 'Closed: players can’t see it now.' : 'Open: players can see it and buy.', !r.error); await loadShops(); } }, s.open ? 'Close the shop' : 'Open it to players')) : null,
    ].filter(Boolean));
    document.title = `${s.name} · Shops · Player’s Handbook`;
    return true;
  }

  function stockEditor(s) {
    const D = stockDraft;
    const items = ledgerItems();
    const L = items.find(i => i.name.toLowerCase() === D.name.trim().toLowerCase()) || null;
    const LF = L && L.fight && L.fight.mat ? L.fight : null;
    if (!LF) D.mat = '';
    const suggest = L ? Math.round(priceIn(L, D.mat || (LF && LF.material)) * qMult(D.q) * s.price_pct / 100) : null;
    const add = async () => {
      const name = D.name.trim(); if (!name) { say('Name the item first.'); render(); return; }
      const price = D.price.trim() ? parseCoin(D.price) : suggest;
      if (price == null) { say('Write the price like 12 gp 5 sp (or pick something from the item list for its price).'); render(); return; }
      const qty = D.qty.trim() === '' ? null : Math.max(0, parseInt(D.qty, 10) || 0);
      busy = true; render();
      const r = await sb().from('shop_stock').insert({ shop_id: s.id, ref: L ? L.id : null, name: L ? L.name : name, quality: D.q || 'Normal', price_cp: price, qty, notes: D.notes.trim() || null,
        gear: LF && D.mat && D.mat !== (LF.material || (stdMat(LF.mat) || {}).id) ? { material: D.mat } : null });
      busy = false;
      if (r.error) { say(friendly(r.error)); render(); return; }
      stockDraft = { name: '', q: D.q, qty: '', price: '', notes: '', mat: '' }; say(`Added ${L ? L.name : name}.`, true);
      await loadShops();
    };
    const rows = stock.filter(k => k.shop_id === s.id);
    const nameIn = el('input', { type: 'text', list: 'tb-items', value: D.name, placeholder: 'Type to search the item list, or write your own', 'aria-label': 'Item to stock', oninput: e => { D.name = e.target.value; const hit = items.find(i => i.name.toLowerCase() === D.name.trim().toLowerCase()); if (hit) render(); } });
    return el('section', { class: 'tb-stockedit' },
      el('h2', { class: 'section-head' }, 'Stock (only you see this)'),
      rows.length ? el('div', { class: 'tb-stocks' }, ...rows.map(k => el('div', { class: 'tb-stock edit' },
        el('span', { class: 'nm' }, k.name, k.quality !== 'Normal' ? ` (${k.quality})` : ''),
        el('label', { class: 'pr' }, el('span', { class: 'sr-only' }, 'Price'), el('input', { type: 'text', value: fmt(k.price_cp), 'aria-label': `Price of ${k.name}`, onchange: async e => { const cp = parseCoin(e.target.value); if (cp == null) { say('Write the price like 12 gp 5 sp.'); render(); return; } await sb().from('shop_stock').update({ price_cp: cp }).eq('id', k.id); await loadShops(); } })),
        el('label', { class: 'left' }, el('span', { class: 'sr-only' }, 'How many'), el('input', { type: 'text', class: 'num', value: k.qty == null ? '' : String(k.qty), placeholder: 'Any', 'aria-label': `How many ${k.name} (empty for no limit)`, onchange: async e => { const v = e.target.value.trim(); await sb().from('shop_stock').update({ qty: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) }).eq('id', k.id); await loadShops(); } })),
        el('button', { class: 'mini danger', 'aria-label': `Remove ${k.name}`, onclick: async () => { await sb().from('shop_stock').delete().eq('id', k.id); await loadShops(); } }, 'Remove')))) : null,
      el('div', { class: 'tb-form' },
        el('label', { class: 'wide' }, el('span', { class: 'k' }, 'Item'), nameIn),
        LF ? el('label', {}, el('span', { class: 'k' }, 'Made of'), el('select', { class: 'select', onchange: e => { D.mat = e.target.value; render(); } }, ...matOptions(LF.mat, D.mat || LF.material || (stdMat(LF.mat) || {}).id))) : null,
        el('label', {}, el('span', { class: 'k' }, 'Quality'), el('select', { class: 'select', onchange: e => { D.q = e.target.value; render(); } }, ...QUALS().map(q => el('option', { value: q.name, selected: D.q === q.name }, q.name)))),
        el('label', {}, el('span', { class: 'k' }, 'How many'), el('input', { type: 'text', class: 'num', value: D.qty, placeholder: 'Any', oninput: e => { D.qty = e.target.value; } })),
        el('label', {}, el('span', { class: 'k' }, 'Price'), el('input', { type: 'text', value: D.price, placeholder: suggest != null ? fmt(suggest) : 'e.g. 12 gp', oninput: e => { D.price = e.target.value; } })),
        el('label', { class: 'wide' }, el('span', { class: 'k' }, 'Notes'), el('input', { type: 'text', value: D.notes, maxlength: '300', placeholder: 'Optional', oninput: e => { D.notes = e.target.value; } })),
        el('button', { class: 'btn small primary', disabled: busy, onclick: add }, 'Add to the shelves')),
      el('p', { class: 'hint' }, suggest != null ? `Item list price ${fmt(priceIn(L, D.mat || (LF && LF.material)))}${D.mat && LF && D.mat !== (LF.material || (stdMat(LF.mat) || {}).id) ? ` in ${matLabel(matItem(D.mat))}` : ''}${D.q !== 'Normal' ? ` × ${qMult(D.q)} for ${D.q}` : ''} at this shop’s ${s.price_pct}%: ${fmt(suggest)}. Leave Price empty to use it.` : 'Pick from the item list and the price is worked out from it (quality and this shop’s %). Weapons and armour from the list arrive with their fighting numbers.'),
      items.length ? el('datalist', { id: 'tb-items' }, ...items.map(i => el('option', { value: i.name }))) : null);
  }

  function shopEditor(pane) {
    const E = shopEdit || { name: '', place: '', blurb: '', price_pct: 100, sell_pct: 50, open: false };
    shopEdit = E;
    const save = async () => {
      if (!E.name.trim()) { say('Give the shop a name.'); render(); return; }
      busy = true; render();
      const row = { campaign_id: campId, name: E.name.trim().slice(0, 80), place: (E.place || '').trim() || null, blurb: (E.blurb || '').trim() || null,
        price_pct: Math.max(1, Math.min(1000, parseInt(E.price_pct, 10) || 100)), sell_pct: Math.max(0, Math.min(100, parseInt(E.sell_pct, 10) || 0)), open: !!E.open };
      const r = E.id ? await sb().from('shops').update(row).eq('id', E.id).select().single() : await sb().from('shops').insert(row).select().single();
      busy = false;
      if (r.error) { say(missing(r.error) ? SETUP : friendly(r.error)); render(); return; }
      shopEdit = null; say('Saved.', true);
      await loadShops(); go({ pick: r.data.id }, true);
    };
    const del = async () => {
      if (!E.id || !confirmDel) { confirmDel = true; render(); return; }
      busy = true; const r = await sb().from('shops').delete().eq('id', E.id); busy = false; confirmDel = false;
      if (r.error) { say(friendly(r.error)); render(); return; }
      shopEdit = null; say('Shop deleted.', true); await loadShops(); go({ pick: '' }, true);
    };
    const f = (label, input, hint) => el('label', { class: 'tb-f' }, el('span', { class: 'k' }, label), input, hint ? el('span', { class: 'hint' }, hint) : null);
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => { shopEdit = null; confirmDel = false; go({ pick: E.id || '' }, true); } }, E.id ? '← Back to the shop' : '← Shops'),
      el('h1', { class: 'd-title' }, E.id ? 'Edit the shop' : 'New shop'),
      msgBox(),
      el('div', { class: 'tb-edit' },
        f('Name', el('input', { type: 'text', value: E.name, maxlength: '80', placeholder: 'Brannock’s Forge', oninput: e => { E.name = e.target.value; } })),
        f('Where', el('input', { type: 'text', value: E.place || '', maxlength: '80', placeholder: 'Saltmere, by the harbour', oninput: e => { E.place = e.target.value; } })),
        f('What players see', el('textarea', { rows: '3', maxlength: '1000', oninput: e => { E.blurb = e.target.value; } }, E.blurb || '')),
        f('Prices (% of the item list)', el('input', { type: 'number', class: 'num', min: '1', max: '1000', value: String(E.price_pct), oninput: e => { E.price_pct = e.target.value; } }),
          'Set this for the town, supply and the party’s standing: 100 is the item list’s price. It sets the suggested price as you stock the shelves.'),
        f('Buys from players at (% of the item list)', el('input', { type: 'number', class: 'num', min: '0', max: '100', value: String(E.sell_pct), oninput: e => { E.sell_pct = e.target.value; } }), 'The item list’s usual is 50.'),
        el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!E.open, onchange: e => { E.open = e.target.checked; } }), ' Open to players')),
      el('div', { class: 'tb-actions' },
        el('button', { class: 'btn primary', disabled: busy, onclick: save }, E.id ? 'Save' : 'Make the shop'),
        E.id ? el('button', { class: 'btn danger', disabled: busy, onclick: del }, confirmDel ? 'Delete it and its stock?' : 'Delete the shop') : null));
    return true;
  }
  let confirmDel = false;

  /* ================= the contract board ================= */
  let jobs = null, jobsFor = '', jobsErr = '', jobsBusy = false, jobEdit = null;
  async function loadJobs() {
    if (jobsBusy) return;
    jobsBusy = true;
    const id = campId;
    const r = await sb().from('contracts').select('*').eq('campaign_id', id).order('created_at', { ascending: false });
    jobsBusy = false;
    if (id !== campId) return;
    if (r.error) { jobsErr = missing(r.error) ? 'missing' : friendly(r.error); jobs = []; jobsFor = id; render(); return; }
    jobs = r.data || []; jobsErr = ''; jobsFor = id;
    render();
  }
  const STATUS = { draft: 'Draft (only you see it)', open: 'Open', taken: 'Taken', done: 'Done', failed: 'Failed', withdrawn: 'Withdrawn' };
  function jobsList(box, meta) {
    meta.textContent = '';
    if (!gate(box, 'Contracts', 'The guild’s contract board for your campaign. Sign in to read it.')) return;
    if (jobsFor !== campId) { loadJobs(); box.replaceChildren(el('div', { class: 'empty' }, 'Opening the board…')); return; }
    if (jobsErr) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, jobsErr === 'missing' ? 'The contract board isn’t set up yet' : 'Couldn’t open the board'), jobsErr === 'missing' ? (admin() ? SETUP : 'The DM hasn’t switched it on yet.') : jobsErr)); return; }
    const row = k => el('button', { type: 'button', class: 'tb-row job ' + k.status + (state.pick === k.id ? ' on' : ''), 'aria-current': state.pick === k.id ? 'true' : null, onclick: () => { jobEdit = null; say(''); go({ pick: k.id }, true); } },
      el('span', { class: 'nm' }, k.title),
      el('span', { class: 'sub' }, [k.tier != null ? `Tier ${k.tier}` : '', k.reward_cp ? fmt(k.reward_cp) : '', k.client || ''].filter(Boolean).join(' · ')),
      k.status !== 'open' ? el('span', { class: 'tb-badge ' + k.status }, k.status === 'taken' ? `Taken by ${nameOf(k.taken_by)}` : STATUS[k.status]) : null);
    const grp = (title, list) => list.length ? el('section', { class: 'tb-grp' }, el('h2', { class: 'section-head' }, title), el('div', { class: 'tb-rows' }, ...list.map(row))) : null;
    box.replaceChildren(el('div', { class: 'tb-list' },
      el('div', { class: 'tb-head' }, el('h1', { class: 'tb-title' }, 'Contracts'), campSel(),
        admin() ? el('button', { class: 'btn small primary', onclick: () => { jobEdit = { title: '', client: '', tier: '', reward: '', deadline: '', details: '', status: 'draft' }; go({ pick: 'new' }, true); } }, '+ New contract') : null),
      el('p', { class: 'd-note' }, admin() ? 'Players see a contract once it’s posted. When you mark one done, its reward goes into the party account.' : 'Take on a contract for the party. The reward goes into the party account when the DM marks it done.'),
      grp('On the board', jobs.filter(k => k.status === 'open')),
      grp('Taken', jobs.filter(k => k.status === 'taken')),
      admin() ? grp('Drafts', jobs.filter(k => k.status === 'draft')) : null,
      grp('Finished', jobs.filter(k => k.status === 'done' || k.status === 'failed').slice(0, 20)),
      !jobs.some(k => admin() || k.status !== 'withdrawn') ? el('div', { class: 'empty' }, admin() ? 'No contracts yet.' : 'Nothing on the board right now.') : null));
  }
  async function closeJob(k, done, logFn) {
    busy = true; render();
    const r = await sb().rpc('contract_close', { k: k.id, done, pay: true });
    busy = false;
    if (r.error) { say(friendly(r.error)); render(); return false; }
    say(done ? `Done.${r.data ? ` ${r.data} paid into the party account.` : ''}` : 'Marked as failed.', true);
    if (logFn) logFn('contract', done ? `Contract done: ${k.title}${r.data ? ` (${r.data} to the party account)` : ''}` : `Contract failed: ${k.title}`);
    await loadJobs();
    return true;
  }
  function jobDetail(pane) {
    const id = state.pick;
    if (!user() || !id || jobsFor !== campId || !jobs) return false;
    if (id === 'new' || (admin() && jobEdit && jobEdit.id === id)) { if (!admin()) return false; jobEditor(pane); return true; }
    const k = jobs.find(x => x.id === id);
    if (!k) { pane.replaceChildren(el('button', { class: 'back', onclick: () => go({ pick: '' }, true) }, '← Contracts'), el('div', { class: 'empty' }, 'That contract isn’t on the board.')); return true; }
    const take = async yes => { busy = true; render(); const r = await sb().rpc('contract_take', { k: k.id, take: yes }); busy = false; say(r.error ? friendly(r.error) : yes ? 'Taken. Good hunting.' : 'Back on the board.', !r.error); await loadJobs(); };
    const setStatus = async st => { busy = true; render(); const r = await sb().from('contracts').update({ status: st }).eq('id', k.id); busy = false; say(r.error ? friendly(r.error) : st === 'open' ? 'Posted: players can see it.' : 'Withdrawn.', !r.error); await loadJobs(); };
    pane.replaceChildren(...[
      el('button', { class: 'back', onclick: () => go({ pick: '' }, true) }, '← Contracts'),
      el('div', { class: 'd-kicker' }, k.tier != null ? el('span', { class: 'badge' }, `Tier ${k.tier}`) : null, k.client ? el('span', {}, k.client) : null, el('span', { class: 'tb-badge ' + k.status }, k.status === 'taken' ? `Taken by ${nameOf(k.taken_by)}` : STATUS[k.status])),
      el('h1', { class: 'd-title' }, k.title),
      msgBox(),
      el('dl', { class: 'tb-facts' },
        el('dt', {}, 'Reward'), el('dd', {}, k.reward_cp ? fmt(k.reward_cp) : 'None named'),
        k.deadline ? el('dt', {}, 'By') : null, k.deadline ? el('dd', {}, k.deadline) : null,
        el('dt', {}, 'Posted'), el('dd', {}, day(k.created_at))),
      k.details ? el('div', { class: 'tb-details' }, ...String(k.details).split(/\n{2,}/).map(p => el('p', {}, p))) : null,
      el('div', { class: 'tb-actions' },
        k.status === 'open' ? el('button', { class: 'btn primary', disabled: busy, onclick: () => take(true) }, 'We’ll take it') : null,
        k.status === 'taken' && (k.taken_by === (user() || {}).id || admin()) ? el('button', { class: 'btn small', disabled: busy, onclick: () => take(false) }, 'Give it up') : null,
        admin() && (k.status === 'open' || k.status === 'taken') ? el('button', { class: 'btn small primary', disabled: busy, onclick: () => closeJob(k, true) }, k.reward_cp ? `Done: pay ${fmt(k.reward_cp)} to the party` : 'Done') : null,
        admin() && (k.status === 'open' || k.status === 'taken') ? el('button', { class: 'btn small', disabled: busy, onclick: () => closeJob(k, false) }, 'Failed') : null,
        admin() && k.status === 'draft' ? el('button', { class: 'btn small primary', disabled: busy, onclick: () => setStatus('open') }, 'Post it on the board') : null,
        admin() && k.status === 'open' ? el('button', { class: 'mini', disabled: busy, onclick: () => setStatus('withdrawn') }, 'Withdraw it') : null,
        admin() ? el('button', { class: 'mini', onclick: () => { jobEdit = { id: k.id, title: k.title, client: k.client || '', tier: k.tier == null ? '' : String(k.tier), reward: k.reward_cp ? fmt(k.reward_cp) : '', deadline: k.deadline || '', details: k.details || '', status: k.status }; render(); } }, 'Edit') : null),
    ].filter(Boolean));
    document.title = `${k.title} · Contracts · Player’s Handbook`;
    return true;
  }
  function jobEditor(pane) {
    const E = jobEdit || { title: '', client: '', tier: '', reward: '', deadline: '', details: '', status: 'draft' };
    jobEdit = E;
    const save = async post => {
      if (!E.title.trim()) { say('Give the contract a title.'); render(); return; }
      const reward = E.reward.trim() ? parseCoin(E.reward) : 0;
      if (reward == null) { say('Write the reward like 250 gp.'); render(); return; }
      const tier = E.tier === '' ? null : Math.max(0, Math.min(20, parseInt(E.tier, 10) || 0));
      busy = true; render();
      const row = { campaign_id: campId, title: E.title.trim().slice(0, 120), client: E.client.trim() || null, tier, reward_cp: reward, deadline: E.deadline.trim() || null, details: E.details.trim() || null,
        status: post && E.status === 'draft' ? 'open' : E.status };
      const r = E.id ? await sb().from('contracts').update(row).eq('id', E.id).select().single() : await sb().from('contracts').insert(row).select().single();
      busy = false;
      if (r.error) { say(missing(r.error) ? SETUP : friendly(r.error)); render(); return; }
      jobEdit = null; say(row.status === 'open' && post ? 'Posted: players can see it.' : 'Saved.', true);
      await loadJobs(); go({ pick: r.data.id }, true);
    };
    const del = async () => {
      if (!E.id || !confirmDel) { confirmDel = true; render(); return; }
      busy = true; const r = await sb().from('contracts').delete().eq('id', E.id); busy = false; confirmDel = false;
      if (r.error) { say(friendly(r.error)); render(); return; }
      jobEdit = null; say('Deleted.', true); await loadJobs(); go({ pick: '' }, true);
    };
    const f = (label, input, hint) => el('label', { class: 'tb-f' }, el('span', { class: 'k' }, label), input, hint ? el('span', { class: 'hint' }, hint) : null);
    pane.replaceChildren(
      el('button', { class: 'back', onclick: () => { jobEdit = null; confirmDel = false; go({ pick: E.id || '' }, true); } }, E.id ? '← Back to the contract' : '← Contracts'),
      el('h1', { class: 'd-title' }, E.id ? 'Edit the contract' : 'New contract'),
      msgBox(),
      el('div', { class: 'tb-edit' },
        f('Title', el('input', { type: 'text', value: E.title, maxlength: '120', placeholder: 'Clear the drowned mill', oninput: e => { E.title = e.target.value; } })),
        f('Client', el('input', { type: 'text', value: E.client, maxlength: '80', placeholder: 'Saltmere council', oninput: e => { E.client = e.target.value; } })),
        el('div', { class: 'tb-two' },
          f('Guild tier', el('input', { type: 'number', class: 'num', min: '0', max: '20', value: E.tier, oninput: e => { E.tier = e.target.value; } })),
          f('Reward', el('input', { type: 'text', value: E.reward, placeholder: '250 gp', oninput: e => { E.reward = e.target.value; } }), 'Paid into the party account when you mark it done.')),
        f('Deadline', el('input', { type: 'text', value: E.deadline, maxlength: '60', placeholder: 'Before the spring tide', oninput: e => { E.deadline = e.target.value; } })),
        f('Details', el('textarea', { rows: '6', maxlength: '3000', oninput: e => { E.details = e.target.value; } }, E.details))),
      el('div', { class: 'tb-actions' },
        E.status === 'draft' ? el('button', { class: 'btn primary', disabled: busy, onclick: () => save(true) }, 'Post it on the board') : null,
        el('button', { class: 'btn' + (E.status === 'draft' ? '' : ' primary'), disabled: busy, onclick: () => save(false) }, E.status === 'draft' ? 'Save as a draft' : 'Save'),
        E.id ? el('button', { class: 'btn danger', disabled: busy, onclick: del }, confirmDel ? 'Delete it for good?' : 'Delete') : null));
    return true;
  }

  /* ================= handouts ================= */
  const signed = new Map();   // image path → { url, at }
  async function sign(paths) {
    const need = [...new Set(paths)].filter(p => p && (!signed.has(p) || Date.now() - signed.get(p).at > 50 * 60000));
    if (!need.length || !sb() || !sb().storage) return;
    try {
      const r = await sb().storage.from('handouts').createSignedUrls(need, 3600);
      for (const x of (r.data || [])) if (x.signedUrl) signed.set(x.path, { url: x.signedUrl, at: Date.now() });
      render();
    } catch (e) { /* no picture then */ }
  }
  const picOf = h => h.image_path ? (signed.get(h.image_path) || {}).url || null : h.image_url || null;
  // big pictures are shrunk before they're sent: at most 2000px on the long side, as WebP (JPEG if the browser can't)
  async function shrink(file) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file isn’t a picture the browser can read.')); i.src = URL.createObjectURL(file); });
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise(res => cv.toBlob(res, 'image/webp', 0.85));
    if (blob && blob.type === 'image/webp') return { blob, ext: 'webp', type: 'image/webp' };
    const jpg = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
    return { blob: jpg, ext: 'jpg', type: 'image/jpeg' };
  }
  function handoutView(h, big) {
    const pic = picOf(h);
    if (h.image_path && !pic) sign([h.image_path]);
    return el('article', { class: 'ho' + (big ? ' big' : '') },
      el('h2', { class: 'ho-t' }, h.title),
      pic ? el('img', { class: 'ho-img', src: pic, alt: h.title, referrerpolicy: 'no-referrer' }) : null,
      h.body ? el('div', { class: 'ho-body' }, ...String(h.body).split(/\n{2,}/).map(p => el('p', {}, p))) : null,
      h.shown_at ? el('p', { class: 'bs-fine' }, `Shown ${when(h.shown_at)}`) : null);
  }
  async function openHandout(h) {
    if (h.image_path && !picOf(h)) await sign([h.image_path]);   // the private link first, so the picture is there when it opens
    if (document.querySelector('.ho-dlg')) return;
    const dlg = el('dialog', { class: 'hb-dialog ho-dlg', 'aria-label': h.title });
    dlg.append(el('div', { class: 'dlg' }, el('button', { class: 'dlg-x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'),
      el('p', { class: 'ho-kick' }, 'From the DM'), handoutView(h, true),
      el('div', { class: 'tb-actions' }, el('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Close'))));
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }
  // players: a handout the DM has just shown pops up, wherever they are on the site
  let hoAll = null, hoTimer = 0, hoCh = null, hoBusy = false;
  const seenKey = () => 'hb-handout-seen:' + ((user() || {}).id || '');
  async function pollHandouts() {
    if (hoBusy || !sb() || !user()) return;
    hoBusy = true;
    const r = await sb().from('handouts').select('*').eq('shown', true).order('shown_at', { ascending: false }).limit(40);
    hoBusy = false;
    if (r.error) { hoAll = []; return; }
    const was = JSON.stringify((hoAll || []).map(h => h.id + h.shown_at));
    hoAll = r.data || [];
    if (!admin()) {
      const seen = lsGet(seenKey());
      const newest = hoAll[0] && hoAll[0].shown_at;
      if (!seen) { if (newest) lsSet(seenKey(), newest); else lsSet(seenKey(), new Date().toISOString()); }
      else {
        const fresh = hoAll.filter(h => h.shown_at && h.shown_at > seen).reverse();
        if (fresh.length) { lsSet(seenKey(), fresh[fresh.length - 1].shown_at); if (!document.querySelector('.ho-dlg')) openHandout(fresh[fresh.length - 1]); }
      }
    }
    if (JSON.stringify(hoAll.map(h => h.id + h.shown_at)) !== was && (state.tab === 'notes' || state.tab === 'screen' || (state.tab === 'all' && !state.q))) render();
  }
  function watchHandouts() {
    if (hoTimer) return;
    pollHandouts();
    hoTimer = setInterval(() => { if (user() && document.visibilityState === 'visible') pollHandouts(); }, 20000);
    try {
      if (sb() && sb().channel && !hoCh) hoCh = sb().channel('handouts-live').on('postgres_changes', { event: '*', schema: 'public', table: 'handouts' }, () => pollHandouts()).subscribe();
    } catch (e) { hoCh = null; }
  }
  // under Notes: everything shown so far
  function handoutsCard() {
    if (!user()) return null;
    if (hoAll === null) { pollHandouts(); return null; }
    if (!hoAll.length) return null;
    const cname = id => ((camps || []).find(c => c.id === id) || {}).name || '';
    if (!camps) loadCamps();
    return el('section', { class: 'ho-list' }, el('h2', { class: 'section-head' }, 'Handouts'),
      el('div', { class: 'tb-rows' }, ...hoAll.slice(0, 12).map(h => el('button', { type: 'button', class: 'tb-row', onclick: () => openHandout(h) },
        el('span', { class: 'nm' }, h.title), el('span', { class: 'sub' }, [day(h.shown_at), (camps || []).length > 1 ? cname(h.campaign_id) : ''].filter(Boolean).join(' · '))))));
  }
  // the DM's handouts for a campaign (on the Session screen)
  let hoDm = null, hoDmFor = '', hoDraft = { title: '', body: '', url: '', file: null }, hoErr = '';
  async function loadDmHandouts(c) {
    hoDmFor = c;
    const r = await sb().from('handouts').select('*').eq('campaign_id', c).order('created_at', { ascending: false });
    if (hoDmFor !== c) return;
    hoErr = r.error ? (missing(r.error) ? 'missing' : friendly(r.error)) : '';
    hoDm = r.data || [];
    sign(hoDm.map(h => h.image_path));
    render();
  }
  function dmHandoutsCard(c, logFn) {
    if (hoDmFor !== c) { hoDm = null; loadDmHandouts(c); }
    const D = hoDraft;
    const add = async show => {
      if (!D.title.trim()) { hoMsg = 'Give the handout a title.'; render(); return; }
      busy = true; hoMsg = 'Saving…'; render();
      const row = { campaign_id: c, title: D.title.trim().slice(0, 120), body: D.body.trim() || null, image_url: !D.file && D.url.trim() ? D.url.trim() : null, shown: !!show, shown_at: show ? new Date().toISOString() : null };
      const r = await sb().from('handouts').insert(row).select().single();
      if (r.error) { busy = false; hoMsg = missing(r.error) ? SETUP : friendly(r.error); render(); return; }
      if (D.file) {
        try {
          const s = await shrink(D.file);
          const path = `${r.data.id}/${Date.now().toString(36)}.${s.ext}`;
          const up = await sb().storage.from('handouts').upload(path, s.blob, { contentType: s.type, upsert: false });
          if (up.error) throw up.error;
          await sb().from('handouts').update({ image_path: path }).eq('id', r.data.id);
        } catch (e) { hoMsg = 'Saved, but the picture didn’t upload: ' + friendly(e); }
      }
      busy = false;
      if (!/didn’t upload/.test(hoMsg)) hoMsg = show ? 'Shown to the players.' : 'Saved. Show it when the moment comes.';
      if (show && logFn) logFn('handout', `Handout shown: ${row.title}`);
      hoDraft = { title: '', body: '', url: '', file: null };
      await loadDmHandouts(c);
    };
    const toggle = async h => {
      busy = true; render();
      const r = await sb().from('handouts').update({ shown: !h.shown, shown_at: h.shown ? h.shown_at : new Date().toISOString() }).eq('id', h.id);
      busy = false; hoMsg = r.error ? friendly(r.error) : h.shown ? 'Hidden again.' : 'Shown to the players.';
      if (!r.error && !h.shown && logFn) logFn('handout', `Handout shown: ${h.title}`);
      await loadDmHandouts(c);
    };
    const del = async h => {
      busy = true; render();
      if (h.image_path) try { await sb().storage.from('handouts').remove([h.image_path]); } catch (e) { /* the row goes anyway */ }
      const r = await sb().from('handouts').delete().eq('id', h.id);
      busy = false; hoMsg = r.error ? friendly(r.error) : 'Deleted.';
      await loadDmHandouts(c);
    };
    if (hoErr === 'missing') return el('p', { class: 'd-note' }, SETUP);
    const fileIn = el('input', { type: 'file', accept: 'image/*', 'aria-label': 'Picture for the handout', onchange: e => { D.file = e.target.files && e.target.files[0] || null; } });
    return el('div', { class: 'ho-dm' },
      el('p', { class: 'd-note' }, 'A letter, a wanted poster, a map scrap. Players see it pop up on their screens when you show it, and it stays under their Notes.'),
      hoMsg ? el('p', { class: 'notes-msg' + (/^(Shown|Saved|Hidden|Deleted)/.test(hoMsg) ? ' ok' : ''), role: 'status' }, hoMsg) : null,
      el('div', { class: 'tb-form ho-form' },
        el('label', { class: 'wide' }, el('span', { class: 'k' }, 'Title'), el('input', { type: 'text', value: D.title, maxlength: '120', placeholder: 'A sealed letter', oninput: e => { D.title = e.target.value; } })),
        el('label', { class: 'wide' }, el('span', { class: 'k' }, 'Text'), el('textarea', { rows: '3', maxlength: '5000', placeholder: 'What it says (optional)', oninput: e => { D.body = e.target.value; } }, D.body)),
        el('label', {}, el('span', { class: 'k' }, 'Picture'), fileIn),
        el('label', {}, el('span', { class: 'k' }, 'Or a link to one'), el('input', { type: 'url', value: D.url, placeholder: 'https://…', oninput: e => { D.url = e.target.value; } })),
        el('div', { class: 'tb-actions wide' },
          el('button', { class: 'btn small primary', disabled: busy, onclick: () => add(true) }, 'Show it now'),
          el('button', { class: 'btn small', disabled: busy, onclick: () => add(false) }, 'Save for later'))),
      hoDm && hoDm.length ? el('ul', { class: 'ho-dmlist' }, ...hoDm.slice(0, 15).map(h => el('li', {},
        el('button', { type: 'button', class: 'linkbtn', onclick: () => openHandout(h) }, h.title),
        el('span', { class: 'tb-badge ' + (h.shown ? 'on' : 'off') }, h.shown ? `Shown ${day(h.shown_at)}` : 'Not shown'),
        el('button', { class: 'mini', disabled: busy, onclick: () => toggle(h) }, h.shown ? 'Hide' : 'Show'),
        el('button', { class: 'mini danger', disabled: busy, onclick: () => del(h) }, 'Delete')))) : null);
  }
  let hoMsg = '';

  /* ================= the next session ================= */
  let next = null, nextFor = '', nextErr = '', nextBusy = false;
  const nextAll = new Map();   // campaign → { row, votes } for the home page
  async function loadNext(c) {
    if (nextBusy) return;
    nextBusy = true;
    const [n, v] = await Promise.all([sb().from('next_session').select('*').eq('campaign_id', c).maybeSingle(), sb().from('next_session_votes').select('*').eq('campaign_id', c)]);
    nextBusy = false;
    if (n.error) { nextErr = missing(n.error) ? 'missing' : friendly(n.error); next = { row: null, votes: [] }; nextFor = c; render(); return; }
    nextErr = ''; next = { row: n.data || null, votes: v.data || [] }; nextFor = c;
    nextAll.set(c, next);
    render();
  }
  const optLabel = o => o.label ? `${when(o.at)} (${o.label})` : when(o.at);
  async function vote(c, o, ans) {
    const me = (user() || {}).id;
    const cur = (next && next.votes || []).find(v => v.user_id === me && v.option_id === o.id);
    const r = cur && cur.answer === ans
      ? await sb().from('next_session_votes').delete().eq('campaign_id', c).eq('user_id', me).eq('option_id', o.id)
      : await sb().from('next_session_votes').upsert({ campaign_id: c, user_id: me, option_id: o.id, answer: ans });
    if (r.error) { say(friendly(r.error)); }
    await loadNext(c);
  }
  // players: answer the dates, or see the one chosen
  function nextCard(c, compact) {
    c = c || campId;
    if (!c || !user()) return null;
    if (nextFor !== c && !nextBusy) { loadNext(c); return null; }
    if (!next || nextErr) return null;
    const row = next.row, opts = row && Array.isArray(row.options) ? row.options : [];
    const chosen = row && row.chosen ? opts.find(o => o.id === row.chosen) : null;
    if (!row || (!chosen && !opts.length)) return null;
    if (chosen) return el('div', { class: 'ns ns-chosen' }, el('span', { class: 'k' }, 'Next session'), el('span', { class: 'v' }, optLabel(chosen)), row.note ? el('span', { class: 'bs-fine' }, row.note) : null);
    const me = (user() || {}).id;
    return el('div', { class: 'ns' }, el('span', { class: 'k' }, 'Next session: when can you play?'), row.note ? el('span', { class: 'bs-fine' }, row.note) : null,
      el('div', { class: 'ns-opts' }, ...opts.map(o => {
        const mineV = (next.votes.find(v => v.user_id === me && v.option_id === o.id) || {}).answer;
        const n = a => next.votes.filter(v => v.option_id === o.id && v.answer === a).length;
        return el('div', { class: 'ns-opt' }, el('span', { class: 'when' }, optLabel(o)),
          el('span', { class: 'bs-seg seg ns-ans', role: 'group', 'aria-label': `Can you play ${optLabel(o)}?` },
            ...[['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']].map(([a, t]) => el('button', { type: 'button', class: mineV === a ? 'on' : null, 'aria-pressed': String(mineV === a), onclick: () => vote(c, o, a) }, t))),
          compact ? null : el('span', { class: 'bs-fine' }, `${n('yes')} yes · ${n('maybe')} maybe · ${n('no')} no`));
      })));
  }
  // the DM: offer dates, see who can come, pick one
  let nsAdd = '', nsLabel = '';
  function dmNextCard(c) {
    if (nextFor !== c && !nextBusy) { loadNext(c); return el('p', { class: 'bs-fine' }, 'Opening…'); }
    if (nextErr === 'missing') return el('p', { class: 'd-note' }, SETUP);
    const row = (next && next.row) || { campaign_id: c, options: [], chosen: null, note: '' };
    const opts = Array.isArray(row.options) ? row.options : [];
    const save = async patch => {
      const r = await sb().from('next_session').upsert({ campaign_id: c, options: opts, chosen: row.chosen || null, note: row.note || null, ...patch, updated_at: new Date().toISOString() });
      if (r.error) say(friendly(r.error));
      await loadNext(c);
    };
    const add = () => { if (!nsAdd) return; const o = { id: uid(), at: nsAdd, ...(nsLabel.trim() ? { label: nsLabel.trim().slice(0, 40) } : {}) }; nsAdd = ''; nsLabel = ''; save({ options: [...opts, o].slice(0, 12) }); };
    const who = (o, a) => next.votes.filter(v => v.option_id === o.id && v.answer === a).map(v => nameOf(v.user_id));
    if (!profiles.length && !camps) loadCamps();
    return el('div', { class: 'ns-dm' },
      opts.length ? el('div', { class: 'ns-opts' }, ...opts.map(o => el('div', { class: 'ns-opt' + (row.chosen === o.id ? ' on' : '') },
        el('span', { class: 'when' }, optLabel(o)),
        el('span', { class: 'bs-fine' }, ['yes', 'maybe', 'no'].map(a => { const w = who(o, a); return `${a === 'yes' ? 'Yes' : a === 'maybe' ? 'Maybe' : 'No'}: ${w.length ? w.join(', ') : '—'}`; }).join(' · ')),
        el('span', { class: 'btns' },
          row.chosen === o.id ? el('button', { class: 'mini', onclick: () => save({ chosen: null }) }, 'Unpick') : el('button', { class: 'btn small', onclick: () => save({ chosen: o.id }) }, 'Pick this one'),
          el('button', { class: 'mini danger', 'aria-label': `Remove ${optLabel(o)}`, onclick: () => save({ options: opts.filter(x => x.id !== o.id), chosen: row.chosen === o.id ? null : row.chosen }) }, 'Remove'))))) : el('p', { class: 'd-note' }, 'Offer a few dates; players answer on their home page and in Notes.'),
      el('div', { class: 'tb-form' },
        el('label', {}, el('span', { class: 'k' }, 'Date and time'), el('input', { type: 'datetime-local', value: nsAdd, oninput: e => { nsAdd = e.target.value; } })),
        el('label', {}, el('span', { class: 'k' }, 'Where (optional)'), el('input', { type: 'text', value: nsLabel, maxlength: '40', placeholder: 'At the usual place', oninput: e => { nsLabel = e.target.value; } })),
        el('button', { class: 'btn small', onclick: add }, 'Offer this date')),
      el('label', { class: 'tb-f' }, el('span', { class: 'k' }, 'Note for the players'), el('input', { type: 'text', value: row.note || '', maxlength: '300', placeholder: 'Bring snacks', onchange: e => save({ note: e.target.value.trim() || null }) })),
      opts.length ? el('div', { class: 'tb-actions' }, el('button', { class: 'mini', onclick: async () => { await sb().from('next_session_votes').delete().eq('campaign_id', c); await save({ options: [], chosen: null }); } }, 'Clear the dates and answers')) : null);
  }

  /* ================= the table screen ================= */
  const SCR_KEY = 'hb-screen-camp';
  let scr = { camp: lsGet(SCR_KEY), fight: null, rolls: [], screen: null, ho: null, key: '' }, scrTimer = 0, scrBusy = false;
  async function loadScreen() {
    if (scrBusy || !scr.camp) return;
    scrBusy = true;
    const c = scr.camp;
    const [f, r, s, h] = await Promise.all([
      sb().from('fight_view').select('data').eq('campaign_id', c).maybeSingle(),
      sb().from('rolls').select('*').eq('campaign_id', c).order('created_at', { ascending: false }).limit(12),
      sb().from('table_screen').select('data').eq('campaign_id', c).maybeSingle(),
      sb().from('handouts').select('*').eq('campaign_id', c).eq('shown', true).order('shown_at', { ascending: false }).limit(1),
    ]);
    scrBusy = false;
    if (c !== scr.camp) return;
    const A = H.Atlas && H.Atlas.api, ar = A ? A.rows() : null;
    const next = { fight: f.error ? null : (f.data && f.data.data) || null, rolls: (r.data || []).filter(x => !x.hidden).slice(0, 8), screen: s.error ? null : (s.data && s.data.data) || null, ho: (h.data || [])[0] || null,
      atlas: ar ? ar.length : -1 };   // so the map list redraws once the atlas has loaded
    const key = JSON.stringify(next);
    if (key !== scr.key) { Object.assign(scr, next, { key }); if (state.tab === 'screen') render(); }
  }
  function screenView(box, meta) {
    meta.textContent = '';
    document.title = 'Table screen · Player’s Handbook';
    if (!gate(box, 'Table screen', 'Put this on a TV at the table: the turn order, the dice, a map and the latest handout. Sign in first.')) return;
    if (!camps.some(c => c.id === scr.camp)) { scr.camp = camps[0].id; scr.key = ''; }
    if (!scrTimer) {
      loadScreen();
      scrTimer = setInterval(() => { if (state.tab !== 'screen') { clearInterval(scrTimer); scrTimer = 0; document.body.classList.remove('ts-on'); return; } if (document.visibilityState === 'visible') loadScreen(); }, 4000);
    }
    document.body.classList.add('ts-on');
    const d = scr.fight;
    const fighting = d && d.active && Array.isArray(d.order) && d.order.length;
    const A = H.Atlas && H.Atlas.api;
    const rowsA = A ? A.rows() : null;
    if (A && rowsA === null) A.load();
    const maps = (rowsA || []).filter(x => x.revealed && (x.image_path || x.image_url));
    const mapId = scr.screen && scr.screen.map;
    const mapRow = maps.find(x => x.id === mapId) || null;
    // the latest handout shows for 15 minutes after it's shown, unless the DM takes it down
    const showHo = scr.ho && Date.now() - Date.parse(scr.ho.shown_at) < 15 * 60000 && !(scr.screen && scr.screen.hoHidden === scr.ho.id) ? scr.ho : null;
    const setScreen = async patch => {
      const data = { ...(scr.screen || {}), ...patch };
      const r = await sb().from('table_screen').upsert({ campaign_id: scr.camp, data, updated_at: new Date().toISOString() });
      if (r.error) { say(missing(r.error) ? SETUP : friendly(r.error)); render(); return; }
      scr.key = ''; loadScreen();
    };
    const order = fighting ? el('section', { class: 'ts-card ts-fight' },
      el('h2', {}, d.started ? `Round ${d.round}` : 'A fight is about to start'),
      el('ol', { class: 'ts-order' }, ...d.order.map(x => el('li', { class: 'ts-row ' + x.side + (x.now ? ' now' : '') + (x.health === 'Down' ? ' down' : '') },
        el('span', { class: 'nm' }, x.name),
        el('span', { class: 'hp' }, x.side === 'party' && x.max ? `${x.hp} / ${x.max}` : x.health || ''),
        x.statuses && x.statuses.length ? el('span', { class: 'sts' }, x.statuses.join(', ')) : null,
        x.saves ? el('span', { class: 'sts' }, x.saves.pass >= 3 ? 'Stable' : x.saves.fail >= 3 ? 'Dead' : `Death saves ${x.saves.pass}/${x.saves.fail}`) : null)))) : null;
    const rolls = el('section', { class: 'ts-card ts-rolls' }, el('h2', {}, 'The dice'),
      scr.rolls.length ? el('ol', { class: 'ts-rl' }, ...scr.rolls.map(x => {
        const o = x.detail && x.detail.outcome;
        return el('li', { class: o ? o : '' }, el('span', { class: 'n' }, String(x.total)), el('span', { class: 't' }, el('strong', {}, x.who || ''), ' ', x.what || '', o ? el('span', { class: 'o' }, o === 'pass' || o === 'success' ? ' · Success' : o === 'fail' ? ' · Fail' : o === 'dead' ? ' · Death' : ` · ${o}`) : null));
      })) : el('p', { class: 'ts-none' }, 'No rolls yet.'));
    const main = showHo ? el('section', { class: 'ts-card ts-ho' }, handoutView(showHo, true))
      : mapRow && H.Atlas.figure ? el('section', { class: 'ts-card ts-map' }, el('h2', {}, mapRow.name), H.Atlas.figure(mapRow.id, { bare: true }))
      : el('section', { class: 'ts-card ts-idle' }, el('p', {}, admin() ? 'Choose a map below to show here. Handouts you show appear here for 15 minutes.' : 'The DM chooses what shows here.'));
    const controls = el('div', { class: 'ts-controls' },
      camps.length > 1 ? el('select', { class: 'select', 'aria-label': 'Campaign', onchange: e => { scr.camp = e.target.value; lsSet(SCR_KEY, scr.camp); scr.key = ''; loadScreen(); render(); } }, ...camps.map(c => el('option', { value: c.id, selected: c.id === scr.camp }, c.name))) : null,
      admin() ? el('select', { class: 'select', 'aria-label': 'Map to show', onchange: e => setScreen({ map: e.target.value || null }) },
        el('option', { value: '' }, maps.length ? 'No map' : 'No revealed maps yet'), ...maps.map(m => el('option', { value: m.id, selected: m.id === mapId }, m.name))) : null,
      showHo && admin() ? el('button', { class: 'mini', onclick: () => setScreen({ hoHidden: showHo.id }) }, 'Stop showing the handout') : null,
      el('button', { class: 'btn small', onclick: () => { const t = document.documentElement; if (document.fullscreenElement) document.exitFullscreen(); else if (t.requestFullscreen) t.requestFullscreen().catch(() => {}); } }, 'Full screen'),
      el('button', { class: 'mini', onclick: () => go({ tab: 'all' }, true) }, 'Leave'));
    box.replaceChildren(el('div', { class: 'ts' + (fighting ? ' fighting' : '') },
      el('div', { class: 'ts-main' }, main),
      el('div', { class: 'ts-side' }, order, rolls),
      msgBox(), controls));
  }

  /* ================= the DM's cards for the Session screen ================= */
  function dmCards(c, logFn) {
    if (c !== campId) { campId = c; jobs = null; }
    if (jobsFor !== c && !jobsBusy) loadJobs();
    const live = (jobs || []).filter(k => k.status === 'open' || k.status === 'taken');
    const card = (title, ...kids) => el('section', { class: 'lab-card ss-card' }, el('h2', { class: 'section-head' }, title), ...kids);
    return {
      handouts: card('Handouts', dmHandoutsCard(c, logFn)),
      next: card('Next session', dmNextCard(c)),
      contracts: card('Contracts', jobsErr === 'missing' ? el('p', { class: 'd-note' }, SETUP)
        : live.length ? el('ul', { class: 'ss-jobs' }, ...live.map(k => el('li', {},
          el('a', { class: 'at-link', href: `#tab=jobs&pick=${encodeURIComponent(k.id)}` }, k.title),
          el('span', { class: 'bs-fine' }, k.status === 'taken' ? ` taken by ${nameOf(k.taken_by)}` : ' on the board'),
          el('button', { class: 'btn small', disabled: busy, onclick: () => closeJob(k, true, logFn) }, k.reward_cp ? `Done: pay ${fmt(k.reward_cp)}` : 'Done'),
          el('button', { class: 'mini', disabled: busy, onclick: () => closeJob(k, false, logFn) }, 'Failed'))))
          : el('p', { class: 'd-note' }, 'Nothing on the board. ', el('a', { class: 'at-link', href: '#tab=jobs' }, 'Post a contract'), '.'),
        el('p', { class: 'bs-fine' }, el('a', { class: 'at-link', href: '#tab=shops' }, 'Shops'), ' · ', el('a', { class: 'at-link', href: '#tab=screen' }, 'Table screen'))),
    };
  }

  /* ================= the home page ================= */
  function homeLines() {
    if (!user()) return [];
    if (!camps) { loadCamps(); return []; }
    const out = [];
    const nc = nextCard(campId, true);
    if (nc) out.push(nc);
    if (camps.length && jobsFor !== campId && !jobsBusy && !jobsErr) loadJobs();
    const open = (jobs || []).filter(k => k.status === 'open').length, taken = (jobs || []).filter(k => k.status === 'taken').length;
    if (open || taken) out.push(el('button', { class: 'yt-line', onclick: () => go({ tab: 'jobs' }, true) }, el('span', { class: 'k' }, 'Contracts'), el('span', { class: 'v' }, [open ? `${open} on the board` : '', taken ? `${taken} taken` : ''].filter(Boolean).join(' · ') + ' →')));
    if (hoAll && hoAll.length && Date.now() - Date.parse(hoAll[0].shown_at) < 7 * 86400000) out.push(el('button', { class: 'yt-line', onclick: () => openHandout(hoAll[0]) }, el('span', { class: 'k' }, 'Latest handout'), el('span', { class: 'v' }, hoAll[0].title)));
    return out;
  }

  function init() {
    if (Notes && Notes.onAuth) Notes.onAuth(() => {
      camps = null; shops = null; shopsFor = ''; jobs = null; jobsFor = ''; mine = null; mineFor = ''; next = null; nextFor = ''; hoAll = null; hoDm = null; hoDmFor = '';
      if (user()) watchHandouts();
    });
    if (user()) watchHandouts();
    else setTimeout(() => { if (user()) watchHandouts(); }, 2500);
  }

  function renderList(box, meta) {
    if (state.tab === 'shops') shopsList(box, meta);
    else if (state.tab === 'jobs') jobsList(box, meta);
    else if (state.tab === 'screen') screenView(box, meta);
  }
  function renderDetail(pane) {
    if (state.tab === 'shops') return shopDetail(pane);
    if (state.tab === 'jobs') return jobDetail(pane);
    return false;
  }

  return { init, renderList, renderDetail, handoutsCard, nextCard, dmCards, homeLines, watchHandouts, parseCoin };
};
