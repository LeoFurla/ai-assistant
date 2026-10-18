'use strict';

// AI Assistant: text autocomplete, ACRIS plugin suggestions, feature check and translations.
// LLM goes through LLM_URL (direct llama.cpp) or, optionally, Open WebUI as a chat router.
// The knowledge base is a local BM25 index over the catalog/ folder, built in-process.
// Zero npm dependencies, requires Node 20+.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8091);
const OWUI_URL = (process.env.OPENWEBUI_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OWUI_KEY = process.env.OPENWEBUI_API_KEY || '';
const OWUI_EMAIL = process.env.OPENWEBUI_EMAIL || '';
const OWUI_PASSWORD = process.env.OPENWEBUI_PASSWORD || '';
// Optional direct OpenAI-compatible endpoint, e.g. http://llama-backend:8080/v1 (skips Open WebUI for completions).
const LLM_URL = (process.env.LLM_URL || '').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'Qwen3.5-9B-Q4_K_M';
const KB_TOP_K = Number(process.env.KB_TOP_K || 6);
const PROMPT_CHARS = Number(process.env.PROMPT_CHARS || 3000);
const CATALOG_DIR = process.env.CATALOG_DIR || path.join(__dirname, 'catalog');
// Feature check: tab-separated plugin catalog with features, scraped from acris.at and the Shopware Store.
const FEATURE_CATALOG = process.env.FEATURE_CATALOG || path.join(CATALOG_DIR, 'acris-features.tsv');
const FEATURE_CATALOG_DATE = process.env.FEATURE_CATALOG_DATE || '2026-10-11';
// The catalog prompt is about 28k tokens, so the model needs a large context (Qwen3.5-9B is configured with 131k).
const FEATURE_MODEL = process.env.FEATURE_MODEL || 'Qwen3.5-9B-Q4_K_M';
// The deep check (reasoning) runs only when the quick answer is not a verified "exists"; FEATURE_THINKING=0 turns it off.
const FEATURE_THINKING = process.env.FEATURE_THINKING !== '0';
// Room for reasoning plus the JSON answer. The prompt is ~28k tokens; 16k more still fits the 131k context.
// Too low a limit cuts the reasoning off before the JSON answer.
const FEATURE_DEEP_MAX_TOKENS = Number(process.env.FEATURE_DEEP_MAX_TOKENS || 16384);
// Hard time limit for the deep check; the request is cancelled and llama.cpp stops generating.
const FEATURE_DEEP_TIMEOUT_MS = Number(process.env.FEATURE_DEEP_TIMEOUT_S || 120) * 1000;
// Search first, then AI: how many plugins the keyword search hands to the model. 0 = always the whole catalog.
const FEATURE_SHORTLIST = Number(process.env.FEATURE_SHORTLIST ?? 25);

// ACRIS pages often name Shopware features differently than merchants do. The model needs these bridges.
const FEATURE_GLOSSARY = 'Terms that mean the same in this catalog: '
    + '"search preview" = search suggestions = search suggest = autocomplete dropdown under the search field (Suchvorschläge); '
    + '"Shopping Experiences" = CMS = Erlebniswelten = layouts; '
    + '"off-canvas cart" = mini cart = slide-out cart; '
    + '"Rule Builder" rules = conditions = Regeln; '
    + '"dynamic product groups" = product streams; '
    + '"debtor" = company account (B2B); '
    + '"Flow Builder" = automations = workflows.\n';

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

const LANGUAGES = {
    'de-DE': 'German', 'en-GB': 'English (British)', 'nl-NL': 'Dutch', 'fr-FR': 'French', 'es-ES': 'Spanish',
    'fi-FI': 'Finnish', 'nn-NO': 'Norwegian (Nynorsk)', 'sv-SE': 'Swedish', 'cs-CZ': 'Czech', 'pt-PT': 'Portuguese (Portugal)',
    'tr-TR': 'Turkish', 'da-DK': 'Danish', 'it-IT': 'Italian', 'pl-PL': 'Polish', 'bs-BA': 'Bosnian',
    'sl-SI': 'Slovene', 'sk-SK': 'Slovak',
};

// ---------------------------------------------------------------------------
// Open WebUI auth + requests
// ---------------------------------------------------------------------------

let sessionToken = null;

async function token(renew = false) {
    if (OWUI_KEY) return OWUI_KEY;
    if (sessionToken && !renew) return sessionToken;
    const res = await fetch(`${OWUI_URL}/api/v1/auths/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: OWUI_EMAIL, password: OWUI_PASSWORD }),
    });
    if (!res.ok) throw new Error(`Open WebUI sign-in failed: ${res.status}`);
    sessionToken = (await res.json()).token;
    return sessionToken;
}

async function owuiFetch(url, init = {}, retry = true) {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${await token()}` };
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && retry && !OWUI_KEY) {
        await token(true);
        return owuiFetch(url, init, false);
    }
    return res;
}

