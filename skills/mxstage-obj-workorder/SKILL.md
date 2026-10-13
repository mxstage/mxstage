---
name: mxstage-obj-workorder
description: "MX Stage object Skill for Maximo work orders and service requests (MXAPIWODETAIL, MXAPISR): correcting open work orders, planned labor and materials, status rules, and closed history."
metadata:
  version: "1.8.0"
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

## Matching work records (daily reports, repair logs)

Work records give the day of the work, not the day the work order was reported. Corrective work is often reported days or weeks before it is done.

- Load the work orders by the work dates: ACTSTART (or ACTFINISH) in the period with a few days of margin, in any status. Never limit them by REPORTDATE.
- Match by site, asset (or location) and work date; the wording differs (nicknames, abbreviations, line numbers written in other ways).
- Do the matching with rules in match_sheets, not by reading the rows (mxstage-core-match, Rows without a shared key): contains with via to the asset names, dateWithin on ACTSTART and ACTFINISH, the customer's dictionary of names for the nicknames, and targetFilter on WORKTYPE so repair rows meet corrective work orders and inspection rows meet the others. Repair reports are about one work order each: match them in their own pass with group on the report (BLOCK), and the daily reports in another pass without group. Link with an apply_rule lookup only the rows with one candidate.
- **Failure codes from the text** are decided by a words → codes dictionary, not by you row by row, so that next month only new words need reading:
  1. Import with addColumns WONUM, ASSETNUM, FAILURECLASS, PROBLEM, CAUSE and REMEDY. Fill WONUM with the matching lookup, ASSETNUM with a lookup on the work orders (by WONUM) and FAILURECLASS with a lookup on the assets (FAILURECODE by ASSETNUM).
  2. Dictionary: use the customer's words → codes dictionary for failures if get_status lists one; otherwise create one (create_dictionary, kind code). Read the failure classes and their problems, causes and remedies (failure list, mxstage-obj-reference).
  3. If the dictionary is new or leaves rows undecided, read the text of the linked repair rows only (query_rows with the text column, filter WONUM not empty), and add entries: the customer's short words → code, FIELD PROBLEM, CAUSE or REMEDY, SCOPE the failure class for problems, the problem for causes and the cause for remedies, so that only valid combinations are made. A word for the repair often also tells the cause (retightening tells that something was loose): add it for both fields.
  4. apply_rule classify: PROBLEM scoped by FAILURECLASS, then CAUSE scoped by PROBLEM, then REMEDY scoped by CAUSE. Check dictionary in the result; for unmatched or ambiguous rows, add or narrow entries and apply again.
  5. Copy to the work orders without failure codes (filter on the work order sheet): FAILURECODE with a lookup on the assets, PROBLEMCODE with a lookup on the report sheet by WONUM. The failure report lines with add_rows from and from.parent (mxstage-core-change, Child rows): one call each for PROBLEM, CAUSE and REMEDY, with values {"FAILUREREPORT.TYPE": ...} and onePerParent. A cause goes only with a problem, and a remedy only with a cause.
  6. Report the work orders left out (split, differs, rows still undecided) with their counts; do not fill them by guessing.
- A repair is missing from Maximo only when no work order exists for the same asset or location within a few days of its date. Before adding new work orders, load the work orders for those assets around those dates (where with in on ASSETNUM and an ACTSTART window). Report near matches to the user instead of creating them.
- Agree with the user on the work order numbers for new ones (MX Stage does not use automatic numbering).

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
