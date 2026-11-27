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
- **From the DM:** the DM (signed in, looking at a player's character) opens **DM: give this character something** above the sheet. It gives:
  - **a feat** outright, or an extra pick up to a tier (the player chooses; Renown doesn't hold it back);
  - **soft skill ranks** in a named skill (on top of the player's own), or extra ranks to spend;
  - **a drawback or quirk** (Drawbacks, Mythic Drawbacks or Quirks). A drawback the DM gives doesn't use the player's two picks and gives no SP back unless **Gives its SP back** is ticked (Advancement says play-acquired and Mythic drawbacks refund SP, so tick it when that applies);
  - **a Mark** from the Marks or Mythic Marks lists, or one the DM writes, with the deed that earned it;
  - **something else** with a name and what it does, and **extra SP**.
  - **a weapon or armour** the DM makes up, with any numbers: damage dice of any size (1d30, 2d50+3, 1d75; up to 50 dice of 1000 sides, as the dice log rolls), Melee, Ranged or Casting, and for armour the place it's worn, Defence, Min hit, temp HP and a note. It shows in Attacks and armour marked *from the DM* and counts like worn gear (DM armour takes its place first);
  - **an item's numbers** (*Set an item's numbers*): pick a weapon or armour the character carries and set its dice, what it hits with, Defence, Min hit or temp HP. A box left empty keeps the item's own number; what the DM sets is final (quality and material aren't added on top). *Back to its own numbers* undoes it;
  - **extra Defence, Min hit and temp HP**, added to the armour totals.

  They're kept in their own table (`character_grants`): only the DM writes it and only the character's owner (and the DM) reads it, so a player can't change or remove them and an open sheet can't overwrite them. The player sees them on the sheet (Feats, Soft skills, Marks, From the DM, Drawbacks and quirks), in the exports, and in a **From the DM** section in Edit. Run the latest `supabase/setup.sql` to switch it on.
- **Inventory** is a list of items with quantity, notes, quality and an Equipped tick. Older characters' gear text
  is turned into items, one per line, when they're opened. Weapons and armour from the item list come with their fighting numbers (shown under each one); anything else can be given its own with **Use as a weapon or armour** (damage, the stat it hits with, its type and two-handed; or Defence, Min hit, temp HP and where it's worn). Editing the numbers makes them the item's own; **Use the item list's numbers** goes back. Your class's starting weapons and equipment (from its subclass page) are offered as one-tap picks.
