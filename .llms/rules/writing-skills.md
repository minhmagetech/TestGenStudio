---
oncalls: ['horizon_mhs_ai_skills']
apply_to_path: "Assistant/skills/.*\\.md$"
---

# Author Horizon project runtime skills

Use this project-local profile for runtime skills under `Assistant/skills`. It
applies the shared Horizon Runtime Skill Rulebook to project packaging; it does
not use the central SkillHub corpus layout or schema.

## Prove the skill is needed

Create or extend a skill only for a reusable Horizon procedure, capability, or
project method that the target agent cannot perform reliably without additional
context.

- Extend an existing skill when its responsibility, trigger, and success
  condition already match.
- Do not create skills for generic knowledge, copied API reference, one mutable
  project fact, an unavailable tool, or a renamed role.
- Keep current project facts in project source or project documentation. Teach
  the method for finding them instead of copying values that will drift.

## Use the portable project frontmatter

New and updated project skills use this shape:

```yaml
---
name: placing-lights
description: Places and configures supported lights. Use for scene-lighting changes, and not for UI color or material-only work.
include: as_needed
agents:
  - scripting
local_tools:
  - exact_activation_granted_tool
---
```

- Use one non-empty `description`, one of `as_needed`, `on_delegation`, or
  `always` for `include`, and a non-empty explicit `agents` list.
- Target only agents that need the responsibility. Do not depend on directory
  fallback for assignment. Listing `scripting` or `task` also targets
  `planning`; no other value expands, so keep `planning` on a list that has
  neither.
- Omit `local_tools` when activation grants no tools; an empty list adds no
  capability.
- Do not require `version` or use the legacy `tools` field. Preserve a
  project-specific ownership field only when the project requires it; ownership
  metadata is not part of the portable minimum.

New skill names use lowercase kebab-case and describe a specific action or
responsibility. Gerund wording is preferred when natural, not mandatory.
Descriptions are third-person routing contracts: state what the skill does, when
it applies, concrete triggers, and meaningful exclusions.

An existing `name` is the runtime catalog key. Renaming one is a migration:
update every `skills_to_activate`, `switch_skills`, and instruction reference in
the same change, then confirm the skill still activates. A missed
`skills_to_activate` reference resolves to nothing without raising an error.

## Follow the project layout

Use the existing `Assistant/skills` layout for the project.

- Keep a standalone skill as one Markdown file in the established target
  folder.
- Use a dedicated subfolder when the skill ships scripts, templates, images, or
  other bundled files. Do not create a folder only to wrap one Markdown file.
- Keep required decisions and the main procedure in the primary file. Put larger
  references one level deep and say whether they are read, copied, or executed.
- Use forward slashes for paths. Use `CONTEXT_PATH`, `RELATIVE_TREE`, or another
  processor only after verifying that the actual project loader resolves it.
- Skip a table of contents in the primary skill. A long reference file may use
  one when it materially improves navigation.

## Put each fact in its authority

A skill may contain the smallest reusable Horizon procedure, a narrow stable
constraint needed at the decision point, and decisive examples that validate.

- Retrieve TypeScript signatures, properties, enums, and defaults from the
  current API or source authority; do not copy reference tables into the skill.
- Cite mutable world and project facts from project source or project
  documentation.
- Omit background a capable target model already knows.
- Mention another skill by name rather than linking into its implementation
  bundle.

`API_LOOKUP` is not a supported runtime processor. `API_CATALOG` is a broad
catalog, not authoritative per-symbol lookup.

## Match detail to risk

Use judgment for tasks with many valid solutions and exact validated steps for
fragile mutations. State a default before branches.

For a retrying workflow, set a maximum attempt count, stop when no progress is
made, preserve user-owned state, and report the remaining blocker. Validate
after each meaningful change. Keep only instructions that prevent an observed
failure; the primary body should normally remain below 500 lines.

## Resolve tools from the target agent

Before naming a callable, verify its exact identifier in the target agent
registry. A tool may come from the agent base grants, activation-coupled
`local_tools`, or the active workflow. If none supplies it, change the target or
grant, provide a supported fallback, or remove the instruction.

Do not assume shell access, package installation, network access, or arbitrary
file execution.

## Verify the real loading path

Before review:

1. Parse the frontmatter through the project loader.
2. Confirm discovery, explicit assignment, activation, and instruction loading
   separately.
3. Confirm each named tool is available to the target agent and that referenced
   files resolve from the packaged project.
4. Run representative before/after prompts in the target surface and inspect
   the resulting actions and postconditions.
5. For a runtime-skill change, include the required manually inspected trace
   evidence. Automated grades supplement but do not replace behavioral review.
