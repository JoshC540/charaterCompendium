/* Live character sheets: HP, temporary HP, statuses, death saves and uses-per-rest trackers, kept at the table.
   One row per character in Supabase (character_play), changed only through play_change(), so the DM's damage
   from the combat tracker and the player's healing on their phone never overwrite each other.
   Updates arrive by Supabase Realtime where it's on, and by a light poll while a sheet or the tracker is open. */
window.HandbookPlay = function (H) {
  'use strict';
  const { el, render } = H;
  const Notes = H.Notes;
  const sb = () => Notes && Notes.client();
  const user = () => Notes && Notes.user();

  const cache = new Map();          // character id -> { data, updated_at, updated_by }
  const watched = new Set();
  const pending = new Map();        // character id -> number of writes in flight (a poll mustn't undo them)
  const syncing = new Set();        // characters whose max HP is being set from their sheet
  let channel = null, live = false, pollT = null, lastErr = '';
  const PERS = [['rest', 'Per rest'], ['long', 'Per long rest'], ['day', 'Per day'], ['session', 'Per session'], ['arc', 'Per arc'], ['none', 'Doesn’t reset']];
  const PER_LABEL = Object.fromEntries(PERS);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const statusList = () => ((H.statuses && H.statuses()) || { statuses: [] }).statuses;
  const stOf = id => statusList().find(s => s.id === id);
  const stCap = id => { const n = parseInt((stOf(id) || {}).max, 10); return isNaN(n) ? Infinity : n; };

  let redrawT = 0;
  const redraw = () => { if (redrawT) return; redrawT = setTimeout(() => { redrawT = 0; render(); }, 60); };

  function put(row) {
    if (!row || !row.character_id) return false;
    if (pending.get(row.character_id)) return false;
    const old = cache.get(row.character_id);
    if (old && old.updated_at && row.updated_at && old.updated_at === row.updated_at && JSON.stringify(old.data) === JSON.stringify(row.data)) return false;
    cache.set(row.character_id, { data: row.data || {}, updated_at: row.updated_at, updated_by: row.updated_by });
    return true;
  }

  async function load(ids) {
    ids = [...new Set(ids)].filter(Boolean);
    if (!ids.length || !sb() || !user()) return;
    const { data, error } = await sb().from('character_play').select('character_id, data, updated_at, updated_by').in('character_id', ids);
    if (error) { lastErr = Notes.friendly(error); if (/character_play|play_change/.test(lastErr)) lastErr = 'Run the latest supabase/setup.sql to switch on live sheets.'; return; }
    lastErr = '';
    let changed = false;
    for (const r of data || []) changed = put(r) || changed;
    for (const id of ids) if (!cache.has(id)) { cache.set(id, { data: {} }); changed = true; }
    if (changed) redraw();
  }

  // apply a change: hp delta (damage negative, healing positive) and/or whole keys to replace
  async function change(id, delta, patch) {
    if (!sb() || !user()) return;
    const cur = (cache.get(id) || { data: {} }).data;
    // show it straight away; the server's answer replaces it
    const guess = { ...cur, ...(patch || {}) };
    if (delta) {
      const mx = guess.max | 0; let hp = guess.hp == null ? mx : guess.hp | 0; let tmp = Math.max(0, guess.temp | 0);
      if (delta < 0) { let d = -delta; const t = Math.min(tmp, d); tmp -= t; d -= t; hp = Math.max(0, hp - d); } else hp = mx ? Math.min(mx, hp + delta) : hp + delta;
      guess.hp = hp; guess.temp = tmp;
    }
    cache.set(id, { ...(cache.get(id) || {}), data: guess });
    pending.set(id, (pending.get(id) || 0) + 1);
    render();
    const { data, error } = await sb().rpc('play_change', { ch: id, hp_delta: delta | 0, patch: patch || {} });
    pending.set(id, pending.get(id) - 1);
    if (error) { lastErr = Notes.friendly(error); if (/play_change|character_play/.test(lastErr)) lastErr = 'Run the latest supabase/setup.sql to switch on live sheets.'; await load([id]); render(); return; }
    lastErr = '';
    if (!pending.get(id)) cache.set(id, { data: data || guess, updated_at: new Date().toISOString(), updated_by: user().id });
    redraw();
  }

  // keep these characters fresh while something on screen shows them
  function watch(ids) {
    const before = [...watched].join();
    watched.clear();
    for (const id of ids) if (id) watched.add(id);
    if ([...watched].join() !== before) load([...watched]);
    if (watched.size && !channel && sb() && sb().channel) {
      try {
        channel = sb().channel('play-live')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'character_play' }, p => { if (p && p.new && put(p.new)) redraw(); })
          .subscribe(status => { live = status === 'SUBSCRIBED'; });
      } catch (e) { channel = null; live = false; }
    }
    if (watched.size && !pollT) pollT = setInterval(() => {
      if (!watched.size) { clearInterval(pollT); pollT = null; return; }
      if (document.visibilityState === 'visible') load([...watched]);
    }, live ? 15000 : 4000);
  }

  const get = id => (cache.get(id) || { data: null }).data;

  /* ---------- the sheet ---------- */
  const ago = t => { if (!t) return ''; const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000); return s < 50 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };

  // opts: { id, name, maxHp, canEdit, suggestions: [{name, per, max}], compact }
  function sheet(opts) {
    const id = opts.id;
    if (!cache.has(id)) load([id]);
    watch([...watched, id]);
    const row = cache.get(id) || { data: {} };
    const p = row.data || {};
    const edit = !!opts.canEdit;
    // the sheet's max HP follows the character; set it (and full HP) the first time
    if (edit && opts.maxHp && row.data && cache.has(id) && p.max !== opts.maxHp && !pending.get(id) && !syncing.has(id)) {
      const hp = p.hp == null ? opts.maxHp : Math.min(p.hp, opts.maxHp);
      syncing.add(id);
      setTimeout(() => change(id, 0, { max: opts.maxHp, hp }).finally(() => syncing.delete(id)), 0);
    }
    const max = p.max || opts.maxHp || 0;
    const hp = p.hp == null ? max : p.hp;
    const temp = p.temp | 0;
    const down = max > 0 && hp <= 0;

    const amt = el('input', { type: 'number', min: '0', inputmode: 'numeric', placeholder: 'amount', 'aria-label': 'Damage or healing', class: 'pl-amt', disabled: !edit });
    const doHp = sign => { const n = parseInt(amt.value, 10); if (n > 0) { amt.value = ''; change(id, sign * n); } };
    amt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doHp(-1); } });
    const bar = el('span', { class: 'pl-bar' + (hp / (max || 1) <= 0.33 ? ' low' : hp / (max || 1) <= 0.66 ? ' mid' : '') },
      el('span', { class: 'hp', style: `width:${max ? Math.min(100, hp / max * 100) : 0}%` }),
      temp ? el('span', { class: 'tmp', style: `width:${max ? Math.min(100, temp / max * 100) : 0}%` }) : null);
    const hpBox = el('section', { class: 'pl-hp' + (down ? ' down' : '') },
      el('div', { class: 'pl-hpnum' },
        el('span', { class: 'k' }, 'HP'),
        el('span', { class: 'v' }, String(hp), el('small', {}, ` / ${max || '–'}`)),
        temp ? el('span', { class: 'pl-temp' }, `+${temp} temporary`) : null,
        down ? el('span', { class: 'pl-down' }, 'Down') : null),
      bar,
      edit ? el('div', { class: 'pl-dmg' }, amt,
        el('button', { class: 'btn small primary', onclick: () => doHp(-1) }, 'Damage'),
        el('button', { class: 'btn small', onclick: () => doHp(1) }, 'Heal'),
        el('label', { class: 'pl-tempf' }, el('span', {}, 'Temp HP'),
          el('input', { type: 'number', min: '0', inputmode: 'numeric', value: String(temp), onchange: e => change(id, 0, { temp: Math.max(0, parseInt(e.target.value, 10) || 0) }) }))) : null,
      edit && down ? el('button', { class: 'mini', onclick: () => change(id, 0, { hp: max, saves: { pass: 0, fail: 0 } }) }, 'Back to full HP') : null);

    // death saves while down
    const saves = p.saves || { pass: 0, fail: 0 };
    const pip = (k, i) => el('button', { type: 'button', class: 'pl-pip ' + k + (i < (saves[k] | 0) ? ' on' : ''), disabled: !edit, 'aria-label': `${k === 'pass' ? 'Passed' : 'Failed'} death save ${i + 1}`,
      onclick: () => change(id, 0, { saves: { ...saves, [k]: i < (saves[k] | 0) ? i : i + 1 } }) });
    const deathBox = down ? el('section', { class: 'pl-saves' }, el('span', { class: 'k' }, 'Death saves'),
      el('span', { class: 'grp' }, el('span', { class: 'lbl' }, 'Passed'), ...[0, 1, 2].map(i => pip('pass', i))),
      el('span', { class: 'grp' }, el('span', { class: 'lbl' }, 'Failed'), ...[0, 1, 2].map(i => pip('fail', i)))) : null;

    // statuses (the shared list from Core rules)
    const sts = p.statuses || {};
    const setSt = (k, n) => { const next = { ...sts }; if (n > 0) next[k] = Math.min(stCap(k), n); else delete next[k]; change(id, 0, { statuses: next }); };
    const stRows = Object.entries(sts).filter(([, n]) => n > 0).map(([k, n]) => {
      const s0 = stOf(k);
      const lv = s0 && s0.levels ? ` Level ${Math.min(n, s0.levels.length)}: ${s0.levels[Math.min(n, s0.levels.length) - 1]}.` : '';
      return el('div', { class: 'pl-st' },
        el('span', { class: 'nm' }, s0 ? s0.name : k),
        edit ? el('span', { class: 'bs-count' },
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One fewer ${k}`, onclick: () => setSt(k, n - 1) }, '−'),
          el('span', { class: 'v' }, String(n)),
          el('button', { type: 'button', class: 'bs-step', 'aria-label': `One more ${k}`, disabled: n >= stCap(k), onclick: () => setSt(k, n + 1) }, '+')) : el('span', { class: 'v' }, `×${n}`),
        s0 ? el('span', { class: 'tx' }, `${s0.effect.replace(/\.$/, '')}.${lv} Ends: ${s0.ends.replace(/\.$/, '')}.`) : null);
    });
    let stSel = null;
    if (edit) {
      stSel = el('select', { class: 'select pl-stadd', 'aria-label': 'Add a status' }, el('option', { value: '' }, 'Add a status…'), ...statusList().map(s0 => el('option', { value: s0.id }, s0.name)));
      stSel.addEventListener('change', () => { if (stSel.value) setSt(stSel.value, (sts[stSel.value] || 0) + 1); });
    }
    const stBox = el('section', { class: 'pl-sec' }, el('h2', {}, 'Statuses', el('a', { class: 'pl-help', href: '#tab=adv&item=adv%2Fcore-rules%2Fstatus-effects', title: 'What each status does' }, 'How they work')),
      stRows.length ? el('div', { class: 'pl-sts' }, ...stRows) : el('p', { class: 'pl-none' }, 'None.'), stSel);

    // uses per rest, per day and so on
    const trk = p.trackers || [];
    const setTrk = next => change(id, 0, { trackers: next });
    const tRows = trk.map((t, i) => el('div', { class: 'pl-trk' },
      el('span', { class: 'nm' }, t.name, el('span', { class: 'per' }, PER_LABEL[t.per] || '')),
      el('span', { class: 'pips' }, ...Array.from({ length: Math.min(t.max, 20) }, (_, k) => el('button', {
        type: 'button', class: 'pl-use' + (k < (t.used | 0) ? ' used' : ''), disabled: !edit, 'aria-label': `${t.name}: ${k < (t.used | 0) ? 'mark unused' : 'use one'}`,
        onclick: () => { const next = trk.slice(); next[i] = { ...t, used: k < (t.used | 0) ? k : k + 1 }; setTrk(next); } }))),
      el('span', { class: 'left' }, `${Math.max(0, t.max - (t.used | 0))} left`),
      edit ? el('button', { class: 'mini', 'aria-label': `Remove ${t.name}`, onclick: () => setTrk(trk.filter((_, k) => k !== i)) }, 'Remove') : null));
    const reset = pers => { const next = trk.map(t => pers.includes(t.per) ? { ...t, used: 0 } : t); setTrk(next); };
    let addRow = null;
    if (edit) {
      const nm = el('input', { type: 'text', placeholder: 'e.g. Second Wind, tier 1 spells', maxlength: '60', 'aria-label': 'What it counts' });
      const mx = el('input', { type: 'number', min: '1', max: '20', value: '1', inputmode: 'numeric', 'aria-label': 'Uses' });
      const per = el('select', { class: 'select', 'aria-label': 'Resets' }, ...PERS.map(([k, l]) => el('option', { value: k }, l)));
      const add = () => { const n = nm.value.trim(); if (!n) { nm.focus(); return; } setTrk([...trk, { id: uid(), name: n.slice(0, 60), max: Math.max(1, Math.min(20, parseInt(mx.value, 10) || 1)), per: per.value, used: 0 }]); };
      nm.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      const sugg = (opts.suggestions || []).filter(s => !trk.some(t => t.name === s.name));
      addRow = el('div', { class: 'pl-addt' },
        el('div', { class: 'row' }, nm, mx, per, el('button', { class: 'btn small', onclick: add }, 'Add')),
        sugg.length ? el('p', { class: 'pl-sugg' }, el('span', { class: 'k' }, 'From your feats'), ...sugg.map(s => el('button', { type: 'button', class: 'chip', title: s.text || '', onclick: () => setTrk([...trk, { id: uid(), name: s.name, max: s.max, per: s.per, used: 0 }]) }, `${s.name} · ${(PER_LABEL[s.per] || '').toLowerCase()}`))) : null);
    }
    const trkBox = el('section', { class: 'pl-sec' }, el('h2', {}, 'Uses'),
      tRows.length ? el('div', { class: 'pl-trks' }, ...tRows) : el('p', { class: 'pl-none' }, edit ? 'Add anything you use a set number of times: a feat, a skill, spells of a tier.' : 'None.'),
      edit && trk.length ? el('div', { class: 'pl-rests' }, el('span', { class: 'k' }, 'Reset after a'),
        el('button', { class: 'btn small', onclick: () => reset(['rest']), title: 'Per rest uses come back' }, 'Short rest'),
        el('button', { class: 'btn small', onclick: () => reset(['rest', 'long']), title: 'Per rest and per long rest uses come back' }, 'Long rest'),
        el('button', { class: 'mini', onclick: () => reset(['day']) }, 'New day'),
        el('button', { class: 'mini', onclick: () => reset(['session']) }, 'New session'),
        el('button', { class: 'mini', onclick: () => reset(['arc']) }, 'New arc')) : null,
      addRow);

    const noteBox = opts.compact ? null : el('section', { class: 'pl-sec' }, el('h2', {}, 'Table notes'),
      el('textarea', { class: 'pl-notes', rows: '3', maxlength: '2000', disabled: !edit, placeholder: edit ? 'Concentrating on…, owes the ferryman…, anything to remember this session' : '', onchange: e => change(id, 0, { notes: e.target.value.slice(0, 2000) }) }, p.notes || ''));

    const who = row.updated_by && user() && row.updated_by !== user().id ? ' by the DM or another player' : '';
    return el('div', { class: 'pl' + (opts.compact ? ' compact' : '') },
      lastErr ? el('p', { class: 'notes-msg', role: 'alert' }, lastErr) : null,
      hpBox, deathBox, stBox, trkBox, noteBox,
      el('p', { class: 'pl-foot' }, row.updated_at ? `Last changed ${ago(row.updated_at)}${who}. ` : '', live ? 'Live.' : 'Updates every few seconds.'));
  }

  return { load, change, watch, get, sheet, live: () => live };
};
