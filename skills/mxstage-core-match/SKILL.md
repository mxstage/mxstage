---
name: mxstage-core-match
description: "MX Stage basic operation: match two sheets (Maximo against Maximo, or an imported file against Maximo) with match_sheets and composite keys, and handle unmatched and ambiguous rows."
metadata:
  version: "1.1.0"
  category: "core"
---

# Matching sheets

Matching is deterministic: values are compared after the chosen normalisation, nothing is matched by similarity or guesswork.

## 1. Choose the keys

- Find a column (or columns) that identifies a record on both sides: ASSETNUM, LOCATION, ITEMNUM, a tag number, a serial number.
- If one column is not unique (the same number at different sites, the same tag in two plants), use a composite key: arrays in the same order and count, for example leftCol `["SITEID","ASSETNUM"]` and rightCol `["SITEID","ASSET_NO"]`.
- Check uniqueness first with aggregate on the key columns of each sheet. Duplicates on either side become ambiguous matches.

## 2. Normalise

normalize defaults to trim, nfkc and upper. Add removeSpaces or removeHyphens when the two sides write codes differently (P-101 against P101). Tell the user which normalisation you used.

## 3. Run match_sheets

The result gives counts and samples of:

- matched: one row on each side
- left-only and right-only: no partner
- ambiguous: several candidates

Show the four counts to the user before changing anything.

## 4. Act on the result

- Move values for matched rows with apply_rule and a lookup (see mxstage-core-change): run with dryRun first.
- **Left-only, right-only and ambiguous rows are not changed.** List them with counts and examples and ask the user what to do (another key, a manual decision, leave them).
- Never fill unmatched rows by picking the closest value.
- Records that exist only in the file can be created as new records if the user agrees (New records in mxstage-core-change). Never create them just because they did not match: a wrong key or spelling looks the same.

## Typical uses

- Field survey or inspection results (Excel) against assets.
- Tag numbers in the customer's register against assets or locations.
- Two sites or two structures that should agree (asset location against the location hierarchy).
- Before and after a migration: the same records in two environments loaded as two sheets.
