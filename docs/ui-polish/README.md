# UI polish: review-round score history

Every row is one complete council review of the running app (2× screenshots of the Electron build,
light and dark), compared against the original UI and four reference apps (T3 Code, Claude desktop,
ChatGPT/Codex, a multi-bot "grok bot" app). Rounds 1–12 were Codex (gpt-6.1-sol, high) alone; once
Codex rated every category 9+, Opus (claude-opus-5-5) joined in round 13; rounds 19–20 had both review
the same build. The two reviewers are calibrated differently (Opus scores the references about 0.3–0.6
lower than Codex does), so compare rows within a reviewer.

Categories: Ty typography · Hi hierarchy · Sp spacing · Ra radii · Ic iconography · Co color · Cn contrast · Cs consistency

## The redesign, round by round

| Round | Reviewer | Overall | Ty | Hi | Sp | Ra | Ic | Co | Cn | Cs |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Codex | 7.2 | 7.6 | 6.8 | 7.0 | 7.7 | 7.0 | 7.7 | 6.3 | 7.4 |
| 2 | Codex | 8.0 | 8.5 | 7.6 | 7.5 | 8.3 | 7.8 | 8.2 | 8.0 | 8.2 |
| 3 | Codex | 8.4 | 8.6 | 8.3 | 8.0 | 8.6 | 8.2 | 8.6 | 8.3 | 8.5 |
| 4 | Codex | 8.6 | 8.6 | 8.5 | 8.2 | 9.0 | 8.5 | 8.8 | 8.6 | 8.7 |
| 5 | Codex | 8.7 | 8.8 | 8.8 | 8.5 | 9.0 | 8.5 | 8.9 | 8.8 | 8.6 |
| 6 | Codex | 8.8 | 8.9 | 8.8 | 8.7 | 9.0 | 8.6 | 8.9 | 8.8 | 8.8 |
| 7 | Codex | 8.8 | 8.9 | 8.7 | 8.8 | 9.1 | 8.7 | 8.9 | 8.8 | 8.9 |
| 8 | Codex | 8.7 | 8.8 | 8.7 | 8.8 | 9.1 | 9.0 | 8.7 | 8.8 | 8.6 |
| 9 | Codex | 8.7 | 8.8 | 8.7 | 8.6 | 9.1 | 9.0 | 8.8 | 8.8 | 8.7 |
| 10 | Codex | 8.8 | 8.9 | 8.8 | 8.9 | 9.1 | 8.9 | 8.8 | 8.8 | 8.8 |
| 11 | Codex | 8.8 | 8.9 | 8.7 | 8.9 | 9.1 | 8.7 | 8.9 | 8.8 | 8.9 |
| 12 | Codex | 9.0 | 9.1 | 9.0 | 9.1 | 9.2 | 9.0 | 9.1 | 9.0 | 9.0 |
| 13 | Opus | 8.1 | 8.4 | 7.8 | 8.0 | 8.3 | 7.2 | 8.3 | 8.3 | 7.7 |
| 14 | Opus | 8.5 | 8.6 | 8.3 | 8.3 | 8.8 | 7.8 | 8.6 | 8.6 | 8.2 |
| 15 | Opus | 8.6 | 8.8 | 8.4 | 8.4 | 8.9 | 8.0 | 8.6 | 8.7 | 8.3 |
| 16 | Opus | 8.7 | 8.9 | 8.5 | 8.6 | 8.9 | 8.2 | 8.6 | 8.8 | 8.4 |
| 17 | Opus | 8.9 | 9.0 | 8.9 | 8.8 | 9.0 | 8.5 | 8.7 | 9.0 | 8.9 |
| 18 | Opus | 9.0 | 9.1 | 9.0 | 8.9 | 9.0 | 8.6 | 8.8 | 9.1 | 9.0 |
| 19 | Opus | 9.0 | 9.1 | 9.0 | 9.0 | 9.0 | 8.8 | 9.0 | 9.1 | 9.0 |
| 19 | Codex | 8.9 | 9.1 | 8.6 | 9.1 | 9.1 | 9.0 | 9.1 | 9.0 | 9.0 |
| 20 | Opus | 9.0 | 9.1 | 9.0 | 9.0 | 9.1 | 9.0 | 9.0 | 9.1 | 8.8 |
| 20 | Codex | 8.9 | 9.1 | 8.9 | 9.1 | 9.1 | 9.0 | 9.1 | 8.9 | 9.0 |

