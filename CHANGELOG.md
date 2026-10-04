# Changelog

All notable changes to MX Stage are listed here. Versions follow [Semantic Versioning](https://semver.org/). Each version becomes available under the Apache License 2.0 four years after its release (see [LICENSE](LICENSE)).

## Unreleased

### Added

- **Filters in the one-row-per-record view.** Column headers in the wide specification view open the same filter menu as other tables. Missing and empty values count as empty, and items outside the record's classification appear as "(not in classification)", so you can list the records missing a given item.
- The color legend explains the yellow, grey and ⚠ cells of the wide view.
- **Classification hierarchy path in the wide view.** The one-row-per-record view shows each record's classification as its hierarchy path with the description (for example MECH  ROT  PUMP (Pump)), taken from a loaded classification sheet; without one it shows the classification ID. When specifications are loaded without CLASSSTRUCTUREID or without a classification sheet that has HIERARCHYPATH, load_sheet tells the AI what to load (it asks you first).

- **Skills for every step and for standard Maximo objects.** The built-in Skills are now 17: an index (`mxstage-workbench` 2.0.0: the rules for every task and which Skill to read when), 8 basic operations (`mxstage-core-*`: loading, analysing, changing, matching, importing, committing, the work screen, writing user Skills) and 8 standard Maximo objects (`mxstage-obj-*`: assets and meters, locations, classifications and specifications, work orders and service requests, PMs and job plans, items and inventory, purchasing, reference data), each saying what Maximo does with the object, what MX Stage can and cannot change, and the traps (for example, changing an asset's classification rebuilds its specifications). The first tool result of a conversation carries the index with the list of all Skills by layer, and the results of loading, changing, matching, importing and committing tools name the Skills for that step. Settings → Skills lists them by layer.

### Changed

- User Skills cannot use names starting with `mxstage` (reserved for built-in Skills); such Skills are not loaded, with the reason shown in Settings → Skills. Saved user Skills record `metadata.category: "user"`.
- **Reloading keeps your work.** When the work screen asks you to reload (for example after an update), it now asks MX Stage on this PC to keep the sheets, changes and undo history in memory while the tab reloads, and restores them afterwards (kept for 10 minutes; nothing is written to disk).
- Settings → Updates: after downloading the Claude Desktop extension, a button copies the file's path, for when the folder does not open (Claude Desktop runs the extension in the background).

## 0.2.4 — 2026-10-02

### Added

- **One row per record for specification tables.** Child tables shaped as item–value pairs (such as asset, location and item specifications) can be shown with one row per record and one column per item. The work screen chooses this automatically from the table's shape, and the button in the table header switches between the two views (remembered per object structure). Edits in the wide view change the matching specification row (the numeric or text value column), so differences, undo, commit and the AI's tools work as before. Units appear under the item names; grey cells have no row for the item; cells marked ⚠ have duplicate rows or a value in an unusual column and are edited in the one-row-per-item view.
- **Missing specifications.** When the classification specifications (CLASSSTRUCTUREID with its CLASSSPEC) are loaded, the one-row-per-record view marks items that the record's classification has but the record lacks in yellow, and items outside the classification in grey. Entering a value in a yellow cell adds the specification row (item, value, the classification's unit and classification ID). If the attributes (ASSETATTRID with DATATYPE) are loaded too, numeric items go into NUMVALUE and text items into ALNVALUE. Items that the classification defines but no record has yet appear as columns as well.

### Fixed

- The development fake Maximo (npm run dev:fake-maximo) rejected every write because it passed request bodies on as bytes.

## 0.2.3 — 2026-10-02

### Added

- **Settings → Updates.** Shows your version and lets you check for a new one. **Update automatically** is off by default; while it is off, MX Stage never contacts GitHub. When it is on, the bridge asks GitHub once a day for the latest version number (nothing about you is sent). Installs made with the setup script then update themselves while no work is open (no window has sheets and the AI is not running a tool) and restart the bridge; copies on another branch or with local changes are left alone. The Claude Desktop extension downloads the new .mcpb, checks its SHA-256 and opens its folder for you to install.
- The work screen tells you when a new version is known.

## 0.2.2 — 2026-10-02

### Added

- **Move the work to this window.** When the sheets are open in another window (for example, the installed app) and you open the work screen somewhere else (for example, the browser inside your AI assistant), the new window says so and offers **Move it to this window**. The sheets, changes and undo history move through the bridge's memory (nothing is written to disk), and the other window becomes empty.

### Fixed

- Clicking a work screen window that has no sheets no longer moves the AI assistant's tools away from the window that has the sheets.

## 0.2.1 — 2026-10-02

### Added

- **Saved Maximo connections.** Choose "Save on this PC" when you connect. The bridge saves the API key encrypted with Windows data protection (DPAPI) or the macOS Keychain, and never sends it to the browser. Every window of the work screen — the installed app, a browser tab, or the browser inside your AI assistant — then connects automatically, also after reloading the page, restarting the bridge or restarting the PC. If the bridge or Maximo is not reachable yet, the work screen retries.
- **Settings → Connection → Saved connections**: switch between Maximo environments, re-enter an API key, or delete a connection. The environment (production or test) is saved with the connection.
- A large development dataset for the fake Maximo: three waste incineration plants operated for 20, 13 and 5 years (`npm run dev:fake-maximo -- --dataset plants`).

### Changed

- On a narrow work screen (for example next to a chat), related tables (such as an asset and its specifications) are stacked vertically, two at a time, instead of showing only the first one.

## 0.2.0 — 2026-10-01

First public release.

### Added

- Production licenses. Choose for each Maximo whether it is a **production** or **test** environment. Committing to a production Maximo needs a license key for that environment; loading, analysing, editing and committing to test environments stay free. Keys are checked on your PC only. Paste keys in **Settings → License**; IT can also place key files in `~/.config/mxstage/licenses/`.
- Environment tag in the top bar (test, production with the licensed organization, production read-only, or a license about to expire).
- English user interface. The language follows the browser and can be changed in **Settings**.
- Claude Desktop extension (`mxstage-<version>.mcpb`): install MX Stage in Claude Desktop without Node.js or Git.
- The installer registers MX Stage with IBM Bob, supports Claude Desktop from the Microsoft Store, and does not register MX Stage twice when the Claude Desktop extension is installed (`--no-claude-desktop`, `--no-bob`, `--claude-code`).
- English tool descriptions, server instructions and built-in Skill (`mxstage-workbench` 1.0.0) for every AI assistant. The AI replies in the user's language.
- `get_status` reports the environment and license state.
- A fake Maximo and a development bridge for developing MX Stage (`npm run dev:fake-maximo`, `npm run dev:bridge`).

### Changed

- Renamed from mxstudio to **MX Stage** (`mxstage`). The installer moves an existing mxstudio installation: it unregisters the old server from each assistant, removes unchanged copies of the old Skill, and copies your Skills to `~/.config/mxstage/skills/`.
- The work screen uses the IBM Carbon Design System.
- The scope sheet created by `scope_options` is now named `Scope <structure>`.
- Licensed under the Business Source License 1.1 with the Apache License 2.0 as the change license.

### Removed

- The unimplemented tools `import_rows` and `export_sheet`.

## 0.1.0

Internal version (mxstudio), not published.
