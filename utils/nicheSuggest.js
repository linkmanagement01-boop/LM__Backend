/**
 * Niche Edit suggestions for writers (OpenAI).
 *
 * Reads the live post, splits it into sentences and asks the model for:
 *   - replace: which existing sentence to rewrite + the rewritten sentence containing the anchor
 *   - insert:  which sentence to insert after + 1–2 new sentences containing the anchor
 * The model only picks sentence NUMBERS, so "Text to Replace" / "Insert After" are always copied word for word
 * from the post. Results are saved per order detail, so reopening an order never costs again.
 *
 * Money guards: post text is capped (~7k tokens in), the answer is capped (2k tokens out),
 * and a daily spend limit stops all calls once reached.
 *
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-5.4-mini),
 *      OPENAI_PRICE_IN / OPENAI_PRICE_OUT (USD per 1M tokens, default 0.75 / 4.50),
 *      NICHE_SUGGEST_DAILY_LIMIT_USD (default 2)
 */

const { query } = require('../config/database');
const { getPage } = require('./postScore');

const MODEL = () => process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const PRICE_IN = () => Number(process.env.OPENAI_PRICE_IN) || 0.75;
const PRICE_OUT = () => Number(process.env.OPENAI_PRICE_OUT) || 4.5;
const DAILY_LIMIT = () => Number(process.env.NICHE_SUGGEST_DAILY_LIMIT_USD) || 2;
const MAX_ARTICLE_CHARS = 24000; // ≈ 6–7k tokens
const MAX_OUTPUT_TOKENS = 2000;

const isConfigured = () => !!process.env.OPENAI_API_KEY;

let schemaReady = null;
const ensureSchema = () => {
    if (!schemaReady) {
        schemaReady = query(`
            CREATE TABLE IF NOT EXISTS niche_edit_suggestions (
                detail_id BIGINT PRIMARY KEY,           -- new_order_process_details.id
                post_url TEXT,
                anchor TEXT,
                status VARCHAR(20) NOT NULL,            -- ok | unreadable | failed | limit
                replace_text TEXT,
                replace_new TEXT,
                insert_after TEXT,
                insert_new TEXT,
                message TEXT,
                model TEXT,
                tokens_in INT DEFAULT 0,
                tokens_out INT DEFAULT 0,
                cost_usd NUMERIC(10,5) DEFAULT 0,
                total_cost_usd NUMERIC(10,5) DEFAULT 0, -- incl. earlier regenerations
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`).then(() => query(`
            CREATE TABLE IF NOT EXISTS ai_usage_log (
                id SERIAL PRIMARY KEY,
                feature VARCHAR(40) NOT NULL,
                model TEXT,
                tokens_in INT,
                tokens_out INT,
                cost_usd NUMERIC(10,5),
                ref_id BIGINT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`)).catch(err => { schemaReady = null; throw err; });
    }
    return schemaReady;
};

