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

## Item list

`content/items.json` is the item list from the Market Price Ledger (items, materials, qualities and crafting recipes). The character builder's inventory suggests items from it as you type.

