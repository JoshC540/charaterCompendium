/* Dice roller and the table's dice log. Rolls are made by the database (roll_dice in supabase/setup.sql), so a
   result can't be typed in, and every roll lands in the campaign's log. Everyone in the campaign sees players' rolls;
   the DM can also roll in secret. Statuses on the live sheet are applied: Exhaustion's −2, disadvantage and extra
   dice, and Freeze halving the dice; Fear and Poisoned show as reminders, since only the table knows when they apply. */
window.HandbookDice = function (H) {
  'use strict';
  const { el, Notes } = H;
  const sb = () => Notes && Notes.client && Notes.client();
  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : String((e && e.message) || e));

  const logs = new Map();       // campaign → { rows, loaded, err, ch, timer, seen }
  const ui = new Map();         // roller key → { mode, bonus, expr, label, last, busy, msg, halve }
  let redrawT = 0;
  const redraw = () => { if (redrawT) return; redrawT = setTimeout(() => { redrawT = 0; H.render(); }, 60); };

  function logOf(c) {
    if (!logs.has(c)) logs.set(c, { rows: [], loaded: false, err: '', ch: null, timer: 0, seen: 0, busy: false });
    return logs.get(c);
  }
  async function load(c) {
    const L = logOf(c);
    if (L.busy) return;
    L.busy = true;
    const r = await sb().from('rolls').select('*').eq('campaign_id', c).order('id', { ascending: false }).limit(40);
    L.busy = false;
    if (r.error) { L.err = /rolls|does not exist|schema cache/i.test(String(r.error.message)) ? 'missing' : friendly(r.error); L.loaded = true; redraw(); return; }
    const wasLoaded = L.loaded, before = L.rows.length ? L.rows[0].id : null;
    L.rows = r.data || []; L.loaded = true; L.err = '';
    const after = L.rows.length ? L.rows[0].id : null;
    // only redraw when something changed, so typing elsewhere on the page isn't interrupted
    if (!wasLoaded || after !== before) redraw();
  }
  // live updates while a log is on screen: realtime when it works, a check every few seconds either way
  function watch(c) {
    const L = logOf(c);
    L.seen = Date.now();
    if (!L.loaded && !L.busy) load(c);
    if (!L.ch && sb().channel) {
      try {
        L.ch = sb().channel('rolls-' + c).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rolls', filter: `campaign_id=eq.${c}` }, p => {
          const row = p && p.new;
          if (row && !L.rows.some(x => x.id === row.id)) { L.rows = [row, ...L.rows].slice(0, 40); redraw(); }
        }).subscribe(st => { L.live = st === 'SUBSCRIBED'; });
      } catch (e) { L.ch = null; }
    }
    if (!L.timer) L.timer = setInterval(() => {
      if (Date.now() - L.seen > 15000) { clearInterval(L.timer); L.timer = 0; return; }   // not on screen any more
      if (document.visibilityState === 'visible') load(c);
    }, L.live ? 15000 : 4000);
  }

  const outcomeText = o => o === 'success' ? 'Success' : o === 'fail' ? 'Fail' : o === 'death' ? 'Death' : '';
  function describe(x) {
    const d = x.detail || {};
    const bits = [];
    for (const t of d.terms || []) bits.push(`${t.dice}: ${t.rolls.join(', ')}`);
    if (d.mode) bits.push(d.mode === 'adv' ? 'advantage' : 'disadvantage');
    if (d.flat) bits.push(`${d.flat > 0 ? '+' : '−'}${Math.abs(d.flat)}`);
    if (d.bonus) bits.push(`${d.bonus > 0 ? '+' : '−'}${Math.abs(d.bonus)} bonus`);
    if (d.halved) bits.push('halved (Freeze)');
    if (d.need != null) bits.push(`needs ${d.need}`);
    if (d.nat === 20) bits.push('natural 20'); else if (d.nat === 1) bits.push('natural 1');
    if (d.side) bits.push(d.side.exhaustion === 3 ? `Exhaustion 2d3: ${d.side.rolls.join(', ')}${d.side.fails ? ' (fails)' : ''}` : `Exhaustion 1d2: ${d.side.rolls[0]}${d.side.death ? ' (death)' : ''}`);
    return bits.join(' · ');
  }
  const when = t => { const s = (Date.now() - new Date(t).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };

  function logView(c, opts) {
    const L = logOf(c);
    watch(c);
    if (L.err === 'missing') return el('p', { class: 'd-note' }, 'Run the latest supabase/setup.sql to switch on the dice log.');
    if (L.err) return el('p', { class: 'notes-msg' }, L.err);
    if (!L.loaded) return el('p', { class: 'bs-fine' }, 'Opening the dice log…');
    const rows = L.rows.slice(0, (opts && opts.limit) || 15);
    return el('div', { class: 'dc-log' },
      el('div', { class: 'dc-logh' }, el('span', { class: 'k' }, 'The table’s rolls'), el('span', { class: 'bs-fine' }, L.live ? 'Live' : 'Updates every few seconds')),
      rows.length ? el('ol', { class: 'dc-list' }, ...rows.map(x => {
        const o = (x.detail || {}).outcome;
        return el('li', { class: 'dc-row' + (x.hidden ? ' hidden' : '') + (o ? ' ' + o : '') },
          el('span', { class: 'dc-tot' }, String(x.total)),
          el('span', { class: 'dc-main' },
            el('span', { class: 'dc-who' }, x.who, x.hidden ? el('span', { class: 'dc-hid' }, ' · hidden') : null),
            el('span', { class: 'dc-what' }, x.what, o ? el('span', { class: 'dc-out' }, ` · ${outcomeText(o)}`) : null),
            el('span', { class: 'dc-det' }, describe(x))),
          el('span', { class: 'dc-when' }, when(x.created_at)));
      })) : el('p', { class: 'd-note' }, 'No rolls yet tonight.'));
  }

  /* The roller. opts: { key, campaign, charId, stats: [{ k, v }], statuses: { id: stacks }, dm, title } */
  function panel(opts) {
    const c = opts.campaign;
    if (!c) return el('section', { class: 'dc' }, el('h3', { class: 'pl-h' }, 'Dice'),
      el('p', { class: 'd-note' }, 'Rolls go to your table’s dice log once this character is in a campaign. Your DM adds characters to a campaign in Party money.'));
    const key = opts.key || c + '|' + (opts.charId || 'dm');
    if (!ui.has(key)) ui.set(key, { mode: 'normal', bonus: 0, expr: '', label: '', last: null, busy: false, msg: '', halve: null, secret: false });
    const U = ui.get(key);
    const st = opts.statuses || {};
    const exh = Math.min(5, Number(st.exhaustion) || 0), frozen = Number(st.freeze) > 0;
    if (U.halve === null) U.halve = frozen;
    // what the statuses do to this roll
    const forcedDis = exh === 2;
    const effMode = forcedDis ? (U.mode === 'adv' ? 'normal' : 'dis') : U.mode;
    const effBonus = Number(U.bonus || 0) + (exh === 1 ? -2 : 0);
    const notes = [];
    if (exh === 1) notes.push('Exhaustion 1: −2 to every roll (added for you).');
    if (exh === 2) notes.push('Exhaustion 2: disadvantage on every roll (added for you).');
    if (exh === 3) notes.push('Exhaustion 3: 2d3 is rolled with each roll; a 2 fails it.');
    if (exh === 4) notes.push('Exhaustion 4: 1d2 is rolled with each roll; a 1 means death.');
    if (exh >= 5) notes.push('Exhaustion 5: death.');
    if (Number(st.fear) > 0) notes.push('Fear: disadvantage on every roll while the source of fear is visible.');
    if (Number(st.poisoned) > 0) notes.push('Poisoned: disadvantage on one type of roll (the DM says which), and on death saves.');
    if (frozen) notes.push('Freeze: rolled dice are halved (damage and other dice rolls).');

    // an attack with a weapon the character isn't trained in rolls to hit with disadvantage (advantage cancels it)
    const withDis = m => m === 'adv' ? 'normal' : 'dis';
    const roll = async (what, dice, need, dis) => {
      if (U.busy) return;
      U.busy = true; U.msg = ''; H.render();
      const r = await sb().rpc('roll_dice', { c, ch: opts.charId || null, what, dice, need: need == null ? null : need,
        mode: dis ? withDis(effMode) : effMode, bonus: effBonus, exh: exh >= 3 && exh <= 4 ? exh : 0, halve: need == null && !!U.halve, secret: !!(opts.dm && U.secret) });
      U.busy = false;
      if (r.error) U.msg = /roll_dice|function/i.test(String(r.error.message)) && /find|exist/i.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to switch on the dice.' : friendly(r.error);
      else { U.last = r.data; const L = logOf(c); if (r.data && !L.rows.some(x => x.id === r.data.id)) L.rows = [r.data, ...L.rows].slice(0, 40); }
      H.render();
    };
    const seg = el('div', { class: 'bs-seg seg dc-mode', role: 'group', 'aria-label': 'Advantage' },
      ...[['normal', 'Normal'], ['adv', 'Advantage'], ['dis', 'Disadvantage']].map(([k, t]) => el('button', { type: 'button', class: U.mode === k ? 'on' : null, 'aria-pressed': String(U.mode === k), onclick: () => { U.mode = k; H.render(); } }, t)));
    const last = U.last ? (() => {
      const o = (U.last.detail || {}).outcome;
      return el('div', { class: 'dc-last' + (o ? ' ' + o : ''), role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'n' }, String(U.last.total)),
        el('span', { class: 't' }, el('strong', {}, U.last.what + (o ? ` · ${outcomeText(o)}` : '')), el('span', { class: 'bs-fine' }, describe(U.last))));
    })() : null;
    const statBtns = (opts.stats || []).filter(s => s.v != null && s.v !== '').map(s => el('button', { type: 'button', class: 'dc-stat', disabled: U.busy, title: `Roll a d20: ${s.v} or more succeeds`, onclick: () => roll(`${s.k} check`, 'd20', Number(s.v)) },
      el('span', { class: 'k' }, s.k), el('span', { class: 'v' }, String(s.v))));
    const atkRows = (opts.attacks || []).map(a => el('div', { class: 'dc-atk' },
      el('span', { class: 'nm' }, a.name, a.dis ? el('span', { class: 'dc-untr' }, 'Not trained: disadvantage') : null),
      a.need != null ? el('button', { type: 'button', class: 'btn small', disabled: U.busy, title: `Roll a d20: ${a.need} or more, plus the target’s Defence${a.dis ? ', with disadvantage (not trained)' : ''}`, onclick: () => roll(`${a.name}: to hit${a.dis ? ' (not trained)' : ''}`, 'd20', Number(a.need), !!a.dis) }, `To hit · ${a.stat} ${a.need}`) : el('span', { class: 'bs-fine' }, `Roll ${a.stat} first`),
      a.dice ? el('button', { type: 'button', class: 'btn small', disabled: U.busy, onclick: () => roll(`${a.name}: damage`, a.dice, null) }, `Damage · ${a.dice}`) : null));
    const free = () => { const ex = (U.expr || '').trim(); if (!ex) { U.msg = 'Type the dice first, like 2d6+3.'; H.render(); return; } roll((U.label || '').trim() || ex, ex, null); };
    return el('section', { class: 'dc' },
      opts.title === '' ? null : el('h3', { class: 'pl-h' }, opts.title || 'Dice'),
      notes.length ? el('ul', { class: 'dc-notes' }, ...notes.map(t => el('li', {}, t))) : null,
      el('div', { class: 'dc-bar' }, seg,
        el('label', { class: 'dc-bonus' }, 'Bonus ', el('input', { type: 'number', class: 'num', value: String(U.bonus || 0), min: '-20', max: '20', 'aria-label': 'Bonus to the roll', onchange: e => { U.bonus = Number(e.target.value) || 0; } }))),
      atkRows.length ? el('div', { class: 'dc-atks', role: 'group', 'aria-label': 'Your attacks' }, ...atkRows) : null,
      statBtns.length ? el('div', { class: 'dc-stats', role: 'group', 'aria-label': 'Roll a check' }, ...statBtns) : null,
      el('div', { class: 'dc-free' },
        el('input', { type: 'text', class: 'dc-in', placeholder: 'Dice, e.g. 2d6+3', value: U.expr, maxlength: 40, 'aria-label': 'Dice to roll', oninput: e => { U.expr = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') free(); } }),
        el('input', { type: 'text', class: 'dc-in', placeholder: 'What for (optional)', value: U.label, maxlength: 80, 'aria-label': 'What the roll is for', oninput: e => { U.label = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') free(); } }),
        el('button', { type: 'button', class: 'btn small primary', disabled: U.busy, onclick: free }, U.busy ? 'Rolling…' : 'Roll')),
      el('div', { class: 'dc-opts' },
        frozen || U.halve ? el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!U.halve, onchange: e => { U.halve = e.target.checked; } }), 'Halve the dice (Freeze)') : null,
        opts.dm ? el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!U.secret, onchange: e => { U.secret = e.target.checked; H.render(); } }), 'Roll in secret (only you see it)') : null),
      U.msg ? el('p', { class: 'notes-msg' }, U.msg) : null,
      last,
      logView(c));
  }

  /* ---------- following the DM's fight ---------- */
  const fights = new Map();   // campaign → { data, loaded, ch, timer, seen, busy }
  async function loadFight(c) {
    const F = fights.get(c);
    if (F.busy) return;
    F.busy = true;
    const r = await sb().from('fight_view').select('data, updated_at').eq('campaign_id', c).maybeSingle();
    F.busy = false;
    const was = JSON.stringify(F.data), now = r.error ? null : (r.data && r.data.data) || null;
    F.data = now; F.loaded = true;
    if (JSON.stringify(now) !== was) redraw();
  }
  function fightView(c, me) {
    if (!c) return null;
    if (!fights.has(c)) fights.set(c, { data: null, loaded: false, ch: null, timer: 0, seen: 0, busy: false });
    const F = fights.get(c);
    F.seen = Date.now();
    if (!F.loaded && !F.busy) loadFight(c);
    if (!F.ch && sb().channel) {
      try { F.ch = sb().channel('fight-' + c).on('postgres_changes', { event: '*', schema: 'public', table: 'fight_view', filter: `campaign_id=eq.${c}` }, () => loadFight(c)).subscribe(st => { F.live = st === 'SUBSCRIBED'; }); } catch (e) { F.ch = null; }
    }
    if (!F.timer) F.timer = setInterval(() => {
      if (Date.now() - F.seen > 15000) { clearInterval(F.timer); F.timer = 0; return; }
      if (document.visibilityState === 'visible') loadFight(c);
    }, F.live ? 15000 : 4000);
    const d = F.data;
    if (!d || !d.active || !Array.isArray(d.order) || !d.order.length) return null;
    const i = d.order.findIndex(x => x.now), nx = i >= 0 ? d.order.slice(i + 1).concat(d.order.slice(0, i)).find(x => x.health !== 'Down') : null;
    return el('section', { class: 'fv', 'aria-label': 'The fight' },
      el('div', { class: 'fv-h' }, el('span', { class: 'k' }, d.started ? `Fight · round ${d.round}` : 'A fight is about to start'),
        i >= 0 ? el('span', { class: 'fv-now' }, d.order[i].charId && d.order[i].charId === me ? 'Your turn' : `${d.order[i].name}’s turn`) : null,
        nx ? el('span', { class: 'bs-fine' }, `Next: ${nx.charId && nx.charId === me ? 'you' : nx.name}`) : null),
      el('ol', { class: 'fv-list' }, ...d.order.map(x => el('li', { class: 'fv-row ' + x.side + (x.now ? ' now' : '') + (x.health === 'Down' ? ' down' : '') + (x.charId && x.charId === me ? ' me' : '') },
        el('span', { class: 'nm' }, x.name, x.charId && x.charId === me ? el('span', { class: 'you' }, ' (you)') : null),
        el('span', { class: 'hp' }, x.side === 'party' && x.max ? `${x.hp} / ${x.max}` : x.health || ''),
        x.statuses && x.statuses.length ? el('span', { class: 'sts' }, x.statuses.join(', ')) : null,
        x.saves ? el('span', { class: 'fv-saves' }, x.saves.pass >= 3 ? 'Stable' : x.saves.fail >= 3 ? 'Dead' : `Death saves: ${x.saves.pass} passed, ${x.saves.fail} failed`) : null))));
  }

  return { panel, log: logView, fight: fightView };
};
