# Player’s Handbook

A searchable reference for the campaign's races, classes, subclasses and spells, hosted on GitHub Pages.

## Editing content

All content lives in plain markdown files in `content/`. Edit them on GitHub (pencil icon) and the site updates on the next Pages build, usually within a minute. No build step is needed.

| File | What's in it |
|---|---|
| `content/races.md` | Playable races |
| `content/classes.md` | Classes, grouped by Melee / Ranged / Magic / Other |
| `content/subclasses.md` | Subclasses, grouped by class |
| `content/spells.md` | Every spell, grouped by school and tier |

Each file has a short comment at the top explaining its format. In short:

```markdown
# Group heading
## Entry name
hp: 12                  <- "key: value" lines directly under the heading are stats
hit die: 1d8

Description in normal markdown. Use ### for named traits/abilities and - for lists.
```

Spells use one line each:

```markdown
- Fireball | 3d6 AoE fire | | Create a ball of fire and throw it at your opponent.
- Cinderbrand | 1d10 + 1d4/turn | Mage (Fire) – Hellfire | Set a target alight...
```

The fields are: name | dice/effect | who gets it | description. Leave "who gets it" empty for general school spells.

- To link a subclass to its spells, give the subclass a `spells:` line that matches the spell's source exactly (e.g. `spells: Mage (Fire) – Hellfire`).
- To mark a subclass as announced but not yet written, add `status: upcoming` under its heading.

## Previewing locally

```
python -m http.server
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't work, because browsers block the content files from loading that way.


## Handbook chapters (Advancement and Gods)

`content/advancement.md` and `content/gods.md` are plain markdown, converted from the Google Docs
*Character Advancement* and *The Book of Gods*. Each `#` heading is a chapter and each `##` heading is a
section players can open and search. Inside a section you can use `###` sub-headings, `-` bullet lists,
`1.` numbered lists and `|` tables (the first row of a table is its header; a one-column table becomes a
highlighted callout box).

Some DM-only passages of the Book of Gods were left out on purpose — keep DM-only material out of
these files, since everything in `content/` is visible to players.

## Session notes and sign-in (Supabase)

The handbook itself is open to anyone with the link. Signing in is only needed for the **Notes** tab,
where players share notes organised by campaign and session. The sign-in button is in the top bar on
every page.

