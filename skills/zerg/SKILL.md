---
name: zerg
description: Runs a governed swarm of agents on one goal in a git repo, from a plain-language goal to a tested branch ready to merge. You write the contract and plan, the human approves once, then examiner, worker, and verifier roles run test-first stages while a script enforces every gate, bound, and state change. Safe to re-invoke to resume. Also reviews the lessons past goals sent back. Use when asked to swarm a goal, run zerg, resume a zerg goal by id, or review zerg lessons.
license: MIT
compatibility: Needs git, Python 3.8 or later, and a repo whose test suite runs from one command. Works in any agent that can run shell commands; uses subagents when the agent has them.
metadata:
  author: tacoda
  version: "0.6.0"
---

# zerg

You are the orchestrator. Find the absolute path of the directory that holds this file and call it `SKILL_DIR`.
`S` means `python3 SKILL_DIR/scripts/swarm.py`. Run it from inside the target repo.

The script holds every gate, bound, and state change. You run `S next`, do the one action it prints, and
run `S next` again. You never write product code or tests, and you never edit `plan.md` or `log.md` by hand.
The roles do the work: the examiner writes tests, workers write code, and verifiers judge.

## Iron laws

1. **`S next` decides.** If you disagree with it, stop and tell the human. Never work around it.
2. **Derive, don't remember.** State lives in `.swarm/<goal>/` and git. Nothing in this conversation decides a route.
3. **Hand off by identifier.** A role gets exactly what `S brief` prints. Never add a summary of the run.
4. **Roles record their own results** with `S define`, `S report`, and `S review`. You don't relay or reinterpret them.
5. **Scripts check; they don't trust.** `report` needs commits, `check` runs the tests, and `merge` needs a recorded pass.
6. **Holdout stays hidden.** Never show a role anything under `.swarm/<goal>/holdout/`.
7. **Nothing merges into base.** You build `swarm/<goal>`. The human merges it.

## Running a role

Get the handoff text with `S brief <goal> <role> [unit]`. Then:

- **If your agent has subagents,** start a fresh one per handoff and give it exactly that text. Run the workers
  for one `implement` row, and the verifiers for one `review` row, in parallel.
- **If it doesn't,** do the role yourself: read the role file the brief names and follow it. Treat it as a
  fresh start, and re-read the files instead of trusting what you remember. Be aware that one agent playing
  both worker and verifier is weaker review than two separate agents. Say so in the hand-off.

## Rows

`S next` prints `row N <action>: <detail>`.

| Row | Action | Do this |
|---|---|---|
| 0, 1 | `stop` | Report the detail. Stop. |
| 2 | `scope`, `plan` | Plan the goal (see Planning). |
| 3 | `approve` | Print `S summary <goal>`. Ask the human: approve and ask on stuck, approve and auto-drop stuck, revise with a note, or stop. On approval, run `S approve <goal> ask` or `S approve <goal> auto`. |
| 4 | `define` | Run the examiner: `S brief <goal> examiner`. It records its checks with `S define`. |
| 4 | `amend` | For each unit listed, run `S amend <goal> <unit> "<finding>"`, using the finding from `log.md`. If a finding needs a file outside the unit's scope, ask the human. |
| 5 | `baseline` | Run `S baseline <goal>`. If units pass before any work, run the examiner again with `Strengthen: <units>` added to its brief. |
| 6 | `check` | Run `S check <goal> <unit>` for each unit. Failures revise themselves. |
| 6 | `review` | Run a verifier per unit: `S brief <goal> verifier <unit>`. It records its verdict with `S review`. |
| 6 | `merge` | Run `S merge <goal> <unit>` for each unit. |
| 7 | `orphans` | For each unit: `S move <goal> <unit> planned "lease lost"`. |
| 8 | `implement` | Run `S lease <goal> <units>`, then a worker per unit: `S brief <goal> worker <unit>`. Each records its result with `S report`. |
| 9 | `interrupt` | Read each listed unit's `note` in `plan.md`. Ask the human one question per unit (see Asking). |
| 9 | `auto-drop` | For each unit: `S move <goal> <unit> dropped "auto: <note>"`. |
| 10 | `integrate` | Run `S integrate <goal>`. If it fails, ask the human, and report holdout as pass or fail only. |
| 11 | `whole-review` | Run a verifier: `S brief <goal> verifier whole`. It records the result with `S review <goal> whole`. Log each advisory finding with `S stage <goal> finding "<text>"`. |
| 11 | `add-fix` | Run `S add-fix <goal> "<task>" "<scope>"` for the blocking finding in `log.md`. |
| 12 | `prove` | For each criterion listed, run `S prove <goal> <C> "<command>"` with a command that shows it. If no command proves a criterion, ask the human. |
| 13 | `learn` | Write `learn.md` (see Learning), then run `S stage <goal> learned`. |
| 14 | `handoff` | Run `S handoff <goal>` and print its report. Stop. |

