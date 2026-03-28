const pool = require('../config/database');
const axios = require('axios');
const cheerio = require('cheerio');

// Helper for DB queries
const query = (text, params) => pool.query(text, params);

// Track bulk check status
let bulkCheckStatus = {
    running: false,
    total: 0,
    checked: 0,
    live: 0,
    notFound: 0,
    errors: 0
};

/**
 * @route   GET /api/admin/sites/link-completed
 * @desc    Get completed links grouped by client with stats
 * @access  Admin
 */
const getCompletedLinks = async (req, res, next) => {
    try {
        const { year, page = 1, limit = 50, status } = req.query;
        const offset = (page - 1) * limit;

        // Build WHERE clause - links where blogger has submitted (submit_url is filled)
        let whereClause = `WHERE nopd.submit_url IS NOT NULL AND nopd.submit_url != ''`;
        const params = [];

        if (year) {
            params.push(year);
            whereClause += ` AND EXTRACT(YEAR FROM nopd.updated_at) = $${params.length}`;
        }

        // Status filter for clickable cards
        if (status === 'live') {
            whereClause += ` AND nopd.link_status = 'Live'`;
        } else if (status === 'removed') {
            whereClause += ` AND nopd.link_status NOT IN ('Live', 'Pending Check') AND nopd.link_status IS NOT NULL`;
        }

        // 1. Get Stats (Dashboard Cards)
        const statsQuery = `
            SELECT
                COUNT(*) as total_completed,
                COUNT(CASE WHEN nopd.link_status = 'Live' THEN 1 END) as live_count,
                COUNT(CASE WHEN nopd.link_status NOT IN ('Live', 'Pending Check') AND nopd.link_status IS NOT NULL THEN 1 END) as issue_count
            FROM new_order_process_details nopd
            ${whereClause}
        `;
        const statsResult = await query(statsQuery, params);
        const stats = statsResult.rows[0];

        // 2. Get all completed links with client info
        // IMPORTANT: client_website is what should be LINKED TO on the blogger's page
        const dataQuery = `
            SELECT
                nopd.id as detail_id,
                no.client_name,
                no.client_website,
                nopd.url as target_url,
                nopd.anchor as anchor_text,
                nopd.submit_url as blogger_link,
                nopd.link_status,
                nopd.link_check_result,
                nopd.last_checked_at,
                nopd.updated_at as completed_date
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            ${whereClause}
            ORDER BY no.client_name, no.client_website, nopd.updated_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const dataParams = [...params, limit, offset];
        const dataResult = await query(dataQuery, dataParams);

        // Group by client_name + client_website
        const groupedData = [];
        let currentGroup = null;

        dataResult.rows.forEach(row => {
            const groupKey = `${row.client_name}|${row.client_website}`;

            if (!currentGroup || currentGroup.groupKey !== groupKey) {
                if (currentGroup) {
                    groupedData.push(currentGroup);
                }
                currentGroup = {
                    groupKey,
                    client_name: row.client_name,
                    client_website: row.client_website,
                    link_count: 0,
                    links: []
                };
            }

            currentGroup.link_count++;
            currentGroup.links.push({
                detail_id: row.detail_id,
                target_url: row.target_url,
                anchor_text: row.anchor_text,
                blogger_link: row.blogger_link,
                link_status: row.link_status,
                link_check_result: row.link_check_result,
                last_checked_at: row.last_checked_at
            });
        });

        if (currentGroup) {
            groupedData.push(currentGroup);
        }

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) 
            FROM new_order_process_details nopd
            ${whereClause}
        `;
        const countResult = await query(countQuery, params);
        const totalItems = parseInt(countResult.rows[0].count);

        res.json({
            stats: {
                completed: parseInt(stats.total_completed) || 0,
                live: parseInt(stats.live_count) || 0,
                removed: parseInt(stats.issue_count) || 0
            },
            data: groupedData,
            pagination: {
                total: totalItems,
                page: parseInt(page),
                pages: Math.ceil(totalItems / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching completed links:', error);
        next(error);
    }
};

/**
 * @route   POST /api/admin/sites/check-link-status
 * @desc    Check if a blogger's page contains a link to the client's website
 * @access  Admin
 * 
 * CORRECT Logic from client's script:
 * - primaryUrl (bloggerLink) = The blogger's submitted page to FETCH
 * - secondaryUrl (clientWebsite) = The CLIENT'S URL that should be LINKED on the blogger's page
 * - textAnchor = Expected anchor text
 * 
 * Example:
 * - bloggerLink: https://www.mindxmaster.com/why-hiring-a-skip-bin-is-beneficial-to-business/
 * - clientWebsite: https://prontoskip.co.uk/
 * - anchorText: "Pronto Skip"
 * 
 * The script fetches the blogger's page and looks for <a href="prontoskip.co.uk">Pronto Skip</a>
 */
const checkLinkStatus = async (req, res, next) => {
    try {
        const { detailId, bloggerLink, clientWebsite, anchorText } = req.body;

        if (!bloggerLink) {
            return res.status(400).json({ error: 'Blogger link is required' });
        }

        if (!clientWebsite) {
            return res.status(400).json({ error: 'Client website is required' });
        }

        let linkStatus = 'Not Found';
        let linkClassification = 'Link Removed';
        let checkResult = '';

        try {
            // Step 1: Fetch the blogger's page (primaryUrl)
            console.log(`Checking blogger page: ${bloggerLink}`);
            console.log(`Looking for link to: ${clientWebsite}`);
            console.log(`Expected anchor: ${anchorText}`);

            const response = await axios.get(bloggerLink, {
                timeout: 20000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
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
                // Step 2: Parse HTML with cheerio
                const $ = cheerio.load(response.data);

                // Normalize client website URL for comparison
                let cleanClientWebsite = clientWebsite.toLowerCase();
                // Remove trailing slash
                if (cleanClientWebsite.endsWith('/')) {
                    cleanClientWebsite = cleanClientWebsite.slice(0, -1);
                }
                // Remove protocol for flexible matching
                const clientDomain = cleanClientWebsite.replace(/^https?:\/\//, '');

                console.log(`Searching for domain: ${clientDomain}`);

                // Step 3: Search all anchor tags for link to client website
                let foundAnyLink = false;
                let foundMatchingAnchor = false;
                let bestMismatchText = null;
                let finalRel = 'Dofollow';

                $('a').each((i, el) => {
                    const link = $(el);
                    let href = link.attr('href');
                    let text = link.text().trim();
                    const rel = link.attr('rel') || '';

                    if (!href) return;

                    let cleanHref = href.toLowerCase();
                    if (cleanHref.endsWith('/')) {
                        cleanHref = cleanHref.slice(0, -1);
                    }
                    const hrefDomain = cleanHref.replace(/^https?:\/\//, '');

                    if (hrefDomain.includes(clientDomain) || cleanHref.includes(clientDomain)) {
                        foundAnyLink = true;

                        if (!anchorText || anchorText.trim() === '') {
                            foundMatchingAnchor = true;
                            finalRel = rel;
                            return false; 
                        } else {
                            // Normalize: collapse all whitespace (incl. &nbsp;), lowercase
                            let expected = anchorText.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            let actual = text.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            
                            if (actual === '') {
                                const imgAlt = link.find('img').attr('alt');
                                if (imgAlt) actual = imgAlt.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            }

                            if (actual !== '' && (actual.includes(expected) || expected.includes(actual))) {
                                foundMatchingAnchor = true;
                                finalRel = rel;
                                return false; 
                            } else if (actual !== '') {
                                if (!bestMismatchText) bestMismatchText = actual;
                            }
                        }
                    }
                });

                if (foundMatchingAnchor) {
                    linkStatus = 'Live';
                    linkClassification = finalRel.includes('nofollow') ? 'Nofollow' : 'Dofollow';
                    checkResult = `Live - ${linkClassification}`;
                } else if (foundAnyLink) {
                    linkStatus = 'Issue';
                    linkClassification = 'Mismatch';
                    checkResult = `Issue! Anchor Text (Expected: "${anchorText}", Found: "${bestMismatchText || 'Empty/Image Link'}")`;
                } else {
                    linkStatus = 'Not Found';
                    checkResult = `Link to ${clientDomain} not found on page`;
                }
            }

        } catch (error) {
            console.error('Link check error:', error.message);
            linkStatus = 'Error';
            checkResult = error.code === 'ECONNREFUSED' ? 'Connection Refused' :
                error.code === 'ETIMEDOUT' ? 'Request Timeout' :
                    error.code === 'ENOTFOUND' ? 'Domain Not Found' :
                        error.message || 'Scraping Error';
        }

        console.log(`Result: ${linkStatus} - ${checkResult}`);

        // Step 4: Update Database
        const updateQuery = `
            UPDATE new_order_process_details
            SET 
                link_status = $1,
                link_check_result = $2,
                last_checked_at = NOW()
            WHERE id = $3
            RETURNING link_status, link_check_result, last_checked_at
        `;

        const updateResult = await query(updateQuery, [linkStatus, checkResult, detailId]);

        res.json({
            status: linkStatus,
            result: checkResult,
            updated: updateResult.rows[0]
        });

    } catch (error) {
        console.error('Error checking link status:', error);
        next(error);
    }
};

/**
 * Helper: Check a single link (for bulk operations)
 */
async function checkSingleLinkInternal(link) {
    const { id, submit_url, client_website, anchor } = link;

    let linkStatus = 'Not Found';
    let checkResult = '';

    try {
        const response = await axios.get(submit_url, {
            timeout: 15000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml'
            },
            validateStatus: (status) => status >= 200 && status < 500
        });

        if (response.status === 404) {
            linkStatus = 'Not Found';
            checkResult = 'Page Not Found (404)';
        } else if (response.status < 200 || response.status >= 300) {
            linkStatus = 'Issue';
            checkResult = `Status ${response.status}`;
        } else {
            const $ = cheerio.load(response.data);

            let cleanClient = client_website.toLowerCase().replace(/\/$/, '');
            const clientDomain = cleanClient.replace(/^https?:\/\//, '');

            let found = false;
            $('a').each((i, el) => {
                let href = $(el).attr('href');
                const text = $(el).text().trim();
                const rel = $(el).attr('rel') || '';

                if (!href) return;

                let cleanHref = href.toLowerCase().replace(/\/$/, '');
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
                            checkResult = `Live - ${rel.includes('nofollow') ? 'Nofollow' : 'Dofollow'}`;
                        } else {
                            linkStatus = 'Issue';
                            checkResult = 'Anchor Mismatch';
                        }
                    } else {
                        linkStatus = 'Live';
                        checkResult = `Live - ${rel.includes('nofollow') ? 'Nofollow' : 'Dofollow'}`;
                    }
                    return false;
                }
            });

            if (!found) {
                linkStatus = 'Not Found';
                checkResult = 'Link not found';
            }
        }
    } catch (error) {
        linkStatus = 'Error';
        checkResult = error.code || 'Error';
    }

    // Update DB
    await query(
        `UPDATE new_order_process_details SET link_status = $1, link_check_result = $2, last_checked_at = NOW() WHERE id = $3`,
        [linkStatus, checkResult, id]
    );

    return { id, linkStatus, checkResult };
}

/**
 * @route   POST /api/admin/sites/bulk-check
 * @desc    Start bulk checking all links
 */
const startBulkCheck = async (req, res, next) => {
    try {
        if (bulkCheckStatus.running) {
            return res.json({ message: 'Bulk check already running', status: bulkCheckStatus });
        }

        // Get count of links to check
        const countResult = await query(`
            SELECT COUNT(*) FROM new_order_process_details 
            WHERE submit_url IS NOT NULL AND submit_url != ''
        `);
        const totalLinks = parseInt(countResult.rows[0].count);

        // Reset status
        bulkCheckStatus = {
            running: true,
            total: totalLinks,
            checked: 0,
            live: 0,
            notFound: 0,
            errors: 0
        };

        res.json({ message: 'Bulk check started', status: bulkCheckStatus });

        // Run in background (don't await)
        runBulkCheckInBackground();

    } catch (error) {
        console.error('Error starting bulk check:', error);
        next(error);
    }
};

/**
 * Background bulk check runner
 */
async function runBulkCheckInBackground() {
    const CONCURRENCY = 5; // Process 5 at a time
    const BATCH_SIZE = 100;

    try {
        console.log('[BulkCheck] Starting...');
        let offset = 0;

        while (bulkCheckStatus.running) {
            // Get batch
            const result = await query(`
                SELECT nopd.id, nopd.submit_url, no.client_website, nopd.anchor
                FROM new_order_process_details nopd
                JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
                JOIN new_orders no ON nop.new_order_id = no.id
                WHERE nopd.submit_url IS NOT NULL AND nopd.submit_url != ''
                ORDER BY nopd.id
                LIMIT $1 OFFSET $2
            `, [BATCH_SIZE, offset]);

            if (result.rows.length === 0) break;

            // Process in parallel with concurrency limit
            for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
                const batch = result.rows.slice(i, i + CONCURRENCY);
                const results = await Promise.all(batch.map(link => checkSingleLinkInternal(link)));

                results.forEach(r => {
                    bulkCheckStatus.checked++;
                    if (r.linkStatus === 'Live') bulkCheckStatus.live++;
                    else if (r.linkStatus === 'Not Found') bulkCheckStatus.notFound++;
                    else bulkCheckStatus.errors++;
                });

                console.log(`[BulkCheck] Progress: ${bulkCheckStatus.checked}/${bulkCheckStatus.total}`);
            }

            offset += BATCH_SIZE;
        }

        bulkCheckStatus.running = false;
        console.log('[BulkCheck] Complete!', bulkCheckStatus);

    } catch (error) {
        console.error('[BulkCheck] Error:', error);
        bulkCheckStatus.running = false;
    }
}

/**
 * @route   GET /api/admin/sites/bulk-check-status
 * @desc    Get bulk check progress
 */
const getBulkCheckStatus = async (req, res) => {
    res.json(bulkCheckStatus);
};

/**
 * @route   POST /api/admin/sites/stop-bulk-check
 * @desc    Stop bulk check
 */
const stopBulkCheck = async (req, res) => {
    bulkCheckStatus.running = false;
    res.json({ message: 'Bulk check stopped', status: bulkCheckStatus });
};

module.exports = {
    getCompletedLinks,
    checkLinkStatus,
    startBulkCheck,
    getBulkCheckStatus,
    stopBulkCheck
};
