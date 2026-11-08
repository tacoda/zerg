"""Self-check for the pure parts of swarm.py. Run: python3 bin/test_swarm.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import swarm  # noqa: E402

CONTRACT = """# G-1: demo

base: main
test: make test
holdout:
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
"""


def unit(uid, scope, after="-", criteria="C1", state="planned", revisions="0", note="", check="t"):
    return {"unit": uid, "task": "t", "scope": scope, "after": after, "criteria": criteria,
            "check": check, "state": state, "revisions": revisions, "note": note}


class Table(unittest.TestCase):
    def test_round_trip(self):
        units = [unit("U-001", "a.py, b.py", note="has | pipe")]
        parsed = swarm.parse_table("# plan\n\n" + swarm.render_table(units) + "\n\nStates: x\n")
        self.assertEqual(parsed[0]["scope"], "a.py, b.py")
        self.assertEqual(parsed[0]["note"], "has / pipe")

    def test_replace_keeps_surrounding_text(self):
        text = swarm.replace_table("# plan\n\n| a |\n|---|\n| b |\n\nStates: x\n", [unit("U-001", "a.py")])
        self.assertTrue(text.startswith("# plan\n") and text.rstrip().endswith("States: x"))


class Contract(unittest.TestCase):
    def test_header_and_criteria(self):
        self.assertEqual(swarm.parse_header(CONTRACT)["test"], "make test")
        self.assertEqual(swarm.criteria(CONTRACT), ["C1", "C2"])

    def test_set_header_replaces_and_inserts(self):
        text = swarm.set_header(swarm.set_header(CONTRACT, "base", "dev"), "autonomy", "auto")
        self.assertEqual(swarm.parse_header(text)["base"], "dev")
        self.assertEqual(swarm.parse_header(text)["autonomy"], "auto")

    def test_lint_catches_plan_errors(self):
        units = [unit("U-001", "a.py"), unit("U-002", "a.py", after="U-009", criteria="C9")]
        problems = " ".join(swarm.lint_problems(CONTRACT, units))
        for expected in ("overlap", "unknown after U-009", "unknown criterion C9", "C2 has no unit"):
            self.assertIn(expected, problems)

    def test_lint_catches_cycle_and_placeholder(self):
        units = [unit("U-001", "a.py", after="U-002", criteria="C1, C2"), unit("U-002", "b.py", after="U-001")]
        problems = " ".join(swarm.lint_problems(CONTRACT.replace("make test", "<cmd>"), units))
        self.assertIn("cycle", problems)
        self.assertIn("placeholder", problems)


class Units(unittest.TestCase):
    def test_two_strikes(self):
        u = unit("U-001", "a.py", state="produced")
        u = swarm.revise_unit(u, "fails one")
        self.assertEqual(u["state"], "planned")
        u = swarm.revise_unit({**u, "state": "produced"}, "fails two")
        self.assertEqual(u["state"], "planned")
        self.assertEqual(swarm.revise_unit({**u, "state": "produced"}, "fails three")["state"], "stuck")

    def test_same_failure_twice_is_stuck(self):
        u = swarm.revise_unit(unit("U-001", "a.py", state="produced"), "same")
        self.assertEqual(swarm.revise_unit({**u, "state": "produced"}, "same")["state"], "stuck")

    def test_ready_respects_after_and_parallelism(self):
        units = [unit("U-001", "a"), unit("U-002", "b", after="U-001"), unit("U-003", "c"), unit("U-004", "d")]
        self.assertEqual(swarm.ready_units(units, 2), ["U-001", "U-003"])
        units[0]["state"] = "merged"
        self.assertEqual(swarm.ready_units(units, 3), ["U-002", "U-003", "U-004"])

    def test_blocked_by_dropped_dependency(self):
        units = [unit("U-001", "a", state="dropped"), unit("U-002", "b", after="U-001")]
        self.assertEqual(swarm.blocked_units(units), ["U-002"])


class Derive(unittest.TestCase):
    def state(self, **over):
        base = {"stop": False, "bound": None, "has_contract": True, "lint": [], "units": [],
                "events": {"approved", "defined", "baseline"}, "max_parallel": 3, "autonomy": "ask",
                "unproven": [], "phases": {}, "fix_exists": False}
        return {**base, **over}

    def test_gates_come_first(self):
        self.assertEqual(swarm.derive(self.state(stop=True))[1], "stop")
        self.assertEqual(swarm.derive(self.state(events=set()))[1], "approve")
        self.assertEqual(swarm.derive(self.state(events=set(), lint=["x"]))[1], "plan")
        self.assertEqual(swarm.derive(self.state(events={"approved"}))[1], "define")

    def test_unit_loop_order(self):
        units = [unit("U-001", "a", state="produced"), unit("U-002", "b")]
        for phase in ("check", "review", "merge"):
            self.assertEqual(swarm.derive(self.state(units=units, phases={"U-001": phase}))[:2], (6, phase))
        units[0]["state"] = "merged"
        self.assertEqual(swarm.derive(self.state(units=units))[:2], (8, "implement"))

    def test_stuck_respects_autonomy(self):
        units = [unit("U-001", "a", state="stuck")]
        self.assertEqual(swarm.derive(self.state(units=units))[1], "interrupt")
        self.assertEqual(swarm.derive(self.state(units=units, autonomy="auto"))[1], "auto-drop")

    def test_close_order(self):
        done = [unit("U-001", "a", state="merged")]
        events = {"approved", "defined", "baseline"}
        self.assertEqual(swarm.derive(self.state(units=done, events=events))[1], "integrate")
        events |= {"integrated", "whole-review"}
        self.assertEqual(swarm.derive(self.state(units=done, events=events, unproven=["C1"]))[1], "prove")
        events |= {"learned", "handed-off"}
        self.assertEqual(swarm.derive(self.state(units=done, events=events))[1], "done")

    def test_whole_review_blocking(self):
        done = [unit("U-001", "a", state="merged")]
        events = {"approved", "defined", "baseline", "integrated", "whole-blocking"}
        self.assertEqual(swarm.derive(self.state(units=done, events=events))[1], "add-fix")
        self.assertEqual(swarm.derive(self.state(units=done, events=events, fix_exists=True))[1], "interrupt")

    def test_unit_phase_from_log(self):
        rows = [{"subject": "U-1", "event": e} for e in ("produced", "check-ok", "review-pass", "revise", "produced")]
        self.assertEqual(swarm.unit_phase(rows, "U-1"), "check")
        rows.append({"subject": "U-1", "event": "check-ok"})
        self.assertEqual(swarm.unit_phase(rows, "U-1"), "review")
        rows.append({"subject": "U-1", "event": "review-pass"})
        self.assertEqual(swarm.unit_phase(rows, "U-1"), "merge")

    def test_fix_unit_reopens_integration(self):
        rows = [{"event": e} for e in ("integrated", "proved", "reopened")]
        self.assertNotIn("integrated", swarm.goal_events(rows))


class Learned(unittest.TestCase):
    def test_grep_criteria_and_owners(self):
        text = CONTRACT.replace("- C2: b", "- C2: `grep -rn legacy src` finds nothing")
        self.assertEqual(swarm.grep_criteria(text), [("C2", "grep -rn legacy src")])
        files = swarm.grep_hit_files("src/a.py:1:import legacy\nsrc/b.py:3:legacy\n")
        units = [unit("U-001", "src/a.py", criteria="C1, C2"), unit("U-002", "src/b.py", criteria="C1")]
        self.assertEqual(swarm.grep_problems("C2", files, units),
                         ["C2: its grep hits src/b.py, which no unit serving C2 has in scope"])

    def test_open_findings_gate(self):
        rows = [{"event": "examiner-finding", "subject": "U-001"}, {"event": "examiner-finding", "subject": "U-002"},
                {"event": "amended", "subject": "U-001"}]
        self.assertEqual(swarm.open_findings(rows), ["U-002"])
        state = Derive().state(events={"approved", "defined"}, open_findings=["U-002"])
        self.assertEqual(swarm.derive(state)[:2], (4, "amend"))


class Lanes(unittest.TestCase):
    def test_split_lanes(self):
        text = "# Learn\n\n## zerg\n\n### P1. hide holdout\nx\n\n## project\n\nnone\n"
        self.assertEqual(swarm.split_lanes(text), {"zerg": "### P1. hide holdout\nx", "project": ""})


class UserLayer(unittest.TestCase):
    INBOX = ("# inbox\n\n## shop G-a (2026-11-08)\n\n### P1. hide holdout (change)\nwhy\n\n"
             "### P2. ignore owner (add)\nwhy2\n\n## web G-b (2026-11-09)\n\n### P1. other (add)\nx\n")

    def test_parse_and_render_inbox(self):
        proposals = swarm.parse_inbox(self.INBOX)
        self.assertEqual([p["id"] for p in proposals], ["shop/G-a/P1", "shop/G-a/P2", "web/G-b/P1"])
        rest = swarm.parse_inbox(swarm.render_inbox(proposals[1:]))
        self.assertEqual([(p["id"], p["body"]) for p in rest], [("shop/G-a/P2", "why2"), ("web/G-b/P1", "x")])

    def test_user_bounds_override(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config").write_text("max_revisions: 4\nbogus: 9\nno_progress: x\n")
            os.environ["ZERG_HOME"] = home
            try:
                self.assertEqual(swarm.user_bounds(), {**swarm.BOUNDS, "max_revisions": 4})
            finally:
                del os.environ["ZERG_HOME"]

    def test_revise_uses_given_bound(self):
        u = unit("U-001", "a.py", state="produced", revisions="2")
        self.assertEqual(swarm.revise_unit(u, "x", max_revisions=4)["state"], "planned")


class Bounds(unittest.TestCase):
    def test_no_progress_and_budget(self):
        passes = [{"event": "pass", "note": "same"}] * 3
        self.assertIn("no progress", swarm.bound_hit(passes, 0))
        tokens = [{"event": "tokens", "note": "implement 600"}, {"event": "tokens", "note": "review 500"}]
        self.assertIn("budget", swarm.bound_hit(tokens, 1000))
        self.assertIsNone(swarm.bound_hit(tokens, 0))

    def test_progress_inside_a_state(self):
        units = [unit("U-1", "a", state="produced")]
        before = [{"event": "produced", "subject": "U-1"}]
        after = before + [{"event": "check-ok", "subject": "U-1"}, {"event": "pass", "subject": "G"}]
        self.assertNotEqual(swarm.fingerprint(units, before), swarm.fingerprint(units, after))
        passes = [{"event": "pass", "note": "old"}] * 2
        self.assertIsNone(swarm.bound_hit(passes, 0, current="new"))
        self.assertIn("no progress", swarm.bound_hit(passes, 0, current="old"))

    def test_iteration_cap(self):
        passes = [{"event": "pass", "note": str(i)} for i in range(swarm.BOUNDS["max_passes"])]
        self.assertIn("iteration cap", swarm.bound_hit(passes, 0))
        self.assertIsNone(swarm.bound_hit(passes, 0, unit_count=5), "a clean 5-unit goal must fit")
        more = passes + [{"event": "pass", "note": str(i)} for i in range(100, 125)]
        self.assertIn("cap 45", swarm.bound_hit(more, 0, unit_count=5))

    def test_scope_violations(self):
        self.assertEqual(swarm.scope_violations(["src/a.py", "tests/t.py"], ["src/*.py"]), ["tests/t.py"])


if __name__ == "__main__":
    unittest.main()
