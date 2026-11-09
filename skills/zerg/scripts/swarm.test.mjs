// Self-check for the pure parts of swarm.mjs. Run: node --test skills/zerg/scripts/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as swarm from "./swarm.mjs";

const CONTRACT = `# G-1: demo

base: main
test: make test
max_parallel: 2

## Outcome
x
## Why
x
## Non-goals
- x
## Constraints
- x
## Criteria
- C1: a
- C2: b
## Escalate when
- x
## Decisions
`;

const unit = (uid, scope, { after = "-", criteria = "C1", state = "planned", revisions = "0", note = "", check = "t" } = {}) =>
  ({ unit: uid, task: "t", scope, after, criteria, check, state, revisions, note });

describe("fnmatch", () => {
  test("matches like Python's fnmatch", () => {
    assert.ok(swarm.fnmatch("src/a.py", "src/*.py"));
    assert.ok(swarm.fnmatch("src/deep/a.py", "src/*"), "* crosses slashes, as in Python");
    assert.ok(swarm.fnmatch("a1.py", "a?.py"));
    assert.ok(swarm.fnmatch("b.py", "[ab].py"));
    assert.ok(!swarm.fnmatch("c.py", "[!c].py"));
    assert.ok(!swarm.fnmatch("src/a.pyc", "src/*.py"));
    assert.ok(swarm.fnmatch("a+b.py", "a+b.py"), "regex characters are literal");
  });
});

describe("table", () => {
  test("round trip", () => {
    const units = [unit("U-001", "a.py, b.py", { note: "has | pipe" })];
    const parsed = swarm.parseTable("# plan\n\n" + swarm.renderTable(units) + "\n\nStates: x\n");
    assert.equal(parsed[0].scope, "a.py, b.py");
    assert.equal(parsed[0].note, "has / pipe");
  });

  test("replace keeps the surrounding text", () => {
    const text = swarm.replaceTable("# plan\n\n| a |\n|---|\n| b |\n\nStates: x\n", [unit("U-001", "a.py")]);
    assert.ok(text.startsWith("# plan\n") && text.trimEnd().endsWith("States: x"));
  });
});

describe("contract", () => {
  test("header and criteria", () => {
    assert.equal(swarm.parseHeader(CONTRACT).test, "make test");
    assert.deepEqual(swarm.criteria(CONTRACT), ["C1", "C2"]);
  });

  test("setHeader replaces and inserts", () => {
    const text = swarm.setHeader(swarm.setHeader(CONTRACT, "base", "dev"), "autonomy", "auto");
    assert.equal(swarm.parseHeader(text).base, "dev");
    assert.equal(swarm.parseHeader(text).autonomy, "auto");
  });

  test("lint catches plan errors", () => {
    const units = [unit("U-001", "a.py"), unit("U-002", "a.py", { after: "U-009", criteria: "C9" })];
    const problems = swarm.lintProblems(CONTRACT, units).join(" ");
    for (const expected of ["overlap", "unknown after U-009", "unknown criterion C9", "C2 has no unit"]) {
      assert.ok(problems.includes(expected), expected);
    }
  });

  test("lint catches a cycle and a placeholder", () => {
    const units = [unit("U-001", "a.py", { after: "U-002", criteria: "C1, C2" }), unit("U-002", "b.py", { after: "U-001" })];
    const problems = swarm.lintProblems(CONTRACT.replace("make test", "<cmd>"), units).join(" ");
    assert.match(problems, /cycle/);
    assert.match(problems, /placeholder/);
  });
});

