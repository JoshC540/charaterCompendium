/* Player's Handbook — character builder.
   Reads races, classes, subclasses, spells and traits straight from the handbook content, so it stays
   in step with edits to content/*.md. Saves to the player's account (Supabase, via notes.js) and
   downloads a printable sheet (PDF via the browser) or a Word document (.docx, built here). */
(() => {
  'use strict';

  window.HandbookCreator = function (H) {
    const { el, md, plain, norm, state, go, render, $, DB, slug, Notes, openItem } = H;

    /* ================= rules (change here if the rules change) ================= */
    const BASE_STATS = ['STR', 'DEX', 'INT', 'WIS', 'PER', 'CHA'];
    const COMBAT_STATS = ['Melee', 'Ranged', 'Dodge', 'Disengage', 'Casting'];
    const STATS = [...BASE_STATS, ...COMBAT_STATS];
    const RULES = {
      statDice: { n: 6, sides: 4, keep: 5 },          // roll 6d4, add the lowest 5 (stats are roll-under)
      spFromLevel(lvl) {                              // 1 SP on levels ending 1, 3, 5, 7, 9 and 0 (not level 0)
        let n = 0;
        for (let i = 1; i <= lvl; i++) if ([1, 3, 5, 7, 9, 0].includes(i % 10)) n++;
        return n;
      },
      costClass: 1,                                   // each class after your first (multiclassing, no limit)
      costGeneral: 1,                                 // class-wide subclass benefits, always first
      costAbility: 1,                                 // non-magic: any ability from any subclass of the class
      costFeat: 1,                                    // magic: a subclass's feat, before its spells
      tierCost: n => 2 * Math.ceil(n / 3),            // magic: any three tiers of a subclass's spells cost 2 SP
      maxDrawbacks: 2, maxDrawbackSP: 3, maxQuirks: 2, statFloor: 5,
      renownAt: lvl => 1 + Math.floor(Math.max(0, lvl) / 10),     // Renown = 1 + level ÷ 10
      tierRenown: { 1: 1, 2: 3, 3: 6, 4: 8, 5: 11 },              // feat tier opens at this Renown
      // what each level gives (the pattern repeats every ten levels)
      grants(L) {
        const g = { stat: [], hd: [], ranks: 0, feats: [], miles: [], fpLevels: 0 };
        for (let n = 1; n <= L; n++) {
          const k = n % 10;
          if (k === 1) g.stat.push({ lvl: n, floor: 10 });
          if (k === 4) { g.stat.push({ lvl: n, floor: 5 }); g.ranks++; }
          if (k === 6) g.ranks++;
          if (k === 2 || k === 0) g.hd.push(n);
          if (k === 8) g.feats.push(n);
          if (k === 0) g.miles.push(n);
          if (n >= 11 && [1, 3, 5, 7, 9, 0].includes(k)) g.fpLevels++;
        }
        return g;
      },
      rankRenown: [0, 1, 1, 2, 6, 9],                              // Renown needed for Trained … Legendary
    };
    const RANKS = ['', 'Trained', 'Expert', 'Master', 'Grandmaster', 'Legendary'];
    const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
    const romanOf = n => ['', 'I', 'II', 'III', 'IV', 'V'][n];
    const DRAFT_KEY = 'hb-character-draft';

    /* ================= handbook data ================= */
    const races = () => DB.items.filter(i => i.type === 'race');
    const classes = () => DB.items.filter(i => i.type === 'class');
    const byId = id => (id && DB.byId.get(id)) || null;
    const groupsOf = cls => cls ? DB.subGroups.filter(g => g.className === cls.name) : [];
    const groupByKey = k => DB.subGroups.find(g => g.key === k) || null;
    const isMagic = g => !!g && (!!g.spellsTag || g.items.some(s => s.spellsTag));
    const spellsWith = tag => tag ? DB.items.filter(s => s.type === 'spell' && s.sources.includes(tag)) : [];
    const num = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

    // A subclass's abilities. Entries that share a name, like "Final Blow (Active)" and "Final Blow (Passive)",
    // are one ability with two parts: bought together for one SP.
    function abilities(sub) {
      const out = [];
      for (const l of (sub.body || '').split('\n')) {
        const m = l.match(/^- \*\*(.+?)\*\*\s*(.*)$/);
        if (!m) continue;
        const full = m[1].replace(/\.$/, '').trim();
        const pm = full.match(/^(.*?)\s*\(([^)]*)\)$/);
        const base = pm && pm[1] ? pm[1].trim() : full;
        const same = out.find(a => a.base.toLowerCase() === base.toLowerCase());
        if (same) {
          if (same.parts.length === 1) { const p = same.parts[0]; same.text = `**${p.label}:** ${p.text}`; }
          same.parts.push({ label: pm ? pm[2] : full, text: m[2], key: slug(full) });
          same.text += ` **${pm ? pm[2] : full}:** ${m[2]}`;
          same.name = same.base; same.key = slug(same.base);
          continue;
        }
        out.push({ key: slug(full), name: full, base, text: m[2], parts: [{ label: pm ? pm[2] : full, text: m[2], key: slug(full) }] });
      }
      if (!out.length && sub.body) out.push({ key: 'all', name: sub.name, base: sub.name, text: plain(sub.body.split('\n\n')[0]), parts: [] });
      return out;
    }

    function raceTraits(r) {
      const out = { traits: [], feats: [] };
      if (!r) return out;
      const parts = ('\n' + r.body).split(/\n### /).slice(1);
      for (const p of parts) {
        const [head, ...rest] = p.split('\n');
        const text = rest.join('\n').replace(/^\*\*Unlock:\*\*.*$/m, '').trim();
        const f = head.match(/^Feat (\d+):\s*(.+)$/);
        if (f) out.feats.push({ n: num(f[1]), name: f[2].trim(), text });
        else out.traits.push({ name: head.trim(), text });
      }
      return out;
    }

    function tableRows(body) {
      return (body || '').split('\n').filter(l => /^\s*\|/.test(l) && !/^[\s|:-]+$/.test(l))
        .map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim().replace(/^\*\*(.*)\*\*$/, '$1')));
    }
    let traitCache = null;
    function traitLists() {
      if (traitCache) return traitCache;
      const find = n => (DB.docs.adv || []).find(x => x.name === n);
      const dr = tableRows(find('Drawbacks') && find('Drawbacks').body).slice(1)
        .map(r => ({ name: r[0], sp: num((r[1] || '').match(/\d+/)), text: r[2] || '' }));
      const qu = tableRows(find('Quirks') && find('Quirks').body).slice(1)
        .map(r => ({ name: r[0], gain: r[1] || '', cost: r[2] || '', mods: statMods(`${r[1]} ${r[2]}`) }));
      traitCache = { drawbacks: dr, quirks: qu };
      return traitCache;
    }
    let featCache = null, skillCache = null;
    function featList() {
      if (featCache) return featCache;
      const out = [];
      for (const e of DB.docs.adv || []) {
        if (e.chapter !== 'Feats' || e.name === e.chapter || /^(Tiers|Rules)$/.test(e.name)) continue;
        for (const r of tableRows(e.body).slice(1)) {
          const m = (r[1] || '').match(/^(III|II|IV|I|V)\b(.*)$/);
          if (!m) continue;
          const flags = m[2];
          out.push({ name: r[0], tier: ROMAN[m[1]], caster: /caster/i.test(flags),
            needs: [...flags.matchAll(/needs ([^,]+)/gi)].map(x => x[1].trim()), effect: plain(r[2] || ''), cat: e.name });
        }
      }
      return (featCache = out);
    }
    function skillList() {
      if (skillCache) return skillCache;
      const e = (DB.docs.adv || []).find(x => x.name === 'Skills at a glance');
      const out = [];
      for (const r of tableRows(e && e.body).slice(1)) {
        for (const raw of (r[1] || '').split(/,\s*/)) {
          const m = raw.trim().match(/^(.*?)\s*\((?:Renown )?(\d+)\)$/);
          out.push({ name: (m ? m[1] : raw).trim(), family: r[0], renown: m ? num(m[2]) : 1 });
        }
      }
      return (skillCache = out.filter(x => x.name));
    }

    function statMods(text) {
      const mods = {};
      for (const m of text.matchAll(/(Improve|Worsen)\s+(STR|DEX|INT|WIS|PER|CHA)\s+by\s+(\d+)/gi)) {
        const k = m[2].toUpperCase();
        mods[k] = (mods[k] || 0) + (m[1].toLowerCase() === 'improve' ? -1 : 1) * num(m[3]);
      }
      return mods;
    }

    /* ================= character model ================= */
    const blank = () => ({
      v: 1, name: '', level: 0, age: '', background: '',
      raceId: '', half: false, race2Id: '',
      classes: [{ classId: '', groupKey: '' }],
      stats: Object.fromEntries(STATS.map(s => [s, ''])), rolls: {}, adjust: Object.fromEntries(STATS.map(s => [s, 0])),
      drawbacks: [], quirks: [],
      spAdjust: 0, hpAdjust: 0, hpRolls: {},
      buys: { general: {}, abil: {}, feat: {}, tiers: {} }, unlocked: {},
      lv: { stat: {}, hd: {}, skills: {}, feats: {}, boons: {}, fp: 0 },
      items: [], gear: '', equipment: '', notes: '',
      guide: { step: 0, seen: 0, done: false },
    });

    let list = null, profiles = [], listError = '', loadingList = false;
    let cur = null;          // { id, owner_id, data, dirty, readOnly }
    let msg = '', confirmDel = false, saving = false;
    let lvlup = null;        // { to, snap, wasDirty, skills: [], fp } while walking through a level-up

    function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } }
    function saveDraft() { try { if (cur && !cur.id) localStorage.setItem(DRAFT_KEY, JSON.stringify(cur.data)); } catch { /* private mode */ } }
    function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

    // older saves had one class (classId/groupKey) and a single general flag; bring them up to date
    function normalize(data) {
      const c = Object.assign(blank(), data || {});
      const fresh = blank();
      c.stats = Object.assign(fresh.stats, c.stats || {});
      c.adjust = Object.assign(fresh.adjust, c.adjust || {});
      const src = data || {};
      if (!Array.isArray(src.classes) || !src.classes.length) c.classes = [{ classId: src.classId || '', groupKey: src.groupKey || '' }];
      else c.classes = src.classes.map(x => ({ classId: x.classId || '', groupKey: x.groupKey || '' }));
      for (const x of c.classes) if (x.classId && !x.groupKey) { const gs = groupsOf(byId(x.classId)); if (gs.length === 1) x.groupKey = gs[0].key; }   // single-path classes
      const first = c.classes[0].groupKey;
      const b = c.buys = Object.assign({ general: {}, abil: {}, feat: {}, tiers: {} }, c.buys || {});
      if (typeof b.general === 'boolean') b.general = b.general && first ? { [first]: true } : {};
      if (Array.isArray(c.hpRolls)) c.hpRolls = c.hpRolls.length && first ? { [first]: c.hpRolls } : {};
      // saves from before two-part abilities were merged: "final-blow-active" + "final-blow-passive" → "final-blow"
      for (const [id, keys] of Object.entries(b.abil || {})) {
        const sub = DB.byId.get(id); if (!sub || !Array.isArray(keys)) continue;
        const merged = abilities(sub).filter(a => a.parts.length > 1);
        if (!merged.length) continue;
        b.abil[id] = [...new Set(keys.map(k => (merged.find(a => a.parts.some(p => p.key === k)) || { key: k }).key))];
      }
      c.hpRolls = c.hpRolls || {}; c.unlocked = c.unlocked || {};
      c.lv = Object.assign({ stat: {}, hd: {}, skills: {}, feats: {}, boons: {}, fp: 0 }, c.lv || {});
      // older saves kept gear as two text boxes; turn each line into an inventory item
      if (!Array.isArray(src.items)) {
        c.items = [c.gear, c.equipment].flatMap(t => String(t || '').split(/\n+/)).map(t => t.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean)
          .map(name => ({ id: itemId(), name, qty: 1, notes: '', on: false }));
        c.gear = ''; c.equipment = '';
      } else c.items = src.items.map(x => ({ id: x.id || itemId(), name: String(x.name || ''), qty: Math.max(0, num(x.qty, 1)), notes: String(x.notes || ''), on: !!x.on, ...(x.ref ? { ref: String(x.ref) } : {}) }));
      c.guide = src.guide && typeof src.guide === 'object' ? { step: Math.max(0, num(src.guide.step)), seen: Math.max(0, num(src.guide.seen), num(src.guide.step)), done: !!src.guide.done } : { step: 0, done: Object.keys(src).length > 0 };
      delete c.classId; delete c.groupKey;
      return c;
    }
    function itemId() { return Math.random().toString(36).slice(2, 10); }
    const slotsOf = c => c.classes.map((s, i) => {
      const cls = byId(s.classId), g = groupByKey(s.groupKey);
      return { i, classId: s.classId, groupKey: s.groupKey, cls, g, magic: isMagic(g),
        label: cls ? (g && groupsOf(cls).length > 1 ? g.title : cls.name) : '' };
    });

    const raceOf = c => byId(c.raceId);
    const race2Of = c => c.half ? byId(c.race2Id) : null;

    function derived(c) {
      const r = raceOf(c), r2 = race2Of(c), slots = slotsOf(c), cls = slots[0].cls, g = slots[0].g;
      const { drawbacks, quirks } = traitLists();
      const dSel = drawbacks.filter(d => c.drawbacks.includes(d.name));
      const qSel = quirks.filter(q => c.quirks.includes(q.name));
      const refund = Math.min(RULES.maxDrawbackSP, dSel.reduce((a, d) => a + d.sp, 0));
      const qMods = {};
      for (const q of qSel) for (const [k, v] of Object.entries(q.mods)) qMods[k] = (qMods[k] || 0) + v;
      const L = Math.max(0, num(c.level)), R = RULES.renownAt(L), G = RULES.grants(L), lv = c.lv;
      const boons = G.miles.map(n => ({ lvl: n, renown: RULES.renownAt(n), ...(lv.boons[n] || {}) }));
      // level-up improvements, applied in level order with their floors
      const steps = [
        ...G.stat.filter(x => lv.stat[x.lvl]).map(x => ({ lvl: x.lvl, k: lv.stat[x.lvl], floor: x.floor })),
        ...boons.flatMap(b => b.type === 'combat' ? [{ lvl: b.lvl, k: b.stat, floor: 5 }]
          : b.type === 'combat2' ? [{ lvl: b.lvl, k: b.stat, floor: 5 }, { lvl: b.lvl, k: b.stat2, floor: 5 }] : []).filter(x => x.k),
      ].sort((a, b) => a.lvl - b.lvl);
      const stats = STATS.map(k => {
        const base = c.stats[k] === '' || c.stats[k] == null ? null : num(c.stats[k]);
        const mod = (qMods[k] || 0) + num(c.adjust[k]);
        let v = base == null ? null : Math.max(RULES.statFloor, base + mod);
        const before = v;
        if (v != null) for (const st of steps) if (st.k === k && v > st.floor) v -= 1;
        return { k, base, mod, lvlMod: v == null ? 0 : v - before, final: v };
      });
      const earned = RULES.spFromLevel(L);
      const fp = Math.min(Math.max(0, num(lv.fp)), G.fpLevels);
      const total = earned - fp + refund + num(c.spAdjust);
      const skillRanks = G.ranks + 2 * boons.filter(b => b.type === 'skills2').length + boons.filter(b => b.type === 'pastMaster').length;
      const pastMaster = boons.filter(b => b.type === 'pastMaster').length;
      const skillsUsed = Object.values(lv.skills).reduce((a, x) => a + num(x), 0);
      const pastUsed = Object.values(lv.skills).reduce((a, x) => a + Math.max(0, num(x) - 3), 0);
      const featSlots = [
        ...G.feats.map(n => ({ key: 'L' + n, lvl: n, max: 3, label: `Level ${n}` })),
        ...boons.filter(b => b.type === 'tier4' || b.type === 'tier5').map(b => ({ key: 'B' + b.lvl, lvl: b.lvl, max: b.type === 'tier4' ? 4 : 5, min: b.type === 'tier4' ? 4 : 5, label: `Level ${b.lvl} milestone` })),
      ];
      const hdRolled = G.hd.reduce((a, n) => a + num(lv.hd[n]), 0);
      const b = c.buys;
      const liveKeys = slots.map(x => x.groupKey).filter(Boolean);
      const spent = Math.max(0, c.classes.length - 1) * RULES.costClass
        + liveKeys.filter(k => b.general[k]).length * RULES.costGeneral
        + Object.values(b.abil).reduce((a, x) => a + x.length * RULES.costAbility, 0)
        + Object.values(b.feat).filter(Boolean).length * RULES.costFeat
        + Object.values(b.tiers).reduce((a, x) => a + (x.length ? RULES.tierCost(x.length) : 0), 0);
      const hpRace = num(r && r.meta.hp), hpClass = num(cls && cls.meta.hp);
      const hpRolled = liveKeys.reduce((a, k) => a + (c.hpRolls[k] || []).reduce((x, y) => x + y, 0), 0);
      return {
        r, r2, cls, g, slots, magic: isMagic(g), dSel, qSel, refund, stats, earned, total, spent, left: total - spent,
        hp: hpRace + hpClass + hpRolled + hdRolled + num(c.hpAdjust), hpRace, hpClass, hpRolled, hdRolled,
        L, R, G, boons, fp, skillRanks, skillsUsed, pastMaster, pastUsed, featSlots,
      };
    }

    function summaryOf(c) {
      const d = derived(c);
      const race = d.r ? (d.r2 ? `${d.r.name} / ${d.r2.name}` : d.r.name) : '';
      const cls = d.slots.filter(x => x.cls).map(x => x.label).join(' / ');
      const who = race && cls ? `${race} ${cls}` : race || cls || 'No race or class yet';
      return `${who} · Level ${num(c.level)}`;
    }

    /* ================= accounts ================= */
    const sb = () => Notes && Notes.client();
    const user = () => Notes && Notes.user();
    const admin = () => !!(Notes && Notes.isAdmin());
    const nameOf = id => (profiles.find(p => p.id === id) || {}).display_name || 'Someone';

    async function refreshList() {
      if (!sb() || !user() || loadingList) return;
      loadingList = true;
      try {
        const [c, p] = await Promise.all([
          sb().from('characters').select('id, owner_id, name, summary, data, updated_at').order('updated_at', { ascending: false }),
          sb().from('profiles').select('id, display_name, is_admin').order('display_name', { ascending: true }),
        ]);
        if (c.error) throw c.error;
        list = c.data || []; profiles = (p && p.data) || []; listError = '';
      } catch (e) {
        listError = Notes.friendly(e);
        if (/characters/.test(listError) && /exist|find|schema/i.test(listError)) listError = 'Run the latest supabase/setup.sql first (it adds saved characters).';
      } finally { loadingList = false; }
    }

    function init() {
      if (Notes) Notes.onAuth(async () => {
        list = null; cur = cur && !cur.id ? cur : null;
        if (user()) await refreshList();
        if (state.tab === 'chars') render();
      });
    }

    function open(id) {
      msg = ''; confirmDel = false;
      go({ char: id }, true);
      const pane = $('#detail'); if (pane) pane.scrollTop = 0;
    }

    function ensureCurrent() {
      const want = state.char;
      if (!want) { cur = null; return; }
      if (want === 'new') {
        if (!cur || cur.id) { cur = { id: null, data: normalize(loadDraft()), dirty: !!loadDraft(), readOnly: false }; enterMode(); }
        return;
      }
      if (cur && cur.id === want) return;
      const row = list && list.find(x => x.id === want);
      if (row) cur = { id: row.id, owner_id: row.owner_id, data: normalize(row.data), dirty: false, readOnly: !!(user() && row.owner_id !== user().id) };
      else cur = null;
      enterMode();
    }

    async function save() {
      const c = cur.data;
      if (!user()) { Notes.openSignIn('Sign in to save this character to your account. Your work so far stays on this page.'); return; }
      if (!c.name.trim()) { msg = 'Give your character a name before saving.'; render(); return; }
      saving = true; msg = ''; render();
      const row = { name: c.name.trim().slice(0, 80), summary: summaryOf(c).slice(0, 200), data: c };
      const q = cur.id ? sb().from('characters').update(row).eq('id', cur.id).select('id').single()
                       : sb().from('characters').insert(row).select('id').single();
      const { data, error } = await q;
      saving = false;
      if (error) { msg = Notes.friendly(error); render(); return; }
      const wasNew = !cur.id;
      cur.id = (data && data.id) || cur.id; cur.owner_id = user().id; cur.dirty = false;
      if (wasNew) clearDraft();
      msg = 'Saved.';
      await refreshList();
      if (wasNew) go({ char: cur.id }, false); else render();
    }

    async function remove() {
      const { error } = await sb().from('characters').delete().eq('id', cur.id);
      if (error) { msg = Notes.friendly(error); render(); return; }
      cur = null; confirmDel = false;
      await refreshList();
      go({ char: '' }, true);
    }

    /* ================= editor state ================= */
    let mode = 'edit';                 // 'sheet' (read), 'edit' (every section) or 'guide' (new-character steps)
    let drawer = false, showAdjust = false;
    const openSubs = new Set();        // subclasses expanded under Subclass points
    function enterMode() {
      lvlup = null; drawer = false; confirmDel = false; msg = '';
      mode = !cur ? 'edit' : cur.readOnly || cur.id ? 'sheet' : cur.data.guide.done ? 'edit' : 'guide';
    }
    const pl = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

    /* ================= what's left to do ================= */
    function todos(c, d) {
      const t = [];
      const add = (sec, text, bad) => t.push({ sec, text, bad: !!bad });
      if (!c.name.trim()) add('Basics', 'Name your character');
      if (!d.r) add('Race', 'Choose a race');
      else if (c.half && !d.r2) add('Race', 'Choose the other parent’s race');
      for (const s of d.slots) {
        if (!s.cls) add('Class', s.i ? `Choose extra class ${s.i}` : 'Choose a class');
        else if (!s.g) add('Class', `Choose a path for ${s.cls.name}`);
      }
      const un = BASE_STATS.filter(k => c.stats[k] === '' || c.stats[k] == null).length;
      if (un) add('Stats', un === BASE_STATS.length ? 'Roll your stats' : `Roll ${pl(un, 'more stat')}`);
      const cun = COMBAT_STATS.filter(k => c.stats[k] === '' || c.stats[k] == null).length;
      if (cun) add('Stats', cun === COMBAT_STATS.length ? 'Roll your combat stats' : `Roll ${pl(cun, 'more combat stat')}`);
      const st = d.G.stat.filter(x => !c.lv.stat[x.lvl]).length;
      if (st) add('Level-ups', `Choose ${pl(st, 'stat improvement')}`);
      const hd = d.G.hd.filter(n => c.lv.hd[n] == null).length;
      if (hd) add('Level-ups', `Roll ${pl(hd, 'hit die', 'hit dice')}`);
      const bo = d.boons.filter(b => !b.type).length;
      if (bo) add('Level-ups', `Choose ${pl(bo, 'milestone boon')}`);
      const rk = d.skillRanks - d.skillsUsed;
      if (rk > 0) add('Soft skills', `Spend ${pl(rk, 'soft skill rank')}`);
      if (rk < 0) add('Soft skills', `${pl(-rk, 'soft skill rank')} too many`, true);
      const fs = d.featSlots.filter(s => !c.lv.feats[s.key]).length;
      if (fs) add('Feats', `Choose ${pl(fs, 'feat')}`);
      if (d.left < 0) add('Subclass points', `${d.left * -1} SP overspent`, true);
      else if (d.left > 0 && d.slots.some(s => s.g)) add('Subclass points', `Spend ${d.left} SP`);
      for (const s of d.slots) if (s.g && c.buys.general[s.g.key] && /Gain \d+d\d+ hit points/i.test(s.g.intro || '') && !(c.hpRolls[s.g.key] || []).length) add('Subclass points', `Roll ${s.g.title} HP`);
      return t;
    }

    /* ================= sections ================= */
    const SECTION_FNS = {
      'Basics': basics, 'Race': raceSection, 'Class': classSection, 'Stats': statsSection,
      'Drawbacks and quirks': traitsSection, 'Level-ups': levelSection, 'Soft skills': skillsSection, 'Feats': featsSection,
      'Subclass points': spSection, 'Inventory': inventorySection, 'Notes': notesSection,
    };
    const editSections = d => Object.keys(SECTION_FNS).filter(t => !(d.L === 0 && (t === 'Soft skills' || t === 'Feats') && !d.skillsUsed && !d.featSlots.length));
    function guideSteps(c, d) {
      const s = [
        { title: 'Basics', secs: ['Basics'], intro: 'Start with a name. Most characters start at level 0; set a higher level only if your DM is starting you further along.' },
        { title: 'Race', secs: ['Race'], intro: 'Your race gives you HP, I.M.P., languages and traits.' },
        { title: 'Class', secs: ['Class'], intro: 'Your starting class sets your hit die, weapons and class trait. You can add more classes later for 1 SP each.' },
        { title: 'Stats', secs: ['Stats'], intro: 'Roll every stat and combat stat. You can reroll any of them, or type in what you rolled at the table.' },
        { title: 'Drawbacks and quirks', secs: ['Drawbacks and quirks'], intro: 'Optional. Drawbacks give you SP back; quirks trade one stat for another.' },
      ];
      if (d.L > 0) s.push({ title: 'Level-ups', secs: ['Level-ups', 'Soft skills', 'Feats'], intro: `Choose what each level up to ${d.L} gave you.` });
      s.push({ title: 'Subclass points', secs: ['Subclass points'], intro: 'Spend SP on your class’s benefits, abilities and spells. Class-wide benefits come first.' },
        { title: 'Gear', secs: ['Inventory', 'Notes'], intro: 'Add your starting gear (your subclass page lists the options) and anything else you carry.' });
      return s;
    }

    const secId = title => 'cc-' + title.toLowerCase().replace(/[^a-z]+/g, '-');
    const section = (title, ...body) => el('section', { class: 'cc-sec', id: secId(title) }, el('h2', { class: 'cc-h' }, title), ...body);
    const headH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head-h')) || 124;
    const narrow = () => window.matchMedia('(max-width: 900px)').matches;
    function scrollToEl(t) {
      if (!t) return;
      if (narrow()) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const z = parseFloat(getComputedStyle(document.body).zoom) || 1;
      window.scrollTo({ top: Math.max(0, t.getBoundingClientRect().top + window.scrollY - (headH() + 16) * z), behavior: 'smooth' });
    }
    const jump = title => scrollToEl(document.getElementById(secId(title)));
    function toTop() {
      requestAnimationFrame(() => {
        const p = $('#detail'); if (!p) return;
        if (narrow()) p.scrollTop = 0; else if (p.getBoundingClientRect().top < headH()) scrollToEl(p);
      });
    }
    function jumpTo(sec) {
      if (!cur || cur.readOnly) return;
      drawer = false;
      if (mode === 'guide') {
        const i = guideSteps(cur.data, derived(cur.data)).findIndex(s => s.secs.includes(sec));
        if (i >= 0) { cur.data.guide.step = i; cur.data.guide.seen = Math.max(num(cur.data.guide.seen), i); saveDraft(); }
        render(); requestAnimationFrame(() => jump(sec)); return;
      }
      if (mode === 'sheet') mode = 'edit';
      render(); requestAnimationFrame(() => jump(sec));
    }
    const changed = () => { cur.dirty = true; msg = ''; saveDraft(); };
    const set = (k, v, rerender = true) => { cur.data[k] = v; changed(); if (rerender) render(); };

    /* ================= status, save, menu ================= */
    function statusInfo() {
      if (cur.readOnly) return ['view', `${nameOf(cur.owner_id)}’s character · view only`];
      if (saving) return ['busy', 'Saving…'];
      if (!cur.id) return ['warn', user() ? 'Not saved yet' : 'Draft on this device'];
      return cur.dirty ? ['warn', 'Unsaved changes'] : ['ok', 'Saved'];
    }
    const statusChip = () => { const [k, t] = statusInfo(); return el('span', { class: 'cc-status ' + k, role: 'status' }, t); };
    function saveButton(extra = '') {
      if (cur.readOnly) return null;
      const clean = cur.id && !cur.dirty && user();
      return el('button', { class: 'btn primary cc-save ' + extra, disabled: saving || !!clean, onclick: save },
        saving ? 'Saving…' : !user() ? 'Sign in to save' : clean ? '✓ Saved' : 'Save');
    }
    function menu() {
      const canDel = cur.id && (!cur.readOnly || admin());
      return el('details', { class: 'cc-menu' },
        el('summary', { class: 'btn small', 'aria-label': 'More actions', title: 'More actions' }, '⋯'),
        el('div', { class: 'cc-menu-list' },
          el('button', { onclick: e => { e.target.closest('details').open = false; printSheet(cur.data); } }, 'Download PDF'),
          el('button', { onclick: e => { e.target.closest('details').open = false; downloadDocx(cur.data); } }, 'Download Word'),
          canDel ? el('button', { class: 'danger', onclick: () => { confirmDel = true; render(); } }, 'Delete character…') : null));
    }
    document.addEventListener('click', e => {
      for (const m of document.querySelectorAll('details.cc-menu[open]')) if (!m.contains(e.target)) m.open = false;
    });

    function modeBar(c, d) {
      if (cur.readOnly) return el('div', { class: 'cc-modebar' },
        el('button', { class: 'btn small', onclick: () => printSheet(c) }, 'Download PDF'),
        el('button', { class: 'btn small', onclick: () => downloadDocx(c) }, 'Download Word'), admin() ? menu() : null);
      if (mode === 'guide') {
        const n = guideSteps(c, d).length;
        return el('div', { class: 'cc-modebar' },
          el('span', { class: 'cc-guide-tag' }, `New character · step ${Math.min(c.guide.step, n - 1) + 1} of ${n}`),
          el('button', { class: 'mini', onclick: () => { c.guide.done = true; mode = 'edit'; changed(); render(); toTop(); } }, 'Skip to the full editor'),
          menu());
      }
      const segBtn = (m, label) => el('button', { class: 'cc-seg-b', role: 'tab', 'aria-selected': String(mode === m), onclick: () => { if (mode !== m) { mode = m; render(); toTop(); } } }, label);
      return el('div', { class: 'cc-modebar' },
        el('div', { class: 'cc-seg', role: 'tablist', 'aria-label': 'View' }, segBtn('sheet', 'Sheet'), segBtn('edit', 'Edit')),
        lvlup ? null : el('button', { class: 'btn small', onclick: startLevelUp }, `Level up to ${d.L + 1}`),
        menu());
    }

    /* ================= rail (left column) and phone bar ================= */
    function nums(c, d) {
      const ranks = d.skillRanks - d.skillsUsed;
      const n = (k, v, bad, title) => el('div', { class: 'cc-num' + (bad ? ' bad' : ''), title: title || '' }, el('span', { class: 'v' }, String(v)), el('span', { class: 'k' }, k));
      return el('div', { class: 'cc-nums' },
        n('HP', d.hp), n('Renown', d.R), n('SP left', d.left, d.left < 0, `${d.spent} spent of ${d.total}`), n('Ranks left', ranks, ranks < 0, 'Soft skill ranks'));
    }
    function todoList(T) {
      if (!T.length) return el('p', { class: 'cc-alldone' }, '✓ Nothing left to do');
      return el('ul', { class: 'cc-todo' }, ...T.map(t => el('li', {}, el('button', { class: t.bad ? 'bad' : '', onclick: () => jumpTo(t.sec) },
        el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', {}, t.text), el('span', { class: 'sec' }, t.sec)))));
    }
    function navList(c, d, T) {
      const items = mode === 'guide' ? guideSteps(c, d).map((s, i) => ({ i, title: s.title, secs: s.secs, cur: i === Math.min(c.guide.step, guideSteps(c, d).length - 1) }))
        : editSections(d).map(t => ({ title: t, secs: [t] }));
      return el('nav', { class: 'cc-nav', 'aria-label': 'Character sections' }, ...items.map(it => {
        const done = (mode !== 'guide' || it.i <= num(c.guide.seen)) && !T.some(t => it.secs.includes(t.sec));
        return el('button', { class: (done ? 'done' : '') + (it.cur ? ' cur' : ''), 'aria-current': it.cur ? 'step' : null, onclick: () => jumpTo(it.secs[0]) },
          el('span', { class: 'mk', 'aria-hidden': 'true' }, done ? '✓' : '○'), it.title);
      }));
    }
    function rail(c, d) {
      const T = cur.readOnly ? [] : todos(c, d);
      return el('div', { class: 'cc-rail' },
        el('button', { class: 'mini cc-rail-back', onclick: () => go({ char: '' }, true) }, '← All characters'),
        el('div', { class: 'cc-rail-id' }, el('strong', {}, c.name || 'New character'), el('span', {}, summaryOf(c))),
        nums(c, d),
        cur.readOnly ? null : [el('h3', { class: 'cc-h3' }, T.length ? `To do · ${T.length}` : 'To do'), todoList(T)],
        cur.readOnly || mode === 'sheet' ? null : [el('h3', { class: 'cc-h3' }, mode === 'guide' ? 'Steps' : 'Sections'), navList(c, d, T)],
        cur.readOnly ? null : el('div', { class: 'cc-rail-save' }, saveButton(), statusChip()));
    }
    function phoneBar(c, d) {
      if (cur.readOnly) return null;
      const T = todos(c, d);
      return el('div', { class: 'cc-pbar' },
        drawer ? el('div', { class: 'cc-pbar-drawer' }, nums(c, d), el('h3', { class: 'cc-h3' }, 'To do'), todoList(T),
          mode === 'sheet' ? null : [el('h3', { class: 'cc-h3' }, mode === 'guide' ? 'Steps' : 'Sections'), navList(c, d, T)]) : null,
        el('div', { class: 'cc-pbar-row' },
          el('button', { class: 'btn small', 'aria-expanded': String(drawer), onclick: () => { drawer = !drawer; render(); } },
            drawer ? 'Close' : T.length ? `To do · ${T.length}` : 'Overview'),
          el('span', { class: 'cc-pbar-nums' }, `${d.left} SP · ${d.skillRanks - d.skillsUsed} ranks`),
          saveButton('small')));
    }

    /* ================= list pane ================= */
    function renderList(box, meta) {
      ensureCurrent();
      if (cur) { meta.textContent = ''; box.replaceChildren(rail(cur.data, derived(cur.data))); return; }
      meta.textContent = '';
      const kids = [el('div', { class: 'notes-bar' },
        el('button', { class: 'btn small primary', onclick: () => { cur = null; open('new'); } }, '+ New character'),
        user() ? el('button', { class: 'btn small ghost', onclick: async () => { await refreshList(); render(); } }, '↻ Refresh') : null)];
      const draft = loadDraft();
      if (draft && (draft.name || draft.raceId || draft.classId || (draft.classes && draft.classes.some(x => x.classId)))) {
        kids.push(el('div', { class: 'section-head' }, 'Unsaved draft'),
          el('button', { class: 'card sess' + (state.char === 'new' ? ' sel' : ''), onclick: () => open('new') },
            el('div', { class: 'card-top' }, el('span', { class: 'card-name' }, draft.name || 'Unnamed character')),
            el('div', { class: 'card-snip' }, summaryOf(normalize(draft)))));
      }
      const status = Notes ? Notes.status() : 'offline';
      if (status === 'loading') kids.push(el('div', { class: 'empty' }, 'Loading…'));
      else if (!user()) {
        kids.push(el('div', { class: 'notice chars-signin' },
          el('p', {}, 'You can build a character and download it without signing in. Sign in to save characters to your account.'),
          status === 'ready' ? el('button', { class: 'btn small', onclick: () => Notes.openSignIn() }, 'Sign in') : null));
      } else if (!list) {
        kids.push(el('div', { class: 'empty' }, listError ? el('strong', {}, listError) : 'Loading characters…'));
        if (!listError) refreshList().then(render);
      } else {
        const mine = list.filter(x => x.owner_id === user().id);
        kids.push(el('div', { class: 'section-head' }, 'My characters'));
        if (!mine.length) kids.push(el('p', { class: 'd-note' }, 'No saved characters yet.'));
        for (const x of mine) kids.push(charCard(x));
        if (admin()) {
          const others = list.filter(x => x.owner_id !== user().id);
          const owners = [...new Set(others.map(x => x.owner_id))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
          for (const o of owners) {
            kids.push(el('div', { class: 'section-head' }, `${nameOf(o)}’s characters`));
            for (const x of others.filter(y => y.owner_id === o)) kids.push(charCard(x));
          }
        }
        meta.textContent = `${list.length} character${list.length === 1 ? '' : 's'}`;
      }
      box.replaceChildren(...kids);
    }

    function charCard(x) {
      return el('button', { class: 'card sess' + (state.char === x.id ? ' sel' : ''), onclick: () => open(x.id) },
        el('div', { class: 'card-top' }, el('span', { class: 'card-name' }, x.name),
          el('span', { class: 'card-sub' }, new Date(x.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))),
        el('div', { class: 'card-snip' }, x.summary || ''));
    }

    /* ================= editor ================= */
    function renderDetail(pane) {
      ensureCurrent();
      document.body.classList.toggle('has-detail', !!cur);
      document.body.classList.toggle('cc-open', !!cur);
      pane.classList.toggle('placeholder', !cur);
      if (!cur) {
        pane.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Character builder'),
          'Start a new character, or open one you’ve saved.'));
        return true;
      }
      if (cur.readOnly) mode = 'sheet';
      const c = cur.data, d = derived(c);
      document.title = `${c.name || 'New character'} · Player’s Handbook`;
      const head = [
        el('button', { class: 'back', onclick: () => go({ char: '' }, true) }, '← All characters'),
        el('div', { class: 'd-kicker' }, el('span', { class: 'badge notes' }, 'Character'), statusChip()),
        el('h1', { class: 'd-title' }, c.name || 'New character'),
        el('p', { class: 'cc-subtitle' }, summaryOf(c)),
        modeBar(c, d),
        confirmDel ? el('div', { class: 'notice cc-confirm', role: 'alert' }, el('span', {}, 'Delete this character for good? '),
          el('button', { class: 'btn small danger', onclick: remove }, 'Delete'),
          el('button', { class: 'btn small ghost', onclick: () => { confirmDel = false; render(); } }, 'Keep')) : null,
        msg ? el('p', { class: 'notes-msg' + (msg === 'Saved.' ? ' ok' : ''), role: 'status' }, msg) : null,
      ];
      let body;
      if (mode === 'sheet') body = [el('div', { class: 'cc-sheetview' }, sheet(c, d))];
      else if (mode === 'guide') body = guideView(c, d);
      else body = [levelUpPanel(c, d), ...editSections(d).map(t => section(t, SECTION_FNS[t](c, d)))];
      pane.replaceChildren(...[...head, ...body].flat().filter(Boolean), phoneBar(c, d) || '');
      return true;
    }

    function guideView(c, d) {
      const steps = guideSteps(c, d);
      const i = Math.min(c.guide.step, steps.length - 1);
      const T = todos(c, d);
      const goStep = j => { c.guide.step = j; c.guide.seen = Math.max(num(c.guide.seen), j); changed(); render(); toTop(); };
      const st = steps[i];
      const left = T.filter(t => st.secs.includes(t.sec));
      return [
        el('ol', { class: 'cc-stepper' }, ...steps.map((s, j) => {
          const done = j <= num(c.guide.seen) && !T.some(t => s.secs.includes(t.sec));
          return el('li', { class: (j === i ? 'cur' : '') + (done ? ' done' : '') },
            el('button', { 'aria-current': j === i ? 'step' : null, onclick: () => goStep(j) },
              el('span', { class: 'n' }, done && j !== i ? '✓' : String(j + 1)), el('span', { class: 't' }, s.title)));
        })),
        el('p', { class: 'cc-intro' }, st.intro),
        ...st.secs.map(t => section(t, SECTION_FNS[t](c, d))),
        el('div', { class: 'cc-guide-nav' },
          i > 0 ? el('button', { class: 'btn', onclick: () => goStep(i - 1) }, `← ${steps[i - 1].title}`) : el('span'),
          el('div', { class: 'cc-guide-next' },
            left.length ? el('span', { class: 'hint' }, `Still to do here: ${left.map((t, k) => k ? t.text[0].toLowerCase() + t.text.slice(1) : t.text).join(', ')}. You can come back to it.`) : null,
            i < steps.length - 1
              ? el('button', { class: 'btn primary', onclick: () => goStep(i + 1) }, `Next: ${steps[i + 1].title} →`)
              : el('button', { class: 'btn primary', onclick: () => { c.guide.done = true; mode = 'sheet'; changed(); render(); toTop(); } }, 'Finish and view the sheet'))),
      ];
    }

    /* ================= picker (search a list, pick one) ================= */
    function picker({ title, note, groups, onPick, empty }) {
      let showAll = false;
      const dlg = el('dialog', { class: 'hb-dialog cc-picker', 'aria-label': title });
      const q = el('input', { type: 'search', class: 'cc-pk-q', placeholder: 'Search…', 'aria-label': 'Search', autocomplete: 'off' });
      const list = el('div', { class: 'cc-pk-list' });
      const blocked = groups.reduce((a, g) => a + g.options.filter(o => o.why).length, 0);
      const allBox = blocked ? el('label', { class: 'toggle cc-pk-all' }, el('input', { type: 'checkbox', onchange: e => { showAll = e.target.checked; draw(); } }), ` Show ${blocked} you can’t take yet`) : null;
      function draw() {
        const toks = norm(q.value).split(' ').filter(Boolean);
        const hit = o => toks.every(t => norm(`${o.name} ${o.meta || ''} ${o.text || ''}`).includes(t));
        const kids = [];
        for (const g of groups) {
          const os = g.options.filter(o => (showAll || !o.why) && hit(o));
          if (!os.length) continue;
          if (g.label) kids.push(el('div', { class: 'cc-pk-g' }, g.label));
          for (const o of os) kids.push(el('button', { class: 'cc-pk-opt', disabled: !!o.why, onclick: () => { dlg.close(); onPick(o.value); } },
            el('span', { class: 'nm' }, o.name, o.meta ? el('span', { class: 'meta' }, o.meta) : null),
            o.text ? el('span', { class: 'tx' }, o.text) : null,
            o.why ? el('span', { class: 'why' }, o.why) : null));
        }
        list.replaceChildren(...(kids.length ? kids : [el('p', { class: 'd-note' }, toks.length ? 'Nothing matches that search.' : (empty || 'Nothing you can take right now.'))]));
      }
      q.addEventListener('input', draw);
      q.addEventListener('keydown', e => { if (e.key === 'Enter') { const f = list.querySelector('.cc-pk-opt:not(:disabled)'); if (f) { e.preventDefault(); f.click(); } } });
      dlg.append(el('div', { class: 'dlg cc-pk' },
        el('button', { class: 'dlg-x', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'),
        el('h2', {}, title), note ? el('p', { class: 'dlg-note' }, note) : null, q, allBox, list));
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg);
      draw(); dlg.showModal(); q.focus();
    }
    const card = (cls, head, ...body) => el('div', { class: 'cc-card ' + cls }, el('div', { class: 'cc-card-h' }, ...[].concat(head).filter(Boolean)), ...body.filter(Boolean));
    const tag = t => el('span', { class: 'cc-tag' }, t);
    const btns = (...b) => el('span', { class: 'cc-card-btns' }, ...b.filter(Boolean));

    const field = (label, input, hint) => el('label', { class: 'cc-field' }, el('span', { class: 'k' }, label), input, hint ? el('span', { class: 'hint' }, hint) : null);

    function textInput(key, attrs = {}) {
      return el('input', Object.assign({ type: 'text', value: cur.data[key] || '', oninput: e => { cur.data[key] = e.target.value; changed(); if (key === 'name') { const t = $('#detail .d-title'); if (t) t.textContent = e.target.value || 'New character'; } } }, attrs));
    }
    function area(key, rows, ph) {
      return el('textarea', { rows: String(rows), placeholder: ph || '', oninput: e => { cur.data[key] = e.target.value; changed(); } }, cur.data[key] || '');
    }

    function basics(c) {
      return el('div', { class: 'cc-grid cc-basics' },
        el('div', { class: 'cc-b-name' }, field('Name', textInput('name', { maxlength: '80', placeholder: 'Character name' }))),
        field('Level', el('input', { type: 'number', min: '0', class: 'cc-small', title: 'To add one level with its choices, use Level up', value: String(num(c.level)), onchange: e => set('level', Math.max(0, num(e.target.value))) })),
        field('Age', textInput('age', { maxlength: '20', class: 'cc-small' })),
        el('div', { class: 'cc-wide' }, field('Background', area('background', 3, 'Where they come from, who they were before the adventure…'))));
    }


    function raceOptions(selected, exclude) {
      const groups = {};
      for (const r of races()) if (r.id !== exclude) (groups[r.group] = groups[r.group] || []).push(r);
      return [el('option', { value: '' }, '— choose a race —'), ...Object.entries(groups).map(([g, rs]) =>
        el('optgroup', { label: g + (/prime/i.test(g) ? ' (locked, DM unlocks)' : '') },
          ...rs.map(r => el('option', { value: r.id, selected: r.id === selected }, r.name))))];
    }

    function raceSection(c, d) {
      const kids = [el('div', { class: 'cc-grid' },
        field(c.half ? 'Parent race (feat 1 and 3)' : 'Race', el('select', { class: 'select', onchange: e => set('raceId', e.target.value) }, ...raceOptions(c.raceId))),
        el('label', { class: 'toggle cc-check' }, el('input', { type: 'checkbox', checked: c.half, onchange: e => set('half', e.target.checked) }), 'Half variant (parents of two different races)'),
        c.half ? field('Other parent (feat 2 and 4)', el('select', { class: 'select', onchange: e => set('race2Id', e.target.value) }, ...raceOptions(c.race2Id, c.raceId))) : null)];
      if (!d.r) return kids;
      if (d.r.prime) kids.push(el('p', { class: 'd-note' }, '🔒 Prime races are unlocked in play. Check with your DM before choosing one.'));
      const t1 = raceTraits(d.r), t2 = d.r2 ? raceTraits(d.r2) : null;
      kids.push(el('div', { class: 'stats' },
        stat('HP', d.r.meta.hp || '—'), stat('I.M.P.', d.r.meta.imp || '—'),
        stat('Languages', [d.r.meta.languages, d.r2 && d.r2.meta.languages].filter(Boolean).join(', ') || '—')));
      const traits = t2 ? [t1.traits[0], t2.traits[1] || t2.traits[0]].filter(Boolean) : t1.traits;
      const feats = t2 ? [t1.feats.find(f => f.n === 3), t2.feats.find(f => f.n === 4)].filter(Boolean) : t1.feats;
      kids.push(el('div', { class: 'cc-list' },
        ...traits.map(t => el('div', { class: 'cc-item' }, el('strong', {}, t.name), el('div', { class: 'prose', html: md(t.text) }))),
        ...feats.map(f => el('div', { class: 'cc-item locked' }, el('strong', {}, `🔒 Feat ${f.n}: ${f.name}`), el('div', { class: 'hint' }, 'Unlocked in play.')))));
      kids.push(el('button', { class: 'mini', onclick: () => go({ tab: 'race', sel: d.r.id }, true) }, `Open the ${d.r.name} page →`));
      return kids;
    }

    function stat(k, v) { return el('div', { class: 'stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, String(v))); }

    function classSection(c, d) {
      const cats = {};
      for (const k of classes()) (cats[k.category] = cats[k.category] || []).push(k);
      const taken = i => d.slots.filter(x => x.i !== i).map(x => x.groupKey).filter(Boolean);
      const kids = [];
      for (const slot of d.slots) {
        const other = taken(slot.i);
        const fullyTaken = k => { const gs = groupsOf(k); return gs.length && gs.every(g => other.includes(g.key)); };
        kids.push(el('div', { class: 'cc-class' + (slot.i ? ' extra' : '') },
          slot.i ? el('div', { class: 'cc-subhead' }, el('strong', {}, `Extra class ${slot.i}`), el('span', { class: 'hint' }, `${RULES.costClass} SP`),
            el('button', { class: 'mini danger', onclick: () => { clearGroup(slot.groupKey); cur.data.classes.splice(slot.i, 1); changed(); render(); } }, 'Remove')) : null,
          el('div', { class: 'cc-grid' },
            field(slot.i ? 'Class' : 'Starting class', el('select', {
              class: 'select', onchange: e => setSlotClass(slot.i, e.target.value),
            }, el('option', { value: '' }, '— choose a class —'),
              ...Object.entries(cats).map(([cat, ks]) => el('optgroup', { label: cat }, ...ks.map(k => el('option', { value: k.id, selected: k.id === slot.classId, disabled: k.id !== slot.classId && fullyTaken(k) }, k.name)))))),
            slot.cls && groupsOf(slot.cls).length > 1 ? field('Path', el('select', {
              class: 'select', onchange: e => setSlotGroup(slot.i, e.target.value),
            }, el('option', { value: '' }, '— choose one —'), ...groupsOf(slot.cls).map(g => el('option', { value: g.key, selected: g.key === slot.groupKey, disabled: other.includes(g.key) }, g.title)))) : null),
          slot.cls ? el('div', { class: 'stats' },
            slot.i ? null : stat('HP', slot.cls.meta.hp || '—'), stat('Hit die', slot.cls.meta['hit die'] || '—'), slot.cls.meta.defence ? stat('Defence', slot.cls.meta.defence) : null,
            stat('Weapons', slot.cls.meta.weapons || '—'), slot.cls.meta.trait ? stat('Trait', slot.cls.meta.trait) : null) : null,
          slot.cls ? el('button', { class: 'mini', onclick: () => go({ tab: 'class', sel: slot.cls.id }, true) }, `Open the ${slot.cls.name} page →`) : null));
      }
      const firstReady = d.slots[0].g;
      const canAdd = firstReady && d.left >= RULES.costClass && d.slots.every(x => x.g);
      kids.push(el('div', { class: 'cc-addclass' },
        el('button', { class: 'btn small', disabled: !canAdd, onclick: () => { cur.data.classes.push({ classId: '', groupKey: '' }); changed(); render(); } }, `+ Add another class (${RULES.costClass} SP)`),
        el('span', { class: 'hint' }, !firstReady ? 'Choose your starting class first.' : !d.slots.every(x => x.g) ? 'Finish choosing the class above first.' : d.left < RULES.costClass ? `Needs ${RULES.costClass} SP left.` : 'Multiclassing has no limit. HP comes from your starting class.')));
      return kids;
    }

    function clearGroup(key) {
      if (!key) return;
      const b = cur.data.buys, g = groupByKey(key);
      delete b.general[key]; delete cur.data.hpRolls[key];
      if (g) for (const sub of g.items) { delete b.abil[sub.id]; delete b.feat[sub.id]; delete b.tiers[sub.id]; delete cur.data.unlocked[sub.id]; }
    }
    function setSlotClass(i, classId) {
      const slot = cur.data.classes[i];
      clearGroup(slot.groupKey);
      const others = cur.data.classes.filter((_, k) => k !== i).map(x => x.groupKey);
      const open = groupsOf(byId(classId)).filter(g => !others.includes(g.key));
      slot.classId = classId; slot.groupKey = open.length === 1 && groupsOf(byId(classId)).length === 1 ? open[0].key : '';
      changed(); render();
    }
    function setSlotGroup(i, key) { const slot = cur.data.classes[i]; clearGroup(slot.groupKey); slot.groupKey = key; changed(); render(); }

    function roll(n, sides) { return Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides)); }
    function rollStat(k) {
      const { n, sides, keep } = RULES.statDice;
      const dice = roll(n, sides).sort((a, b) => a - b);
      cur.data.rolls[k] = dice; cur.data.stats[k] = dice.slice(0, keep).reduce((a, x) => a + x, 0);
    }

    /* ---- stats: one card per stat ---- */
    const STAT_NAMES = { STR: 'Strength', DEX: 'Dexterity', INT: 'Intelligence', WIS: 'Wisdom', PER: 'Perception', CHA: 'Charisma' };
    function statCards(c, d, keys, label) {
      const { keep, sides } = RULES.statDice;
      const cards = d.stats.filter(s => keys.includes(s.k)).map(s => {
        const dice = c.rolls[s.k], adj = num(c.adjust[s.k]), q = s.mod - adj;
        const parts = [s.base != null ? `rolled ${s.base}` : null, q ? `quirks ${fmt(q)}` : null, adj ? `adjust ${fmt(adj)}` : null, s.lvlMod ? `levels ${fmt(s.lvlMod)}` : null].filter(Boolean);
        return el('div', { class: 'cc-stat' + (s.final == null ? ' empty' : '') },
          el('span', { class: 'k', title: STAT_NAMES[s.k] || s.k }, s.k),
          el('span', { class: 'v' }, s.final == null ? '—' : String(s.final)),
          el('span', { class: 'bd' }, parts.length > 1 || s.base == null ? (parts.join(' · ') || 'Not rolled') : '\u00a0'),
          dice ? el('span', { class: 'dice', title: `Rolled ${dice.join(', ')}; the highest is dropped`, html: dice.map((x, i) => i < keep ? String(x) : `<s>${x}</s>`).join(' ') }) : null,
          showAdjust ? el('div', { class: 'cc-stat-edit' },
            el('label', {}, 'Rolled', el('input', { type: 'number', class: 'num', min: String(keep), max: String(keep * sides), value: s.base == null ? '' : String(s.base), 'aria-label': `${s.k} rolled`, onchange: e => { cur.data.stats[s.k] = e.target.value === '' ? '' : num(e.target.value); delete cur.data.rolls[s.k]; changed(); render(); } })),
            el('label', {}, 'Adjust', el('input', { type: 'number', class: 'num', value: String(adj), title: '−1 improves the stat, +1 worsens it', 'aria-label': `${s.k} adjustment`, onchange: e => { cur.data.adjust[s.k] = num(e.target.value); changed(); render(); } }))) : null,
          el('button', { class: 'mini', 'aria-label': `${s.base == null ? 'Roll' : 'Reroll'} ${s.k}`, onclick: () => { rollStat(s.k); changed(); render(); } }, s.base == null ? 'Roll' : 'Reroll'));
      });
      const rolledAny = keys.some(k => c.stats[k] !== '' && c.stats[k] != null);
      return [
        el('div', { class: 'cc-stat-head' }, el('h3', { class: 'cc-h3' }, label),
          el('button', { class: 'btn small' + (rolledAny ? '' : ' primary'), onclick: () => { keys.forEach(rollStat); changed(); render(); } }, `${rolledAny ? 'Reroll' : 'Roll'} all ${label.toLowerCase()}`)),
        el('div', { class: 'cc-statgrid' + (keys.length === 5 ? ' five' : '') }, ...cards),
      ];
    }
    function statsSection(c, d) {
      const { n, sides, keep } = RULES.statDice;
      return [
        el('p', { class: 'd-note' }, `Each stat is ${n}d${sides}, keeping the lowest ${keep}. Lower is better. Level-up improvements are added for you.`),
        ...statCards(c, d, BASE_STATS, 'Stats'),
        ...statCards(c, d, COMBAT_STATS, 'Combat stats'),
        el('label', { class: 'toggle cc-adjust-t' }, el('input', { type: 'checkbox', checked: showAdjust, onchange: e => { showAdjust = e.target.checked; render(); } }),
          ' Enter rolls by hand, or adjust a stat for your race or class (−1 improves it)'),
      ];
    }
    const fmt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);

    /* ---- drawbacks and quirks ---- */
    function traitsSection(c, d) {
      const { drawbacks, quirks } = traitLists();
      const dFull = c.drawbacks.length >= RULES.maxDrawbacks, qFull = c.quirks.length >= RULES.maxQuirks;
      const drop = (key, name) => () => { cur.data[key] = cur.data[key].filter(x => x !== name); changed(); render(); };
      const add = (key, v) => { cur.data[key].push(v); changed(); render(); };
      return [
        el('p', { class: 'd-note' }, `Both are optional. Take up to ${RULES.maxDrawbacks} drawbacks (they give back at most ${RULES.maxDrawbackSP} SP) and up to ${RULES.maxQuirks} quirks.`),
        el('div', { class: 'cc-cols' },
          el('div', {}, el('h3', { class: 'cc-h3' }, `Drawbacks · ${c.drawbacks.length} of ${RULES.maxDrawbacks}${d.refund ? ` · ${d.refund} SP back` : ''}`),
            ...d.dSel.map(x => card('', [el('strong', {}, x.name), tag(`${x.sp} SP back`), btns(el('button', { class: 'mini danger', onclick: drop('drawbacks', x.name) }, 'Remove'))], el('p', { class: 'cc-card-t' }, x.text))),
            el('button', { class: 'btn small cc-add', disabled: dFull, onclick: () => picker({
              title: 'Add a drawback', note: d.refund >= RULES.maxDrawbackSP ? `You already get the most SP back (${RULES.maxDrawbackSP}); another drawback won’t give more.` : `Drawbacks give back at most ${RULES.maxDrawbackSP} SP in total.`,
              groups: [{ options: drawbacks.filter(x => !c.drawbacks.includes(x.name)).map(x => ({ value: x.name, name: x.name, meta: `${x.sp} SP back`, text: x.text })) }],
              onPick: v => add('drawbacks', v) }) }, dFull ? `Drawbacks full (${RULES.maxDrawbacks})` : '+ Add a drawback')),
          el('div', {}, el('h3', { class: 'cc-h3' }, `Quirks · ${c.quirks.length} of ${RULES.maxQuirks}`),
            ...d.qSel.map(x => card('', [el('strong', {}, x.name), btns(el('button', { class: 'mini danger', onclick: drop('quirks', x.name) }, 'Remove'))], el('p', { class: 'cc-card-t' }, `${x.gain}; ${x.cost}`))),
            el('button', { class: 'btn small cc-add', disabled: qFull, onclick: () => picker({
              title: 'Add a quirk', note: 'Quirks trade one stat for another, at no SP cost.',
              groups: [{ options: quirks.filter(x => !c.quirks.includes(x.name)).map(x => ({ value: x.name, name: x.name, text: `${x.gain}; ${x.cost}` })) }],
              onPick: v => add('quirks', v) }) }, qFull ? `Quirks full (${RULES.maxQuirks})` : '+ Add a quirk'))),
      ];
    }

    /* ---- level-ups: stat improvements, hit dice, milestone boons ---- */
    // multiclassed characters roll whichever of their classes' hit dice is highest
    function bestDie(d) {
      let best = '', top = -1;
      for (const x of d.slots) {
        const die = x.cls && x.cls.meta['hit die'];
        const m = die && die.match(/(\d+)d(\d+)/);
        if (m && num(m[1]) * num(m[2]) > top) { top = num(m[1]) * num(m[2]); best = m[0]; }
      }
      return best;
    }
    const lvSet = (k, key, v) => { if (v === '' || v == null) delete cur.data.lv[k][key]; else cur.data.lv[k][key] = v; changed(); render(); };

    function levelSection(c, d) {
      const kids = [el('div', { class: 'stats' }, stat('Level', d.L), stat('Renown', d.R)),
        lvlup || mode === 'guide' ? null : el('p', { class: 'cc-lvl-cta' }, el('button', { class: 'btn small primary', onclick: startLevelUp }, `Level up to ${d.L + 1}`),
          el('span', { class: 'hint' }, d.L ? ' Walks you through what the next level gives. Earlier levels can be changed below.' : ' Walks you through what level 1 gives.'))];
      if (!d.L) { kids.push(el('p', { class: 'd-note' }, 'Level 0 is your starting character. Raise the level under Basics to plan what each level gives: stat improvements at X1 and X4, hit dice at X2 and X10, soft skill ranks at X4 and X6, a feat at X8, and a milestone boon every tenth level.')); return kids; }
      const lv = c.lv;
      if (d.G.stat.length) {
        kids.push(el('h3', { class: 'cc-h3' }, 'Stat improvements'),
          el('div', { class: 'cc-rows' }, ...d.G.stat.map(x => el('label', { class: 'cc-row' },
            el('span', { class: 'k' }, `Level ${x.lvl}`),
            el('select', { class: 'select', onchange: e => lvSet('stat', x.lvl, e.target.value) },
              el('option', { value: '' }, '— improve a stat —'),
              el('optgroup', { label: 'Stats' }, ...BASE_STATS.map(k => el('option', { value: k, selected: lv.stat[x.lvl] === k }, k))),
              el('optgroup', { label: 'Combat stats' }, ...COMBAT_STATS.map(k => el('option', { value: k, selected: lv.stat[x.lvl] === k }, k)))),
            el('span', { class: 'hint' }, `−1, but not below ${x.floor}`)))));
      }
      const die = bestDie(d);
      const dm = die.match(/(\d+)d(\d+)/);
      if (d.G.hd.length) {
        kids.push(el('h3', { class: 'cc-h3' }, `Hit dice${die ? ` (${die}${d.slots.filter(x => x.cls).length > 1 ? ', your highest' : ''})` : ''}`),
          el('div', { class: 'cc-rows' }, ...d.G.hd.map(n => el('label', { class: 'cc-row' },
            el('span', { class: 'k' }, `Level ${n}`),
            el('input', { type: 'number', min: '0', class: 'num', value: lv.hd[n] == null ? '' : String(lv.hd[n]), onchange: e => lvSet('hd', n, e.target.value === '' ? '' : num(e.target.value)) }),
            dm ? el('button', { class: 'mini', type: 'button', onclick: () => lvSet('hd', n, roll(num(dm[1]), num(dm[2])).reduce((a, x) => a + x, 0)) }, 'Roll') : null))),
          dm ? el('button', { class: 'btn small', onclick: () => { for (const n of d.G.hd) if (lv.hd[n] == null) lv.hd[n] = roll(num(dm[1]), num(dm[2])).reduce((a, x) => a + x, 0); changed(); render(); } }, 'Roll the empty ones') : el('p', { class: 'hint' }, 'Choose a class to roll its hit die.'),
          el('p', { class: 'hint' }, `${d.hdRolled} HP from hit dice, added to your max HP.`));
      }
      if (d.boons.length) {
        kids.push(el('h3', { class: 'cc-h3' }, 'Milestone boons'));
        for (const b of d.boons) kids.push(boonRow(c, b));
      }
      return kids;
    }


    /* ---- level up: one level at a time ---- */
    function startLevelUp() {
      lvlup = { to: num(cur.data.level) + 1, snap: JSON.parse(JSON.stringify(cur.data)), wasDirty: cur.dirty, skills: [], fp: false, back: mode };
      mode = 'edit'; cur.data.level = lvlup.to; changed(); render();
      requestAnimationFrame(() => { const p = $('#cc-levelup'); if (p) { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); p.focus({ preventScroll: true }); } });
    }
    function cancelLevelUp() {
      const back = lvlup.back; cur.data = lvlup.snap; cur.dirty = lvlup.wasDirty; lvlup = null; mode = back || 'edit'; saveDraft(); render(); toTop();
    }
    function finishLevelUp() { const back = lvlup.back; lvlup = null; mode = back || 'edit'; render(); toTop(); }

    function levelGains(N) {
      const k = N % 10, out = [];
      if ([1, 3, 5, 7, 9, 0].includes(k)) out.push(N >= 11 ? '1 subclass point (SP), or 1 FP instead' : '1 subclass point (SP)');
      if (k === 1) out.push('Improve one stat or combat stat by 1 (not below 10)');
      if (k === 4) out.push('Improve one stat or combat stat by 1 (not below 5)');
      if (k === 2 || k === 0) out.push('A roll of your hit die for extra HP');
      if (k === 4 || k === 6) out.push('1 soft skill rank');
      if (k === 8) out.push('A feat (Tier I–III)');
      if (k === 0) {
        const R = RULES.renownAt(N);
        out.push(`Renown ${R - 1} → ${R}`, 'A milestone boon');
        const tier = Object.entries(RULES.tierRenown).find(([, r]) => r === R);
        if (tier) out.push(`Tier ${romanOf(num(tier[0]))} feats open`);
        RULES.rankRenown.forEach((r, i) => { if (i > 2 && r === R) out.push(`${RANKS[i]} soft skill rank opens`); });
        if (R === 5) out.push('You can hold more than one Master skill per family');
        if (R === 11) out.push('You can hold more than one Legendary skill');
      }
      return out;
    }

    function levelUpPanel(c, d) {
      if (!lvlup) return null;
      if (d.L !== lvlup.to) { lvlup = null; return null; }
      const N = lvlup.to, k = N % 10, lv = c.lv;
      const step = (title, body, done) => el('div', { class: 'cc-buy cc-step' + (done ? ' on' : '') },
        el('div', { class: 'cc-subhead' }, el('span', { class: 'cc-tick', 'aria-hidden': 'true' }, done ? '✓' : '•'), title), ...[].concat(body).filter(Boolean));
      const steps = [];
      const todo = [];

      // stat improvement
      const sx = d.G.stat.find(x => x.lvl === N);
      if (sx) {
        const pick = lv.stat[N];
        const s = pick && d.stats.find(x => x.k === pick);
        steps.push(step('Improve a stat', el('label', { class: 'cc-row' },
          el('select', { class: 'select', onchange: e => lvSet('stat', N, e.target.value) },
            el('option', { value: '' }, '— choose a stat —'),
            el('optgroup', { label: 'Stats' }, ...BASE_STATS.map(k2 => el('option', { value: k2, selected: pick === k2 }, k2))),
            el('optgroup', { label: 'Combat stats' }, ...COMBAT_STATS.map(k2 => el('option', { value: k2, selected: pick === k2 }, k2)))),
          el('span', { class: 'hint' }, s && s.final != null ? `${pick} is now ${s.final}${s.lvlMod ? '' : ` (already at ${sx.floor} or lower, so no change)`}` : `−1 to the stat, but not below ${sx.floor}. Lower is better.`)), !!pick));
        if (!pick) todo.push('a stat');
      }
      // hit die
      if (d.G.hd.includes(N)) {
        const die = bestDie(d), dm = die.match(/(\d+)d(\d+)/), v = lv.hd[N];
        steps.push(step(`Roll your hit die${die ? ` (${die})` : ''}`, el('div', { class: 'cc-row' },
          el('input', { type: 'number', min: '0', class: 'num', 'aria-label': 'Hit die result', value: v == null ? '' : String(v), onchange: e => lvSet('hd', N, e.target.value === '' ? '' : num(e.target.value)) }),
          dm ? el('button', { class: 'btn small', onclick: () => lvSet('hd', N, roll(num(dm[1]), num(dm[2])).reduce((a, x) => a + x, 0)) }, v == null ? 'Roll' : 'Reroll') : el('span', { class: 'hint' }, 'Choose a class first.'),
          el('span', { class: 'hint' }, v == null ? 'Or type what you rolled at the table.' : `+${v} HP · max HP is now ${d.hp}`)), v != null));
        if (v == null) todo.push('your hit die');
      }
      // milestone boon (and a Tier IV/V feat if that's the boon)
      const boon = d.boons.find(b => b.lvl === N);
      if (boon) {
        const bSlot = d.featSlots.find(sl => sl.key === 'B' + N);
        const boonDone = !!boon.type && (boon.type !== 'combat' || !!boon.stat) && (boon.type !== 'combat2' || (!!boon.stat && !!boon.stat2)) && (!bSlot || !!lv.feats[bSlot.key]);
        steps.push(step('Choose a milestone boon', [boonRow(c, boon), bSlot ? featSlotRow(c, d, bSlot) : null], boonDone));
        if (!boonDone) todo.push('a milestone boon');
      }
      // feat
      const fSlot = d.featSlots.find(sl => sl.key === 'L' + N);
      if (fSlot) {
        steps.push(step('Choose a feat', featSlotRow(c, d, fSlot), !!lv.feats[fSlot.key]));
        if (!lv.feats[fSlot.key]) todo.push('a feat');
      }
      // soft skill ranks (from this level, a boon, or any left over)
      const leftRanks = d.skillRanks - d.skillsUsed;
      if (leftRanks > 0 || lvlup.skills.length) {
        steps.push(step(`Spend soft skill ranks${leftRanks > 0 ? ` · ${leftRanks} left` : ''}`, [
          lvlup.skills.length ? el('ul', { class: 'cc-added' }, ...lvlup.skills.map((x, i) => el('li', {}, `${x.n} → ${RANKS[x.to]} `,
            i === lvlup.skills.length - 1 ? el('button', { class: 'mini', onclick: () => { const r = num(lv.skills[x.n]) - 1; if (r > 0) lv.skills[x.n] = r; else delete lv.skills[x.n]; lvlup.skills.pop(); changed(); render(); } }, 'Undo') : null))) : null,
          leftRanks > 0 ? el('button', { class: 'btn small primary', onclick: () => skillPicker(c, d, n => { lv.skills[n] = num(lv.skills[n]) + 1; lvlup.skills.push({ n, to: lv.skills[n] }); changed(); render(); }) }, '+ Add a skill rank') : null], leftRanks <= 0));
        if (leftRanks > 0) todo.push(`${leftRanks} soft skill rank${leftRanks === 1 ? '' : 's'}`);
      }
      // SP (or FP)
      if ([1, 3, 5, 7, 9, 0].includes(k)) {
        steps.push(step(`Spend your point · ${d.left} SP left`, [
          N >= 11 ? el('label', { class: 'cc-opt' }, el('input', { type: 'checkbox', checked: lvlup.fp, onchange: e => {
            lvlup.fp = e.target.checked; lv.fp = Math.max(0, num(lv.fp) + (lvlup.fp ? 1 : -1)); changed(); render(); } }),
            el('span', {}, 'Take this level’s point as FP instead of SP')) : null,
          el('div', { class: 'cc-row' }, el('button', { class: 'btn small', onclick: () => jump('Subclass points') }, 'Go to Subclass points'),
            el('span', { class: 'hint' }, d.left > 0 ? 'Buy class-wide benefits, abilities, feats or spell tiers. Your choices here stay open while you do.' : 'Nothing left to spend.'))], d.left <= 0));
      }
      if (!steps.length) steps.push(el('p', { class: 'd-note' }, 'Nothing to choose this level.'));

      return el('section', { class: 'cc-sec cc-levelup', id: 'cc-levelup', tabindex: '-1', 'aria-label': `Level ${N}` },
        el('div', { class: 'cc-lu-head' }, el('h2', {}, `Level ${N}`), el('span', { class: 'hint' }, `Renown ${d.R}`)),
        el('p', { class: 'cc-h3' }, 'You gain'),
        el('ul', { class: 'cc-gains' }, ...levelGains(N).map(g => el('li', {}, g))),
        el('p', { class: 'cc-h3' }, 'Your choices'),
        ...steps,
        el('div', { class: 'cc-tools' },
          el('button', { class: 'btn primary', onclick: finishLevelUp }, `Finish level ${N}`),
          el('button', { class: 'btn ghost', onclick: cancelLevelUp }, 'Cancel level-up'),
          todo.length ? el('span', { class: 'hint' }, `Still to choose: ${todo.join(', ')}. You can finish now and come back to these under Level-ups.`) : null));
    }

    function boonRow(c, b) {
      const R = b.renown;
      const opts = [['combat', 'Improve one combat stat by 1'], ['skills2', 'Gain 2 soft skill ranks'], ['retrain', 'Retrain a feat and up to 2 skill ranks'],
        ...(R >= 6 ? [['pastMaster', 'Gain one soft skill rank past Master']] : []),
        ...(R >= 8 ? [['tier4', 'Take a Tier IV feat'], ['combat2', 'Improve two combat stats by 1']] : []),
        ...(R >= 11 ? [['tier5', 'Take a Tier V feat'], ['mark', 'Claim a Mythic Mark (DM approval)']] : [])];
      const setB = patch => { const cur0 = cur.data.lv.boons[b.lvl] || {}; const next = Object.assign({}, cur0, patch);
        if (patch.type !== undefined && patch.type !== cur0.type) { delete cur.data.lv.feats['B' + b.lvl]; next.stat = ''; next.stat2 = ''; next.note = ''; }
        if (!next.type) delete cur.data.lv.boons[b.lvl]; else cur.data.lv.boons[b.lvl] = next; changed(); render(); };
      const statSel = (key, label) => el('select', { class: 'select', onchange: e => setB({ [key]: e.target.value }) },
        el('option', { value: '' }, label), ...COMBAT_STATS.map(k => el('option', { value: k, selected: b[key] === k }, k)));
      return el('div', { class: 'cc-row boon' },
        el('span', { class: 'k' }, `Level ${b.lvl}`),
        el('select', { class: 'select', onchange: e => setB({ type: e.target.value }) },
          el('option', { value: '' }, '— choose a boon —'), ...opts.map(([v, t]) => el('option', { value: v, selected: b.type === v }, t))),
        b.type === 'combat' ? statSel('stat', '— combat stat —') : null,
        b.type === 'combat2' ? [statSel('stat', '— first —'), statSel('stat2', '— second —')] : null,
        b.type === 'tier4' || b.type === 'tier5' ? el('span', { class: 'hint' }, 'Pick the feat under Feats.') : null,
        b.type === 'retrain' || b.type === 'mark' ? el('input', { type: 'text', class: 'cc-note', placeholder: b.type === 'mark' ? 'Which mark, for what deed' : 'What you swapped', value: b.note || '', onchange: e => setB({ note: e.target.value }) }) : null);
    }

    function skillCheck(c, d, sk, to) {
      const R = d.R, ranks = c.lv.skills;
      if (to > 5) return 'Legendary is the highest rank.';
      if (R < sk.renown) return `Needs Renown ${sk.renown}.`;
      if (R < RULES.rankRenown[to]) return `${RANKS[to]} needs Renown ${RULES.rankRenown[to]}.`;
      if (d.skillsUsed >= d.skillRanks) return 'No soft skill ranks left.';
      if (to > 3 && d.pastUsed >= d.pastMaster) return 'Ranks past Master come from a milestone boon.';
      if (to === 3 && R < 5 && skillList().some(x => x.family === sk.family && x.name !== sk.name && num(ranks[x.name]) >= 3)) return `Only one Master per family until Renown 5.`;
      if (to === 5 && R < 11 && Object.entries(ranks).some(([n, r]) => n !== sk.name && num(r) >= 5)) return 'Only one Legendary skill until Renown 11.';
      return '';
    }

    /* ---- soft skills ---- */
    function skillPicker(c, d, onPick) {
      const fams = [...new Set(skillList().map(x => x.family))];
      picker({
        title: 'Add a soft skill rank',
        note: `One rank is Trained, two Expert, three Master (Renown ${RULES.rankRenown[3]}). You have ${pl(d.skillRanks - d.skillsUsed, 'rank')} to spend.`,
        groups: fams.map(f => ({ label: f, options: skillList().filter(x => x.family === f).map(sk => {
          const r = num(c.lv.skills[sk.name]);
          return { value: sk.name, name: sk.name, meta: r ? `${RANKS[r]} → ${RANKS[r + 1] || '—'}` : 'New · Trained', text: sk.renown > 1 ? `Renown ${sk.renown} skill` : '', why: skillCheck(c, d, sk, r + 1) };
        }) })),
        onPick,
      });
    }
    const pips = r => el('span', { class: 'cc-pips', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map(i => el('i', { class: i <= r ? 'on' : '' })));
    function skillsSection(c, d) {
      const left = d.skillRanks - d.skillsUsed;
      const kids = [el('div', { class: 'sp-bar' }, stat('Ranks', d.skillRanks), stat('Used', d.skillsUsed),
        el('div', { class: 'stat sp-left' + (left < 0 ? ' bad' : '') }, el('span', { class: 'k' }, 'Left'), el('span', { class: 'v' }, String(left))),
        d.pastMaster ? stat('Past Master', `${d.pastUsed}/${d.pastMaster}`) : null)];
      if (!d.skillRanks && !d.skillsUsed) { kids.push(el('p', { class: 'd-note' }, 'You gain soft skill ranks at levels X4 and X6, and from milestone boons. Your first comes at level 4.')); return kids; }
      const byFam = skillList();
      const held = Object.entries(c.lv.skills).filter(([, r]) => num(r) > 0)
        .map(([n, r]) => ({ n, r: num(r), sk: byFam.find(x => x.name === n) || { name: n, family: '', renown: 1 } }))
        .sort((a, b) => b.r - a.r || a.n.localeCompare(b.n));
      if (held.length) kids.push(el('div', { class: 'cc-skillrows' }, ...held.map(h => {
        const why = skillCheck(c, d, h.sk, h.r + 1);
        return el('div', { class: 'cc-skillrow' },
          el('span', { class: 'nm' }, el('strong', {}, h.n), h.sk.family ? el('span', { class: 'fam' }, h.sk.family) : null),
          pips(h.r), el('span', { class: 'rk' }, RANKS[h.r]),
          el('span', { class: 'cc-card-btns' },
            el('button', { class: 'mini', 'aria-label': `Remove a rank from ${h.n}`, onclick: () => { const v = h.r - 1; if (v > 0) c.lv.skills[h.n] = v; else delete c.lv.skills[h.n]; changed(); render(); } }, '−'),
            el('button', { class: 'mini', disabled: !!why, title: why || `Raise to ${RANKS[h.r + 1]}`, 'aria-label': `Add a rank to ${h.n}`, onclick: () => { c.lv.skills[h.n] = h.r + 1; changed(); render(); } }, '+')));
      })));
      kids.push(el('button', { class: 'btn small cc-add' + (left > 0 && !held.length ? ' primary' : ''), disabled: left <= 0, onclick: () => skillPicker(c, d, n => { c.lv.skills[n] = num(c.lv.skills[n]) + 1; changed(); render(); }) },
        left > 0 ? '+ Add a skill rank' : 'No ranks left to spend'));
      return kids;
    }

    /* ---- feats ---- */
    function featWhy(c, d, f, slot) {
      if (f.tier > slot.max) return `Tier ${romanOf(f.tier)} is above this slot`;
      if (slot.min && f.tier < slot.min) return `This slot needs a Tier ${romanOf(slot.min)} feat`;
      if (RULES.renownAt(slot.lvl) < RULES.tierRenown[f.tier]) return `Tier ${romanOf(f.tier)} needs Renown ${RULES.tierRenown[f.tier]}`;
      const taken = Object.entries(c.lv.feats).filter(([k]) => k !== slot.key).map(([, v]) => v);
      if (taken.includes(f.name)) return 'You already have this feat';
      const miss = f.needs.filter(n => !taken.includes(n));
      if (miss.length) return `Needs ${miss.join(', ')}`;
      if (f.caster && !d.slots.some(x => x.magic)) return 'Needs a spellcasting class';
      return '';
    }
    const featOk = (c, d, f, slot) => !featWhy(c, d, f, slot);
    function featsSection(c, d) {
      if (!d.featSlots.length) return [el('p', { class: 'd-note' }, 'You gain a feat at every level X8 (8, 18, 28…), and Tier IV or V feats from milestone boons at high Renown. Your first comes at level 8.')];
      return [el('p', { class: 'd-note' }, 'Each slot offers the feats you qualify for at that level.'), ...d.featSlots.map(slot => featSlotRow(c, d, slot))];
    }
    function featSlotRow(c, d, slot) {
      const chosen = featList().find(f => f.name === c.lv.feats[slot.key]);
      const cats = [...new Set(featList().map(f => f.cat))];
      const maxOpen = [5, 4, 3, 2, 1].find(t => t <= slot.max && RULES.renownAt(slot.lvl) >= RULES.tierRenown[t]) || 1;
      const open = () => picker({
        title: `Choose a feat · ${slot.label}`,
        note: slot.min ? `This slot takes a Tier ${romanOf(slot.min)} feat.` : `This slot takes a Tier I${maxOpen > 1 ? '–' + romanOf(maxOpen) : ''} feat.`,
        groups: cats.map(cat => ({ label: cat, options: featList().filter(f => f.cat === cat && f.tier <= slot.max).map(f => ({
          value: f.name, name: f.name, meta: `Tier ${romanOf(f.tier)}${f.caster ? ' · caster' : ''}`, text: f.effect, why: chosen && f.name === chosen.name ? '' : featWhy(c, d, f, slot) })) })),
        onPick: v => lvSet('feats', slot.key, v),
      });
      return card('cc-slot' + (chosen ? ' on' : ' empty'),
        [tag(slot.label), chosen ? el('strong', {}, chosen.name) : el('span', { class: 'hint' }, 'No feat chosen yet'), chosen ? tag(`Tier ${romanOf(chosen.tier)}`) : null,
          btns(el('button', { class: 'btn small' + (chosen ? '' : ' primary'), onclick: open }, chosen ? 'Change' : 'Choose a feat'),
            chosen ? el('button', { class: 'mini danger', onclick: () => lvSet('feats', slot.key, '') }, 'Remove') : null)],
        chosen ? el('p', { class: 'cc-card-t' }, chosen.effect) : null);
    }

    /* ---- subclass points ---- */
    function spSection(c, d) {
      const kids = [el('div', { class: 'sp-bar' },
        stat('From level', d.earned), stat('Drawbacks', d.refund),
        el('label', { class: 'stat sp-adj' }, el('span', { class: 'k' }, 'DM bonus'),
          el('input', { type: 'number', class: 'num', value: String(num(c.spAdjust)), title: 'SP your DM has awarded', onchange: e => set('spAdjust', num(e.target.value)) })),
        d.G.fpLevels ? el('label', { class: 'stat sp-adj' }, el('span', { class: 'k' }, 'As FP'),
          el('input', { type: 'number', class: 'num', min: '0', max: String(d.G.fpLevels), value: String(d.fp), title: `From level 11 you may take FP instead of SP on an SP level (up to ${d.G.fpLevels} so far)`, onchange: e => { cur.data.lv.fp = Math.min(Math.max(0, num(e.target.value)), d.G.fpLevels); changed(); render(); } })) : null,
        stat('Spent', d.spent), el('div', { class: 'stat sp-left' + (d.left < 0 ? ' bad' : '') }, el('span', { class: 'k' }, 'Left'), el('span', { class: 'v' }, String(d.left))))];
      if (d.left < 0) kids.push(el('p', { class: 'notes-msg' }, 'You’ve spent more SP than you have. Remove something, or raise your level.'));
      if (!d.cls) { kids.push(el('p', { class: 'd-note' }, 'Choose a class first.')); return kids; }
      if (d.total === 0 && d.spent === 0) kids.push(el('p', { class: 'd-note' }, 'Level 0 characters start with 0 SP. Level up, take a drawback, or add SP your DM has given you to start buying.'));
      const can = cost => d.left >= cost;
      for (const slot of d.slots) {
        if (d.slots.length > 1) kids.push(el('h3', { class: 'cc-h3 cc-classhead' }, slot.label || `Extra class ${slot.i}`, slot.i ? el('span', { class: 'hint' }, ` · added for ${RULES.costClass} SP`) : null));
        if (!slot.g) { kids.push(el('p', { class: 'd-note' }, slot.cls ? 'Choose a path for this class first.' : 'Choose a class first.')); continue; }
        kids.push(generalBuy(c, slot, can));
        kids.push(el('div', { class: 'cc-subs' }, ...slot.g.items.map(sub => subBuy(c, slot, sub, can))));
      }
      return kids;
    }

    function generalBuy(c, slot, can) {
      const b = c.buys, g = slot.g, on = !!b.general[g.key];
      const hpDice = (g.intro || '').match(/Gain (\d+d\d+) hit points/i);
      const rolls = c.hpRolls[g.key] || [];
      return card('cc-general' + (on ? ' on' : ''),
        [el('strong', {}, `${g.title}: class-wide benefits`), tag(`${RULES.costGeneral} SP`),
          btns(on ? el('span', { class: 'cc-own' }, '✓ Bought') : null,
            on ? el('button', { class: 'mini danger', title: 'Also removes everything bought in this class', onclick: () => { clearGroup(g.key); changed(); render(); } }, 'Remove')
              : el('button', { class: 'btn small primary', disabled: !can(RULES.costGeneral), onclick: () => { b.general[g.key] = true; changed(); render(); } }, `Buy · ${RULES.costGeneral} SP`))],
        on ? null : el('p', { class: 'cc-card-t' }, can(RULES.costGeneral) ? 'Buy this first: everything else in this class needs it.' : `Buy this first: everything else in this class needs it. You need ${RULES.costGeneral} SP left.`),
        el('details', { class: 'cc-what' }, el('summary', {}, 'What you get'), el('div', { class: 'prose', html: md(g.intro || '') })),
        on && hpDice ? el('div', { class: 'cc-hp' },
          rolls.length ? `Rolled ${hpDice[1]}: ${rolls.join(' + ')} = ${rolls.reduce((a, x) => a + x, 0)} HP` : `Roll ${hpDice[1]} for extra HP.`,
          el('button', { class: 'btn small' + (rolls.length ? '' : ' primary'), onclick: () => { const [n, sd] = hpDice[1].split('d').map(Number); cur.data.hpRolls[g.key] = roll(n, sd); changed(); render(); } }, rolls.length ? 'Reroll' : `Roll ${hpDice[1]}`)) : null);
    }

    function subBuy(c, slot, sub, can) {
      const b = c.buys;
      const locked = sub.sixth && !c.unlocked[sub.id];
      const hasGeneral = !!b.general[slot.g.key];
      const ready = hasGeneral && !sub.upcoming && !locked;
      const reason = sub.upcoming ? 'Not released yet' : locked ? 'Sixth: your DM unlocks it' : !hasGeneral ? 'Buy class-wide benefits first' : '';
      const abil = slot.magic ? [] : abilities(sub);
      const ownedA = b.abil[sub.id] || [], tiers = b.tiers[sub.id] || [], hasFeat = !!b.feat[sub.id];
      const spells = slot.magic ? spellsWith(sub.spellsTag) : [];
      const tierList = [1, 2, 3, 4, 5, 6].filter(t => spells.some(s => s.tier === t));
      const count = slot.magic
        ? (hasFeat ? `Feat ✓${tiers.length ? ` · tier${tiers.length > 1 ? 's' : ''} ${tiers.join(', ')}` : ''}` : 'Nothing bought')
        : (ownedA.length ? `${ownedA.length} of ${abil.length} bought` : `${abil.length} abilit${abil.length === 1 ? 'y' : 'ies'}`);
      const isOpen = openSubs.has(sub.id);
      const head = el('button', { class: 'cc-sub-h', 'aria-expanded': String(isOpen), onclick: () => { isOpen ? openSubs.delete(sub.id) : openSubs.add(sub.id); render(); } },
        el('span', { class: 'chev', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
        el('strong', {}, sub.name),
        sub.sixth ? el('span', { class: 'badge sixth' }, 'Sixth') : null,
        sub.upcoming ? el('span', { class: 'badge soon' }, 'Coming soon') : null,
        el('span', { class: 'cnt' + ((slot.magic ? hasFeat : ownedA.length) ? ' has' : '') }, count),
        reason ? el('span', { class: 'why' }, reason) : null);
      const box = el('div', { class: 'cc-sub' + (isOpen ? ' open' : '') + ((slot.magic ? hasFeat : ownedA.length) ? ' has' : '') + (reason ? ' wait' : '') }, head);
      if (!isOpen) return box;
      const inner = el('div', { class: 'cc-sub-body' },
        el('div', { class: 'cc-sub-tools' },
          el('button', { class: 'mini', onclick: () => openItem(sub.id) }, `Read ${sub.name} →`),
          sub.sixth ? el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!c.unlocked[sub.id], onchange: e => { if (e.target.checked) c.unlocked[sub.id] = true; else { delete c.unlocked[sub.id]; delete b.abil[sub.id]; delete b.feat[sub.id]; delete b.tiers[sub.id]; } changed(); render(); } }), ' My DM has unlocked this') : null));
      box.append(inner);
      if (sub.upcoming) { inner.append(el('p', { class: 'hint' }, 'Not released yet.')); return box; }
      const buyRow = (name, text, has, cost, onBuy, onDrop, html) => el('div', { class: 'cc-buyrow' + (has ? ' on' : '') },
        el('div', { class: 'tx' }, el('strong', {}, name), text ? el('span', html ? { class: 'hint', html: text } : { class: 'hint' }, html ? undefined : text) : null),
        has ? btns(el('span', { class: 'cc-own' }, '✓'), el('button', { class: 'mini danger', onclick: onDrop }, 'Remove'))
          : el('button', { class: 'btn small', disabled: !ready || !can(cost), title: !ready ? reason : !can(cost) ? `Needs ${cost} SP left` : '', onclick: onBuy }, `Buy · ${cost} SP`));
      if (!slot.magic) {
        for (const a of abil) {
          const has = ownedA.includes(a.key);
          inner.append(buyRow(a.name, md(a.text).replace(/^<p>|<\/p>$/g, ''), has, RULES.costAbility,
            () => { (b.abil[sub.id] = b.abil[sub.id] || []).push(a.key); changed(); render(); },
            () => { b.abil[sub.id] = (b.abil[sub.id] || []).filter(k => k !== a.key); if (!b.abil[sub.id].length) delete b.abil[sub.id]; changed(); render(); }, true));
        }
        return box;
      }
      inner.append(buyRow(`${sub.name} feat`, 'Needed before this subclass’s spells.', hasFeat, RULES.costFeat,
        () => { b.feat[sub.id] = true; changed(); render(); },
        () => { delete b.feat[sub.id]; delete b.tiers[sub.id]; changed(); render(); }));
      if (tierList.length) {
        const free = tiers.length % 3 ? 3 - (tiers.length % 3) : 0;
        inner.append(el('div', { class: 'cc-tiers' }, el('span', { class: 'k' }, 'Spell tiers'),
          ...tierList.map(t => {
            const has = tiers.includes(t);
            const delta = has ? 0 : RULES.tierCost(tiers.length + 1) - RULES.tierCost(tiers.length);
            const ok = has || (hasFeat && can(delta));
            return el('label', { class: 'cc-tier' + (ok ? '' : ' off') + (has ? ' on' : ''), title: !hasFeat ? 'Buy the feat first' : !ok ? `Needs ${delta} SP left` : '' },
              el('input', { type: 'checkbox', checked: has, disabled: !ok, onchange: e => {
                let arr = (b.tiers[sub.id] || []).filter(x => x !== t);
                if (e.target.checked) arr.push(t);
                arr.sort((x, y) => x - y);
                if (arr.length) b.tiers[sub.id] = arr; else delete b.tiers[sub.id];
                changed(); render();
              } }), `Tier ${t}`);
          }),
          el('span', { class: 'hint' }, `2 SP for any three tiers${tiers.length ? ` · ${RULES.tierCost(tiers.length)} SP spent here` : ''}${free && tiers.length ? ` · ${free} more tier${free === 1 ? '' : 's'} included` : ''}`)));
      }
      return box;
    }

    // the shared item catalogue (from the Market Price Ledger), loaded the first time the inventory is shown
    let catalogue = null, catLoading = false;
    const NOT_CARRIED = new Set(['services', 'hire', 'craft', 'temple', 'arcane', 'info', 'leisure']);
    function catalogueItems() {
      if (!catalogue && !catLoading) {
        catLoading = true;
        fetch('content/items.json').then(r => r.json()).then(j => { catalogue = j; if (state.tab === 'chars') render(); }).catch(() => {});
      }
      return catalogue ? catalogue.items.filter(i => !NOT_CARRIED.has(i.cat)) : [];
    }
    function inventorySection(c) {
      const items = c.items;
      const touch = () => changed();
      const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; changed(); render(); };
      const rows = items.map((it, i) => el('div', { class: 'cc-inv-row' + (it.on ? ' on' : '') },
        el('label', { class: 'cc-inv-eq', title: 'Equipped' }, el('input', { type: 'checkbox', checked: it.on, 'aria-label': `${it.name || 'Item'} equipped`, onchange: e => { it.on = e.target.checked; changed(); render(); } }), el('span', {}, 'Equipped')),
        el('input', { type: 'text', class: 'cc-inv-name', value: it.name, maxlength: '120', 'aria-label': 'Item', placeholder: 'Item', oninput: e => { it.name = e.target.value; touch(); } }),
        el('input', { type: 'number', class: 'num cc-inv-qty', min: '0', value: String(it.qty), 'aria-label': 'Quantity', title: 'Quantity', onchange: e => { it.qty = Math.max(0, num(e.target.value)); changed(); render(); } }),
        el('input', { type: 'text', class: 'cc-inv-notes', value: it.notes, maxlength: '300', 'aria-label': 'Notes', placeholder: 'Notes, e.g. 1d20, two-handed', oninput: e => { it.notes = e.target.value; touch(); } }),
        el('span', { class: 'cc-inv-btns' },
          el('button', { class: 'mini', disabled: i === 0, 'aria-label': `Move ${it.name || 'item'} up`, onclick: () => move(i, -1) }, '↑'),
          el('button', { class: 'mini', disabled: i === items.length - 1, 'aria-label': `Move ${it.name || 'item'} down`, onclick: () => move(i, 1) }, '↓'),
          el('button', { class: 'mini danger', 'aria-label': `Remove ${it.name || 'item'}`, onclick: () => { items.splice(i, 1); changed(); render(); } }, 'Remove'))));
      const known = catalogueItems();
      const name = el('input', { type: 'text', id: 'cc-inv-add', list: 'cc-catalogue', maxlength: '120', placeholder: 'Add an item: type to search the item list, or write your own', 'aria-label': 'New item',
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
      const qty = el('input', { type: 'number', class: 'num', min: '1', value: '1', 'aria-label': 'Quantity', title: 'Quantity',
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
      function add() {
        const n = name.value.trim(); if (!n) { name.focus(); return; }
        const ref = known.find(k => k.name.toLowerCase() === n.toLowerCase());
        items.push({ id: itemId(), name: ref ? ref.name : n, qty: Math.max(1, num(qty.value, 1)), notes: '', on: false, ...(ref ? { ref: ref.id } : {}) });
        changed(); render();
        requestAnimationFrame(() => { const f = $('#cc-inv-add'); if (f) f.focus(); });
      }
      const eq = items.filter(x => x.on).length;
      return [
        el('p', { class: 'd-note' }, items.length ? `${items.length} item${items.length === 1 ? '' : 's'}${eq ? ` · ${eq} equipped` : ''}. Tick Equipped for what you’re wearing or holding; it’s listed first on the sheet.` : 'Add your starting gear (from your subclass) and anything else you carry.'),
        rows.length ? el('div', { class: 'cc-inv' }, ...rows) : null,
        el('div', { class: 'cc-inv-add' }, name, qty, el('button', { class: 'btn small', onclick: add }, 'Add item')),
        known.length ? el('datalist', { id: 'cc-catalogue' }, ...known.map(k => el('option', { value: k.name }))) : null,
      ];
    }

    function notesSection() {
      return el('div', { class: 'cc-grid' },
        el('div', { class: 'cc-wide' }, field('Notes', area('notes', 4, 'Personality, goals, allies, anything else'))),
        field('Extra HP', el('input', { type: 'number', class: 'num', value: String(num(cur.data.hpAdjust)), onchange: e => set('hpAdjust', num(e.target.value)) }), 'Anything else that changes your max HP (level-up hit dice are under Level-ups)'));
    }

    /* ================= sheet (shared by page, PDF and Word) ================= */
    function sheetData(c) {
      const d = derived(c);
      const out = { title: c.name || 'Unnamed character', subtitle: summaryOf(c), blocks: [] };
      const row = keys => d.stats.filter(s => keys.includes(s.k)).map(s => [s.k, s.final == null ? '—' : String(s.final)]);
      const st = row(BASE_STATS), cs = row(COMBAT_STATS);
      out.blocks.push({ h: 'Stats', table: [['Stat', ...st.map(s => s[0])], ['Score', ...st.map(s => s[1])]] });
      out.blocks.push({ h: 'Combat stats', table: [['Stat', ...cs.map(s => s[0])], ['Score', ...cs.map(s => s[1])]], note: 'Roll-under: lower is better.' });
      const live = d.slots.filter(x => x.cls);
      const weapons = [...new Set(live.flatMap(x => (x.cls.meta.weapons || '').split(/,\s*/)).filter(Boolean))].join(', ');
      const vitals = [['HP', String(d.hp)], ['Hit die', bestDie(d) || '—'], ['Defence', (d.cls && d.cls.meta.defence) || '—'],
        ['Weapons', weapons || '—'], ['Languages', [d.r && d.r.meta.languages, d.r2 && d.r2.meta.languages].filter(Boolean).join(', ') || '—'],
        ['Renown', String(d.R)], ['SP', `${d.spent} spent of ${d.total}`], ...(d.fp ? [['FP', String(d.fp)]] : [])];
      if (c.age) vitals.splice(0, 0, ['Age', c.age]);
      out.blocks.push({ h: 'At a glance', pairs: vitals });
      if (c.background) out.blocks.push({ h: 'Background', text: c.background });
      if (d.r) {
        const t1 = raceTraits(d.r), t2 = d.r2 ? raceTraits(d.r2) : null;
        const traits = t2 ? [t1.traits[0], t2.traits[1] || t2.traits[0]].filter(Boolean) : t1.traits;
        const feats = t2 ? [t1.feats.find(f => f.n === 3), t2.feats.find(f => f.n === 4)].filter(Boolean) : t1.feats;
        out.blocks.push({ h: `Race: ${d.r2 ? d.r.name + ' / ' + d.r2.name : d.r.name}`, items: [
          ...traits.map(t => ({ name: t.name, text: plain(t.text) })),
          ...feats.map(f => ({ name: `Feat ${f.n}: ${f.name} (locked)`, text: 'Unlocked in play.' }))] });
      }
      for (const slot of live) {
        const items = [];
        if (slot.cls.meta.trait) {
          const tr = (slot.cls.body.split(/\n### /).slice(1).find(p => p.startsWith(slot.cls.meta.trait)) || '').split('\n').slice(1).join(' ');
          items.push({ name: `Class trait: ${slot.cls.meta.trait}`, text: plain(tr) });
        }
        if (slot.g && c.buys.general[slot.g.key]) items.push({ name: `${slot.g.title}: class-wide benefits`, text: plain(slot.g.intro || '') });
        if (slot.g) for (const sub of slot.g.items) {
          if (slot.magic && c.buys.feat[sub.id]) items.push({ name: `${sub.name} (subclass feat)`, text: abilities(sub).map(a => `${a.name}. ${plain(a.text)}`).join(' ') || plain(sub.body) });
          for (const a of abilities(sub)) if ((c.buys.abil[sub.id] || []).includes(a.key)) items.push({ name: `${a.name} (${sub.name})`, text: plain(a.text) });
        }
        out.blocks.push({ h: `${slot.i ? 'Extra class' : 'Class'}: ${slot.label}`, items });
        if (!slot.g) continue;
        const spellGroups = [];
        if (c.buys.general[slot.g.key] && slot.g.spellsTag) {
          const ss = spellsWith(slot.g.spellsTag);
          if (ss.length) spellGroups.push({ name: `${slot.g.title} spells`, spells: ss });
        }
        for (const sub of slot.g.items) {
          const tiers = c.buys.tiers[sub.id] || [];
          if (!tiers.length) continue;
          spellGroups.push({ name: `${sub.name} spells (tier ${tiers.join(', ')})`, spells: spellsWith(sub.spellsTag).filter(s => tiers.includes(s.tier)) });
        }
        for (const sg of spellGroups) out.blocks.push({ h: sg.name, spells: sg.spells.sort((a, b) => a.tier - b.tier) });
      }
      const feats = d.featSlots.map(sl => featList().find(f => f.name === c.lv.feats[sl.key])).filter(Boolean);
      if (feats.length) out.blocks.push({ h: 'Feats', items: feats.map(f => ({ name: `${f.name} (Tier ${romanOf(f.tier)})`, text: f.effect })) });
      const sk = Object.entries(c.lv.skills).filter(([, r]) => num(r) > 0).sort((a, b) => num(b[1]) - num(a[1]) || a[0].localeCompare(b[0]));
      if (sk.length) out.blocks.push({ h: 'Soft skills', pairs: sk.map(([n, r]) => [n, `${RANKS[num(r)]} (+${2 * num(r)})`]) });
      const BOON = { combat: 'Improved a combat stat', skills2: 'Gained 2 soft skill ranks', retrain: 'Retrained', pastMaster: 'Gained a rank past Master', tier4: 'Took a Tier IV feat', combat2: 'Improved two combat stats', tier5: 'Took a Tier V feat', mark: 'Claimed a Mythic Mark' };
      const bl = d.boons.filter(b => b.type);
      if (bl.length) out.blocks.push({ h: 'Milestone boons', items: bl.map(b => ({ name: `Level ${b.lvl}`, text: `${BOON[b.type]}${b.stat ? ': ' + [b.stat, b.stat2].filter(Boolean).join(', ') : ''}${b.note ? ' (' + b.note + ')' : ''}.` })) });
      if (d.dSel.length || d.qSel.length) out.blocks.push({ h: 'Drawbacks and quirks', items: [
        ...d.dSel.map(x => ({ name: `${x.name} (drawback, ${x.sp} SP back)`, text: plain(x.text) })),
        ...d.qSel.map(x => ({ name: `${x.name} (quirk)`, text: `${x.gain}; ${x.cost}` }))] });
      const inv = c.items.filter(x => x.name.trim());
      if (inv.length) {
        const sorted = [...inv.filter(x => x.on), ...inv.filter(x => !x.on)];
        out.blocks.push({ h: 'Inventory', grid: [['Item', 'Qty', 'Notes'], ...sorted.map(x => [x.name.trim() + (x.on ? ' (equipped)' : ''), String(x.qty), x.notes.trim()])] });
      }
      if (c.gear) out.blocks.push({ h: 'Starting gear', text: c.gear });
      if (c.equipment) out.blocks.push({ h: 'Equipment', text: c.equipment });
      if (c.notes) out.blocks.push({ h: 'Notes', text: c.notes });
      return out;
    }

    function sheetHTML(data) {
      const kids = [el('header', { class: 'sh-head' }, el('h1', {}, data.title), el('p', {}, data.subtitle))];
      for (const b of data.blocks) {
        const sec = el('section', { class: 'sh-block' + (b.table ? ' sh-stats' : '') }, el('h2', {}, b.h));
        if (b.table) sec.append(el('div', { class: 'sh-statrow', style: `grid-template-columns: repeat(${b.table[0].length - 1}, 1fr)` }, ...b.table[0].slice(1).map((k, i) => el('div', { class: 'sh-stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, b.table[1][i + 1])))), b.note ? el('p', { class: 'sh-note' }, b.note) : '');
        if (b.grid) sec.append(el('table', { class: 'sh-table' }, el('thead', {}, el('tr', {}, ...b.grid[0].map(t => el('th', {}, t)))),
          el('tbody', {}, ...b.grid.slice(1).map(r => el('tr', {}, ...r.map(t => el('td', {}, t)))))));
        if (b.pairs) sec.append(el('dl', { class: 'sh-pairs' }, ...b.pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
        if (b.text) sec.append(...b.text.split(/\n+/).map(t => el('p', {}, t)));
        if (b.items) sec.append(...b.items.map(it => el('p', { class: 'sh-item' }, el('strong', {}, it.name + '. '), it.text)));
        if (b.spells) sec.append(...b.spells.map(s => el('p', { class: 'sh-item' }, el('strong', {}, s.name), ` (T${s.tier}${s.dice ? ', ' + s.dice : ''}). `, plain(s.desc))));
        kids.push(sec);
      }
      return el('article', { class: 'sheet' }, ...kids);
    }
    const sheet = c => sheetHTML(sheetData(c));

    /* ---- PDF: print just the sheet ---- */
    function printSheet(c) {
      let root = $('#print-root');
      if (!root) { root = el('div', { id: 'print-root' }); document.body.append(root); }
      root.replaceChildren(sheet(c));
      const title = document.title;
      document.title = (c.name || 'Character').replace(/[^\w\- ]+/g, '') + ' – character sheet';
      document.body.classList.add('printing');
      const done = () => { document.body.classList.remove('printing'); document.title = title; window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
    }

    /* ---- Word: a real .docx, zipped here (no library needed) ---- */
    const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const run = (t, o = {}) => `<w:r>${o.b || o.i || o.color || o.sz ? `<w:rPr>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.sz ? `<w:sz w:val="${o.sz}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
    const para = (runs, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`;
    function docxBody(data) {
      const out = [para(run(data.title), 'Title'), para(run(data.subtitle), 'Subtitle')];
      const cell = (t, o = {}) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(run(t, { b: o.b }))}</w:tc>`;
      const table = rows => `<w:tbl><w:tblPr><w:tblStyle w:val="SheetTable"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${rows.join('')}</w:tbl>${para('')}`;
      for (const b of data.blocks) {
        out.push(para(run(b.h), 'Heading1'));
        if (b.table) out.push(table(b.table.map((r, i) => `<w:tr>${r.map((t, j) => cell(t, { b: i === 0 || j === 0 })).join('')}</w:tr>`)));
        if (b.note) out.push(para(run(b.note, { i: true })));
        if (b.grid) out.push(table(b.grid.map((r, i) => `<w:tr>${r.map(t => cell(t, { b: i === 0 })).join('')}</w:tr>`)));
        if (b.pairs) out.push(table(b.pairs.map(([k, v]) => `<w:tr>${cell(k, { b: true })}${cell(v)}</w:tr>`)));
        if (b.text) for (const t of b.text.split(/\n+/)) out.push(para(run(t)));
        if (b.items) for (const it of b.items) out.push(para(run(it.name + '. ', { b: true }) + run(it.text)));
        if (b.spells) for (const s of b.spells) out.push(para(run(s.name, { b: true }) + run(` (T${s.tier}${s.dice ? ', ' + s.dice : ''}). `) + run(plain(s.desc))));
      }
      return out.join('');
    }
    function docxFiles(data) {
      const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
      return {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(data.title)}</dc:title><dc:subject>Character sheet</dc:subject></cp:coreProperties>`,
        'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
          + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
          + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>`
          + `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr></w:style>`
          + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>`
          + `<w:style w:type="table" w:styleId="SheetTable"><w:name w:val="Sheet Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:color="808080"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`,
        'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${docxBody(data)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
      };
    }
    const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    function zip(files) {   // store-only zip
      const enc = new TextEncoder(), parts = [], central = [];
      let offset = 0;
      const now = new Date();
      const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      for (const [name, text] of Object.entries(files)) {
        const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
        h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
        h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), nameB, data);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
        c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
        c.setUint16(28, nameB.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), nameB);
        offset += 30 + nameB.length + data.length;
      }
      const cdSize = central.reduce((a, x) => a + x.length, 0);
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true);
      e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
      return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
    function downloadDocx(c) {
      const data = sheetData(c);
      const blob = zip(docxFiles(data));
      const a = el('a', { href: URL.createObjectURL(blob), download: `${(c.name || 'Character').replace(/[^\w\- ]+/g, '').trim() || 'Character'} - character sheet.docx` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }

    return {
      init, renderList, renderDetail,
      _test: { sheetData, docxFiles, derived, blank, normalize, featList, skillList, RULES, abilities, traitLists, current: () => cur },
    };
  };
})();