// ---------------------------------------------------------------------------
// LLM (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

async function llmRequest(messages, opts, signal) {
    const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: LLM_MODEL,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
            messages,
            ...opts,
        }),
        signal,
    };
    const res = LLM_URL
        ? await fetch(`${LLM_URL}/chat/completions`, init)
        : await owuiFetch(`${OWUI_URL}/api/chat/completions`, init);
    if (!res.ok) throw new Error(`LLM -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
}

async function chat(messages, opts, signal) {
    const data = await (await llmRequest(messages, opts, signal)).json();
    return ((data.choices && data.choices[0].message.content) || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}

// llama.cpp unloads idle models, so the first request after a pause pays the load time.
// A one-token request when the page opens loads the model before the user starts typing.
let warming = null;
function warmUp() {
    if (warming) return;
    warming = chat([{ role: 'user', content: 'Hi' }], { max_tokens: 1 })
        .catch((e) => console.error('warm-up failed:', e.message))
        .finally(() => { warming = null; });
}

// Streams the assistant text into `out` (an http.ServerResponse) as plain text chunks.
async function chatStream(messages, opts, out, signal) {
    const res = await llmRequest(messages, { ...opts, stream: true }, signal);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try {
                const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                if (delta) out.write(delta);
            } catch {}
        }
    }
}

// ---------------------------------------------------------------------------
// Knowledge base: local BM25 index over catalog/ (no external service, no seeding)
// ---------------------------------------------------------------------------

let kb = null;

function pluginDocument(p, feat) {
    const lines = [
        `ACRIS plugin: ${p.label} (${p.name})`,
        `Description: ${p.description}`,
    ];
    if (p.category) lines.push(`Category: ${p.category}`);
    if (p.keywords) lines.push(`Keywords: ${p.keywords}`);
    // English summary and keywords from the TSV feature catalog: without them, English queries
    // would rarely match the (mostly German) JSON catalog entries.
    if (feat) {
        if (feat.summary) lines.push(`English summary: ${feat.summary}`);
        if (feat.keywords) lines.push(`Catalog keywords: ${feat.keywords}`);
    }
    if (p.highlights && p.highlights.length) lines.push(`Highlights: ${p.highlights.join('; ')}`);
    if (p.features && p.features.length) lines.push(`Features: ${p.features.join('; ')}`);
    if (p.price) lines.push(`Price: ${p.price}`);
    if (p.url) lines.push(`URL: ${p.url}`);
    return lines.join('\n') + '\n';
}

// Builds the knowledge base: one document per plugin (JSON catalog, enriched with the TSV's
// English fields) plus the company profile (*.txt). The index lives in memory and is rebuilt
// on container restart, so the catalog folder is the single source of truth.
function loadKb() {
    if (kb) return kb;

    let featureByName = new Map();
    try {
        featureByName = new Map(loadFeatureCatalog().plugins.map((p) => [p.name, p]));
    } catch (e) {
        console.error('kb: feature catalog unreadable, using JSON catalog only:', e.message);
    }

    const docs = [];
    for (const file of fs.readdirSync(CATALOG_DIR)) {
        const full = path.join(CATALOG_DIR, file);
        if (file.endsWith('.txt')) {
            docs.push({ source: file, text: fs.readFileSync(full, 'utf8') });
        } else if (file.endsWith('.json')) {
            for (const p of JSON.parse(fs.readFileSync(full, 'utf8'))) {
                docs.push({ source: `${p.name}.txt`, text: pluginDocument(p, featureByName.get(p.name)) });
            }
        }
    }

    // Same BM25 index as the feature check: stemmed tokens, shared vocabulary.
    const df = new Map();
    const index = docs.map((d) => {
        const tokens = searchTokens(d.text).map(stem);
        const tf = new Map();
        tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
        tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
        return { ...d, tf, length: tokens.length };
    });
    const avgLength = index.reduce((sum, d) => sum + d.length, 0) / index.length;

    kb = { index, df, avgLength };
    return kb;
}

// Keyword search over the catalog. Synchronous and in-memory, so it is cheap enough to run
// on every autocomplete request. Returns { text, source } documents, best first.
function retrieve(query, k) {
    query = query.trim();
    if (!query) return [];
    const terms = expandQuery(searchTokens(query));
    const { index, df, avgLength } = loadKb();
    const n = index.length;
    const scored = [];
    for (const doc of index) {
        let score = 0;
        for (const t of terms) {
            const tf = doc.tf.get(t);
            if (!tf) continue;
            const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
            score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / avgLength));
        }
        if (score > 0) scored.push({ text: doc.text, source: doc.source, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

// The retrieval query only changes once a sentence is finished, to spare the embedding model.
function sentenceKey(text) {
    const tail = text.slice(-400);
    const end = Math.max(tail.lastIndexOf('. '), tail.lastIndexOf('? '), tail.lastIndexOf('! '), tail.lastIndexOf('\n'));
    return end > 40 ? tail.slice(0, end + 1) : tail.slice(0, Math.floor(tail.length / 40) * 40) || tail;
}

async function autocomplete(before, signal) {
    let notes = [];
    try {
        notes = await retrieve(sentenceKey(before), 3);
    } catch {}

    const prefix = before.slice(-PROMPT_CHARS);
    let system = 'You are an autocomplete engine for employees of ACRIS E-Commerce GmbH, a Shopware plugin vendor. '
        + 'Continue the assistant text with the next few words or the rest of the sentence. '
        + 'Never repeat text that is already written. Keep the language, tone and formatting of the text.';
    if (notes.length) {
        system += '\n\nFacts from the ACRIS knowledge base, use them only when relevant:\n'
            + notes.map((n) => '- ' + n.text.replace(/\s+/g, ' ').slice(0, 600)).join('\n');
    }

    // Assistant prefill: the model continues the existing text instead of answering it.
    let out = await chat([
        { role: 'system', content: system },
        { role: 'user', content: 'Continue my text.' },
        { role: 'assistant', content: prefix },
    ], { max_tokens: 32, temperature: 0.3, stop: ['\n\n'] }, signal);

    if (out.startsWith(prefix)) out = out.slice(prefix.length);
    else if (out.startsWith(prefix.trimEnd())) out = out.slice(prefix.trimEnd().length);
    return { completion: out };
}

function parsePlugin(doc) {
    const m = doc.text.match(/ACRIS plugin:\s*(.+?)\s*\((\w+)\)/);
    if (!m) return null;
    const field = (name) => (doc.text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm')) || [])[1] || '';
    return { name: m[2], label: m[1], description: field('Description'), url: field('URL') };
}

// The index matches words, not meaning: the requirement is first rewritten by the model into a few
// short keyword phrases in English and German (the catalog is bilingual). This is the keyword-world
// equivalent of a semantic search, and it is what makes English queries find the German catalog entries.
async function expandRequirement(requirement, signal) {
    const answer = await chat([
        {
            role: 'system',
            content: 'You prepare a keyword search over a bilingual (English/German) Shopware plugin catalog. '
                + 'Rewrite the requirement into 3 to 5 short keyword phrases using typical catalog wording, '
                + 'mixing English and German. No full sentences, no explanations, only the phrases, comma separated.',
        },
        { role: 'user', content: requirement },
    ], { max_tokens: 120, temperature: 0 }, signal);
    return answer.trim();
}

async function suggestPlugins(requirement, signal) {
    let expanded = '';
    try {
        expanded = await expandRequirement(requirement, signal);
    } catch {}
    const candidates = [];
    for (const doc of retrieve(expanded ? `${requirement}, ${expanded}` : requirement, KB_TOP_K)) {
        const p = parsePlugin(doc);
        if (p && !candidates.some((c) => c.name === p.name)) candidates.push(p);
    }
    if (!candidates.length) return { picked: [], candidates };

    const answer = await chat([
        {
            role: 'system',
            content: 'You map webshop requirements to ACRIS Shopware plugins. Answer only with the technical names of the '
                + '1 to 3 best matching plugins from the candidate list, comma separated, best first. '
                + 'If no candidate fits, answer: none',
        },
        {
            role: 'user',
            content: 'Candidates:\n' + candidates.map((c) => `- ${c.name}: ${c.label}. ${c.description}`).join('\n')
                + `\n\nRequirement: ${requirement}`,
        },
    ], { max_tokens: 40, temperature: 0 }, signal);

    const picked = answer.split(/[,\n]/)
        .map((s) => s.replace(/[^\w]/g, '').toLowerCase())
        .map((name) => candidates.find((c) => c.name.toLowerCase() === name))
        .filter((c, i, all) => c && all.indexOf(c) === i)
        .slice(0, 3);

    return { picked, candidates };
}

// Search first, then AI: a keyword search (BM25, in this process, no GPU) picks the FEATURE_SHORTLIST plugins that
// share the most words with the request, expanded with synonyms; only those go to the model. That keeps the prompt
// at a few thousand tokens instead of the whole catalog (~43k), so checks are fast and can run in parallel.
let featureCatalog = null;

const SEARCH_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'is', 'are', 'be', 'can',
    'should', 'i', 'we', 'my', 'our', 'der', 'die', 'das', 'und', 'oder', 'im', 'mit', 'für', 'zu', 'von', 'den', 'dem', 'ein',
    'eine', 'einen', 'ist', 'sind', 'kann', 'sollen', 'soll', 'es', 'auf']);

// Words in one group find each other (English, German and ACRIS wording). Same idea as FEATURE_GLOSSARY for the model.
const SEARCH_SYNONYMS = [
    ['suggest', 'suggestion', 'suggestions', 'preview', 'autocomplete', 'suchvorschlag', 'suchvorschläge', 'vorschläge'],
    ['shopping', 'experience', 'experiences', 'cms', 'erlebniswelt', 'erlebniswelten', 'layout', 'layouts'],
    ['offcanvas', 'off', 'canvas', 'minicart', 'mini'],
    ['rule', 'rules', 'regel', 'regeln', 'condition', 'conditions', 'bedingung'],
    ['stream', 'streams', 'dynamic', 'group', 'groups', 'produktgruppe'],
    ['debtor', 'debtors', 'company', 'firma', 'debitor'],
    ['flow', 'automation', 'automations', 'workflow', 'workflows'],
    ['voucher', 'vouchers', 'gutschein', 'gutscheine', 'coupon', 'coupons'],
    ['cart', 'carts', 'basket', 'warenkorb', 'warenkörbe'],
    ['email', 'mail', 'emails', 'e', 'reminder', 'reminders', 'erinnerung', 'notification', 'benachrichtigung'],
    ['search', 'suche', 'suchen', 'find'],
    ['product', 'products', 'produkt', 'produkte', 'artikel', 'item', 'items'],
    ['buy', 'purchase', 'kaufen', 'order', 'bestellen', 'bestellung', 'checkout'],
    ['delivery', 'shipping', 'versand', 'lieferung', 'lieferzeit'],
    ['faq', 'faqs', 'question', 'questions', 'fragen'],
];

function searchTokens(text) {
    return (String(text).toLowerCase().match(/[a-z0-9äöüß]+/g) || [])
        .filter((t) => t.length > 1 && !SEARCH_STOPWORDS.has(t));
}

// Tiny suffix stripping, so plurals and German endings match ("vouchers" ~ "voucher", "Lieferungen" ~ "Lieferung").
function stem(t) {
    for (const suffix of ['ungen', 'ung', 'ies', 'es', 'en', 'er', 's', 'e', 'n']) {
        if (t.length > suffix.length + 3 && t.endsWith(suffix)) return t.slice(0, -suffix.length);
    }
    return t;
}

function expandQuery(tokens) {
    const out = new Set(tokens);
    for (const t of tokens) {
        for (const group of SEARCH_SYNONYMS) {
            if (group.includes(t)) group.forEach((g) => out.add(g));
        }
    }
    return [...new Set([...out].map(stem))];
}

// BM25 ranking over the search index built in loadFeatureCatalog().
function shortlist(catalog, query, k) {
    const terms = expandQuery(searchTokens(query));
    const { docs, df, avgLength } = catalog.index;
    const n = docs.length;
    const scored = [];
    for (const doc of docs) {
        let score = 0;
        for (const t of terms) {
            const tf = doc.tf.get(t);
            if (!tf) continue;
            const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
            score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / avgLength));
        }
        if (score > 0) scored.push({ plugin: doc.plugin, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.plugin);
}

function loadFeatureCatalog() {
    if (featureCatalog) return featureCatalog;

    const lines = fs.readFileSync(FEATURE_CATALOG, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    const header = lines.shift().split('\t');
    const plugins = lines.map((line) => {
        const cells = line.split('\t');
        const row = Object.fromEntries(header.map((h, i) => [h, (cells[i] || '').trim()]));
        return {
            name: row.technical_name,
            label: row.display_name,
            category: row.category,
            url: row.source_url,
            summary: row.summary,
            features: row.features ? row.features.split(' | ').map((f) => f.trim()).filter(Boolean) : [],
            // English keywords from acris.at and German keywords from the older catalog (help with synonyms and German questions).
            keywords: [row.keywords_en, row.keywords_de].filter(Boolean).join(', '),
        };
    }).filter((p) => p.name);

    // Compact prompt line per plugin: links are left out and summaries shortened to keep the prompt small.
    for (const p of plugins) {
        p.line = [
            `${p.name} (${p.label})`,
            p.category && `category: ${p.category}`,
            p.summary && `summary: ${p.summary.slice(0, 140)}`,
            p.features.length && `features: ${p.features.join('; ')}`,
            p.keywords && `keywords: ${p.keywords}`,
        ].filter(Boolean).join(' | ');
    }

    // Search index: name and label weigh double (they appear twice), German keywords too, because German
    // questions otherwise only match the few German words in the catalog.
    const df = new Map();
    const docs = plugins.map((p) => {
        const tokens = searchTokens([p.name, p.label, p.label, p.summary, p.features.join(' '), p.keywords].join(' ')).map(stem);
        const tf = new Map();
        tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
        tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
        return { plugin: p, tf, length: tokens.length };
    });
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;

    featureCatalog = {
        plugins,
        byName: new Map(plugins.map((p) => [p.name.toLowerCase(), p])),
        text: plugins.map((p) => p.line).join('\n'),
        index: { docs, df, avgLength },
    };
    return featureCatalog;
}

const normalizeText = (s) => String(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

const FEATURE_ANSWER_SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['exists', 'partial', 'missing'] },
        matches: {
            type: 'array',
            maxItems: 3,
            items: {
                type: 'object',
                properties: {
                    plugin: { type: 'string', maxLength: 80 },
                    evidence: { type: 'string', maxLength: 300 },
                    reason: { type: 'string', maxLength: 300 },
                },
                required: ['plugin', 'evidence', 'reason'],
                additionalProperties: false,
            },
        },
        summary: { type: 'string', maxLength: 400 },
    },
    required: ['verdict', 'matches', 'summary'],
    additionalProperties: false,
};

function parseJsonAnswer(answer) {
    const match = answer.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            return JSON.parse(match[0]);
        } catch {}
    }
    console.error('feature check: no valid JSON in model answer:', answer.slice(0, 1500));

    // Rescue a broken answer (e.g. cut off at the token limit): verdict and the first summary are usually intact.
    // Matches are not rescued, so a positive verdict without plugins ends up as "unclear".
    const verdict = (answer.match(/"verdict"\s*:\s*"(exists|partial|missing)"/) || [])[1];
    const summary = (answer.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
    if (verdict) return { verdict, matches: [], summary: summary ? JSON.parse(`"${summary}"`) : '' };

    throw new Error('The model did not answer with JSON.');
}

const VERDICTS = ['exists', 'partial', 'missing'];

// The model often answers in German because parts of the catalog are German, so the server decides the
// answer language. German if the text has umlauts/ß, one clearly German word or a typical German word ending;
// everything else English. Words that also exist in English ("die", "in", "shop") never count on their own.
const GERMAN_WORDS = new Set([
    'der', 'das', 'und', 'oder', 'nicht', 'ist', 'sind', 'ein', 'eine', 'einen', 'mit', 'auf', 'von', 'zu', 'im',
    'kann', 'soll', 'sollen', 'wird', 'werden', 'gibt', 'wie', 'wenn', 'nach', 'beim', 'bei', 'als', 'auch', 'dem',
    'des', 'zum', 'zur', 'wir', 'sie', 'kunden', 'kunde', 'kaufen', 'bestellen', 'bestellung', 'warenkorb', 'gutschein',
    'gutscheine', 'artikel', 'produkt', 'produkte', 'seite', 'seiten', 'anzeigen', 'versand', 'lieferung', 'rechnung',
    'zahlung', 'suche', 'suchvorschlag', 'erlebniswelt', 'erlebniswelten', 'gibt', 'haben', 'mehrere', 'automatisch',
]);
const GERMAN_ENDING = /(ung|ungen|keit|heit|lich|ieren|chen)$/;

function answerLanguage(text) {
    if (/[äöüß]/i.test(text)) return 'German';
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    return words.some((w) => GERMAN_WORDS.has(w) || (w.length >= 6 && GERMAN_ENDING.test(w))) ? 'German' : 'English';
}

// Checks that send the whole catalog (~43k tokens) run one at a time: llama.cpp shares one context across
// parallel requests, so two or more at once exceed it ("Context size has been exceeded"). Shortlist checks
// are small and run in parallel.
let featureQueue = Promise.resolve();
function queueFeatureCheck(task) {
    const run = featureQueue.then(task, task);
    featureQueue = run.catch(() => {});
    return run;
}

// Two modes: a quick check (no reasoning, JSON enforced) answers in seconds; the deep check reasons first,
// which catches features the catalog only implies, but takes a minute or more. The page runs the deep check
// only when the quick answer is not a verified "exists".
async function checkFeature(feature, signal, deep = false) {
    const catalog = loadFeatureCatalog();

    // Search first: the plugins sharing the most words with the request. If the search finds nothing at all
    // (or the shortlist is switched off), the model gets the whole catalog instead.
    const candidates = FEATURE_SHORTLIST > 0 ? shortlist(catalog, feature, FEATURE_SHORTLIST) : [];
    const wholeCatalog = candidates.length === 0;
    const catalogText = wholeCatalog ? catalog.text : candidates.map((p) => p.line).join('\n');

    // The system message holds only the fixed rules (cached by llama.cpp); the candidates change per request.
    const messages = [
        {
            role: 'system',
            content: 'You check whether a requested webshop feature already exists in the ACRIS Shopware plugin catalog. '
                + 'You get the plugins from the catalog that are most related to the request. '
                + 'Judge only from these plugins. Never invent plugins or features.\n'
                + 'Read the summaries, features and keywords carefully: the catalog often describes a feature in other words or only implies it '
                + '(for example "PDF voucher after purchase" means customers can buy vouchers in the shop).\n'
                + FEATURE_GLOSSARY
                + 'verdict: "exists" if a plugin offers the feature, directly or clearly implied; '
                + '"partial" if a plugin offers part of it or something close; '
                + '"missing" only if no plugin covers it, not even partly. When unsure between "partial" and "missing", choose "partial".\n'
                + 'matches: up to 3 plugins, best first. For each: the technical name exactly as in the catalog, '
                + 'a short evidence quote (one feature or one sentence) copied word for word from that plugin\'s catalog line, '
                + 'and one short sentence why it matches. For "missing", list the closest related plugins.\n'
                + 'summary: one sentence with the answer.\n'
                + 'Answer with JSON only, no other text: '
                + '{"verdict":"exists|partial|missing","matches":[{"plugin":"TechnicalName","evidence":"exact quote","reason":"..."}],"summary":"..."}',
        },
        {
            role: 'user',
            content: 'Plugins, one per line:\n' + catalogText + '\n\n'
                + `Requested feature: ${feature}\n\n`
                + `Write "summary" and every "reason" in ${answerLanguage(feature)}. `
                + 'Keep each "evidence" quote exactly as written in the catalog, in its original language.'
                + (deep ? ' Keep your reasoning short and end with the JSON answer.' : ''),
        },
    ];

    const generate = async () => {
        let answer;
        if (!deep) {
            // Quick check without reasoning. llama.cpp enforces the exact answer structure: with plain JSON mode
            // and temperature 0 the model once repeated "summary" until the token limit (duplicate keys are valid
            // JSON). The schema allows every field once, with a maximum length. Open WebUI may not pass
            // response_format through, so it is only sent directly.
            answer = await chat(messages, {
                model: FEATURE_MODEL,
                temperature: 0,
                max_tokens: 1200,
                ...(LLM_URL
                    ? { response_format: { type: 'json_schema', json_schema: { name: 'feature_check', schema: FEATURE_ANSWER_SCHEMA } } }
                    : {}),
            }, signal);
        } else {
            // Deep check with reasoning. Qwen's recommended sampling for thinking mode: at temperature 0 the
            // reasoning can repeat itself endlessly. Streamed, so llama.cpp stops generating as soon as the
            // request is cancelled, and capped in time, so a runaway answer cannot block the GPU.
            let collected = '';
            try {
                await chatStream(messages, {
                    model: FEATURE_MODEL,
                    temperature: 0.6,
                    top_p: 0.95,
                    top_k: 20,
                    chat_template_kwargs: { enable_thinking: true },
                    max_tokens: FEATURE_DEEP_MAX_TOKENS,
                }, { write: (text) => { collected += text; } },
                AbortSignal.any([signal, AbortSignal.timeout(FEATURE_DEEP_TIMEOUT_MS)]));
            } catch (e) {
                if (e.name === 'TimeoutError') {
                    throw new Error(`The double-check took longer than ${Math.round(FEATURE_DEEP_TIMEOUT_MS / 1000)} s and was stopped.`);
                }
                throw e;
            }
            answer = collected.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
        }
        return answer;
    };

    // Whole-catalog prompts are large, so they wait in line; shortlist prompts run in parallel.
    const answer = wholeCatalog
        ? await queueFeatureCheck(() => {
            if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            return generate();
        })
        : await generate();

    const raw = parseJsonAnswer(answer);

    // Only plugins that exist in the catalog survive; evidence counts as verified only if it is really in that plugin's entry.
    const seen = new Set();
    let dropped = 0;
    const matches = (Array.isArray(raw.matches) ? raw.matches : []).map((m) => {
        const plugin = catalog.byName.get(String((m && m.plugin) || '').replace(/[^\w]/g, '').toLowerCase());
        if (!plugin || seen.has(plugin.name)) {
            if (!plugin) dropped++;
            return null;
        }
        seen.add(plugin.name);
        const evidence = String(m.evidence || '').trim();
        const haystack = normalizeText([plugin.label, plugin.summary, ...plugin.features, plugin.keywords].join(' '));
        return {
            name: plugin.name,
            label: plugin.label,
            category: plugin.category,
            url: plugin.url,
            evidence,
            verified: normalizeText(evidence).length > 3 && haystack.includes(normalizeText(evidence)),
            reason: String(m.reason || '').trim(),
        };
    }).filter(Boolean).slice(0, 3);

    let verdict = VERDICTS.includes(raw.verdict) ? raw.verdict : 'unclear';
    // A positive verdict without any real plugin behind it cannot be trusted.
    if ((verdict === 'exists' || verdict === 'partial') && !matches.length) verdict = 'unclear';

    return {
        verdict,
        summary: String(raw.summary || '').trim(),
        matches,
        dropped,
        deep,
        // How many plugins the model looked at (the search shortlist, or the whole catalog as fallback).
        considered: wholeCatalog ? catalog.plugins.length : candidates.length,
        catalog: { count: catalog.plugins.length, date: FEATURE_CATALOG_DATE },
    };
}

async function translate(text, target, out, signal) {
    const run = (language) => chatStream([
        {
            role: 'system',
            content: `Translate the text into ${language}. Translate every word, including short UI labels and single words. `
                + 'If the text is JSON, translate only the string values and keep keys, structure and valid JSON. '
                + 'Keep placeholders like {count}, {{ name }}, %name% and HTML tags unchanged. '
                + 'Output only the translation, without explanations, quotes or code fences.',
        },
        { role: 'user', content: text },
    ], { temperature: 0.2, max_tokens: 2048 }, out, signal);

    if (target !== 'all') return run(LANGUAGES[target] || 'English');
    for (const [code, language] of Object.entries(LANGUAGES)) {
        if (signal.aborted) return;
        out.write(`${code}:\n`);
        await run(language);
        out.write('\n\n');
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

async function readJson(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
}

function abortOnClose(res) {
    const ctrl = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) ctrl.abort();
    });
    return ctrl.signal;
}

const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;

    try {
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return fs.createReadStream(INDEX_HTML).pipe(res);
        }

        if (req.method === 'GET' && p === '/api/status') {
            warmUp();
            const status = { model: LLM_MODEL, kb: null, kbError: null, languages: LANGUAGES };
            try {
                status.kb = { name: 'catalog (local)', count: loadKb().index.length };
            } catch (e) {
                status.kbError = e.message;
            }
            try {
                status.featureCatalog = { count: loadFeatureCatalog().plugins.length, date: FEATURE_CATALOG_DATE, model: FEATURE_MODEL, deep: FEATURE_THINKING };
            } catch (e) {
                status.featureCatalogError = e.message;
            }
            return send(res, 200, status);
        }

        if (req.method === 'POST' && p === '/api/complete') {
            const { before = '' } = await readJson(req);
            if (before.trim().length < 3) return send(res, 200, { completion: '' });
            return send(res, 200, await autocomplete(before, abortOnClose(res)));
        }

        if (req.method === 'POST' && p === '/api/plugins') {
            const { requirement = '' } = await readJson(req);
            if (requirement.trim().length < 4) return send(res, 200, { picked: [], candidates: [] });
            return send(res, 200, await suggestPlugins(requirement, abortOnClose(res)));
        }

        if (req.method === 'POST' && p === '/api/feature-check') {
            const body = await readJson(req);
            const feature = String(body.feature || '').trim();
            if (feature.length < 4) return send(res, 400, { error: 'Describe the feature in a few words.' });
            const deep = body.deep === true && FEATURE_THINKING;
            return send(res, 200, await checkFeature(feature.slice(0, 1000), abortOnClose(res), deep));
        }

        if (req.method === 'POST' && p === '/api/translate') {
            const { text = '', target = 'en-GB' } = await readJson(req);
            const signal = abortOnClose(res);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            try {
                if (text.trim()) await translate(text, target, res, signal);
            } catch (e) {
                if (e.name !== 'AbortError') res.write(`\n[error] ${e.message}`);
            }
            return res.end();
        }

        send(res, 404, { error: 'not found' });
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: e.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Assistant on :${PORT}  model=${LLM_MODEL}  via=${LLM_URL || OWUI_URL}  kb=local catalog`);
});
