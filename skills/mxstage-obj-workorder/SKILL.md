---
name: mxstage-obj-workorder
description: "MX Stage object Skill for Maximo work orders and service requests (MXAPIWODETAIL, MXAPISR): correcting open work orders, planned labor and materials, status rules, and closed history."
metadata:
  version: "1.2.0"
  category: "object"
---

# Work orders and service requests

Work orders: MXAPIWODETAIL (with tasks, planned labor WPLABOR, planned materials WPMATERIAL and other children) or MXAPIWO. Key: SITEID and WONUM. Service requests: MXAPISR, key TICKETID (CLASS SR).

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Correct open work orders (asset, location, failure class, problem code, priority, work type, owner, lead, crew, target and scheduled dates, GL account, job plan reference) | apply_rule or patch_cells | Only while the status allows edits (see below) |
| Correct planned labor and materials | WPLABOR and WPMATERIAL child rows: change, add with add_rows, delete | Approved work orders may have reservations; changes affect them |
| Correct service requests (classification, owner group, asset, location, reported priority) | attributes | Closed requests are history |

## Status

Decide the status per record by its phase (Statuses in mxstage-core-change), never one status for a whole file:

- **Past work**: existing completed (COMP) work orders can still be corrected. New ones for past work (for example history from Excel) get the connection's status for past work (COMP unless the user chose CLOSE), with ACTSTART and ACTFINISH set to the real dates.
- **In progress**: keep the status (INPRG and so on) and correct the contents.
- **Future**: a planning status the user agrees (usually WAPPR).

How MX Stage applies a STATUS edit: it updates or creates the record, verifies it, then runs Maximo's status change and reads the status back. Maximo applies its rules (allowed moves, checks on actuals and reservations, status history rows).

- **Closed (CLOSE) and cancelled (CAN) work orders are history**: MX Stage does not send changes to them (skipped). An administrator can fix some fields with Edit History Work Order in Maximo. Exclude them in the range unless the task is reading them.
- Allowed moves: WAPPR, APPR, WSCH, WMATL and WPCOND go to most statuses; INPRG goes to WMATL, COMP, WAPPR or CLOSE; COMP only to CLOSE; CLOSE and CAN are final. Other moves are skipped.
- CLOSE and CAN cannot be undone; the user confirms them in the commit panel.
- Only top-level work orders, **never task rows** (they follow their parent).
- Customers may use their own statuses: check the values with aggregate on STATUS, never guess.
- Try a new kind of status change on one or two records in a test environment first; if Maximo rejects it, report the message and stop.

## What it cannot do now

- Report actuals (labor, materials, tools). Actuals are transactions; tell the user to report them in Maximo.
- Change closed history. If history is wrong, Maximo needs its own correction process.

## New work orders

Work orders and service requests can be created (New records in mxstage-core-change). Keys: SITEID and WONUM (TICKETID for service requests); MX Stage does not take Maximo's automatic numbers. Usually needed: DESCRIPTION, and the asset or location, work type and priority. Maximo sets the initial status (usually waiting for approval); a STATUS you fill is applied after the work order is created. Planned labor and materials can be added as child rows of the new work order. Do not create work orders that a PM should generate.

## Traps

1. **Asset and location must agree**: when you change ASSETNUM, the location usually follows the asset. Load assets with load_master (from ASSETNUM to ASSETNUM, with SITEID) and keep them consistent.
2. **Work orders created by PMs** take values from the PM and job plan. Fixing them in the work order does not fix the next ones; fix the PM too (mxstage-obj-pm-jobplan).
3. **Tasks** are child work orders (WOACTIVITY). Change their attributes only when the user asks; never their status.
4. **Dates** are in the Maximo server time zone; check with the user before bulk date changes.
5. **Ownership and workflow**: records in a workflow may be locked or reassigned by it. Report failures, never retry automatically.

## Checks before the commit

- The range excludes closed and cancelled records.
- STATUS values come from the agreed phase rule or list, only on top-level rows, and are listed in the commit note with their counts.
- Planned material and labor changes are on the agreed work orders only.
