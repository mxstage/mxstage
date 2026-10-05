---
name: mxstage-obj-workorder
description: "MX Stage object Skill for Maximo work orders and service requests (MXAPIWODETAIL, MXAPISR): correcting open work orders, planned labor and materials, status rules, and closed history."
metadata:
  version: "1.1.0"
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

- **Closed (CLOSE) and cancelled (CAN) work orders cannot be changed.** Completed (COMP) ones allow very little. Exclude them in the range, unless the task is about reading them.
- **Status changes** (approve, close old completed work orders, cancel) are Maximo actions with rules: allowed transitions (for example COMP only goes to CLOSE; CAN and CLOSE are final), checks on actuals and reservations, history rows, and changes to child tasks. IBM recommends changing the STATUS of the top-level work order through the API, and Maximo then runs the action. In MX Stage this means editing STATUS on the top-level rows:
  - only when the user asks for it, with the target status and the list agreed;
  - only top-level work orders, **never task rows** (they follow their parent);
  - only on records whose current status allows the transition (check with aggregate on STATUS);
  - first on one or two records in a test environment, because the result depends on the Maximo version and the customer's workflow; if Maximo rejects it, report the message and stop.
- A status memo or date cannot be given this way.

## What it cannot do now

- Report actuals (labor, materials, tools). Actuals are transactions; tell the user to report them in Maximo.
- Change closed history. If history is wrong, Maximo needs its own correction process.

## New work orders

Work orders and service requests can be created (New records in mxstage-core-change). Keys: SITEID and WONUM (TICKETID for service requests); MX Stage does not take Maximo's automatic numbers. Usually needed: DESCRIPTION, and the asset or location, work type and priority. Maximo sets the initial status (usually waiting for approval). Planned labor and materials can be added as child rows of the new work order. Do not create work orders that a PM should generate.

## Traps

1. **Asset and location must agree**: when you change ASSETNUM, the location usually follows the asset. Load assets with load_master (from ASSETNUM to ASSETNUM, with SITEID) and keep them consistent.
2. **Work orders created by PMs** take values from the PM and job plan. Fixing them in the work order does not fix the next ones; fix the PM too (mxstage-obj-pm-jobplan).
3. **Tasks** are child work orders (WOACTIVITY). Change their attributes only when the user asks; never their status.
4. **Dates** are in the Maximo server time zone; check with the user before bulk date changes.
5. **Ownership and workflow**: records in a workflow may be locked or reassigned by it. Report failures, never retry automatically.

## Checks before the commit

- The range excludes closed and cancelled records.
- STATUS changes only if agreed, only on top-level rows, and listed in the commit note.
- Planned material and labor changes are on the agreed work orders only.
