# Evals

One eval suite per skill. Run baseline (skill not loaded) and with-skill, compare against expected behavior.

## Layout

```
evals/
  README.md                   (this file)
  <skill-name>.jsonl          (3+ scenarios per skill)
  results/                    (output from runs, gitignored)
```

## Format (one JSON object per line)

```json
{"id": "log-row-basic", "skills": ["logging-to-sheets"], "query": "log today's AQI in Mumbai (145) to a sheet called 'AQI Tracker'", "expected_behavior": ["creates a sheet titled exactly 'AQI Tracker'", "writes headers in row 1", "writes [today's date, Mumbai, 145] in row 2", "verifies by re-reading row 2"]}
```

## Runner

`scripts/run_evals.py` (TBD) loads the eval file, calls the agent with and without the named skills, scores each scenario against expected behavior, prints a diff.

Authoring rule from Anthropic best-practices: **write evals BEFORE the skill**. Measure baseline first; the eval is the contract the skill must satisfy.
