---
name: mxstage-core-skills
description: "MX Stage basic operation: when to propose a user Skill, how to write one for a customer's environment (custom objects and attributes, rules, repeated tasks), how to name and save it."
metadata:
  version: "1.0.0"
  category: "core"
---

# Making user Skills

Built-in Skills cover standard Maximo. Everything specific to one customer belongs in user Skills, which the user keeps on their PC (~/.config/mxstage/skills/name/SKILL.md).

## When to propose one

Propose a user Skill (never save one without being asked) when:

- the work used a custom object structure, custom attributes or tables (for example attributes with a customer prefix), and you had to find out what they mean;
- the customer has rules that differ from standard Maximo (mandatory attributes, naming of codes, their own statuses, who approves);
- a task was worked out step by step and will be repeated (a monthly cleanup, a migration check, a survey import);
- a built-in Skill had to be adapted for this customer.

## What to write

Write for an AI that knows MX Stage and the built-in Skills but not this customer. Keep what was learned, not the conversation.

1. **When to use it**: the customer or environment, the task, the object structures.
2. **Data**: structures, attributes and their meaning (custom ones especially), keys, child objects, the referenced masters to load.
3. **Range**: the usual conditions (sites, statuses, classifications) and the usual size.
4. **Rule**: how each value is decided, including what to do with rows the rule cannot decide.
5. **Checks**: what to look at in aggregate and get_diff before the commit; known traps.
6. **Customer rules** that replace steps of built-in Skills. The rules of the index cannot be replaced.

Do not write API keys, passwords, personal data or row data into a Skill. Use attribute names, not cell values. Refer to tools by their names, as here.

## Name and description

- Name: lowercase letters, digits and hyphens, for example customer-task (plant-a-boiler-spec-fill). **Names starting with mxstage are reserved** for built-in Skills.
- One Skill per customer and task. Keep different customers in different Skills, even for the same task.
- Description: up to 200 characters, saying when to use it (for example: Use in MX Stage for Plant A boiler assets to fill missing specifications from the survey sheet).
- Body: Markdown, under 8,000 bytes. Link other Skills by name instead of copying them.

## Saving

1. Show the user the name, description and full body.
2. Change it until they agree.
3. save_skill. To replace an existing one, get their agreement and pass overwrite: true with a higher version.
4. Read warnings in the result (for example words that look like tool names but are not) and fix them with the user.
5. The Skill can be read with list_skills and get_skill from the next conversation on. For Claude Code, Codex and other assistants with their own Skill folders, the user runs the MX Stage setup again to copy it there.
