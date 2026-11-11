import logging
import re
import sys
import unittest
from pathlib import Path

from agent_framework import AgentSession, SessionContext

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

from agent import skills_provider
from grounding import load_templates
from skillset import DESCRIPTIONS, TASK_SKILLS
from tools import CURRENT_RUN, RunRecord

SKILLS_DIR = Path(__file__).parents[1] / "skills"

class SkillsProviderTests(unittest.IsolatedAsyncioTestCase):
    async def provide(self, task_type):
        token = CURRENT_RUN.set(RunRecord(task_type=task_type))
        self.addCleanup(CURRENT_RUN.reset, token)
        context = SessionContext(input_messages=[])
        await skills_provider(SKILLS_DIR).before_run(agent=None, session=AgentSession(), context=context, state={})
        return context, {tool.name: tool for tool in context.tools}

    async def test_no_skill_tool_waits_for_approval(self):
        _, tools = await self.provide("design")

        self.assertEqual(sorted(tools), ["load_skill", "read_skill_resource", "run_skill_script"])
        for name, tool in tools.items():
            with self.subTest(name):
                self.assertEqual(tool.approval_mode, "never_require")

    async def test_each_task_type_is_advertised_its_own_skills_with_the_descriptions_written_for_it(self):
        for task_type, skills in [*TASK_SKILLS.items(), ("", TASK_SKILLS["design"])]:
            with self.subTest(task_type):
                context, _ = await self.provide(task_type)

                listing = context.instructions[0]
                self.assertEqual(re.findall(r"<name>([^<]+)</name>", listing), sorted(skills))
                for skill, description in DESCRIPTIONS.items():
                    self.assertEqual(description in listing, skill in skills)
                self.assertNotIn("read_skill_resource", listing)
                self.assertNotIn("run_skill_script", listing)

    async def test_a_skill_of_another_type_cannot_be_loaded(self):
        _, tools = await self.provide("explain")

        for skill in ("healthmodel-build", "healthmodel-plan", "healthmodel-design-rules"):
            with self.subTest(skill):
                content = await tools["load_skill"].invoke(arguments={"skill_name": skill}, skip_parsing=True)

                self.assertEqual(content, f"Error: Skill '{skill}' not found.")

    async def test_no_skill_advertises_resources_or_scripts(self):
        _, tools = await self.provide("design")
        _, review_tools = await self.provide("review")

        for skill in TASK_SKILLS["design"] + TASK_SKILLS["review"]:
            with self.subTest(skill):
                loaded = tools if skill in TASK_SKILLS["design"] else review_tools
                content = await loaded["load_skill"].invoke(arguments={"skill_name": skill}, skip_parsing=True)

                self.assertEqual(re.findall(r"<resource name=", content), [])
                self.assertEqual(re.findall(r"<script name=", content), [])
                self.assertIn((SKILLS_DIR / skill / "SKILL.md").read_text(encoding="utf-8").split("---", 2)[2].strip().splitlines()[0], content)

    async def test_the_templates_are_not_read_by_the_model_but_still_feed_the_example_words(self):
        _, tools = await self.provide("design")

        text = await tools["read_skill_resource"].invoke(
            arguments={"skill_name": "healthmodel-plan", "resource_name": "templates/plan.md"}, skip_parsing=True
        )

        self.assertEqual(text, "Error: Resource 'templates/plan.md' not found in skill 'healthmodel-plan'.")
        self.assertEqual(
            sorted(path.name for path in SKILLS_DIR.glob("*/templates/*")), ["main.bicep", "modelspec.md", "plan.md"]
        )
        self.assertTrue(load_templates(SKILLS_DIR))

    async def test_the_description_of_a_skill_is_set_once_on_the_cached_skill(self):
        provider = skills_provider(SKILLS_DIR)
        token = CURRENT_RUN.set(RunRecord(task_type="explain"))
        self.addCleanup(CURRENT_RUN.reset, token)

        for _ in range(2):
            context = SessionContext(input_messages=[])
            await provider.before_run(agent=None, session=AgentSession(), context=context, state={})

        self.assertEqual(context.instructions[0].count(DESCRIPTIONS["healthmodel-analyze"]), 1)


if __name__ == "__main__":
    unittest.main()
