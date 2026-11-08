"""Checks every skill in skills/ against the agentskills.io specification. Run: python3 tests/test_skill_spec.py"""
import re
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parent.parent / "skills"
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def frontmatter(path):
    text = path.read_text()
    if not text.startswith("---\n"):
        raise AssertionError(f"{path}: no YAML frontmatter")
    head, _, body = text[4:].partition("\n---\n")
    fields, current = {}, None
    for line in head.splitlines():
        if line.startswith("  ") and current == "metadata":
            key, _, value = line.strip().partition(":")
            fields["metadata"][key.strip()] = value.strip()
        else:
            key, _, value = line.partition(":")
            current = key.strip()
            fields[current] = {} if current == "metadata" and not value.strip() else value.strip()
    return fields, body


class Spec(unittest.TestCase):
    def test_every_skill(self):
        skills = sorted(p for p in SKILLS.iterdir() if p.is_dir())
        self.assertTrue(skills, "no skills found")
        for skill in skills:
            with self.subTest(skill=skill.name):
                fields, body = frontmatter(skill / "SKILL.md")
                self.assertRegex(fields.get("name", ""), NAME)
                self.assertLessEqual(len(fields["name"]), 64)
                self.assertEqual(fields["name"], skill.name, "name must match the directory")
                self.assertTrue(0 < len(fields.get("description", "")) <= 1024)
                self.assertLessEqual(len(fields.get("compatibility", "")), 500)
                self.assertIsInstance(fields.get("metadata", {}), dict)
                # The spec recommends under 5,000 tokens for the body; 3,500 words is a safe proxy.
                self.assertLess(len(body.split()), 3500)

    def test_referenced_files_exist(self):
        for skill in (p for p in SKILLS.iterdir() if p.is_dir()):
            text = (skill / "SKILL.md").read_text()
            for ref in set(re.findall(r"(?:references|scripts|assets)/[\w.-]+", text)):
                self.assertTrue((skill / ref).exists(), f"{skill.name}: {ref} is missing")


if __name__ == "__main__":
    unittest.main()
