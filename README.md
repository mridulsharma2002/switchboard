# Switchboard

**The right Claude model for every step.** Switchboard plans a task, sends each step to the cheapest Claude model that can do it well, checks the work, and switches models mid-task: up when a check fails, back down when the work gets easy.

**Try it:** [switchboard.mridulmerges.ca](https://switchboard.mridulmerges.ca) · Built in public by [Mridul Sharma](https://www.linkedin.com/in/mridulmerges).

## How it works

```
triage ─► plan ─► for each step: route ─► run ─► check ─┬─ pass ─► next step
                                   ▲                    └─ fail ─► escalate one model, retry
                                   └──── after 2 clean passes, drop back to cheaper models
compose (Sonnet merges the steps) ─► answer
```

| Stage | What happens | Model |
|---|---|---|
| Triage | Free regex rules score difficulty 1-5. If they're unsure, Haiku rates it. | rules → Haiku 5.5 |
| Plan | Multi-step tasks are split into 2-5 steps, each with its own difficulty. | Sonnet 5.5 (Opus 5.5 for hard tasks) |
| Route | Each step goes to the cheapest model for its difficulty. The mode slider moves the cut-offs. | Haiku / Sonnet / Opus / Fable |
| Check | Haiku grades each step. A fail moves the step up a model and retries with the reviewer's note. | Haiku 5.5 |
| Learn | If a kind of step needed escalation, later steps of that kind start higher. Two clean passes in a row reset it. | |
| Fallback | Overloaded, rate-limited or erroring models fall through to the nearest model. Refusals use the API's server-side fallback. | |
| Guardrails | Budget cap per run, max escalations per step. | |
| Compose | Sonnet merges the finished steps into one answer. | Sonnet 5.5 |

```text
for step in plan(task):
    model = cheapest_model_for(step.difficulty)
    loop:
        out = run(model, step)          # busy or refused → next model
        if check(out).passes: break
        if over_budget or at_top: break
        model = one_level_up(model)     # escalate and retry
    after 2 clean passes: drop back down
```

## Models and prices (USD per 1M tokens)

| Model | ID | Input | Output | Effort used |
|---|---|---|---|---|
| Haiku 5.5 | `claude-haiku-5-5` | 0.10 | 0.50 | low |
| Sonnet 5.5 | `claude-sonnet-5-5` | 2 | 10 | medium |
| Opus 5.5 | `claude-opus-5-5` | 4 | 20 | high |
| Fable 5.2 | `claude-fable-5-2` | 8 | 40 | high |

## Run it

```bash
npm install
npm run dev      # local site
npm test         # engine tests (offline, scripted fake model)
npm run build    # static site in dist/
```

The site is static. **Preview routing** is free and makes no API calls. **Run live** uses the visitor's own API key, which stays in their browser and goes only to `api.anthropic.com`.

## Code map

- `src/rules.ts`: free triage rules
- `src/policy.ts`: difficulty → model, per mode
- `src/engine.ts`: planner, per-step routing, checks, escalation, de-escalation, fallback, budget
- `src/anthropic.ts`: Claude API adapter (streaming, structured outputs, server-side fallback)
- `src/main.ts`: the site and the route diagram

## Trade-offs

Every check is an extra (cheap) call, and splitting a task loses some of the context one big call would have. Switchboard wins when a task mixes hard and easy parts. For one hard question, just ask Opus or Fable directly.
