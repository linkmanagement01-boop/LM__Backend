const path = require('path');
const { Worker } = require('worker_threads');
const { bareDomain } = require('../utils/contactFinder');

// at most 4 checks at the same time on the server (the page sends them one by one, 3 in parallel)
let running = 0;
const MAX_RUNNING = 4;
const CHECK_LIMIT_MS = 60000;

/** One check in its own worker thread, stopped after 60 s – a website can never freeze the server */
const runIsolated = (domain) => new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, '../utils/contactFinderWorker.js'), { workerData: { domain } });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve(value); };
    const timer = setTimeout(() => finish({ domain: bareDomain(domain), status: 'timeout', emails: [], socials: {}, pages_checked: [], contact_form: null, note: 'Site took too long – check by hand' }), CHECK_LIMIT_MS);
    worker.on('message', (msg) => finish(msg.result || { domain: bareDomain(domain), status: 'error', emails: [], socials: {}, pages_checked: [], note: msg.error || 'Check failed' }));
    worker.on('error', (err) => finish({ domain: bareDomain(domain), status: 'error', emails: [], socials: {}, pages_checked: [], note: `Check failed (${err.message})` }));
    worker.on('exit', () => finish({ domain: bareDomain(domain), status: 'error', emails: [], socials: {}, pages_checked: [], note: 'Check failed' }));
});

/**
 * @route POST /admin/contact-finder/check { domain }
 * Public e-mails + social profiles of one website. Nothing is saved.
 */
const checkDomain = async (req, res, next) => {
    try {
        const domain = String(req.body?.domain || '').trim().slice(0, 200);
        if (!domain) return res.status(400).json({ message: 'Domain is required' });
        if (running >= MAX_RUNNING) return res.status(429).json({ message: 'Too many checks at once – try again in a moment' });
        running++;
        try { res.json({ result: await runIsolated(domain) }); } finally { running--; }
    } catch (error) { next(error); }
};

module.exports = { checkDomain };
