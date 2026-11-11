/* Player's Handbook — sign-in and shared session notes (Supabase).
   The handbook works without this file; it only adds the account button and the Notes tab. */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://adeahwjowoywcunewwno.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZWFod2pvd295d2N1bmV3d25vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMDE5NzUsImV4cCI6MjEwOTg3Nzk3NX0.rs8CLX5Us_LNErEqf9mBudSn0OW2nrazxYlN5cuK6yg';

  window.HandbookNotes = function (H) {
    const { el, md, plain, norm, highlight, state, go, render, $ } = H;

    let sb = null;                 // supabase client
    let status = 'loading';        // loading | ready | offline
    let user = null, me = null;    // auth user, profile row
    let data = null;               // { campaigns, sessions, notes, profiles }
    let loadingData = false, loadError = '';
    const authListeners = [];
    let ui = { editing: null, confirmDelete: null, addSession: null, addCampaign: false, renaming: null, busy: false, msg: '' };

    const admin = () => !!(me && me.is_admin);
    const nameOf = id => (data && data.profiles.find(p => p.id === id) || {}).display_name || 'Someone';
    const sessionsOf = cid => data.sessions.filter(s => s.campaign_id === cid).sort((a, b) => b.number - a.number);
    const notesOf = sid => data.notes.filter(n => n.session_id === sid).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const when = iso => {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
        d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    };
    const day = s => s ? new Date(s + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const sessionLabel = s => `Session ${s.number}${s.title ? ': ' + s.title : ''}`;
    const friendly = e => {
      const m = (e && (e.message || e.error_description)) || String(e || 'Something went wrong');
      if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match.';
      if (/duplicate key.*number/i.test(m)) return 'That campaign already has a session with that number.';
      if (/row-level security|permission denied/i.test(m)) return 'You don’t have permission to do that.';
      if (/Failed to fetch|NetworkError/i.test(m)) return 'Couldn’t reach the server. Check your connection.';
      if (/Could not find the function|admin_set_password/i.test(m)) return 'Run the latest supabase/setup.sql first (it adds password resets).';
      return m;
    };

    /* ---------------- boot ---------------- */

    function loadLib() {
      if (window.supabase && window.supabase.createClient) return Promise.resolve();
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/supabase.js'; s.onload = res; s.onerror = rej;
        document.head.append(s);
      });
    }

    async function init() {
      renderAccount();
      try {
        await loadLib();
        sb = (H.createClient || window.supabase.createClient)(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
        const linkError = new URLSearchParams(location.hash.slice(1)).get('error_description');
        let recovering = /type=recovery/.test(location.hash);
        sb.auth.onAuthStateChange((evt, session) => {
          if (evt === 'PASSWORD_RECOVERY') recovering = true;
          const next = session ? session.user : null;
          const changed = (next && next.id) !== (user && user.id);
          const p = changed ? setUser(next) : Promise.resolve();
          if (recovering && next) { recovering = false; p.then(() => openNewPassword()); }
        });
        const { data: { session } } = await sb.auth.getSession();
        status = 'ready';
        if ((session && session.user && session.user.id) !== (user && user.id)) await setUser(session ? session.user : null);
        else renderAccount();
        if (linkError) {
          history.replaceState(null, '', location.pathname + location.search);
          dialog('That link didn’t work',
            el('p', { class: 'dlg-note' }, /expired|invalid/i.test(linkError)
              ? 'The email link has expired or was already used. Ask your DM to set a new password for you.'
              : linkError),
            el('div', { class: 'dlg-foot' }, el('button', { class: 'btn', onclick: () => $('#hb-dialog').close() }, 'OK')));
        }
      } catch (e) {
        console.warn('Sign-in unavailable:', e);
        status = 'offline';
        renderAccount();
        authListeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
        if (state.tab === 'notes') render();
      }
    }

    async function setUser(u) {
      user = u; me = null; data = null; loadError = '';
      if (u) {
        const { data: prof } = await sb.from('profiles').select('id, display_name, is_admin').eq('id', u.id).maybeSingle();
        me = prof || { id: u.id, display_name: u.email.split('@')[0], is_admin: false };
      }
      renderAccount();
      authListeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
      if (state.tab === 'notes') { if (u) await refresh(); render(); }
    }

    async function refresh() {
      if (!sb || !user || loadingData) return;
      loadingData = true;
      try {
        const q = (t, cols, order) => sb.from(t).select(cols).order(order, { ascending: true });
        const [c, s, n, p] = await Promise.all([
          q('campaigns', 'id, name, created_at', 'created_at'),
          q('sessions', 'id, campaign_id, number, title, played_on, created_by, created_at', 'number'),
          q('notes', 'id, session_id, author_id, body, created_at, updated_at', 'created_at'),
          q('profiles', 'id, display_name, is_admin', 'display_name'),
        ]);
        const err = c.error || s.error || n.error || p.error;
        if (err) throw err;
        data = { campaigns: c.data, sessions: s.data, notes: n.data, profiles: p.data };
        loadError = '';
        const mine = data.profiles.find(x => x.id === user.id);
        if (mine) me = mine;
      } catch (e) {
        loadError = friendly(e);
      } finally {
        loadingData = false;
      }
    }

    // run a change, then reload everything and redraw
    async function act(fn, after) {
      if (ui.busy) return;
      ui.busy = true; ui.msg = '';
      let post = null;
      try {
        const r = await fn();
        if (r && r.error) throw r.error;
        if (after) post = after(r);
      } catch (e) {
        ui.msg = friendly(e);
      }
      ui.busy = false;
      await refresh();
      if (typeof post === 'function') post(); else render();
    }

    /* ---------------- account button & dialogs ---------------- */

    function renderAccount() {
      const box = $('#account');
      if (!box) return;
      if (status === 'loading') { box.replaceChildren(el('button', { class: 'acct', disabled: true }, '…')); return; }
      if (status === 'offline') { box.replaceChildren(el('button', { class: 'acct', disabled: true, title: 'Sign-in couldn’t load. Check your connection.' }, 'Sign in')); return; }
      box.replaceChildren(user
        ? el('button', { class: 'acct on', onclick: openAccount, title: 'Your account' }, el('span', { class: 'dot' }), me ? me.display_name : 'Account')
        : el('button', { class: 'acct', onclick: () => openSignIn() }, 'Sign in'));
    }

    function dialog(title, ...kids) {
      let d = $('#hb-dialog');
      if (!d) { d = el('dialog', { id: 'hb-dialog', class: 'hb-dialog' }); document.body.append(d); d.addEventListener('click', e => { if (e.target === d) d.close(); }); }
      d.replaceChildren(el('div', { class: 'dlg' },
        el('button', { class: 'dlg-x', 'aria-label': 'Close', onclick: () => d.close() }, '×'),
        el('h2', {}, title), ...kids));
      if (!d.open) d.showModal();
      return d;
    }

    function openSignIn(reason) {
      const err = el('p', { class: 'dlg-err', role: 'alert' });
      const email = el('input', { type: 'email', name: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
      const pw = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
      const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
      const d = dialog('Sign in',
        el('p', { class: 'dlg-note' }, reason || 'Sign in to read and write the shared session notes. Your DM gives you your login.'),
        el('form', {
          class: 'dlg-form', onsubmit: async e => {
            e.preventDefault();
            btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
            const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
            btn.disabled = false; btn.textContent = 'Sign in';
            if (error) { err.textContent = friendly(error); pw.select(); return; }
            d.close();
          },
        },
          el('label', {}, 'Email', email),
          el('label', {}, 'Password', pw),
          err, btn),
        el('p', { class: 'dlg-fine' }, 'Forgotten your password? Ask your DM to reset it.'));
      setTimeout(() => email.focus(), 30);
    }

    function openNewPassword() {
      const err = el('p', { class: 'dlg-err', role: 'alert' });
      const pw1 = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8', required: true, placeholder: 'At least 8 characters' });
      const pw2 = el('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Type it again' });
      const d = dialog('Choose a new password',
        el('p', { class: 'dlg-note' }, `You’re signed in as ${user.email}. Set a new password to finish.`),
        el('form', {
          class: 'dlg-form', onsubmit: async e => {
            e.preventDefault(); err.className = 'dlg-err';
            if (pw1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
            if (pw1.value !== pw2.value) { err.textContent = 'Those passwords don’t match.'; return; }
            const { error } = await sb.auth.updateUser({ password: pw1.value });
            if (error) { err.textContent = friendly(error); return; }
            d.close();
          },
        }, el('label', {}, 'New password', pw1), el('label', {}, 'Confirm new password', pw2), err,
          el('button', { class: 'btn primary', type: 'submit' }, 'Save password')));
      setTimeout(() => pw1.focus(), 30);
    }

    function openAccount() {
      const nameErr = el('p', { class: 'dlg-err', role: 'alert' });
      const pwErr = el('p', { class: 'dlg-err', role: 'alert' });
      const name = el('input', { type: 'text', maxlength: '40', value: me ? me.display_name : '', required: true });
      const pw1 = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8', placeholder: 'At least 8 characters' });
      const pw2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
      const d = dialog('Your account',
        el('p', { class: 'dlg-note' }, `Signed in as ${user.email}${admin() ? ' · admin' : ''}`),
        el('form', {
          class: 'dlg-form', onsubmit: async e => {
            e.preventDefault(); nameErr.textContent = '';
            const v = name.value.trim(); if (!v) return;
            const { error } = await sb.from('profiles').update({ display_name: v }).eq('id', user.id);
            if (error) { nameErr.textContent = friendly(error); return; }
            me = { ...me, display_name: v }; nameErr.textContent = 'Saved.'; nameErr.classList.add('ok');
            await refresh(); renderAccount(); render();
          },
        }, el('label', {}, 'Name shown on your notes', name), nameErr, el('button', { class: 'btn', type: 'submit' }, 'Save name')),
        el('form', {
          class: 'dlg-form', onsubmit: async e => {
            e.preventDefault(); pwErr.className = 'dlg-err';
            if (pw1.value.length < 8) { pwErr.textContent = 'Use at least 8 characters.'; return; }
            if (pw1.value !== pw2.value) { pwErr.textContent = 'Those passwords don’t match.'; return; }
            const { error } = await sb.auth.updateUser({ password: pw1.value });
            if (error) { pwErr.textContent = friendly(error); return; }
            pw1.value = pw2.value = ''; pwErr.textContent = 'Password changed.'; pwErr.classList.add('ok');
          },
        }, el('label', {}, 'New password', pw1), el('label', {}, 'Confirm new password', pw2), pwErr, el('button', { class: 'btn', type: 'submit' }, 'Change password')),
        admin() ? adminResetForm() : null,
        el('div', { class: 'dlg-foot' },
          el('button', { class: 'btn ghost', onclick: async () => { await sb.auth.signOut(); d.close(); } }, 'Sign out')));
    }

    function adminResetForm() {
      const msg = el('p', { class: 'dlg-err', role: 'alert' });
      const email = el('input', { type: 'email', required: true, placeholder: 'player@example.com', autocomplete: 'off' });
      const pw = el('input', { type: 'text', required: true, minlength: '8', placeholder: 'At least 8 characters', autocomplete: 'off' });
      return el('form', {
        class: 'dlg-form admin', onsubmit: async e => {
          e.preventDefault(); msg.className = 'dlg-err';
          if (pw.value.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
          const { error } = await sb.rpc('admin_set_password', { target_email: email.value.trim(), new_password: pw.value });
          if (error) { msg.textContent = friendly(error); return; }
          msg.textContent = `Done. ${email.value.trim()} can now sign in with that password.`; msg.classList.add('ok');
          pw.value = '';
        },
      }, el('p', { class: 'dlg-sub' }, 'Admin · reset a player’s password'),
        el('label', {}, 'Player’s email', email), el('label', {}, 'New password', pw), msg,
        el('button', { class: 'btn', type: 'submit' }, 'Set password'));
    }

    /* ---------------- list pane ---------------- */

    function gate(box, meta) {
      meta.textContent = '';
      if (status === 'loading') { box.replaceChildren(el('div', { class: 'empty' }, 'Loading…')); return true; }
      if (status === 'offline') {
        box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Notes are unavailable'), 'The sign-in service couldn’t be reached. The rest of the handbook still works.'));
        return true;
      }
      if (!user) {
        box.replaceChildren(el('div', { class: 'notes-gate' },
          el('h1', {}, 'Session notes'),
          el('p', {}, 'The party’s shared notebook: what happened each session, who you met, and what you swore you’d remember. Notes are only visible to signed-in players.'),
          el('button', { class: 'btn primary', onclick: () => openSignIn() }, 'Sign in to read the notes')));
        return true;
      }
      if (!data) {
        box.replaceChildren(el('div', { class: 'empty' }, loadError ? el('strong', {}, loadError) : 'Loading notes…'));
        if (!loadError) refresh().then(render);
        return true;
      }
      return false;
    }

    function renderList(box, meta) {
      if (gate(box, meta)) return;
      const kids = [];
      if (ui.msg && !state.ses) kids.push(el('p', { class: 'notes-msg', role: 'alert' }, ui.msg));

      const qn = norm(state.q);
      if (qn) return renderSearch(box, meta, qn);

      kids.push(el('div', { class: 'notes-bar' },
        el('button', { class: 'btn small ghost', onclick: async () => { await refresh(); render(); }, title: 'Load the latest notes' }, '↻ Refresh'),
        admin() && !ui.addCampaign ? el('button', { class: 'btn small', onclick: () => { ui.addCampaign = true; render(); } }, '+ New campaign') : null));

      if (ui.addCampaign) kids.push(campaignForm(null));

      if (!data.campaigns.length) {
        kids.push(el('div', { class: 'empty' }, el('strong', {}, 'No campaigns yet'),
          admin() ? 'Add your first campaign above, then players can add sessions and notes.' : 'Your DM hasn’t set up a campaign yet.'));
      }

      let total = 0;
      for (const c of data.campaigns) {
        const ss = sessionsOf(c.id);
        kids.push(ui.renaming === c.id ? campaignForm(c) : el('div', { class: 'section-head camp-head' }, c.name,
          admin() ? el('button', { class: 'mini', title: 'Rename campaign', onclick: () => { ui.renaming = c.id; render(); } }, 'Rename') : null));
        if (ui.addSession === c.id) kids.push(sessionForm(c, null));
        else kids.push(el('button', { class: 'add-row', onclick: () => { ui.addSession = c.id; render(); } }, '+ Add a session'));
        for (const s of ss) {
          const n = notesOf(s.id);
          total += n.length;
          const authors = [...new Set(n.map(x => nameOf(x.author_id)))];
          kids.push(el('button', { class: 'card sess' + (state.ses === s.id ? ' sel' : ''), onclick: () => openSession(s.id) },
            el('div', { class: 'card-top' },
              el('span', { class: 'card-name' }, sessionLabel(s)),
              s.played_on ? el('span', { class: 'card-sub' }, day(s.played_on)) : null),
            el('div', { class: 'card-snip' }, n.length ? `${n.length} note${n.length === 1 ? '' : 's'} · ${authors.join(', ')}` : 'No notes yet')));
        }
        if (!ss.length && ui.addSession !== c.id) kids.push(el('p', { class: 'd-note' }, 'No sessions yet.'));
      }
      meta.textContent = data.campaigns.length ? `${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'} · ${total} note${total === 1 ? '' : 's'}` : '';
      box.replaceChildren(...kids);
    }

    function renderSearch(box, meta, qn) {
      const tokens = qn.split(' ').filter(Boolean);
      const hits = data.notes.filter(n => {
        const s = data.sessions.find(x => x.id === n.session_id);
        const hay = norm(`${plain(n.body)} ${nameOf(n.author_id)} ${s ? sessionLabel(s) : ''}`);
        return tokens.every(t => hay.includes(t));
      }).sort((a, b) => b.created_at.localeCompare(a.created_at));
      meta.textContent = `${hits.length} note${hits.length === 1 ? '' : 's'} match`;
      box.replaceChildren(...(hits.length ? hits.slice(0, 200).map(n => {
        const s = data.sessions.find(x => x.id === n.session_id);
        const c = s && data.campaigns.find(x => x.id === s.campaign_id);
        const text = plain(n.body);
        const k = Math.max(0, norm(text).indexOf(tokens[0]) - 60);
        return el('button', { class: 'card', onclick: () => openSession(s.id) },
          el('div', { class: 'card-top' },
            el('span', { class: 'card-name' }, s ? sessionLabel(s) : 'Session'),
            el('span', { class: 'card-sub' }, `${c ? c.name + ' · ' : ''}${nameOf(n.author_id)}`)),
          el('div', { class: 'card-snip', html: highlight((k ? '…' : '') + text.slice(k, k + 220), tokens) }));
      }) : [el('div', { class: 'empty' }, el('strong', {}, 'Nothing found'), `No notes mention “${state.q}”.`)]));
    }

    function campaignForm(c) {
      const name = el('input', { type: 'text', maxlength: '80', required: true, value: c ? c.name : '', placeholder: 'Campaign name' });
      setTimeout(() => name.focus(), 20);
      const cancel = () => { ui.addCampaign = false; ui.renaming = null; render(); };
      return el('form', {
        class: 'inline-form', onsubmit: e => {
          e.preventDefault();
          const v = name.value.trim(); if (!v) return;
          act(() => c ? sb.from('campaigns').update({ name: v }).eq('id', c.id) : sb.from('campaigns').insert({ name: v }), cancel);
        },
      }, name,
        el('div', { class: 'row' },
          el('button', { class: 'btn small primary', type: 'submit' }, c ? 'Save' : 'Add campaign'),
          el('button', { class: 'btn small ghost', type: 'button', onclick: cancel }, 'Cancel'),
          c && admin() ? deleteButton(`campaign-${c.id}`, 'Delete campaign and all its notes', () => act(() => sb.from('campaigns').delete().eq('id', c.id), () => { ui.renaming = null; go({ ses: '' }, false); })) : null));
    }

    function sessionForm(c, s) {
      const next = s ? s.number : (Math.max(0, ...sessionsOf(c.id).map(x => x.number)) + 1);
      const num = el('input', { type: 'number', min: '0', required: true, value: String(next), class: 'num', 'aria-label': 'Session number' });
      const title = el('input', { type: 'text', maxlength: '120', value: s && s.title || '', placeholder: 'Title (optional)', 'aria-label': 'Title' });
      const date = el('input', { type: 'date', value: s ? (s.played_on || '') : new Date().toISOString().slice(0, 10), 'aria-label': 'Date played' });
      setTimeout(() => title.focus(), 20);
      const cancel = () => { ui.addSession = null; ui.editing = null; render(); };
      return el('form', {
        class: 'inline-form', onsubmit: e => {
          e.preventDefault();
          const row = { number: parseInt(num.value, 10), title: title.value.trim() || null, played_on: date.value || null };
          if (Number.isNaN(row.number)) return;
          act(() => s ? sb.from('sessions').update(row).eq('id', s.id)
                      : sb.from('sessions').insert({ ...row, campaign_id: c.id }).select('id').single(),
            r => { ui.addSession = null; ui.editing = null; if (!s && r && r.data) return () => openSession(r.data.id); });
        },
      },
        el('div', { class: 'row' }, el('label', { class: 'lbl-num' }, 'Session', num), date),
        title,
        el('div', { class: 'row' },
          el('button', { class: 'btn small primary', type: 'submit' }, s ? 'Save' : 'Add session'),
          el('button', { class: 'btn small ghost', type: 'button', onclick: cancel }, 'Cancel')));
    }

    function deleteButton(key, label, onYes) {
      if (ui.confirmDelete === key) {
        return el('span', { class: 'confirm' }, 'Sure? ',
          el('button', { class: 'btn small danger', type: 'button', onclick: () => { ui.confirmDelete = null; onYes(); } }, 'Delete'),
          el('button', { class: 'btn small ghost', type: 'button', onclick: () => { ui.confirmDelete = null; render(); } }, 'Keep'));
      }
      return el('button', { class: 'mini danger', type: 'button', onclick: () => { ui.confirmDelete = key; render(); } }, label);
    }

    function openSession(id) {
      ui.editing = null; ui.confirmDelete = null; ui.msg = '';
      go({ ses: id }, true);
      const pane = $('#detail'); if (pane) pane.scrollTop = 0;
    }

    /* ---------------- detail pane ---------------- */

    function renderDetail(pane) {
      const s = data && state.ses && data.sessions.find(x => x.id === state.ses);
      document.body.classList.toggle('has-detail', !!s);
      pane.classList.toggle('placeholder', !s);
      if (!user || !data) { pane.replaceChildren(); return false; }
      if (!s) {
        pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Pick a session'), 'Choose a session on the left to read its notes or add your own.'));
        return true;
      }
      const c = data.campaigns.find(x => x.id === s.campaign_id);
      const canEditSession = admin() || s.created_by === user.id;
      const notes = notesOf(s.id);
      const kids = [
        el('button', { class: 'back', onclick: () => go({ ses: '' }, true) }, '← Back to sessions'),
        el('div', { class: 'd-kicker' }, el('span', { class: 'badge notes' }, 'Notes'), [c ? c.name : '', s.played_on ? day(s.played_on) : ''].filter(Boolean).join(' · ')),
      ];
      if (ui.editing === 'session') kids.push(sessionForm(c, s));
      else kids.push(el('h1', { class: 'd-title' }, sessionLabel(s)),
        canEditSession ? el('div', { class: 'sess-tools' },
          el('button', { class: 'mini', onclick: () => { ui.editing = 'session'; render(); } }, 'Edit session'),
          admin() ? deleteButton(`session-${s.id}`, 'Delete session', () => act(() => sb.from('sessions').delete().eq('id', s.id), () => go({ ses: '' }, false))) : null) : null);
      if (ui.msg) kids.push(el('p', { class: 'notes-msg', role: 'alert' }, ui.msg));

      if (!notes.length) kids.push(el('p', { class: 'd-note' }, 'Nobody has written anything for this session yet. Be the first.'));
      for (const n of notes) kids.push(noteView(n));
      kids.push(composer(s));

      const list = sessionsOf(s.campaign_id);
      const k = list.indexOf(s);
      const newer = list[k - 1], older = list[k + 1];
      kids.push(el('nav', { class: 'pager' },
        older ? el('button', { class: 'pg prev', onclick: () => openSession(older.id) }, el('span', { class: 'k' }, '← Previous session'), el('span', { class: 'v' }, sessionLabel(older))) : el('span'),
        newer ? el('button', { class: 'pg next', onclick: () => openSession(newer.id) }, el('span', { class: 'k' }, 'Next session →'), el('span', { class: 'v' }, sessionLabel(newer))) : el('span')));
      pane.replaceChildren(...kids.filter(Boolean));
      document.title = `${sessionLabel(s)} · Player’s Handbook`;
      return true;
    }

    function noteView(n) {
      const mine = n.author_id === user.id;
      const can = mine || admin();
      const edited = n.updated_at && (new Date(n.updated_at) - new Date(n.created_at) > 60000);
      if (ui.editing === n.id) {
        const ta = el('textarea', { rows: '8', required: true }, n.body);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
        return el('form', {
          class: 'note editing', onsubmit: e => {
            e.preventDefault();
            const v = ta.value.trim(); if (!v) return;
            act(() => sb.from('notes').update({ body: v }).eq('id', n.id), () => { ui.editing = null; });
          },
        }, ta, el('div', { class: 'row' },
          el('button', { class: 'btn small primary', type: 'submit' }, 'Save'),
          el('button', { class: 'btn small ghost', type: 'button', onclick: () => { ui.editing = null; render(); } }, 'Cancel')));
      }
      return el('article', { class: 'note' + (mine ? ' mine' : '') },
        el('header', {},
          el('span', { class: 'who' }, nameOf(n.author_id), mine ? el('span', { class: 'you' }, ' (you)') : null),
          el('span', { class: 'when', title: edited ? `Edited ${when(n.updated_at)}` : '' }, when(n.created_at), edited ? ' · edited' : ''),
          can ? el('span', { class: 'tools' },
            el('button', { class: 'mini', onclick: () => { ui.editing = n.id; ui.confirmDelete = null; render(); } }, 'Edit'),
            deleteButton(`note-${n.id}`, 'Delete', () => act(() => sb.from('notes').delete().eq('id', n.id)))) : null),
        el('div', { class: 'prose', html: md(n.body) }));
    }

    function composer(s) {
      const ta = el('textarea', { rows: '5', placeholder: 'What happened? Who did you meet? What do you need to remember?', 'aria-label': 'New note' });
      const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Add note');
      const submit = () => {
        const v = ta.value.trim(); if (!v) { ta.focus(); return; }
        act(() => sb.from('notes').insert({ session_id: s.id, body: v }));
      };
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
      return el('form', { class: 'composer', onsubmit: e => { e.preventDefault(); submit(); } },
        el('label', { class: 'composer-k' }, `Writing as ${me ? me.display_name : 'you'}`),
        ta,
        el('div', { class: 'row' }, btn,
          el('span', { class: 'hint' }, 'Ctrl+Enter to post · **bold**, *italic* and - lists work')));
    }

    return {
      init, renderList, renderDetail,
      // shared with the character builder
      client: () => sb, user: () => user, profile: () => me, isAdmin: admin, status: () => status,
      onAuth: f => authListeners.push(f), openSignIn: reason => openSignIn(reason), friendly: e => friendly(e),
      isReady: () => status === 'ready',
      signedIn: () => !!user,
      validSession: id => !!(data && data.sessions.some(s => s.id === id)),
      _debug: () => ({ user, me, data, ui }),
    };
  };
})();