const spentToday = async () => Number((await query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage_log WHERE created_at >= date_trunc('day', NOW())`
)).rows[0].s);

/** Article text → numbered sentences worth linking from (skips tiny fragments and giant run-ons) */
const toSentences = (text) => {
    const parts = String(text || '')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+(?=["“'‘(]?[A-Z0-9])/);
    const out = [];
    let chars = 0;
    for (const raw of parts) {
        const s = raw.trim();
        if (s.length < 40 || s.length > 450) continue;
        if (!/[.!?]["”'’)]?$/.test(s)) continue;            // keep whole sentences only
        if (chars + s.length > MAX_ARTICLE_CHARS) break;
        out.push(s);
        chars += s.length;
    }
    return out;
};

const containsAnchor = (text, anchor) => String(text || '').toLowerCase().includes(String(anchor || '').toLowerCase().trim());

const SYSTEM = `You are an expert SEO editor placing ONE backlink inside an existing blog post (a "niche edit").
You get the post as numbered sentences, the anchor text and the target URL the anchor will link to.
Return ONLY a JSON object:
{"replace":{"sentence":<number>,"new_text":"..."},"insert":{"after_sentence":<number>,"new_text":"..."}}

Rules:
- replace: pick the sentence whose topic best fits the anchor/target. new_text = that same sentence lightly rewritten so it naturally contains the anchor text. Keep its meaning, tone and roughly its length.
- insert: pick the sentence after which a link fits best (preferably a different spot than replace). new_text = 1–2 NEW sentences that flow naturally after it and contain the anchor text.
- new_text MUST contain the anchor text exactly as given (same words, same order).
- Use the anchor exactly once, never stuff keywords, never mention "click here", the target URL, or the brand being paid.
- Plain text only: no HTML, no markdown, no quotes around the anchor.
- Write in the same language and style as the article. Avoid the very first sentence and obvious headings or captions.`;

/** One Chat Completions call → { json, usage } */
const callModel = async (messages) => {
    const body = {
        model: MODEL(),
        messages,
        response_format: { type: 'json_object' },
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        reasoning_effort: 'low'
    };
    let res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
    });
    let data = await res.json().catch(() => ({}));
    // Older/non-reasoning models don't accept reasoning_effort – retry once without it
    if (res.status === 400 && /reasoning_effort/i.test(data?.error?.message || '')) {
        delete body.reasoning_effort;
        res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000)
        });
        data = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
        const e = new Error(data?.error?.message || `OpenAI error ${res.status}`);
        e.status = res.status;
        e.code = data?.error?.code;
        throw e;
    }
    const usage = { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 };
    usage.cost = (usage.in * PRICE_IN() + usage.out * PRICE_OUT()) / 1e6;
    let json = null;
    try { json = JSON.parse(data.choices?.[0]?.message?.content || ''); } catch { /* invalid → null */ }
    return { json, usage };
};

/** Checks the model's answer against the sentence list; returns problems (empty = good) */
const problemsWith = (json, sentences, anchor) => {
    const p = [];
    const r = json?.replace, ins = json?.insert;
    const rIdx = Number(r?.sentence), iIdx = Number(ins?.after_sentence);
    if (!(rIdx >= 1 && rIdx <= sentences.length)) p.push('replace.sentence must be one of the sentence numbers');
    if (!(iIdx >= 1 && iIdx <= sentences.length)) p.push('insert.after_sentence must be one of the sentence numbers');
    if (!containsAnchor(r?.new_text, anchor)) p.push(`replace.new_text must contain the exact anchor text "${anchor}"`);
    if (!containsAnchor(ins?.new_text, anchor)) p.push(`insert.new_text must contain the exact anchor text "${anchor}"`);
    if (rIdx >= 1 && sentences[rIdx - 1] && String(r?.new_text || '').trim() === sentences[rIdx - 1]) p.push('replace.new_text must differ from the original sentence');
    if (/<[a-z][^>]*>|\]\(|https?:\/\//i.test(`${r?.new_text || ''} ${ins?.new_text || ''}`)) p.push('new_text must be plain text without links, HTML or markdown');
    return p;
};

const saveResult = async (detailId, row) => {
    await query(
        `INSERT INTO niche_edit_suggestions (detail_id, post_url, anchor, status, replace_text, replace_new, insert_after, insert_new, message,
                                             model, tokens_in, tokens_out, cost_usd, total_cost_usd, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,NOW())
         ON CONFLICT (detail_id) DO UPDATE SET post_url = EXCLUDED.post_url, anchor = EXCLUDED.anchor, status = EXCLUDED.status,
            replace_text = EXCLUDED.replace_text, replace_new = EXCLUDED.replace_new, insert_after = EXCLUDED.insert_after,
            insert_new = EXCLUDED.insert_new, message = EXCLUDED.message, model = EXCLUDED.model, tokens_in = EXCLUDED.tokens_in,
            tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd,
            total_cost_usd = niche_edit_suggestions.total_cost_usd + EXCLUDED.cost_usd, updated_at = NOW()`,
        [detailId, row.post_url, row.anchor, row.status, row.replace_text || null, row.replace_new || null, row.insert_after || null,
            row.insert_new || null, row.message || null, row.model || null, row.tokens_in || 0, row.tokens_out || 0, row.cost || 0]
    );
};

const publicView = (r) => ({
    detail_id: Number(r.detail_id), status: r.status, message: r.message,
    replace_text: r.replace_text, replace_new: r.replace_new, insert_after: r.insert_after, insert_new: r.insert_new,
    created_at: r.updated_at
});

const inFlight = new Map(); // detail id → promise (stops double calls, e.g. two tabs / React double effects)

/**
 * Suggestion for one Niche Edit site. Returns the saved one when it matches the same post + anchor,
 * unless regenerate = true (the only way to spend money again on the same site).
 */
const suggestFor = async ({ detailId, postUrl, anchor, targetUrl, regenerate = false }) => {
    await ensureSchema();
    if (!regenerate) {
        const saved = (await query(`SELECT * FROM niche_edit_suggestions WHERE detail_id = $1`, [detailId])).rows[0];
        // Re-use anything except a hit daily limit (that should retry once the limit resets)
        if (saved && saved.post_url === postUrl && saved.anchor === anchor && saved.status !== 'limit') return publicView(saved);
    }
    if (inFlight.has(detailId)) return inFlight.get(detailId);

    const work = (async () => {
        const base = { post_url: postUrl, anchor, model: MODEL() };
        if (!isConfigured()) return { ...base, status: 'failed', message: 'AI suggestions are not set up (no OpenAI key).' };
        if (await spentToday() >= DAILY_LIMIT()) {
            return { ...base, status: 'limit', message: `Today's AI budget ($${DAILY_LIMIT()}) is used up – please fill in manually or try tomorrow.` };
        }

        const page = await getPage(postUrl);
        const all = page.status === 'ok' ? toSentences(page.body_text) : [];
        // Sentences that already mention the anchor are left out, so we never rewrite/duplicate an existing mention
        const sentences = all.filter(x => !containsAnchor(x, anchor));
        const alreadyMentioned = all.length - sentences.length;
        if (sentences.length < 3) {
            return { ...base, status: 'unreadable', message: page.status === 'blocked'
                ? 'This site blocks automatic reading – please fill in manually.'
                : "Couldn't read this post – please fill in manually." };
        }

        const userMsg = `Anchor text: "${anchor}"\nTarget URL (the anchor links here; use it only to understand the topic): ${targetUrl}\nPost URL: ${postUrl}\n\nPost sentences:\n`
            + sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
        const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }];

        let totalIn = 0, totalOut = 0, totalCost = 0, json = null, problems = ['no answer'];
        for (let attempt = 0; attempt < 2 && problems.length; attempt++) {
            // Each call is logged before anything else, so the daily limit counts every cent
            const { json: answer, usage } = await callModel(messages);
            totalIn += usage.in; totalOut += usage.out; totalCost += usage.cost;
            await query(`INSERT INTO ai_usage_log (feature, model, tokens_in, tokens_out, cost_usd, ref_id) VALUES ('niche_suggest',$1,$2,$3,$4,$5)`,
                [MODEL(), usage.in, usage.out, usage.cost, detailId]);
            json = answer;
            problems = problemsWith(json, sentences, anchor);
            if (problems.length && attempt === 0) {
                messages.push({ role: 'assistant', content: JSON.stringify(json || {}) });
                messages.push({ role: 'user', content: `Fix these problems and answer with the full JSON again:\n- ${problems.join('\n- ')}` });
            }
        }
        const usage = { tokens_in: totalIn, tokens_out: totalOut, cost: totalCost };
        if (problems.length) return { ...base, ...usage, status: 'failed', message: 'The AI could not make a usable suggestion – please fill in manually or try Regenerate.' };

        return {
            ...base, ...usage, status: 'ok',
            message: alreadyMentioned ? `Heads-up: this post already mentions "${anchor}" ${alreadyMentioned === 1 ? 'once' : alreadyMentioned + ' times'} – check the link isn't already there.` : null,
            replace_text: sentences[Number(json.replace.sentence) - 1],
            replace_new: String(json.replace.new_text).trim(),
            insert_after: sentences[Number(json.insert.after_sentence) - 1],
            insert_new: String(json.insert.new_text).trim()
        };
    })().then(async (row) => {
        await saveResult(detailId, row);
        return publicView((await query(`SELECT * FROM niche_edit_suggestions WHERE detail_id = $1`, [detailId])).rows[0]);
    }).catch(async (err) => {
        console.error('[NicheSuggest] failed for detail', detailId, err.message);
        const message = err.status === 401 ? 'The OpenAI key is not valid.'
            : err.status === 429 || err.code === 'insufficient_quota' ? 'The OpenAI account has no credit or is rate-limited – please fill in manually.'
                : 'AI suggestion failed – please fill in manually or try Regenerate.';
        return { detail_id: detailId, status: 'failed', message };
    }).finally(() => inFlight.delete(detailId));

    inFlight.set(detailId, work);
    return work;
};

module.exports = { suggestFor, isConfigured, ensureSchema, toSentences };
