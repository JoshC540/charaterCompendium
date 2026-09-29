# Character Compendium

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
