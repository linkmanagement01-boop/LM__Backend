/**
 * Notifications for MARKETPLACE clients (email in the marketplace's own brand + an in-marketplace notification).
 * Internal client-area clients and all other users are ignored, so existing behaviour is unchanged.
 * Never throws – a failed notification must never break the team's workflow.
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const { sendEmail } = require('./emailService');
const { getBrand } = require('./marketplace');

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marketplaceClient = async (userId) => {
    const u = (await query(`SELECT id, name, email, role, marketplace FROM users WHERE id = $1`, [userId])).rows[0];
    return u && u.role === 'client' && u.marketplace ? u : null;
};

const addNotification = (userId, type, data) => query(
    `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
     VALUES ($1, $2, 'App\\Models\\User', $3, $4, NOW(), NOW())`,
    [crypto.randomUUID(), type, userId, JSON.stringify(data)]
);

/**
 * A link went live (manager approved the blogger's live URL) – call with the new_order_process_details id.
 */
const notifyLinkLive = async (processDetailId) => {
    try {
        const r = (await query(
            `SELECT co.client_user_id, co.marketplace_order_id, co.order_type, mo.order_number,
                    ns.root_domain, nopd.submit_url, cod.anchor_text, cod.target_url
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nop.id = nopd.new_order_process_id
             JOIN client_orders co ON co.linked_new_order_id = nop.new_order_id
             JOIN client_order_details cod ON cod.client_order_id = co.id AND cod.site_id = nopd.new_site_id
             LEFT JOIN marketplace_orders mo ON mo.id = co.marketplace_order_id
             LEFT JOIN new_sites ns ON ns.id = nopd.new_site_id
             WHERE nopd.id = $1 AND co.marketplace IS NOT NULL
             LIMIT 1`,
            [processDetailId]
        )).rows[0];
        if (!r) return;
        const client = await marketplaceClient(r.client_user_id);
        if (!client) return;
        const brand = getBrand(client.marketplace);
        await addNotification(client.id, 'link_live', {
            title: 'Your link is live',
            message: `Your ${r.order_type} on ${r.root_domain} is live.`,
            site: r.root_domain, live_url: r.submit_url, order_id: r.marketplace_order_id, order_number: r.order_number
        });
        await sendEmail(client.email, `✅ Your link on ${r.root_domain} is live – ${brand.name}`, `
            <h2>Good news, ${esc(client.name || '')}!</h2>
            <p>Your <strong>${esc(r.order_type)}</strong> on <strong>${esc(r.root_domain)}</strong> is now live.</p>
            <div class="highlight-box">
              <p class="label">Live URL</p><p class="value"><a href="${esc(r.submit_url)}">${esc(r.submit_url)}</a></p>
              <p class="label" style="margin-top:10px;">Anchor text</p><p class="value">${esc(r.anchor_text || '-')}</p>
              <p class="label" style="margin-top:10px;">Target URL</p><p class="value">${esc(r.target_url || '-')}</p>
            </div>
            ${r.order_number ? `<p>Order: <strong>${esc(r.order_number)}</strong></p>` : ''}
            <a href="${brand.url}/orders/${r.marketplace_order_id || ''}" class="btn">View my order →</a>`, { brand });
    } catch (err) {
        console.error('[MarketplaceNotify] link-live failed:', err.message);
    }
};

/**
 * Money was refunded to a marketplace client's wallet (site declined / order rejected).
 * @param {{clientUserId, amount, reason?, what?}} p   what = e.g. "example.com" or "order MP-…"
 */
const notifyRefund = async ({ clientUserId, amount, reason, what, notification = true }) => {
    try {
        const client = await marketplaceClient(clientUserId);
        if (!client) return;
        const brand = getBrand(client.marketplace);
        const amt = Number(amount || 0).toFixed(2);
        if (notification) await addNotification(client.id, 'refund', {
            title: 'Refund added to your wallet',
            message: `$${amt} was refunded to your wallet for ${what || 'your order'}.`,
            refund_amount: Number(amount), reason: reason || null
        });
        await sendEmail(client.email, `💰 $${amt} refunded to your wallet – ${brand.name}`, `
            <h2>Hello ${esc(client.name || '')},</h2>
            <p>We couldn't complete <strong>${esc(what || 'part of your order')}</strong>, so we've refunded
               <strong>$${amt}</strong> to your wallet. You can use it for your next order right away.</p>
            ${reason ? `<div class="highlight-box"><p class="label">Reason</p><p class="value">${esc(reason)}</p></div>` : ''}
            <a href="${brand.url}/wallet" class="btn">View my wallet →</a>`, { brand });
    } catch (err) {
        console.error('[MarketplaceNotify] refund failed:', err.message);
    }
};

module.exports = { notifyLinkLive, notifyRefund };
