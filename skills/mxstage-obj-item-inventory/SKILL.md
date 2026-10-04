---
name: mxstage-obj-item-inventory
description: "MX Stage object Skill for Maximo items, inventory and storerooms (MXAPIITEM, MXAPIINVENTORY): item master cleanup, reorder settings, default bins, and why balances cannot be adjusted here."
metadata:
  version: "1.0.0"
  category: "object"
---

# Items, inventory and storerooms

Items: MXAPIITEM, key ITEMNUM and ITEMSETID, children such as ITEMSPEC (specifications) and the organisation records. Inventory: MXAPIINVENTORY, key ITEMNUM, ITEMSETID, LOCATION (storeroom) and SITEID, with balances (INVBALANCES) and costs. Storerooms are locations of type storeroom.

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Item master cleanup: descriptions, commodity group and code, classification and specifications, manufacturer data, rotating and lot flags where allowed | apply_rule or patch_cells; ITEMSPEC child rows | Descriptions often need standard naming rules; agree on them first |
| Reorder settings: reorder point, economic order quantity, safety stock, lead time, reorder flag, vendor | apply_rule on inventory | The most common inventory task |
| Default bin, ABC type, cycle count frequency | attributes | |
| Item specifications | ITEMSPEC rows | Rotating assets of the item take these values (mxstage-obj-classification) |

## What it cannot do now

- **Adjust balances or costs** (quantities, opening balances, average or standard cost). These are inventory transactions in Maximo; tell the user to use Inventory's adjustment actions or their loading tool.
- **Physical counts** are entered through a non-persistent count attribute and a reconciliation in Maximo. Only if the structure exposes the count attribute, after a test on one record, and never for rotating items.
- **Receipts, issues and transfers** are transactions.
- **Create items, inventory records or storerooms** (migration).
- **Change item status** (active, pending obsolescence, obsolete, planning). Status exists at the item set, organisation and inventory level, and obsolete is only reached from pending obsolescence. Tell the user to use the applications.

## Traps

1. **Units**: issue and order units cannot be changed freely once there are balances or transactions. Do not change MEASUREUNITID fields of items with inventory unless the user confirms Maximo allows it.
2. **Item set and site**: items are per item set, inventory per storeroom and site. Match items with ITEMNUM and ITEMSETID, inventory with ITEMNUM, LOCATION and SITEID.
3. **Rotating items**: specifications and some attributes flow to the rotating assets. Changing the rotating flag is not possible once assets exist.
4. **Reorder settings** drive automatic purchase requisitions; a wrong reorder point can create many requisitions. Show the old and new values side by side and agree on the rule.
5. **Duplicates** in the item master (same part under different numbers) cannot be merged here; list them for the user.

## Checks before the commit

- No balance, cost or unit changes.
- Reorder changes only on the agreed storerooms and items.
