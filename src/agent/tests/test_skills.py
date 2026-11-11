import logging
import re
import sys
import unittest
from pathlib import Path

from agent_framework import AgentSession, SessionContext

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

from agent import skills_provider

SKILLS_DIR = Path(__file__).parents[1] / "skills"

RESOURCES = {
    "healthmodel-analyze": [],
    "healthmodel-build": ["templates/main.bicep"],
    "healthmodel-plan": ["templates/modelspec.md", "templates/plan.md"],
}


class SkillsProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        context = SessionContext(input_messages=[])
        await skills_provider(SKILLS_DIR).before_run(agent=None, session=AgentSession(), context=context, state={})
        self.context = context
        self.tools = {tool.name: tool for tool in context.tools}

    def test_no_skill_tool_waits_for_approval(self):
        self.assertEqual(sorted(self.tools), ["load_skill", "read_skill_resource", "run_skill_script"])
        for name, tool in self.tools.items():
            with self.subTest(name):
                self.assertEqual(tool.approval_mode, "never_require")

    def test_the_three_skills_are_advertised(self):
        advertised = re.findall(r"<name>([^<]+)</name>", self.context.instructions[0])

        self.assertEqual(advertised, sorted(RESOURCES))

    async def test_templates_are_found_as_resources_and_no_skill_has_scripts(self):
        for skill, resources in RESOURCES.items():
            with self.subTest(skill):
                content = await self.tools["load_skill"].invoke(arguments={"skill_name": skill}, skip_parsing=True)

                self.assertEqual(re.findall(r'<resource name="([^"]+)"/>', content), resources)
                self.assertIn("<available_scripts />", content)

    async def test_resources_can_be_read_including_the_bicep_template(self):
        for skill, resources in RESOURCES.items():
            for resource in resources:
                with self.subTest(resource):
                    text = await self.tools["read_skill_resource"].invoke(
                        arguments={"skill_name": skill, "resource_name": resource}, skip_parsing=True
                    )

                    self.assertEqual(text, (SKILLS_DIR / skill / resource).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
