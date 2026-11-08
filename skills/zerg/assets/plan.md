# <goal> plan

| unit | task | scope | after | criteria | check | state | revisions | note |
|---|---|---|---|---|---|---|---|---|
| U-001 | one sentence | path/a.py | - | C1 | | planned | 0 | |
| U-002 | one sentence | path/b.py | U-001 | C1, C2 | | planned | 0 | |

States: planned, leased, produced, merged, stuck, dropped.
`scope` lists product files only, never tests. Scopes never overlap.
`check` is filled at stage 5 with the command that runs this unit's tests.