## Planning (row 2)

1. Run `S new <goal>`. The goal id is `G-` plus a short kebab slug.
2. Run `S home`, then read the user `rules.md` it names and `.swarm/LEARNINGS.md`, if they exist. Plan with both.
3. Find the test command in the repo's docs or build files. Read the code the goal touches.
4. Fill in `.swarm/<goal>/contract.md`:
   - Make every criterion observable.
   - Write a criterion about a string's absence as a backticked `grep ...` command.
   - Use Constraints to name edge cases and behavior that must not change.
5. Fill in `.swarm/<goal>/plan.md`:
   - Give each unit a scope of product files only, plus `after` and `criteria`.
   - Give a change that two units need its own unit.
6. Run `S lint <goal>` until it passes. If the goal holds more than one shippable outcome, or needs more than 6 units, plan the first goal and name the rest.

## Asking

Ask the human in whatever way your agent supports. If it can't ask in the middle of a run, print the
question with `INTERRUPT:` at the front, then stop. The human answers by invoking the skill again.

Record answers through the script, never by editing files:

| Answer | Command |
|---|---|
| a decision for the goal | `S answer <goal> goal "<q>: <a>"` |
| a decision for a unit | `S answer <goal> <unit> "<text>"` |
| widen a unit's scope | `S rescope <goal> <unit> "<scope>" "<why>"` |
| drop a unit | `S move <goal> <unit> dropped "<why>"` |

## Learning (row 13)

Write `.swarm/<goal>/learn.md` with two sections: `## zerg` (lessons about the swarm itself) and
`## project` (lessons about this codebase). Each proposal is a heading in the form `### Pn. <rule> (add|change|remove)`,
followed by the `log.md` lines that are its evidence. Write `none` under a section that has no proposals.

`S stage <goal> learned` routes each section:
- `project` goes to `.swarm/LEARNINGS.md`. That file is committed, so later goals in this repo read it.
- `zerg` goes to the user inbox. `S home` names it.

Apply nothing yourself.

## Reviewing lessons

When the human asks to review zerg lessons:

1. Run `S inbox`. If it's empty, say so and stop.
2. For each proposal, read it in the inbox file that `S home` names. Then recommend one action:
   - **Accept it as a rule** with `S accept <id> "<note>"`. Accepted rules go to the user's `rules.md`, which every goal reads.
   - **Accept it as a bound change** with `S config <key> <n>`, then `S accept <id> "<note>"`.
   - **Dismiss it** with `S dismiss <id> "<reason>"`. Use this for a proposal that needs a new script gate, which only a release can add, or for a proposal about one project.
3. Ask the human about each proposal. Run each command only after the human answers.

The user layer (`S home`) lives outside this skill, so lessons survive every update of the skill.

## Bounds

`S next` enforces these: 2 revisions per unit, a word-for-word repeat goes straight to stuck, 3 passes with no
progress, 20 passes in total, an optional `token_budget`, and `.swarm/STOP`. The user's `S config` can change
the first three.
