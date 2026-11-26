/* Balance lab (DM only): runs an encounter many times against your real party, and checks every creature's KR
   against a standard party. The bestiary data comes from bestiary.js (Supabase, admins only); nothing is stored here.
   The engine at the top has no page code in it, so it can be tested on its own. */
(function () {
  'use strict';

  /* ================= engine ================= */

  function rngOf(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // "2d6+3", "d8", "12": { n, s, b }, or null
  function dice(str) {
    const t = String(str == null ? '' : str).replace(/\s+/g, '').toLowerCase();
    let m = t.match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (m) return { n: Math.max(1, +(m[1] || 1)), s: +m[2], b: +(m[3] || 0) };
    m = t.match(/^\d+(\.\d+)?$/);
    if (m) return { n: 0, s: 0, b: +t };
    return null;
  }
  const avg = d => d ? d.n * (d.s + 1) / 2 + d.b : 0;
  function roll(d, R, crit) {
    let x = d.b;
    const k = crit ? 2 : 1;
    for (let j = 0; j < d.n * k; j++) x += 1 + Math.floor(R() * d.s);
    return Math.max(0, x);
  }

  // roll-under stats, lower is better: a roll succeeds on a d20 of the stat or more. A natural 1 fails, a natural 20 succeeds.
  const pRoll = need => clamp((21 - need) / 20, 0.05, 0.95);
  const pDodge = dodge => dodge == null ? 0 : pRoll(dodge);

  const AREA_RE = /\b(every|everyone|each creature|all creatures|cone|line|area|within \d+ ft|in its space|burst|wave|aura)\b/i;
  const RANGED_RE = /\brange \d+/i;
  const SKIP_LIMIT = /reaction|passive|bonus|when it chooses|a day|heal/i;

  function tempoOf(traits) {
    let n = 0;
    for (const t of traits || []) {
      if (t.struck || !/Tempo/.test(t.name || '')) continue;
      const tx = (t.text || '').toLowerCase();
      const m = tx.match(/tempo\s*(\d)/);
      n += m ? +m[1] : /four times/.test(tx) ? 3 : /three times/.test(tx) ? 2 : 1;
    }
    return n;
  }

  // the hits in one attack line. A Multiattack makes each listed attack ("Claws ×2, 2d12 each" is two hits).
  function hitsOf(a, alpha) {
    const text = a.text || '';
    const out = [];
    let from = 0;
    const area = AREA_RE.test(text), ranged = RANGED_RE.test(text);
    const lim = String(a.limit || '');
    const times = !a.multiattack && /^×\s*(\d)/.test(lim) ? +lim.match(/^×\s*(\d)/)[1] : 1;
    for (const ds of a.damage || []) {
      const d = dice(ds);
      if (!d) continue;
      if (alpha && d.n) d.n += 1;                     // Alpha: one more of each damage die
      let rep = 1;
      if (a.multiattack) {
        const at = text.indexOf(ds, from);
        const seg = at >= 0 ? text.slice(from, at) : '';
        const m = seg.match(/×\s*(\d)/);
        if (m) rep = +m[1];
        if (at >= 0) from = at + ds.length;
      }
      for (let k = 0; k < rep * times; k++) out.push({ d, area, ranged });
    }
    // a single (non-multi) attack with several dice is one hit for their total
    if (!a.multiattack && times === 1 && out.length > 1) {
      const d = { n: 0, s: 0, b: 0, parts: out.map(h => h.d) };
      return [{ d, parts: out.map(h => h.d), area, ranged }];
    }
    return out;
  }
  const hitAvg = h => h.parts ? h.parts.reduce((x, d) => x + avg(d), 0) : avg(h.d);
  const hitRoll = (h, R, crit) => h.parts ? h.parts.reduce((x, d) => x + roll(d, R, crit), 0) : roll(h.d, R, crit);

  /* A creature as it fights here. `v` is a stat block as the card shows it (bestiary.js view()), templates applied. */
  function fromCreature(v, label) {
    const tpl = v.tpl || [];
    const alpha = tpl.includes('alpha'), minion = tpl.includes('minion'), boss = tpl.includes('boss');
    const cb = v.combat || {};
    const acts = [];
    for (const a of v.attacks || []) {
      if (a.struck) continue;
      const lim = String(a.limit || '');
      if (SKIP_LIMIT.test(lim) || /^as /i.test(lim)) continue;
      if (minion && a.recharge) continue;
      const hits = hitsOf(a, alpha);
      if (!hits.length) continue;
      const once = /once/i.test(lim), free = /each (turn|round)/i.test(lim);
      acts.push({ name: a.name, hits, multi: !!a.multiattack, recharge: a.recharge ? +a.recharge : 0, once, free });
    }
    if (minion) for (const a of acts) for (const h of a.hits) { const m = Math.floor(hitAvg(h)); h.d = { n: 0, s: 0, b: m }; delete h.parts; }
    const role = String(v.role || ''), base = v.base || v;
    const swarm = /swarm/i.test(role) || (base.tags || []).some(t => /swarm/i.test(t)) || /\bswarm\b/i.test(base.typeLine || '');
    return {
      side: 'foe', name: label || v.name, hp: minion ? 1 : Math.max(1, Math.round(v.hp || 1)), level: null, kr: v.kr,
      melee: cb.melee, ranged: cb.ranged, casting: cb.casting, dodge: cb.dodge == null ? null : cb.dodge,
      defence: v.defence || 0, minHit: v.minHit || 0, swarm, solo: /solo/i.test(role) || boss,
      tempo: minion ? 0 : tempoOf(v.traits) + (boss ? 1 : 0), acts,
    };
  }

  function adventurer(o) {
    return { side: 'party', name: o.name, hp: Math.max(1, Math.round(o.hp)), level: o.level, melee: o.hit, ranged: null, casting: null,
      dodge: o.dodge, defence: o.defence || 0, minHit: o.minHit || 0, dmg: o.dmg, dmgAvg: o.dmgAvg, acts: [] };
  }
  const hitStatFor = (c, h) => {
    const order = h && h.ranged ? [c.ranged, c.casting, c.melee] : [c.melee, c.ranged, c.casting];
    const s = order.find(x => x != null);
    return s == null ? 10 : s;
  };

  /* ---- one fight ---- */
  function fight(partySpec, foeSpec, opt, R, log) {
    const mk = (s, i) => ({ ...s, i, cur: s.hp, down: false, dodges: 0, rech: {}, used: {}, dealt: 0, init: R() * 20 });
    const party = partySpec.map(mk), foes = foeSpec.map(mk);
    const all = [...party, ...foes].sort((a, b) => b.init - a.init);
    const alive = side => (side === 'party' ? party : foes).filter(x => !x.down);
    const L = log ? (s => { if (log.length < 400) log.push(s); }) : null;
    const pick = (atk) => {
      if (atk.side === 'party') {
        const t = alive('foe');
        if (!t.length) return null;
        return opt.focus === 'random' ? t[Math.floor(R() * t.length)] : t.reduce((a, b) => (b.cur < a.cur ? b : a));
      }
      const t = alive('party');
      if (!t.length) return null;
      if (opt.target === 'weakest') return t.reduce((a, b) => (b.cur < a.cur ? b : a));
      if (opt.target === 'toughest') return t.reduce((a, b) => (b.cur > a.cur ? b : a));
      return t[Math.floor(R() * t.length)];
    };
    const harm = (atk, tgt, amount, what) => {
      if (amount <= 0 || tgt.down) return;
      const before = tgt.cur;
      tgt.cur = Math.max(0, tgt.cur - amount);
      atk.dealt += before - tgt.cur;
      if (L) L(`${atk.name} → ${tgt.name}: ${what} ${amount}${tgt.cur ? ` (${tgt.cur} left)` : ', down'}`);
      if (!tgt.cur) tgt.down = true;
    };
    // a single attack roll: hit, then the target's Dodge (one a round), then Min hit (weapon hits only)
    const strike = (atk, tgt, h, weapon) => {
      const need = hitStatFor(atk, h) + (tgt.defence || 0);
      const r = 1 + Math.floor(R() * 20);
      const hit = r === 20 || (r !== 1 && r >= need);
      if (!hit) { if (L) L(`${atk.name} → ${tgt.name}: miss`); return false; }
      const crit = opt.crits && r === 20;
      if (tgt.dodge != null && tgt.dodges < opt.dodges) {
        tgt.dodges++;
        const dr = 1 + Math.floor(R() * 20);
        if (dr === 20 || (dr !== 1 && dr >= tgt.dodge)) { if (L) L(`${atk.name} → ${tgt.name}: dodged`); return false; }
      }
      let dmg = atk.side === 'party' ? partyDamage(atk, R, crit) : hitRoll(h, R, crit);
      if (atk.side === 'foe' && atk.swarm && atk.cur < atk.hp / 2) dmg = Math.floor(dmg / 2);
      if (atk.side === 'party' && tgt.swarm) dmg = Math.floor(dmg / 2);
      if (weapon && dmg < (tgt.minHit || 0)) { if (L) L(`${atk.name} → ${tgt.name}: ${dmg} doesn’t beat Min hit ${tgt.minHit}`); return true; }
      harm(atk, tgt, dmg, crit ? 'critical' : 'hit');
      return true;
    };
    const partyDamage = (a, R2, crit) => {
      if (a.dmg) return roll(a.dmg, R2, crit) ;
      const x = Math.round(a.dmgAvg * (0.5 + R2())) * (crit ? 2 : 1);
      return Math.max(1, x);
    };
    // an area hit: no attack roll; each target in it (up to opt.area) halves the damage with a Dodge roll
    const blast = (atk, h) => {
      const t = alive('party');
      for (let k = t.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [t[k], t[j]] = [t[j], t[k]]; }
      const dmg0 = hitRoll(h, R, false);
      for (const tgt of t.slice(0, opt.area)) {
        let dmg = dmg0;
        if (tgt.dodge != null) { const dr = 1 + Math.floor(R() * 20); if (dr === 20 || (dr !== 1 && dr >= tgt.dodge)) dmg = Math.floor(dmg / 2); }
        harm(atk, tgt, dmg, 'area');
      }
    };
    const actValue = (f, a) => a.hits.reduce((x, h) => x + hitAvg(h) * (h.area ? Math.min(opt.area, alive('party').length) : 0.55), 0);
    const ready = (f, a, k) => (!a.recharge || !(f.rech[k] > 0)) && !(a.once && f.used[k]);
    const doAct = (f, a, k) => {
      if (a.recharge) f.rech[k] = a.recharge;
      if (a.once) f.used[k] = true;
      for (const h of a.hits) {
        if (!alive('party').length) return;
        if (h.area) blast(f, h);
        else { const t = pick(f); if (t) strike(f, t, h, true); }
      }
    };
    // its turn: the best ready action (a recharge or once-a-fight ability when it beats the normal attack), plus free actions
    const foeTurn = (f, single) => {
      const opts = f.acts.map((a, k) => ({ a, k })).filter(({ a, k }) => !a.free && ready(f, a, k) && !(single && a.multi));
      if (!opts.length) return;
      const best = opts.reduce((x, y) => actValue(f, y.a) > actValue(f, x.a) ? y : x);
      if (single && best.a.multi === false && best.a.hits.length > 1 && !best.a.hits[0].area) doAct(f, { ...best.a, hits: [best.a.hits[0]] }, best.k);
      else doAct(f, best.a, best.k);
    };
    let round = 0;
    while (round < opt.maxRounds && alive('party').length && alive('foe').length) {
      round++;
      if (L) L(`— Round ${round} —`);
      for (const c of all) c.dodges = 0;
      for (const c of all) {
        if (c.down || !alive('party').length || !alive('foe').length) continue;
        if (c.side === 'party') { const t = pick(c); if (t) { const landed = strike(c, t, null, opt.minHitPC); if (landed && t.solo && !t.down && !t.reacted) { t.reacted = true; const s = t.acts.filter(a => !a.multi && !a.recharge && !a.once && !a.hits[0].area)[0] || t.acts[0]; if (s) strike(t, c, s.hits[0], true); } } }
        else {
          for (const k in c.rech) if (c.rech[k] > 0) c.rech[k]--;
          foeTurn(c, false);
          c.acts.forEach((a, k) => { if (a.free && alive('party').length) doAct(c, a, k); });
        }
      }
      // Tempo: extra single actions at the end of the round
      for (const c of foes) for (let t = 0; t < c.tempo && !c.down && alive('party').length; t++) foeTurn(c, true);
      for (const c of foes) c.reacted = false;
    }
    const win = !alive('foe').length && alive('party').length > 0;
    return { win, draw: !!alive('foe').length && !!alive('party').length, rounds: round,
      party: party.map(p => ({ down: p.down, dealt: p.dealt, left: p.cur })), foes: foes.map(f => ({ down: f.down, left: f.cur })) };
  }

  function run(partySpec, foeSpec, opt, n, seed) {
    const R = rngOf(seed || 12345);
    const out = { n, wins: 0, draws: 0, rounds: 0, roundsWin: 0, anyDown: 0, wipes: 0,
      party: partySpec.map(() => ({ down: 0, dealt: 0 })), foes: foeSpec.map(() => ({ down: 0 })), hist: {} };
    let sample = null;
    for (let k = 0; k < n; k++) {
      const log = k === 0 ? [] : null;
      const r = fight(partySpec, foeSpec, opt, R, log);
      if (log) sample = log;
      if (r.win) { out.wins++; out.roundsWin += r.rounds; }
      if (r.draw) out.draws++;
      out.rounds += r.rounds;
      out.hist[r.rounds] = (out.hist[r.rounds] || 0) + 1;
      const downs = r.party.filter(p => p.down).length;
      if (downs) out.anyDown++;
      if (downs === r.party.length) out.wipes++;
      r.party.forEach((p, i) => { if (p.down) out.party[i].down++; out.party[i].dealt += p.dealt; });
      r.foes.forEach((f, i) => { if (f.down) out.foes[i].down++; });
    }
    out.sample = sample;
    return out;
  }

  /* ---- the book's own curve: median creature at each KR ---- */
  const GRID = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384];
  const median = a => { const s = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function profile(spec) {
    // what it does in an ordinary round, by averages: its best repeatable action, plus Tempo and free actions
    const acts = spec.acts.filter(a => !a.free);
    const val = a => a.hits.reduce((x, h) => x + hitAvg(h) * (h.area ? 2 : 1), 0);
    const plain = acts.filter(a => !a.recharge && !a.once);
    const main = plain.length ? Math.max(...plain.map(val)) : 0;
    const rech = acts.filter(a => a.recharge).map(a => (val(a) + (a.recharge - 1) * main) / a.recharge);
    const single = Math.max(0, ...acts.filter(a => !a.multi && !a.once).map(a => hitAvg(a.hits[0]) * (a.hits[0].area ? 2 : 1)));
    const free = spec.acts.filter(a => a.free).reduce((x, a) => x + val(a), 0);
    const per = Math.max(main, ...rech) + spec.tempo * single + free;
    const hits = Math.max(1, ...plain.map(a => a.hits.length));
    return { dpr: per, hits, hit: [spec.melee, spec.ranged, spec.casting].filter(x => x != null).reduce((a, b) => Math.min(a, b), 99) };
  }
  function curve(specs) {
    const rows = specs.filter(s => s.kr > 0 && s.hp > 0).map(s => ({ s, p: profile(s) }));
    const at = GRID.map(K => {
      const w = rows.filter(r => r.s.kr >= K / 1.5 && r.s.kr <= K * 1.5);
      if (w.length < 4) return null;
      return { K, n: w.length, hp: median(w.map(r => r.s.hp)), dpr: median(w.map(r => r.p.dpr)), hit: median(w.map(r => r.p.hit === 99 ? null : r.p.hit)) || 10,
        dodge: median(w.map(r => r.s.dodge)) || 13, defence: median(w.map(r => r.s.defence)) || 0, minHit: median(w.map(r => r.s.minHit)) || 0 };
    }).filter(Boolean);
    const lerp = (K, key) => {
      if (K <= at[0].K) return at[0][key] * (key === 'hp' || key === 'dpr' ? K / at[0].K : 1);
      const last = at[at.length - 1];
      if (K >= last.K) return last[key] * (key === 'hp' ? K / last.K : key === 'dpr' ? Math.sqrt(K / last.K) : 1);
      const j = at.findIndex(p => p.K >= K), a = at[j - 1], b = at[j];
      const t = Math.log(K / a.K) / Math.log(b.K / a.K);
      return key === 'hp' || key === 'dpr' ? Math.exp(Math.log(a[key]) + t * (Math.log(b[key]) - Math.log(a[key]))) : a[key] + t * (b[key] - a[key]);
    };
    return { points: at, get: K => ({ K, hp: lerp(K, 'hp'), dpr: lerp(K, 'dpr'), hit: lerp(K, 'hit'), dodge: lerp(K, 'dodge'), defence: lerp(K, 'defence'), minHit: lerp(K, 'minHit') }) };
  }

  /* ---- the standard adventurer ----
     HP: a typical race and class at level 0, plus two hit dice every ten levels. Melee and Dodge start at the average of
     the stat roll and improve by 1 every 10 and 20 levels. Damage is what makes one adventurer worth KR = their level
     (level 0 counts as ½) against the book's median creature: see calibrate(). */
  const STD = { hp0: 17, perLevel: 1.1, hit0: 10, dodge0: 10, defence: 1, floor: 4.5 };   // floor: never less than a 1d8 weapon
  const worth = L => Math.max(0.5, L);
  function stdStats(L) {
    return { hp: STD.hp0 + STD.perLevel * L, hit: Math.max(5, STD.hit0 - Math.floor(L / 10)), dodge: Math.max(5, STD.dodge0 - Math.floor(L / 20)), defence: STD.defence, minHit: 0 };
  }
  // chance a hit of average A (rolled 0.5A–1.5A) beats Min hit m
  const mhf = (A, m) => !m ? 1 : A <= 0 ? 0 : clamp((1.5 * A - m) / A, 0, 1);
  const land = (hit, def, dodge) => pRoll(hit + def) * (1 - pDodge(dodge));
  // power = √(damage it lands a round × HP it takes to bring down); n of the same thing is n× the power
  function powerOf(dpr, hpEff) { return Math.sqrt(Math.max(0, dpr) * Math.max(0, hpEff)); }
  const calCache = new WeakMap();
  function calibrate(cv, L) {
    if (!calCache.has(cv)) calCache.set(cv, new Map());
    const memo = calCache.get(cv), key = Math.round(L * 100);
    if (memo.has(key)) return memo.get(key);
    const M = cv.get(worth(L)), S = stdStats(L);
    const mOn = land(M.hit, S.defence, S.dodge), sOn = land(S.hit, M.defence, M.dodge);
    // the adventurer's power and the median creature's (whose toughness depends on whether A beats its Min hit)
    const gap = A => powerOf(A * sOn * mhf(A, M.minHit), S.hp / Math.max(0.01, mOn)) - powerOf(M.dpr * mOn, M.hp / Math.max(0.01, sOn * mhf(A, M.minHit)));
    let lo = 0.1, hi = 20000;
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (gap(mid) < 0) lo = mid; else hi = mid; }
    const A = Math.max(STD.floor, Math.round(hi * 10) / 10);
    memo.set(key, A);
    return A;
  }
  function standardParty(K, cv) {
    const n = K < 2 ? Math.max(1, Math.round(2 * K)) : 4, L = K < 2 ? 0 : K / 4;
    const S = stdStats(L), A = calibrate(cv, L);
    return Array.from({ length: n }, (_, i) => adventurer({ name: `Adventurer ${i + 1}`, level: L, hp: S.hp, hit: S.hit, dodge: S.dodge, defence: S.defence, dmgAvg: A }));
  }
  // one creature's power against the standard adventurer of a party worth K, and the median creature's at the same K
  function powerVs(spec, K, cv) {
    const L = K < 2 ? 0 : K / 4, S = stdStats(L), A = calibrate(cv, L), p = profile(spec);
    const on = pRoll((p.hit === 99 ? 10 : p.hit) + S.defence) * (1 - pDodge(S.dodge) / p.hits);   // one Dodge a round, so only one of several hits can be dodged
    const taken = land(S.hit, spec.defence, spec.dodge) * mhf(A, spec.minHit) * (spec.swarm ? 0.5 : 1);
    return powerOf(p.dpr * on, spec.hp / Math.max(0.01, taken));
  }
  /* The KR check. Each creature is set against the creatures of about the same KR (within ×1.5 either way), all measured
     against the same standard adventurer. Its power over their median power gives how much stronger or weaker it plays;
     "looks like KR" turns that back into a KR using how fast power grows with KR across the whole book. */
  function krCheck(specs, cv) {
    const live = specs.filter(s => s.kr > 0 && profile(s).dpr > 0);
    const memo = new Map();
    const pv = (s, K) => { const k = s.__id + '|' + K; if (!memo.has(k)) memo.set(k, powerVs(s, K, cv)); return memo.get(k); };
    live.forEach((s, i) => { s.__id = i; });
    const peersAt = K => live.filter(p => p.kr >= K / 1.5 && p.kr <= K * 1.5);
    // growth of power with KR: the slope of log(median peer power) against log KR
    const pts = GRID.map(K => { const ps = peersAt(K); return ps.length >= 4 ? [Math.log(K), Math.log(median(ps.map(p => pv(p, K))))] : null; }).filter(Boolean);
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const maxKr = Math.max(...specs.map(s => s.kr || 0));
    const rows = specs.map(s => {
      if (!(s.kr > 0)) return { spec: s, skip: 'No KR' };
      if (!(profile(s).dpr > 0)) return { spec: s, skip: 'No damage to measure' };
      const ps = peersAt(s.kr);
      if (ps.length < 4) return { spec: s, skip: 'Too few creatures near its KR' };
      const ratio = pv(s, s.kr) / median(ps.map(p => pv(p, s.kr)));
      const implied = clamp(s.kr * Math.pow(ratio, 1 / slope), 0.25, maxKr * 2);
      return { spec: s, ratio, implied, peers: ps.length };
    });
    return { rows, slope };
  }


  /* ================= the page ================= */

  window.HandbookLab = function (H) {
    const { el, go, render, Notes } = H;
    const S = window.HandbookLabSim;
    const B = H.B;   // bestiary internals: data(), view(), rowView(), encounter(), encMaths(), open(), krText()
    const KEY = 'hb-lab';
    const OPT0 = { n: 1000, target: 'random', focus: 'weakest', dodges: 1, crits: true, area: 2, minHitPC: true, maxRounds: 50 };
    const L = (() => { try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x && typeof x === 'object') return x; } catch (e) { /* storage blocked */ } return {}; })();
    L.mode = L.mode === 'kr' ? 'kr' : 'sim';
    L.src = L.src === 'std' ? 'std' : 'saved';
    L.picked = Array.isArray(L.picked) ? L.picked : [];
    L.dmg = L.dmg && typeof L.dmg === 'object' ? L.dmg : {};
    L.opt = Object.assign({}, OPT0, L.opt || {});
    L.krVol = ['1', '2', '3'].includes(L.krVol) ? L.krVol : 'all';
    L.krShow = L.krShow === 'all' ? 'all' : 'flagged';
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ mode: L.mode, src: L.src, picked: L.picked, dmg: L.dmg, opt: L.opt, krVol: L.krVol, krShow: L.krShow, triShown: L.triShown })); } catch (e) { /* this visit only */ } };
    let chars = null, charErr = '', loadingChars = false;
    let result = null, running = false, resultKey = '';
    let KR = null, krRunning = false, krDone = 0, krTotal = 0;
    let cvCache = null, cvFor = null;

    const pct = x => `${Math.round(x * 100)}%`;
    const r1 = x => Math.round(x * 10) / 10;
    const krText = k => B.krText(k);

    function curveNow() {
      const D = B.data();
      if (cvFor === D && cvCache) return cvCache;
      const specs = D.creatures.filter(c => c.kind !== 'tier' && c.hp && c.kr != null).map(c => S.fromCreature(B.view(c, [])));
      cvCache = S.curve(specs); cvFor = D;
      return cvCache;
    }

    async function loadChars() {
      if (loadingChars) return;
      loadingChars = true; charErr = '';
      const c = Notes.client();
      const [ch, cp] = await Promise.all([
        c.from('characters').select('id, name, owner_id, campaign_id, data').order('name', { ascending: true }),
        c.from('campaigns').select('id, name')]);
      loadingChars = false;
      if (ch.error) { charErr = Notes.friendly ? Notes.friendly(ch.error) : String(ch.error.message || ch.error); chars = []; render(); return; }
      const camps = new Map(((cp && cp.data) || []).map(x => [x.id, x.name]));
      chars = (ch.data || []).map(r => ({ id: r.id, name: r.name || 'Unnamed', camp: camps.get(r.campaign_id) || 'Not in a campaign', st: (H.fightStats && H.fightStats(r.data)) || null }));
      render();
    }

    // the adventurers as they'll fight, with where each number came from
    function partyRows() {
      const cv = curveNow();
      const best = st => [st.melee, st.ranged, st.casting].filter(x => x != null && x !== '').map(Number).reduce((a, b) => Math.min(a, b), 99);
      if (L.src === 'std') {
        const enc = B.encounter();
        return enc.party.map((lvl, i) => {
          const st = S.stdStats(lvl), key = 'std' + i;
          return { key, name: `Adventurer ${i + 1}`, level: lvl, hp: Math.round(st.hp), hit: st.hit, dodge: st.dodge, defence: st.defence, est: { hp: 1, hit: 1, dodge: 1, defence: 1 }, book: S.calibrate(cv, lvl) };
        });
      }
      if (!chars) return [];
      return chars.filter(c => L.picked.includes(c.id)).map(c => {
        const st = c.st || {}, lvl = st.level | 0, std = S.stdStats(lvl), h = best(st);
        // the character's own best attack (equipped weapons and Attacks and armour on their sheet); one they're trained with first
        const atk = (st.attacks || []).map(a => ({ ...a, d: S.dice(a.dice) })).filter(a => a.d && (a.d.n || a.d.b)).sort((x, y) => (x.dis ? 1 : 0) - (y.dis ? 1 : 0) || S.avg(y.d) - S.avg(x.d))[0] || null;
        const hit = atk && atk.hit != null ? atk.hit : h === 99 ? std.hit : h;
        // armour's temp HP is there at the start of a fight after a long rest, so it counts towards their HP here
        return { key: c.id, name: c.name, level: lvl, hp: (st.hp || Math.round(std.hp)) + (st.thp | 0), hit, dodge: st.dodge != null ? st.dodge : std.dodge, defence: st.defence || 0, minHit: st.minHit || 0, atk,
          est: { hp: !st.hp, hit: !atk && h === 99, dodge: st.dodge == null }, book: S.calibrate(cv, lvl) };
      });
    }
    function partySpecs(rows) {
      return rows.map(r => {
        const typed = S.dice(L.dmg[r.key]);
        const dmg = typed && (typed.n || typed.b) ? typed : r.atk ? r.atk.d : null;
        return S.adventurer({ name: r.name, level: r.level, hp: r.hp, hit: r.hit, dodge: r.dodge, defence: r.defence, minHit: r.minHit || 0, dmg, dmgAvg: r.book });
      });
    }
    function foeSpecs() {
      const out = [];
      for (const r of B.encounter().rows) {
        const v = B.rowView(r);
        if (!v) continue;
        for (let k = 1; k <= r.n; k++) out.push(S.fromCreature(v, r.n > 1 ? `${v.name} ${k}` : v.name));
      }
      return out;
    }

    function runSim() {
      const rows = partyRows(), party = partySpecs(rows), foes = foeSpecs();
      if (!party.length || !foes.length) return;
      running = true; render();
      setTimeout(() => {
        const t0 = performance.now();
        const res = S.run(party, foes, L.opt, L.opt.n, 20261124);
        res.ms = performance.now() - t0;
        res.rows = rows; res.party = res.party.map((p, i) => ({ ...p, spec: party[i] })); res.foes = res.foes.map((f, i) => ({ ...f, spec: foes[i] }));
        res.enc = B.encMaths();
        result = res; resultKey = simKey(); running = false; render();
      }, 30);
    }
    const simKey = () => JSON.stringify([L.src, L.picked, L.dmg, L.opt, B.encounter(), chars && chars.length]);

    function runKr() {
      const D = B.data();
      const cs = D.creatures.filter(c => c.kind !== 'tier' && c.hp && c.kr != null);
      const specs = cs.map(c => { const sp = S.fromCreature(B.view(c, [])); sp.c = c; return sp; });
      const cv = curveNow();
      const chk = S.krCheck(specs, cv);
      krRunning = true; krDone = 0; krTotal = chk.rows.length; KR = null; render();
      const R = S.rngOf(7);
      const wins = new Array(chk.rows.length);
      let i = 0;
      const step = () => {
        const t0 = performance.now();
        while (i < chk.rows.length && performance.now() - t0 < 40) {
          const row = chk.rows[i];
          if (!row.skip) { const res = S.run(S.standardParty(row.spec.kr, cv), [row.spec], L.opt, 100, 99 + i); wins[i] = res.wins / res.n; }
          i++;
        }
        krDone = i;
        if (i < chk.rows.length) { render(); setTimeout(step, 0); return; }
        // the typical win rate for creatures of about the same KR, to read each one against
        const typical = r => { const ws = chk.rows.map((x, k) => (!x.skip && x.spec.kr >= r.spec.kr / 1.5 && x.spec.kr <= r.spec.kr * 1.5) ? wins[k] : null).filter(x => x != null).sort((a, b) => a - b); return ws.length ? ws[ws.length >> 1] : null; };
        KR = { slope: chk.slope, rows: chk.rows.map((r, k) => ({ ...r, c: r.spec.c, win: wins[k], typ: r.skip ? null : typical(r) })) };
        krRunning = false; render();
      };
      setTimeout(step, 30);
    }

    /* ---- pieces ---- */
    const segBtns = (cur, items, set, label) => el('div', { class: 'bs-seg seg', role: 'group', 'aria-label': label },
      ...items.map(([k, t]) => el('button', { type: 'button', class: cur === k ? 'on' : null, 'aria-pressed': String(cur === k), onclick: () => set(k) }, t)));
    const sel = (val, items, on, label) => el('select', { class: 'select lab-sel', 'aria-label': label, onchange: e => on(e.target.value) },
      ...items.map(([k, t]) => el('option', { value: String(k), selected: String(val) === String(k) }, t)));
    const setOpt = (k, v) => { L.opt[k] = v; save(); render(); };

    function assumptions() {
      const o = L.opt;
      return el('section', { class: 'lab-card lab-how' },
        el('h2', { class: 'section-head' }, 'How each fight is run'),
        el('div', { class: 'lab-opts' },
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'Fights per run'), sel(o.n, [[200, '200'], [1000, '1,000'], [5000, '5,000']], v => setOpt('n', +v), 'Fights per run')),
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'Monsters attack'), sel(o.target, [['random', 'a random adventurer'], ['weakest', 'the one with least HP'], ['toughest', 'the one with most HP']], v => setOpt('target', v), 'Who monsters attack')),
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'Adventurers attack'), sel(o.focus, [['weakest', 'the enemy with least HP'], ['random', 'a random enemy']], v => setOpt('focus', v), 'Who adventurers attack')),
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'Dodge rolls a round'), sel(o.dodges, [[1, 'one'], [2, 'two']], v => setOpt('dodges', +v), 'Dodge rolls a round')),
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'An area attack catches'), sel(o.area, [[1, '1 adventurer'], [2, '2 adventurers'], [3, '3 adventurers'], [4, '4 adventurers'], [99, 'everyone']], v => setOpt('area', +v), 'Adventurers caught by an area attack')),
          el('label', { class: 'lab-opt' }, el('span', { class: 'k' }, 'Call it a draw after'), sel(o.maxRounds, [[20, '20 rounds'], [50, '50 rounds'], [100, '100 rounds']], v => setOpt('maxRounds', +v), 'Rounds before a draw')),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: o.crits, onchange: e => setOpt('crits', e.target.checked) }), 'A natural 20 is a critical (damage dice rolled twice)'),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: o.minHitPC, onchange: e => setOpt('minHitPC', e.target.checked) }), 'Adventurers’ hits are weapon hits, so Min hit applies'),
          el('button', { type: 'button', class: 'mini', onclick: () => { L.opt = { ...OPT0 }; save(); render(); } }, 'Back to the defaults')),
        el('ul', { class: 'lab-rules' },
          el('li', {}, 'An attack hits on a d20 of the attacker’s Melee, Ranged or Casting or more, plus the target’s Defence. A natural 1 misses and a natural 20 hits.'),
          el('li', {}, 'A hit can be dodged with a d20 of the target’s Dodge or more, once a round. Weapon damage under the target’s Min hit doesn’t count.'),
          el('li', {}, 'Area attacks don’t roll to hit. Each adventurer caught makes a Dodge roll to halve the damage, and Min hit doesn’t apply.'),
          el('li', {}, 'Monsters use their best ready attack each turn: a Multiattack, a recharge ability once it’s back, a once-a-fight ability. Tempo adds single attacks at the end of the round, a Boss gets one more, and a Solo creature hits back once a round at whoever hit it.'),
          el('li', {}, 'Alpha, Boss and Minion change the numbers as the templates say. A swarm takes half damage from single-target hits and deals half once it’s below half HP.'),
          el('li', {}, 'Adventurers make one attack a turn. An adventurer at 0 HP is down for the rest of the fight. Initiative is random.'),
          el('li', {}, el('strong', {}, 'Not modelled: '), 'status effects, saves, spells and feats other than plain damage, healing, movement and terrain, morale, phases, lair actions and tactics. Read the numbers as a first look, then adjust on the day.')));
    }

    function partyCard() {
      const rows = partyRows();
      const src = segBtns(L.src, [['saved', 'Saved characters'], ['std', 'Standard adventurers']], k => { L.src = k; save(); if (k === 'saved' && !chars) loadChars(); render(); }, 'Who fights');
      let pick = null;
      if (L.src === 'saved') {
        if (!Notes || !Notes.client || !Notes.client()) pick = el('p', { class: 'd-note' }, 'Sign in to use saved characters.');
        else if (!chars) { if (!loadingChars) loadChars(); pick = el('p', { class: 'bs-fine' }, 'Opening the saved characters…'); }
        else {
          const groups = new Map();
          for (const c of chars) { if (!groups.has(c.camp)) groups.set(c.camp, []); groups.get(c.camp).push(c); }
          pick = el('div', { class: 'lab-pick' },
            charErr ? el('p', { class: 'notes-msg' }, charErr) : null,
            chars.length ? null : el('p', { class: 'd-note' }, 'No saved characters yet. Players save theirs in Characters.'),
            ...[...groups].map(([camp, cs]) => el('div', { class: 'lab-pg' },
              el('div', { class: 'k' }, camp, cs.length > 1 ? el('button', { type: 'button', class: 'mini', onclick: () => { const all = cs.every(c => L.picked.includes(c.id)); L.picked = all ? L.picked.filter(id => !cs.some(c => c.id === id)) : [...new Set([...L.picked, ...cs.map(c => c.id)])]; save(); render(); } }, cs.every(c => L.picked.includes(c.id)) ? 'Clear them' : 'Pick them all') : null),
              el('div', { class: 'lab-chips' }, ...cs.map(c => el('label', { class: 'lab-chip' + (L.picked.includes(c.id) ? ' on' : '') },
                el('input', { type: 'checkbox', checked: L.picked.includes(c.id), onchange: e => { L.picked = e.target.checked ? [...L.picked, c.id] : L.picked.filter(x => x !== c.id); save(); render(); } }),
                el('span', {}, c.name), el('span', { class: 'lv' }, `Lv ${(c.st && c.st.level) | 0}`)))))));
        }
      } else pick = el('p', { class: 'd-note' }, `The party levels from Encounters: ${B.encounter().party.map(l => krText(l)).join(', ') || 'none yet'}. `, el('button', { type: 'button', class: 'linkbtn', onclick: () => go({ tab: 'encounter', mon: '', rs: '' }, true) }, 'Change them'));
      const est = (r, k) => r.est[k] ? el('span', { class: 'lab-est', title: 'Not on the sheet yet, so the standard adventurer’s number is used' }, '*') : null;
      const table = rows.length ? el('div', { class: 'lab-tw' }, el('table', { class: 'lab-t' },
        el('thead', {}, el('tr', {}, ...['Adventurer', 'Level', 'HP', 'Hits on', 'Dodge', 'Defence', 'Damage a hit'].map(h => el('th', {}, h)))),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', { class: 'nm' }, r.name), el('td', {}, String(r.level)),
          el('td', {}, String(r.hp), est(r, 'hp')), el('td', {}, String(r.hit), est(r, 'hit')), el('td', {}, String(r.dodge), est(r, 'dodge')), el('td', {}, String(r.defence)),
          el('td', {}, el('input', { type: 'text', class: 'lab-dmg', value: L.dmg[r.key] || '', placeholder: r.atk ? `${r.atk.dice} (${r.atk.name})` : `≈ ${r1(r.book)}`, 'aria-label': `Damage a hit for ${r.name}`, inputmode: 'text',
            onchange: e => { const v = e.target.value.trim(); if (v && !S.dice(v)) { e.target.setCustomValidity('Use dice like 2d6+3, or a number'); e.target.reportValidity(); return; } e.target.setCustomValidity(''); if (v) L.dmg[r.key] = v; else delete L.dmg[r.key]; save(); render(); } }))))))) : null;
      return el('section', { class: 'lab-card' },
        el('h2', { class: 'section-head' }, 'The party'),
        src, pick, table,
        rows.length ? el('p', { class: 'bs-fine' }, 'Hits on and damage come from each character’s best attack (Attacks and armour on their sheet); without one, Hits on is the best of Melee, Ranged and Casting. * means it isn’t on the sheet yet, so the standard adventurer’s number stands in. Type dice (2d6+3) to try other damage. Left blank with no attack written, it’s the damage the KR system expects at their level (see the KR check).') : null);
    }

    function foesCard() {
      const enc = B.encounter(), M = B.encMaths();
      const lines = enc.rows.map(r => { const v = B.rowView(r); return v ? el('li', {}, el('span', { class: 'n' }, `${r.n} ×`), ' ', el('button', { type: 'button', class: 'bs-elink', onclick: () => B.open(v.base, r.tpl) }, v.name), el('span', { class: 'bs-each' }, ` KR ${krText(v.kr)} · HP ${v.hp}`)) : null; });
      return el('section', { class: 'lab-card' },
        el('h2', { class: 'section-head' }, 'The enemies'),
        lines.length ? el('ul', { class: 'bs-sug-l lab-foes' }, ...lines) : el('p', { class: 'd-note' }, 'No creatures yet. Build the encounter in Encounters, then come back.'),
        lines.length ? el('p', { class: 'bs-fine' }, `Encounter KR ${krText(M.total)}${M.verdict ? `: the builder calls it ${M.verdict} for its party total of ${krText(M.party)}` : ''}.`) : null,
        el('button', { type: 'button', class: 'mini', onclick: () => go({ tab: 'encounter', mon: '', rs: '' }, true) }, lines.length ? 'Change it in Encounters' : 'Open Encounters'));
    }

    function verdictOf(res) {
      const w = res.wins / res.n, wipe = res.wipes / res.n;
      return w >= 0.9 && wipe < 0.03 ? 'easy' : w >= 0.6 ? 'fair' : 'deadly';
    }
    const NAME = { easy: 'Easy', fair: 'Fair', deadly: 'Deadly' };

    function resultCard() {
      if (running) return el('section', { class: 'lab-card lab-res' }, el('p', { class: 'd-note' }, `Running ${L.opt.n.toLocaleString('en-GB')} fights…`));
      if (!result) return null;
      const res = result, n = res.n, v = verdictOf(res), stale = resultKey !== simKey();
      const tile = (k, val, sub) => el('div', { class: 'bs-res-n' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, val), sub ? el('span', { class: 'sub' }, sub) : null);
      const wins = res.wins / n;
      const agree = res.enc && res.enc.verdict ? (res.enc.verdict === v ? `The encounter builder calls it ${NAME[res.enc.verdict]} too.` : `The encounter builder calls it ${NAME[res.enc.verdict]}, so this party finds it ${({ easy: 0, fair: 1, deadly: 2 }[v] > { easy: 0, fair: 1, deadly: 2 }[res.enc.verdict]) ? 'harder' : 'easier'} than the KR suggests.`) : '';
      // rounds, in a small bar chart
      const maxR = Math.max(...Object.keys(res.hist).map(Number));
      const step = Math.max(1, Math.ceil(maxR / 24));
      const bins = [];
      for (let a = 1; a <= maxR; a += step) { let c = 0; for (let k = a; k < a + step; k++) c += res.hist[k] || 0; bins.push({ a, b: a + step - 1, c }); }
      const top = Math.max(...bins.map(b => b.c), 1);
      const foeGroups = new Map();
      for (const f of res.foes) { const k = f.spec.name.replace(/ \d+$/, ''); if (!foeGroups.has(k)) foeGroups.set(k, { name: k, n: 0, down: 0, hp: f.spec.hp }); const g = foeGroups.get(k); g.n++; g.down += f.down; }
      return el('section', { class: `lab-card lab-res bs-result ${v}` },
        stale ? el('p', { class: 'lab-stale' }, 'You’ve changed something since this ran. ', el('button', { type: 'button', class: 'linkbtn', onclick: runSim }, 'Run it again')) : null,
        el('div', { class: 'bs-res-nums lab-tiles' },
          tile('Party wins', pct(wins), `of ${n.toLocaleString('en-GB')} fights`),
          tile('Someone drops', pct(res.anyDown / n)),
          tile('Whole party drops', pct(res.wipes / n)),
          tile('Average fight', `${r1(res.rounds / n)}`, 'rounds'),
          el('div', { class: 'bs-res-n verdict' }, el('span', { class: 'k' }, 'Plays like'), el('span', { class: 'v' }, NAME[v]))),
        el('p', { class: 'bs-verdict' }, agree, res.draws ? ` ${pct(res.draws / n)} hit the ${L.opt.maxRounds}-round limit and count as draws.` : ''),
        el('p', { class: 'bs-fine' }, 'Plays like: Easy when the party wins 90% or more and almost never wipes; Fair from 60%; Deadly below that.'),
        el('div', { class: 'lab-hist', role: 'img', 'aria-label': 'How many rounds the fights lasted' },
          ...bins.map(b => el('div', { class: 'col', title: `${b.a === b.b ? b.a : `${b.a}–${b.b}`} rounds: ${b.c} fights` }, el('span', { class: 'bar', style: `height:${Math.max(2, Math.round(b.c / top * 100))}%` }), el('span', { class: 'x' }, String(b.a))))),
        el('p', { class: 'bs-fine lab-histk' }, 'How many rounds each fight lasted.'),
        el('div', { class: 'lab-tw' }, el('table', { class: 'lab-t' },
          el('thead', {}, el('tr', {}, ...['Adventurer', 'HP', 'Drops in', 'Damage dealt a fight'].map(h => el('th', {}, h)))),
          el('tbody', {}, ...res.party.map(p => el('tr', {}, el('td', { class: 'nm' }, p.spec.name), el('td', {}, String(p.spec.hp)), el('td', {}, pct(p.down / n)), el('td', {}, String(Math.round(p.dealt / n)))))))),
        el('div', { class: 'lab-tw' }, el('table', { class: 'lab-t' },
          el('thead', {}, el('tr', {}, ...['Enemy', 'HP each', 'Killed in'].map(h => el('th', {}, h)))),
          el('tbody', {}, ...[...foeGroups.values()].map(g => el('tr', {}, el('td', { class: 'nm' }, g.n > 1 ? `${g.n} × ${g.name}` : g.name), el('td', {}, String(g.hp)), el('td', {}, pct(g.down / (n * g.n)))))))),
        res.sample ? el('details', { class: 'lab-log' }, el('summary', {}, 'Read one of the fights, blow by blow'),
          el('ol', {}, ...res.sample.map(l => el('li', { class: l.startsWith('—') ? 'rd' : null }, l)))) : null);
    }

    function simPage() {
      const rows = partyRows(), foes = B.encounter().rows.length;
      const why = !rows.length ? (L.src === 'saved' ? 'Pick at least one character.' : 'Add the party’s levels in Encounters.') : !foes ? 'Add some creatures in Encounters.' : '';
      return el('div', { class: 'lab-sim' },
        el('div', { class: 'lab-cols' },
          el('div', { class: 'lab-col' }, partyCard(), foesCard(),
            el('div', { class: 'lab-go' }, el('button', { type: 'button', class: 'btn primary', disabled: !!why || running, onclick: runSim }, running ? 'Running…' : `Run ${L.opt.n.toLocaleString('en-GB')} fights`), why ? el('span', { class: 'bs-fine' }, why) : null)),
          el('div', { class: 'lab-col' }, resultCard() || el('section', { class: 'lab-card lab-empty' }, el('p', { class: 'd-note' }, 'Pick the party and the enemies, then run the fights. You’ll see how often the party wins, who drops, and how long it takes.')), assumptions())));
    }

    /* Your rulings on flagged creatures and the book's open flags. Kept in the DM-only dm_store table ("kr-triage"),
       recorded rather than applied: the data files are changed from the list later, then the SQL is rerun. */
    let TRI = null, triErr = '', triT = null, triBusy = false, triShown = !!L.triShown;
    async function loadTri() {
      if (triBusy || TRI) return;
      triBusy = true;
      const r = await Notes.client().from('dm_store').select('key, data').eq('key', 'kr-triage').maybeSingle();
      triBusy = false;
      if (r.error) { triErr = /dm_store|does not exist|schema cache/i.test(String(r.error.message)) ? 'Run the latest supabase/setup.sql to save your rulings.' : String(r.error.message); TRI = {}; render(); return; }
      TRI = (r.data && r.data.data) || {};
      render();
    }
    function saveTri() {
      clearTimeout(triT);
      triT = setTimeout(async () => { const r = await Notes.client().from('dm_store').upsert({ key: 'kr-triage', data: TRI }); if (r.error) { triErr = String(r.error.message); render(); } }, 500);
    }
    const justRuled = new Set();   // ruled on during this visit: they stay in view (so a new KR can be typed) until the page is left
    const ruled = id => TRI && TRI[id] && TRI[id].call && TRI[id].call !== 'later' && !justRuled.has(id);
    function callCell(id, r, label) {
      const t = (TRI && TRI[id]) || {};
      const set = patch => { justRuled.add(id); TRI[id] = { ...t, ...patch, at: new Date().toISOString(), name: r ? r.c.name : (label || t.name) }; if (!TRI[id].call) delete TRI[id]; saveTri(); render(); };
      return el('div', { class: 'lab-call' },
        el('select', { class: 'select', 'aria-label': `Your call on ${r ? r.c.name : 'this'}`, onchange: e => set({ call: e.target.value }) },
          el('option', { value: '' }, 'Your call…'),
          el('option', { value: 'fine', selected: t.call === 'fine' }, 'Fine as is'),
          el('option', { value: 'change', selected: t.call === 'change' }, r ? 'Change KR to…' : 'Change it'),
          el('option', { value: 'later', selected: t.call === 'later' }, 'Look later')),
        t.call === 'change' && r ? el('input', { type: 'number', class: 'num', min: '0', step: '0.5', value: t.kr != null ? String(t.kr) : String(Math.round(r.implied >= 10 ? r.implied : r.implied * 2) / (r.implied >= 10 ? 1 : 2)), 'aria-label': `New KR for ${r.c.name}`, onchange: e => set({ kr: Number(e.target.value) }) }) : null,
        t.call === 'change' && !r ? el('input', { type: 'text', class: 'lab-callnote', value: t.note || '', maxlength: 300, placeholder: 'What should it be?', 'aria-label': 'What to change', onchange: e => set({ note: e.target.value }) }) : null);
    }
    function rulingsText() {
      const lines = [];
      for (const [id, t] of Object.entries(TRI || {})) {
        if (!t.call || t.call === 'later') continue;
        if (id.startsWith('flag:')) lines.push(`${t.name}: ${t.call === 'fine' ? 'leave as written' : 'change it' + (t.note ? ' — ' + t.note : '')}`);
        else lines.push(`${t.name}: ${t.call === 'fine' ? 'KR is fine' : `KR → ${t.kr}`}`);
      }
      return lines.sort().join('\n');
    }
    function flagsCard() {
      const D = B.data();
      const flags = [...(((D.v2 || {}).flags) || []).map((f, i) => ({ id: `flag:2:${i}`, vol: 'II', text: f })), ...(((D.v3 || {}).flags) || []).map((f, i) => ({ id: `flag:3:${i}`, vol: 'III', text: f }))];
      if (!flags.length) return null;
      const open = flags.filter(f => !ruled(f.id));
      return el('section', { class: 'lab-card' },
        el('h2', { class: 'section-head' }, 'Open questions in the book'),
        el('p', { class: 'd-note' }, `Things found while putting the volumes in that need your ruling. ${open.length} of ${flags.length} still open.`),
        el('ul', { class: 'lab-flags' }, ...(triShown ? flags : open).map(f => el('li', {},
          el('p', {}, el('strong', {}, `Vol ${f.vol}. `), f.text.length > 600 ? f.text.slice(0, 600) + '…' : f.text),
          callCell(f.id, null, `Vol ${f.vol}: ${f.text.slice(0, 80)}${f.text.length > 80 ? '…' : ''}`)))));
    }

    function krPage() {
      if (!TRI) loadTri();
      const cv = curveNow();
      const std = [0, 1, 3, 5, 10, 20, 30, 50, 75, 100].map(l => ({ l, st: S.stdStats(l), A: S.calibrate(cv, l) }));
      let body;
      if (krRunning) body = el('div', { class: 'lab-prog' }, el('div', { class: 'bar' }, el('span', { style: `width:${krTotal ? Math.round(krDone / krTotal * 100) : 0}%` })), el('p', { class: 'bs-fine' }, `Checked ${krDone} of ${krTotal} creatures…`));
      else if (!KR) body = el('p', { class: 'd-note' }, 'Checks every creature in all three volumes. It takes a few seconds.');
      else {
        const inVol = r => L.krVol === 'all' || String(r.c.volume) === L.krVol;
        const rows = KR.rows.filter(inVol);
        const off = r => !r.skip && (r.implied / r.c.kr >= 1.5 || r.implied / r.c.kr <= 1 / 1.5);
        const strong = rows.filter(r => off(r) && r.implied > r.c.kr).length, weak = rows.filter(r => off(r) && r.implied < r.c.kr).length, skip = rows.filter(r => r.skip).length;
        const shown = rows.filter(r => (L.krShow === 'all' || off(r) || r.skip) && (triShown || L.krShow === 'all' || !ruled(r.c.id))).sort((a, b) => (!!a.skip - !!b.skip) || (a.skip ? a.c.name.localeCompare(b.c.name) : Math.abs(Math.log(b.implied / b.c.kr)) - Math.abs(Math.log(a.implied / a.c.kr))));
        const NOT_DMG = /controller|leader|support|summoner|set piece|hazard|trickster|herald|guide|trader|clerk|sage|keeper|judge|mirror|nuisance/i;
        const note = r => {
          if (r.skip) return r.skip;
          const bits = [];
          if (r.implied > r.c.kr * 1.5) bits.push('Plays stronger than its KR');
          else if (r.implied < r.c.kr / 1.5) bits.push('Plays weaker than its KR');
          if (r.implied < r.c.kr && NOT_DMG.test(r.c.role || '')) bits.push(`its role (${r.c.role}) does more than damage, so this may be fine`);
          if (r.c.hp <= 2) bits.push('very low HP');
          return bits.join('; ');
        };
        body = el('div', {},
          el('p', { class: 'bs-verdict' }, `${rows.length - skip} creatures checked. ${strong} play noticeably stronger than their KR and ${weak} noticeably weaker (half again or more either way). ${skip ? `${skip} can’t be judged by damage alone.` : ''}`),
          el('p', { class: 'bs-fine lab-key' }, el('span', { class: 'hi' }), 'plays stronger than its KR', el('span', { class: 'lo' }), 'plays weaker. “Typical” is how often the standard party beats creatures of about the same KR.'),
          el('div', { class: 'lab-tw' }, el('table', { class: 'lab-t lab-kr' },
            el('thead', {}, el('tr', {}, ...['Creature', 'Vol', 'KR', 'Plays like', 'Standard party wins', 'Note', 'Your call'].map(h => el('th', {}, h)))),
            el('tbody', {}, ...shown.slice(0, 400).map(r => el('tr', { class: r.skip ? 'skip' : off(r) ? (r.implied > r.c.kr ? 'hi' : 'lo') : null },
              el('td', { class: 'nm' }, el('button', { type: 'button', class: 'bs-elink', onclick: () => B.open(r.c, []) }, r.c.name)),
              el('td', {}, ['', 'I', 'II', 'III'][r.c.volume]),
              el('td', {}, krText(r.c.kr)),
              el('td', {}, r.skip ? '–' : `KR ${krText(r.implied >= 10 ? Math.round(r.implied) : Math.round(r.implied * 2) / 2)}`),
              el('td', {}, r.skip || r.win == null ? '–' : `${pct(r.win)}${r.typ != null ? ` (typical ${pct(r.typ)})` : ''}`),
              el('td', { class: 'lab-note' }, note(r)),
              el('td', {}, r.skip ? null : callCell(r.c.id, r))))))),
          shown.length > 400 ? el('p', { class: 'bs-fine' }, `Showing the first 400 of ${shown.length}.`) : null);
      }
      return el('div', { class: 'lab-krp' },
        el('section', { class: 'lab-card' },
          el('h2', { class: 'section-head' }, 'KR check'),
          el('p', { class: 'd-note' }, 'Each creature is measured against the others of about the same KR, by the damage it deals in a round and the damage it takes to bring down, against a standard party whose levels add up to its KR. A flag is a prompt to look at the stat block, not a verdict: anything whose danger is control, summoning or tactics will read as weaker than it is.'),
          el('div', { class: 'lab-krf' },
            segBtns(L.krVol, [['all', 'All volumes'], ['1', 'Vol I'], ['2', 'Vol II'], ['3', 'Vol III']], k => { L.krVol = k; save(); render(); }, 'Which volumes'),
            segBtns(L.krShow, [['flagged', 'Flagged only'], ['all', 'Every creature']], k => { L.krShow = k; save(); render(); }, 'Which creatures'),
            el('button', { type: 'button', class: 'btn primary small', disabled: krRunning, onclick: runKr }, KR ? 'Run it again' : 'Run the check')),
          el('div', { class: 'lab-krf' },
            el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: triShown, onchange: e => { triShown = e.target.checked; L.triShown = triShown; save(); render(); } }), 'Show what I’ve already ruled on'),
            TRI && rulingsText() ? el('button', { type: 'button', class: 'mini', onclick: async () => { try { await navigator.clipboard.writeText(rulingsText()); triErr = 'Copied your rulings.'; } catch (e) { triErr = 'Couldn’t copy; your rulings are also in the backup on the Session screen.'; } render(); } }, `Copy my rulings (${rulingsText().split('\n').length})`) : null,
            triErr ? el('span', { class: 'bs-fine' }, triErr) : null),
          body),
        flagsCard(),
        el('section', { class: 'lab-card lab-how' },
          el('h2', { class: 'section-head' }, 'The standard adventurer'),
          el('p', { class: 'd-note' }, `HP is a typical race and class (${S.STD.hp0} at level 0) plus two hit dice every ten levels (about ${S.STD.perLevel} a level). Melee starts at ${S.STD.hit0} and Dodge at ${S.STD.dodge0}, the average stat roll, improving by 1 every 10 and every 20 levels. Defence ${S.STD.defence}, no Min hit. A party worth KR k is four adventurers of level k÷4 (or level 0 adventurers, two per KR, below KR 2).`),
          el('p', { class: 'd-note' }, 'Damage a hit is what makes one adventurer worth KR equal to their level against the book’s median creature of that KR (level 0 counts as ½), and never less than a 1d8 weapon. It comes from the bestiary itself, so it’s also a useful check on your classes: if they hit much softer than this at a level, fights at that level will run harder than their KR.'),
          el('div', { class: 'lab-tw' }, el('table', { class: 'lab-t' },
            el('thead', {}, el('tr', {}, ...['Level', 'HP', 'Hits on', 'Dodge', 'Damage a hit the KR system expects'].map(h => el('th', {}, h)))),
            el('tbody', {}, ...std.map(x => el('tr', {}, el('td', {}, String(x.l)), el('td', {}, String(Math.round(x.st.hp))), el('td', {}, String(x.st.hit)), el('td', {}, String(x.st.dodge)), el('td', {}, String(Math.round(x.A)))))))),
          el('p', { class: 'bs-fine' }, `The fights use the same rules as the simulator (see How each fight is run on the other page), 100 fights per creature. Power grows with KR at a rate of ${KR ? r1(KR.slope) : '–'} across the book, which turns each creature’s power back into the KR it plays like.`)));
    }

    function renderList(box) {
      const head = el('div', { class: 'lab-head' },
        el('h1', { class: 'lab-title' }, 'Balance lab'),
        el('div', { class: 'cc-seg', role: 'tablist', 'aria-label': 'Lab tools' },
          ...[['sim', 'Fight simulator'], ['kr', 'KR check']].map(([k, t]) => el('button', { type: 'button', class: 'cc-seg-b', role: 'tab', 'aria-selected': String(L.mode === k), onclick: () => { L.mode = k; save(); render(); } }, t))));
      box.replaceChildren(el('div', { class: 'lab' }, head, L.mode === 'kr' ? krPage() : simPage()));
      document.title = 'Balance lab · Bestiary';
    }

    return { renderList };
  };

  window.HandbookLabSim = { rngOf, dice, avg, pRoll, fromCreature, adventurer, fight, run, profile, curve, calibrate, stdStats, standardParty, krCheck, powerVs, worth, GRID, STD, hitAvg };
})();
