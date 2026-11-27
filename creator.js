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
      const md = tableRows(find('Mythic Drawbacks') && find('Mythic Drawbacks').body).slice(1)
        .map(r => ({ name: r[0], needs: r[1] || '', sp: num((r[2] || '').match(/\d+/)), text: r[3] || '', mythic: true }));
      const mk = tableRows(find('Marks') && find('Marks').body).filter(r => r[0] && r[0] !== 'Mark' && r.length >= 3)
        .map(r => ({ name: r[0], earned: r[1] || '', text: r[2] || '' }));
      const mm = tableRows(find('Mythic Marks') && find('Mythic Marks').body).filter(r => r[0] && r[0] !== 'Mark' && r.length >= 4)
        .map(r => ({ name: r[0], needs: r[1] || '', earned: r[2] || '', text: r[3] || '', mythic: true }));
      traitCache = { drawbacks: dr, quirks: qu, mythicDrawbacks: md, marks: mk, mythicMarks: mm };
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
      attacks: [], armour: { name: '', defence: 0, minHit: 0 },
      lv: { stat: {}, hd: {}, skills: {}, feats: {}, boons: {}, fp: 0 },
      items: [], gear: '', equipment: '', notes: '',
      guide: { step: 0, seen: 0, done: false },
    });

    let list = null, profiles = [], listError = '', listing = null;
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
      } else c.items = src.items.map(x => ({ id: x.id || itemId(), name: String(x.name || ''), qty: Math.max(0, num(x.qty, 1)), notes: String(x.notes || ''), on: !!x.on, ...(x.ref ? { ref: String(x.ref) } : {}),
        ...(x.g ? { g: cleanGear(x.g) } : {}), ...(x.gc ? { gc: true } : {}), ...(x.q && QUALS.includes(x.q) && x.q !== 'Normal' ? { q: x.q } : {}), ...(x.m ? { m: String(x.m).slice(0, 60) } : {}) })).map(x => { if (x.g === null) delete x.g; if (x.gc && !x.g && !x.ref) delete x.gc; return x; });
      c.guide = src.guide && typeof src.guide === 'object' ? { step: Math.max(0, num(src.guide.step)), seen: Math.max(0, num(src.guide.seen), num(src.guide.step)), done: !!src.guide.done } : { step: 0, done: Object.keys(src).length > 0 };
      // attacks (weapon or spell, the stat it hits with, its damage dice) and worn armour
      c.attacks = (Array.isArray(src.attacks) ? src.attacks : []).slice(0, 30).map(a => ({ id: a.id || itemId(), name: String(a.name || '').slice(0, 80),
        stat: ['Melee', 'Ranged', 'Casting'].includes(a.stat) ? a.stat : 'Melee', dice: String(a.dice || '').slice(0, 30), notes: String(a.notes || '').slice(0, 200) }));
      const ar = src.armour && typeof src.armour === 'object' ? src.armour : {};
      const arDef = Math.max(0, Math.min(20, num(ar.defence))), arMin = Math.max(0, Math.min(50, num(ar.minHit)));
      // the old typed-in armour box becomes an equipped item, so it counts the same way as everything else
      if (String(ar.name || '').trim() || arDef || arMin)
        c.items.push({ id: itemId(), name: String(ar.name || '').trim().slice(0, 80) || 'Armour', qty: 1, notes: '', on: true, g: { kind: 'armour', slot: 'body', def: arDef, minHit: arMin, thp: 0 }, gc: true });
      c.armour = { name: '', defence: 0, minHit: 0 };
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

    /* ---------- from the DM: feats, soft skills, traits, Marks and anything else the DM gives a character ----------
       Kept apart from the character (table character_grants: only the DM writes it, the owner reads it), so a player
       can't change or remove them, and a sheet open for editing can't overwrite them. */
    const GRANTS = new Map();          // character id → grants (null while loading)
    const grantOf = new WeakMap();     // character data → its grants
    let grantsMissing = false;
    const gid = () => Math.random().toString(36).slice(2, 9);
    function cleanGrants(g) {
      g = g && typeof g === 'object' ? g : {};
      const arr = (x, f) => (Array.isArray(x) ? x : []).map(f).filter(Boolean).slice(0, 60);
      const str = (v, n) => String(v || '').slice(0, n);
      return {
        feats: arr(g.feats, x => x && x.name ? { id: str(x.id, 12) || gid(), name: str(x.name, 120), ...(x.text ? { text: str(x.text, 600) } : {}) } : null),
        featPicks: arr(g.featPicks, x => x && x.tier ? { id: str(x.id, 12) || gid(), tier: Math.max(1, Math.min(5, num(x.tier))) } : null),
        skills: arr(g.skills, x => x && x.name && num(x.ranks) ? { id: str(x.id, 12) || gid(), name: str(x.name, 80), ranks: Math.max(1, Math.min(5, num(x.ranks))) } : null),
        skillPicks: Math.max(0, Math.min(20, num(g.skillPicks))),
        drawbacks: arr(g.drawbacks, x => x && x.name ? { id: str(x.id, 12) || gid(), name: str(x.name, 120), ...(x.sp ? { sp: true } : {}), ...(x.note ? { note: str(x.note, 200) } : {}) } : null),
        quirks: arr(g.quirks, x => x && x.name ? { id: str(x.id, 12) || gid(), name: str(x.name, 120) } : null),
        marks: arr(g.marks, x => x && x.name ? { id: str(x.id, 12) || gid(), name: str(x.name, 120), ...(x.deed ? { deed: str(x.deed, 300) } : {}), ...(x.text ? { text: str(x.text, 600) } : {}), ...(x.at ? { at: str(x.at, 30) } : {}) } : null),
        other: arr(g.other, x => x && x.name ? { id: str(x.id, 12) || gid(), name: str(x.name, 120), ...(x.text ? { text: str(x.text, 1000) } : {}) } : null),
        sp: Math.max(-50, Math.min(50, num(g.sp))),
        // weapons and armour the DM makes up, the DM's own numbers for the player's items, and extra armour values
        gear: arr(g.gear, x => x && x.name && (x.kind === 'weapon' || x.kind === 'armour') ? { id: str(x.id, 12) || gid(), name: str(x.name, 120), ...dmGearNums(x) } : null),
        tweaks: Object.fromEntries(Object.entries(g.tweaks && typeof g.tweaks === 'object' ? g.tweaks : {}).slice(0, 60)
          .map(([k, x]) => [str(k, 16), x && typeof x === 'object' ? dmTweakNums(x) : null]).filter(([k, x]) => k && x && Object.keys(x).length)),
        arm: { def: clampN(g.arm && g.arm.def, -20, 50), minHit: clampN(g.arm && g.arm.minHit, -50, 100), thp: clampN(g.arm && g.arm.thp, -500, 500) },
      };
    }
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(num(v))));
    const dmDice = v => String(v == null ? '' : v).replace(/\s/g, '').slice(0, 30);
    function dmGearNums(x) {
      const notes = x.notes ? { notes: String(x.notes).slice(0, 200) } : {};
      if (x.kind === 'weapon') return { kind: 'weapon', dice: dmDice(x.dice), stat: ['Melee', 'Ranged', 'Casting'].includes(x.stat) ? x.stat : 'Melee', hands: num(x.hands) === 2 ? 2 : 1, ...notes };
      return { kind: 'armour', slot: SLOT_LABEL[x.slot] && x.slot !== 'mount' ? x.slot : 'body', def: clampN(x.def, 0, 50), minHit: clampN(x.minHit, 0, 100), thp: clampN(x.thp, 0, 500), ...notes };
    }
    // only what the DM set; anything left blank keeps the item's own number
    function dmTweakNums(x) {
      const o = {}, has = v => v != null && v !== '';
      if (has(x.dice)) o.dice = dmDice(x.dice);
      if (['Melee', 'Ranged', 'Casting'].includes(x.stat)) o.stat = x.stat;
      if (has(x.def)) o.def = clampN(x.def, 0, 50);
      if (has(x.minHit)) o.minHit = clampN(x.minHit, 0, 100);
      if (has(x.thp)) o.thp = clampN(x.thp, 0, 500);
      if (x.notes) o.notes = String(x.notes).slice(0, 200);
      return o;
    }
    const grantsFor = c => grantOf.get(c) || cleanGrants({});
    const hasGrants = G => !!(G.feats.length || G.featPicks.length || G.skills.length || G.skillPicks || G.drawbacks.length || G.quirks.length || G.marks.length || G.other.length || G.sp
      || G.gear.length || Object.keys(G.tweaks).length || G.arm.def || G.arm.minHit || G.arm.thp);
    async function loadGrants(id) {
      if (!id || !sb() || GRANTS.has(id)) return;
      GRANTS.set(id, null);
      const r = await sb().from('character_grants').select('data').eq('character_id', id).maybeSingle();
      if (r.error && /does not exist|schema cache|relation/i.test(String(r.error.message))) grantsMissing = true;
      GRANTS.set(id, cleanGrants(r.error ? {} : r.data && r.data.data));
      render();
    }
    let grantMsg = '';
    async function saveGrants(id, G) {
      const g = cleanGrants(G);
      const r = await sb().from('character_grants').upsert({ character_id: id, data: g, updated_at: new Date().toISOString() });
      if (r.error) { grantMsg = /does not exist|schema cache|relation/i.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to switch this on.' : friendly(r.error); render(); return false; }
      GRANTS.set(id, g); grantMsg = 'Saved. The player sees it on their sheet.';
      if (cur && cur.id === id) grantOf.set(cur.data, g);
      render();
      return true;
    }

    function derived(c) {
      const r = raceOf(c), r2 = race2Of(c), slots = slotsOf(c), cls = slots[0].cls, g = slots[0].g;
      const GR = grantsFor(c);
      const { drawbacks, quirks, mythicDrawbacks } = traitLists();
      const allDraw = [...drawbacks, ...mythicDrawbacks];
      const dSel = drawbacks.filter(d => c.drawbacks.includes(d.name));
      const dGiven = GR.drawbacks.map(x => ({ ...(allDraw.find(d => d.name === x.name) || { name: x.name, sp: 0, text: '' }), given: true, spBack: !!x.sp, note: x.note || '' }));
      const qSel = [...quirks.filter(q => c.quirks.includes(q.name)), ...GR.quirks.map(x => quirks.find(q => q.name === x.name)).filter(Boolean).map(q => ({ ...q, given: true }))];
      // chosen drawbacks give back at most 3 SP; ones the DM gives only when the DM ticks it (Advancement: Drawbacks)
      const refund = Math.min(RULES.maxDrawbackSP, dSel.reduce((a, d) => a + d.sp, 0)) + dGiven.filter(d => d.spBack).reduce((a, d) => a + num(d.sp), 0);
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
      const total = earned - fp + refund + num(c.spAdjust) + GR.sp;
      const skillRanks = G.ranks + 2 * boons.filter(b => b.type === 'skills2').length + boons.filter(b => b.type === 'pastMaster').length + GR.skillPicks;
      const pastMaster = boons.filter(b => b.type === 'pastMaster').length;
      const skillsUsed = Object.values(lv.skills).reduce((a, x) => a + num(x), 0);
      const pastUsed = Object.values(lv.skills).reduce((a, x) => a + Math.max(0, num(x) - 3), 0);
      const featSlots = [
        ...G.feats.map(n => ({ key: 'L' + n, lvl: n, max: 3, label: `Level ${n}` })),
        ...boons.filter(b => b.type === 'tier4' || b.type === 'tier5').map(b => ({ key: 'B' + b.lvl, lvl: b.lvl, max: b.type === 'tier4' ? 4 : 5, min: b.type === 'tier4' ? 4 : 5, label: `Level ${b.lvl} milestone` })),
        // an extra feat the DM gave, for the player to choose (any tier up to the one given; Renown doesn't hold it back)
        ...GR.featPicks.map(x => ({ key: 'G' + x.id, lvl: L, max: x.tier, label: `From the DM (up to Tier ${romanOf(x.tier)})`, dm: true })),
      ];
      const hdRolled = G.hd.reduce((a, n) => a + num(lv.hd[n]), 0);
      const b = c.buys;
      const liveKeys = slots.map(x => x.groupKey).filter(Boolean);
      const spent = Math.max(0, c.classes.length - 1) * RULES.costClass
        + liveKeys.filter(k => b.general[k]).length * RULES.costGeneral
        + Object.values(b.abil).reduce((a, x) => a + x.length * RULES.costAbility, 0)
        + Object.values(b.feat).filter(Boolean).length * RULES.costFeat
        + Object.values(b.tiers).reduce((a, x) => a + (x.length ? RULES.tierCost(x.length) : 0), 0);
      // every class adds its class HP, extra classes included (Advancement: Extra classes)
      const hpRace = num(r && r.meta.hp), hpClass = slots.reduce((a, x) => a + (x.cls ? num(x.cls.meta.hp) : 0), 0);
      const hpRolled = liveKeys.reduce((a, k) => a + (c.hpRolls[k] || []).reduce((x, y) => x + y, 0), 0);
      // Defence: the best class Defence plus worn armour's; Min hit comes from the armour (Core rules: Attacks and armour)
      const classDefence = slots.reduce((a, x) => Math.max(a, x.cls ? num(String(x.cls.meta.defence || '').replace('+', '')) : 0), 0);
      const gear = gearSummary(c, slots, GR);
      const defence = classDefence + gear.def, minHit = gear.minHit;
      return {
        classDefence, defence, minHit, gear, armourThp: gear.thp, attacks: [...gear.attacks, ...c.attacks.filter(a => a.name.trim() || a.dice.trim())],
        r, r2, cls, g, slots, magic: isMagic(g), dSel, qSel, refund, stats, earned, total, spent, left: total - spent,
        hp: hpRace + hpClass + hpRolled + hdRolled + num(c.hpAdjust), hpRace, hpClass, hpRolled, hdRolled,
        L, R, G, boons, fp, skillRanks, skillsUsed, pastMaster, pastUsed, featSlots,
        grants: GR, dGiven,
        dmFeats: GR.feats.map(x => ({ ...(featList().find(f => f.name === x.name) || { name: x.name, tier: 0, effect: x.text || '' }), given: true, gid: x.id })),
        dmSkills: GR.skills.reduce((o, x) => { o[x.name] = (o[x.name] || 0) + x.ranks; return o; }, {}),
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

    // One load at a time: a second call while one is running waits for that one, rather than returning straight
    // away (which let the list page re-render in a tight loop until the page froze).
    function refreshList() {
      if (!sb() || !user()) return Promise.resolve();
      if (!listing) listing = loadList().finally(() => { listing = null; });
      return listing;
    }
    async function loadList() {
      try {
        const [c, p] = await Promise.all([
          sb().from('characters').select('id, owner_id, campaign_id, name, summary, data, updated_at').order('updated_at', { ascending: false }),
          sb().from('profiles').select('id, display_name, is_admin').order('display_name', { ascending: true }),
        ]);
        if (c.error) throw c.error;
        list = c.data || []; profiles = (p && p.data) || []; listError = '';
      } catch (e) {
        listError = Notes.friendly(e);
        if (/characters/.test(listError) && /exist|find|schema/i.test(listError)) listError = 'Run the latest supabase/setup.sql first (it adds saved characters).';
      }
    }

    function init() {
      // a shop (table.js) changed a character's inventory: reload it, unless there are unsaved changes here
      if (typeof window !== 'undefined') window.addEventListener('hb-character-changed', async e => {
        const id = e && e.detail && e.detail.id;
        if (!id || !user()) return;
        await refreshList();
        if (cur && cur.id === id && !cur.dirty) { cur = null; ensureCurrent(); }
        if (state.tab === 'chars' || state.tab === 'all') render();
      });
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
      if (row) cur = { id: row.id, owner_id: row.owner_id, campaign_id: row.campaign_id || null, data: normalize(row.data), dirty: false, readOnly: !!(user() && row.owner_id !== user().id) };
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
    let mode = 'edit';                 // 'sheet' (read), 'edit' (every section), 'guide' (new-character steps) or 'play' (live sheet at the table)
    let drawer = false, showAdjust = false;
    const openSubs = new Set();        // subclasses expanded under Subclass points
    let wantPlay = '';                 // set by openPlay: the next time this character opens, open it in play mode
    function enterMode() {
      lvlup = null; drawer = false; confirmDel = false; msg = '';
      mode = !cur ? 'edit' : cur.readOnly || cur.id ? 'sheet' : cur.data.guide.done ? 'edit' : 'guide';
      if (cur && cur.id && wantPlay === cur.id) { mode = 'play'; wantPlay = ''; }
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
      'Subclass points': spSection, 'Attacks and armour': attacksSection, 'Inventory': inventorySection, 'Notes': notesSection, 'From the DM': dmSection,
    };
    const editSections = d => Object.keys(SECTION_FNS).filter(t => !(d.L === 0 && (t === 'Soft skills' || t === 'Feats') && !d.skillsUsed && !d.featSlots.length && !d.dmFeats.length && !Object.keys(d.dmSkills).length)
      && (t !== 'From the DM' || hasGrants(d.grants) || (admin() && cur && cur.id)));
    function guideSteps(c, d) {
      const s = [
        { title: 'Basics', secs: ['Basics'], intro: 'Start with a name. Most characters start at level 0; set a higher level only if your DM is starting you further along.' },
        { title: 'Race', secs: ['Race'], intro: 'Your race gives you HP, I.M.P., languages and traits.' },
        { title: 'Class', secs: ['Class'], intro: 'Your starting class sets your hit die, weapons and class trait. You can add more classes later for 1 SP each.' },
        { title: 'Stats', secs: ['Stats'], intro: 'Roll your stats and combat stats the way your DM has set for the campaign, or type in what you rolled at the table.' },
        { title: 'Drawbacks and quirks', secs: ['Drawbacks and quirks'], intro: 'Optional. Drawbacks give you SP back; quirks trade one stat for another.' },
      ];
      if (d.L > 0) s.push({ title: 'Level-ups', secs: ['Level-ups', 'Soft skills', 'Feats'], intro: `Choose what each level up to ${d.L} gave you.` });
      s.push({ title: 'Subclass points', secs: ['Subclass points'], intro: 'Spend SP on your class’s benefits, abilities and spells. Class-wide benefits come first.' },
        { title: 'Gear', secs: ['Attacks and armour', 'Inventory', 'Notes'], intro: 'Add your attacks and armour, your starting gear (your subclass page lists the options) and anything else you carry.' });
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

    const canPlay = () => !!(H.Play && cur && cur.id);
    function modeBar(c, d) {
      const segBtn = (m, label) => el('button', { class: 'cc-seg-b', role: 'tab', 'aria-selected': String(mode === m), onclick: () => { if (mode !== m) { mode = m; render(); toTop(); } } }, label);
      if (cur.readOnly) return el('div', { class: 'cc-modebar' },
        canPlay() ? el('div', { class: 'cc-seg', role: 'tablist', 'aria-label': 'View' }, segBtn('sheet', 'Sheet'), segBtn('play', 'Play')) : null,
        el('button', { class: 'btn small', onclick: () => printSheet(c) }, 'Download PDF'),
        el('button', { class: 'btn small', onclick: () => downloadDocx(c) }, 'Download Word'), admin() ? menu() : null);
      if (mode === 'guide') {
        const n = guideSteps(c, d).length;
        return el('div', { class: 'cc-modebar' },
          el('span', { class: 'cc-guide-tag' }, `New character · step ${Math.min(c.guide.step, n - 1) + 1} of ${n}`),
          el('button', { class: 'mini', onclick: () => { c.guide.done = true; mode = 'edit'; changed(); render(); toTop(); } }, 'Skip to the full editor'),
          menu());
      }
      return el('div', { class: 'cc-modebar' },
        el('div', { class: 'cc-seg', role: 'tablist', 'aria-label': 'View' }, segBtn('sheet', 'Sheet'), segBtn('edit', 'Edit'), canPlay() ? segBtn('play', 'Play') : null),
        lvlup ? null : el('button', { class: 'btn small', onclick: startLevelUp }, `Level up to ${d.L + 1}`),
        menu());
    }

    /* ================= rail (left column) and phone bar ================= */
    function nums(c, d) {
      const ranks = d.skillRanks - d.skillsUsed;
      const n = (k, v, bad, title) => el('div', { class: 'cc-num' + (bad ? ' bad' : ''), title: title || '' }, el('span', { class: 'v' }, String(v)), el('span', { class: 'k' }, k));
      return el('div', { class: 'cc-nums' },
        n('SP left', d.left, d.left < 0, `${d.spent} spent of ${d.total}`), n('Ranks left', ranks, ranks < 0, 'Soft skill ranks'));
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
        nums(c, d),
        cur.readOnly ? null : [el('h3', { class: 'cc-h3' }, T.length ? `To do · ${T.length}` : 'To do'), todoList(T)],
        cur.readOnly || mode === 'sheet' ? null : [el('h3', { class: 'cc-h3' }, mode === 'guide' ? 'Steps' : 'Sections'), navList(c, d, T)],
        mode === 'sheet' ? el('nav', { class: 'cc-nav cc-rail-jump', 'aria-label': 'Parts of the sheet' }) : null,
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
        if (!listError && !listing) refreshList().then(() => { if (list || listError) render(); });
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
      if (cur.readOnly && mode !== 'play') mode = 'sheet';
      if (mode === 'play' && !canPlay()) mode = 'sheet';
      const c = cur.data;
      if (cur.id) { if (!GRANTS.has(cur.id)) loadGrants(cur.id); const G0 = GRANTS.get(cur.id); if (G0) grantOf.set(c, G0); }
      const d = derived(c);
      document.title = `${c.name || 'New character'} · Player’s Handbook`;
      const head = [
        el('button', { class: 'back', onclick: () => go({ char: '' }, true) }, '← All characters'),
        // who they are and the numbers needed at the table, pinned while the sheet scrolls
        el('div', { class: 'cc-head' },
          el('div', { class: 'cc-who' },
            el('span', { class: 'hm-seal cc-seal', 'aria-hidden': 'true' }, (c.name || '?').trim().charAt(0).toUpperCase() || '?'),
            el('div', { class: 'cc-whoname' },
              el('h1', { class: 'd-title' }, c.name || 'New character', ' ', statusChip()),
              el('p', { class: 'cc-subtitle' }, summaryOf(c)))),
          mode === 'guide' ? null : vitals(c, d),
          modeBar(c, d)),
        levelNotice(d),
        inboxNotice(c),
        confirmDel ? el('div', { class: 'notice cc-confirm', role: 'alert' }, el('span', {}, 'Delete this character for good? '),
          el('button', { class: 'btn small danger', onclick: remove }, 'Delete'),
          el('button', { class: 'btn small ghost', onclick: () => { confirmDel = false; render(); } }, 'Keep')) : null,
        msg ? el('p', { class: 'notes-msg' + (msg === 'Saved.' ? ' ok' : ''), role: 'status' }, msg) : null,
      ];
      let body;
      if (mode === 'play') body = [playView(c, d)];
      else if (mode === 'sheet') {
        const sh = sheet(c, d);
        // the DM looking at a player's character: give it feats, skills, traits and Marks from here
        const dm = admin() && cur.id && cur.readOnly ? el('details', { class: 'cc-dmbox', open: dmBoxOpen, ontoggle: e => { dmBoxOpen = e.target.open; } },
          el('summary', {}, 'DM: give this character something', hasGrants(d.grants) ? el('span', { class: 'bs-fine' }, ' · already given: ' + [d.grants.marks.length ? `${d.grants.marks.length} Mark${d.grants.marks.length === 1 ? '' : 's'}` : '', d.grants.feats.length + d.grants.featPicks.length ? `${d.grants.feats.length + d.grants.featPicks.length} feat${d.grants.feats.length + d.grants.featPicks.length === 1 ? '' : 's'}` : '', d.grants.skills.length || d.grants.skillPicks ? 'skill ranks' : '', d.grants.drawbacks.length + d.grants.quirks.length ? 'traits' : '', d.grants.other.length ? 'other' : '', d.grants.sp ? 'SP' : '', d.grants.gear.length || Object.keys(d.grants.tweaks).length || d.grants.arm.def || d.grants.arm.minHit || d.grants.arm.thp ? 'gear' : ''].filter(Boolean).join(', ')) : null),
          dmTools(c, d)) : null;
        body = [dm, jumpBar(sh), el('div', { class: 'cc-sheetview' }, sh), rollRecord(c)];
      }
      else if (mode === 'guide') body = guideView(c, d);
      else body = [levelUpPanel(c, d), ...editSections(d).map(t => section(t, SECTION_FNS[t](c, d)))];
      pane.replaceChildren(...[...head, ...body].flat().filter(Boolean), phoneBar(c, d) || '');
      return true;
    }

    // HP (live from play mode when there is any), temp HP from armour, Defence, Min hit and hit die
    function vitals(c, d) {
      const L = cur && cur.id && H.Play ? H.Play.get(cur.id) : null;
      const max = (L && L.max) || d.hp, hp = L && L.hp != null ? L.hp : max;
      const temp = L && L.temp != null ? L.temp : d.armourThp;
      const v = (k, val, sub) => el('div', { class: 'cc-vital' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, val), sub ? el('span', { class: 'sub' }, sub) : null);
      return el('div', { class: 'cc-vitals' },
        v('Hit points', el('span', {}, String(hp), el('small', {}, ` / ${max}`))),
        temp ? v('Temp HP', String(temp)) : null,
        v('Defence', `+${d.defence | 0}`),
        d.minHit ? v('Min hit', String(d.minHit)) : null,
        bestDie(d) ? v('Hit die', bestDie(d)) : null,
        v('Renown', String(d.R)));
    }

    // a markdown bullet list as sheet lines: "- **Name.** text" keeps its name, plain bullets become bullet lines
    function bulletsOf(md) {
      const out = [];
      for (const line of String(md || '').split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^\s*[-*]\s+(.*)$/);
        if (!m) { if (out.length) out[out.length - 1].text += ' ' + plain(line); else out.push({ name: '', text: plain(line), sub: true }); continue; }
        const nm = m[1].match(/^\*\*([^*]+?)\*\*\s*(.*)$/);
        out.push(nm ? { name: nm[1].replace(/[.:]\s*$/, ''), text: plain(nm[2]), sub: true } : { name: '', text: plain(m[1]), sub: true });
      }
      return out;
    }

    // on screen: a bar to jump to each part of the sheet, and long parts fold away when their heading is tapped
    function jumpBar(sh) {
      const secs = [...sh.querySelectorAll('.sh-block')];
      for (const sec of secs) {
        const h = sec.querySelector('h2'), n = sec.children.length - 1;
        if (n > 4 || sec.querySelectorAll('.sh-item').length > 5) {
          h.setAttribute('role', 'button'); h.setAttribute('tabindex', '0'); h.setAttribute('aria-expanded', 'true'); h.classList.add('sh-fold');
          const flip = () => { const f = sec.classList.toggle('folded'); h.setAttribute('aria-expanded', String(!f)); };
          h.addEventListener('click', flip); h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        }
      }
      if (secs.length < 4) return null;
      const goTo = sec => () => { sec.classList.remove('folded'); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      // on a laptop the same list sits in the left rail (drawn just before this)
      setTimeout(() => { const r = document.querySelector('.cc-rail-jump'); if (r) r.replaceChildren(el('h3', { class: 'cc-h3' }, 'On the sheet'), ...secs.map(sec => el('button', { type: 'button', onclick: goTo(sec) }, el('span', { class: 'mk', 'aria-hidden': 'true' }, '◆'), sec.getAttribute('data-h')))); }, 0);
      return el('nav', { class: 'cc-jump', 'aria-label': 'Parts of the sheet' }, ...secs.map(sec => el('button', { type: 'button', class: 'chip', onclick: goTo(sec) }, sec.getAttribute('data-h'))));
    }

    // how the stats came about: every set rolled, reroll and number typed in (on screen only, not in the downloads)
    function rollRecord(c) {
      const log = Array.isArray(c.rollLog) ? c.rollLog : [];
      if (!log.length) return null;
      const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const HOW = { set: 'rolled a set', 'in order': 'rolled in order', roll: 'rolled', reroll: 'rerolled', typed: 'typed in' };
      const seen = new Set();
      const rerolls = log.filter(x => { if (x.how === 'reroll') return true; if (x.how !== 'set' && x.how !== 'in order') return false; const again = seen.has(x.what); seen.add(x.what); return again; }).length;
      return el('details', { class: 'cc-rolls' },
        el('summary', {}, `Stat rolls: ${log.length} recorded${rerolls ? `, ${rerolls} reroll${rerolls === 1 ? '' : 's'}` : ''}`),
        el('ol', {}, ...log.slice().reverse().map(x => el('li', {}, el('span', { class: 'w' }, when(x.at)), ` ${x.what} ${HOW[x.how] || x.how}: `, el('strong', {}, (x.values || []).join(', '))))));
    }

    // the Play view's quick reference: everything the character can do, searchable, so nobody flips to the sheet mid-fight
    let qrFind = '';
    function quickRef(c) {
      const sd = sheetData(c);
      const groups = [];
      for (const b of sd.blocks) {
        if (b.items && b.items.length && !/^At a glance|^Background|^Milestone|^Drawbacks/.test(b.h)) groups.push({ h: b.h, rows: b.items.filter(it => it.name || it.text).map(it => ({ name: it.name, text: it.text })) });
        if (b.spells && b.spells.length) groups.push({ h: b.h, rows: b.spells.map(sp => ({ name: `${sp.name} (T${sp.tier}${sp.dice ? ', ' + sp.dice : ''})`, text: plain(sp.desc) })) });
      }
      if (!groups.length) return null;
      const q = norm(qrFind.trim());
      const shown = groups.map(g => ({ ...g, rows: q ? g.rows.filter(r => norm(`${r.name} ${r.text}`).includes(q)) : g.rows })).filter(g => g.rows.length);
      const count = groups.reduce((a, g) => a + g.rows.length, 0);
      const input = el('input', { type: 'search', class: 'qr-find', placeholder: 'Find an ability, feat or spell…', value: qrFind, 'aria-label': 'Find an ability, feat or spell',
        oninput: e => { qrFind = e.target.value; clearTimeout(input._t); input._t = setTimeout(() => { render(); const f = document.querySelector('.qr-find'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 150); } });
      return el('section', { class: 'qr' },
        el('h3', { class: 'pl-h' }, 'Abilities, feats and spells', el('span', { class: 'bs-fine' }, ` ${count}`)),
        count > 6 ? input : null,
        ...shown.map(g => el('details', { class: 'qr-g', open: !!q || groups.length === 1 || null },
          el('summary', {}, g.h, el('span', { class: 'n' }, ` ${g.rows.length}`)),
          ...g.rows.map(r => el('p', { class: 'qr-row' }, r.name ? el('strong', {}, r.text ? r.name + '. ' : r.name) : null, r.text)))),
        q && !shown.length ? el('p', { class: 'd-note' }, 'Nothing matches.') : null);
    }

    // things handed over from the party stash wait on the live sheet until the player adds them to their inventory
    function inboxNotice(c) {
      if (!H.Play || !cur || !cur.id || cur.readOnly) return null;
      const live = H.Play.get(cur.id), inbox = live && Array.isArray(live.inbox) ? live.inbox.filter(x => x && x.name) : [];
      if (!inbox.length) return null;
      const take = async () => {
        for (const x of inbox) {
          // things bought in a shop keep their place in the item list (so weapons and armour bring their numbers) and quality
          const L = x.ref && catalogue ? catalogue.items.find(k => k.id === x.ref) : null;
          const g = x.g && x.g.kind ? cleanGear(x.g) : L && L.fight ? cleanGear(L.fight) : null;
          const m = x.m || (x.g && x.g.material) || '';
          c.items.push({ id: itemId(), name: String(x.name).slice(0, 120), qty: Math.max(1, num(x.qty, 1)), notes: String(x.notes || '').slice(0, 200), on: false,
            ...(x.ref ? { ref: String(x.ref) } : {}), ...(g ? { g } : {}), ...(x.g && x.g.kind ? { gc: true } : {}), ...(x.q && QUALS.includes(x.q) && x.q !== 'Normal' ? { q: x.q } : {}), ...(m ? { m: String(m) } : {}) });
        }
        await H.Play.change(cur.id, 0, { inbox: [] });
        changed(); render();
        save();
      };
      return el('div', { class: 'notice cc-inbox', role: 'status' },
        el('span', {}, `From ${[...new Set(inbox.map(x => x.from || 'the party stash'))].join(' and ')}: ${inbox.map(x => `${x.qty > 1 ? x.qty + ' × ' : ''}${x.name}`).join(', ')}.`),
        el('button', { class: 'btn small primary', onclick: take }, 'Add to my inventory'));
    }

    // the DM raises the party's level from the session screen (stored as levelTo on the live sheet); the player takes the levels here
    const playAsked = new Set();
    function levelNotice(d) {
      if (!H.Play || !cur || !cur.id || cur.readOnly || lvlup) return null;
      if (!playAsked.has(cur.id)) { playAsked.add(cur.id); H.Play.load([cur.id]); }
      const live = H.Play.get(cur.id), to = live ? num(live.levelTo) : 0;
      if (!to || to <= d.L) return null;
      const gap = to - d.L;
      return el('div', { class: 'notice cc-lvlnote', role: 'status' },
        el('span', {}, `Your DM has raised the party to level ${to}.${gap > 1 ? ` That’s ${gap} levels to take, one at a time.` : ''}`),
        el('button', { class: 'btn small primary', onclick: startLevelUp }, `Level up to ${d.L + 1}`));
    }

    // the live sheet at the table: HP, statuses, uses (play.js); the player and the DM can both change it
    function playSuggestions(c) {
      const per = t => /once per long rest/i.test(t) ? 'long' : /once per rest/i.test(t) ? 'rest' : /once per day/i.test(t) ? 'day' : /once per session/i.test(t) ? 'session' : /once per arc/i.test(t) ? 'arc' : null;
      const out = [];
      for (const n of Object.values(c.lv.feats || {})) {
        const f = featList().find(x => x.name === n);
        const p = f && per(f.effect);
        if (p) out.push({ name: f.name, per: p, max: 1, text: f.effect });
      }
      // subclass abilities with a count: "three times a combat", "twice per long rest", "once per day"…
      const WORD = { once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      for (const [id, keys] of Object.entries(c.buys.abil || {})) {
        const sub = DB.byId.get(id); if (!sub || !Array.isArray(keys)) continue;
        for (const ab of abilities(sub).filter(x => keys.includes(x.key))) {
          const m = String(ab.text).match(/\b(once|twice|thrice|(one|two|three|four|five|six|\d+) times?)\s+(?:a|per|each)\s+(combat|fight|long rest|short rest|rest|day|session|arc)\b/i);
          if (!m) continue;
          const n = WORD[(m[2] || m[1]).toLowerCase()] || parseInt(m[2] || m[1], 10) || 1;
          const w = m[3].toLowerCase();
          const p = w === 'combat' || w === 'fight' ? 'combat' : w === 'long rest' ? 'long' : w === 'short rest' || w === 'rest' ? 'rest' : w;
          if (!out.some(o => o.name === ab.name)) out.push({ name: ab.name, per: p, max: Math.min(20, n), text: plain(ab.text) });
        }
      }
      return out;
    }
    function playView(c, d) {
      const canEdit = !!(user() && (cur.owner_id === user().id || admin()));
      if (cur.dirty && !cur.readOnly) return el('div', { class: 'notice' }, 'Save your changes first: the live sheet uses the saved character.');
      return el('div', { class: 'cc-play' },
        el('p', { class: 'd-note' }, canEdit ? 'Your character at the table. Changes save at once, and the DM sees them in the combat tracker (and can change them too).' : 'This character’s live sheet. Only its player and the DM can change it.'),
        H.Dice && cur.campaign_id ? H.Dice.fight(cur.campaign_id, cur.id) : null,
        H.Play.sheet({ id: cur.id, name: c.name, maxHp: d.hp, canEdit, suggestions: canEdit ? playSuggestions(c) : [], hitDie: bestDie(d) || '', armourThp: d.armourThp, campaign: cur.campaign_id || null }),
        quickRef(c),
        // the dice: checks against this character's stats, any other roll, and the table's log
        canEdit && H.Dice ? H.Dice.panel({ campaign: cur.campaign_id, charId: cur.id, stats: d.stats.filter(s => s.final != null).map(s => ({ k: s.k, v: s.final })),
          attacks: d.attacks.filter(a => a.name.trim() || diceOk(a.dice)).map(a => { const st = d.stats.find(x => x.k === a.stat); return { name: a.name.trim() || 'Attack', stat: a.stat, need: st && st.final != null ? st.final : null, dice: diceOk(a.dice) ? a.dice.replace(/\s/g, '') : '', dis: !!a.untrained }; }),
          statuses: ((H.Play.get(cur.id) || {}).statuses) || {} }) : null);
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
        stat('HP', d.r.meta.hp || '—'), stat(el('abbr', { title: 'Innate Magical Potential: how many magic items you can bind to' }, 'I.M.P.'), d.r.meta.imp || '—'),
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
            stat('HP', slot.cls.meta.hp ? (slot.i ? `+${slot.cls.meta.hp}` : slot.cls.meta.hp) : '—'), stat('Hit die', slot.cls.meta['hit die'] || '—'), slot.cls.meta.defence ? stat('Defence', slot.cls.meta.defence) : null,
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
    function rollOne() {
      const { n, sides, keep } = RULES.statDice;
      const dice = roll(n, sides).sort((a, b) => a - b);
      return { v: dice.slice(0, keep).reduce((a, x) => a + x, 0), dice };
    }
    // every roll goes in the character's roll record, so the DM can see how the stats came about
    function logRoll(what, values, how) {
      const c = cur.data;
      c.rollLog = Array.isArray(c.rollLog) ? c.rollLog : [];
      c.rollLog.push({ at: new Date().toISOString(), what, how, values });
      if (c.rollLog.length > 60) c.rollLog = c.rollLog.slice(-60);
    }
    function rollStat(k) {
      const r = rollOne();
      cur.data.rolls[k] = r.dice; cur.data.stats[k] = r.v;
      if (cur.data.typed) delete cur.data.typed[k];
      return r;
    }

    /* How stats are rolled is the DM's call, per campaign (Session screen): roll a set and assign it (the default),
       or roll each stat in order; and how many rerolls are allowed. Without a campaign, the default applies. */
    const ROLL_DEFAULT = { method: 'assign', rerolls: 0 };
    let campRules = null, campRulesBusy = false;
    async function loadCampRules() {
      if (campRulesBusy || !sb() || !user()) return;
      campRulesBusy = true;
      const [cp, mem] = await Promise.all([sb().from('campaigns').select('*').order('name', { ascending: true }), sb().from('campaign_members').select('campaign_id, user_id').eq('user_id', user().id)]);
      campRules = { byId: new Map(((cp && cp.data) || []).map(x => [x.id, x])), mine: ((mem && mem.data) || []).map(x => x.campaign_id) };
      campRulesBusy = false;
      if (state.tab === 'chars') render();
    }
    function rollRules() {
      if (!campRules) { loadCampRules(); return { ...ROLL_DEFAULT, from: '' }; }
      const ids = [cur && cur.campaign_id, ...campRules.mine].filter(Boolean);
      const cp = ids.map(id => campRules.byId.get(id)).find(Boolean);
      const st = (cp && cp.settings && cp.settings.stats) || {};
      return { method: st.method === 'order' ? 'order' : 'assign', rerolls: Number.isFinite(+st.rerolls) ? Math.max(0, Math.min(99, +st.rerolls)) : 0, from: cp ? cp.name : '' };
    }
    const groupKey = label => label === 'Stats' ? 'base' : 'combat';
    const rollsUsed = (c, g) => num((c.rollCount || {})[g]);
    function bump(c, g) { c.rollCount = c.rollCount || {}; c.rollCount[g] = rollsUsed(c, g) + 1; }

    // roll a whole set for a group, to be placed on the stats in any order
    function rollSet(keys, label) {
      const c = cur.data, g = groupKey(label);
      const set = keys.map(() => rollOne()).sort((a, b) => a.v - b.v);
      c.pool = c.pool || {};
      c.pool[g] = set.map(x => ({ ...x, to: null }));
      for (const k of keys) { c.stats[k] = ''; delete c.rolls[k]; if (c.typed) delete c.typed[k]; }
      bump(c, g);
      logRoll(label, set.map(x => x.v), 'set');
    }
    function assign(keys, label, k, idx) {
      const c = cur.data, pool = (c.pool || {})[groupKey(label)] || [];
      for (const p of pool) if (p.to === k) p.to = null;
      if (idx >= 0 && pool[idx]) { pool[idx].to = k; c.stats[k] = pool[idx].v; c.rolls[k] = pool[idx].dice; }
      else { c.stats[k] = ''; delete c.rolls[k]; }
    }

    /* ---- stats: one card per stat ---- */
    const STAT_NAMES = { STR: 'Strength', DEX: 'Dexterity', INT: 'Intelligence', WIS: 'Wisdom', PER: 'Perception', CHA: 'Charisma' };
    function statCards(c, d, keys, label) {
      const { keep, sides } = RULES.statDice;
      const R = rollRules(), g = groupKey(label), used = rollsUsed(c, g);
      const pool = R.method === 'assign' && c.pool && c.pool[g] && c.pool[g].length === keys.length ? c.pool[g] : null;
      const rolledAny = keys.some(k => c.stats[k] !== '' && c.stats[k] != null);
      // rolling again is allowed while the DM's reroll allowance lasts (characters rolled before the record started aren't held to it)
      const left = R.rerolls - Math.max(0, used - 1);
      const canRoll = (used === 0 && !rolledAny && !pool) || left > 0;
      const cards = d.stats.filter(s => keys.includes(s.k)).map(s => {
        const dice = c.rolls[s.k], adj = num(c.adjust[s.k]), q = s.mod - adj;
        const typed = c.typed && c.typed[s.k];
        const parts = [s.base != null ? `${typed ? 'typed in' : 'rolled'} ${s.base}` : null, q ? `quirks ${fmt(q)}` : null, adj ? `adjust ${fmt(adj)}` : null, s.lvlMod ? `levels ${fmt(s.lvlMod)}` : null].filter(Boolean);
        const slot = pool ? pool.findIndex(p => p.to === s.k) : -1;
        return el('div', { class: 'cc-stat' + (s.final == null ? ' empty' : '') },
          el('span', { class: 'k', title: STAT_NAMES[s.k] || s.k }, s.k),
          el('span', { class: 'v' }, s.final == null ? '—' : String(s.final)),
          el('span', { class: 'bd' }, parts.length > 1 || s.base == null ? (parts.join(' · ') || (pool ? 'Not placed' : 'Not rolled')) : '\u00a0'),
          dice ? el('span', { class: 'dice', title: `Rolled ${dice.join(', ')}; the highest is dropped`, html: dice.map((x, i) => i < keep ? String(x) : `<s>${x}</s>`).join(' ') }) : null,
          pool ? el('select', { class: 'select cc-place', 'aria-label': `Number for ${s.k}`, onchange: e => { assign(keys, label, s.k, e.target.value === '' ? -1 : +e.target.value); changed(); render(); } },
            el('option', { value: '' }, slot >= 0 ? 'Take it off' : 'Place a number…'),
            ...pool.map((p, i) => (p.to === null || p.to === s.k) ? el('option', { value: String(i), selected: i === slot }, `${p.v}${p.to === s.k ? ' (here)' : ''}`) : null).filter(Boolean)) : null,
          showAdjust ? el('div', { class: 'cc-stat-edit' },
            el('label', {}, 'Rolled', el('input', { type: 'number', class: 'num', min: String(keep), max: String(keep * sides), value: s.base == null ? '' : String(s.base), 'aria-label': `${s.k} rolled`,
              onchange: e => { const v = e.target.value === '' ? '' : num(e.target.value); if (v === cur.data.stats[s.k] && cur.data.typed && cur.data.typed[s.k]) return; cur.data.stats[s.k] = v; delete cur.data.rolls[s.k]; if (v !== '') { cur.data.typed = cur.data.typed || {}; cur.data.typed[s.k] = true; logRoll(s.k, [v], 'typed'); } if (pool) for (const p of pool) if (p.to === s.k) p.to = null; changed(); render(); } })),
            el('label', {}, 'Adjust', el('input', { type: 'number', class: 'num', value: String(adj), title: '−1 improves the stat, +1 worsens it', 'aria-label': `${s.k} adjustment`, onchange: e => { cur.data.adjust[s.k] = num(e.target.value); changed(); render(); } }))) : null,
          R.method === 'order' && (s.base == null || canRoll)
            ? el('button', { class: 'mini', 'aria-label': `${s.base == null ? 'Roll' : 'Reroll'} ${s.k}`, onclick: () => { const r = rollStat(s.k); if (s.base != null) bump(cur.data, g); logRoll(s.k, [r.v], s.base == null ? 'roll' : 'reroll'); changed(); render(); } }, s.base == null ? 'Roll' : 'Reroll') : null);
      });
      const free = pool ? pool.filter(p => p.to === null) : [];
      const head = R.method === 'assign'
        ? el('button', { class: 'btn small' + (pool || rolledAny ? '' : ' primary'), disabled: !canRoll, title: canRoll ? null : 'No rerolls left for this campaign',
            onclick: () => { rollSet(keys, label); changed(); render(); } }, pool || rolledAny ? `Reroll the ${label.toLowerCase()}` : `Roll your ${label.toLowerCase()}`)
        : el('button', { class: 'btn small' + (rolledAny ? '' : ' primary'), disabled: rolledAny && !canRoll, title: rolledAny && !canRoll ? 'No rerolls left for this campaign' : null,
            onclick: () => { const vals = keys.map(k => rollStat(k).v); if (rolledAny) bump(cur.data, g); else { cur.data.rollCount = cur.data.rollCount || {}; cur.data.rollCount[g] = Math.max(1, rollsUsed(cur.data, g)); } logRoll(label, vals, 'in order'); changed(); render(); } }, `${rolledAny ? 'Reroll' : 'Roll'} all ${label.toLowerCase()}`);
      return [
        el('div', { class: 'cc-stat-head' }, el('h3', { class: 'cc-h3' }, label), head),
        pool ? el('div', { class: 'cc-pool', role: 'group', 'aria-label': `Your ${label.toLowerCase()} rolls` },
          el('span', { class: 'k' }, free.length ? `To place (lower is better):` : 'All placed:'),
          ...pool.map(p => el('span', { class: 'cc-poolv' + (p.to ? ' used' : ''), title: `${p.dice.join(', ')}${p.to ? ' · on ' + p.to : ''}` }, String(p.v), p.to ? el('span', { class: 'to' }, p.to) : null))) : null,
        el('div', { class: 'cc-statgrid' + (keys.length === 5 ? ' five' : '') }, ...cards),
      ];
    }
    function statsSection(c, d) {
      const { n, sides, keep } = RULES.statDice;
      const R = rollRules();
      const how = R.method === 'assign'
        ? `Roll a set of numbers, then place each one on the stat you want it on.`
        : `Roll each stat in turn.`;
      const re = R.rerolls === 0 ? 'No rerolls.' : R.rerolls >= 99 ? 'Rerolls as you like.' : `${R.rerolls} reroll${R.rerolls === 1 ? '' : 's'} of each set.`;
      return [
        el('p', { class: 'd-note' }, `Each number is ${n}d${sides}, keeping the lowest ${keep}. Lower is better. ${how} ${re}${R.from ? ` (The rules for ${R.from}.)` : ''} Level-up improvements are added for you.`),
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
          d.dGiven.length || d.qSel.some(q => q.given) ? el('div', {}, el('h3', { class: 'cc-h3' }, 'From the DM'),
            ...d.dGiven.map(x => card('', [el('strong', {}, x.name), x.spBack && x.sp ? tag(`${x.sp} SP back`) : null, fromDm()], el('p', { class: 'cc-card-t' }, [plain(x.text), x.note].filter(Boolean).join(' · ')))),
            ...d.qSel.filter(q => q.given).map(x => card('', [el('strong', {}, x.name), tag('quirk'), fromDm()], el('p', { class: 'cc-card-t' }, `${x.gain}; ${x.cost}`)))) : null,
          el('div', {}, el('h3', { class: 'cc-h3' }, `Quirks · ${c.quirks.length} of ${RULES.maxQuirks}`),
            ...d.qSel.filter(q => !q.given).map(x => card('', [el('strong', {}, x.name), btns(el('button', { class: 'mini danger', onclick: drop('quirks', x.name) }, 'Remove'))], el('p', { class: 'cc-card-t' }, `${x.gain}; ${x.cost}`))),
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
      if ([1, 3, 5, 7, 9, 0].includes(k)) out.push(N >= 11 ? '1 subclass point (SP), or 1 Final Point (FP) instead' : '1 subclass point (SP)');
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
            el('span', {}, 'Take this level’s point as a Final Point (FP) instead of SP: FP is spent on final classes')) : null,
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
      const dmRows = Object.entries(d.dmSkills).map(([n, r]) => el('div', { class: 'cc-skillrow cc-given' }, el('span', { class: 'nm' }, el('strong', {}, n), fromDm()), pips(Math.min(5, r)), el('span', { class: 'rk' }, `+${r} rank${r === 1 ? '' : 's'}`)));
      if (dmRows.length) kids.push(el('div', { class: 'cc-skillrows' }, ...dmRows));
      if (!d.skillRanks && !d.skillsUsed) { if (!dmRows.length) kids.push(el('p', { class: 'd-note' }, 'You gain soft skill ranks at levels X4 and X6, and from milestone boons. Your first comes at level 4.')); return kids; }
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
      if (!slot.dm && RULES.renownAt(slot.lvl) < RULES.tierRenown[f.tier]) return `Tier ${romanOf(f.tier)} needs Renown ${RULES.tierRenown[f.tier]}`;
      const taken = [...Object.entries(c.lv.feats).filter(([k]) => k !== slot.key).map(([, v]) => v), ...(d.dmFeats || []).map(x => x.name)];
      if (taken.includes(f.name)) return 'You already have this feat';
      const miss = f.needs.filter(n => !taken.includes(n));
      if (miss.length) return `Needs ${miss.join(', ')}`;
      if (f.caster && !d.slots.some(x => x.magic)) return 'Needs a spellcasting class';
      return '';
    }
    const featOk = (c, d, f, slot) => !featWhy(c, d, f, slot);
    const fromDm = () => el('span', { class: 'cc-dmtag' }, 'From the DM');
    function featsSection(c, d) {
      const given = d.dmFeats.map(f => el('div', { class: 'cc-card cc-given' }, el('div', { class: 'cc-card-h' }, el('strong', {}, f.name), f.tier ? el('span', { class: 'cc-tag' }, `Tier ${romanOf(f.tier)}`) : null, fromDm()), f.effect ? el('p', { class: 'cc-card-t' }, f.effect) : null));
      if (!d.featSlots.length) return [...given, given.length ? null : el('p', { class: 'd-note' }, 'You gain a feat at every level X8 (8, 18, 28…), and Tier IV or V feats from milestone boons at high Renown. Your first comes at level 8.')];
      return [...given, el('p', { class: 'd-note' }, 'Each slot offers the feats you qualify for at that level.'), ...d.featSlots.map(slot => featSlotRow(c, d, slot))];
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
    setTimeout(() => catalogueItems(), 0);
    const NOT_CARRIED = new Set(['services', 'hire', 'craft', 'temple', 'arcane', 'info', 'leisure']);
    function catalogueItems() {
      if (!catalogue && !catLoading) {
        catLoading = true;
        fetch('content/items.json').then(r => r.json()).then(j => { catalogue = j; if (state.tab === 'chars') render(); }).catch(() => {});
      }
      return catalogue ? catalogue.items.filter(i => !NOT_CARRIED.has(i.cat)) : [];
    }
    /* ---------- weapons and armour that work on the sheet ----------
       Items from the item list carry fighting numbers (content/items.json "fight"); anything else can be given its own.
       Equipped weapons become attacks; equipped armour adds its Defence to the class's, the highest Min hit counts, and
       temp HP adds up (back on a long rest). One piece per place (body, shield, head…) counts. Quality's shift adds to
       damage, and to Defence for body armour and shields. A weapon the character's classes aren't trained in rolls to hit
       with disadvantage. Broken gear doesn't count until it's repaired. */
    const QUALS = ['Broken', 'Poor', 'Normal', 'Good', 'Great', 'Masterwork', 'Legendary', 'Artifact'];
    const QSHIFT = { Great: 1, Masterwork: 2, Legendary: 3, Artifact: 4 };
    const qualShift = q => { const Q = catalogue && (catalogue.qualities || []).find(x => x.name === q); return Q ? num(Q.shift) : (QSHIFT[q] || 0); };
    const SLOTS = [['body', 'Body armour'], ['shield', 'Shield'], ['head', 'Head'], ['hands', 'Hands'], ['arms', 'Arms'], ['legs', 'Legs'], ['neck', 'Neck'], ['mount', 'A mount (doesn’t count for you)']];
    const SLOT_LABEL = Object.fromEntries(SLOTS);
    const WTYPES = [['sword', 'Sword'], ['shortsword', 'Short sword'], ['curved', 'Curved blade'], ['axe', 'Axe'], ['shortaxe', 'Short axe'], ['dagger', 'Dagger or knife'],
      ['spear', 'Spear'], ['javelin', 'Javelin'], ['polearm', 'Polearm'], ['glaive', 'Glaive'], ['lance', 'Lance'], ['hammer', 'Hammer'], ['warhammer', 'Warhammer'], ['mace', 'Mace'],
      ['flail', 'Flail'], ['club', 'Club'], ['staff', 'Staff'], ['pick', 'Pick or tool'], ['whip', 'Whip'], ['net', 'Net, bola or line'], ['bow', 'Bow'], ['shortbow', 'Short bow'],
      ['longbow', 'Longbow'], ['crossbow', 'Crossbow'], ['handcrossbow', 'Hand crossbow'], ['sling', 'Sling'], ['blowgun', 'Blowgun'], ['firearm', 'Firearm'], ['unarmed', 'Unarmed or claws'], ['other', 'Something else']];
    const TYPE_TAGS = { dagger: ['dagger', 'knife'], pick: ['pick', 'tool'], shortsword: ['sword', 'shortsword'], shortaxe: ['axe', 'shortaxe'], longbow: ['bow', 'longbow'], shortbow: ['bow', 'shortbow'],
      handcrossbow: ['crossbow', 'handcrossbow'], warhammer: ['hammer', 'warhammer'], glaive: ['polearm', 'glaive'], javelin: ['spear', 'javelin'] };
    const TAGS_OK = new Set(WTYPES.map(([k]) => k).concat(['knife', 'tool', 'cutlass']));
    // what an item from the list is made of: its main material ('metal', 'wood', 'leather', 'cloth'), how much, and any set material
    const MATS = ['metal', 'wood', 'leather', 'cloth'];
    const matBits = g => ({ ...(MATS.includes(g.mat) ? { mat: g.mat, kg: Math.max(0, Math.min(100, num(g.kg))) } : {}), ...(g.material ? { material: String(g.material).slice(0, 60) } : {}) });
    function cleanGear(g) {
      if (!g || typeof g !== 'object') return null;
      const lim = (v, hi) => Math.max(0, Math.min(hi, num(v)));
      if (g.kind === 'weapon') return { kind: 'weapon', dice: String(g.dice || '').replace(/\s/g, '').slice(0, 30), stat: ['Melee', 'Ranged', 'Casting'].includes(g.stat) ? g.stat : 'Melee',
        hands: num(g.hands) === 2 ? 2 : 1, tags: (Array.isArray(g.tags) ? g.tags : []).map(String).filter(t => TAGS_OK.has(t)).slice(0, 4), ...(g.notes ? { notes: String(g.notes).slice(0, 160) } : {}), ...(g.cls ? { cls: true } : {}), ...matBits(g) };
      if (g.kind === 'armour') return { kind: 'armour', slot: SLOT_LABEL[g.slot] ? g.slot : 'body', def: lim(g.def, 20), minHit: lim(g.minHit, 50), thp: lim(g.thp, 200), ...matBits(g) };
      if (g.kind === 'ammo') return { kind: 'ammo' };
      return null;
    }
    const listItem = it => it.ref && catalogue ? catalogue.items.find(x => x.id === it.ref) || null : null;
    // the numbers an item fights with: the player's own, else the item list's, else the copy saved with it
    function baseGear(it) {
      if (it.gc) return it.g || null;
      const L = listItem(it);
      if (L) return L.fight ? cleanGear(L.fight) : null;
      return it.g || null;
    }
    /* ---------- materials ----------
       Gear is drawn up in its standard material (steel, oak, cured leather, wool). Made of something else, it scales by
       the material's tier against the standard's: each tier up alternately adds +1 damage and a bigger damage die; armour
       gets +1 Min hit and +20% temp HP per tier, and +1 Defence every two tiers (body armour and shields). Worse
       materials take the same off. */
    const STD_MAT = { metal: 'steel-ingot-1-lb', wood: 'oak-plank', leather: 'cured-leather-hide', cloth: 'wool-cloth-1-sq-yd' };
    const matItem = id => catalogue && id ? catalogue.items.find(x => x.id === id && x.mat) || null : null;
    const stdMat = cls => matItem(((catalogue && catalogue.standardMaterials) || STD_MAT)[cls]);
    const matName = m => m ? m.name.replace(/\s*\((?:1 [^)]*|bundle|unfinished|thick)\)\s*$/i, '').replace(/ (ingot|plank|stave|pelt|hide|skin|cloth)$/i, (w, x) => /hide|skin|pelt/i.test(x) ? w : '') : '';
    const DIES = [2, 4, 6, 8, 10, 12, 20];
    // "1d8" one tier up → "1d8+1", two → "1d10", three → "1d10+1"; down the same way
    function scaleDice(dice, step) {
      if (!step || !dice) return dice;
      const m = String(dice).match(/^(\d*)d(\d+)(.*)$/i);
      const dieSteps = Math.trunc(step / 2), flat = step - 2 * dieSteps;
      if (!m) { const n = parseInt(dice, 10); return isNaN(n) ? dice : String(Math.max(1, n + step)); }
      let i = DIES.indexOf(parseInt(m[2], 10));
      let die = parseInt(m[2], 10), spare = i < 0 ? dieSteps : 0;
      // past a d20 (or below a d2) the steps left over become +2 each
      if (i >= 0) { const want = i + dieSteps; i = Math.max(0, Math.min(DIES.length - 1, want)); spare = want - i; die = DIES[i]; }
      const rest = m[3] || '';
      const k = rest.match(/^([+-]\d+)$/);
      const mod = (k ? parseInt(k[1], 10) : 0) + flat + spare * 2;
      const tail = k || !rest ? (mod ? (mod > 0 ? `+${mod}` : `${mod}`) : '') : rest + (flat ? (flat > 0 ? `+${flat}` : `${flat}`) : '');
      return `${m[1]}d${die}${tail}`;
    }
    function withMaterial(g, matId) {
      if (!g || !g.mat || (g.kind !== 'weapon' && g.kind !== 'armour')) return g;
      const id = matId || g.material;
      const M = matItem(id), S = stdMat(g.mat);
      if (!M || !S || M.mat !== g.mat) return g;
      const step = num(M.tier) - num(S.tier);
      const fx = M.fx && M.fx[g.kind === 'weapon' ? 'w' : 'a'];
      const out = { ...g, matId: M.id, matName: matName(M), matStep: step, ...(fx ? { matFx: fx } : {}) };
      if (!step) return out;
      if (g.kind === 'weapon') out.dice = scaleDice(g.dice, step);
      else {
        out.thp = Math.max(0, Math.round(g.thp * (1 + 0.2 * step)));
        if (g.slot === 'body' || g.slot === 'shield' || g.slot === 'mount') {
          out.minHit = Math.max(0, g.minHit + step);
          out.def = Math.max(0, g.def + Math.trunc(step / 2));
        }
      }
      return out;
    }
    const gearOf = it => withMaterial(baseGear(it), it.m);
    // what the character's classes are trained with, from each class's "weapons" line (null: no class to check against)
    function trainedOf(slots) {
      const out = new Set(); let any = false;
      for (const x of slots) {
        let t = String((x.cls && x.cls.meta.weapons) || '').toLowerCase();
        if (!t) continue;
        any = true;
        const add = (re, ...k) => { if (re.test(t)) k.forEach(v => out.add(v)); };
        add(/any melee/, '*melee');
        add(/short ?swords?/, 'shortsword');
        add(/curve|curved|hook ?swords?|sickles?|scythes?|kama/, 'curved');
        add(/cutlass/, 'cutlass');
        add(/short ?axes?/, 'shortaxe');
        add(/long ?bows?/, 'longbow');
        add(/short ?bows?/, 'shortbow');
        add(/hand ?crossbows?/, 'handcrossbow');
        add(/warhammers?/, 'warhammer');
        t = t.replace(/short ?swords?|curved swords?|hook swords?|short ?axes?|long ?bows?|short ?bows?|hand ?crossbows?|warhammers?/g, ' ');
        add(/\bswords?\b/, 'sword');
        add(/\baxes?\b/, 'axe');
        add(/\bbows?\b/, 'bow');
        add(/crossbows?/, 'crossbow');
        add(/spears?/, 'spear');
        add(/javelins?/, 'javelin');
        add(/polearms?/, 'polearm');
        add(/glaives?/, 'glaive');
        add(/lances?/, 'lance');
        add(/\bhammers?\b/, 'hammer');
        add(/\btools?\b/, 'hammer', 'pick', 'tool');
        add(/\bclubs?\b/, 'club');
        add(/staffs?|staves/, 'staff');
        add(/daggers?|knives|knife/, 'dagger', 'knife');
        add(/slings?/, 'sling');
        add(/\bnets?\b|weighted lines|bolas/, 'net');
        add(/barehanded|unarmed|claws/, 'unarmed');
        add(/\bmaces?\b/, 'mace');
        add(/\bwhips?\b/, 'whip');
      }
      return any ? out : null;
    }
    const isTrained = (g, T) => !T || g.cls || !g.tags.length || g.tags.includes('other') || g.tags.some(k => T.has(k)) || (T.has('*melee') && g.stat === 'Melee');
    function gearSummary(c, slots, GR) {
      GR = GR || cleanGrants({});
      const T = trainedOf(slots);
      const attacks = [], worn = [], ignored = [], bySlot = {};
      let def = 0, minHit = 0, thp = 0;
      // what the DM made up comes first, so DM armour takes its place on the body
      for (const x of GR.gear) {
        if (x.kind === 'weapon') { attacks.push({ id: 'G' + x.id, name: x.name, stat: x.stat, dice: x.dice, gear: true, dm: true, notes: [x.hands === 2 ? 'two-handed' : '', x.notes || '', 'from the DM'].filter(Boolean).join(', ') }); continue; }
        if (bySlot[x.slot]) continue;
        bySlot[x.slot] = x.name;
        def += x.def; minHit = Math.max(minHit, x.minHit); thp += x.thp;
        worn.push({ id: 'G' + x.id, name: x.name, slot: x.slot, def: x.def, minHit: x.minHit, thp: x.thp, q: 'Normal', mat: '', dm: true, ...(x.notes ? { fx: x.notes } : {}) });
      }
      for (const it of c.items) {
        if (!it.on) continue;
        const g = gearOf(it);
        if (!g || g.kind === 'ammo') continue;
        const q = it.q || 'Normal', sh = qualShift(q), nm = it.name.trim() || (g.kind === 'weapon' ? 'Weapon' : 'Armour');
        const tw = GR.tweaks[it.id] || null;   // the DM's own numbers for this item: final, quality and material already counted
        if (q === 'Broken') { ignored.push(`${nm} is broken, so it doesn’t count until it’s repaired`); continue; }
        if (g.kind === 'weapon') {
          const dice = tw && tw.dice != null ? tw.dice : g.dice ? (sh ? `${g.dice}+${sh}` : g.dice) : '';
          attacks.push({ id: it.id, name: nm, stat: tw && tw.stat || g.stat, dice, gear: true, untrained: !isTrained(g, T), ...(tw ? { dmSet: true } : {}),
            notes: [g.matStep && !g.matFx ? g.matName : '', g.hands === 2 ? 'two-handed' : '', g.notes || '', sh && !(tw && tw.dice != null) ? `${q}: +${sh} damage` : '', tw && tw.notes || '', tw ? 'numbers set by the DM' : ''].filter(Boolean).join(', ')
              + (g.matFx ? `. ${g.matName}: ${g.matFx}` : '') });
        } else if (g.kind === 'armour') {
          if (g.slot === 'mount') continue;
          if (bySlot[g.slot]) { ignored.push(`${nm} doesn’t count: you already wear ${bySlot[g.slot]} (${SLOT_LABEL[g.slot].toLowerCase()})`); continue; }
          bySlot[g.slot] = nm;
          const dd = tw && tw.def != null ? tw.def : g.def + (g.slot === 'body' || g.slot === 'shield' ? sh : 0);
          const mh = tw && tw.minHit != null ? tw.minHit : g.minHit, th = tw && tw.thp != null ? tw.thp : g.thp;
          def += dd; minHit = Math.max(minHit, mh); thp += th;
          const fx = [g.matFx ? `${g.matName}: ${g.matFx}` : '', tw && tw.notes || ''].filter(Boolean).join(' ');
          worn.push({ id: it.id, name: nm, slot: g.slot, def: dd, minHit: mh, thp: th, q, mat: g.matStep || g.matFx ? g.matName : '', ...(tw ? { dmSet: true } : {}), ...(fx ? { fx, fxFull: true } : {}) });
        }
      }
      // the DM's extra armour values, on top of whatever is worn
      const A = GR.arm;
      def = Math.max(0, def + A.def); minHit = Math.max(0, minHit + A.minHit); thp = Math.max(0, thp + A.thp);
      return { attacks, worn, ignored, def, minHit, thp, trained: T, dmArm: A.def || A.minHit || A.thp ? A : null };
    }
    // a class's starting weapons and equipment, from its subclass page ("Weapons: A (1d20) · B (3d8) …")
    function startingKit(d) {
      const out = [];
      for (const x of d.slots) {
        if (!x.g || !x.g.intro) continue;
        for (const [re, kind] of [[/^Weapons:\s*(.+)$/m, 'weapon'], [/^Or equipment:\s*(.+)$/m, 'item']]) {
          const m = x.g.intro.match(re); if (!m) continue;
          for (const part of m[1].split(/\s*·\s*/)) {
            const pm = part.trim().replace(/\.$/, '').match(/^([^(]+?)\s*(?:\((.+)\))?$/);
            if (!pm) continue;
            let name = pm[1].trim(), qty = 1;
            const xm = name.match(/\s+x(\d+)$/i); if (xm) { qty = num(xm[1], 1); name = name.slice(0, xm.index).trim(); }
            const desc = (pm[2] || '').trim();
            if (kind === 'item') { out.push({ name, qty, notes: desc, from: x.label }); continue; }
            const dm = desc.match(/\d*d\d+(?:\s*\+\s*\d*d?\d+)*/i);
            const ranged = /bow|crossbow|sling|pistol|musket|bola|net|line|harpoon|throw/i.test(name);
            const rest = desc.replace(dm ? dm[0] : '\u0000', '').replace(/\b(two|one)[- ]handed\b|\btwo one-handed\b/ig, '').replace(/^\s*each\b/i, '').replace(/^[\s,—–-]+|[\s,—–-]+$/g, '').replace(/\s{2,}/g, ' ');
            out.push({ name, qty, from: x.label, g: { kind: 'weapon', dice: dm ? dm[0].replace(/\s/g, '') : '', stat: ranged ? 'Ranged' : 'Melee', hands: /two-handed/i.test(desc) && !/two one-handed/i.test(desc) ? 2 : 1, tags: [], notes: rest, cls: true } });
          }
        }
      }
      return out;
    }
    const sgn = n => n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
    const dmArmText = A => [A.def ? `Defence ${sgn(A.def)}` : '', A.minHit ? `Min hit ${sgn(A.minHit)}` : '', A.thp ? `${sgn(A.thp)} temp HP` : ''].filter(Boolean).join(' · ');
    const tweakText = tw => [tw.dice != null ? tw.dice : '', tw.stat || '', tw.def != null ? `Defence +${tw.def}` : '', tw.minHit != null ? `Min hit ${tw.minHit}` : '', tw.thp != null ? `${tw.thp} temp HP` : '', tw.notes || ''].filter(Boolean).join(' · ');
    const gearLine = (g, it) => {
      if (!g) return '';
      const made = g.matStep || g.matFx || (g.matId && g.material && g.matId === g.material) ? `${g.matName}${g.matStep ? ` (${g.matStep > 0 ? '+' : '−'}${Math.abs(g.matStep)})` : ''}` : '';
      if (made) return made + ' · ' + gearLine({ ...g, matStep: 0, matId: null, matFx: '' }, it);
      const q = it && it.q && it.q !== 'Normal' ? it.q : '';
      if (g.kind === 'weapon') return [`${g.dice || 'no damage'}${q && qualShift(q) ? `+${qualShift(q)}` : ''}`, g.stat, g.hands === 2 ? 'two-handed' : '', g.notes || ''].filter(Boolean).join(' · ');
      if (g.kind === 'armour') {
        const sh = q && (g.slot === 'body' || g.slot === 'shield') ? qualShift(q) : 0;
        return [SLOT_LABEL[g.slot], g.def + sh ? `Defence +${g.def + sh}` : '', g.minHit ? `Min hit ${g.minHit}` : '', g.thp ? `${g.thp} temp HP` : ''].filter(Boolean).join(' · ');
      }
      if (g.kind === 'ammo') return 'Ammunition';
      return '';
    };

    // dice like 1d8, 2d6+3 or 12 (the same forms the dice roller takes)
    // up to six terms; the table's dice go up to 50 dice of 1000 sides (supabase/setup.sql: roll_dice)
    const diceOk = t => { const x = String(t || '').replace(/\s/g, ''); return /^[+-]?(\d{0,2}d\d{1,4}|\d{1,4})([+-](\d{0,2}d\d{1,4}|\d{1,4})){0,5}$/i.test(x) && [...x.matchAll(/(\d*)d(\d+)/gi)].every(m => +m[2] >= 2 && +m[2] <= 1000 && (+m[1] || 1) <= 50); };
    function knownSpellsWithDice(c, d) {
      const out = [];
      for (const slot of d.slots) {
        if (!slot.g) continue;
        if (c.buys.general[slot.g.key] && slot.g.spellsTag) out.push(...spellsWith(slot.g.spellsTag));
        for (const sub of slot.g.items) { const tiers = c.buys.tiers[sub.id] || []; if (tiers.length) out.push(...spellsWith(sub.spellsTag).filter(sp => tiers.includes(sp.tier))); }
      }
      const seen = new Set();
      return out.filter(sp => sp.dice && /\d*d\d+/.test(sp.dice) && !seen.has(sp.name) && seen.add(sp.name));
    }
    function attacksSection(c, d) {
      const A = c.attacks, gear = d.gear;
      const statVal = k => { const s = d.stats.find(x => x.k === k); return s && s.final != null ? s.final : null; };
      const toInv = () => { const sec = document.querySelector('[data-sec="Inventory"]') || [...document.querySelectorAll('.cc-sec')].find(x => /Inventory/.test(x.querySelector('h2, h3') ? x.querySelector('h2, h3').textContent : '')); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      const gearRows = gear.attacks.map(a => el('div', { class: 'cc-gatk' + (a.untrained ? ' untrained' : '') },
        el('span', { class: 'nm' }, a.name),
        el('span', { class: 'st' }, `${a.stat}${statVal(a.stat) != null ? ' ' + statVal(a.stat) : ''}`),
        el('span', { class: 'dmg' }, a.dice || '—'),
        el('span', { class: 'nt' }, a.notes || ''),
        a.untrained ? el('span', { class: 'cc-untrained' }, 'Not trained: to hit with disadvantage') : null));
      const rows = A.map((a, i) => el('div', { class: 'cc-atk' },
        el('input', { type: 'text', class: 'cc-atk-name', value: a.name, maxlength: '80', placeholder: 'Firebolt, unarmed strike…', 'aria-label': 'Attack name', oninput: e => { a.name = e.target.value; changed(); } }),
        el('select', { class: 'select cc-atk-stat', 'aria-label': `Stat ${a.name || 'this attack'} hits with`, onchange: e => { a.stat = e.target.value; changed(); render(); } },
          ...['Melee', 'Ranged', 'Casting'].map(k => el('option', { value: k, selected: a.stat === k }, `${k}${statVal(k) != null ? ' ' + statVal(k) : ''}`))),
        el('input', { type: 'text', class: 'cc-atk-dice' + (a.dice && !diceOk(a.dice) ? ' bad' : ''), value: a.dice, maxlength: '30', placeholder: '1d8', 'aria-label': `Damage dice for ${a.name || 'this attack'}`,
          oninput: e => { a.dice = e.target.value; e.target.classList.toggle('bad', !!a.dice && !diceOk(a.dice)); changed(); } }),
        el('input', { type: 'text', class: 'cc-atk-notes', value: a.notes, maxlength: '200', placeholder: 'Notes (reach, range, effects)', 'aria-label': `Notes for ${a.name || 'this attack'}`, oninput: e => { a.notes = e.target.value; changed(); } }),
        el('button', { class: 'mini danger', 'aria-label': `Remove ${a.name || 'this attack'}`, onclick: () => { A.splice(i, 1); changed(); render(); } }, 'Remove')));
      const spells = knownSpellsWithDice(c, d).filter(sp => !A.some(a => a.name === sp.name)).slice(0, 16);
      const W = gear.worn;
      return [
        el('p', { class: 'd-note' }, 'An attack hits on a d20 of its stat or more, plus the target’s Defence. Damage is the weapon’s or spell’s dice; feats and abilities can add to it. These show on your sheet and in the Play view, where you can roll them.'),
        el('h3', { class: 'cc-h3' }, 'Weapons'),
        gearRows.length ? el('div', { class: 'cc-gatks' }, ...gearRows)
          : el('p', { class: 'hint' }, 'No weapons equipped. Add weapons in your inventory and tick Equipped; they show here with their damage.'),
        gear.trained ? el('p', { class: 'hint' }, `Your class${d.slots.filter(x => x.cls).length > 1 ? 'es are' : ' is'} trained with: ${[...new Set(d.slots.filter(x => x.cls && x.cls.meta.weapons).map(x => x.cls.meta.weapons))].join('; ')}. Anything else rolls to hit with disadvantage.`) : null,
        el('h3', { class: 'cc-h3' }, 'Spells and other attacks'),
        rows.length ? el('div', { class: 'cc-atks' }, ...rows) : el('p', { class: 'hint' }, 'Spells, unarmed strikes, anything that isn’t a weapon you carry.'),
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small', disabled: A.length >= 30, onclick: () => { A.push({ id: itemId(), name: '', stat: 'Melee', dice: '', notes: '' }); changed(); render(); } }, '+ Add an attack')),
        spells.length ? el('div', { class: 'cc-sugg' }, el('span', { class: 'hint' }, 'From your spells: '),
          ...spells.map(sp => el('button', { class: 'chip', onclick: () => { A.push({ id: itemId(), name: sp.name, stat: 'Casting', dice: (sp.dice.match(/\d*d\d+(\s*[+-]\s*\d+)?/i) || [''])[0].replace(/\s/g, ''), notes: `Tier ${sp.tier} spell` }); changed(); render(); } }, `${sp.name} (${sp.dice})`))) : null,
        el('h3', { class: 'cc-h3' }, 'Armour'),
        W.length ? el('div', { class: 'cc-worn' }, ...W.map(w => el('div', { class: 'cc-wornrow' },
          el('span', { class: 'nm' }, w.name, w.q !== 'Normal' || w.mat || w.dm || w.dmSet ? el('span', { class: 'bs-fine' }, ` (${[w.mat, w.q !== 'Normal' ? w.q : '', w.dm ? 'from the DM' : w.dmSet ? 'numbers set by the DM' : ''].filter(Boolean).join(', ')})`) : null),
          el('span', { class: 'sl' }, SLOT_LABEL[w.slot]),
          el('span', { class: 'v' }, [w.def ? `Defence +${w.def}` : '', w.minHit ? `Min hit ${w.minHit}` : '', w.thp ? `${w.thp} temp HP` : ''].filter(Boolean).join(' · ') || '—'),
          w.fx ? el('span', { class: 'fx' }, w.fxFull || w.dm ? w.fx : `${w.mat}: ${w.fx}`) : null)))
          : el('p', { class: 'hint' }, 'No armour equipped. Add armour or a shield in your inventory and tick Equipped.'),
        gear.ignored.length ? el('ul', { class: 'cc-ignored' }, ...gear.ignored.map(t => el('li', {}, t))) : null,
        gear.dmArm ? el('p', { class: 'hint' }, `From the DM: ${dmArmText(gear.dmArm)} (counted in the totals below).`) : null,
        el('div', { class: 'cc-armtot' },
          el('span', {}, el('span', { class: 'k' }, 'Defence'), ` ${d.defence}`, el('span', { class: 'bs-fine' }, d.classDefence && gear.def ? ` (class ${d.classDefence} + armour ${gear.def})` : d.classDefence ? ' (class)' : gear.def ? ' (armour)' : '')),
          el('span', {}, el('span', { class: 'k' }, 'Min hit'), ` ${d.minHit}`),
          el('span', {}, el('span', { class: 'k' }, 'Temp HP from armour'), ` ${d.armourThp}`)),
        el('p', { class: 'hint' }, 'Attackers need your Defence more on their d20. Weapon damage under your Min hit doesn’t count; spells, status damage and area effects always do. Armour’s temp HP comes back on a long rest (the Play view does it for you). One piece counts for each place: one body armour, one shield, one helmet and so on.'),
        el('div', { class: 'cc-row' }, el('button', { class: 'mini', onclick: toInv }, 'Go to my inventory')),
      ];
    }

    let gearEdit = '';   // the inventory item whose fighting numbers are open for editing
    // what an item is made of: every material of its kind, by tier (the standard one first in its tier)
    function matSelect(it, g) {
      if (!catalogue) return null;
      const S = stdMat(g.mat), cur = it.m || g.material || (S && S.id);
      const all = catalogue.items.filter(x => x.mat === g.mat);
      const tiers = [...new Set(all.map(x => num(x.tier)))].sort((a, b) => a - b);
      const step = m => num(m.tier) - num(S ? S.tier : 0);
      return el('select', { class: 'select cc-q cc-mat', 'aria-label': `What ${it.name || 'this item'} is made of`,
        onchange: e => { const v = e.target.value; if (v === (g.material || (S && S.id))) delete it.m; else it.m = v; changed(); render(); } },
        ...tiers.map(t => el('optgroup', { label: `Tier ${t}` }, ...all.filter(x => num(x.tier) === t).sort((a, b) => (S && b.id === S.id) - (S && a.id === S.id) || matName(a).localeCompare(matName(b)))
          .map(m => el('option', { value: m.id, selected: m.id === cur }, `${matName(m)}${S && m.id === S.id ? ' (standard)' : step(m) ? ` (${step(m) > 0 ? '+' : '−'}${Math.abs(step(m))})` : ''}`)))));
    }
    function inventorySection(c, d) {
      const items = c.items;
      d = d || derived(c);
      const touch = () => changed();
      const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; changed(); render(); };
      // editing makes the numbers the player's own (until they go back to the list's)
      const own = it => { if (!it.gc) { it.g = Object.assign({}, baseGear(it) || { kind: 'weapon', dice: '', stat: 'Melee', hands: 1, tags: [] }); it.gc = true; } return it.g; };
      const setG = (it, patch) => { const g = own(it); Object.assign(g, patch); it.g = cleanGear(g) || g; changed(); render(); };
      const editor = it => {
        const g = baseGear(it) || {};   // the numbers before material and quality
        const kindSel = el('select', { class: 'select', 'aria-label': `What ${it.name || 'this item'} is`, onchange: e => {
          const k = e.target.value;
          if (!k) { delete it.g; if (listItem(it) && listItem(it).fight) it.gc = true; else delete it.gc; changed(); render(); return; }
          it.gc = true; it.g = cleanGear(k === 'weapon' ? { kind: 'weapon', dice: '', stat: 'Melee', hands: 1, tags: [] } : { kind: 'armour', slot: 'body' }); changed(); render(); } },
          el('option', { value: '', selected: !g.kind || g.kind === 'ammo' }, 'Not a weapon or armour'), el('option', { value: 'weapon', selected: g.kind === 'weapon' }, 'A weapon'), el('option', { value: 'armour', selected: g.kind === 'armour' }, 'Armour or a shield'));
        const lbl = (t, x) => el('label', { class: 'cc-gf' }, el('span', { class: 'k' }, t), x);
        const n = (v, hi, k) => el('input', { type: 'number', class: 'num', min: '0', max: String(hi), value: String(v | 0), onchange: e => setG(it, { [k]: Math.max(0, Math.min(hi, num(e.target.value))) }) });
        const tagNow = (g.tags || []).find(t => WTYPES.some(([k]) => k === t && !TYPE_TAGS[t])) || (g.tags || []).find(t => TYPE_TAGS[t]) || (g.tags || [])[0] || '';
        const typeKey = Object.keys(TYPE_TAGS).find(k => TYPE_TAGS[k].every(t => (g.tags || []).includes(t)) && (g.tags || []).length === TYPE_TAGS[k].length) || tagNow;
        const body = g.kind === 'weapon' ? [
          lbl('Damage', el('input', { type: 'text', class: 'cc-gdice' + (g.dice && !diceOk(g.dice) ? ' bad' : ''), value: g.dice || '', maxlength: '30', placeholder: '1d8', onchange: e => setG(it, { dice: e.target.value }) })),
          lbl('Hits with', el('select', { class: 'select', onchange: e => setG(it, { stat: e.target.value }) }, ...['Melee', 'Ranged', 'Casting'].map(k => el('option', { value: k, selected: g.stat === k }, k)))),
          lbl('Type', el('select', { class: 'select', onchange: e => setG(it, { tags: TYPE_TAGS[e.target.value] || [e.target.value] }) }, el('option', { value: '', selected: !typeKey }, 'Choose…'), ...WTYPES.map(([k, t]) => el('option', { value: k, selected: typeKey === k }, t)))),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: g.hands === 2, onchange: e => setG(it, { hands: e.target.checked ? 2 : 1 }) }), ' Two-handed'),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!g.cls, onchange: e => setG(it, { cls: e.target.checked }) }), ' From my class (always trained)'),
        ] : g.kind === 'armour' ? [
          lbl('Worn on', el('select', { class: 'select', onchange: e => setG(it, { slot: e.target.value }) }, ...SLOTS.map(([k, t]) => el('option', { value: k, selected: g.slot === k }, t)))),
          lbl('Defence +', n(g.def, 20, 'def')), lbl('Min hit', n(g.minHit, 50, 'minHit')), lbl('Temp HP', n(g.thp, 200, 'thp')),
        ] : [];
        const L = listItem(it);
        return el('div', { class: 'cc-geared' },
          el('div', { class: 'cc-gerow' }, lbl('This is', kindSel), ...body),
          el('div', { class: 'cc-row' },
            el('button', { class: 'btn small', onclick: () => { gearEdit = ''; render(); } }, 'Done'),
            L && it.gc ? el('button', { class: 'mini', onclick: () => { it.gc = false; it.g = L.fight ? cleanGear(L.fight) : null; if (!it.g) delete it.g; changed(); render(); } }, 'Use the item list’s numbers') : null,
            L && L.fight && catalogue && catalogue.fightDraft ? el('span', { class: 'bs-fine' }, 'The item list’s numbers are a draft the DM is checking.') : null));
      };
      const rows = items.map((it, i) => {
        const g = gearOf(it), line = gearLine(g, it);
        const fightable = g && g.kind !== 'ammo';
        return el('div', { class: 'cc-inv-item' + (it.on ? ' on' : '') },
          el('div', { class: 'cc-inv-row' + (it.on ? ' on' : '') },
            el('label', { class: 'cc-inv-eq', title: 'Equipped' }, el('input', { type: 'checkbox', checked: it.on, 'aria-label': `${it.name || 'Item'} equipped`, onchange: e => { it.on = e.target.checked; changed(); render(); } }), el('span', {}, 'Equipped')),
            el('input', { type: 'text', class: 'cc-inv-name', value: it.name, maxlength: '120', 'aria-label': 'Item', placeholder: 'Item', oninput: e => { it.name = e.target.value; touch(); } }),
            el('input', { type: 'number', class: 'num cc-inv-qty', min: '0', value: String(it.qty), 'aria-label': 'Quantity', title: 'Quantity', onchange: e => { it.qty = Math.max(0, num(e.target.value)); changed(); render(); } }),
            el('input', { type: 'text', class: 'cc-inv-notes', value: it.notes, maxlength: '300', 'aria-label': 'Notes', placeholder: 'Notes', oninput: e => { it.notes = e.target.value; touch(); } }),
            el('span', { class: 'cc-inv-btns' },
              el('button', { class: 'mini', disabled: i === 0, 'aria-label': `Move ${it.name || 'item'} up`, onclick: () => move(i, -1) }, '↑'),
              el('button', { class: 'mini', disabled: i === items.length - 1, 'aria-label': `Move ${it.name || 'item'} down`, onclick: () => move(i, 1) }, '↓'),
              el('button', { class: 'mini danger', 'aria-label': `Remove ${it.name || 'item'}`, onclick: () => { items.splice(i, 1); changed(); render(); } }, 'Remove'))),
          el('div', { class: 'cc-inv-gear' },
            line ? el('span', { class: 'cc-gline' + (it.gc ? ' own' : '') }, line) : null,
            g && g.matFx ? el('span', { class: 'cc-gfx' }, g.matFx) : null,
            fightable && cur && grantsFor(cur.data).tweaks[it.id] ? el('span', { class: 'cc-gfx cc-gdm' }, `Your DM set this: ${tweakText(grantsFor(cur.data).tweaks[it.id])}`) : null,
            fightable && g.mat ? matSelect(it, g) : null,
            fightable ? el('select', { class: 'select cc-q', 'aria-label': `Quality of ${it.name || 'this item'}`, onchange: e => { if (e.target.value === 'Normal') delete it.q; else it.q = e.target.value; changed(); render(); } },
              ...QUALS.map(q => el('option', { value: q, selected: (it.q || 'Normal') === q }, q + (qualShift(q) ? ` (+${qualShift(q)})` : '')))) : null,
            el('button', { class: 'mini', 'aria-expanded': String(gearEdit === it.id), onclick: () => { gearEdit = gearEdit === it.id ? '' : it.id; render(); } }, fightable ? 'Fighting numbers' : 'Use as a weapon or armour')),
          gearEdit === it.id ? editor(it) : null);
      });
      const known = catalogueItems();
      const name = el('input', { type: 'text', id: 'cc-inv-add', list: 'cc-catalogue', maxlength: '120', placeholder: 'Add an item: type to search the item list, or write your own', 'aria-label': 'New item',
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
      const qty = el('input', { type: 'number', class: 'num', min: '1', value: '1', 'aria-label': 'Quantity', title: 'Quantity',
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
      function add() {
        const n = name.value.trim(); if (!n) { name.focus(); return; }
        const ref = known.find(k => k.name.toLowerCase() === n.toLowerCase());
        const g = ref && ref.fight ? cleanGear(ref.fight) : null;
        items.push({ id: itemId(), name: ref ? ref.name : n, qty: Math.max(1, num(qty.value, 1)), notes: '', on: false, ...(ref ? { ref: ref.id } : {}), ...(g ? { g } : {}) });
        changed(); render();
        requestAnimationFrame(() => { const f = $('#cc-inv-add'); if (f) f.focus(); });
      }
      const kit = startingKit(d).filter(k => !items.some(x => x.name.trim().toLowerCase() === k.name.toLowerCase()));
      const eq = items.filter(x => x.on).length;
      return [
        el('p', { class: 'd-note' }, items.length ? `${items.length} item${items.length === 1 ? '' : 's'}${eq ? ` · ${eq} equipped` : ''}. Tick Equipped for what you’re wearing or holding: equipped weapons become attacks, and equipped armour adds to your Defence.` : 'Add your starting gear (from your subclass) and anything else you carry.'),
        rows.length ? el('div', { class: 'cc-inv' }, ...rows) : null,
        el('div', { class: 'cc-inv-add' }, name, qty, el('button', { class: 'btn small', onclick: add }, 'Add item')),
        kit.length ? el('div', { class: 'cc-sugg cc-kit' }, el('span', { class: 'hint' }, 'Your class’s starting kit (one set of weapons or equipment): '),
          ...kit.map(k => el('button', { class: 'chip', title: k.g ? k.g.notes || '' : k.notes || '', onclick: () => {
            items.push({ id: itemId(), name: k.name, qty: k.qty, notes: k.g ? '' : k.notes, on: false, ...(k.g ? { g: cleanGear(k.g), gc: true } : {}) });
            changed(); render(); } }, k.g ? `${k.name}${k.qty > 1 ? ` ×${k.qty}` : ''} (${k.g.dice || 'weapon'})` : k.name))) : null,
        known.length ? el('datalist', { id: 'cc-catalogue' }, ...known.map(k => el('option', { value: k.name }))) : null,
      ];
    }

    /* ---- from the DM: what the player sees, and (for the DM) the tools to give more ---- */
    let markDraft = null, otherDraft = null, gearDraft = null, tweakDraft = null, dmBoxOpen = false;
    const day = t => { const x = new Date(t); return isNaN(x) ? '' : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };   // a Mark waiting for its deed; something else being written
    function markText(m) {
      const L = traitLists(), hit = [...L.marks, ...L.mythicMarks].find(x => x.name === m.name);
      return plain(m.text || (hit && hit.text) || '');
    }
    // a form for the DM's numbers on one of the character's items, filled with what's set already
    function tweakStart(it, tw) {
      const g = gearOf(it); tw = tw || {};
      return { item: it.id, kind: g.kind, now: gearLine(g, it), dice: tw.dice == null ? '' : tw.dice, stat: tw.stat || '', def: tw.def == null ? '' : tw.def, minHit: tw.minHit == null ? '' : tw.minHit, thp: tw.thp == null ? '' : tw.thp, notes: tw.notes || '' };
    }
    function dmSection(c, d) {
      const G = d.grants;
      const kids = [];
      if (G.marks.length) kids.push(el('h3', { class: 'cc-h3' }, `Marks · ${G.marks.length}`),
        ...G.marks.map(m => card('', [el('strong', {}, m.name), m.at ? el('span', { class: 'bs-fine' }, day(m.at)) : null], el('p', { class: 'cc-card-t' }, [m.deed ? `For ${m.deed.replace(/^for\s+/i, '')}.` : '', markText(m)].filter(Boolean).join(' ')))));
      if (G.other.length) kids.push(el('h3', { class: 'cc-h3' }, 'Also from the DM'), ...G.other.map(x => card('', [el('strong', {}, x.name)], x.text ? el('p', { class: 'cc-card-t' }, x.text) : null)));
      const extras = [G.sp ? `${G.sp > 0 ? '+' : ''}${G.sp} SP (in Subclass points)` : '', G.skillPicks ? `${G.skillPicks} extra soft skill rank${G.skillPicks === 1 ? '' : 's'} to spend (in Soft skills)` : '',
        G.featPicks.length ? `${G.featPicks.length} extra feat${G.featPicks.length === 1 ? '' : 's'} to choose (in Feats)` : '',
        G.feats.length ? `Feats: ${G.feats.map(x => x.name).join(', ')}` : '', G.skills.length ? `Soft skill ranks: ${G.skills.map(x => `${x.name} +${x.ranks}`).join(', ')}` : '',
        G.drawbacks.length || G.quirks.length ? `Traits: ${[...G.drawbacks, ...G.quirks].map(x => x.name).join(', ')}` : '',
        ...G.gear.map(x => `${x.kind === 'weapon' ? 'Weapon' : 'Armour'}: ${x.name} (${dmGearText(x)}), in Attacks and armour`),
        ...Object.entries(G.tweaks).map(([k, tw]) => { const it = c.items.find(i => i.id === k); return it ? `${it.name || 'An item'}: ${tweakText(tw)}` : ''; }),
        G.arm.def || G.arm.minHit || G.arm.thp ? `Armour: ${dmArmText(G.arm)}` : ''].filter(Boolean);
      if (extras.length) kids.push(el('ul', { class: 'cc-gains' }, ...extras.map(t => el('li', {}, t))));
      if (!kids.length) kids.push(el('p', { class: 'd-note' }, 'Nothing yet. Marks, bonus feats, skill ranks, traits and gear your DM gives this character show here.'));
      const tools = dmTools(c, d);
      return tools ? [...kids, tools] : kids;
    }
    const dmGearText = x => x.kind === 'weapon' ? [x.dice || 'no damage', x.stat, x.hands === 2 ? 'two-handed' : ''].filter(Boolean).join(' · ')
      : [SLOT_LABEL[x.slot], x.def ? `Defence +${x.def}` : '', x.minHit ? `Min hit ${x.minHit}` : '', x.thp ? `${x.thp} temp HP` : ''].filter(Boolean).join(' · ');
    function dmTools(c, d) {
      if (!admin() || !cur || !cur.id) return null;
      const id = cur.id;
      if (grantsMissing) return el('p', { class: 'notice' }, 'Run the latest supabase/setup.sql to give characters feats, skills, traits and Marks.');
      if (GRANTS.get(id) === null) return el('p', { class: 'bs-fine' }, 'Opening…');
      const G = JSON.parse(JSON.stringify(d.grants));
      const save = () => saveGrants(id, G);
      const add = (k, x) => { G[k] = [...G[k], { id: gid(), ...x }]; save(); };
      const drop = (k, x) => () => { G[k] = G[k].filter(y => y.id !== x.id); save(); };
      const L = traitLists();
      const giveFeat = () => picker({
        title: 'Give a feat', note: 'Give a feat outright, or an extra pick the player chooses (up to the tier you set; Renown doesn’t hold it back).',
        groups: [{ label: 'An extra pick (the player chooses)', options: [1, 2, 3, 4, 5].map(t => ({ value: 'pick:' + t, name: `A feat up to Tier ${romanOf(t)}`, meta: 'Player chooses' })) },
          ...[...new Set(featList().map(f => f.cat))].map(cat => ({ label: cat, options: featList().filter(f => f.cat === cat).map(f => ({ value: f.name, name: f.name, meta: `Tier ${romanOf(f.tier)}`, text: f.effect, why: G.feats.some(x => x.name === f.name) ? 'Already given' : '' })) }))],
        onPick: v => { if (String(v).startsWith('pick:')) add('featPicks', { tier: num(String(v).slice(5)) }); else add('feats', { name: v }); } });
      const giveSkill = () => picker({
        title: 'Give soft skill ranks', note: 'Give ranks in a skill (on top of the player’s own), or extra ranks for the player to spend.',
        groups: [{ label: 'Extra ranks (the player chooses)', options: [{ value: 'pick', name: 'One extra rank to spend', meta: 'Player chooses' }] },
          ...[...new Set(skillList().map(x => x.family))].map(f => ({ label: f, options: skillList().filter(x => x.family === f).map(sk => ({ value: sk.name, name: sk.name, meta: sk.renown > 1 ? `Renown ${sk.renown}` : '' })) }))],
        onPick: v => { if (v === 'pick') { G.skillPicks += 1; save(); return; } const hit = G.skills.find(x => x.name === v); if (hit) { hit.ranks = Math.min(5, hit.ranks + 1); save(); } else add('skills', { name: v, ranks: 1 }); } });
      const giveTrait = () => picker({
        title: 'Give a drawback or quirk', note: 'Drawbacks you give don’t give SP back unless you tick it, and don’t use up the player’s two picks.',
        groups: [{ label: 'Drawbacks', options: L.drawbacks.map(x => ({ value: 'd:' + x.name, name: x.name, meta: `${x.sp} SP`, text: plain(x.text) })) },
          { label: 'Mythic Drawbacks', options: L.mythicDrawbacks.map(x => ({ value: 'd:' + x.name, name: x.name, meta: [x.needs, `${x.sp} SP`].filter(Boolean).join(' · '), text: plain(x.text) })) },
          { label: 'Quirks', options: L.quirks.map(x => ({ value: 'q:' + x.name, name: x.name, text: `${x.gain}; ${x.cost}` })) }],
        onPick: v => { const n = String(v).slice(2); if (v.startsWith('d:')) add('drawbacks', { name: n }); else add('quirks', { name: n }); } });
      const giveMark = () => picker({
        title: 'Award a Mark', note: 'Then write the deed that earned it. Marks are never bought, and there’s no limit.',
        groups: [{ label: 'Your own', options: [{ value: '', name: 'Write your own Mark…', meta: 'Custom' }] },
          { label: 'Marks', options: L.marks.map(x => ({ value: x.name, name: x.name, meta: x.earned, text: plain(x.text) })) },
          { label: 'Mythic Marks', options: L.mythicMarks.map(x => ({ value: x.name, name: x.name, meta: [x.needs, x.earned].filter(Boolean).join(' · '), text: plain(x.text), why: G.marks.some(m => m.name === x.name) ? 'Already awarded' : '' })) }],
        onPick: v => { markDraft = { name: v || '', deed: '', text: '', custom: !v }; render(); } });
      const rowBtns = (...b) => el('span', { class: 'cc-card-btns' }, ...b);
      const list = [
        ...G.feats.map(x => el('li', {}, el('span', {}, `Feat: ${x.name}`), rowBtns(el('button', { class: 'mini danger', onclick: drop('feats', x) }, 'Remove')))),
        ...G.featPicks.map(x => el('li', {}, el('span', {}, `An extra feat up to Tier ${romanOf(x.tier)}${c.lv.feats['G' + x.id] ? ` (they chose ${c.lv.feats['G' + x.id]})` : ' (not chosen yet)'}`), rowBtns(el('button', { class: 'mini danger', onclick: drop('featPicks', x) }, 'Remove')))),
        ...G.skills.map(x => el('li', {}, el('span', {}, `${x.name} +${x.ranks}`), rowBtns(
          el('button', { class: 'mini', 'aria-label': `One rank less in ${x.name}`, onclick: () => { x.ranks -= 1; if (x.ranks <= 0) G.skills = G.skills.filter(y => y.id !== x.id); save(); } }, '−'),
          el('button', { class: 'mini', 'aria-label': `One rank more in ${x.name}`, disabled: x.ranks >= 5, onclick: () => { x.ranks += 1; save(); } }, '+')))),
        G.skillPicks ? el('li', {}, el('span', {}, `${G.skillPicks} extra skill rank${G.skillPicks === 1 ? '' : 's'} to spend`), rowBtns(
          el('button', { class: 'mini', 'aria-label': 'One extra rank less', onclick: () => { G.skillPicks -= 1; save(); } }, '−'),
          el('button', { class: 'mini', 'aria-label': 'One extra rank more', onclick: () => { G.skillPicks += 1; save(); } }, '+'))) : null,
        ...G.drawbacks.map(x => { const D = [...L.drawbacks, ...L.mythicDrawbacks].find(y => y.name === x.name); return el('li', {}, el('span', {}, `Drawback: ${x.name}`),
          D && D.sp ? el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: !!x.sp, onchange: e => { x.sp = e.target.checked; save(); } }), ` Gives its ${D.sp} SP back`) : null,
          rowBtns(el('button', { class: 'mini danger', onclick: drop('drawbacks', x) }, 'Remove'))); }),
        ...G.quirks.map(x => el('li', {}, el('span', {}, `Quirk: ${x.name}`), rowBtns(el('button', { class: 'mini danger', onclick: drop('quirks', x) }, 'Remove')))),
        ...G.marks.map(x => el('li', {}, el('span', {}, `Mark: ${x.name}${x.deed ? ` (${x.deed})` : ''}`), rowBtns(el('button', { class: 'mini danger', onclick: drop('marks', x) }, 'Remove')))),
        ...G.other.map(x => el('li', {}, el('span', {}, x.name), rowBtns(el('button', { class: 'mini danger', onclick: drop('other', x) }, 'Remove')))),
        ...G.gear.map(x => el('li', {}, el('span', {}, `${x.kind === 'weapon' ? 'Weapon' : 'Armour'}: ${x.name} (${dmGearText(x)})`), rowBtns(
          el('button', { class: 'mini', onclick: () => { gearDraft = { ...x, edit: x.id }; render(); } }, 'Edit'),
          el('button', { class: 'mini danger', onclick: drop('gear', x) }, 'Remove')))),
        ...Object.entries(G.tweaks).map(([k, tw]) => { const it = c.items.find(i => i.id === k); return el('li', {}, el('span', {}, `${it ? it.name || 'An item' : 'An item they no longer have'}: ${tweakText(tw)}`), rowBtns(
          it ? el('button', { class: 'mini', onclick: () => { tweakDraft = tweakStart(it, tw); render(); } }, 'Edit') : null,
          el('button', { class: 'mini danger', onclick: () => { delete G.tweaks[k]; save(); } }, it ? 'Back to its own numbers' : 'Remove'))); }),
      ].filter(Boolean);
      // ---- gear: make up a weapon or armour, or set the numbers of something they carry ----
      const numIn = (o, k, lab, opts = {}) => el('label', { class: 'field' }, el('span', { class: 'k' }, lab),
        el('input', { type: opts.text ? 'text' : 'number', class: opts.text ? '' : 'num', value: o[k] == null ? '' : String(o[k]), placeholder: opts.ph || '', maxlength: '30', ...(opts.text ? {} : { min: String(opts.min == null ? 0 : opts.min) }),
          oninput: e => { o[k] = e.target.value; if (opts.dice) e.target.classList.toggle('bad', !!e.target.value && !diceOk(e.target.value)); } }));
      const statSel = (o, blank) => el('label', { class: 'field' }, el('span', { class: 'k' }, 'Hits with'),
        el('select', { class: 'select', onchange: e => { o.stat = e.target.value; } }, ...(blank ? [el('option', { value: '', selected: !o.stat }, 'Keep as it is')] : []),
          ...['Melee', 'Ranged', 'Casting'].map(v => el('option', { value: v, selected: o.stat === v }, v))));
      const GD = gearDraft;
      const gearForm = GD ? el('div', { class: 'cc-dmform' },
        el('div', { class: 'cc-row' },
          el('label', { class: 'field' }, el('span', { class: 'k' }, 'Kind'), el('select', { class: 'select', onchange: e => { GD.kind = e.target.value; render(); } },
            el('option', { value: 'weapon', selected: GD.kind === 'weapon' }, 'Weapon'), el('option', { value: 'armour', selected: GD.kind === 'armour' }, 'Armour or shield'))),
          el('label', { class: 'field' }, el('span', { class: 'k' }, 'Name'), el('input', { type: 'text', value: GD.name, maxlength: '120', placeholder: GD.kind === 'weapon' ? 'Starfall greatsword' : 'Warden’s plate', oninput: e => { GD.name = e.target.value; } }))),
        GD.kind === 'weapon' ? el('div', { class: 'cc-row' },
          numIn(GD, 'dice', 'Damage dice', { text: true, dice: true, ph: '1d75+4' }), statSel(GD),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: GD.hands === 2, onchange: e => { GD.hands = e.target.checked ? 2 : 1; } }), ' Two-handed'))
        : el('div', { class: 'cc-row' },
          el('label', { class: 'field' }, el('span', { class: 'k' }, 'Worn on'), el('select', { class: 'select', onchange: e => { GD.slot = e.target.value; } }, ...SLOTS.filter(([k]) => k !== 'mount').map(([k, v]) => el('option', { value: k, selected: GD.slot === k }, v)))),
          numIn(GD, 'def', 'Defence'), numIn(GD, 'minHit', 'Min hit'), numIn(GD, 'thp', 'Temp HP')),
        el('label', { class: 'field' }, el('span', { class: 'k' }, 'Notes (shown with it)'), el('input', { type: 'text', value: GD.notes || '', maxlength: '200', placeholder: GD.kind === 'weapon' ? 'Reach 10 ft; on a hit, 1d4 status dice of Burn' : 'Resistance to fire', oninput: e => { GD.notes = e.target.value; } })),
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small primary', onclick: () => {
            if (!String(GD.name || '').trim()) { grantMsg = 'Give it a name.'; render(); return; }
            if (GD.kind === 'weapon' && GD.dice && !diceOk(GD.dice)) { grantMsg = 'Write the damage like 1d30, 2d50+3 or 1d75 (up to 1000 sides).'; render(); return; }
            const x = { id: GD.edit || gid(), name: GD.name.trim(), ...dmGearNums(GD) };
            G.gear = GD.edit ? G.gear.map(y => y.id === GD.edit ? x : y) : [...G.gear, x];
            gearDraft = null; grantMsg = ''; save(); } }, GD.edit ? 'Save it' : 'Give it'),
          el('button', { class: 'mini', onclick: () => { gearDraft = null; grantMsg = ''; render(); } }, 'Cancel'))) : null;
      const TD = tweakDraft, tIt = TD ? c.items.find(i => i.id === TD.item) : null;
      const tweakForm = TD && tIt ? el('div', { class: 'cc-dmform' },
        el('p', {}, el('strong', {}, tIt.name || 'Item'), ' ', el('span', { class: 'bs-fine' }, `Now: ${TD.now}. Leave a box empty to keep the item’s own number; what you set is final (quality and material aren’t added on top).`)),
        TD.kind === 'weapon' ? el('div', { class: 'cc-row' }, numIn(TD, 'dice', 'Damage dice', { text: true, dice: true, ph: '1d50' }), statSel(TD, true))
          : el('div', { class: 'cc-row' }, numIn(TD, 'def', 'Defence'), numIn(TD, 'minHit', 'Min hit'), numIn(TD, 'thp', 'Temp HP')),
        el('label', { class: 'field' }, el('span', { class: 'k' }, 'Notes (shown with it)'), el('input', { type: 'text', value: TD.notes || '', maxlength: '200', placeholder: 'Blessed at the shrine', oninput: e => { TD.notes = e.target.value; } })),
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small primary', onclick: () => {
            if (TD.dice && !diceOk(TD.dice)) { grantMsg = 'Write the damage like 1d30, 2d50+3 or 1d75 (up to 1000 sides).'; render(); return; }
            const o = dmTweakNums(TD);
            if (Object.keys(o).length) G.tweaks = { ...G.tweaks, [TD.item]: o }; else delete G.tweaks[TD.item];
            tweakDraft = null; grantMsg = ''; save(); } }, 'Set it'),
          el('button', { class: 'mini', onclick: () => { tweakDraft = null; grantMsg = ''; render(); } }, 'Cancel'))) : null;
      const fightItems = c.items.map(it => ({ it, g: gearOf(it) })).filter(x => x.g && (x.g.kind === 'weapon' || x.g.kind === 'armour'));
      const changeItem = () => picker({
        title: 'Set an item’s numbers', note: 'Pick a weapon or armour this character carries, then set its numbers. The player can’t change what you set.',
        empty: 'They carry no weapons or armour yet.',
        groups: [{ label: 'Weapons', options: fightItems.filter(x => x.g.kind === 'weapon').map(x => ({ value: x.it.id, name: x.it.name || 'Weapon', meta: x.it.on ? 'Equipped' : '', text: gearLine(x.g, x.it) })) },
          { label: 'Armour', options: fightItems.filter(x => x.g.kind === 'armour').map(x => ({ value: x.it.id, name: x.it.name || 'Armour', meta: x.it.on ? 'Equipped' : '', text: gearLine(x.g, x.it) })) }].filter(g => g.options.length),
        onPick: v => { const it = c.items.find(i => i.id === v); if (it) { tweakDraft = tweakStart(it, G.tweaks[v]); render(); } } });
      const M = markDraft;
      const markForm = M ? el('div', { class: 'cc-dmform' },
        M.custom ? el('label', { class: 'field' }, el('span', { class: 'k' }, 'Mark'), el('input', { type: 'text', value: M.name, maxlength: '120', placeholder: 'Ashwalker', oninput: e => { M.name = e.target.value; } })) : el('p', {}, el('strong', {}, M.name), ' ', el('span', { class: 'bs-fine' }, markText(M))),
        M.custom ? el('label', { class: 'field' }, el('span', { class: 'k' }, 'What it does'), el('input', { type: 'text', value: M.text, maxlength: '600', placeholder: 'Resistance to fire; +2 to rolls in burning places', oninput: e => { M.text = e.target.value; } })) : null,
        el('label', { class: 'field' }, el('span', { class: 'k' }, 'Earned for'), el('input', { type: 'text', value: M.deed, maxlength: '300', placeholder: 'Walking out of the burning mill', oninput: e => { M.deed = e.target.value; } })),
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small primary', onclick: () => { if (!M.name.trim()) return; add('marks', { name: M.name.trim(), deed: M.deed.trim(), ...(M.custom && M.text.trim() ? { text: M.text.trim() } : {}), at: new Date().toISOString() }); markDraft = null; } }, 'Award it'),
          el('button', { class: 'mini', onclick: () => { markDraft = null; render(); } }, 'Cancel'))) : null;
      const O = otherDraft;
      const otherForm = O ? el('div', { class: 'cc-dmform' },
        el('label', { class: 'field' }, el('span', { class: 'k' }, 'Name'), el('input', { type: 'text', value: O.name, maxlength: '120', placeholder: 'Blessing of the Tide', oninput: e => { O.name = e.target.value; } })),
        el('label', { class: 'field' }, el('span', { class: 'k' }, 'What it does'), el('textarea', { rows: '2', maxlength: '1000', oninput: e => { O.text = e.target.value; } }, O.text)),
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small primary', onclick: () => { if (!O.name.trim()) return; add('other', { name: O.name.trim(), text: O.text.trim() }); otherDraft = null; } }, 'Give it'),
          el('button', { class: 'mini', onclick: () => { otherDraft = null; render(); } }, 'Cancel'))) : null;
      return el('div', { class: 'cc-dmtools' },
        el('h3', { class: 'cc-h3' }, 'Give this character something (only you can)'),
        grantMsg ? el('p', { class: 'notes-msg' + (/^Saved/.test(grantMsg) ? ' ok' : ''), role: 'status' }, grantMsg) : null,
        el('div', { class: 'cc-row' },
          el('button', { class: 'btn small', onclick: giveFeat }, '+ A feat'),
          el('button', { class: 'btn small', onclick: giveSkill }, '+ Soft skill ranks'),
          el('button', { class: 'btn small', onclick: giveTrait }, '+ A drawback or quirk'),
          el('button', { class: 'btn small primary', onclick: giveMark }, '+ Award a Mark'),
          el('button', { class: 'btn small', onclick: () => { otherDraft = { name: '', text: '' }; render(); } }, '+ Something else'),
          el('button', { class: 'btn small', onclick: () => { gearDraft = { kind: 'weapon', name: '', dice: '', stat: 'Melee', hands: 1, slot: 'body', def: '', minHit: '', thp: '', notes: '' }; tweakDraft = null; render(); } }, '+ A weapon or armour'),
          el('button', { class: 'btn small', onclick: changeItem }, 'Set an item’s numbers')),
        el('div', { class: 'cc-row cc-dmnums' },
          el('label', { class: 'cc-dmsp' }, el('span', { class: 'k' }, 'Extra SP'), el('input', { type: 'number', class: 'num', min: '-50', max: '50', value: String(G.sp), onchange: e => { G.sp = num(e.target.value); save(); } })),
          ...[['def', 'Extra Defence'], ['minHit', 'Extra Min hit'], ['thp', 'Extra temp HP']].map(([k, lab]) => el('label', { class: 'cc-dmsp' }, el('span', { class: 'k' }, lab),
            el('input', { type: 'number', class: 'num', min: k === 'thp' ? '-500' : '-50', max: k === 'thp' ? '500' : '100', value: String(G.arm[k]), 'aria-label': lab, onchange: e => { G.arm = { ...G.arm, [k]: num(e.target.value) }; save(); } })))),
        markForm, otherForm, gearForm, tweakForm,
        list.length ? el('ul', { class: 'cc-dmlist' }, ...list) : el('p', { class: 'hint' }, 'Nothing given yet.'));
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
      const vitals = [['HP', String(d.hp)], ['Hit die', bestDie(d) || '—'], ['Defence', d.defence ? `+${d.defence}` : ((d.cls && d.cls.meta.defence) || '—')], ...(d.minHit ? [['Min hit', String(d.minHit)]] : []),
        ...(d.gear.worn.length ? [['Armour', d.gear.worn.map(w => w.name).join(', ')]] : []), ...d.gear.worn.filter(w => w.fx).map(w => [`${w.name} (${w.mat})`, w.fx]), ...(d.armourThp ? [['Temp HP from armour', `${d.armourThp} (back on a long rest)`]] : []),
        ['Trained with', weapons || '—'], ['Languages', [d.r && d.r.meta.languages, d.r2 && d.r2.meta.languages].filter(Boolean).join(', ') || '—'],
        ['Renown', String(d.R)], ['SP', `${d.spent} spent of ${d.total}`], ...(d.fp ? [['FP', String(d.fp)]] : [])];
      if (c.age) vitals.splice(0, 0, ['Age', c.age]);
      out.blocks.push({ h: 'At a glance', pairs: vitals });
      const atks = d.attacks;
      if (atks.length) {
        const sv = k => { const st = d.stats.find(x => x.k === k); return st && st.final != null ? st.final : '—'; };
        out.blocks.push({ h: 'Attacks', grid: [['Attack', 'Hits on', 'Damage', 'Notes'], ...atks.map(a => [a.name.trim() || 'Attack', `${a.stat} ${sv(a.stat)}${a.untrained ? ' (disadvantage: not trained)' : ''}`, a.dice.trim() || '—', a.notes.trim()])] });
      }
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
        // class-wide benefits and subclass feats: one line per benefit or ability, like every other ability on the sheet
        if (slot.g && c.buys.general[slot.g.key]) items.push({ name: `${slot.g.title}: class-wide benefits`, text: '' }, ...bulletsOf(slot.g.intro));
        if (slot.g) for (const sub of slot.g.items) {
          if (slot.magic && c.buys.feat[sub.id]) {
            const ab = abilities(sub);
            items.push({ name: `${sub.name} (subclass feat)`, text: ab.length ? '' : plain(sub.body) }, ...ab.map(a => ({ name: a.name, text: plain(a.text), sub: true })));
          }
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
      const feats = [...d.featSlots.map(sl => featList().find(f => f.name === c.lv.feats[sl.key])).filter(Boolean), ...d.dmFeats];
      if (feats.length) out.blocks.push({ h: 'Feats', items: feats.map(f => ({ name: `${f.name}${f.tier ? ` (Tier ${romanOf(f.tier)})` : ''}${f.given ? ' (from the DM)' : ''}`, text: f.effect })) });
      const skAll = { ...c.lv.skills };
      for (const [n, r] of Object.entries(d.dmSkills)) skAll[n] = num(skAll[n]) + r;
      const sk = Object.entries(skAll).filter(([, r]) => num(r) > 0).sort((a, b) => num(b[1]) - num(a[1]) || a[0].localeCompare(b[0]));
      if (sk.length) out.blocks.push({ h: 'Soft skills', pairs: sk.map(([n, r]) => [n, `${RANKS[num(r)]} (+${2 * num(r)})`]) });
      const BOON = { combat: 'Improved a combat stat', skills2: 'Gained 2 soft skill ranks', retrain: 'Retrained', pastMaster: 'Gained a rank past Master', tier4: 'Took a Tier IV feat', combat2: 'Improved two combat stats', tier5: 'Took a Tier V feat', mark: 'Claimed a Mythic Mark' };
      const bl = d.boons.filter(b => b.type);
      if (bl.length) out.blocks.push({ h: 'Milestone boons', items: bl.map(b => ({ name: `Level ${b.lvl}`, text: `${BOON[b.type]}${b.stat ? ': ' + [b.stat, b.stat2].filter(Boolean).join(', ') : ''}${b.note ? ' (' + b.note + ')' : ''}.` })) });
      if (d.grants.marks.length) out.blocks.push({ h: 'Marks', items: d.grants.marks.map(m => ({ name: m.name, text: [m.deed ? `For ${m.deed.replace(/^for\s+/i, '')}.` : '', markText(m)].filter(Boolean).join(' ') })) });
      if (d.grants.other.length) out.blocks.push({ h: 'From the DM', items: d.grants.other.map(x => ({ name: x.name, text: x.text || '' })) });
      if (d.dSel.length || d.qSel.length || d.dGiven.length) out.blocks.push({ h: 'Drawbacks and quirks', items: [
        ...d.dSel.map(x => ({ name: `${x.name} (drawback, ${x.sp} SP back)`, text: plain(x.text) })),
        ...d.dGiven.map(x => ({ name: `${x.name} (drawback${x.spBack && x.sp ? `, ${x.sp} SP back` : ''}, from the DM)`, text: [plain(x.text), x.note].filter(Boolean).join(' ') })),
        ...d.qSel.map(x => ({ name: `${x.name} (quirk${x.given ? ', from the DM' : ''})`, text: `${x.gain}; ${x.cost}` }))] });
      const inv = c.items.filter(x => x.name.trim());
      if (inv.length) {
        const sorted = [...inv.filter(x => x.on), ...inv.filter(x => !x.on)];
        out.blocks.push({ h: 'Inventory', grid: [['Item', 'Qty', 'Notes'], ...sorted.map(x => [x.name.trim() + (x.q && x.q !== 'Normal' ? ` (${x.q})` : '') + (x.on ? ' (equipped)' : ''), String(x.qty),
          [gearLine(gearOf(x), x), x.notes.trim()].filter(Boolean).join(' · ')])] });
      }
      if (c.gear) out.blocks.push({ h: 'Starting gear', text: c.gear });
      if (c.equipment) out.blocks.push({ h: 'Equipment', text: c.equipment });
      if (c.notes) out.blocks.push({ h: 'Notes', text: c.notes });
      // table order: what you need mid-fight first (HP, attacks, stats), then abilities and spells, then gear, then background
      const RANK = { 'At a glance': 0, 'Attacks': 1, 'Stats': 2, 'Combat stats': 3, 'Soft skills': 6, 'Milestone boons': 7, 'Marks': 7, 'From the DM': 7, 'Drawbacks and quirks': 8, 'Inventory': 9, 'Starting gear': 9, 'Equipment': 9, 'Background': 10, 'Notes': 11 };
      out.blocks = out.blocks.map((b, i) => ({ b, i, r: RANK[b.h] == null ? 5 : RANK[b.h] })).sort((x, y) => x.r - y.r || x.i - y.i).map(x => x.b);
      return out;
    }

    function sheetHTML(data) {
      const kids = [el('header', { class: 'sh-head' }, el('h1', {}, data.title), el('p', {}, data.subtitle))];
      for (const b of data.blocks) {
        const sec = el('section', { class: 'sh-block' + (b.table ? ' sh-stats' : ''), 'data-h': b.h }, el('h2', {}, b.h));
        if (b.table) sec.append(el('div', { class: 'sh-statrow', style: `grid-template-columns: repeat(${b.table[0].length - 1}, minmax(0, 1fr))` }, ...b.table[0].slice(1).map((k, i) => el('div', { class: 'sh-stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, b.table[1][i + 1])))), b.note ? el('p', { class: 'sh-note' }, b.note) : '');
        if (b.grid) sec.append(el('table', { class: 'sh-table' }, el('thead', {}, el('tr', {}, ...b.grid[0].map(t => el('th', {}, t)))),
          el('tbody', {}, ...b.grid.slice(1).map(r => el('tr', {}, ...r.map(t => el('td', {}, t)))))));
        if (b.pairs) sec.append(el('dl', { class: 'sh-pairs' }, ...b.pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
        if (b.text) sec.append(...b.text.split(/\n+/).map(t => el('p', {}, t)));
        if (b.items) sec.append(...b.items.map(it => el('p', { class: 'sh-item' + (it.sub ? ' sh-sub' : '') }, it.name ? el('strong', {}, it.text ? it.name + '. ' : it.name) : null, it.text)));
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
        if (b.items) for (const it of b.items) out.push(para((it.sub ? run('• ') : '') + (it.name ? run(it.text ? it.name + '. ' : it.name, { b: true }) : '') + run(it.text)));
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
      // the home page's "Play mode" button
      openPlay: id => { wantPlay = id; if (cur && cur.id === id) { mode = 'play'; wantPlay = ''; } go({ tab: 'chars', char: id }, true); },
      maxHp: data => { try { return derived(normalize(JSON.parse(JSON.stringify(data || {})))).hp; } catch (e) { return 0; } },
      // the signed-in player's own saved characters, for the home page (null until the list has loaded)
      mine: () => { if (!list) { refreshList().then(() => { if (state.tab === 'all') render(); }); return null; } return user() ? list.filter(r => r.owner_id === user().id) : []; },
      // what the balance lab needs: HP, level, combat stats (null when not rolled yet) and class defence
      fightStats: data => {
        try {
          const d = derived(normalize(JSON.parse(JSON.stringify(data || {}))));
          const st = Object.fromEntries(d.stats.map(s => [s.k.toLowerCase(), s.final]));
          const c = normalize(JSON.parse(JSON.stringify(data || {})));
          const attacks = d.attacks.filter(a => diceOk(a.dice)).map(a => ({ name: a.name || 'Attack', stat: a.stat, dice: a.dice.replace(/\s/g, ''), hit: st[a.stat.toLowerCase()], ...(a.untrained ? { dis: true } : {}) }));
          return { hp: d.hp, level: d.L, melee: st.melee, ranged: st.ranged, casting: st.casting, dodge: st.dodge, defence: d.defence, minHit: d.minHit, thp: d.armourThp, attacks };
        } catch (e) { return null; }
      },
      _test: { sheetData, docxFiles, derived, blank, normalize, featList, skillList, RULES, abilities, traitLists, current: () => cur },
    };
  };
})();
