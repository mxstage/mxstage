# Changelog

All notable changes to MX Stage are listed here. Versions follow [Semantic Versioning](https://semver.org/). Each version becomes available under the Apache License 2.0 four years after its release (see [LICENSE](LICENSE)).

## Unreleased

### Added

- **Reading printed forms.** apply_mapping reads a sheet of repeated forms, such as one daily work report per printed page: it finds each form by its title, takes header values by their labels (so inserted rows and shifted columns do not matter; a label can have several wordings, and full-width and half-width characters are treated alike) and makes one row per item line, with the form's values on every row. Several sheets (one per month, for example) can be read at once into one sheet. describe_import points out such sheets (formHint, with the titles used) and merged cells, and apply_mapping says when the number of forms read differs from it.
- **fillDown and unpivot.** apply_mapping fills merged cells and ditto marks with the value above, and turns columns such as years into rows (one row per mark, with several marks in one cell split and a quantity split into units). The work screen moves the values; the AI only says how to read the file.
- **Status changes.** A changed STATUS is committed with Maximo's own status change, after the record is created or updated and verified, and then read back, so Maximo applies its rules (allowed moves, status history). Closed or cancelled records, approved purchase orders (they need a revision in Maximo) and moves Maximo does not allow for work orders (such as COMP back to INPRG) are not sent and are listed with the reason. Changes to a status that cannot be undone (such as CLOSE or CAN) need an extra confirmation in the commit panel, which also counts the status changes. If a record is created but its status cannot be changed, the record is kept and the status change stays in the work screen for the next commit.
- add_rows takes children: child rows under several parents in one call and one undo batch (for example failure report lines for many work orders), instead of one call per parent.
- **Statuses by phase.** apply_rule can choose a value from each row's dates (phase): past work (the end date has passed), work in progress, or future work. By default it changes only rows added in the work screen, so existing records keep their status while their contents are corrected. Settings → Maximo connection → **Status for past work** chooses, per connection, what past work gets when the AI does not say: Completed (COMP, the default) or Closed (CLOSE).

### Changed

- STATUS is no longer sent as an ordinary value in an update or a new record.
- like in the work screen (query_rows, aggregate, apply_rule) ignores full-width and half-width characters as well as case, as the grid's own filter already did. A search in full-width katakana finds descriptions written in half-width katakana.
- The demo data is version 3: work orders are closed together after each fiscal year ends, so work finished in this fiscal year (from April 2026) stays completed (COMP) and can still be corrected, as in many sites. The demo downloads the new data once (about 10 MB per language).
- The Skills describe deciding statuses by each record's phase, never one status for a whole file (mxstage-core-change, mxstage-core-commit, mxstage-obj-workorder, mxstage-obj-purchasing).

## 0.2.7 — 2026-10-06

### Added

- **Try without Maximo.** Settings → Demo downloads fictional sample data (three waste incineration plants, in Japanese or English) and runs a demo Maximo inside the bridge on your PC. Load, fix and commit as with a real Maximo; commits change only the copy on your PC and can be reset. The data (about 10 MB, no programs) comes from `mxstage-demo.pages.dev` only when you press **Download data and connect**, is checked against a SHA-256 built into this version, and works offline afterwards. The demo is always a test environment and needs no license. It takes about 0.5 GB of memory while in use and is released when you close it, after an hour without use, or when MX Stage restarts. See [docs/demo.en.md](docs/demo.en.md).
- Five sample Excel files to merge with the demo (purchase orders without work order numbers, a legacy equipment register, daily work reports printed as A4 forms (a repair log table in the English data), an equipment register ahead of Maximo, a star chart). **Load into work screen** adds one as if you had dropped it there.
- A purple **Demo** badge in the top bar while connected to the demo. get_status and open_grid tell the AI about the demo.
- `--no-demo` turns the demo off.
- **Diff report (Excel).** The commit panel saves the changes of a sheet as an .xlsx file before you commit: one row per changed cell with the record's key, the column, the old value, the new value, who changed it (the AI assistant or a person), the reason and the time, plus added and deleted rows. A summary sheet gives the Maximo URL, the environment, the object structure, the commit request note, the counts, the changes by column and the work history. After a commit, until you change the sheet again, the button saves the changes of that commit together with the write log of that commit (the committed rows are reloaded from Maximo and leave the diff). Keep it as the record of what was approved. The file contains Maximo data; it is made in the work screen and sent nowhere.

### Changed

- The license links in the work screen (Settings → License and the commit panel's license messages) open the license page in the screen's language (https://mxstage.tsunagi.app/license, /ja/license).
- The documentation now describes commits as they work: records changed in Maximo after loading are skipped and listed, and a commit stops on an error or an unknown result (it said it stopped on conflicts). It also lists the update and demo downloads among the connections, and the Node.js version for each install channel.
- The link to the object structures in the top bar is now an icon (with its name as a tooltip), next to Settings. While the definitions load, the count appears beside it.

### Fixed

- Settings → Updates: the **Update automatically** switch was shown without its styles (as a bare checkbox). The language choices and multi-line text boxes had the same problem.
- The results by row in the commit panel no longer wrap one character per line in the narrow side panel.
- After a commit, the commit panel says there are no changes to commit instead of "There are reasons this cannot be committed".
- Claude Desktop could report "Couldn't start for Cowork and Code sessions" right after installing or updating the extension (it reconnected about 10 seconds later). Claude starts MX Stage several times at once and stops the trial one; a copy that saw the stopping one took it for another app on port 8788 and quit. MX Stage now asks again for up to about 1.5 seconds before deciding the port belongs to another app.

## 0.2.6 — 2026-10-05

### Added

- **New records.** Rows added as new parents (add_rows without parentRowKey, on a sheet loaded from Maximo) are created in Maximo when you commit: assets, locations, items, work orders and so on, with their child rows. MX Stage first searches Maximo by the sheet's key columns and does not send a record that already exists; after creating it, it finds the record by its key again, checks the values and the added child rows, and shows the record as Maximo created it (including defaults and child rows Maximo added). Every key column must be filled (Maximo's automatic numbering is not used). The commit panel and the confirmation show how many records will be created.
- **add_rows from another sheet.** `from` takes rows from another sheet, such as an imported Excel file, inside the work screen (up to 200 at a time), so the values never pass through the AI.
- The Skills describe creating records (mxstage-core-change: New records) and what to fill for each standard object.

## 0.2.5 — 2026-10-05

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
