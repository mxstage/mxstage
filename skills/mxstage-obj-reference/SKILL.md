---
name: mxstage-obj-reference
description: "MX Stage object Skill for Maximo reference data: people, labor, crafts, person groups, companies, domains and failure codes (MXAPIPERSON, MXAPILABOR, MXAPIPERSONGROUP, MXAPICOMPANY, MXAPIDOMAIN)."
metadata:
  version: "1.1.0"
  category: "object"
---

# Reference data

| Object | Structure (usual) | Key | Children |
|---|---|---|---|
| People | MXAPIPERSON | PERSONID | phones, e-mails, sites |
| Labor | MXAPILABOR | LABORCODE and ORGID | crafts (LABORCRAFTRATE), qualifications |
| Crafts | MXAPICRAFT | CRAFT and ORGID | skill levels and rates |
| Person groups | MXAPIPERSONGROUP | PERSONGROUP | members (PERSONGROUPTEAM) |
| Companies | MXAPICOMPANY | COMPANY and ORGID | contacts, branches |
| Domains | MXAPIDOMAIN | DOMAINID | values (ALNDOMAIN, NUMERICDOMAIN, SYNONYMDOMAIN) |
| Failure codes | failure code and failure list structures | FAILURECODE and ORGID | problems, causes, remedies |

## What MX Stage can do

- **People and labor**: supervisor, department, crew, calendar and shift, primary site, craft rates. Keep people and labor consistent (a labor record points to a person).
- **Person groups**: add and remove members, change the primary and the sequence, per site. Groups are used for assignment and escalation; tell the user who will stop or start receiving work.
- **Companies**: clean up names, addresses, payment terms and types. Duplicates cannot be merged or disabled here; list them for the user.
- **Domains**: add values (ALNDOMAIN rows) or correct descriptions. **Never change or delete a value that records use**; Maximo stores the value itself in the records. Count the records that use a value first (load them with load_sheet and aggregate on the attribute).

## What it cannot do now

- Deactivate people or labor, or change their status: these are status actions.
- Build failure hierarchies (failure class, problem, cause, remedy); create them in Maximo.
- Change synonym domains of statuses beyond descriptions: internal values drive Maximo logic.

## New records

People, labor, crafts, person groups, companies and domains can be created (New records in mxstage-core-change). Create a person before the labor record that points to it, and a craft before the labor crafts that use it. New domain values are child rows of an existing domain, not new records.

## Traps

1. **Synonym domains** (statuses, work types): the internal value (MAXVALUE) drives Maximo's logic; only the external value and description may be customer-specific. Do not change MAXVALUE.
2. **Security**: people and labor link to users and security groups, which MX Stage does not change. Do not suggest changes to users or security from here.
3. **Personal data**: show the user only the columns needed for the task. Do not copy personal data into notes or Skills.
4. **Organisation and site**: labor, crafts and companies are per organisation; match with ORGID as well.

## Checks before the commit

- Domain values that are removed or renamed are not used by any record.
- Person group changes list the members added and removed per group.
