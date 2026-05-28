-- Migration: Add total_price to client_orders
-- Description: Supports the prepaid wallet model by storing the exact amount charged at order creation

ALTER TABLE client_orders
ADD COLUMN IF NOT EXISTS total_price DOUBLE PRECISION DEFAULT 0;
