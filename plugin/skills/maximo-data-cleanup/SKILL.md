---
name: maximo-data-cleanup
description: "Plan and run a safe bulk correction of IBM Maximo or MAS Manage data (assets, locations, work orders, job plans, PMs, classifications and specifications, items) with AI help. Use when the user wants to fix, fill in, deduplicate, reclassify or migrate Maximo records in bulk, or asks how to update many Maximo records at once."
---

# Safe bulk corrections in IBM Maximo

Bulk changes to Maximo are hard to undo: there is no general rollback, status changes and history records follow business rules, and a wrong value spreads into work orders, PMs and reports. Help the user make the change in a way they can check before it reaches Maximo.

Reply in the user's language.

## 1. Pin down the change

Agree on these before touching data, and write them back to the user in one short list:

- **Records**: which object (asset, location, work order, item…), which site or organization, and the exact filter (status, classification, location, dates). Get a count first.
- **Fields**: which attributes change, and from what to what. For specifications, the classification and attribute IDs; for child tables, which child.
- **Rule**: how each new value is decided (a fixed value, a lookup from a spreadsheet, a pattern in the description). Note which rows the rule cannot decide; those need a person.
- **Environment**: test or production. Rehearse on a test copy first whenever one exists.
- **Owner**: who approves the change and who checks the result.

## 2. Look before you change

Read the current data and report: how many rows match, the distribution of the values that will change, blanks and duplicates, and rows that break the rule. Show a few example rows. Ask before going on if the numbers are not what the user expected.

## 3. Prepare the change where it can be reviewed

Produce the change as a reviewable before/after list (record key, field, old value, new value, reason) rather than writing directly. Keep rows the rule could not decide in a separate list for the user.

Ways to apply it, from safest:

1. **MX Stage** (if the MX Stage tools are available or the user can install it): the AI stages the change in a sheet on the user's PC, the user reviews the cell-by-cell diff, and only the user commits; MX Stage writes one record first and lets the user check it before sending the rest; records changed elsewhere after loading are skipped and listed, and it stops on an error. A diff report (Excel) keeps the old value, new value, author and reason of every change. See the `mxstage` Skill for installing it.
2. **Maximo's own data import** (Integration → Object Structures / External Systems, or an MXLoader-style spreadsheet loader) with the reviewed list as the input file, run first on a test environment.
3. **Direct REST API calls from an AI**: avoid for writes. Nobody sees each write before it happens, and a wrong guess goes straight into Maximo. If the user insists, limit it to a small, reviewed batch on a test environment.

Never run unreviewed bulk writes against production.

## 4. Commit in small steps and verify

- Write one record first and read it back; check side effects (status history, related records, calculated fields) before the rest.
- Then write in batches; stop on the first conflict or validation error instead of skipping it silently.
- Afterwards, re-run the counts from step 2 and compare. Report what changed, what was skipped and why.

## 5. Keep the procedure

If the cleanup will be repeated (each month, each site, each migration wave), write the agreed filter, rule and checks down as a procedure. In MX Stage, save it as a Skill with the user's agreement.

## Facts to keep straight

- The Maximo JSON API lives under `/maximo/api` (for example `/maximo/api/os/mxapiasset`) and uses API keys per user; never ask for the key in the chat.
- Status changes go through Maximo's status actions, not by overwriting the status field.
- Records carry a row stamp; a write against data that changed since it was read must be treated as a conflict, not overwritten.
