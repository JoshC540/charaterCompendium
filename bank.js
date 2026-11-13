/* Party money: a shared party account per campaign (withdrawals need two players to agree, or the DM),
   and a purse for each character in the campaign. Every movement is a ledger line; balances are sums.
   All changes go through database functions (see supabase/setup.sql), so the rules can't be bypassed. */
window.HandbookBank = function (H) {
  'use strict';
  const { el, state, go, render, Notes } = H;

  const DENOMS = [['pp', 1000000], ['gp', 10000], ['sp', 100], ['cp', 1]];
  // 1234567 cp → "1 pp 23 gp 45 sp 67 cp"
  const fmt = cp => {
    const n = Math.abs(Number(cp) || 0);
    const out = [[Math.floor(n / 1000000), 'pp'], [Math.floor(n % 1000000 / 10000), 'gp'], [Math.floor(n % 10000 / 100), 'sp'], [n % 100, 'cp']]
      .filter(([v]) => v).map(([v, k]) => `${v.toLocaleString()} ${k}`);
    return (cp < 0 ? '−' : '') + (out.join(' ') || '0 cp');
  };
  const KIND = { deposit: 'Deposit', withdrawal: 'Withdrawal', gift: 'Gift', spend: 'Spent', adjust: 'DM' };

  let data = null, loading = false, loadErr = '';
  let camp = null;                       // { id, tx, requests, votes, chars } for the open campaign
  let campLoading = false;
  let form = null;                       // which action form is open
  let vals = {};                         // what's typed in it, kept if the action fails
  let msg = '', busy = false;

  const sb = () => Notes && Notes.client && Notes.client();
  const user = () => Notes && Notes.user && Notes.user();
  const admin = () => !!(Notes && Notes.isAdmin && Notes.isAdmin());
  const nameOf = id => { const p = data && data.profiles.find(x => x.id === id); return p ? p.display_name : 'Someone'; };

  function init() {
    if (Notes && Notes.onAuth) Notes.onAuth(() => { data = null; camp = null; form = null; msg = ''; if (state.tab === 'bank') render(); });
  }

  async function load() {
    if (loading || !sb() || !user()) return;
    loading = true; loadErr = '';
    try {
      const [c, m, p, ch] = await Promise.all([
        sb().from('campaigns').select('*').order('created_at', { ascending: true }),
        sb().from('campaign_members').select('*'),
        sb().from('profiles').select('id, display_name'),
        sb().from('characters').select('id, name, owner_id, campaign_id'),
      ]);
      const err = [c, m, p, ch].find(r => r.error);
      if (err) throw err.error;
      data = { campaigns: c.data || [], members: m.data || [], profiles: p.data || [], characters: ch.data || [] };
    } catch (e) { loadErr = friendly(e); data = null; }
    loading = false;
    if (state.tab === 'bank') render();
  }

  async function loadCamp(id) {
    if (campLoading || !sb()) return;
    campLoading = true;
    try {
      const [tx, rq, vt, ch] = await Promise.all([
        sb().from('money_tx').select('*').eq('campaign_id', id).order('created_at', { ascending: true }),
        sb().from('money_requests').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
        sb().from('money_votes').select('*'),
        sb().rpc('campaign_characters', { c: id }),
      ]);
      const err = [tx, rq, vt, ch].find(r => r.error);
      if (err) throw err.error;
      const ids = new Set((rq.data || []).map(r => r.id));
      camp = { id, tx: tx.data || [], requests: rq.data || [], votes: (vt.data || []).filter(v => ids.has(v.request_id)), chars: ch.data || [] };
    } catch (e) { msg = friendly(e); camp = { id, tx: [], requests: [], votes: [], chars: [] }; }
    campLoading = false;
    if (state.tab === 'bank') render();
  }

  const friendly = e => (Notes && Notes.friendly ? Notes.friendly(e) : (e && e.message) || String(e));

  async function act(fn, done) {
    if (busy) return;
    busy = true; msg = ''; render();
    try {
      const r = await fn();
      if (r && r.error) throw r.error;
      if (done) done(r);
    } catch (e) { msg = friendly(e); }
    busy = false;
    await load();
    if (camp) { const id = camp.id; camp = null; await loadCamp(id); }
    render();
  }

  /* ---------- derived ---------- */
  const myCampaigns = () => !data ? [] : admin() ? data.campaigns : data.campaigns.filter(c => data.members.some(m => m.campaign_id === c.id && m.user_id === user().id));
  const currentCampaign = () => {
    const list = myCampaigns();
    return list.find(c => c.id === state.camp) || (list.length === 1 ? list[0] : null) || (state.camp ? null : list[0] || null);
  };
  const balance = acct => camp ? camp.tx.filter(t => (t.character_id || null) === (acct === 'party' ? null : acct)).reduce((a, t) => a + Number(t.amount_cp), 0) : 0;
  const myChars = c => data.characters.filter(x => x.owner_id === user().id && x.campaign_id === c.id);
  const charName = id => { const x = (camp && camp.chars.find(y => y.id === id)) || (data && data.characters.find(y => y.id === id)); return x ? x.name : 'A character'; };
  const votesFor = r => camp.votes.filter(v => v.request_id === r.id);
  const pending = () => camp ? camp.requests.filter(r => r.status === 'pending') : [];
  const gameDateKey = id => 'hb-game-date-' + id;
  const lastDate = id => { try { return localStorage.getItem(gameDateKey(id)) || ''; } catch (e) { return ''; } };
  const keepDate = (id, v) => { try { localStorage.setItem(gameDateKey(id), v); } catch (e) { /* private mode */ } };

  /* ---------- list pane ---------- */
  function renderList(box, meta) {
    meta.textContent = '';
    const status = Notes ? Notes.status() : 'offline';
    if (status === 'loading') { box.replaceChildren(el('div', { class: 'empty' }, 'Loading…')); return; }
    if (status === 'offline' || !sb()) { box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Party money is unavailable'), 'The sign-in service couldn’t be reached. The rest of the handbook still works.')); return; }
    if (!user()) {
      box.replaceChildren(el('div', { class: 'notes-gate' },
        el('h1', {}, 'Party money'),
        el('p', {}, 'Your party’s shared account and each character’s purse. Taking coin out of the party account needs two players to agree. Sign in to see your campaign’s money.'),
        el('button', { class: 'btn primary', onclick: () => Notes.openSignIn() }, 'Sign in')));
      return;
    }
    if (!data) { if (!loading) load(); box.replaceChildren(el('div', { class: 'empty' }, loadErr ? el('strong', {}, loadErr) : 'Loading…')); return; }
    const list = myCampaigns();
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, admin() ? 'No campaigns yet' : 'You’re not in a campaign yet'),
        admin() ? 'Create a campaign on the Notes tab, then add players here.' : 'Ask your DM to add you to the campaign.'));
      return;
    }
    const c = currentCampaign();
    const kids = [];
    if (list.length > 1 || !c) kids.push(el('label', { class: 'bk-camp' }, el('span', { class: 'k' }, 'Campaign'),
      el('select', { class: 'select', onchange: e => { camp = null; form = null; msg = ''; go({ camp: e.target.value, acct: '' }, true); } },
        c ? null : el('option', { value: '' }, '— choose a campaign —'),
        ...list.map(x => el('option', { value: x.id, selected: c && x.id === c.id }, x.name)))));
    if (!c) { box.replaceChildren(...kids); return; }
    if (!camp || camp.id !== c.id) { if (!campLoading) loadCamp(c.id); kids.push(el('div', { class: 'empty' }, 'Loading…')); box.replaceChildren(...kids); return; }

    const acct = state.acct || 'party';
    const card = (key, title, sub, amount, extra) => el('button', { class: 'card bk-acct' + (acct === key ? ' sel' : ''), onclick: () => { form = null; vals = {}; msg = ''; go({ acct: key }, true); } },
      el('div', { class: 'card-top' }, el('span', { class: 'card-name' }, title), el('span', { class: 'bk-amt' }, fmt(amount))),
      sub ? el('div', { class: 'card-snip' }, sub) : null, extra || null);
    const p = pending();
    const waitingOnMe = p.filter(r => !votesFor(r).some(v => v.user_id === user().id)).length;
    kids.push(el('div', { class: 'section-head' }, c.name),
      card('party', 'Party account', p.length ? `${p.length} request${p.length === 1 ? '' : 's'} waiting${waitingOnMe ? ` · ${waitingOnMe} need${waitingOnMe === 1 ? 's' : ''} your approval` : ''}` : 'Shared by the whole party', balance('party'),
        waitingOnMe ? el('span', { class: 'bk-dot', 'aria-label': 'Needs your approval' }) : null));
    const mine = myChars(c);
    if (mine.length) {
      kids.push(el('div', { class: 'section-head' }, mine.length === 1 ? 'Your purse' : 'Your purses'));
      for (const x of mine) kids.push(card(x.id, x.name, 'Coin this character carries', balance(x.id)));
    }
    if (admin()) {
      const others = camp.chars.filter(x => x.owner_id !== user().id);
      if (others.length) {
        kids.push(el('div', { class: 'section-head' }, 'Every purse'));
        for (const x of others) kids.push(card(x.id, x.name, nameOf(x.owner_id), balance(x.id)));
      }
    }
    // join a character to this campaign
    const free = data.characters.filter(x => x.owner_id === user().id && x.campaign_id !== c.id);
    const member = admin() || data.members.some(m => m.campaign_id === c.id && m.user_id === user().id);
    if (member && free.length) kids.push(el('div', { class: 'bk-join' },
      el('label', {}, el('span', { class: 'k' }, mine.length ? 'Add another character' : 'Add your character to this campaign'),
        el('select', { class: 'select', onchange: e => { const id = e.target.value; if (id) act(() => sb().from('characters').update({ campaign_id: c.id }).eq('id', id), () => go({ acct: id }, true)); } },
          el('option', { value: '' }, '— choose a saved character —'),
          ...free.map(x => el('option', { value: x.id }, x.name + (x.campaign_id ? ` (in ${(data.campaigns.find(k => k.id === x.campaign_id) || {}).name || 'another campaign'})` : '')))))));
    else if (member && !mine.length && !admin()) kids.push(el('p', { class: 'd-note' }, 'Save a character in the Characters tab, then add it here to get a purse.'));
    if (admin()) kids.push(playersBox(c));
    box.replaceChildren(...kids);
  }

  function playersBox(c) {
    const ids = data.members.filter(m => m.campaign_id === c.id).map(m => m.user_id);
    const rest = data.profiles.filter(p => !ids.includes(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));
    return el('div', { class: 'bk-players' },
      el('div', { class: 'section-head' }, `Players in ${c.name}`),
      ids.length ? el('div', { class: 'bk-chips' }, ...ids.map(id => el('span', { class: 'bk-chip' }, nameOf(id),
        el('button', { class: 'mini danger', 'aria-label': `Remove ${nameOf(id)} from ${c.name}`, title: 'Remove from campaign',
          onclick: () => act(() => sb().from('campaign_members').delete().eq('campaign_id', c.id).eq('user_id', id)) }, '×'))))
        : el('p', { class: 'd-note' }, 'No players yet. Add them so they can see the party account.'),
      rest.length ? el('select', { class: 'select', 'aria-label': 'Add a player', onchange: e => { const id = e.target.value; if (id) act(() => sb().from('campaign_members').insert({ campaign_id: c.id, user_id: id })); } },
        el('option', { value: '' }, '+ Add a player…'), ...rest.map(p => el('option', { value: p.id }, p.display_name))) : null);
  }

  /* ---------- detail pane ---------- */
  function amountInput() {
    const box = el('div', { class: 'bk-amount' }, ...DENOMS.map(([k]) => el('label', {}, el('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', class: 'num', name: k, 'aria-label': k, placeholder: '0', value: vals[k] || null, oninput: e => { vals[k] = e.target.value; } }), el('span', {}, k))));
    box.value = () => DENOMS.reduce((a, [k, v]) => a + Math.max(0, Math.floor(Number(box.querySelector(`[name=${k}]`).value) || 0)) * v, 0);
    return box;
  }
  function actionForm(c, kind, acct) {
    const amt = amountInput();
    const sign = el('select', { class: 'select', 'aria-label': 'Add or remove' }, el('option', { value: '1' }, 'Add'), el('option', { value: '-1' }, 'Remove'));
    const mine = myChars(c);
    const fromSel = el('select', { class: 'select', 'aria-label': 'Which purse' }, ...mine.map(x => el('option', { value: x.id, selected: x.id === acct }, `${x.name} · ${fmt(balance(x.id))}`)));
    const toSel = el('select', { class: 'select', 'aria-label': 'Give to' }, ...camp.chars.filter(x => x.id !== acct).map(x => el('option', { value: x.id }, x.name)));
    const reason = el('input', { type: 'text', maxlength: '200', value: vals.reason || null, oninput: e => { vals.reason = e.target.value; }, placeholder: kind === 'request' ? 'What it’s for, e.g. Ferry to Axeholm' : kind === 'spend' ? 'What you bought' : 'Reason (optional)', 'aria-label': 'Reason' });
    const gdate = el('input', { type: 'text', maxlength: '60', value: lastDate(c.id), placeholder: 'e.g. 26th Zinkeday', 'aria-label': 'In-game date' });
    const titles = { deposit: 'Put coin into the party account', request: 'Ask to take coin from the party account', give: 'Give coin to another character', spend: 'Spend coin', adjust: 'Add or remove coin (DM)' };
    const go2 = async () => {
      const v = amt.value();
      if (!v) { msg = 'Enter an amount.'; render(); return; }
      keepDate(c.id, gdate.value.trim());
      const args = { amount: v, reason: reason.value.trim() || null, game_date: gdate.value.trim() || null };
      const ch = acct === 'party' ? fromSel.value : acct;
      const fns = {
        deposit: () => sb().rpc('money_deposit', { c: c.id, ch, ...args }),
        request: () => sb().rpc('money_request', { c: c.id, ch, ...args }),
        give: () => sb().rpc('money_give', { c: c.id, from_ch: ch, to_ch: toSel.value, ...args, reason: `${charName(ch)} → ${charName(toSel.value)}${args.reason ? ': ' + args.reason : ''}`.slice(0, 200) }),
        spend: () => sb().rpc('money_spend', { c: c.id, ch, ...args }),
        adjust: () => sb().rpc('money_adjust', { c: c.id, ch: acct === 'party' ? null : acct, ...args, amount: v * Number(sign.value) }),
      };
      await act(fns[kind], () => { form = null; vals = {}; msg = kind === 'request' ? (admin() ? 'Done: the coin is in the purse.' : 'Asked. One more player needs to approve it.') : 'Done.'; });
    };
    const pickPurse = ['deposit', 'request'].includes(kind) && acct === 'party' && mine.length > 1;
    return el('form', { class: 'bk-form', onsubmit: e => { e.preventDefault(); go2(); } },
      el('h3', { class: 'cc-h3' }, titles[kind]),
      kind === 'adjust' ? el('div', { class: 'bk-row' }, sign, amt) : amt,
      pickPurse ? el('label', { class: 'bk-field' }, el('span', { class: 'k' }, kind === 'deposit' ? 'From' : 'Into'), fromSel) : null,
      kind === 'give' ? el('label', { class: 'bk-field' }, el('span', { class: 'k' }, 'To'), toSel) : null,
      el('label', { class: 'bk-field' }, el('span', { class: 'k' }, kind === 'request' ? 'For' : 'Reason'), reason),
      el('label', { class: 'bk-field' }, el('span', { class: 'k' }, 'In-game date'), gdate),
      kind === 'request' && !admin() ? el('p', { class: 'd-note' }, 'Asking counts as your approval. It goes through when one other player approves it.') : null,
      el('div', { class: 'bk-btns' },
        el('button', { class: 'btn primary', type: 'submit', disabled: busy }, busy ? 'Working…' : { deposit: 'Deposit', request: 'Ask', give: 'Give', spend: 'Spend', adjust: 'Save' }[kind]),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => { form = null; vals = {}; msg = ''; render(); } }, 'Cancel')));
  }

  function requestRow(r) {
    const votes = votesFor(r), voted = votes.some(v => v.user_id === user().id);
    const enough = votes.length >= 2;
    const mineToCancel = r.requested_by === user().id || admin();
    const state2 = r.status === 'approved' ? 'Paid out' : r.status === 'cancelled' ? 'Cancelled' : enough ? 'Approved · waiting for the party account to have enough' : `${votes.length} of 2 approvals`;
    return el('div', { class: 'bk-req ' + r.status },
      el('div', { class: 'bk-req-h' },
        el('strong', {}, fmt(r.amount_cp)), el('span', {}, ` to ${charName(r.character_id)}`),
        r.reason ? el('span', { class: 'bk-reason' }, ` · ${r.reason}`) : null),
      el('div', { class: 'bk-req-m' }, `Asked by ${nameOf(r.requested_by)}${r.game_date ? ` · ${r.game_date}` : ''} · `, el('span', { class: 'bk-state' }, state2),
        votes.length ? el('span', { class: 'bk-voters' }, ` (${votes.map(v => nameOf(v.user_id)).join(', ')})`) : null),
      r.status === 'pending' ? el('div', { class: 'bk-btns' },
        admin() ? el('button', { class: 'btn small primary', disabled: busy, onclick: () => act(() => sb().rpc('money_approve', { rid: r.id }), res => { msg = res.data === 'short' ? 'The party account doesn’t have enough yet.' : 'Paid out.'; }) }, 'Approve now')
          : !voted ? el('button', { class: 'btn small primary', disabled: busy, onclick: () => act(() => sb().rpc('money_approve', { rid: r.id }), res => { msg = res.data === 'approved' ? 'Approved and paid out.' : res.data === 'short' ? 'Approved, but the party account doesn’t have enough yet.' : 'Approved.'; }) }, 'Approve')
            : enough ? el('button', { class: 'btn small', disabled: busy, onclick: () => act(() => sb().rpc('money_approve', { rid: r.id }), res => { msg = res.data === 'approved' ? 'Paid out.' : 'Still not enough in the party account.'; }) }, 'Try paying out') : el('span', { class: 'hint' }, 'You’ve approved this'),
        mineToCancel ? el('button', { class: 'btn small ghost', disabled: busy, onclick: () => act(() => sb().rpc('money_cancel', { rid: r.id }), () => { msg = 'Cancelled.'; }) }, admin() && r.requested_by !== user().id ? 'Turn down' : 'Cancel') : null) : null);
  }

  function history(acct) {
    const rows = camp.tx.filter(t => (t.character_id || null) === (acct === 'party' ? null : acct));
    if (!rows.length) return el('p', { class: 'd-note' }, 'Nothing yet.');
    let run = 0;
    const lines = rows.map(t => { run += Number(t.amount_cp); return { t, run }; }).reverse();
    return el('table', { class: 'bk-ledger' },
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'What'), el('th', { class: 'r' }, 'Amount'), el('th', { class: 'r' }, 'Balance'))),
      el('tbody', {}, ...lines.map(({ t, run }) => el('tr', {},
        el('td', {}, t.game_date || '', el('span', { class: 'bk-real' }, new Date(t.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))),
        el('td', {}, el('strong', {}, KIND[t.kind] || t.kind), t.reason ? ` · ${t.reason}` : '', el('span', { class: 'bk-by' }, nameOf(t.created_by))),
        el('td', { class: 'r ' + (t.amount_cp > 0 ? 'in' : 'out') }, (t.amount_cp > 0 ? '+' : '') + fmt(t.amount_cp)),
        el('td', { class: 'r' }, fmt(run))))));
  }

  function renderDetail(pane) {
    document.body.classList.toggle('has-detail', !!(state.acct));
    pane.classList.toggle('placeholder', !state.acct);   // phones: the party account opens when you tap it
    if (!user() || !data) { pane.replaceChildren(); return false; }
    const c = currentCampaign();
    if (!c || !camp || camp.id !== c.id) { pane.replaceChildren(); return false; }
    const acct = state.acct || 'party';
    const isParty = acct === 'party';
    const ch = !isParty && camp.chars.find(x => x.id === acct);
    if (!isParty && !ch) { pane.replaceChildren(el('div', { class: 'empty' }, 'That purse isn’t in this campaign.')); return true; }
    const mine = myChars(c);
    const ownsThis = !isParty && ch.owner_id === user().id;
    const member = admin() || data.members.some(m => m.campaign_id === c.id && m.user_id === user().id);
    const btn = (k, label, primary) => el('button', { class: 'btn small' + (primary ? ' primary' : '') + (form === k ? ' on' : ''), 'aria-expanded': String(form === k), onclick: () => { form = form === k ? null : k; vals = {}; msg = ''; render(); } }, label);
    const actions = isParty
      ? [mine.length ? btn('deposit', 'Deposit') : null, mine.length ? btn('request', 'Ask to withdraw', true) : null, admin() ? btn('adjust', 'Add or remove coin') : null]
      : [ownsThis ? btn('request', 'Ask the party for coin', true) : null, ownsThis ? btn('deposit', 'Put into party account') : null,
        ownsThis && camp.chars.length > 1 ? btn('give', 'Give') : null, ownsThis ? btn('spend', 'Spend') : null, admin() ? btn('adjust', 'Add or remove coin') : null];
    const reqs = isParty ? camp.requests : camp.requests.filter(r => r.character_id === acct);
    const open = reqs.filter(r => r.status === 'pending');
    const done = reqs.filter(r => r.status !== 'pending').slice(0, 5);
    pane.replaceChildren(...[
      el('button', { class: 'back', onclick: () => go({ acct: '' }, true) }, '← Accounts'),
      el('div', { class: 'd-kicker' }, el('span', { class: 'badge notes' }, isParty ? 'Party account' : 'Purse'), el('span', {}, c.name)),
      el('h1', { class: 'd-title' }, isParty ? 'Party account' : ch.name),
      el('div', { class: 'bk-balance' }, el('span', { class: 'v' }, fmt(balance(acct))), el('span', { class: 'k' }, isParty ? 'shared by the party' : ownsThis ? 'carried' : `carried · ${nameOf(ch.owner_id)}’s character`)),
      member ? el('div', { class: 'bk-actions' }, ...actions.filter(Boolean)) : el('p', { class: 'd-note' }, 'You’re viewing this campaign without being one of its players.'),
      form ? actionForm(c, form, acct) : null,
      msg ? el('p', { class: 'notes-msg' + (/^(Done|Paid|Approved|Asked|Cancelled)/.test(msg) ? ' ok' : ''), role: 'status' }, msg) : null,
      open.length ? el('section', { class: 'd-section' }, el('h2', {}, isParty ? 'Waiting for approval' : 'Requests waiting'), ...open.map(requestRow)) : null,
      el('section', { class: 'd-section' }, el('h2', {}, 'History'), history(acct)),
      done.length ? el('section', { class: 'd-section' }, el('h2', {}, 'Recent requests'), ...done.map(requestRow)) : null,
      el('div', { class: 'bk-btns' }, el('button', { class: 'mini', onclick: async () => { const id = camp.id; camp = null; await load(); await loadCamp(id); } }, '↻ Refresh'))].filter(Boolean));
    document.title = `${isParty ? 'Party account' : ch.name} · Player’s Handbook`;
    return true;
  }

  return { init, renderList, renderDetail, fmt };
};