describe("units", () => {
  test("two strikes", () => {
    let u = swarm.reviseUnit(unit("U-001", "a.py", { state: "produced" }), "fails one");
    assert.equal(u.state, "planned");
    u = swarm.reviseUnit({ ...u, state: "produced" }, "fails two");
    assert.equal(u.state, "planned");
    assert.equal(swarm.reviseUnit({ ...u, state: "produced" }, "fails three").state, "stuck");
  });

  test("the same failure twice is stuck", () => {
    const u = swarm.reviseUnit(unit("U-001", "a.py", { state: "produced" }), "same");
    assert.equal(swarm.reviseUnit({ ...u, state: "produced" }, "same").state, "stuck");
  });

  test("ready respects after and parallelism", () => {
    const units = [unit("U-001", "a"), unit("U-002", "b", { after: "U-001" }), unit("U-003", "c"), unit("U-004", "d")];
    assert.deepEqual(swarm.readyUnits(units, 2), ["U-001", "U-003"]);
    units[0].state = "merged";
    assert.deepEqual(swarm.readyUnits(units, 3), ["U-002", "U-003", "U-004"]);
  });

  test("blocked by a dropped dependency", () => {
    const units = [unit("U-001", "a", { state: "dropped" }), unit("U-002", "b", { after: "U-001" })];
    assert.deepEqual(swarm.blockedUnits(units), ["U-002"]);
  });
});

const state = (over = {}) => ({
  stop: false, bound: null, has_contract: true, lint: [], units: [],
  events: new Set(["approved", "defined", "baseline"]), max_parallel: 3, autonomy: "ask",
  unproven: [], phases: {}, fix_exists: false, ...over,
});

describe("derive", () => {
  test("gates come first", () => {
    assert.equal(swarm.derive(state({ stop: true }))[1], "stop");
    assert.equal(swarm.derive(state({ events: new Set() }))[1], "approve");
    assert.equal(swarm.derive(state({ events: new Set(), lint: ["x"] }))[1], "plan");
    assert.equal(swarm.derive(state({ events: new Set(["approved"]) }))[1], "define");
  });

  test("unit loop order", () => {
    const units = [unit("U-001", "a", { state: "produced" }), unit("U-002", "b")];
    for (const phase of ["check", "review", "merge"]) {
      assert.deepEqual(swarm.derive(state({ units, phases: { "U-001": phase } })).slice(0, 2), [6, phase]);
    }
    units[0].state = "merged";
    assert.deepEqual(swarm.derive(state({ units })).slice(0, 2), [8, "implement"]);
  });

  test("stuck respects autonomy", () => {
    const units = [unit("U-001", "a", { state: "stuck" })];
    assert.equal(swarm.derive(state({ units }))[1], "interrupt");
    assert.equal(swarm.derive(state({ units, autonomy: "auto" }))[1], "auto-drop");
  });

  test("close order", () => {
    const units = [unit("U-001", "a", { state: "merged" })];
    const events = new Set(["approved", "defined", "baseline"]);
    assert.equal(swarm.derive(state({ units, events }))[1], "integrate");
    ["integrated", "whole-review"].forEach((e) => events.add(e));
    assert.equal(swarm.derive(state({ units, events, unproven: ["C1"] }))[1], "prove");
    ["learned", "handed-off"].forEach((e) => events.add(e));
    assert.equal(swarm.derive(state({ units, events }))[1], "done");
  });

  test("whole review blocking", () => {
    const units = [unit("U-001", "a", { state: "merged" })];
    const events = new Set(["approved", "defined", "baseline", "integrated", "whole-blocking"]);
    assert.equal(swarm.derive(state({ units, events }))[1], "add-fix");
    assert.equal(swarm.derive(state({ units, events, fix_exists: true }))[1], "interrupt");
  });

  test("unit phase from the log", () => {
    const rows = ["produced", "check-ok", "review-pass", "revise", "produced"].map((event) => ({ subject: "U-1", event, note: "" }));
    assert.equal(swarm.unitPhase(rows, "U-1"), "check");
    rows.push({ subject: "U-1", event: "check-ok", note: "" });
    assert.equal(swarm.unitPhase(rows, "U-1"), "review");
    rows.push({ subject: "U-1", event: "review-pass", note: "" });
    assert.equal(swarm.unitPhase(rows, "U-1"), "merge");
  });

  test("a fix unit reopens integration", () => {
    const rows = ["integrated", "proved", "reopened"].map((event) => ({ event }));
    assert.ok(!swarm.goalEvents(rows).has("integrated"));
  });
});

