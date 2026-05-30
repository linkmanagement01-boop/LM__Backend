-- ============================================================
-- SAFE MIGRATION: Add Client Panel tables to production
-- Date: 2026-05-30
-- Target: Railway PostgreSQL (railway database)
-- 
-- SAFETY: All statements use IF NOT EXISTS.
--         No DROP, DELETE, TRUNCATE, or ALTER TYPE statements.
--         Wrapped in a transaction for atomic rollback.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. NEW TABLE: client_orders
--    Stores orders placed by clients through the client panel.
--    Referenced by: client_order_details, client_payments
-- ============================================================
CREATE TABLE IF NOT EXISTS "client_orders" (
    "id" BIGSERIAL PRIMARY KEY,
    "client_user_id" INTEGER NOT NULL,
    "order_type" VARCHAR(255) DEFAULT NULL,
    "no_of_links" INTEGER DEFAULT NULL,
    "status" VARCHAR(50) DEFAULT 'pending_review',
    "fill_details" BOOLEAN DEFAULT TRUE,
    "notes" TEXT DEFAULT NULL,
    "order_package" VARCHAR(255) DEFAULT NULL,
    "category" TEXT DEFAULT NULL,
    "total_price" DOUBLE PRECISION DEFAULT 0,
    "assigned_to" INTEGER DEFAULT NULL,
    "assigned_at" TIMESTAMP DEFAULT NULL,
    "linked_new_order_id" INTEGER DEFAULT NULL,
    "manager_notes" TEXT DEFAULT NULL,
    "order_number" VARCHAR(255) DEFAULT NULL,
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP DEFAULT NULL
);

-- ============================================================
-- 2. NEW TABLE: client_order_details
--    Per-site details for each client order.
--    FK: client_order_id -> client_orders.id
--    FK: site_id -> new_sites.id
-- ============================================================
CREATE TABLE IF NOT EXISTS "client_order_details" (
    "id" BIGSERIAL PRIMARY KEY,
    "client_order_id" INTEGER NOT NULL,
    "site_id" INTEGER DEFAULT NULL,
    "target_url" TEXT DEFAULT NULL,
    "anchor_text" TEXT DEFAULT NULL,
    "article_title" TEXT DEFAULT NULL,
    "doc_url" TEXT DEFAULT NULL,
    "post_url" TEXT DEFAULT NULL,
    "insert_after" TEXT DEFAULT NULL,
    "insert_statement" TEXT DEFAULT NULL,
    "note" TEXT DEFAULT NULL,
    "fill_details" BOOLEAN DEFAULT TRUE,
    "price" DOUBLE PRECISION DEFAULT NULL,
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 3. NEW TABLE: client_payments
--    Razorpay payment records for client wallet top-ups.
--    FK: client_user_id -> users.id
-- ============================================================
CREATE TABLE IF NOT EXISTS "client_payments" (
    "id" BIGSERIAL PRIMARY KEY,
    "client_user_id" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" VARCHAR(10) DEFAULT 'USD',
    "status" VARCHAR(50) DEFAULT 'pending',
    "razorpay_order_id" VARCHAR(255) DEFAULT NULL,
    "razorpay_payment_id" VARCHAR(255) DEFAULT NULL,
    "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP DEFAULT NULL
);

-- ============================================================
-- 4. INDEXES for performance on the new tables
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_client_orders_client_user_id ON client_orders(client_user_id);
CREATE INDEX IF NOT EXISTS idx_client_orders_status ON client_orders(status);
CREATE INDEX IF NOT EXISTS idx_client_orders_assigned_to ON client_orders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_client_orders_linked_new_order_id ON client_orders(linked_new_order_id);

CREATE INDEX IF NOT EXISTS idx_client_order_details_order_id ON client_order_details(client_order_id);
CREATE INDEX IF NOT EXISTS idx_client_order_details_site_id ON client_order_details(site_id);

CREATE INDEX IF NOT EXISTS idx_client_payments_user_id ON client_payments(client_user_id);
CREATE INDEX IF NOT EXISTS idx_client_payments_status ON client_payments(status);

COMMIT;