Files: `notes.js` (sign-in and notes), `vendor/supabase.js` (the Supabase library, kept here so the site
doesn't depend on another CDN), `supabase/setup.sql` (the database). The project address and its public
"anon" key are at the top of `notes.js`. The anon key is meant to be public; never put the
`service_role` key in this repo.

### One-time setup

1. **Create the tables.** Supabase dashboard → **SQL Editor** → New query → paste all of
   `supabase/setup.sql` → **Run**. It's safe to run again whenever this file is updated.
2. **Stop strangers signing up.** Authentication → **Sign In / Providers** → turn off
   **Allow new users to sign up**. Leave the Email provider itself switched on.
3. **Create your own account.** Authentication → **Users** → **Add user** → **Create new user**, with
   the admin email set in `supabase/setup.sql` and a password, and tick **Auto Confirm User**.

### Adding a player

Authentication → Users → Add user → Create new user → their email and a password you choose → tick
**Auto Confirm User**. Send them the details. They can change their password and the name shown on their
notes from the account button once signed in.

**Resetting a forgotten password:** sign in as yourself, click your name in the top bar, and use
**Admin · reset a player's password**. No email is involved. Avoid Supabase's "Send password recovery"
emails: they expire quickly, some mail apps use them up by previewing them, and they only work once the
Site URL below is set.

**If you're locked out of your own account,** run this in the SQL Editor:

```sql
update auth.users
set encrypted_password = extensions.crypt('NEW-PASSWORD-HERE', extensions.gen_salt('bf'))
where email = 'YOUR-EMAIL-HERE';
```

**Site URL:** Authentication → **URL Configuration** → set **Site URL** to the GitHub Pages address
(e.g. `https://YOUR-USERNAME.github.io/charaterCompendium/`) and add the same address under
**Redirect URLs**. Supabase defaults to `http://localhost:3000`, which is why email links go nowhere.

### Who can do what

| | Players | Admin (you) |
| --- | --- | --- |
| Read all notes | ✓ | ✓ |
| Add sessions and notes | ✓ | ✓ |
| Edit a session | the ones they added | any |
| Edit / delete notes | their own | any |
| Add, rename or delete campaigns | – | ✓ |
| Delete sessions | – | ✓ |

These rules are enforced by the database (row-level security in `setup.sql`), not just hidden in the page.


## Patch notes

`content/patch-notes.md` holds the changelog players see under **Patch notes**, newest first. The top
update is also shown on the home page as "Latest update". Add a new `## D Mon YYYY` block at the top
(under the current year's `#` heading, or start a new `# 2027`), with one line per change:
`- **Thing:** from → to` (use — when something is new or removed).


## Character builder

The **Characters** tab (`creator.js`) builds characters from the handbook content itself, so new races,
classes, subclasses, spells, drawbacks and quirks show up in it automatically.

- Anyone can build a character and download it as a PDF (the browser's print → Save as PDF) or a Word
  document. Signed-in players can also save characters to their account. Players see only their own;
  the admin sees everyone's, read-only.
- Unsaved work is kept in the browser as a draft until it's saved.
- New characters start in a step-by-step setup (it can be skipped). Saved characters open on their sheet;
  **Edit** shows every section, with a side panel of what's left to do.
- **Level up** raises the character one level and lists what that level gives, with each choice in one
  place (stat, hit die, soft skill ranks, feat, milestone boon, SP or FP). **Cancel level-up** puts
  everything back. Earlier levels can still be changed in the Level-ups section.
- **Inventory** is a list of items with quantity, notes and an Equipped tick. Older characters' gear text
  is turned into items, one per line, when they're opened.
- Saving needs the `characters` table: run the latest `supabase/setup.sql` once more.

The rules it applies are at the top of `creator.js` (`RULES`), so they're easy to change:

| Rule | Value |
| --- | --- |
| Stats | 6d4, add the lowest 5 (roll-under) |
| HP | race HP + class HP (+ the class-wide hit dice, rolled in the builder, + any extra) |
| SP | 1 on every level ending 1, 3, 5, 7, 9 and 0; 0 at level 0; plus drawbacks (max 2, max 3 SP) |
| Extra classes (multiclassing) | 1 SP each, no limit; each class then has its own class-wide benefits, abilities, feats and spells to buy. HP comes from the starting class |
| Class-wide subclass benefits | 1 SP per class, before anything else in that class |
| Non-magic classes | any ability from any of the class's subclasses, 1 SP each |
| Magic classes | a subclass's feat, 1 SP, before its spells; any three tiers of its spells, 2 SP |
| Level-ups | from Advancement's Each decade table: stat improvements at X1 (not below 10) and X4 (not below 5), class hit die at X2 and X10, soft skill ranks at X4 and X6, a Tier I–III feat at X8, a milestone boon at X10 |
| Renown | 1 + level ÷ 10; opens feat tiers (II at 3, III at 6, IV at 8, V at 11) and soft skill ranks (Master 2, Grandmaster 6, Legendary 9) |
| Soft skills | one Master per family until Renown 5, one Legendary until Renown 11; ranks past Master only from the milestone boon |
| FP | from level 11, any SP level can be taken as FP instead |
| Sixth subclasses, Prime races | locked until the player ticks "My DM has unlocked this" (sixths) or with a warning (Primes) |

## Settings

The gear button in the header (and the footer link) opens **Settings**: theme (match device, light, dark), contrast, decoration (illuminated or minimal), text size, an easy-read font (Atkinson Hyperlegible), line spacing and animations. Choices are saved in the browser on each device, so there is nothing to set up. They are applied by a small script at the top of `index.html` before the page draws, so the page never flashes the wrong theme.

## Party money

The **Party money** tab (under Your table) gives each campaign a shared **party account** and each character a **purse**.

**Setting it up (once):** run `supabase/setup.sql` again in the Supabase SQL editor. It's safe to re-run; it adds the new tables and leaves existing notes and characters alone. Then, signed in as the admin:

1. Create the campaign on the **Notes** tab, if it doesn't exist yet.
2. Open **Party money**, and use **+ Add a player…** to add each player to the campaign.
3. Each player opens **Party money** and adds their saved character to the campaign. That gives the character a purse.

**Rules (enforced by the database, not just the page):**

- Anyone in the party can put coin from their purse into the party account.
- Taking coin out is a request. Asking counts as one approval; it pays out when one other player approves it. If the party account is short at that moment, it pays out once there's enough and someone presses **Try paying out**.
- Whoever asked can cancel a request; the DM can turn any request down.
- The DM can approve any request at once, and add or remove coin from any account (loot, rewards, fines).
- Players can give coin to another character in the same campaign, and spend from their own purse.
- Players see the party account and their own purses; only the DM sees every purse.
- Amounts are kept in copper: 100 cp = 1 sp, 100 sp = 1 gp, 100 gp = 1 pp.

## Crafting

The **Crafting** tab (under Your table) is for players: pick an item, its materials and a quality for an estimate of what it costs to commission, what it costs to make yourself, what it's worth and what a merchant pays for it (half its value), how long it takes and how much it weighs. Making it yourself costs the materials and any special work, plus a rented forge (metal items, by the day) or workshop (by the week) if you tick it, and the tools for each Crafting skill the item needs: already yours, hired (about a tenth of their price a week) or bought. The Artisan feat halves the materials for the skill you pick. **Copy a link to this estimate** gives a link that opens the same choices for someone else. It uses the item list, recipes and maths from the Market Price Ledger, priced for an ordinary market, without the ledger's town settings or enchantments. Choices are remembered in the browser.

## Item list

`content/items.json` is the item list from the Market Price Ledger (items, materials, qualities and crafting recipes). The character builder's inventory suggests items from it as you type.


## Offline and phones

`sw.js` keeps a copy of the site's own files (pages, rules, fonts) as they load, so once someone has visited, the rules, races, classes, spells, gods and crafting open without signal. When online it always fetches the latest files first, so updates show straight away. Nothing from Supabase is kept: notes, characters, party money and the bestiary need a connection. If you add a new file the site loads, add it to the list at the top of `sw.js` too. On phones, long pages get a round **back to the top** button once you've scrolled down.

## Bestiary (DM only)

The **DM** tab group (Volume I, Volume II, Volume III, Named monsters, Dragons & elementals, Encounters, Combat tracker, Monster rules) only appears for the admin account. Everything in it comes from *Bestiary: Volume I*, *Bestiary: Volume II* and *Bestiary: Volume III – Peoples and Powers*.

**Why the data isn't in this repo:** anything in a GitHub Pages repo can be downloaded by anyone, including tactics, tells and exploits. So the monster data lives in Supabase, in a `bestiary` table that only the admin account can read. The site loads it after you sign in as the DM. Players, and people who aren't signed in, get nothing back.

**Setting it up (once):** the SQL that loads the data is in the separate `bestiary-data` folder, not in this repo, because it holds the whole bestiary. Supabase dashboard → **SQL Editor** → New query → paste all of `bestiary-data/bestiary.sql` → **Run**. Then do the same with `bestiary-data/bestiary-2.sql` (Volume II) and `bestiary-data/bestiary-3.sql` (Volume III). Run `setup.sql` first if you haven't. All three are safe to run again: they replace the data. Never commit any of them, or the `bestiary-data` folder, to this repo: `.gitignore` blocks them in case they're copied in by mistake.

**What's in it:**

- **Bestiary:** search by name, filter by type, role and KR range, sort by KR or name. Each stat card has Alpha, Boss and Minion toggles that apply the template maths, tooltips on statuses and rule keywords (hover, or tap on a phone), **Add to encounter**, **Print** (one page, A4 or Letter) and **Copy as text** (plain text for Discord or a virtual tabletop).
- **Dragons & elementals:** pick dragon or elemental, tier, flavour and disposition to get the finished block, with the flavour's status, weakness, movement, lair effect and signature moves.
- **Encounters:** add creatures from either volume and the party's levels (level 0 counts as ½). The Pemmaroth encounter tables show both volumes: Volume II's creatures are placed by family (set in `REGION_FAMILIES` near the top of the encounter code in `bestiary.js`), and its named monsters are left out because they aren't tied to a place. **Suggested encounters** offers an easy, a fair and a deadly group for the party's total, built from one Volume III faction, rival party or section, Volume II family or Volume I type (or any), using the solo, pack, leader and followers, boss, and boss and minions shapes. Press **Another** for a different one, **Use this** to replace the encounter, or **Add to the encounter**. It applies the group multiplier (minions don't count towards group size) and rates the fight: **easy** when the party total is at least 1.5× the KR, **fair** from 0.75× to 1.5×, **deadly** below 0.75×. The encounter is saved in the browser on that device.
- **Volume II:** the intro (with Weak Point, Countdown and Shift), a page per family with its creatures in KR order, the 50 named monsters, and an index of all 300 (or both volumes) you can sort and filter by family, KR range and named only. Every stat block has its own link, e.g. `#tab=vol2&page=beasts-of-the-wilds&mon=gloamfox`, and a **Copy link** button.
- **Volume III:** the intro (with Command, Break, Terms and Loadout), the seven new templates, the GM toolkit (encounter steps, a sortable taming and mounts table linked to Volume II, and trap cards with Find, Disarm and Break), a page for each of the 12 factions, the rival parties, each Powers section, the 30 named leaders and the Pemmaroth appendix. A faction page opens with its Wants, How they fight, Break and Terms, its three recipes (each with **Use this** and **Add** for the encounter builder), any faction-wide trait (the Hungering Choir's has a Song counter from 0 to 6), then a rank ladder and the nine ranks. Leaders' **Command** lines stand out at the top of their blocks, and **Loadout** shows as a row of options. Tags link a Throne to its god in the Book of Gods, a flavour to its subclass (Soul, Mind (domination), Creation and Destruction have no subclass of that name, so they aren't linked), a named leader to its faction, and Divine to its explanation. The Void page has its own darker look. A rival party's page can load the whole party as the encounter. The index covers Volume III or all three volumes, with section, KR range, named only and divine only filters. Links look like `#tab=vol3&page=roadwolves&mon=pack-sergeant`. The Pemmaroth appendix has campaign spoilers; like the rest of the bestiary, only the DM account can see it. In the combat tracker, a fight with Choir members shows the Song, and ranks with their own Defiant (like the Roadwolf Chieftain) get Defiant pips.
- **Weak points, countdowns and shifts:** each stat block that uses one has a tracker: type damage into a weak point, tick a countdown die down, tap the mode a shifting creature is in. They reset when you reload.
- **Search:** signed in as the DM, the main search box also finds bestiary entries by name, family, Tell and Exploit.
- **Monster rules:** Running monsters, status effects, the KR budget, harvest values, the templates, flavours, disposition, creature types, the index by KR, and the Pemmaroth encounter tables (on the Encounters page).

**Combat tracker (DM):** press **Run this fight** on the Encounters page (or open the Combat tracker tab). Type everyone's initiative (Enter moves to the next box) and press **Start the fight**. **Next turn** moves down the order and counts rounds; creatures at 0 HP and adventurers marked down are skipped. Each creature has its own HP (minions die to any damaging hit, and **Undo** takes back the last HP change), status stacks (capped at each status's max), weak points, countdowns, shifts, recharge timers (they count down at the start of the creature's own turns), Defiant uses, and a phase alert at 66% and 33% for bosses and named monsters. At the start of each turn a box lists what applies: bleed, burn and toxic damage (with an **Apply** button for creatures), stun, sleep, paralysis, madness, freeze, exhaustion, and recharges that are ready again. Lair actions get their own row on initiative 20 when a boss or named monster is in the fight. **End the fight** lists the spoils from everything that fell. Nothing is rolled for you, and the fight is saved in the browser so a reload doesn't lose it.

**Data files:** the clean JSON (creatures, templates, KR budget, harvest, flavours, disposition, encounter tables and rules) is kept outside this repo, in `bestiary-data`. The combat simulator and price tool can use the same files, or read the `bestiary` table. If you change the JSON, run `python3 make-sql.py` in that folder to rebuild `bestiary.sql`, `bestiary-2.sql` and `bestiary-3.sql`, then run them in Supabase again.

**Status effects** aren't secret, so they live in this repo, in `content/statuses.json`. That one list feeds the players' Core rules page (Advancement → Core rules → Status effects), the Monster rules page, the tooltips and the combat tracker. Edit it there and every page updates.

Files: `bestiary.js` (all the DM pages), `content/statuses.json` (status effects). The table, its access rules and the data are in `bestiary-data/bestiary.sql`, `bestiary-2.sql` and `bestiary-3.sql`, outside the repo.