- Saving needs the `characters` table: run the latest `supabase/setup.sql` once more.
- **Play** (on a saved character) is the live sheet for the table: see *Live character sheets* below.
- **Stats** are rolled the way the DM sets for the campaign (Session screen → Character rules): roll a set and place each number (the default, no rerolls) or roll each stat in order, with none, one, two or unlimited rerolls. Every set rolled, reroll and number typed in by hand is listed under **Stat rolls** on the sheet.
- **Attacks and armour** work from what's equipped in the inventory:
  - **Weapons** become attacks with their damage dice and the stat they hit with. A weapon your classes aren't trained in (from each class's weapons line, e.g. Soldier: swords, spears, polearms, shields) is marked, and its To hit rolls with disadvantage in the dice roller. Weapons from your class's starting kit always count as trained.
  - **Spells and other attacks** (unarmed, anything that isn't a weapon you carry) are added by hand, as before; spells with dice can be added in one tap.
  - **Armour:** one piece counts for each place (body, shield, head, hands, arms, legs, neck); a second body armour is listed as not counting. Their Defence adds to the class's, the highest Min hit counts, and their temp HP adds up. Barding is for a mount and doesn't count for the character.
  - **Quality:** Great +1, Masterwork +2, Legendary +3, Artifact +4 to a weapon's damage, and to Defence for body armour and shields. Broken gear doesn't count until it's repaired.
  - **Made of:** the material, from the item list's metals, woods, hides and cloths; a better or worse one scales the numbers (see *Item list* below).
  - The old typed-in armour box is turned into an equipped item when a character is opened.
  - The rules are in Core rules → Attacks and armour.
- **The sheet** reads in table order (At a glance and Attacks first, background and notes last), with a bar to jump to each part; tap a long section's heading to fold it.

The rules it applies are at the top of `creator.js` (`RULES`), so they're easy to change:

| Rule | Value |
| --- | --- |
| Stats | 6d4, add the lowest 5 (roll-under) |
| HP | race HP + class HP (+ the class-wide hit dice, rolled in the builder, + any extra) |
| SP | 1 on every level ending 1, 3, 5, 7, 9 and 0; 0 at level 0; plus drawbacks (max 2, max 3 SP) |
| Extra classes (multiclassing) | 1 SP each, no limit; each class then has its own class-wide benefits, abilities, feats and spells to buy. Every class adds its class HP; hit dice are the highest of your classes' |
| Class-wide subclass benefits | 1 SP per class, before anything else in that class |
| Non-magic classes | any ability from any of the class's subclasses, 1 SP each |
| Magic classes | a subclass's feat, 1 SP, before its spells; any three tiers of its spells, 2 SP |
| Level-ups | from Advancement's Each decade table: stat improvements at X1 (not below 10) and X4 (not below 5), class hit die at X2 and X10, soft skill ranks at X4 and X6, a Tier I–III feat at X8, a milestone boon at X10 |
| Renown | 1 + level ÷ 10; opens feat tiers (II at 3, III at 6, IV at 8, V at 11) and soft skill ranks (Master 2, Grandmaster 6, Legendary 9) |
| Soft skills | one Master per family until Renown 5, one Legendary until Renown 11; ranks past Master only from the milestone boon |
| FP (Final Points) | from level 11, any SP level can be taken as FP instead; spent on final classes |
| Sixth subclasses, Prime races | locked until the player ticks "My DM has unlocked this" (sixths) or with a warning (Primes) |

## Live character sheets

Every saved character has a **Play** view (Characters → the character → **Play**) for use at the table:

- **HP:** damage and healing (damage takes temp HP first; HP never goes below 0 or above max), temp HP, and back to full. At 0 HP it shows death-save pips (3 passed, 3 failed) to tick, with **Stable** or **Dead** at three; the DM rules on them at the table. Death saves also show in the combat tracker, the players' fight view and the table screen.
- **Rests:** **Short rest** rolls the character's hit die (into the dice log) for HP and brings back per-combat and per-rest uses. **Long rest** gives full HP, clears death saves, sets temp HP to what the equipped armour gives, and brings back per-combat, per-rest and per-long-rest uses.
- **Statuses:** add any status from the shared list, with stacks capped at each status's max and its rules beside it.
- **Uses:** anything used a set number of times (a feat, a skill, spells of a tier), each resetting after a combat, a rest, a long rest, a day, a session, an arc or never. **End of combat**, **New day**, **New session** and **New arc** appear when something resets that way. Feats whose text says "once per rest", and bought subclass abilities that say "three times a combat", "twice per long rest" and so on, are offered as one-tap suggestions.
- **Table notes:** a free box for concentration, debts, anything.
- **Dice:** check buttons for every stat, To hit and Damage for every attack, and any dice (`2d6+3`). Rolls are made by the database (`roll_dice` in `setup.sql`), so nobody can type a result in, and every roll goes in the campaign's dice log, which everyone in the campaign sees. Exhaustion 1 (−2), 2 (disadvantage), 3 and 4 (the extra dice) and Freeze (halved dice) are applied for you; Fear and Poisoned show as reminders. The DM rolls from the Session screen and can roll in secret.
- **Following a fight:** when the DM runs a fight for the campaign, the Play view shows the turn order, whose turn it is and who's next, the party's HP, and enemies only as unhurt, hurt, badly hurt or down.
- **Abilities, feats and spells:** everything from the sheet in one searchable list.
- **No signal?** Changes are kept on the device and sent, in order, when the connection is back (the sheet says how many are waiting).
- **From the party stash or a shop:** anything handed over or bought waits on the sheet with **Add to my inventory** (weapons and armour keep their quality and numbers).

The same sheet shows in the DM's **Combat tracker**: **+ Add saved characters** brings anyone in (grouped by campaign), and from then on HP, statuses and uses are one shared record. When the DM deals damage, the player's sheet changes within a few seconds, and the other way round. Bleed, burn and toxic on a saved character's turn apply to the live sheet.

Who can see and change it: the player who owns the character and the DM can change it; players in the same campaign can see it. Changes go through a database function (`play_change` in `setup.sql`) that applies them on the server, so two people changing HP at once can't overwrite each other.

**Setting it up (once):** run the latest `supabase/setup.sql`. It adds the `character_play` table and turns on live updates for it. If live updates aren't on in your project, the sheets check every few seconds instead.

## Atlas

The **Atlas** tab (under Your table) holds places, factions, people, creatures, items and lore. The DM writes every entry and decides when players see it:

- Signed in as the DM, **+ New entry** adds one: kind, name, region (entries are grouped by kind, then region), an optional picture link, what the players learn, and **your notes**.
- Every entry starts **hidden**. **Reveal to players** shows it to every signed-in player; **Hide it again** takes it back.
- Write `[[Another entry]]` to link to another entry (or `[[Another entry|shown text]]`). A link only works for players once the entry it points to is revealed too; until then they see plain text. Each entry also lists the entries that mention it.
- **Your notes** are kept in a separate table only the admin account can read, so they never reach a player's browser.
- Players see only revealed entries, can filter by kind and search them, and the main search box finds them too.
- **Pictures:** in the editor, choose a picture or drop one on the box. It's shrunk in the browser (at most 2400 px, WebP) and stored in a private Supabase Storage bucket (`atlas`), so players can only load it once its entry is revealed. A link to a picture hosted elsewhere still works.
- **Maps:** any entry with a picture can be a map. Signed in as the DM, press **Use as a map: place pins**, click the picture where a pin goes and pick the entry it points to. Players see a pin only once the map and that entry are both revealed, and each entry lists the maps it's on.
- **Busy maps:** pins are numbered, with a key under the map grouped by kind; pointing at a pin or a line in the key picks it out and fades the rest. Only one name shows at a time unless **Show all names** is on (it's on by default for 8 pins or fewer). The kind buttons under the map show only places, people and so on. **Enlarge** opens the map full screen: drag to move around, and zoom with + and −, a pinch, or Ctrl + scroll (up to 600%), so crowded pins spread apart. Esc or Close goes back.

This is enforced by the database (row-level security on `atlas`, `atlas_dm` and `atlas_pins` in `setup.sql`), not just hidden in the page. **Setting it up (once):** run the latest `supabase/setup.sql`.

## Session screen (DM)

**Session** is the first tab in the DM group: one page for the night, per campaign (pick it at the top).

- **The party:** every character in the campaign, live from their sheets (HP, temp HP, statuses, who's down). Tap one to change their HP, statuses or uses. **Raise the party to level N** gives everyone below it a **Level up** prompt on their own sheet, so they still make their own choices.
- **Encounters for tonight:** build an encounter in Encounters, then **Add the one in Encounters** with a name. Each shows its KR and how it rates against this party. **Start the fight** puts the party's saved characters (linked to their live sheets) and the creatures into the combat tracker.
- **To reveal:** queue hidden atlas entries the party might uncover, then reveal each with one tap.
- **Loot:** items to tick off as you hand them out, and coin (`40 gp`, `12 gp 5 sp`, or a plain number for gold) that **Pay into the party account** adds to the campaign's party money.
- **Notes for tonight:** only you see them.
- **Table dice:** roll for the table or in secret; the campaign's dice log is underneath.
- **End of the session:** fights started, entries revealed, coin paid out, items handed out and levels given are noted as you go. **Write the recap** turns them into a draft you can edit, then **Post to Notes** adds it to a new session (or an existing one) for the players.
- **Character rules:** how players in this campaign roll stats, and how many rerolls they get.
- **Contracts:** what's on the board or taken, with **Done** (pays the reward into the party account) and **Failed**. Both go into the recap.
- **Next session:** offer dates (and where), see who said yes, maybe or no, and **Pick this one**. Players answer on their home page and in Notes, and see the picked date there.
- **Handouts:** write a letter or note, add a picture (shrunk before it's sent) or a link, then **Show it now** or **Save for later** and **Show** it when the moment comes. Shown handouts go into the recap.
- Starting a fight from here also lets the campaign's players follow it on their phones; in the combat tracker, **Players follow it in** picks the campaign (or nobody).
- **Backup:** **Download everything** saves the whole database as one JSON file (campaigns, sessions, notes, characters, live sheets, party money, the atlas with your notes and pins, and these plans). The bestiary isn't in it; that's in `bestiary-data`.

The plan saves as you go, in a `dm_store` table only the admin account can read. Files: `session.js`. **Setting it up (once):** run the latest `supabase/setup.sql`.

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

## Party stash

In **Party money**, the **Party stash** holds spoils and gear the party shares. Anyone in the campaign can **Put something in** (same name and notes stack up). To take something out, **Ask for it** for one of your characters: like a party account withdrawal, asking counts as the first approval, a second player's approval hands it over, and the DM's approval (or the DM asking) hands it over at once. It then waits on that character's sheet until the player adds it to their inventory, so nothing is overwritten on a sheet someone is editing. The DM can also remove things (used up, sold, lost). Everything is in the stash history. The Session screen's Loot can send items straight into the stash.

## Shops

The **Shops** tab (under Your table) lists the shops open in the campaign. The DM makes a shop with **+ New shop**: a name, where it is, a line players see, its prices as a % of the item list (set it for the town, supply and the party's standing; 100 is the item list's price) and what it pays for things (the item list's usual is 50%). Stock it from the item list (the price is worked out from the item, its quality and the shop's %, and can be changed) or with anything else at a price you write, with a number in stock or no limit. Players only see a shop once it's **open**.

- **Buying:** choose the character, how many and **Buy**. The coin comes out of that character's purse at once (it has to be there), stock goes down, and the item waits on the sheet to add to the inventory.
- **Selling:** pick something from the character's inventory and an asking price (the shop's share of the item list's price is suggested). It leaves the sheet while the offer stands. The DM **Pays it** (the coin goes into the purse) or **Turns it down** (it goes back on the sheet); the player can **Take it back** before then.
- Everything is in the shop's **Recent sales** and in Party money.

Files: `table.js`. Buying, offers and answers go through `shop_buy`, `shop_offer`, `shop_offer_answer` and `shop_offer_cancel` in `setup.sql`.

## Contracts

The **Contracts** tab is the guild's board for the campaign. The DM writes a contract (title, client, guild tier, reward, deadline, details), saves it as a draft or **posts** it. Players see posted contracts and **take** one (or give it up). When the DM marks it **done**, the reward goes into the party account; **failed** pays nothing. Drafts and withdrawn contracts are only seen by the DM.

## Handouts and the next session

Handouts the DM shows pop up on players' screens (on whatever page they're on, within about 20 seconds) and are listed under **Notes**, with the latest on the home page. Pictures are stored in a private Supabase Storage bucket (`handouts`), so players can only load one once its handout is shown.

The next session's dates are at the top of **Notes** and on the home page: answer **Yes**, **Maybe** or **No** for each date (tap again to take it back). Once the DM picks one, it shows there instead.

## Table screen

**Table screen** (under Your table) is for a TV or laptop at the table. Pick the campaign; it shows the fight the DM is running (turn order, whose turn, the party's HP, enemies in words, death saves), the last few rolls from the dice log (never the DM's secret ones), and the map the DM picks (with revealed pins only, even when the DM is signed in). A handout the DM shows takes the main space for 15 minutes, or until **Stop showing the handout**. **Full screen** hides the rest of the site. It updates every few seconds.

## Crafting

The **Crafting** tab (under Your table) is for players: pick an item, its materials and a quality for an estimate of what it costs to commission, what it costs to make yourself, what it's worth and what a merchant pays for it (half its value), how long it takes and how much it weighs. Making it yourself costs the materials and any special work, plus a rented forge (metal items, by the day) or workshop (by the week) if you tick it, and the tools for each Crafting skill the item needs: already yours, hired (about a tenth of their price a week) or bought. The Artisan feat halves the materials for the skill you pick. **Copy a link to this estimate** gives a link that opens the same choices for someone else. It uses the item list, recipes and maths from the Market Price Ledger, priced for an ordinary market, without the ledger's town settings or enchantments. Choices are remembered in the browser.

## Item list

`content/items.json` is the item list from the Market Price Ledger (items, materials, qualities and crafting recipes). The character builder's inventory suggests items from it as you type, and shops are stocked from it. Weapons and armour carry a `fight` entry with their fighting numbers: weapons `dice`, `stat` (Melee or Ranged), `hands` and `tags` (the weapon types matched against each class's weapons line); armour `slot`, `def` (Defence), `minHit` and `thp` (temp HP). Both have `mat` and `kg`: their main material (`metal`, `wood`, `leather` or `cloth`) and how much of it, from the item's recipe. The numbers are for the standard material (steel, oak, cured leather, wool). Armour's come from its recipe: light armour (tier 1 or lower) gets temp HP from how much cloth, leather and metal it holds (15–25 for body armour) and no Min hit; heavy armour gets 20–40 temp HP, Defence and Min hit from its metal. Featherlight chain shirt and dragonhide armour are a chain shirt and hide armour with a set `material` (mithral, dragonhide).

**Materials.** In the inventory and when stocking a shop, an item from the list can be made of any material of its kind (**Made of**). Its numbers then scale by that material's tier against the standard's: each tier up alternately adds +1 damage and a bigger damage die (1d8 → 1d8+1 → 1d10 → 1d10+1 → 1d12; past a d20 it's +2 a tier); armour gets +1 Min hit and +20% temp HP a tier, and +1 Defence every two tiers (body armour and shields). A worse material takes the same off. A shop's suggested price adds the difference in what the main material costs per kg. The rule is in Core rules → Attacks and armour. Special materials also carry `fx`: `w` (on a weapon) and `a` (on armour), a line of rules text each. It counts only when the material is the item's main one, and shows in the sheet's attack notes and armour list, the inventory, the PDF and Word sheet, shop stock and the crafting estimate. It's text for the table to apply, not worked into the numbers. `fightDraft: true` means the numbers are a first draft; change any in the file, and set it to `false` once they're signed off (the inventory stops saying they're being checked).


## Offline and phones

`sw.js` keeps a copy of the site's own files (pages, rules, fonts) as they load, so once someone has visited, the rules, races, classes, spells, gods and crafting open without signal. When online it always fetches the latest files first, so updates show straight away. Nothing from Supabase is kept: notes, characters, party money, the atlas, the session screen and the bestiary need a connection. The one exception is live sheets: HP, coin, conditions and the rest changed with no signal are kept on that device and sent when it's back online. If you add a new file the site loads, add it to the list at the top of `sw.js` too.

On phones (700 px wide or less), the sections (Rules, Characters, Notes and so on) are in a bar at the bottom of the screen, buttons and links are bigger, and an arrow appears beside a section's pages when there are more than fit. Long pages get a round **back to the top** button once you've scrolled down.

Signed in, the home page starts with **Your table**: your characters with their HP (and a flag when there's a level to take or something from the stash), the latest note, and atlas entries revealed in the last 30 days. The DM also gets a link to the Session screen.

## Final classes (DM only, and players you let in)

**Character → Final classes** has every final class: each class's finals (abilities, or base abilities and spells for casters), what every final of that class also gets, and the four new Mage schools (drafts). The tab only shows for the DM and for players the DM has let in; everyone else doesn't see it at all.

**Letting a player see them:** Final classes → **Who can see them**. Open a player and tick the classes whose finals they may read, or **Every final class**. Untick to take it away. A player sees the change the next time they open the page. The new Mage schools stay with the DM.

**Why the text isn't in this repo:** same as the bestiary: anything in a GitHub Pages repo can be downloaded by anyone. The finals live in Supabase, in a `finals` table; the database only hands a class's finals to the DM and to players with a matching row in `final_access` (row-level security in `setup.sql`).

**Setting it up (once):** run the latest `supabase/setup.sql`, then the SQL that loads the text, which is in the separate `finals-data` folder (not this repo): Supabase dashboard → **SQL Editor** → New query → paste all of `finals-data/finals-1.sql` → **Run**, then the same with `finals-2.sql` and `finals-3.sql`. They're safe to run again: they replace the text, and leave who can see what alone. Never commit them, or the `finals-data` folder, to this repo: `.gitignore` blocks them.

Files: `finals.js`.

## Bestiary (DM only)

The **DM** tab group (Session, Volume I, Volume II, Volume III, Named monsters, Dragons & elementals, Encounters, Combat tracker, Balance lab, Monster rules) only appears for the admin account. Everything in it comes from *Bestiary: Volume I*, *Bestiary: Volume II* and *Bestiary: Volume III – Peoples and Powers*.

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

**Combat tracker (DM):** press **Run this fight** on the Encounters page (or open the Combat tracker tab). Type everyone's initiative (Enter moves to the next box) and press **Start the fight**. **Next turn** moves down the order and counts rounds; creatures at 0 HP and adventurers marked down are skipped. Each creature has its own HP (minions die to any damaging hit, and **Undo** takes back the last HP change), status stacks (capped at each status's max), weak points, countdowns, shifts, recharge timers (they count down at the start of the creature's own turns), Defiant uses, and a phase alert at 66% and 33% for bosses and named monsters. At the start of each turn a box lists what applies: bleed, burn and toxic damage (with an **Apply** button for creatures), stun, sleep, paralysis, madness, freeze, exhaustion, and recharges that are ready again. Lair actions get their own row on initiative 20 when a boss or named monster is in the fight. **End the fight** lists the spoils from everything that fell. Nothing is rolled for you, and the fight is saved in the browser so a reload doesn't lose it. **+ Add saved characters** brings players' saved characters in, linked to their live sheets (see *Live character sheets*); **Undo** covers creatures, not those characters.

**Balance lab (DM):** two tools, from **Test it in the balance lab** on the Encounters page or the Balance lab tab.

- **Fight simulator:** pick saved characters (or use the party levels from Encounters) and it runs the current encounter 200, 1,000 or 5,000 times: how often the party wins, how often someone drops or everyone does, how long fights last, how often each adventurer drops and how much damage they deal, and one fight blow by blow. HP, Dodge, Defence, Min hit and their best attack (its stat and damage dice) come from each character's sheet; anything not rolled yet uses the standard adventurer's number (marked *). Type each adventurer's damage a hit as dice; left blank, it uses what the KR system expects at their level.
- **Your rulings:** each flagged creature gets **Your call**: fine as is, change its KR to a number, or look later. The book's open questions (from putting the volumes in) are listed below with the same choices. Rulings are saved for you only (`dm_store`) and drop off the list; **Copy my rulings** gives the list to apply to the data files, after which the SQL is run again. They're recorded, not applied straight away.
- **KR check:** measures every creature in all three volumes against the creatures of about the same KR (damage it deals a round, and damage it takes to bring down, against a standard party whose levels add up to its KR), and runs it 100 times against that party. It lists the ones that play noticeably stronger or weaker than their KR, with the KR they play like. A flag is a prompt to look, not a verdict: creatures whose danger is control, summoning or tactics read as weaker than they are.
- **The rules it uses** are on the page, and the choices that matter can be changed there: who monsters attack, Dodge rolls a round, natural 20s, how many adventurers an area attack catches, and whether Min hit applies to adventurers' hits. It doesn't model status effects, saves, spells and feats beyond plain damage, healing, movement, morale, phases or lair actions.
- The standard adventurer (HP, Melee and Dodge by level, and the damage a hit the KR system expects) is in a table on the KR check page, and its numbers are at the top of the engine in `lab.js` (`STD`).


**Data files:** the clean JSON (creatures, templates, KR budget, harvest, flavours, disposition, encounter tables and rules) is kept outside this repo, in `bestiary-data`. The balance lab reads the same data from the `bestiary` table. If you change the JSON, run `python3 make-sql.py` in that folder to rebuild `bestiary.sql`, `bestiary-2.sql` and `bestiary-3.sql`, then run them in Supabase again.

**Status effects** aren't secret, so they live in this repo, in `content/statuses.json`. That one list feeds the players' Core rules page (Advancement → Core rules → Status effects), the Monster rules page, the tooltips and the combat tracker. Edit it there and every page updates.

Files: `bestiary.js` (the DM pages), `lab.js` (the balance lab), `content/statuses.json` (status effects). The table, its access rules and the data are in `bestiary-data/bestiary.sql`, `bestiary-2.sql` and `bestiary-3.sql`, outside the repo.
