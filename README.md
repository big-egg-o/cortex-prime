# Cortex Prime for Foundry VTT

A game system implementing the Cortex Prime rules for Foundry Virtual Tabletop **V14**.

Status: early and incomplete, but playable for the basics. A GM can configure trait sets and
actor kinds, characters have a sheet driven by that configuration, and dice pools, tests and
contests are rolled and resolved on chat cards. Automated plot point bookkeeping, assets, complications,
stress and optional mods are not implemented yet, and data may still change between releases.

## Trying the character sheets

Back up the world in Foundry Setup before opening it with this version. In a test world, use
**Create Actor → Player character** or **GMC**. **Game Configuration → Layout for all player
characters** selects the shared PC layout. In **Edit sheet**, a GM can add blocks to a GMC.
Hiding a block keeps its contents, and adding it again restores them. PC plot point balances
are recorded manually in Edit sheet. Selecting dice previews the pool's cost or gain.
**Review pool** opens the Pool Builder for the current user.

Existing characters, compendium entries, locations and unlinked tokens retain their classic sheet
and document IDs. To try one with the new sheet, a GM can open its sheet's header menu and choose
**Create PC copy in world** or **Create GMC copy in world**. This creates a separate world Actor
from the sheet's current data, including a token's own changes. Existing tokens, assignments
and chat references continue to point to their original Actors. A copied PC uses the world's
PC layout. Edit mode lists stored traits outside that layout.

To return to an original character, open the classic Actor. To roll back the whole installation,
stop Foundry, restore the previous system version, and restore the matching pre-upgrade world
backup in Setup. A world restore returns play and world settings to the time of that backup.

## Development

Specs, decisions and the development environment guide live in the Outline collection
"Cortex Prime to Foundry VTT". Local-only reference material (handbook, Foundry client
source) goes in `reference/`, which is git-ignored and never committed.

## License

The code in this repository is released under the [MIT License](LICENSE).

This is an unofficial, free fan project. It contains no text from the Cortex Prime Game Handbook;
you need your own copy of the rules to play. Cortex and Cortex Prime are trademarks of their
respective owners, who are not affiliated with or endorsing this project.
