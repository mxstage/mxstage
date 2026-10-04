---
name: mxstage-core-screen
description: "MX Stage basic operation: how the work screen shows sheets (related tables, views, colors, one-row-per-record specifications, filters, windows, reload, settings), to guide the user to what they see."
metadata:
  version: "1.0.0"
  category: "core"
---

# The work screen

Use this to point the user to the right place on screen and to explain what they see. Describe the screen in the user's language; the labels below are the English ones.

## Layout

- **Top bar**: the Maximo connection, the environment tag (test, production with the licensed organization, production read-only), Object structures, Color legend, Reload, Settings and End work.
- **Sheet tabs**: one tab per sheet, with the number of pending changes. Closing a sheet with changes discards them (after a confirmation); nothing is committed.
- **Tables**: a sheet and its related tables (parent, child, master data from load_master) are shown side by side and linked: selecting a row in one table filters the others. On a narrow screen (for example next to a chat) they are stacked, two at a time. Each table header has Linked or Unlink, Row details (all columns of the selected row, read vertically, with long text in full), Show side by side or Maximize, and Hide. Hidden tables come back from "Tables shown".
- **Commit and history panel** (right side): the commit request with its counts and blockers, the commit button, the results per row, and the change history.

## Views

The view switcher shows Final (Maximo values plus pending changes), Changes (only changed cells and rows) and Original (Maximo values as loaded). The same three views exist for query_rows (final, diff, base).

## Colors

The Color legend in the top bar explains the cell colors: changed by the AI, changed by the user, added rows, rows marked for deletion, and read-only cells. Hovering over a cell shows its author, reason and the values before and after.

## One row per record (specifications)

Child tables shaped as item and value pairs (asset, location and item specifications) can be shown with one row per record and one column per item. The screen chooses this from the table's shape; the button in the table header switches between "One row per record" and "One row per item".

- Units appear under the item names. The classification column shows the hierarchy path and description when the classification sheet is loaded.
- **Yellow**: the record's classification has this item but the record has no row. Entering a value adds the specification row.
- **Grey**: the item is not in the record's classification (cannot be edited here).
- **⚠**: duplicate rows, a value in an unusual column or mixed units; edit those in the one-row-per-item view.
- Column headers open filters; missing and empty values count as empty, and grey cells appear as "(not in classification)".
- Edits in this view change the specification rows, so the diff, undo and commit work as usual.

## Filters

Column headers of every table open a filter menu. Filters only change what the user sees; tools use their own filter arguments. If the user says a row is missing, check whether a filter in the screen hides it.

## Windows and reload

- The work belongs to one window. If the user opens the work screen in another window (for example the browser inside the AI assistant), that window offers "Move it to this window"; the sheets, changes and undo history move there.
- When the screen says it is out of date and asks to reload, the work is kept on this PC for 10 minutes while the tab reloads, then comes back. A reload from the browser's own button discards the work in that tab.
- End work discards all sheets and history (nothing is committed).

## Settings

- **Connection**: Maximo URL and API key, saved connections (encrypted on this PC; every window connects by itself), switching environments, production or test.
- **License**: production license keys. Committing to production needs one; everything else is free.
- **Skills**: the built-in and user Skills and their problems.
- **Updates**: the version, checking for a new one, and automatic updates (off by default).
- Language follows the browser and can be changed here.

Never ask for the API key in the chat; it goes only into Settings.
