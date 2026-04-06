const { Pool } = require('pg');
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

async function audit() {
    const client = await pool.connect();
    try {
        console.log('✅ Connected\n');

        // Get ALL of Aswad's wallet credits with their order detail status
        const res = await client.query(`
            SELECT 
                wh.id as wh_id, wh.price, wh.order_detail_id, wh.created_at,
                nopd.status as detail_status,
                nopd.vendor_id,
                no.order_id,
                ns.root_domain
            FROM wallet_histories wh
            LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
            LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            LEFT JOIN new_orders no ON nop.new_order_id = no.id
            LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE wh.wallet_id = 308 AND wh.type = 'credit'
            ORDER BY wh.created_at DESC
        `);

        console.log(`Total credit entries: ${res.rows.length}\n`);

        let totalValid = 0, totalInvalid = 0;
        const invalid = [];

        for (const row of res.rows) {
            const amount = parseFloat(row.price);
            const status = parseInt(row.detail_status);
            const isValid = status === 8;
            
            if (isValid) {
                totalValid += amount;
            } else {
                totalInvalid += amount;
                invalid.push(row);
            }

            const statusLabel = {
                5: 'Assigned', 7: 'Submitted', 8: 'Credited/Complete',
                11: 'Manager Rejected', 12: 'Blogger Rejected'
            }[status] || `Unknown(${status})`;

            const flag = isValid ? '✅' : '🔴';
            console.log(`${flag} wh_id=${row.wh_id} | $${amount} | Order: ${row.order_id || 'N/A'} | Site: ${row.root_domain || 'N/A'} | Status: ${statusLabel} | ${new Date(row.created_at).toLocaleDateString()}`);
        }

        console.log(`\n--- SUMMARY ---`);
        console.log(`Valid credits (status 8):   $${totalValid}`);
        console.log(`Invalid credits (not 8):   $${totalInvalid}`);
        console.log(`Stored balance:            $${3703}`);
        
        if (invalid.length > 0) {
            console.log(`\n🔴 ${invalid.length} INVALID credit entries found worth $${totalInvalid}:`);
            for (const r of invalid) {
                console.log(`   Order ${r.order_id}: $${r.price} (status=${r.detail_status}) [wh_id=${r.wh_id}]`);
            }
        } else {
            console.log(`\n✅ All credits belong to status=8 orders. The $3703 appears legitimate.`);
        }

    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}
audit().catch(e => { console.error(e); process.exit(1); });