## Final round (20): every version

| Version | Codex overall | Opus overall |
|---|---:|---:|
| **Top redesign** | **8.9** (all ≥ 9.0 except hierarchy 8.9, contrast 8.9) | **9.0** (all ≥ 9.0 except consistency 8.8) |
| grok bot | 8.6 | 8.1 |
| ChatGPT / Codex | 8.1 | 7.8 |
| T3 Code | 8.2 | 7.6 |
| Claude desktop | 8.4 | 7.2 |
| Top original | 6.2 | 5.7 |

The three sub-9 items from round 20 (keyboard access to message times, light code-comment contrast at
4.3:1, and the "Running" dot sharing blue with the unread dot) were fixed afterwards: focusable `<time>`
elements, `#706d65` comments (4.7:1), and a spinning arc for Running. That build was not re-scored.

## Every version, every round

| Round | Reviewer | Version | Overall | Ty | Hi | Sp | Ra | Ic | Co | Cn | Cs |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Codex | Top redesign | 7.2 | 7.6 | 6.8 | 7.0 | 7.7 | 7.0 | 7.7 | 6.3 | 7.4 |
| 1 | Codex | Top original | 5.6 | 6.4 | 5.5 | 5.6 | 6.3 | 4.5 | 4.7 | 5.5 | 6.3 |
| 1 | Codex | grok bot | 8.3 | 8.1 | 8.5 | 8.3 | 8.3 | 8.6 | 8.7 | 7.8 | 8.2 |
| 1 | Codex | T3 Code | 8.0 | 8.0 | 8.1 | 8.2 | 8.3 | 8.2 | 7.7 | 7.4 | 8.2 |
| 1 | Codex | ChatGPT | 7.8 | 7.9 | 8.0 | 8.0 | 8.2 | 8.2 | 6.8 | 7.4 | 8.3 |
| 1 | Codex | Claude desktop | 7.6 | 7.8 | 7.3 | 7.4 | 8.0 | 8.2 | 6.6 | 7.7 | 8.2 |
| 2 | Codex | Top redesign | 8.0 | 8.5 | 7.6 | 7.5 | 8.3 | 7.8 | 8.2 | 8.0 | 8.2 |
| 2 | Codex | Top original | 6.1 | 6.7 | 5.9 | 5.8 | 6.4 | 5.4 | 5.8 | 6.2 | 6.4 |
| 2 | Codex | grok bot | 8.4 | 8.2 | 8.6 | 8.5 | 8.5 | 8.6 | 8.7 | 8.2 | 8.5 |
| 2 | Codex | T3 Code | 8.1 | 8.3 | 8.3 | 8.3 | 8.4 | 8.1 | 7.9 | 7.6 | 8.3 |
| 2 | Codex | ChatGPT | 7.9 | 8.2 | 8.0 | 8.0 | 8.4 | 8.1 | 7.2 | 7.5 | 8.3 |
| 2 | Codex | Claude desktop | 7.7 | 7.9 | 7.8 | 7.7 | 8.0 | 8.0 | 6.9 | 7.8 | 8.0 |
| 3 | Codex | Top redesign | 8.4 | 8.6 | 8.3 | 8.0 | 8.6 | 8.2 | 8.6 | 8.3 | 8.5 |
| 3 | Codex | Top original | 6.3 | 6.8 | 6.1 | 6.2 | 6.7 | 5.4 | 5.8 | 6.3 | 6.5 |
| 3 | Codex | grok bot | 8.6 | 8.5 | 8.8 | 8.7 | 8.7 | 8.6 | 8.8 | 8.4 | 8.6 |
| 3 | Codex | T3 Code | 8.1 | 8.4 | 8.2 | 8.3 | 8.4 | 8.1 | 7.7 | 7.6 | 8.2 |
| 3 | Codex | ChatGPT | 8.0 | 8.3 | 8.1 | 8.0 | 8.5 | 8.2 | 7.2 | 7.7 | 8.3 |
| 3 | Codex | Claude desktop | 7.8 | 8.0 | 7.7 | 7.6 | 8.2 | 8.0 | 7.0 | 8.0 | 8.0 |
| 4 | Codex | Top redesign | 8.6 | 8.6 | 8.5 | 8.2 | 9.0 | 8.5 | 8.8 | 8.6 | 8.7 |
| 4 | Codex | Top original | 6.2 | 6.5 | 6.1 | 5.9 | 6.6 | 5.5 | 5.9 | 6.4 | 6.6 |
| 4 | Codex | grok bot | 8.7 | 8.6 | 8.8 | 8.9 | 8.8 | 8.7 | 9.0 | 8.4 | 8.6 |
| 4 | Codex | T3 Code | 8.1 | 8.3 | 8.1 | 8.2 | 8.4 | 8.2 | 8.2 | 7.8 | 8.1 |
| 4 | Codex | ChatGPT | 8.0 | 8.3 | 8.1 | 8.2 | 8.4 | 8.2 | 7.0 | 7.6 | 8.4 |
| 4 | Codex | Claude desktop | 7.8 | 8.0 | 7.7 | 7.6 | 8.0 | 8.0 | 7.0 | 7.8 | 8.1 |
| 5 | Codex | Top redesign | 8.7 | 8.8 | 8.8 | 8.5 | 9.0 | 8.5 | 8.9 | 8.8 | 8.6 |
| 5 | Codex | Top original | 6.3 | 6.7 | 6.2 | 6.1 | 6.7 | 5.7 | 6.0 | 6.0 | 6.5 |
| 5 | Codex | grok bot | 8.6 | 8.5 | 8.8 | 8.8 | 8.9 | 8.8 | 8.7 | 8.3 | 8.7 |
| 5 | Codex | T3 Code | 8.1 | 8.3 | 8.2 | 8.2 | 8.5 | 8.2 | 7.8 | 7.7 | 8.1 |
| 5 | Codex | ChatGPT | 8.0 | 8.2 | 8.0 | 8.0 | 8.6 | 8.3 | 7.4 | 7.5 | 8.3 |
| 5 | Codex | Claude desktop | 7.8 | 8.0 | 7.7 | 7.8 | 8.2 | 8.2 | 7.2 | 7.7 | 7.9 |
| 6 | Codex | Top redesign | 8.8 | 8.9 | 8.8 | 8.7 | 9.0 | 8.6 | 8.9 | 8.8 | 8.8 |
| 6 | Codex | Top original | 6.4 | 6.8 | 6.6 | 6.1 | 6.7 | 5.7 | 5.8 | 6.7 | 6.7 |
| 6 | Codex | grok bot | 8.6 | 8.5 | 8.7 | 8.7 | 8.8 | 8.8 | 8.8 | 8.4 | 8.6 |
| 6 | Codex | T3 Code | 8.1 | 8.3 | 8.2 | 8.3 | 8.5 | 8.1 | 7.7 | 7.8 | 8.2 |
| 6 | Codex | ChatGPT | 8.0 | 8.3 | 8.0 | 7.9 | 8.5 | 8.2 | 7.2 | 7.7 | 8.3 |
| 6 | Codex | Claude desktop | 7.8 | 8.0 | 7.7 | 7.6 | 8.2 | 8.1 | 7.0 | 7.8 | 8.1 |
| 7 | Codex | Top redesign | 8.8 | 8.9 | 8.7 | 8.8 | 9.1 | 8.7 | 8.9 | 8.8 | 8.9 |
| 7 | Codex | Top original | 6.3 | 6.7 | 6.2 | 6.1 | 6.7 | 5.2 | 5.8 | 6.4 | 6.8 |
| 7 | Codex | grok bot | 8.5 | 8.5 | 8.7 | 8.6 | 8.8 | 9.0 | 8.9 | 8.0 | 8.6 |
| 7 | Codex | T3 Code | 8.1 | 8.4 | 8.1 | 8.3 | 8.7 | 8.2 | 7.7 | 7.8 | 8.2 |
| 7 | Codex | ChatGPT | 8.0 | 8.3 | 8.1 | 8.1 | 8.6 | 8.2 | 7.2 | 7.6 | 8.3 |
| 7 | Codex | Claude desktop | 7.8 | 8.0 | 7.6 | 7.8 | 8.4 | 8.1 | 7.1 | 7.8 | 8.0 |
| 8 | Codex | Top redesign | 8.7 | 8.8 | 8.7 | 8.8 | 9.1 | 9.0 | 8.7 | 8.8 | 8.6 |
| 8 | Codex | Top original | 6.3 | 6.8 | 6.1 | 6.3 | 6.6 | 5.8 | 6.0 | 5.9 | 6.6 |
| 8 | Codex | grok bot | 8.4 | 8.3 | 8.6 | 8.5 | 8.7 | 8.7 | 8.8 | 8.1 | 8.4 |
| 8 | Codex | T3 Code | 8.1 | 8.3 | 8.0 | 8.2 | 8.6 | 8.2 | 7.9 | 7.7 | 8.2 |
| 8 | Codex | ChatGPT | 8.0 | 8.3 | 8.1 | 8.0 | 8.7 | 8.3 | 7.2 | 7.6 | 8.1 |
| 8 | Codex | Claude desktop | 7.8 | 8.1 | 7.5 | 7.8 | 8.4 | 8.1 | 7.1 | 7.9 | 7.8 |
| 9 | Codex | Top redesign | 8.7 | 8.8 | 8.7 | 8.6 | 9.1 | 9.0 | 8.8 | 8.8 | 8.7 |
| 9 | Codex | Top original | 6.2 | 6.7 | 6.2 | 6.0 | 6.8 | 5.5 | 5.8 | 6.3 | 6.3 |
| 9 | Codex | grok bot | 8.5 | 8.3 | 8.7 | 8.5 | 8.8 | 8.7 | 8.8 | 8.4 | 8.5 |
| 9 | Codex | T3 Code | 8.2 | 8.4 | 8.1 | 8.3 | 8.6 | 8.5 | 7.7 | 7.9 | 8.1 |
| 9 | Codex | ChatGPT | 8.0 | 8.3 | 8.2 | 8.1 | 8.7 | 8.4 | 7.1 | 7.6 | 8.1 |
| 9 | Codex | Claude desktop | 7.8 | 8.0 | 7.6 | 7.7 | 8.4 | 8.5 | 7.0 | 8.0 | 7.8 |
| 10 | Codex | Top redesign | 8.8 | 8.9 | 8.8 | 8.9 | 9.1 | 8.9 | 8.8 | 8.8 | 8.8 |
| 10 | Codex | Top original | 6.3 | 6.7 | 6.2 | 6.3 | 6.5 | 5.8 | 6.0 | 6.0 | 6.5 |
| 10 | Codex | grok bot | 8.5 | 8.4 | 8.7 | 8.6 | 8.7 | 8.8 | 8.9 | 8.3 | 8.5 |
| 10 | Codex | T3 Code | 8.2 | 8.5 | 8.2 | 8.4 | 8.6 | 8.3 | 7.9 | 7.8 | 8.2 |
| 10 | Codex | ChatGPT | 8.0 | 8.3 | 8.0 | 8.1 | 8.6 | 8.3 | 7.2 | 7.6 | 8.2 |
| 10 | Codex | Claude desktop | 7.8 | 8.0 | 7.6 | 7.7 | 8.3 | 8.2 | 7.1 | 7.8 | 8.0 |
| 11 | Codex | Top redesign | 8.8 | 8.9 | 8.7 | 8.9 | 9.1 | 8.7 | 8.9 | 8.8 | 8.9 |
| 11 | Codex | Top original | 6.3 | 6.8 | 6.2 | 6.5 | 6.7 | 5.3 | 5.9 | 6.1 | 6.5 |
| 11 | Codex | grok bot | 8.5 | 8.4 | 8.7 | 8.6 | 8.8 | 8.7 | 8.8 | 8.2 | 8.5 |
| 11 | Codex | T3 Code | 8.2 | 8.5 | 8.2 | 8.4 | 8.7 | 8.2 | 7.9 | 7.8 | 8.2 |
| 11 | Codex | ChatGPT | 8.0 | 8.3 | 8.0 | 8.2 | 8.7 | 8.2 | 7.2 | 7.7 | 8.0 |
| 11 | Codex | Claude desktop | 7.8 | 8.0 | 7.7 | 7.8 | 8.3 | 8.1 | 7.1 | 7.7 | 7.9 |
| 12 | Codex | Top redesign | 9.0 | 9.1 | 9.0 | 9.1 | 9.2 | 9.0 | 9.1 | 9.0 | 9.0 |
| 12 | Codex | Top original | 6.3 | 6.6 | 6.2 | 6.3 | 6.5 | 5.7 | 6.0 | 6.2 | 6.6 |
| 12 | Codex | grok bot | 8.5 | 8.4 | 8.7 | 8.5 | 8.6 | 8.5 | 8.9 | 8.5 | 8.4 |
| 12 | Codex | T3 Code | 8.2 | 8.4 | 8.2 | 8.4 | 8.5 | 8.1 | 7.9 | 7.9 | 8.2 |
| 12 | Codex | ChatGPT | 8.1 | 8.3 | 8.1 | 8.3 | 8.6 | 8.2 | 7.5 | 7.8 | 8.2 |
| 12 | Codex | Claude desktop | 7.9 | 8.0 | 7.7 | 8.1 | 8.3 | 8.1 | 7.3 | 7.9 | 7.9 |
| 13 | Opus | Top redesign | 8.1 | 8.4 | 7.8 | 8.0 | 8.3 | 7.2 | 8.3 | 8.3 | 7.7 |
| 13 | Opus | Top original | 5.4 | 5.0 | 5.6 | 6.0 | 6.2 | 4.8 | 5.6 | 6.2 | 5.2 |
| 13 | Opus | grok bot | 7.9 | 7.8 | 7.9 | 7.8 | 8.4 | 7.6 | 8.6 | 7.6 | 8.0 |
| 13 | Opus | T3 Code | 7.5 | 7.6 | 7.4 | 7.6 | 7.8 | 7.4 | 7.2 | 7.8 | 7.4 |
| 13 | Opus | ChatGPT | 7.3 | 7.4 | 7.3 | 7.5 | 7.8 | 7.3 | 6.4 | 7.6 | 7.6 |
| 13 | Opus | Claude desktop | 7.0 | 7.0 | 6.8 | 7.2 | 7.5 | 7.4 | 6.6 | 7.6 | 6.8 |
| 14 | Opus | Top redesign | 8.5 | 8.6 | 8.3 | 8.3 | 8.8 | 7.8 | 8.6 | 8.6 | 8.2 |
| 14 | Opus | Top original | 5.4 | 5.2 | 5.3 | 5.8 | 6.4 | 4.6 | 5.6 | 5.6 | 5.2 |
| 14 | Opus | grok bot | 7.9 | 8.0 | 7.8 | 7.9 | 8.5 | 7.6 | 8.3 | 7.6 | 8.0 |
| 14 | Opus | T3 Code | 7.5 | 7.6 | 7.2 | 7.4 | 7.8 | 7.6 | 7.3 | 7.6 | 7.4 |
| 14 | Opus | ChatGPT | 7.3 | 7.4 | 7.0 | 7.3 | 7.8 | 7.5 | 6.6 | 7.4 | 7.4 |
| 14 | Opus | Claude desktop | 7.0 | 7.2 | 6.6 | 6.8 | 7.6 | 7.4 | 6.8 | 7.4 | 6.8 |
| 15 | Opus | Top redesign | 8.6 | 8.8 | 8.4 | 8.4 | 8.9 | 8.0 | 8.6 | 8.7 | 8.3 |
| 15 | Opus | Top original | 5.4 | 5.6 | 5.4 | 5.6 | 5.8 | 4.8 | 5.3 | 6.0 | 5.2 |
| 15 | Opus | grok bot | 7.9 | 7.8 | 8.0 | 7.9 | 8.2 | 8.2 | 8.4 | 7.6 | 7.8 |
| 15 | Opus | T3 Code | 7.5 | 7.6 | 7.4 | 7.3 | 7.6 | 7.6 | 7.0 | 7.8 | 7.4 |
| 15 | Opus | ChatGPT | 7.3 | 7.4 | 7.3 | 7.2 | 7.6 | 7.5 | 6.6 | 7.4 | 7.3 |
| 15 | Opus | Claude desktop | 7.0 | 7.0 | 6.8 | 6.8 | 7.3 | 7.2 | 6.7 | 7.4 | 6.9 |
| 16 | Opus | Top redesign | 8.7 | 8.9 | 8.5 | 8.6 | 8.9 | 8.2 | 8.6 | 8.8 | 8.4 |
| 16 | Opus | Top original | 5.4 | 5.0 | 5.5 | 5.8 | 6.0 | 4.8 | 5.5 | 6.2 | 5.2 |
| 16 | Opus | grok bot | 7.9 | 8.0 | 8.0 | 7.8 | 8.3 | 7.8 | 8.5 | 7.8 | 7.8 |
| 16 | Opus | T3 Code | 7.5 | 7.6 | 7.5 | 7.5 | 7.8 | 7.3 | 7.0 | 7.8 | 7.3 |
| 16 | Opus | ChatGPT | 7.3 | 7.5 | 7.0 | 7.3 | 7.6 | 7.4 | 6.6 | 7.6 | 7.2 |
| 16 | Opus | Claude desktop | 7.0 | 7.2 | 6.6 | 6.8 | 7.4 | 7.0 | 6.8 | 7.6 | 6.8 |
| 17 | Opus | Top redesign | 8.9 | 9.0 | 8.9 | 8.8 | 9.0 | 8.5 | 8.7 | 9.0 | 8.9 |
| 17 | Opus | Top original | 5.4 | 5.6 | 5.2 | 5.6 | 6.0 | 4.8 | 5.4 | 5.8 | 5.0 |
| 17 | Opus | grok bot | 7.9 | 8.0 | 8.0 | 7.9 | 8.2 | 8.3 | 8.2 | 7.6 | 7.8 |
| 17 | Opus | T3 Code | 7.5 | 7.6 | 7.4 | 7.6 | 7.6 | 7.4 | 7.0 | 7.6 | 7.4 |
| 17 | Opus | ChatGPT | 7.3 | 7.4 | 7.2 | 7.3 | 7.6 | 7.4 | 6.6 | 7.4 | 7.3 |
| 17 | Opus | Claude desktop | 7.0 | 7.2 | 6.8 | 6.6 | 7.3 | 7.0 | 6.8 | 7.2 | 7.0 |
| 18 | Opus | Top redesign | 9.0 | 9.1 | 9.0 | 8.9 | 9.0 | 8.6 | 8.8 | 9.1 | 9.0 |
| 18 | Opus | Top original | 5.4 | 5.0 | 5.5 | 5.8 | 6.0 | 4.8 | 5.5 | 6.0 | 5.3 |
| 18 | Opus | grok bot | 7.9 | 7.8 | 7.9 | 8.0 | 8.3 | 8.2 | 8.4 | 7.6 | 7.9 |
| 18 | Opus | T3 Code | 7.5 | 7.7 | 7.3 | 7.5 | 7.8 | 7.4 | 7.0 | 7.8 | 7.4 |
| 18 | Opus | ChatGPT | 7.3 | 7.5 | 7.0 | 7.3 | 7.7 | 7.3 | 6.6 | 7.6 | 7.4 |
| 18 | Opus | Claude desktop | 7.0 | 7.3 | 6.6 | 6.8 | 7.4 | 7.2 | 6.8 | 7.6 | 7.0 |
| 19 | Opus | Top redesign | 9.0 | 9.1 | 9.0 | 9.0 | 9.0 | 8.8 | 9.0 | 9.1 | 9.0 |
| 19 | Opus | Top original | 6.3 | 6.0 | 6.3 | 6.8 | 7.0 | 5.0 | 5.8 | 7.0 | 6.3 |
| 19 | Opus | grok bot | 8.3 | 8.3 | 8.4 | 8.4 | 8.6 | 7.6 | 8.8 | 8.2 | 8.2 |
| 19 | Opus | T3 Code | 8.2 | 8.4 | 8.2 | 8.3 | 8.4 | 8.4 | 7.6 | 8.4 | 8.2 |
| 19 | Opus | ChatGPT | 8.3 | 8.5 | 8.3 | 8.3 | 8.5 | 8.5 | 7.3 | 8.3 | 8.4 |
| 19 | Opus | Claude desktop | 8.0 | 8.2 | 7.8 | 7.9 | 8.2 | 8.3 | 7.2 | 8.4 | 8.0 |
| 19 | Codex | Top redesign | 8.9 | 9.1 | 8.6 | 9.1 | 9.1 | 9.0 | 9.1 | 9.0 | 9.0 |
| 19 | Codex | Top original | 6.8 | 7.3 | 6.5 | 6.5 | 7.0 | 6.5 | 6.2 | 6.7 | 6.8 |
| 19 | Codex | grok bot | 8.6 | 8.5 | 8.8 | 8.6 | 8.7 | 8.3 | 9.2 | 8.5 | 8.6 |
| 19 | Codex | T3 Code | 8.2 | 8.5 | 8.1 | 8.3 | 8.7 | 8.1 | 8.2 | 7.9 | 8.3 |
| 19 | Codex | ChatGPT | 8.7 | 9.0 | 8.7 | 8.9 | 9.0 | 8.8 | 8.2 | 8.4 | 8.8 |
| 19 | Codex | Claude desktop | 8.4 | 8.7 | 8.3 | 8.7 | 8.8 | 8.6 | 7.8 | 8.3 | 8.6 |
| 20 | Opus | Top redesign | 9.0 | 9.1 | 9.0 | 9.0 | 9.1 | 9.0 | 9.0 | 9.1 | 8.8 |
| 20 | Opus | Top original | 5.7 | 5.5 | 5.8 | 6.0 | 6.2 | 4.8 | 5.0 | 6.5 | 5.8 |
| 20 | Opus | grok bot | 8.1 | 8.0 | 8.2 | 8.0 | 8.4 | 7.8 | 8.6 | 7.8 | 8.0 |
| 20 | Opus | T3 Code | 7.6 | 7.8 | 7.4 | 7.6 | 7.8 | 7.6 | 7.0 | 8.0 | 7.5 |
| 20 | Opus | ChatGPT | 7.8 | 8.0 | 7.8 | 7.8 | 8.0 | 8.0 | 6.8 | 8.0 | 8.0 |
| 20 | Opus | Claude desktop | 7.2 | 7.6 | 6.8 | 7.0 | 7.6 | 7.4 | 6.4 | 7.8 | 7.2 |
| 20 | Codex | Top redesign | 8.9 | 9.1 | 8.9 | 9.1 | 9.1 | 9.0 | 9.1 | 8.9 | 9.0 |
| 20 | Codex | Top original | 6.2 | 6.8 | 6.0 | 5.8 | 6.5 | 5.6 | 5.6 | 6.6 | 6.4 |
| 20 | Codex | grok bot | 8.6 | 8.6 | 8.7 | 8.7 | 8.6 | 8.5 | 9.0 | 8.5 | 8.7 |
| 20 | Codex | T3 Code | 8.2 | 8.4 | 8.1 | 8.2 | 8.7 | 8.4 | 7.9 | 7.9 | 8.2 |
| 20 | Codex | ChatGPT | 8.1 | 8.4 | 8.0 | 8.3 | 8.7 | 8.4 | 7.2 | 7.7 | 8.3 |
| 20 | Codex | Claude desktop | 8.4 | 8.6 | 8.4 | 8.4 | 8.8 | 8.7 | 7.5 | 8.4 | 8.8 |
