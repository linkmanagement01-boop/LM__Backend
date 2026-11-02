/**
 * Plan emails for marketplace clients (in the marketplace's own brand) + the hourly plan job:
 *   - removes wallet money that is more than 12 months old ("Expired funds" debit)
 *   - warns 30 / 7 / 1 days before money expires and before a Pro account is deactivated
 *   - deactivates Pro clients with no order for 12 months (never while an order is open)
 * Every warning is sent once (marketplace_plan_reminders).
 */

const { query, transaction } = require('../config/database');
const { sendEmail } = require('./emailService');
const mp = require('./marketplace');
const plans = require('./marketplacePlan');

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const DAY = 86400000;
const daysUntil = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / DAY));
const inDays = (n) => (n <= 1 ? 'tomorrow' : `in ${n} days`);

const send = async (client, kind, data = {}) => {
    const brand = mp.getBrand(client.marketplace || mp.DEFAULT_MARKETPLACE);
    const name = esc(client.name || 'there');
    const content = {
        pro: [`You're on Pro – ${brand.name}`, `
            <h2>You're on Pro, ${name}! 🎉</h2>
            <p>You now have <strong>full access for life</strong> to every publisher site – full domain names, all pages and samples.</p>
            <p>Your wallet balance is yours to spend on orders – nothing was charged for the plan.
               Wallet money is valid for ${plans.VALID_MONTHS} months from the day it was added.</p>
            <a href="${brand.url}/" class="btn">Browse all sites →</a>`],
        funds_reminder: [`${usd(data.amount)} in your wallet expires ${inDays(data.days)} – ${brand.name}`, `
            <h2>Hi ${name},</h2>
            <p><strong>${usd(data.amount)}</strong> of your wallet balance expires on <strong>${fmt(data.date)}</strong>.
               Wallet money is valid for ${plans.VALID_MONTHS} months from the day it was added.</p>
            <p>Place an order before then so you don't lose it.</p>
            <a href="${brand.url}/" class="btn">Browse sites →</a>`],
        funds_expired: [`${usd(data.amount)} of your wallet balance has expired – ${brand.name}`, `
            <h2>Hi ${name},</h2>
            <p><strong>${usd(data.amount)}</strong> of your wallet balance was more than ${plans.VALID_MONTHS} months old and has expired.
               You can see it in your transactions as "Expired funds".</p>
            <p>Questions? Just chat with us from the Support page.</p>
            <a href="${brand.url}/transactions" class="btn">View transactions →</a>`],
        deact_reminder: [`Your account will be paused ${inDays(data.days)} – ${brand.name}`, `
            <h2>Hi ${name},</h2>
            <p>You haven't placed an order for a while. Pro accounts are paused after ${plans.INACTIVE_MONTHS} months without an order.</p>
            <div class="highlight-box"><p class="label">Place an order before</p><p class="value">${fmt(data.date)}</p></div>
            <p>Any order keeps your account active for another ${plans.INACTIVE_MONTHS} months.</p>
            <a href="${brand.url}/" class="btn">Browse sites →</a>`],
        deactivated: [`Your account has been paused – ${brand.name}`, `
            <h2>Hi ${name},</h2>
            <p>Your account has been paused because no order was placed for ${plans.INACTIVE_MONTHS} months.</p>
            <p>You can still log in – just open <strong>Support</strong> and chat with us, and we'll reactivate your account.</p>
            <a href="${brand.url}/support" class="btn">Chat with support →</a>`],
        reactivated: [`Your account is active again – ${brand.name}`, `
            <h2>Welcome back, ${name}!</h2>
            <p>Your account has been reactivated – you have full access to every page again.</p>
            <a href="${brand.url}/" class="btn">Browse sites →</a>`]
    }[kind];
    if (!content || !client.email) return false;
    return sendEmail(client.email, content[0], content[1], { brand });
};

/** Plan email for the client in the request (e.g. "You're on Pro") */
const sendPlanEmail = async (req, kind, data) => send({ ...req.client, marketplace: req.params.marketplace }, kind, data);
/** Plan email for any marketplace client by id */
const sendPlanEmailTo = async (clientId, kind, data) => {
    const u = (await query(`SELECT id, name, email, marketplace FROM users WHERE id = $1 AND marketplace IS NOT NULL`, [clientId])).rows[0];
    return u ? send(u, kind, data) : false;
};

