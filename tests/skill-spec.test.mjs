// Checks every skill in skills/ against the agentskills.io specification. Run: node --test tests/
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const skills = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("---\n"), `${file}: no YAML frontmatter`);
  const end = text.indexOf("\n---\n", 4);
  const fields = {};
  let current = "";
  for (const line of text.slice(4, end).split("\n")) {
    if (line.startsWith("  ") && current === "metadata") {
      const [key, ...rest] = line.trim().split(":");
      fields.metadata[key.trim()] = rest.join(":").trim();
    } else {
      const [key, ...rest] = line.split(":");
      current = key.trim();
      const value = rest.join(":").trim();
      fields[current] = current === "metadata" && !value ? {} : value;
    }
  }
  return { fields, body: text.slice(end + 5) };
}

test("there is at least one skill", () => assert.ok(skills.length));

for (const name of skills) {
  test(`${name}: frontmatter follows the spec`, () => {
    const { fields, body } = frontmatter(path.join(SKILLS, name, "SKILL.md"));
    assert.match(fields.name ?? "", NAME);
    assert.ok(fields.name.length <= 64);
    assert.equal(fields.name, name, "name must match the directory");
    assert.ok(fields.description && fields.description.length <= 1024);
    assert.ok((fields.compatibility ?? "").length <= 500);
    assert.equal(typeof (fields.metadata ?? {}), "object");
    // The spec recommends under 5,000 tokens for the body; 3,500 words is a safe proxy.
    assert.ok(body.split(/\s+/).length < 3500);
  });

  test(`${name}: every referenced file exists`, () => {
    const text = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
    for (const ref of new Set(text.match(/(?:references|scripts|assets)\/[\w.-]+/g) ?? [])) {
      assert.ok(fs.existsSync(path.join(SKILLS, name, ref)), `${ref} is missing`);
    }
  });
}

test("zerg: every row derive can print has a line in SKILL.md's Rows table", () => {
  const core = fs.readFileSync(path.join(SKILLS, "zerg", "scripts", "core.mjs"), "utf8");
  const printed = new Set([...core.matchAll(/return \[(\d+), (?:s\.autonomy === "auto" \? "auto-drop" : )?"([a-z-]+)"/g)]
    .map(([, row, action]) => `${row} ${action}`));
  // These come from a variable or a ternary, so the regex can't see them.
  for (const row of ["9 auto-drop", "6 check", "6 review", "6 merge"]) printed.add(row);
  const skill = fs.readFileSync(path.join(SKILLS, "zerg", "SKILL.md"), "utf8");
  const documented = new Set();
  for (const [, rows, actions] of skill.matchAll(/^\| ([\d, ]+) \| ((?:`[a-z-]+`(?:, )?)+) \|/gm)) {
    for (const row of rows.split(",").map((r) => r.trim())) {
      for (const [, action] of actions.matchAll(/`([a-z-]+)`/g)) documented.add(`${row} ${action}`);
    }
  }
  const missing = [...printed].filter((r) => !documented.has(r));
  assert.deepEqual(missing, [], `rows derive can print but SKILL.md doesn't explain: ${missing.join(", ")}`);
});
