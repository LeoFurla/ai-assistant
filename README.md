# ai-assistant

A self-hosted AI assistant for the **ACRIS plugin ecosystem** (Shopware 6). One plain-Node server, zero npm dependencies, with a single-page UI. It pairs a local LLM with a local, in-process knowledge base that indexes the ACRIS plugin catalog directly from the `catalog/` folder.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node 20+, bare `node:http` — **no npm dependencies** |
| Frontend | Single `public/index.html` (vanilla JS, no framework) |
| LLM | Local llama.cpp router (`llama-backend`) via an OpenAI-compatible endpoint, e.g. Qwen3.5-9B; Open WebUI only as an optional chat router |
| Knowledge base | Local BM25 keyword index built in-process from `catalog/` — bilingual documents (German JSON catalog enriched with the TSV's English summaries/keywords), no external service, no seeding |
| Data | `catalog/` — ACRIS plugin catalog (`acris-plugins.json`), feature matrix (`acris-features.tsv`, scraped from acris.at + Shopware Store), company profile (`acris-company.txt`) — the single source of truth for both the knowledge base and the feature check |
| Deploy | Docker (Compose), `node:20-alpine`, on the external `ai` docker network |

## Features

- **Text autocomplete** (`/api/complete`) — the model *continues* the text you're typing (prefill-style), with model pre-warming on page load
- **Plugin matching** (`/api/plugins`) — given a task description, the model first rewrites it into short bilingual (EN/DE) keyword phrases, a BM25 search over the catalog picks the candidate plugins, and the model picks the best 1–3
- **Feature check** (`/api/feature-check`) — "does a plugin do X?" against the ~28k-token feature catalog: BM25 keyword shortlist first (GPU-free), quick LLM pass, then an optional deep reasoning pass with hard token/time limits; answers are structured (exists / partial / none + plugin + evidence)
- **Translations** (`/api/translate`) — translate plugin texts across ~12 languages (DE, EN, NL, FR, ES, FI, NO-Nynorsk, SV, CS, PT, …)
- **Status** (`/api/status`) — model, KB document count, catalog size, available languages

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
   Required: the `LLM_MODEL` name and (recommended) `LLM_URL` for direct llama.cpp completions. The Open WebUI variables are only needed if you want to route the LLM through Open WebUI instead.
2. Start (requires the external `ai` docker network):
   ```sh
   docker compose up -d
   ```
3. Open <http://localhost:8091> and use the tools. The knowledge base is indexed from `catalog/` on startup — nothing to seed. After editing the catalog, restart the container to pick up the changes.

### Key env vars

| Var | Meaning |
|---|---|
| `LLM_URL` | Direct OpenAI-compatible endpoint (recommended) |
| `OPENWEBUI_URL` / `_API_KEY` / `_EMAIL`+`_PASSWORD` | Optional: route the LLM through Open WebUI when `LLM_URL` is not set |
| `LLM_MODEL` / `FEATURE_MODEL` | Model names (feature check needs a big context, ~131k configured) |
| `KB_TOP_K` | How many catalog documents the local keyword search hands to the plugin matcher |
| `FEATURE_THINKING` | `0` disables the deep reasoning pass of the feature check |
| `FEATURE_SHORTLIST` | How many plugins the keyword pre-filter hands to the model (0 = whole catalog) |
| `FEATURE_DEEP_TIMEOUT_S` / `FEATURE_DEEP_MAX_TOKENS` | Hard limits for the deep pass |

## Notes

- No npm dependencies — `package.json` exists only for tooling metadata; there is nothing to `npm install`.
- The knowledge base is a BM25 index built in memory from `catalog/` on first use — the catalog folder is the single source of truth. Edit the files, restart the container. Plugin matching additionally asks the LLM to rewrite the requirement into bilingual keyword phrases, so English queries match the German catalog entries (the keyword-world equivalent of semantic search).
- When `LLM_URL` is not set, the server keeps the Open WebUI session token in memory and renews it on 401s.
- `.env` is gitignored and contains live credentials — never commit it.
- The app itself has no auth; keep it on a trusted network (e.g. Tailscale).
