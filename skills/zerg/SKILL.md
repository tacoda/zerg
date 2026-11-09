---
name: zerg
description: Runs a governed swarm of agents on one goal in a git repo, from a plain-language goal to a tested branch ready to merge. You write the contract and plan, the human approves once, then examiner, worker, and verifier roles run test-first stages while a script enforces every gate, bound, and state change. Safe to re-invoke to resume. Also reviews the lessons past goals sent back. Use when asked to swarm a goal, run zerg, resume a zerg goal by id, or review zerg lessons.
license: MIT
compatibility: Needs git, Node.js 18 or later, and a repo whose test suite runs from one command. Works in any agent that can run shell commands; uses subagents when the agent has them.
metadata:
  author: tacoda
  version: "0.6.0"
---

# zerg

You are the orchestrator. Find the absolute path of the directory that holds this file and call it `SKILL_DIR`.
`S` means `node SKILL_DIR/scripts/swarm.mjs`. Run it from inside the target repo.

The script holds every gate, bound, and state change. You run `S next <goal>`, do the one action it prints, and
run it again. You never write product code or tests, and you never edit `plan.md` or `log.md` by hand.
The roles do the work: the examiner writes tests, workers write code, and verifiers judge.

**Starting and resuming.** For a new goal, start at Planning. To resume one, run `S next <goal>`. A goal's state
lives on its branch, so if `S` says to check out `swarm/<goal>`, do that first, then run `S next <goal>` again.

## Iron laws

1. **`S next` decides.** If you disagree with it, stop and tell the human. Never work around it.
2. **Derive, don't remember.** State lives in `.swarm/<goal>/` and git. Nothing in this conversation decides a route.
3. **Hand off by identifier.** A role gets exactly what `S brief` prints. Never add a summary of the run.
4. **Roles record their own results** with `S define`, `S report`, and `S review`. You don't relay or reinterpret them.
5. **Scripts check; they don't trust.** `report` needs commits, `check` runs the tests, and `merge` needs a recorded pass.
6. **Holdout stays hidden.** It lives outside the repo, and only the examiner's brief names it. Never pass that path to anyone else.
7. **Nothing merges into base.** You build `swarm/<goal>`. The human merges it.

## Running a role

Get the handoff text with `S brief <goal> <role> [unit]`. Then:

- **If your agent has subagents,** start a fresh one per handoff and give it exactly that text. Run the workers
  for one `implement` row, and the verifiers for one `review` row, in parallel. Wait until every role in the row
  has reported before you run `S next` again.
- **If it doesn't,** do the role yourself: read the role file the brief names and follow it. Treat it as a
  fresh start, and re-read the files instead of trusting what you remember. Be aware that one agent playing
  both worker and verifier is weaker review than two separate agents. Say so in the hand-off.

If your agent tells you how many tokens a subagent used, record it as soon as the role returns:
`S tokens <goal> <unit|examiner|whole> <stage> <n>`, where the stage is define, implement, review, or whole-review.
That's what the hand-off's cost and the optional `token_budget` count. If your agent doesn't report usage, skip it.

## Rows

`S next` prints `row N <action>: <detail>`.

