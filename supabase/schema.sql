-- 91DAB Store — Supabase schema
--
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL
-- Editor → New query → paste → Run). It creates the tables the app
-- needs. Safe to re-run later — every statement uses IF NOT EXISTS, so
-- re-running after an app update (e.g. to pick up new columns) won't
-- touch existing data. See README.md > "Supabase setup" for the full
-- walkthrough.

create table if not exists orders (
  id                 text primary key,              -- e.g. DAB1A2B3C4D5
  qty                integer not null,
  amount             numeric not null,
  customer_name      text not null,
  customer_email     text not null,
  customer_phone     text not null,
  customer_address   text not null,
  customer_city      text,
  customer_state     text,
  customer_pincode   text,
  status             text not null default 'pending',      -- pending | paid | expired
  fulfillment_status text not null default 'processing',   -- processing | shipped | delivered | cancelled
  utr                text,
  tracking_number    text,
  carrier            text,
  return_status      text not null default 'none',         -- none | requested | approved | rejected | refunded
  return_reason      text,
  refunded_amount    numeric,
  refunded_at        timestamptz,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  paid_at            timestamptz
);

-- If you already ran an earlier version of this file, these fill in the
-- newer columns (tracking/returns) without touching existing rows.
alter table orders add column if not exists tracking_number text;
alter table orders add column if not exists carrier text;
alter table orders add column if not exists return_status text not null default 'none';
alter table orders add column if not exists return_reason text;
alter table orders add column if not exists refunded_amount numeric;
alter table orders add column if not exists refunded_at timestamptz;

create index if not exists orders_created_at_idx on orders (created_at desc);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_return_status_idx on orders (return_status);

-- A log of admin-sent customer emails, for the dashboard's Messages view.
create table if not exists admin_messages (
  id        bigint generated always as identity primary key,
  order_id  text references orders(id) on delete set null,
  to_email  text not null,
  subject   text not null,
  body      text not null,
  sent_at   timestamptz not null default now()
);

create index if not exists admin_messages_sent_at_idx on admin_messages (sent_at desc);

-- Row Level Security: on, with zero policies, on both tables.
--
-- Nothing in this app ever talks to Supabase from the browser — only the
-- Express server does, using the SERVICE ROLE key, which bypasses RLS by
-- design. Enabling RLS with no policies means the public/anon key (if it
-- ever leaked) could not read or write either table at all. This is the
-- correct, secure default for a server-only integration — don't add
-- permissive policies here unless you later add direct client-side access.
alter table orders enable row level security;
alter table admin_messages enable row level security;
