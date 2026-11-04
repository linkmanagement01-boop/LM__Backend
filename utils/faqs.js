/**
 * FAQs shown on the public FAQ page (/faq), managed in Admin → More Links → FAQs.
 * Each FAQ belongs to one tab (category) and is shown in sort_order within it.
 */
const { query } = require('../config/database');

const CATEGORIES = ['advertiser', 'publisher', 'content_writing'];
const cleanCategory = (c) => (CATEGORIES.includes(c) ? c : 'advertiser');
const cleanOrder = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : 0);

const ensureSchema = async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS faqs (
            id SERIAL PRIMARY KEY,
            question TEXT NOT NULL,
            answer TEXT,
            active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
    await query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    // existing FAQs land in the first tab
    await query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS category VARCHAR(30) NOT NULL DEFAULT 'advertiser'`);
    await query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
};

const COLS = `id, question, answer, COALESCE(active, true) AS is_active, category, sort_order, created_at, updated_at`;
const ORDER = `category, sort_order, id`;

const list = async () => (await query(`SELECT ${COLS} FROM faqs ORDER BY ${ORDER}`)).rows;
const listActive = async () => (await query(`SELECT id, question, answer, category FROM faqs WHERE COALESCE(active, true) ORDER BY ${ORDER}`)).rows;
const get = async (id) => (await query(`SELECT ${COLS} FROM faqs WHERE id = $1`, [id])).rows[0] || null;

const create = async ({ question, answer, is_active = true, category, sort_order }) => (await query(
    `INSERT INTO faqs (question, answer, active, category, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${COLS}`,
    [question, answer, is_active !== false, cleanCategory(category), cleanOrder(sort_order)]
)).rows[0];

const update = async (id, { question, answer, is_active, category, sort_order }) => (await query(
    `UPDATE faqs SET question = $1, answer = $2, active = $3, category = $4, sort_order = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6 RETURNING ${COLS}`,
    [question, answer, is_active !== false, cleanCategory(category), cleanOrder(sort_order), id]
)).rows[0] || null;

const remove = async (id) => (await query(`DELETE FROM faqs WHERE id = $1 RETURNING id`, [id])).rows[0] || null;

/**
 * One-time: the FAQ page's first questions (edit or delete them in Admin → FAQs afterwards).
 * Runs once (marker in faq_jobs), so FAQs deleted later never come back; also removes the old test FAQ.
 */
const SEED_JOB = 'starter_faqs_v1';
const STARTER = {
    advertiser: [
        ['What does each order status mean?', `<p>The status shows the stage of your order and changes as it moves forward:</p>
<ul><li><strong>New:</strong> the order is placed and waiting for the publisher to accept or reject it.</li>
<li><strong>In progress:</strong> the publisher has accepted it and the work has started.</li>
<li><strong>Your approval:</strong> the publisher has submitted the live link. Accept it or tell us the changes you need. If you don't respond within 48 hours, it is approved automatically.</li>
<li><strong>Completed:</strong> the live link is approved and the order is finished. Changes can no longer be requested.</li></ul>`],
        ['How do I place an order?', `<p>Tell us your website, the number of links, the order type (guest post or niche edit), the category and any instructions. Our team picks matching sites, the article is prepared, and the publisher puts it live. You get the live link once it is checked.</p>`],
        ["What's the difference between a guest post and a niche edit?", `<p>A <strong>guest post</strong> is a new article written for your order and published on the site with your link. A <strong>niche edit</strong> adds your link to an article that is already live on the site.</p>`],
        ['Can I give instructions for my order?', `<p>Yes. Add your target URL, anchor text and any notes about the topic or tone when the order is placed. They go to the writer and the publisher with the order.</p>`],
        ['What happens if a link is removed later?', `<p>We keep checking published links. If a link is removed or has an issue, our team sees it and follows it up with the publisher.</p>`]
    ],
    publisher: [
        ['Is it free to join as a publisher?', `<p>Yes. Create a free account, add your websites and start receiving orders once they are approved.</p>`],
        ['How do I add my websites?', `<p>After signing up, add your sites one by one or upload many at once with an Excel file. Our team reviews every site before it can receive orders.</p>`],
        ['Why was my site not approved?', `<p>We look at each site's organic traffic, authority and content quality. Sites with very low organic traffic or quality issues may not be approved. You can add the site again once it has grown.</p>`],
        ['How do I receive and complete orders?', `<p>New orders appear in your dashboard and are sent to your email. Accept or reject each one. Once the post is published, submit the live URL from your dashboard so our team can check it.</p>`],
        ['What if my submitted link is sent back?', `<p>If something needs fixing, our team sends the order back with the reason. Make the change and submit the live URL again.</p>`],
        ['When and how do I get paid?', `<p>When our team approves your live link, the amount is added to your wallet. Once your balance reaches the minimum withdrawal amount shown in your wallet, request a withdrawal by PayPal, bank transfer or UPI (the options depend on your country). Our team approves the request and sends the payment.</p>`]
    ],
    content_writing: [
        ['Do you write the content for my order?', `<p>Yes. For guest posts, our writers prepare the article from your order's instructions, and our managers review it before it goes to the publisher.</p>`],
        ['Can I send my own article?', `<p>Yes. Share your article with the order and it goes straight to the publisher, without the writing step.</p>`],
        ['What should I include in my instructions?', `<p>Your target URL, the anchor text, the topic or angle you want, and anything to avoid. Clear instructions help the writer get it right the first time.</p>`],
        ['Who checks the article before it is published?', `<p>Every article written by our team is reviewed by a manager before it is sent to the publisher, so it matches your instructions and the site's guidelines.</p>`]
    ]
};
const seedStarterFaqs = async () => {
    await query(`CREATE TABLE IF NOT EXISTS faq_jobs (name VARCHAR(60) PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const claimed = await query(`INSERT INTO faq_jobs (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name`, [SEED_JOB]);
    if (!claimed.rows.length) return; // already done
    try {
        // the old test entry ("fdg" / "fg")
        await query(`DELETE FROM faqs WHERE question = '<p>fdg</p>' AND answer = '<p>fg</p>'`);
        for (const [category, items] of Object.entries(STARTER)) {
            for (const [i, [question, answer]] of items.entries()) {
                await create({ question, answer, category, sort_order: i + 1 });
            }
        }
        console.log('❓ Starter FAQs added');
    } catch (err) {
        await query(`DELETE FROM faq_jobs WHERE name = $1`, [SEED_JOB]); // try again on the next start
        throw err;
    }
};

module.exports = { CATEGORIES, ensureSchema, seedStarterFaqs, list, listActive, get, create, update, remove };
