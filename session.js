/* Session screen (DM only): everything for the night in one place. The party's live sheets, the encounters
   planned for tonight, atlas entries waiting to be revealed, loot to hand out, notes, and a backup of everything.
   The plan is kept in Supabase (dm_store, one row per campaign, readable only by the DM). */
window.HandbookSession = function (H) {
  'use strict';
  const { el, go, render, Notes } = H;
  const B = H.B;   // bestiary internals: data(), rowView(), krText(), encounter(), mathsFor(), useEncounter(), startFight()

  const sb = () => Notes && Notes.client && Notes.client();
  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : String((e && e.message) || e));
  const CAMP_KEY = 'hb-session-camp';
  const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* this visit only */ } };

  let camps = null, campErr = '', campId = lsGet(CAMP_KEY);
  let chars = null;                 // characters in the chosen campaign
  let plan = null, planFor = '', planErr = '', planBusy = false;
  let saveT = null, saveState = '';  // '', 'saving', 'saved', or an error
  let open = new Set();             // party tiles opened into full sheets
  let msg = '', busy = false, encName = '', lootText = '', lootCoin = '', revealPick = '', levelTo = '';
  let backupState = '';

  /* ---------- money, as the party money tab writes it ---------- */
  const fmt = cp => {
    const n = Math.abs(Number(cp) || 0);
    const out = [[Math.floor(n / 1000000), 'pp'], [Math.floor(n % 1000000 / 10000), 'gp'], [Math.floor(n % 10000 / 100), 'sp'], [n % 100, 'cp']]
      .filter(([v]) => v).map(([v, k]) => `${v.toLocaleString('en-GB')} ${k}`);
    return out.join(' ') || '0 cp';
  };
  // "12 gp 5 sp", "40" (gold), "3pp" → copper; null if it doesn't read as money
  function parseCoin(s) {
    const t = String(s || '').toLowerCase().replace(/,/g, '').trim();
    if (!t) return 0;
    const RATE = { pp: 1000000, gp: 10000, sp: 100, cp: 1 };
    let cp = 0, rest = t;
    rest = rest.replace(/(\d+(?:\.\d+)?)\s*(pp|gp|sp|cp)\b/g, (m, n, k) => { cp += Math.round(Number(n) * RATE[k]); return ' '; });
    if (/^\s*\d+(\.\d+)?\s*$/.test(rest)) { cp += Math.round(Number(rest) * RATE.gp); rest = ''; }
    return rest.trim() ? null : cp;
  }
  const uid = () => Math.random().toString(36).slice(2, 10);

  /* ---------- loading and saving ---------- */
  async function loadCamps() {
    const r = await sb().from('campaigns').select('*').order('name', { ascending: true });
    if (r.error) { campErr = friendly(r.error); camps = []; render(); return; }
    camps = r.data || [];
    if (!camps.some(c => c.id === campId)) campId = camps[0] ? camps[0].id : '';
    render();
  }
  let charsLoading = '';
  async function loadChars() {
    const id = campId;
    if (charsLoading === id) return;
    charsLoading = id;
    const r = await sb().from('characters').select('id, name, owner_id, campaign_id, data').eq('campaign_id', id).order('name', { ascending: true });
    charsLoading = '';
    if (id !== campId) { render(); return; }
    chars = (r.data || []).map(x => ({ id: x.id, name: x.name || 'Unnamed', level: (x.data && x.data.level) | 0, max: H.charHp ? H.charHp(x.data) : 0 }));
    if (H.Play) H.Play.load(chars.map(c => c.id));
    render();
  }
  async function loadPlan() {
    const id = campId;
    planBusy = true;
    const r = await sb().from('dm_store').select('key, data').eq('key', 'session:' + id).maybeSingle();
    planBusy = false;
    if (id !== campId) { render(); return; }   // the DM switched campaign while this was loading
    if (r.error) { planErr = /dm_store|does not exist|schema cache/i.test(String(r.error.message || r.error)) ? 'missing' : friendly(r.error); plan = null; render(); return; }
    const d = (r.data && r.data.data) || {};
    plan = { encounters: Array.isArray(d.encounters) ? d.encounters : [], reveal: Array.isArray(d.reveal) ? d.reveal : [], loot: Array.isArray(d.loot) ? d.loot : [], notes: typeof d.notes === 'string' ? d.notes : '',
      log: Array.isArray(d.log) ? d.log : [], recap: typeof d.recap === 'string' ? d.recap : '' };
    planFor = id; planErr = '';
    render();
  }
  function changed(now) {
    saveState = 'saving';
    clearTimeout(saveT);
    const id = planFor, data = JSON.parse(JSON.stringify(plan));
    saveT = setTimeout(async () => {
      const r = await sb().from('dm_store').upsert({ key: 'session:' + id, data });
      saveState = r.error ? 'Couldn’t save: ' + friendly(r.error) : 'saved';
      const s = document.querySelector('.ss-saved');
      if (s) s.textContent = saveLabel(); else render();
    }, now ? 0 : 700);
  }
  // what happened tonight, for the recap
  function logEvent(kind, text) { plan.log.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 300) }); if (plan.log.length > 200) plan.log = plan.log.slice(-200); }
  const saveLabel = () => saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState;
  function pickCamp(id) {
    campId = id; lsSet(CAMP_KEY, id);
    chars = null; plan = null; planFor = ''; planErr = ''; open = new Set(); msg = ''; levelTo = '';
    render();
  }

  /* ---------- the party ---------- */
  function partyCard() {
    if (!chars) return card('The party', el('p', { class: 'bs-fine' }, 'Opening the party…'));
    if (!chars.length) return card('The party', el('p', { class: 'd-note' }, 'No characters in this campaign yet. Players add theirs from Party money.'));
    if (H.Play) H.Play.watch(chars.map(c => c.id));
    const STAT = ((H.statuses && H.statuses()) || {}).statuses || [];
    const sName = id => { const s = STAT.find(x => x.id === id); return s ? s.name : id; };
    const tiles = chars.map(c => {
      const live = (H.Play && H.Play.get(c.id)) || {};
      const max = live.max || c.max || 0, hp = live.hp == null ? max : live.hp, temp = live.temp | 0;
      const pctHp = max ? Math.max(0, Math.min(100, Math.round(hp / max * 100))) : 0;
      const sts = Object.entries(live.statuses || {}).filter(([, n]) => n > 0);
      const owed = (live.levelTo | 0) > c.level ? live.levelTo | 0 : 0;
      const isOpen = open.has(c.id);
      return el('div', { class: 'ss-pc' + (hp <= 0 && max ? ' down' : '') + (isOpen ? ' open' : '') },
        el('button', { type: 'button', class: 'ss-pch', 'aria-expanded': String(isOpen), onclick: () => { isOpen ? open.delete(c.id) : open.add(c.id); render(); } },
          el('span', { class: 'nm' }, c.name),
          el('span', { class: 'lv' }, `Lv ${c.level}`, owed ? el('span', { class: 'ss-owed', title: 'Hasn’t taken the level you gave yet' }, ` → ${owed}`) : null),
          el('span', { class: 'hp' }, max ? `${hp} / ${max}${temp ? ` +${temp}` : ''}` : '–'),
          el('span', { class: 'ft-bar pc ss-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${pctHp}%` })),
          sts.length ? el('span', { class: 'ss-sts' }, ...sts.map(([id, n]) => el('span', { class: 'chip' }, n > 1 ? `${sName(id)} ×${n}` : sName(id)))) : null,
          hp <= 0 && max ? el('span', { class: 'ss-down' }, 'Down') : null),
        isOpen && H.Play ? el('div', { class: 'ss-sheet' },
          H.Play.sheet({ id: c.id, name: c.name, maxHp: c.max, canEdit: true, compact: true }),
          el('button', { type: 'button', class: 'linkbtn', onclick: () => go({ tab: 'chars', char: c.id }, true) }, 'Open the full character')) : null);
    });
    const top = Math.max(0, ...chars.map(c => c.level));
    const want = levelTo === '' ? top + 1 : Number(levelTo);
    const raise = async () => {
      const n = Math.floor(Number(levelTo === '' ? top + 1 : levelTo));
      if (!(n >= 1 && n <= 200)) { msg = 'Pick a level from 1 to 200.'; render(); return; }
      busy = true; msg = ''; render();
      try { for (const c of chars) if (c.level < n) await H.Play.change(c.id, 0, { levelTo: n }); msg = `Done. Everyone below level ${n} now sees “Level up” on their sheet.`; logEvent('level', `The party reached level ${n}`); changed(true); }
      catch (e) { msg = friendly(e); }
      busy = false; render();
    };
    return card('The party', el('div', { class: 'ss-party' }, ...tiles),
      el('p', { class: 'bs-fine' }, 'Live from each player’s sheet. Tap someone to change their HP, statuses or uses.'),
      el('div', { class: 'ss-level' },
        el('label', {}, 'Raise the party to level ', el('input', { type: 'number', class: 'ss-num', min: '1', max: '200', value: String(want), 'aria-label': 'Level to raise the party to', oninput: e => { levelTo = e.target.value; } })),
        el('button', { type: 'button', class: 'btn small', disabled: busy || !H.Play, onclick: raise }, 'Raise them'),
        el('span', { class: 'bs-fine' }, 'Each player then takes the level on their own sheet, making their choices.')));
  }

  function rulesCard() {
    // how players in this campaign roll stats (the character builder reads this)
    const camp = camps.find(x => x.id === campId) || {};
    const st = (camp.settings && camp.settings.stats) || {};
    const method = st.method === 'order' ? 'order' : 'assign', rerolls = Number.isFinite(+st.rerolls) ? +st.rerolls : 0;
    const setRule = async patch => {
      const settings = { ...(camp.settings || {}), stats: { method, rerolls, ...patch } };
      const r = await sb().from('campaigns').update({ settings }).eq('id', campId);
      if (r.error) { msg = /settings/.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to set stat rolling per campaign.' : friendly(r.error); render(); return; }
      camp.settings = settings; msg = 'Saved. New stat rolls in this campaign follow it.'; render();
    };
    return card('Character rules', el('div', { class: 'ss-rules' },
      el('span', {}, 'Stat rolling:'),
      el('select', { class: 'select', 'aria-label': 'How players roll stats', onchange: e => setRule({ method: e.target.value }) },
        el('option', { value: 'assign', selected: method === 'assign' }, 'Roll a set, then assign'),
        el('option', { value: 'order', selected: method === 'order' }, 'Roll each stat in order')),
      el('select', { class: 'select', 'aria-label': 'Rerolls allowed', onchange: e => setRule({ rerolls: +e.target.value }) },
        ...[[0, 'No rerolls'], [1, 'One reroll'], [2, 'Two rerolls'], [99, 'Rerolls as they like']].map(([v, t]) => el('option', { value: String(v), selected: rerolls === v }, t))),
      el('span', { class: 'bs-fine' }, 'For new characters in this campaign. Each sheet keeps a record of its rolls.')));
  }

  /* ---------- encounters ---------- */
  const describe = enc => enc.rows.map(r => { const v = B.rowView(r); return v ? `${r.n > 1 ? r.n + ' × ' : ''}${v.name}` : null; }).filter(Boolean).join(', ');
  function encountersCard() {
    if (!B.data()) return card('Encounters for tonight', el('p', { class: 'bs-fine' }, 'Opening the bestiary…'));
    const party = (chars || []).map(c => c.level);
    const cur = B.encounter();
    const add = () => {
      if (!cur.rows.length) return;
      plan.encounters.push({ id: uid(), name: encName.trim() || `Encounter ${plan.encounters.length + 1}`, enc: { party: cur.party.slice(), rows: JSON.parse(JSON.stringify(cur.rows)) }, fought: false });
      encName = ''; changed(); render();
    };
    const VERD = { easy: 'Easy', fair: 'Fair', deadly: 'Deadly' };
    const list = plan.encounters.map((x, i) => {
      const M = B.mathsFor({ party: party.length ? party : x.enc.party, rows: x.enc.rows });
      return el('li', { class: 'ss-enc' + (x.fought ? ' done' : '') },
        el('div', { class: 'ss-ench' },
          el('strong', {}, x.name),
          el('span', { class: 'bs-fine' }, `KR ${B.krText(M.total)}${M.verdict ? ` · ${VERD[M.verdict]} for ${party.length ? 'this party' : 'its party'}` : ''}${x.fought ? ' · fought' : ''}`)),
        el('div', { class: 'ss-encd' }, describe(x.enc) || 'No creatures'),
        el('div', { class: 'ss-btns' },
          el('button', { type: 'button', class: 'btn small primary', disabled: !chars || !chars.length && !x.enc.party.length, onclick: () => { x.fought = true; logEvent('fight', `${x.name}${describe(x.enc) ? ` (${describe(x.enc)})` : ''}`); changed(true); B.startFight(x.enc, chars || [], campId); } }, 'Start the fight'),
          el('button', { type: 'button', class: 'mini', onclick: () => { B.useEncounter(x.enc); go({ tab: 'encounter', mon: '', rs: '' }, true); } }, 'Open in Encounters'),
          i > 0 ? el('button', { type: 'button', class: 'mini', 'aria-label': `Move ${x.name} up`, onclick: () => { plan.encounters.splice(i - 1, 0, plan.encounters.splice(i, 1)[0]); changed(); render(); } }, '↑') : null,
          el('button', { type: 'button', class: 'mini', onclick: () => { plan.encounters.splice(i, 1); changed(); render(); } }, 'Remove')));
    });
    return card('Encounters for tonight',
      list.length ? el('ol', { class: 'ss-list' }, ...list) : el('p', { class: 'd-note' }, 'None planned yet. Build one in Encounters, then add it here.'),
      el('div', { class: 'ss-add' },
        cur.rows.length
          ? [el('input', { type: 'text', class: 'ss-in', placeholder: `Name it (Encounter ${plan.encounters.length + 1})`, value: encName, maxlength: 80, 'aria-label': 'Name for the encounter', oninput: e => { encName = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') add(); } }),
            el('button', { type: 'button', class: 'btn small', onclick: add }, 'Add the one in Encounters'),
            el('span', { class: 'bs-fine' }, describe(cur))]
          : el('span', { class: 'bs-fine' }, 'The encounter builder is empty. '),
        el('button', { type: 'button', class: 'linkbtn', onclick: () => go({ tab: 'encounter', mon: '', rs: '' }, true) }, 'Go to Encounters')),
      el('p', { class: 'bs-fine' }, 'Start the fight puts the party’s saved characters (linked to their live sheets) and the creatures into the combat tracker, and lets the players follow it on their phones.'));
  }

  /* ---------- the atlas reveal queue ---------- */
  function revealCard() {
    const A = H.Atlas && H.Atlas.api;
    if (!A) return null;
    const rows = A.rows();
    if (!rows) { A.load(); return card('To reveal', el('p', { class: 'bs-fine' }, 'Opening the atlas…')); }
    const by = id => rows.find(r => r.id === id);
    plan.reveal = plan.reveal.filter(id => by(id));
    const K = H.Atlas.KIND;
    const candidates = rows.filter(r => !r.revealed && !plan.reveal.includes(r.id));
    const items = plan.reveal.map(id => {
      const r = by(id);
      return el('li', { class: 'ss-rev' + (r.revealed ? ' done' : '') },
        el('button', { type: 'button', class: 'bs-elink', onclick: () => go({ tab: 'atlas', ent: r.id }, true) }, r.name),
        el('span', { class: 'bs-fine' }, `${(K[r.kind] || K.lore).one}${r.region ? ' · ' + r.region : ''}`),
        el('span', { class: 'ss-btns' },
          r.revealed
            ? [el('span', { class: 'ss-ok' }, 'Revealed'), el('button', { type: 'button', class: 'mini', disabled: busy, onclick: async () => { busy = true; render(); msg = await A.reveal(r.id, false); busy = false; render(); } }, 'Hide again')]
            : el('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: async () => { busy = true; render(); msg = await A.reveal(r.id, true); busy = false; if (/^Revealed/.test(msg)) { logEvent('reveal', r.name); changed(); } render(); } }, 'Reveal'),
          el('button', { type: 'button', class: 'mini', 'aria-label': `Take ${r.name} off the list`, onclick: () => { plan.reveal = plan.reveal.filter(x => x !== id); changed(); render(); } }, '×')));
    });
    return card('To reveal',
      items.length ? el('ul', { class: 'ss-list' }, ...items) : el('p', { class: 'd-note' }, rows.length ? 'Queue the hidden atlas entries the party might uncover tonight, then reveal each with one tap.' : 'The atlas is empty. Write entries in the Atlas tab first.'),
      candidates.length ? el('div', { class: 'ss-add' },
        el('select', { class: 'select ss-in', 'aria-label': 'Hidden entry to queue', onchange: e => { revealPick = e.target.value; } },
          el('option', { value: '' }, 'A hidden entry…'), ...candidates.map(r => el('option', { value: r.id, selected: revealPick === r.id }, `${r.name} (${(K[r.kind] || K.lore).one})`))),
        el('button', { type: 'button', class: 'btn small', onclick: () => { if (!revealPick) return; plan.reveal.push(revealPick); revealPick = ''; changed(); render(); } }, 'Queue it')) : null);
  }

  /* ---------- loot ---------- */
  function lootCard() {
    const add = () => {
      const cp = parseCoin(lootCoin);
      if (cp === null) { msg = 'Write coin like 12 gp 5 sp, or a number for gold.'; render(); return; }
      if (!lootText.trim() && !cp) return;
      plan.loot.push({ id: uid(), text: lootText.trim().slice(0, 200), cp: cp || 0, done: false });
      lootText = ''; lootCoin = ''; msg = ''; changed(); render();
    };
    const pay = async x => {
      busy = true; msg = ''; render();
      const r = await sb().rpc('money_adjust', { c: campId, ch: null, amount: x.cp, reason: (x.text || 'Loot').slice(0, 200) });
      busy = false;
      if (r.error) { msg = friendly(r.error); render(); return; }
      x.done = true; x.paid = new Date().toISOString(); msg = `${fmt(x.cp)} paid into the party account.`; logEvent('coin', `${x.text || 'Coin'}: ${fmt(x.cp)} into the party account`); changed(true); render();
    };
    const stashIt = async x => {
      busy = true; msg = ''; render();
      const r = await sb().rpc('stash_add', { c: campId, item: (x.text || 'Loot').slice(0, 120), qty: 1, notes: null, reason: 'Loot' });
      busy = false;
      if (r.error) { msg = /stash_add|function/i.test(String(r.error.message)) && /find|exist/i.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to switch on the party stash.' : friendly(r.error); render(); return; }
      x.done = true; x.stashed = true; msg = `${x.text} is in the party stash.`; logEvent('item', `${x.text} (into the party stash)`); changed(true); render();
    };
    const items = plan.loot.map(x => el('li', { class: 'ss-loot' + (x.done ? ' done' : '') },
      x.cp ? null : el('input', { type: 'checkbox', checked: !!x.done, 'aria-label': `Handed out: ${x.text}`, onchange: e => { x.done = e.target.checked; if (x.done) logEvent('item', x.text); changed(); render(); } }),
      el('span', { class: 'what' }, x.text || 'Coin', x.cp ? el('span', { class: 'coin' }, ` ${fmt(x.cp)}`) : null),
      el('span', { class: 'ss-btns' },
        x.cp ? (x.done ? el('span', { class: 'ss-ok' }, 'In the party account') : el('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: () => pay(x) }, 'Pay into the party account'))
          : x.stashed ? el('span', { class: 'ss-ok' }, 'In the party stash')
          : !x.done ? el('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => stashIt(x) }, 'Put in the party stash') : null,
        el('button', { type: 'button', class: 'mini', 'aria-label': `Remove ${x.text || 'coin'}`, onclick: () => { plan.loot = plan.loot.filter(y => y !== x); changed(); render(); } }, '×'))));
    const done = plan.loot.filter(x => x.done).length;
    return card('Loot',
      items.length ? el('ul', { class: 'ss-list' }, ...items) : el('p', { class: 'd-note' }, 'What the party could find tonight. Coin goes straight into the party account; tick items off as you hand them out.'),
      el('div', { class: 'ss-add ss-lootadd' },
        el('input', { type: 'text', class: 'ss-in', placeholder: 'What (a silver ring, the bandit chest…)', value: lootText, maxlength: 200, 'aria-label': 'Loot', oninput: e => { lootText = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') add(); } }),
        el('input', { type: 'text', class: 'ss-in ss-coin', placeholder: 'Coin, e.g. 40 gp', value: lootCoin, 'aria-label': 'Coin', oninput: e => { lootCoin = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') add(); } }),
        el('button', { type: 'button', class: 'btn small', onclick: add }, 'Add')),
      done ? el('button', { type: 'button', class: 'mini', onclick: () => { plan.loot = plan.loot.filter(x => !x.done); changed(); render(); } }, `Clear the ${done} handed out`) : null);
  }

  function notesCard() {
    return card('Notes for tonight',
      el('textarea', { class: 'ss-notes', rows: 7, maxlength: 50000, placeholder: 'Names to remember, what they’re after, what happens if they go left…', 'aria-label': 'Notes for tonight',
        oninput: e => { plan.notes = e.target.value; changed(); } }, plan.notes),
      el('p', { class: 'bs-fine' }, 'Only you see these. For notes the players share, use the Notes tab.'));
  }

  /* ---------- end of the session: a recap for the players, posted to Notes ---------- */
  let sessions = null, sessionsFor = '', recapTarget = 'new', posting = false;
  async function loadSessions() {
    const id = campId; sessionsFor = id;
    const r = await sb().from('sessions').select('id, number, title, played_on').eq('campaign_id', id).order('number', { ascending: false });
    if (id !== campId) return;
    sessions = r.error ? [] : r.data || [];
    render();
  }
  function draftRecap() {
    const by = k => plan.log.filter(x => x.kind === k).map(x => x.text);
    const lines = [];
    const list = (label, xs) => { if (xs.length) lines.push(`**${label}:** ${xs.join('; ')}`); };
    list('Fights', by('fight'));
    list('Discovered', by('reveal'));
    list('Coin', by('coin'));
    list('Handed out', by('item'));
    for (const t of by('level')) lines.push(`**Levels:** ${t}.`);
    return `### What happened\n\n${lines.join('\n\n') || 'Write what happened tonight.'}\n`;
  }
  function recapCard() {
    if (sessionsFor !== campId) { sessions = null; loadSessions(); }
    const n = plan.log.length;
    const next = sessions && sessions.length ? sessions[0].number + 1 : 1;
    const post = async () => {
      const body = (plan.recap || '').trim();
      if (!body) { msg = 'Write the recap first.'; render(); return; }
      posting = true; render();
      try {
        let sid = recapTarget;
        if (recapTarget === 'new') {
          const r = await sb().from('sessions').insert({ campaign_id: campId, number: next, played_on: new Date().toISOString().slice(0, 10) }).select('id').single();
          if (r.error) throw r.error; sid = r.data.id;
        }
        const r2 = await sb().from('notes').insert({ session_id: sid, body: body.slice(0, 20000) });
        if (r2.error) throw r2.error;
        plan.log = []; plan.recap = ''; sessions = null; sessionsFor = '';
        msg = 'Posted to Notes. The players can read it there.'; changed(true);
      } catch (e) { msg = friendly(e); }
      posting = false; render();
    };
    return card('End of the session',
      n ? el('ul', { class: 'ss-list ss-events' }, ...plan.log.slice(-12).map(x => el('li', {}, el('span', { class: 'bs-fine' }, new Date(x.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' '), x.text)))
        : el('p', { class: 'd-note' }, 'Fights you start, entries you reveal, coin you pay out, items you hand out and levels you give are noted here as you go.'),
      plan.recap
        ? [el('textarea', { class: 'ss-notes', rows: 9, maxlength: 20000, 'aria-label': 'The recap', oninput: e => { plan.recap = e.target.value; changed(); } }, plan.recap),
          el('div', { class: 'ss-add' },
            el('label', { class: 'bs-fine' }, 'Post it to ', el('select', { class: 'select', 'aria-label': 'Which session', onchange: e => { recapTarget = e.target.value; } },
              el('option', { value: 'new', selected: recapTarget === 'new' }, `A new session (${next}, today)`),
              ...(sessions || []).slice(0, 8).map(x => el('option', { value: x.id, selected: recapTarget === x.id }, `Session ${x.number}${x.title ? ': ' + x.title : ''}`)))),
            el('button', { type: 'button', class: 'btn small primary', disabled: posting, onclick: post }, posting ? 'Posting…' : 'Post to Notes'),
            el('button', { type: 'button', class: 'mini', onclick: () => { plan.recap = ''; changed(); render(); } }, 'Not yet'))]
        : el('div', { class: 'ss-add' }, el('button', { type: 'button', class: 'btn small', onclick: () => { plan.recap = draftRecap(); changed(); render(); } }, 'Write the recap'),
          el('span', { class: 'bs-fine' }, 'A draft from tonight that you can edit, then post to the campaign’s Notes for the players.')));
  }

  /* ---------- backup ---------- */
  const TABLES = ['profiles', 'campaigns', 'campaign_members', 'sessions', 'notes', 'characters', 'character_play', 'money_tx', 'money_requests', 'money_votes', 'atlas', 'atlas_dm', 'atlas_pins', 'dm_store'];
  async function backup() {
    backupState = 'Gathering…'; render();
    const out = { made: new Date().toISOString(), note: 'Everything in the handbook’s database except the bestiary (which is in bestiary-data).', tables: {}, problems: {} };
    for (const t of TABLES) {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const r = await sb().from(t).select('*').range(from, from + 999);
        if (r.error) { out.problems[t] = friendly(r.error); break; }
        rows.push(...(r.data || []));
        if (!r.data || r.data.length < 1000) break;
      }
      out.tables[t] = rows;
    }
    const n = Object.values(out.tables).reduce((a, r) => a + r.length, 0);
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `handbook-backup-${out.made.slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const probs = Object.keys(out.problems);
    backupState = `Downloaded ${n.toLocaleString('en-GB')} rows from ${TABLES.length - probs.length} tables.${probs.length ? ` Couldn’t read: ${probs.join(', ')}.` : ''}`;
    render();
  }
  function backupCard() {
    return card('Backup',
      el('p', { class: 'd-note' }, 'Downloads everything in the database as one file: campaigns, sessions and notes, characters and their live sheets, party money, the atlas with your notes, and this plan. Keep a copy somewhere safe now and then.'),
      el('div', { class: 'ss-add' }, el('button', { type: 'button', class: 'btn small', disabled: backupState === 'Gathering…', onclick: backup }, 'Download everything'), backupState ? el('span', { class: 'bs-fine', role: 'status' }, backupState) : null));
  }

  const card = (title, ...kids) => el('section', { class: 'lab-card ss-card' }, el('h2', { class: 'section-head' }, title), ...kids);

  function renderList(box) {
    document.title = 'Session · Player’s Handbook';
    if (!sb()) { box.replaceChildren(el('div', { class: 'empty' }, 'Sign in first.')); return; }
    if (!camps) { loadCamps(); box.replaceChildren(el('div', { class: 'empty' }, 'Opening your campaigns…')); return; }
    const head = el('div', { class: 'lab-head ss-head' },
      el('h1', { class: 'lab-title' }, 'Session screen'),
      camps.length ? el('label', { class: 'ss-camp' }, el('span', { class: 'k' }, 'Campaign'),
        el('select', { class: 'select', onchange: e => pickCamp(e.target.value) }, ...camps.map(c => el('option', { value: c.id, selected: c.id === campId }, c.name)))) : null,
      plan ? el('span', { class: 'bs-fine ss-saved', role: 'status' }, saveLabel()) : null);
    if (campErr) { box.replaceChildren(head, el('div', { class: 'empty' }, campErr)); return; }
    if (!camps.length) { box.replaceChildren(head, el('div', { class: 'empty' }, el('strong', {}, 'No campaigns yet'), 'Create one on the Notes tab, then come back.'), backupCard()); return; }
    if (!chars) loadChars();
    if (planFor !== campId && !planBusy && !planErr) loadPlan();
    if (planErr) {
      box.replaceChildren(head, el('div', { class: 'empty' }, el('strong', {}, planErr === 'missing' ? 'The session screen isn’t set up yet' : 'Couldn’t open the plan'),
        planErr === 'missing' ? 'Run the latest supabase/setup.sql in the Supabase SQL editor, then reload.' : planErr,
        el('div', {}, el('button', { class: 'mini', onclick: () => { planErr = ''; render(); } }, 'Try again'))));
      return;
    }
    if (!plan) { box.replaceChildren(head, el('div', { class: 'empty' }, 'Opening tonight’s plan…')); return; }
    box.replaceChildren(el('div', { class: 'lab ss' }, head,
      el('p', { class: 'd-note ss-intro' }, 'Only you see this page. Everything on it saves as you go.'),
      msg ? el('p', { class: 'notes-msg' + (/^(Done|Revealed|Hidden|Saved|Posted|\d|.*paid into|.*in the party stash)/.test(msg) ? ' ok' : ''), role: 'status' }, msg) : null,
      el('div', { class: 'lab-cols' },
        el('div', { class: 'lab-col' }, partyCard(), encountersCard(), recapCard(), rulesCard()),
        el('div', { class: 'lab-col' }, H.Dice ? card('Table dice', H.Dice.panel({ campaign: campId, dm: true, key: 'dm|' + campId, title: '' })) : null, revealCard(), lootCard(), notesCard(), backupCard()))));
  }

  return { renderList, parseCoin };
};