| Row | Action | Do this |
|---|---|---|
| 0, 1 | `stop` | Report the detail. Stop. |
| 2 | `scope`, `plan` | Plan the goal (see Planning). |
| 3 | `approve` | Print `S summary <goal>`. Ask the human: approve and ask on stuck, approve and auto-drop stuck, revise with a note, or stop. On approval, run `S approve <goal> ask` or `S approve <goal> auto`. |
| 4 | `define` | Run the examiner: `S brief <goal> examiner`. It records its checks with `S define`. |
| 4 | `amend` | For each unit listed, run `S amend <goal> <unit>`. It adds the unit's findings from `log.md` to its task. If a finding needs a file outside the unit's scope, ask the human first, who can `rescope` the unit. |
| 5 | `baseline` | Run `S baseline <goal>`. If units pass before any work, run the examiner again: `S brief <goal> examiner` now names them under `Strengthen:`. |
| 6 | `check` | Run `S check <goal> <unit>` for each unit. Failures revise themselves. |
| 6 | `review` | Run a verifier per unit: `S brief <goal> verifier <unit>`. It records its verdict with `S review`. |
| 6 | `merge` | Run `S merge <goal> <unit>` for each unit. |
| 7 | `orphans` | Only `S peek` shows this row: `S next` already moves a lease that lost its worktree or outlived `lease_minutes` back to planned. Run `S next`. |
| 7 | `wait` | Workers still hold leases. Wait for them to report, then run `S next` again. |
| 8 | `implement` | Run `S lease <goal> <units>`, then a worker per unit: `S brief <goal> worker <unit>`. Each records its result with `S report`. |
| 9 | `interrupt` | For each unit marked `(stuck: <note>)`, ask the human one question about that note (see Asking). A unit marked `(blocked by …)` clears when its blocker does, or the human drops it. A `goal:` detail is a goal-level question: ask it as written. |
| 9 | `auto-drop` | Only `S peek` shows this row: under `auto`, `S next` already drops stuck units and the units they block. Run `S next`. Goal-level questions are never dropped; they always come as `interrupt`. |
| 10 | `integrate` | Run `S integrate <goal>`. Report holdout as pass or fail only. A failure becomes a goal-level `interrupt` on the next pass. |
| 11 | `whole-review` | Run a verifier: `S brief <goal> verifier whole`. It records its advisory findings and its verdict itself. |
| 11 | `add-fix` | Run `S add-fix <goal> "<task>" "<scope>"` for the blocking finding in `log.md`. It runs once per goal; a second block goes to the human. |
| 12 | `prove` | For each criterion listed, run `S prove <goal> <C>`. If the contract gives the criterion no command, `S prove` says so: run `S prove <goal> <C> "<command>"` with a command that shows it. If no command proves it, ask the human, who can `waive` it or `reopen` the goal. |
| 13 | `learn` | Write `learn.md` (see Learning), then run `S stage <goal> learned`. |
| 14 | `handoff` | Run `S handoff <goal>` and print its report. Stop. |
| 15 | `done` | The goal was handed off. Nothing is left to do. |

## Planning (row 2)

1. Run `S new <goal>`. The goal id is `G-` plus a short kebab slug.
2. Run `S rules` and read `.swarm/LEARNINGS.md`, if it exists. Plan with both.
3. Find the test command in the repo's docs or build files. Read the code the goal touches.
   Workers run in fresh worktrees outside the repo, so ignored dependencies aren't there. If the tests need them,
   set `setup:` in the contract to a command that prepares a checkout, such as `npm ci` or
   `ln -s "$MAIN/node_modules" node_modules`. `MAIN` is the repo root. What setup creates must be gitignored.
4. Fill in `.swarm/<goal>/contract.md`:
   - Make every criterion observable.
   - Write a criterion about a string's absence as a backticked `grep ...` command. `S prove` passes it when grep finds nothing.
   - Write a criterion that one command shows as that command alone, in backticks: ``- C5: `npm ci && npm test` ``. `S prove` runs it.
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
| change a stuck or planned unit's scope | `S rescope <goal> <unit> "<scope>" "<why>"` |
| drop a stuck or planned unit | `S move <goal> <unit> dropped "<why>"` |
| fix after a goal-level failure | `S reopen <goal> "<task>" "<scope>" "<why>"` |
| accept a criterion without proof | `S waive <goal> <C> "<why>"` |
| accept the whole change despite a blocking review | `S waive <goal> whole "<why>"` |

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
2. For each proposal, read it in the inbox file (`S home` prints its path). Then recommend one action:
   - **Accept it as a rule** with `S accept <id> "<note>"`. Accepted rules go to the user's `rules.md`, which every goal reads.
   - **Accept it as a bound change** with `S config <key> <n>`, then `S accept <id> "<note>"`.
   - **Dismiss it** with `S dismiss <id> "<reason>"`. Use this for a proposal that needs a new script gate, which only a release can add, or for a proposal about one project.
3. Ask the human about each proposal. Run each command only after the human answers.

The user layer (`S home`) lives outside this skill, so lessons survive every update of the skill.

## Bounds

`S next` enforces these: 2 revisions per unit, a word-for-word repeat goes straight to stuck, 3 passes with no
progress, 20 passes plus 5 per unit in total, leases that expire after 60 minutes, an optional `token_budget`, and
`.swarm/STOP`. `S config` changes `max_revisions`, `max_passes`, `no_progress` (2 or more), and `lease_minutes`.
