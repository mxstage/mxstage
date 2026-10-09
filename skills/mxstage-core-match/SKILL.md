---
name: mxstage-core-match
description: "MX Stage basic operation: match two sheets with match_sheets (keys, composite keys, or rules for free-text rows without a key) and handle unmatched and ambiguous rows."
metadata:
  version: "1.2.0"
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

## 5. Rows without a shared key

Daily reports, repair reports and contractor sheets often name equipment in free text ("#1 feeder", "No.3 FDF") and carry a date, but no ASSETNUM or WONUM. Do not read the rows and pick partners yourself. Write rules, let match_sheets apply them, and link only the rows that come to exactly one candidate.

1. **Load the other side and its names.** For work orders, load the range by date and site, and load_master the assets (ASSETNUM to DESCRIPTION) so the rules can use the asset names.
2. **Look at how the file writes names.** Use aggregate or a few rows of query_rows on the text column. Write rewrite rules that make the nicknames equal to the Maximo names, applied after normalize (for example a rule with find `#(\d)` that writes the number the way the asset names do). Keep each rule narrow; a rule that matches too much makes wrong pairs.
3. **Combine conditions** in match_sheets (leftCol and rightCol may be omitted):
   - contains: the text column contains the other side's name; with via, the name comes from another sheet (for work orders: the Assets sheet, its ASSETNUM and its DESCRIPTION).
   - dateWithin: the row's date falls within the record's start and end (ACTSTART to ACTFINISH).
   - targetFilter with leftFilter: split the rows by kind and match each kind to its records only (repair rows to CM and EM work orders, inspection rows to the others). Run match_sheets once per kind.
   - group: only for documents that are about one record (one repair report, one work order). The rows of a document then share the record that its rows matched. Do not use it on daily reports that list many jobs.
   - followsAbove: rows that only say "same as above" (a ditto mark or word at the start of the text) take the record of the row directly above, when that row matched one record. Fill ditto marks in category columns with fillDown when importing (mxstage-core-import), so such rows land in the same kind as the row above.
4. **Try before linking.** Show the user the counts (matched, ambiguous, left-only) and samples of each, including a few matched rows with their text and the record, before writing anything. If a sample is wrong, narrow the rule or add a condition and run again. Never widen a rule just to raise the matched count.
5. **Link.** Use apply_rule with a lookup that has the same conditions (sourceCol is the key to bring, for example WONUM), with the same filter as leftFilter. dryRun first; the counts must agree with match_sheets. Example set: `{"WONUM": {"lookup": {"sheet": "WorkOrders", "sourceCol": "WONUM", "normalize": ["trim", "nfkc", "upper", "removeSpaces"], "contains": {"col": "WORK", "targetCol": "ASSETNUM", "via": {"sheet": "Assets", "matchCol": "ASSETNUM", "sourceCol": "DESCRIPTION"}}, "dateWithin": {"col": "DATE", "targetStart": "ACTSTART", "targetEnd": "ACTFINISH"}}}}`. Only rows with one candidate are written; ambiguous rows come back as lookup_ambiguous and left-only rows are skipped.
6. **The rest.** Report the rows that were not linked with counts and examples. Decide them with the user, or read those rows only and propose partners one by one with reasons (patch_cells with a reason per cell). A row that matches nothing may be work that is not in Maximo yet; confirm before creating records.
7. **Keep the rules.** If the same kind of file comes every month, offer to save the rules (rewrite list, conditions, filters) as a user Skill (mxstage-core-skills), so the next file starts from them.

## Typical uses

- Field survey or inspection results (Excel) against assets.
- Tag numbers in the customer's register against assets or locations.
- Two sites or two structures that should agree (asset location against the location hierarchy).
- Before and after a migration: the same records in two environments loaded as two sheets.
- Daily or repair reports in free text against work orders (section 5).
