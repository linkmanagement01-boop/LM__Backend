const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('❌ Provide DATABASE_URL'); process.exit(1); }

const isDryRun = !process.argv.includes('--execute');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fix() {
    const client = await pool.connect();
    try {
        console.log('✅ Connected to PRODUCTION database');
        console.log(isDryRun ? '🔍 DRY RUN — no changes will be made\n' : '⚠️  EXECUTE MODE — changes WILL be made\n');

        // 1. Find Aswad
        const userRes = await client.query("SELECT id, name FROM users WHERE email = 'aswadmaswad8@gmail.com'");
        if (userRes.rows.length === 0) { console.log("❌ Aswad not found"); return; }
        
        const aswadId = userRes.rows[0].id;
        console.log(`👤 User: ${userRes.rows[0].name} (ID: ${aswadId})`);

        // 2. Get wallet
        const walletRes = await client.query('SELECT id, balance FROM wallets WHERE user_id = $1', [aswadId]);
        if (walletRes.rows.length === 0) { console.log("❌ Wallet not found"); return; }
        
        const walletId = walletRes.rows[0].id;
        const currentBalance = parseFloat(walletRes.rows[0].balance);
        console.log(`💰 Wallet ID: ${walletId}, Current Balance: $${currentBalance}\n`);

        // 3. Find orphaned credits — credits linked to rejected orders (status 11 or 12)
        const orphanedRes = await client.query(`
            SELECT 
                wh.id as wh_id, wh.price, wh.order_detail_id,
                nopd.status as detail_status,
                no.order_id
            FROM wallet_histories wh
            JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            WHERE wh.wallet_id = $1 AND wh.type = 'credit'
              AND nopd.vendor_id = $2
              AND nopd.status IN (11, 12)
            ORDER BY no.order_id
        `, [walletId, aswadId]);

        if (orphanedRes.rows.length === 0) {
            console.log('✅ No orphaned credits found! Aswad\'s wallet is clean.');
            
            // Still verify balance is correct
            const cSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'credit'", [walletId]);
            const dSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'debit'", [walletId]);
            const trueBalance = parseFloat(cSum.rows[0].total) - parseFloat(dSum.rows[0].total);
            console.log(`📊 Verified balance: credits($${cSum.rows[0].total}) - debits($${dSum.rows[0].total || 0}) = $${trueBalance}`);
            console.log(`📊 Stored balance: $${currentBalance}`);
            if (Math.abs(trueBalance - currentBalance) > 0.01) {
                console.log(`⚠️  MISMATCH! Stored: $${currentBalance}, True: $${trueBalance}`);
            }
            return;
        }

        // Print what we found
        let totalToRemove = 0;
        console.log(`Found ${orphanedRes.rows.length} fake credit(s):`);
        for (const row of orphanedRes.rows) {
            const amount = parseFloat(row.price);
            totalToRemove += amount;
            const label = row.detail_status === 11 ? 'Manager Rejected' : 'Blogger Rejected';
            console.log(`  🔴 Order ${row.order_id}: $${amount} (${label}) [wh_id=${row.wh_id}]`);
        }
        console.log(`\n📊 TOTAL fake credits: $${totalToRemove}`);

        if (isDryRun) {
            console.log('\n👆 Run with --execute to remove these credits:');
            console.log('   DATABASE_URL="..." node fix-aswad-wallet.js --execute');
            return;
        }

        // EXECUTE
        console.log('\n🔧 Deleting fake credits...');
        await client.query('BEGIN');
        try {
            const ids = orphanedRes.rows.map(r => r.wh_id);
            await client.query('DELETE FROM wallet_histories WHERE id = ANY($1)', [ids]);
            console.log(`✅ Deleted ${ids.length} credit entries`);

            // Recalculate
            const cSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'credit'", [walletId]);
            const dSum = await client.query("SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'debit'", [walletId]);
            const trueBalance = parseFloat(cSum.rows[0].total) - parseFloat(dSum.rows[0].total);

            await client.query('UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [trueBalance, walletId]);
            await client.query('COMMIT');

            console.log(`\n✅ DONE!`);
            console.log(`💰 Old balance: $${currentBalance}`);
            console.log(`💰 New balance: $${trueBalance}`);
            console.log(`💰 Removed: $${currentBalance - trueBalance}`);
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
fix().catch(e => { console.error(e); process.exit(1); });
