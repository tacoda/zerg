# <goal>: <title>

base: <filled by swarm.py new>
test: <command that runs the full suite>
max_parallel: 3
token_budget:

## Outcome
What is true when this goal is done, in one or two sentences.

## Why
The reason, so a worker can choose well when the contract runs out.

## Non-goals
- What no unit may change or add.

## Constraints
- Behavior that must hold, including edge cases nobody will write a unit test for.

## Criteria
- C1: an observable result a test or command can show

## Escalate when
- A constraint can't be met inside a unit's scope.
- Two readings of the goal lead to different code.

## Decisions
