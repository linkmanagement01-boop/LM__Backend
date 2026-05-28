require('dotenv').config();
const { query } = require('./config/database');

async function run() {
    try {
        console.log('Starting DB migration...');
        
        console.log('Adding fill_details to client_order_details...');
        await query(`
            ALTER TABLE client_order_details 
            ADD COLUMN IF NOT EXISTS fill_details BOOLEAN DEFAULT true;
        `);
        
        console.log('Backfilling client_order_details fill_details from client_orders...');
        await query(`
            UPDATE client_order_details cod 
            SET fill_details = co.fill_details 
            FROM client_orders co 
            WHERE co.id = cod.client_order_id;
        `);
        
        console.log('Adding fill_details to new_order_process_details...');
        await query(`
            ALTER TABLE new_order_process_details 
            ADD COLUMN IF NOT EXISTS fill_details BOOLEAN DEFAULT false;
        `);
        
        console.log('DB migration complete!');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

run();
