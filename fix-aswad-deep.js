const { Pool } = require('pg');
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

const FAKE_ORDERS = ['DK056695552', 'DKM85426566', 'DKM7566659', 'DK745595582', 'DK2546695852', 'Royal101'];

async function deepAudit() {
    const client = await pool.connect();
    try {
        console.log('✅ Connected to PRODUCTION\n');

        // Find Aswad
        const userRes = await client.query("SELECT id, name FROM users WHERE email = 'aswadmaswad8@gmail.com'");
        const aswadId = userRes.rows[0].id;
        console.log(`👤 Aswad ID: ${aswadId}\n`);

        let totalFakeCredits = 0;
        const creditsToDelete = [];

        for (const orderId of FAKE_ORDERS) {
            console.log(`═══ Order: ${orderId} ═══`);
            
            // Get ALL detail rows for this order where Aswad is the vendor
            const details = await client.query(`
                SELECT 
                    nopd.id as detail_id, nopd.status, nopd.vendor_id,
                    ns.root_domain,
                    no.order_id
                FROM new_orders no
                JOIN new_order_processes nop ON nop.new_order_id = no.id
                JOIN new_order_process_details nopd ON nopd.new_order_process_id = nop.id
                LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
                WHERE no.order_id = $1 AND nopd.vendor_id = $2
            `, [orderId, aswadId]);

            if (details.rows.length === 0) {
                console.log('  No assignments found for Aswad in this order\n');
                continue;
            }

            for (const d of details.rows) {
                const statusLabel = { 5: 'Assigned', 7: 'Submitted', 8: 'Credited', 11: 'Mgr Rejected', 12: 'Blogger Rejected' }[d.status] || `Unknown(${d.status})`;
                
                // Check if there's a credit in wallet for this detail
                const creditRes = await client.query(`
                    SELECT id as wh_id, price FROM wallet_histories 
                    WHERE order_detail_id = $1 AND wallet_id = 308 AND type = 'credit'
                `, [d.detail_id]);

                const hasCredit = creditRes.rows.length > 0;
                const creditAmount = hasCredit ? parseFloat(creditRes.rows[0].price) : 0;

                if (hasCredit && d.status !== 8) {
                    // BAD: has credit but order is rejected
                    console.log(`  🔴 detail_id=${d.detail_id} | ${d.root_domain} | status=${statusLabel} | HAS CREDIT $${creditAmount} ← SHOULD NOT EXIST`);
                    creditsToDelete.push({ wh_id: creditRes.rows[0].wh_id, amount: creditAmount, orderId, domain: d.root_domain });
                    totalFakeCredits += creditAmount;
                } else if (hasCredit && d.status === 8) {
                    // This is the tricky case: order is "status 8" but user says it should be rejected
                    console.log(`  ⚠️  detail_id=${d.detail_id} | ${d.root_domain} | status=${statusLabel} | HAS CREDIT $${creditAmount} ← STATUS 8 BUT ORDER IS SUPPOSED TO BE REJECTED`);
                    creditsToDelete.push({ wh_id: creditRes.rows[0].wh_id, amount: creditAmount, orderId, domain: d.root_domain });
                    totalFakeCredits += creditAmount;
                } else {
                    console.log(`  ✅ detail_id=${d.detail_id} | ${d.root_domain} | status=${statusLabel} | No credit in wallet`);
                }
            }
            console.log('');
        }

        console.log(`\n══════════════════════════════`);
        console.log(`Total fake credits found: $${totalFakeCredits}`);
        console.log(`Credits to delete: ${creditsToDelete.length}`);
        
        if (creditsToDelete.length > 0) {
            console.log('\nBreakdown:');
            for (const c of creditsToDelete) {
                console.log(`  - Order ${c.orderId} | ${c.domain}: $${c.amount} [wh_id=${c.wh_id}]`);
            }
        }

        // Now check: does the user want to execute?
        if (!process.argv.includes('--execute')) {
            console.log('\n👆 Run with --execute to delete these credits and fix the wallet');
            return;
        }

        if (creditsToDelete.length === 0) {
            console.log('\n✅ Nothing to fix!');
            return;
        }

        // EXECUTE
        console.log('\n🔧 EXECUTING FIX...');
        await client.query('BEGIN');
        try {
            for (const c of creditsToDelete) {
                await client.query('DELETE FROM wallet_histories WHERE id = $1', [c.wh_id]);
                console.log(`  Deleted wh_id=${c.wh_id} ($${c.amount})`);
            }

            // Also set the detail status to 12 (blogger rejected) for these entries
            for (const c of creditsToDelete) {
                // Find the detail_id from wallet_histories before deletion... we need it from our saved data
            }

            // Recalculate wallet
            const cSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = 308 AND type = 'credit'");
            const dSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = 308 AND type = 'debit'");
            const newBalance = parseFloat(cSum.rows[0].total) - parseFloat(dSum.rows[0].total);

            await client.query('UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = 308', [newBalance]);
            await client.query('COMMIT');

            console.log(`\n✅ DONE!`);
            console.log(`💰 Old balance: $3703`);
            console.log(`💰 New balance: $${newBalance}`);
            console.log(`💰 Removed: $${3703 - newBalance}`);
        } catch(e) {
            await client.query('ROLLBACK');
            console.error('❌ ROLLED BACK:', e.message);
        }

    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}
deepAudit().catch(e => { console.error(e); process.exit(1); });
