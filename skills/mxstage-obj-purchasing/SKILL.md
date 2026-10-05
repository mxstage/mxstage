---
name: mxstage-obj-purchasing
description: "MX Stage object Skill for Maximo purchase requisitions and orders (MXAPIPR, MXAPIPO): correcting records waiting for approval, and why approved orders and receipts are out of reach."
metadata:
  version: "1.1.0"
  category: "object"
---

# Purchasing

Purchase requisitions: MXAPIPR, key SITEID and PRNUM, lines PRLINE. Purchase orders: MXAPIPO, key SITEID, PONUM and REVISIONNUM, lines POLINE. Receipts are transactions on the order lines.

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Correct requisitions and orders **waiting for approval** (WAPPR): GL accounts, work order and asset references, required dates, vendor, ship-to, line descriptions | apply_rule or patch_cells on header and line attributes | Some attributes are read-only even in WAPPR; the sheet shows them as read-only |
| Add or remove lines of records waiting for approval | PRLINE or POLINE child rows | Fill the attributes the line type needs (item or description, quantity, unit, cost, line type) |
| Status of old requisitions and orders (cancel, close) | STATUS on the top-level record, like work orders | Only with the user's agreement, never on lines, first on one or two records in a test environment |

## What it cannot do now

- **Change approved orders.** An approved purchase order is changed through a revision (a new REVISIONNUM) in Maximo. Ask the user to revise it in the Purchase Orders application; the revision can then be corrected here while it is waiting for approval.
- **Receive, return or invoice.** These are transactions.
- Cancelled and closed records are history.

## New requisitions

Purchase requisitions can be created with their lines (New records in mxstage-core-change; keys SITEID and PRNUM). They start waiting for approval and go through the customer's approval. Do not create purchase orders this way unless the user asks; orders are usually created from requisitions in Maximo.

## Traps

1. **GL accounts** must be valid combinations in the chart of accounts; load them with load_master or ask the user for the valid list. Never compose account codes.
2. **References**: lines that refer to a work order, asset or location should agree with that record's site and GL account. Load those masters to check.
3. **Approval workflow**: records inside a workflow may be locked or change status while you work. Load again before the commit if the work took long.
4. **Currency and costs** follow vendor and contract settings; changing the vendor can change prices. Agree on it with the user.

## Checks before the commit

- Only records waiting for approval are changed (aggregate on STATUS).
- STATUS changes only if agreed and only on headers.

## Note for testing

The development fake Maximo of MX Stage has no purchasing objects; try these steps on a test environment of the customer's Maximo.
