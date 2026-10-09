export const CHECKS = `# Acceptance checks — login

## Rules for the judge
1. Grade only the checks below. Binary: PASS or FAIL with one line of reason.

## Destination
Users can sign in with email and password.

## Checks
| # | check | kind | proven by | reference | source |
|---|---|---|---|---|---|
| C1 | Wrong password returns 401 within 300 ms | run | tests/acceptance/C1-* | - | PRD#login |
| C2 | Five wrong passwords lock the account for 15 min | run | tests/acceptance/C2-* | - | PRD#lockout |
| C3 | Login page matches mock B at 390 px | pick | owner compares | mocks/login-b.png | PRD#ui |

## Out of scope
1. Password reset — later

## Unknowns
- U1: Lockout threshold — owner: Charles, by: 2026-10-20, blocks: C2
`;

export const PRD_TEXT = '# PRD — demo\n\n## Vision\nA demo.\n';