describe("learned rules", () => {
  test("grep criteria and their owners", () => {
    const text = CONTRACT.replace("- C2: b", "- C2: `grep -rn legacy src` finds nothing");
    assert.deepEqual(swarm.grepCriteria(text), [["C2", "grep -rn legacy src"]]);
    const files = swarm.grepHitFiles("src/a.py:1:import legacy\nsrc/b.py:3:legacy\n");
    const units = [unit("U-001", "src/a.py", { criteria: "C1, C2" }), unit("U-002", "src/b.py", { criteria: "C1" })];
    assert.deepEqual(swarm.grepProblems("C2", files, units), ["C2: its grep hits src/b.py, which no unit serving C2 has in scope"]);
  });

  test("open findings gate the baseline", () => {
    const rows = [
      { event: "examiner-finding", subject: "U-001", note: "" },
      { event: "examiner-finding", subject: "U-002", note: "" },
      { event: "amended", subject: "U-001", note: "" },
    ];
    assert.deepEqual(swarm.openFindings(rows), ["U-002"]);
    const s = state({ events: new Set(["approved", "defined"]), open_findings: ["U-002"] });
    assert.deepEqual(swarm.derive(s).slice(0, 2), [4, "amend"]);
  });

  test("learn.md splits into two lanes", () => {
    const text = "# Learn\n\n## zerg\n\n### P1. hide holdout\nx\n\n## project\n\nnone\n";
    assert.deepEqual(swarm.splitLanes(text), { zerg: "### P1. hide holdout\nx", project: "" });
  });
});

