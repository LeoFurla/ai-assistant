# Changelog

All notable changes to the AI Assistant are documented here.

## [0.4.0] - 2026-10-18

### Changed
- **Knowledge base decoupled from Open WebUI.** The KB is now an in-memory BM25 keyword index built directly from the `catalog/` folder on first use. No seeding, no external data service. The catalog folder is the single source of truth.
- **Bilingual knowledge base documents.** Each plugin document merges the JSON catalog entry with the TSV feature catalog's English summary and keywords, so English queries match the (mostly German) JSON catalog entries.
- **LLM query expansion for plugin matching.** Before the keyword search, the model rewrites the requirement into 3-5 short bilingual (EN/DE) keyword phrases - the keyword-world equivalent of semantic search. Falls back to plain keyword search if the expansion call fails.
- **Open WebUI is now optional.** It is only used as an LLM chat router when `LLM_URL` is not set. With a direct `LLM_URL` the app has no Open WebUI dependency at all.

### Removed
- The `/api/kb/seed` endpoint and the "Load ACRIS catalog" seed button (nothing to seed anymore).
- The `KB_NAME` and `KB_ID` environment variables.

### Notes
- After editing files in `catalog/`, restart the container to rebuild the index.
- The feature check already ran on a local BM25 index over the TSV and is unchanged.

## [0.3.0] - 2026-10-18

### Added
- README: tech stack, features, environment variables, usage.

## [0.1.0] - 2026-10-18

### Added
- Initial release: text autocomplete, ACRIS plugin suggestions, feature check and translations, powered by a local LLM (llama.cpp, optionally routed through Open WebUI) and an Open WebUI knowledge base seeded from the ACRIS plugin catalog.
