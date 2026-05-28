require('dotenv').config();
const { pool } = require('./config/database');

async function migrate() {
    try {
        console.log('Starting migration...');
        
        // Check if assigned_to column exists
        const checkRes = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='client_orders' AND column_name='assigned_to';
        `);
        
        if (checkRes.rows.length === 0) {
            console.log('Adding assigned_to and assigned_at to client_orders...');
            await pool.query(`
                ALTER TABLE client_orders 
                ADD COLUMN assigned_to INT DEFAULT NULL,
                ADD COLUMN assigned_at TIMESTAMP DEFAULT NULL;
            `);
            
            // Add foreign key constraint if desired (optional but good for integrity)
            try {
                await pool.query(`
                    ALTER TABLE client_orders
                    ADD CONSTRAINT fk_client_orders_assigned_to 
                    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;
                `);
                console.log('Added foreign key constraint.');
            } catch (fkErr) {
                console.log('Could not add foreign key (maybe users table layout issue):', fkErr.message);
            }
            
            console.log('Migration successful!');
        } else {
            console.log('Columns already exist. Skipping migration.');
        }
        
    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await pool.end();
        process.exit();
    }
}

migrate();
