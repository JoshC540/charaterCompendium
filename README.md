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

The two DM-only passages of the Book of Gods (reading Pluras's blot, and why the Namewright was erased)
were left out on purpose — don't paste them back in.

## Session notes and sign-in (Supabase)

The handbook itself is open to anyone with the link. Signing in is only needed for the **Notes** tab,
where players share notes organised by campaign and session. The sign-in button is in the top bar on
every page.

Files: `notes.js` (sign-in and notes), `vendor/supabase.js` (the Supabase library, kept here so the site
doesn't depend on another CDN), `supabase/setup.sql` (the database). The project address and its public
"anon" key are at the top of `notes.js`. The anon key is meant to be public; never put the
`service_role` key in this repo.


### Adding a player

Authentication → Users → Add user → Create new user → their email and a password you choose → tick
**Auto Confirm User**. Send them the details. They can change their password and the name shown on their
notes from the account button once signed in.

**Resetting a forgotten password:** sign in as yourself, click your name in the top bar, and use
**Admin · reset a player's password**. No email is involved. Avoid Supabase's "Send password recovery"
emails: they expire quickly, some mail apps use them up by previewing them, and they only work once the
Site URL below is set.
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

`content/patch-notes.md` holds the changelog players see in the **Patch Notes** tab, newest first. The top
update is also shown on the home page as "Latest update". Add a new `## Date — Title` block at the top
(under the current year's `#` heading, or start a new `# 2027`), with `### New`, `### Changed` and
`### Fixed` lists as needed.
