/**
 * Link Checker Background Job
 * Runs every minute to check link status in batches
 */

const cron = require('node-cron');
const pool = require('../config/database');
const axios = require('axios');
const cheerio = require('cheerio');

// Configuration
const BATCH_SIZE = 10; // Check 10 links per minute to avoid rate limiting
const CHECK_INTERVAL = '* * * * *'; // Every minute

// Helper for DB queries
const query = (text, params) => pool.query(text, params);

/**
 * Check a single link
 */
async function checkSingleLink(link) {
    const { id, submit_url, client_website, anchor } = link;

    let linkStatus = 'Not Found';
    let checkResult = '';

    try {
        console.log(`[LinkChecker] Checking: ${submit_url}`);
        console.log(`[LinkChecker] Looking for: ${client_website}`);

        const response = await axios.get(submit_url, {
            timeout: 15000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            },
            validateStatus: (status) => status >= 200 && status < 500
        });

        if (response.status === 404) {
            linkStatus = 'Not Found';
            checkResult = 'Page Not Found (404)';
        } else if (response.status < 200 || response.status >= 300) {
            linkStatus = 'Issue';
            checkResult = `Issue! Status ${response.status}`;
        } else {
            const $ = cheerio.load(response.data);

            // Normalize client website
            let cleanClientWebsite = client_website.toLowerCase();
            if (cleanClientWebsite.endsWith('/')) {
                cleanClientWebsite = cleanClientWebsite.slice(0, -1);
            }
            const clientDomain = cleanClientWebsite.replace(/^https?:\/\//, '');

            let found = false;
            $('a').each((i, el) => {
                const linkEl = $(el);
                let href = linkEl.attr('href');
                const text = linkEl.text().trim();
                const rel = linkEl.attr('rel') || '';

                if (!href) return;

                let cleanHref = href.toLowerCase();
                if (cleanHref.endsWith('/')) {
                    cleanHref = cleanHref.slice(0, -1);
                }
                const hrefDomain = cleanHref.replace(/^https?:\/\//, '');

                if (hrefDomain.includes(clientDomain) || cleanHref.includes(clientDomain)) {
                    found = true;

                    if (anchor && anchor.trim() !== '') {
                        // Normalize: collapse all whitespace (incl. &nbsp;), lowercase
                        const normalizedExpected = anchor.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                        const normalizedActual = text.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                        if (normalizedActual.includes(normalizedExpected) ||
                            normalizedExpected.includes(normalizedActual)) {
                            linkStatus = 'Live';
                            const classification = rel.includes('nofollow') ? 'Nofollow' : 'Dofollow';
                            checkResult = `Live - ${classification}`;
                        } else {
                            linkStatus = 'Issue';
                            checkResult = `Issue! Anchor Mismatch`;
                        }
                    } else {
                        linkStatus = 'Live';
                        const classification = rel.includes('nofollow') ? 'Nofollow' : 'Dofollow';
                        checkResult = `Live - ${classification}`;
                    }
                    return false;
                }
            });

            if (!found) {
                linkStatus = 'Not Found';
                checkResult = `Link to ${clientDomain} not found`;
            }
        }

    } catch (error) {
        linkStatus = 'Error';
        checkResult = error.code === 'ETIMEDOUT' ? 'Timeout' :
            error.code === 'ENOTFOUND' ? 'Domain Not Found' :
                'Error';
    }

    // Update database
    await query(
        `UPDATE new_order_process_details
         SET link_status = $1, link_check_result = $2, last_checked_at = NOW()
         WHERE id = $3`,
        [linkStatus, checkResult, id]
    );

    console.log(`[LinkChecker] Result for ${id}: ${linkStatus} - ${checkResult}`);
    return { id, linkStatus, checkResult };
}

/**
 * Run batch check
 */
async function runBatchCheck() {
    try {
        console.log('[LinkChecker] Starting batch check...');

        // Get links that need checking (oldest checked first, or never checked)
        const result = await query(`
            SELECT 
                nopd.id,
                nopd.submit_url,
                no.client_website,
                nopd.anchor
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            WHERE nopd.submit_url IS NOT NULL 
              AND nopd.submit_url != ''
            ORDER BY 
                CASE WHEN nopd.last_checked_at IS NULL THEN 0 ELSE 1 END,
                nopd.last_checked_at ASC
            LIMIT $1
        `, [BATCH_SIZE]);

        if (result.rows.length === 0) {
            console.log('[LinkChecker] No links to check');
            return;
        }

        console.log(`[LinkChecker] Checking ${result.rows.length} links...`);

        // Process links sequentially to avoid rate limiting
        for (const link of result.rows) {
            await checkSingleLink(link);
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('[LinkChecker] Batch check complete');

    } catch (error) {
        console.error('[LinkChecker] Error:', error.message);
    }
}

/**
 * Start the cron job
 */
function startLinkChecker() {
    console.log('[LinkChecker] Starting automated link checker...');
    console.log(`[LinkChecker] Will check ${BATCH_SIZE} links every minute`);

    cron.schedule(CHECK_INTERVAL, () => {
        runBatchCheck();
    });

    // Run immediately on startup
    runBatchCheck();
}

module.exports = { startLinkChecker, runBatchCheck, checkSingleLink };
