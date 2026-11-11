"""The skills a Task type is offered, and how they are described to the model: each type sees only the skills of its work."""

from __future__ import annotations

from pathlib import Path

from agent_framework import CachingSkillsSource, DelegatingSkillsSource, FileSkillsSource, Skill, SkillsProvider, SkillsSourceContext

from tools import CURRENT_RUN

TASK_SKILLS = {
    "explain": ("healthmodel-analyze",),
    "review": ("healthmodel-analyze", "healthmodel-design-rules"),
    "design": ("healthmodel-plan", "healthmodel-design-rules"),
}
DESCRIPTIONS = {
    "healthmodel-analyze": "How to read the evidence of a health model: errors, Unknown, stale reports, thresholds, rollup and impact. Read-only.",
    "healthmodel-plan": "How to derive the user flows, components, entities and signals of a workload from its code and infrastructure.",
}
LISTING = "Skills of this Task; load one with `load_skill` before you use it.\n<available_skills>\n{skills}\n</available_skills>"


class TaskSkills(DelegatingSkillsSource):
    """The skills of the Task type of the current run, with the descriptions written for it. The skills are cached by the
    source below, so a description is set once on the cached skill."""

    async def get_skills(self, context: SkillsSourceContext) -> list[Skill]:
        record = CURRENT_RUN.get()
        wanted = TASK_SKILLS.get(record.task_type if record else "", TASK_SKILLS["design"])
        skills = [skill for skill in await self.inner_source.get_skills(context) if skill.frontmatter.name in wanted]
        for skill in skills:
            skill.frontmatter.description = DESCRIPTIONS.get(skill.frontmatter.name, skill.frontmatter.description)
        return skills


def skills_provider(skills_dir: Path) -> SkillsProvider:
    """No skill advertises resources or scripts: no type is offered `read_skill_resource` or `run_skill_script`, and the
    templates, whose examples a model copies, are not for it to read (`grounding.py` reads them to tell the examples apart)."""
    files = FileSkillsSource(skills_dir, resource_extensions=(), script_extensions=())
    return SkillsProvider(
        TaskSkills(CachingSkillsSource(files)),
        instruction_template=LISTING,
        disable_load_skill_approval=True,
        disable_read_skill_resource_approval=True,
        disable_run_skill_script_approval=True,
    )
