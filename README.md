# Clinical Cases

[![CI](https://github.com/NKolosov097/eximion/actions/workflows/verify.yaml/badge.svg)](https://github.com/NKolosov097/eximion/actions/workflows/verify.yaml)
[![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688)](backend)
[![Next.js](https://img.shields.io/badge/frontend-Next.js%2016-000000)](frontend)
[![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL%2017-336791)](compose.yaml)

A small educational clinical-case application built as a test assignment for Eximion: a learner reads a synthetic clinical vignette, submits a diagnosis, and gets deterministic, exact-match feedback. Cases are authored from free text with Gemini-assisted structured extraction, then reviewed by a human before publication.

> **Synthetic data only. This is not a medical diagnostic system.**

## Contents

- [Live application](#live-application)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Development checks](#development-checks)
- [Browser regression checks](#browser-regression-checks)
- [Accounts and personal history](#accounts-and-personal-history)
- [Assignment assumptions](#assignment-assumptions)
- [Documentation](#documentation)

## Live application

| | |
| --- | --- |
| App | https://eximion-frontend-497115726994.europe-west3.run.app |
| API docs | https://eximion-backend-497115726994.europe-west3.run.app/docs |

All three seeded demo cases can be solved without an author key. The home-page demo link opens the original fever-and-cough case. Creating cases, running Gemini extraction, and viewing private Analytics require the author key, which is kept out of source control. Both services and PostgreSQL run in Frankfurt (`europe-west3`); Gemini uses the EU endpoint. See the [deployment metadata](docs/deployment.json) and [verification record](docs/progress.md) for what has actually been checked live.

## How it works

1. **Author** pastes synthetic clinical text on *Create case* and runs extraction. Gemini returns a structured draft that the author edits and reviews, removing anything that would reveal the diagnosis.
2. The author independently supplies the **reference diagnosis** and any accepted variants — the model never grades its own output.
3. **Learners** browse the catalog, open a case, and submit a primary diagnosis plus optional alternatives. Grading is deterministic exact-match against the hidden reference and variants (0 or 100), never an LLM judgment call.
4. After submitting, the learner sees the accepted answer set; unmatched alternatives are shown as unassessed, never as incorrect.

Signed-in users get a profile with answer history and authored cases; guests can still answer after acknowledging the attempt won't be attached to an account. See [Accounts](#accounts-and-personal-history) below.

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | FastAPI, SQLAlchemy 2, Alembic, Pydantic, Python 3.12 |
| Frontend | Next.js 16 (App Router, Server Components), React 19, TypeScript |
| Database | PostgreSQL 17 |
| LLM extraction | Gemini via Vertex AI (`google-genai`), structured output validated with Pydantic |
| Contract | OpenAPI generated from Pydantic, TypeScript types generated from OpenAPI — CI fails on drift |
| Observability | OpenTelemetry → Cloud Trace, structured JSON logs |
| Deployment | Docker, Cloud Run, Cloud SQL |
| Testing | pytest (unit + integration), mypy, Vitest, Playwright, pixel-diff screenshot regression |

## Project structure

```
backend/
  app/            API routes, persistence, deterministic grading, Gemini extraction
  migrations/     Alembic schema history
  eval/           synthetic extraction benchmark
frontend/
  src/            server-rendered case pages and interactive author/answer forms
scripts/          contract generation, cloud deployment, smoke and screenshot checks
docs/             specification, API contract, deployment runbook, observability, progress log
```

## Getting started

Requirements: Docker Compose. For tests and contract generation you'll also need [uv](https://docs.astral.sh/uv/) and Node 24.

```sh
cp .env.example .env
docker compose up -d db
docker compose build
docker compose run --rm backend python -m alembic upgrade head
docker compose run --rm backend python -m app.seed
docker compose up -d
```

Open http://localhost:3000 (API docs at http://localhost:8000/docs). The local author key is `local-author-key`; set a private value in `.env` before exposing the service. PostgreSQL listens on `localhost:55432`. Migrations are run explicitly and never automatically at web startup.

## Configuration

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | Local database password |
| `AUTHOR_API_KEY` | Key required for extraction, creation, and Analytics (`X-Author-Key` header) |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Vertex AI project/region for Gemini |
| `GEMINI_MODEL` | Left unset by default — without credentials, extraction returns an honest "unavailable" error instead of failing silently |

Gemini extraction needs Application Default Credentials. Run the backend on the host with `gcloud auth application-default login`, or mount an ADC file read-only into the container — never bake credentials into an image. Cloud Run picks up credentials from its service identity automatically.

## Development checks

```sh
uv sync --project backend --frozen
npm ci --prefix frontend

# keep the generated API contract and TypeScript client in sync
uv run --project backend python scripts/generate-contract.py

uv run --project backend mypy --config-file backend/pyproject.toml backend/app
uv run --project backend python -m pytest backend/tests -m "not integration"
# set TEST_DATABASE_URL to a dedicated PostgreSQL test database first
uv run --project backend python -m pytest backend/tests

npm run typecheck --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend

uv run --project backend python scripts/smoke.py http://localhost:8000
```

`generate-contract.py` regenerates `docs/openapi.json` and `frontend/src/lib/api.generated.ts` in one step — CI repeats it and fails on drift, so don't hand-edit the generated DTO types. Integration tests require real PostgreSQL and must target a disposable test database, never application data. CI runs typecheck, unit-test, integration-test, api-contract, build, and browser-test jobs behind a single aggregate verify gate ([`.github/workflows/verify.yaml`](.github/workflows/verify.yaml)).

## Browser regression checks

```sh
npm ci --prefix frontend
npm run build --prefix frontend
npm run test:e2e --prefix frontend
```

Both suites boot their own local production server against synthetic API fixtures — they never touch the deployed database or call Gemini. Local E2E uses installed Google Chrome; CI uses Playwright Chromium.

Pixel-diff screenshots run inside the same pinned Linux/amd64 browser container locally and in CI:

```powershell
docker build --platform linux/amd64 -f scripts/Dockerfile.screenshots -t clinical-cases-screenshots .
docker run --rm --ipc=host -v "${PWD}/.local/screenshot-results:/app/.local/screenshot-results" clinical-cases-screenshots
```

Screenshot comparison tolerates one RGB level of antialiasing rounding between Linux hosts; dimensions and alpha remain exact. Sixteen reviewed baselines in `scripts/screenshots/linux-chromium` cover Home, Cases, a case, answer feedback, Profile, the sign-in dialog, Analytics, and the author form on desktop/mobile. After an intentional UI change, regenerate baselines, review every changed image, then re-run the comparison:

```powershell
docker run --rm --ipc=host -v "${PWD}/scripts/screenshots/linux-chromium:/app/scripts/screenshots/linux-chromium" clinical-cases-screenshots node scripts/check-screenshots.cjs --update-baselines
```

CI never updates baselines; failures upload actual/diff PNGs as the **screenshot-results** artifact. The pinned Playwright PNG decoder is used by this test harness and must be checked when upgrading Playwright.

The header links to Home, Cases, Create case, Analytics and API Docs (a new tab). The footer links to the author's GitHub profile. Unsaved author content is kept only in memory, never written to browser storage; links and reload/close warn before leaving.

All cases supports case-insensitive literal search in case titles and descriptions, debounced 300 ms, with pagination-preserving URL state. Open **Analytics** in the header, enter the author key and select the last 7, 30 or 90 days to see cases created, attempts submitted, and the percentage of correct answers. See [analytics access and calculations](docs/observability.md#private-application-analytics).

## Accounts and personal history

Signing in attaches new cases and answers to a profile: correct/incorrect attempts, total points, answer history with case links, and authored cases. There's no email or password recovery, so credentials aren't recoverable if lost. Guests can still answer after confirming the attempt will remain unowned.

Case owners can edit or hide their own cases, including after answers have been submitted — edits apply to future answers only, and past answers keep their original case and score. Author extraction and case creation require both a signed-in account and the author key.

## Assignment assumptions

The original assignment asked for a saved clinical case, answer scoring, server rendering, and structured LLM extraction. The educational author/learner workflow, one diagnosis per case, an independently entered reference with accepted variants, and deterministic exact-match scoring are this project's interpretation — no external JSON schema or scoring rubric was supplied. See [assignment coverage](docs/assignment-coverage.md) for a requirement-by-requirement trace.

## Documentation

- [docs/specification.md](docs/specification.md) — functional specification
- [docs/api-contract.md](docs/api-contract.md) — API contract
- [docs/deployment.md](docs/deployment.md) — Cloud Run deployment runbook
- [docs/observability.md](docs/observability.md) — tracing, logs, and Analytics access/calculations
- [docs/llm.md](docs/llm.md) — Gemini extraction evaluation
- [docs/e2e-selectors.md](docs/e2e-selectors.md) — stable selectors for browser tests
- [docs/progress.md](docs/progress.md) — verification record of what's actually been checked
- [docs/assignment-coverage.md](docs/assignment-coverage.md) — requirement coverage trace

---

Built by [Nikita Kolosov](https://github.com/NKolosov097).
