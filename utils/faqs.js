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

module.exports = { CATEGORIES, ensureSchema, list, listActive, get, create, update, remove };
