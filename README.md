# ai-assistant

A self-hosted AI assistant for the **ACRIS plugin ecosystem** (Shopware 6). One plain-Node server, zero npm dependencies, with a single-page UI. It pairs a local LLM with an Open WebUI knowledge base seeded from the ACRIS plugin catalog.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node 20+, bare `node:http` — **no npm dependencies** |
| Frontend | Single `public/index.html` (vanilla JS, no framework) |
| LLM | Local llama.cpp router (`llama-backend`) via an OpenAI-compatible endpoint, e.g. Qwen3.5-9B; optionally routed through Open WebUI |
| Knowledge base | Open WebUI KB (retrieval-augmented answers), seeded from the local catalog |
| Data | `catalog/` — ACRIS plugin catalog (`acris-plugins.json`), feature matrix (`acris-features.tsv`, scraped from acris.at + Shopware Store), company profile (`acris-company.txt`) |
| Deploy | Docker (Compose), `node:20-alpine`, on the external `ai` docker network |

## Features

- **Text autocomplete** (`/api/complete`) — the model *continues* the text you're typing (prefill-style), with model pre-warming on page load
- **Plugin matching** (`/api/plugins`) — given a task description, suggests ACRIS plugins with evidence from the catalog/KB
- **Feature check** (`/api/feature-check`) — "does a plugin do X?" against the ~28k-token feature catalog: BM25 keyword shortlist first (GPU-free), quick LLM pass, then an optional deep reasoning pass with hard token/time limits; answers are structured (exists / partial / none + plugin + evidence)
- **Translations** (`/api/translate`) — translate plugin texts across ~12 languages (DE, EN, NL, FR, ES, FI, NO-Nynorsk, SV, CS, PT, …)
- **KB seeding** (`/api/kb/seed`) — uploads the catalog into the Open WebUI knowledge base in one batch (takes a few minutes)
- **Status** (`/api/status`) — model, KB entry count, catalog size, available languages

## Project layout

```
server.js         The entire backend (HTTP routes, OWUI client, KB, retrieval, prompts)
public/index.html Single-page UI
catalog/          ACRIS plugin data (JSON catalog, TSV feature matrix, company profile)
compose.yml       node:20-alpine container, env_file .env, on the external "ai" network
.env.example      Required env vars (copy to .env)
```

## Getting started

1. Copy the env template:
   ```sh
   cp .env.example .env
   ```
   Required: an Open WebUI endpoint + credentials (API key *or* email/password login), the `LLM_MODEL` name, and (recommended) `LLM_URL` for direct llama.cpp completions. `KB_ID` pins the knowledge base so an empty duplicate is never picked — leave it empty to auto-create/look up by `KB_NAME` first, then pin the real UUID in `.env`.
2. Start (requires the external `ai` docker network):
   ```sh
   docker compose up -d
   ```
3. Open <http://localhost:8091>, click **Load ACRIS catalog** once to seed the knowledge base, then use the tools.

### Key env vars

| Var | Meaning |
|---|---|
| `OPENWEBUI_URL` / `_API_KEY` / `_EMAIL`+`_PASSWORD` | Knowledge base + optional LLM routing |
| `LLM_URL` | Direct OpenAI-compatible endpoint (skips Open WebUI for completions) |
| `LLM_MODEL` / `FEATURE_MODEL` | Model names (feature check needs a big context, ~131k configured) |
| `KB_ID` / `KB_NAME` / `KB_TOP_K` | Knowledge base pinning and retrieval width |
| `FEATURE_THINKING` | `0` disables the deep reasoning pass of the feature check |
| `FEATURE_SHORTLIST` | How many plugins the keyword pre-filter hands to the model (0 = whole catalog) |
| `FEATURE_DEEP_TIMEOUT_S` / `FEATURE_DEEP_MAX_TOKENS` | Hard limits for the deep pass |

## Notes

- No npm dependencies — `package.json` exists only for tooling metadata; there is nothing to `npm install`.
- The server keeps the OWUI session token in memory and renews it on 401s.
- `.env` is gitignored and contains live credentials — never commit it.
- The app itself has no auth; keep it on a trusted network (e.g. Tailscale).