/** Sends the most urgent warning due for `ref` once (30 → 7 → 1 days); marks the bigger ones as sent too */
const warnOnce = async (client, ref, days, kind, data) => {
    const due = plans.REMIND_DAYS.filter(d => days <= d);
    if (!due.length) return false;
    const urgent = Math.min(...due);
    const inserted = (await query(
        `INSERT INTO marketplace_plan_reminders (client_user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING key`,
        [client.id, `${ref}:${urgent}`]
    )).rows.length;
    for (const d of due.filter(d => d !== urgent)) {
        await query(`INSERT INTO marketplace_plan_reminders (client_user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [client.id, `${ref}:${d}`]);
    }
    if (!inserted || client.status !== 1) return false;
    await send(client, kind, { ...data, days }).catch(() => false);
    return true;
};

/** Removes this client's expired money (inside one wallet-locked transaction). Returns the amount removed. */
const expireFunds = async (clientId) => transaction(async (tx) => {
    const wallet = (await tx.query(`SELECT id, balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, [clientId])).rows[0];
    if (!wallet) return 0;
    const now = new Date();
    const due = (await plans.replayLots(clientId, tx)).filter(l => l.remaining > 0 && l.expires_at <= now);
    let balance = Math.round(Number(wallet.balance || 0) * 100);
    let removed = 0;
    for (const lot of due) {
        const amount = Math.min(lot.remaining, balance);
        if (amount <= 0) continue;
        balance -= amount;
        removed += amount;
        await tx.query(
            `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
             VALUES ($1, 'Debit', $2, $3, 1, NOW(), NOW(), NOW())`,
            [wallet.id, amount / 100, `${plans.EXPIRED_REMARK} (added ${fmt(lot.added_at)}, valid ${plans.VALID_MONTHS} months)`]
        );
    }
    if (removed > 0) {
        await tx.query(`UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`, [balance / 100, wallet.id]);
        await tx.query(`INSERT INTO marketplace_plan_events (client_user_id, kind, amount, note) VALUES ($1, 'expired', $2, 'Wallet money older than 12 months')`, [clientId, removed / 100]);
    }
    return removed / 100;
});

/** Pauses a Pro client (only Support works). Returns true when it happened now. */
const deactivate = async (clientId) => {
    const row = (await query(
        `UPDATE marketplace_plans SET deactivated_at = NOW(), updated_at = NOW()
         WHERE client_user_id = $1 AND pro_since IS NOT NULL AND deactivated_at IS NULL RETURNING client_user_id`, [clientId]
    )).rows[0];
    if (row) await query(`INSERT INTO marketplace_plan_events (client_user_id, kind, note) VALUES ($1, 'deactivated', 'No order for 12 months')`, [clientId]);
    return !!row;
};

/** The plan job for one client: expire old money, warn about money / pause coming up, pause when due */
const processClient = async (c, done = { expired: 0, warned: 0, deactivated: 0 }) => {
    const removed = await expireFunds(c.id);
    if (removed > 0) {
        done.expired++;
        if (c.status === 1) await send(c, 'funds_expired', { amount: removed }).catch(() => false);
    }
    const plan = await plans.getPlan(c.id);
    // Money expiring soon (one warning per lot)
    for (const lot of plan.funds.lots) {
        if (await warnOnce(c, `funds:${lot.id}`, daysUntil(lot.expires_at), 'funds_reminder', { amount: lot.remaining, date: lot.expires_at })) done.warned++;
    }
    // Pro without an order for 12 months
    if (plan.tier === 'pro' && plan.deactivates_on) {
        if (new Date(plan.deactivates_on) <= new Date()) {
            if (!(await plans.hasOpenOrder(c.id)) && await deactivate(c.id)) {
                done.deactivated++;
                if (c.status === 1) await send(c, 'deactivated').catch(() => false);
            }
        } else if (await warnOnce(c, `deact:${new Date(plan.deactivates_on).toISOString().slice(0, 10)}`, daysUntil(plan.deactivates_on), 'deact_reminder', { date: plan.deactivates_on })) {
            done.warned++;
        }
    }
    return done;
};

/** Hourly plan job for every marketplace client */
const runPlanJob = async () => {
    await plans.ensureSchema();
    const clients = (await query(
        `SELECT u.id, u.name, u.email, u.marketplace, u.status FROM users u
         WHERE u.role = 'client' AND u.marketplace IS NOT NULL ORDER BY u.id`
    )).rows;
    const done = { expired: 0, warned: 0, deactivated: 0 };
    for (const c of clients) {
        await processClient(c, done).catch(err => console.error(`[Plans] job failed for client ${c.id}:`, err.message));
    }
    if (done.expired || done.warned || done.deactivated) {
        console.log(`[Plans] ${done.expired} wallet(s) expired, ${done.warned} warning(s) sent, ${done.deactivated} account(s) paused`);
    }
    return done;
};

const startPlanReminders = () => {
    const tick = () => runPlanJob().catch(err => console.error('[Plans] job failed:', err.message));
    setTimeout(tick, 2 * 60 * 1000);
    setInterval(tick, 60 * 60 * 1000);
};

module.exports = { sendPlanEmail, sendPlanEmailTo, runPlanJob, processClient, expireFunds, deactivate, startPlanReminders };
