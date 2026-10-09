# Test plan
<!-- ghostship:todo — replace every line marked TODO, then delete this comment -->

## Levels
| level | where | runs in | proves |
|---|---|---|---|
| Unit | TODO | every task (red → green) | each function's behaviour |
| Acceptance | `tests/acceptance/C*-*` | every task and every release | the approved checks (locked after STOP 1) |
| Regression | full suite | before every merge and release | nothing else broke |

## Non-functional
TODO: performance, accessibility, security tests and their thresholds from the PRD.

## Reports
Release packets in `docs/10-releases/` list the evidence for each check.
