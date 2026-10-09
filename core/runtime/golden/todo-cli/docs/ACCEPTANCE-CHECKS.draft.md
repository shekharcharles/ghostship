# Acceptance checks — todo

## Destination
A terminal to-do list kept in one JSON file.

## Checks
| # | check | kind | proven by | reference | source |
|---|---|---|---|---|---|
| C1 | `todo add "milk"` prints `added: milk` | run | tests/acceptance/C1-* | - | PRD#Add |
| C2 | `todo list` prints the items numbered from 1 | run | tests/acceptance/C2-* | - | PRD#List |
| C3 | `todo done 1` marks item 1 as `[x]` in the list | run | tests/acceptance/C3-* | - | PRD#Done |
| C4 | `todo list` with no items prints `nothing to do` | run | tests/acceptance/C4-* | - | PRD#List |
| C5 | `todo clear` empties the list | run | tests/acceptance/C5-* | - | PRD#Clear |

## Out of scope
1. Due dates
2. Sync between machines

## Unknowns
None identified — a single-user local file.