describe("user layer", () => {
  const INBOX = "# inbox\n\n## shop G-a (2026-11-08)\n\n### P1. hide holdout (change)\nwhy\n\n" +
    "### P2. ignore owner (add)\nwhy2\n\n## web G-b (2026-11-09)\n\n### P1. other (add)\nx\n";

  test("parse and render the inbox", () => {
    const proposals = swarm.parseInbox(INBOX);
    assert.deepEqual(proposals.map((p) => p.id), ["shop/G-a/P1", "shop/G-a/P2", "web/G-b/P1"]);
    const rest = swarm.parseInbox(swarm.renderInbox(proposals.slice(1)));
    assert.deepEqual(rest.map((p) => [p.id, p.body]), [["shop/G-a/P2", "why2"], ["web/G-b/P1", "x"]]);
  });

  test("config overrides the bounds", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zerg-"));
    fs.writeFileSync(path.join(home, "config"), "max_revisions: 4\nbogus: 9\nno_progress: 1\nmax_passes: x\n");
    process.env.ZERG_HOME = home;
    try {
      assert.deepEqual(swarm.userBounds(), { ...swarm.BOUNDS, max_revisions: 4 });
    } finally {
      delete process.env.ZERG_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("revise uses the given bound", () => {
    assert.equal(swarm.reviseUnit(unit("U-001", "a.py", { state: "produced", revisions: "2" }), "x", 4).state, "planned");
  });
});

describe("bounds", () => {
  test("no progress and budget", () => {
    const passes = Array(3).fill({ event: "pass", note: "same" });
    assert.match(swarm.boundHit(passes), /no progress/);
    const tokens = [{ event: "tokens", note: "implement 600" }, { event: "tokens", note: "review 500" }];
    assert.match(swarm.boundHit(tokens, { budget: 1000 }), /budget/);
    assert.equal(swarm.boundHit(tokens), null);
  });

  test("progress inside a state counts", () => {
    const units = [unit("U-1", "a", { state: "produced" })];
    const before = [{ event: "produced", subject: "U-1" }];
    const after = [...before, { event: "check-ok", subject: "U-1" }, { event: "pass", subject: "G" }];
    assert.notEqual(swarm.fingerprint(units, before), swarm.fingerprint(units, after));
    const passes = Array(2).fill({ event: "pass", note: "old" });
    assert.equal(swarm.boundHit(passes, { current: "new" }), null);
    assert.match(swarm.boundHit(passes, { current: "old" }), /no progress/);
  });

  test("the iteration cap grows with the plan", () => {
    const passes = Array.from({ length: swarm.BOUNDS.max_passes }, (_, i) => ({ event: "pass", note: String(i) }));
    assert.match(swarm.boundHit(passes), /iteration cap/);
    assert.equal(swarm.boundHit(passes, { unitCount: 5 }), null, "a clean 5-unit goal must fit");
    const more = [...passes, ...Array.from({ length: 25 }, (_, i) => ({ event: "pass", note: String(100 + i) }))];
    assert.match(swarm.boundHit(more, { unitCount: 5 }), /cap 45/);
  });

  test("scope violations", () => {
    assert.deepEqual(swarm.scopeViolations(["src/a.py", "tests/t.py"], ["src/*.py"]), ["tests/t.py"]);
  });
});

describe("batch 1 guards", () => {
  test("ids are validated before they reach a path", () => {
    assert.equal(swarm.argProblem("report", ["G-ok", "U-001", "produced"]), null);
    assert.match(swarm.argProblem("report", ["G-ok", "../../..", "gave_up"]), /unit id/);
    assert.match(swarm.argProblem("next", ["../x"]), /goal id/);
    assert.match(swarm.argProblem("next", ["G-Bad Name"]), /goal id/);
    assert.match(swarm.argProblem("lease", ["G-ok", "U-001", "U-002/../x"]), /U-002\/\.\.\/x/);
    assert.equal(swarm.argProblem("review", ["G-ok", "whole", "pass"]), null);
    assert.equal(swarm.argProblem("answer", ["G-ok", "goal", "x"]), null);
    assert.equal(swarm.argProblem("brief", ["G-ok", "verifier", "whole"]), null);
    assert.match(swarm.argProblem("tokens", ["G-ok", "a b", "x", "1"]), /plain word/);
  });

  test("grep criteria parse to argv, or not at all", () => {
    assert.deepEqual(swarm.grepArgv(`grep -rn "a b" src`), ["grep", "-H", "-rn", "a b", "src"], "-H names the file even for one");
    assert.deepEqual(swarm.grepArgv("grep -rn 'x;y' src"), ["grep", "-H", "-rn", "x;y", "src"]);
    for (const bad of ["grep x src; touch p", "grep x src | sh", "grep $(id) src", "grep `id` src", "grep x > f", "rm -rf x", "grep 'open"]) {
      assert.equal(swarm.grepArgv(bad), null, bad);
    }
  });

  test("glob overlap finds real overlaps and only those", () => {
    assert.ok(swarm.globOverlap("src/*.js", "src/a*"), "both match src/abc.js");
    assert.ok(swarm.globOverlap("src/a.py", "src/*.py"));
    assert.ok(swarm.globOverlap("src/**", "src/x/y.py"));
    assert.ok(!swarm.globOverlap("src/*.js", "src/*.py"));
    assert.ok(!swarm.globOverlap("src/a.py", "src/b.py"));
    assert.ok(!swarm.globOverlap("lib/*", "src/*"));
  });

  test("the examiner's test files are off limits whatever the scope", () => {
    assert.deepEqual(swarm.testViolations(["src/a.py", "src/a.test.js"], ["src/a.test.js"]), ["src/a.test.js"]);
  });

  test("secret-looking files are recognized", () => {
    for (const p of [".env", ".env.local", "config/.env.production", "certs/server.pem", "id.key"]) assert.ok(swarm.SECRET.test(p), p);
    for (const p of ["src/env.py", "keyboard.js", "docs/pem-format.md"]) assert.ok(!swarm.SECRET.test(p), p);
  });
});

describe("batch 2 recovery", () => {
  test("a lease is orphaned only when its worktree is gone or it is too old", () => {
    const leases = [
      { unit: "U-1", worktree: true, minutes: 5 },
      { unit: "U-2", worktree: false, minutes: 5 },
      { unit: "U-3", worktree: true, minutes: 90 },
    ];
    assert.deepEqual(swarm.orphanedLeases(leases, 60), ["U-2", "U-3"]);
  });

  test("live leases make row 7 wait instead of orphaning them", () => {
    const units = [unit("U-001", "a", { state: "leased" }), unit("U-002", "b", { after: "U-001" })];
    assert.deepEqual(swarm.derive(state({ units, orphans: [] })).slice(0, 2), [7, "wait"]);
    assert.deepEqual(swarm.derive(state({ units, orphans: ["U-001"] })).slice(0, 2), [7, "orphans"]);
  });

  test("row 9 says which units are stuck and which wait on them", () => {
    const units = [unit("U-001", "a", { state: "stuck" }), unit("U-002", "b", { after: "U-001" }), unit("U-003", "c", { state: "merged" })];
    assert.equal(swarm.derive(state({ units }))[2], "U-001 (stuck) U-002 (blocked by U-001)");
  });

  test("a failed integration is a goal-level question, even under auto", () => {
    const units = [unit("U-001", "a", { state: "merged" })];
    const events = new Set(["approved", "defined", "baseline", "integrate-failed"]);
    for (const autonomy of ["ask", "auto"]) {
      const [row, action, detail] = swarm.derive(state({ units, events, autonomy }));
      assert.deepEqual([row, action], [9, "interrupt"]);
      assert.match(detail, /^goal: integration failed/);
    }
  });

  test("reopen clears integration, its failure, and the whole review", () => {
    const rows = ["integrated", "integrate-failed", "whole-review", "whole-blocking", "reopened"].map((event) => ({ event }));
    const events = swarm.goalEvents(rows);
    for (const gone of ["integrated", "integrate-failed", "whole-review", "whole-blocking"]) assert.ok(!events.has(gone), gone);
  });

  test("waive takes a criterion or whole", () => {
    assert.equal(swarm.argProblem("waive", ["G-ok", "C2", "why"]), null);
    assert.equal(swarm.argProblem("waive", ["G-ok", "whole", "why"]), null);
    assert.match(swarm.argProblem("waive", ["G-ok", "U-001", "why"]), /criterion like C1/);
  });

  test("lease_minutes is a bound users can set", () => {
    assert.equal(swarm.BOUNDS.lease_minutes, 60);
  });
});

describe("batch 3 real repos", () => {
  test("a CRLF contract parses like an LF one", () => {
    const crlf = swarm.normalizeNewlines(CONTRACT.replaceAll("\n", "\r\n"));
    assert.deepEqual(swarm.criteria(crlf), ["C1", "C2"]);
    assert.equal(swarm.lintProblems(crlf, [unit("U-001", "a.py", { criteria: "C1, C2" })]).length, 0);
  });

  test("git -z output is read unquoted, and a rename yields its new path", () => {
    assert.deepEqual(swarm.parsePorcelainZ(" M src/café.py\0R  new name.py\0old.py\0?? x y\0"), ["src/café.py", "new name.py", "x y"]);
  });

  test("scopes are compared in git's forward-slash form", () => {
    assert.deepEqual(swarm.scopeGlobs("src\\a.py, lib\\*.js"), ["src/a.py", "lib/*.js"]);
    assert.deepEqual(swarm.scopeViolations(["src/a.py"], swarm.scopeGlobs("src\\a.py")), []);
  });

  test("a repo name with spaces becomes one word in inbox ids", () => {
    assert.equal(swarm.slug("my repo "), "my-repo");
    const inbox = `# inbox\n\n## ${swarm.slug("my repo")} G-a (2026-11-08)\n\n### P1. x (add)\ny\n`;
    assert.deepEqual(swarm.parseInbox(inbox).map((p) => p.id), ["my-repo/G-a/P1"]);
  });

  test("@test runs the contract's test command, verbatim", () => {
    assert.equal(swarm.resolveCheck("@test", "npm test | tee out"), "npm test | tee out");
    assert.equal(swarm.resolveCheck("npm run unit", "npm test"), "npm run unit");
  });

  test("numeric headers are validated", () => {
    assert.deepEqual(swarm.numberProblems({ max_parallel: "3", token_budget: "" }), []);
    assert.equal(swarm.numberProblems({ max_parallel: "-1" }).length, 1);
    assert.equal(swarm.numberProblems({ max_parallel: "0" }).length, 1);
    assert.equal(swarm.numberProblems({ token_budget: "lots" }).length, 1);
  });
});
