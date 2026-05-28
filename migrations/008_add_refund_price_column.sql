-- Migration: Add price column to client_order_details for refund tracking
-- This stores the marked-up client price at order creation time,
-- so refunds can be calculated accurately even if site prices change later.

ALTER TABLE client_order_details ADD COLUMN IF NOT EXISTS price DOUBLE PRECISION DEFAULT NULL;
