-- Client Panel Database Migration
-- Creates tables for client payments, orders, and order details

-- 1. Client Payments (Razorpay Top-up tracking)
CREATE TABLE IF NOT EXISTS client_payments (
    id BIGSERIAL PRIMARY KEY,
    client_user_id INTEGER NOT NULL REFERENCES users(id),
    amount DOUBLE PRECISION NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    status VARCHAR(30) NOT NULL DEFAULT 'pending',  -- pending, completed, failed
    razorpay_order_id VARCHAR(255),
    razorpay_payment_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_payments_user ON client_payments(client_user_id);
CREATE INDEX IF NOT EXISTS idx_client_payments_order ON client_payments(razorpay_order_id);

-- 2. Client Orders (main order record)
CREATE TABLE IF NOT EXISTS client_orders (
    id BIGSERIAL PRIMARY KEY,
    client_user_id INTEGER NOT NULL REFERENCES users(id),
    order_type VARCHAR(50) NOT NULL,          -- 'Guest Post' or 'Niche Edit'
    no_of_links INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_review',
    -- Status flow: pending_review -> manager_processing -> pushed_to_blogger -> completed
    fill_details BOOLEAN NOT NULL DEFAULT false,  -- true = client filled, false = delegate to manager
    notes TEXT,
    order_package VARCHAR(255),
    category TEXT,
    manager_notes TEXT,                       -- Manager can add notes during review
    linked_new_order_id INTEGER,              -- Reference to new_orders table after manager pushes
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_orders_user ON client_orders(client_user_id);
CREATE INDEX IF NOT EXISTS idx_client_orders_status ON client_orders(status);

-- 3. Client Order Details (per-website detail in an order)
CREATE TABLE IF NOT EXISTS client_order_details (
    id BIGSERIAL PRIMARY KEY,
    client_order_id INTEGER NOT NULL REFERENCES client_orders(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL,                 -- References new_sites(id)
    target_url TEXT,
    anchor_text TEXT,
    article_title TEXT,                       -- For Guest Post
    doc_url TEXT,                             -- For Guest Post (Google Doc link)
    post_url TEXT,                            -- For Niche Edit
    insert_after TEXT,                        -- For Niche Edit
    insert_statement TEXT,                    -- For Niche Edit
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_order_details_order ON client_order_details(client_order_id);
