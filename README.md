# 91DAB Store

A small, live storefront for DAB (Dental Aerosol Blocker): browse → cart →
checkout → pay via a dynamic UPI QR code → get an emailed invoice — plus
a full sales dashboard to run the back office from.

## How it works

- `public/index.html` — the marketing/landing page (home, story,
  recognition, journal, contact). This is what visitors land on. Its
  **Buy DAB** button (in the nav, the hero, and the pricing callout) links
  to `shop.html`. **Unchanged** by the admin/Supabase work below.
- `public/shop.html` — the storefront itself (home, product, cart,
  checkout form, payment, confirmation), plain HTML/CSS/JS, no build step.
  **Unchanged** — it calls the same three API endpoints it always did.
- `server.js` — an Express server that serves both storefront pages, the
  API `shop.html` calls, and the whole admin dashboard + its API.
- `lib/store.js` — orders, backed by **Supabase** (Postgres). Every read
  or write to an order goes through this file.
- `lib/messages.js` — the log of admin-sent customer emails (the
  dashboard's Messages view), also backed by Supabase.
- `lib/analytics.js` — pure functions that turn the raw order list into
  what the dashboard displays (weekly/monthly series, totals, reports,
  finances). No I/O — just arrays in, numbers out.
- `lib/supabaseClient.js` — the one place the Supabase client is created,
  using the service-role key (server-only, never sent to the browser).
- `lib/upi.js` — builds the `upi://pay?...` link and turns it into a QR
  code image.
- `lib/email.js` — sends the confirmation invoice, and free-form
  admin-to-customer messages, via [Resend](https://resend.com).
- `admin/dashboard.html` — the admin dashboard itself: one self-contained
  HTML/CSS/JS file (no build step, same philosophy as `shop.html`),
  served only to authenticated requests (see "Admin dashboard" below).
- `supabase/schema.sql` — the SQL that creates the tables this app needs.

### The payment flow, specifically

There's no payment gateway sitting in the middle — QR codes point straight
at **your own UPI ID**. That was the ask, and it's genuinely simpler and
fee-free, but it comes with one real tradeoff worth understanding clearly:

**There is no automatic "payment succeeded" signal.** A gateway (Razorpay,
Cashfree, PayU, etc.) can tell your server the instant money lands, because
they're a licensed intermediary sitting between the buyer and your bank.
A raw UPI QR to your own VPA doesn't give you that — the money goes
straight to your bank, and your server has no way to know it arrived.

So the flow here is:

1. Buyer reaches the payment screen → server creates an order (now saved
   in Supabase, not memory) and a QR code good for **5 minutes**, encoding
   your VPA, the amount, and the order ID (as the UPI transaction
   reference, `tr`).
2. Buyer scans and pays with any UPI app. They can optionally paste the
   UPI reference number from their app into a field on the page — this
   doesn't verify anything automatically, it just gives you something
   exact to match against instead of eyeballing amounts and timestamps.
3. You open `/admin`, check your bank or UPI app for a matching credit —
   the order ID usually shows up in the transaction note/reference — and
   click **Mark paid** on the Orders view.
4. That click flips the order to `paid`, which (a) the buyer's browser
   picks up within a few seconds via polling and shows the confirmation
   screen, and (b) triggers the invoice email via Resend.

If the 5 minutes run out before you confirm, the QR expires and the buyer
gets a **Generate new QR** button, which mints a fresh order.

This is honest, workable for low-to-moderate order volume, and keeps every
rupee going straight to your account with no cut taken out. It does mean
someone needs to check `/admin` reasonably often — it's not "walk away and
it runs itself." If you outgrow that, see "Going further."

## Admin dashboard

Go to `/admin` (e.g. `https://your-domain.com/admin`) and sign in with
`ADMIN_USER` / `ADMIN_PASSWORD` when your browser prompts for it.

| View | What it does |
|---|---|
| **Dashboard** | Totals, weekly orders/sales bar charts, a this-year-vs-last-year revenue line chart, recent orders, and a fulfillment snapshot. |
| **Orders** | Every order — search, filter by status, **mark paid**, and set fulfillment status (processing/shipped/delivered/cancelled). |
| **Returns** | Flag a paid order as a return by ID, then approve/reject it, then mark it refunded (always the full order amount). |
| **Shipping** | Every paid order that isn't delivered yet, with editable carrier + tracking number fields. |
| **Customers** | Buyers rolled up from their order history — orders count, total spent, last order date. |
| **Messages** | Send a free-form email to a customer via Resend (optionally tied to an order), and see everything sent before. |
| **Product** | What this single-SKU store currently sells. |
| **Reports** | Confirmation rate, return rate, repeat customers, top customers, order-status breakdown. |
| **Finances** | Gross/net revenue, total refunded, revenue by month. |

The **Export** button (top-right, and again on the Orders view) downloads
every order as a CSV. The bell icon shows how many orders are waiting on
payment confirmation.

Everything above is real — every table and chart is backed by Supabase
through the `/api/admin/*` routes in `server.js`. Nothing on the dashboard
is placeholder or mock data.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `MERCHANT_VPA` | Your own UPI ID that should receive payments, e.g. `91dab@okhdfcbank` |
| `MERCHANT_NAME` | Name shown in the buyer's UPI app when they scan |
| `RESEND_API_KEY` | From [resend.com](https://resend.com) — free tier is 3,000 emails/month |
| `RESEND_FROM_EMAIL` | Must be on a domain you've verified in Resend |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Login for the `/admin` dashboard |
| `SUPABASE_URL` | Your Supabase project URL — see "Supabase setup" below |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase project's **service_role** key — see below |

Run it locally:

```bash
npm start
# landing page at http://localhost:4000
# storefront ("Buy DAB") at http://localhost:4000/shop.html
# admin dashboard at http://localhost:4000/admin
```

## Supabase setup

This is what makes orders persistent — without it, every order would
still disappear the moment the server restarts, same as the old
in-memory version.

1. **Create a project.** Go to [supabase.com](https://supabase.com) →
   New project. Pick any name/region; the free tier is plenty for this.
2. **Run the schema.** In your project, go to **SQL Editor → New query**,
   paste the entire contents of `supabase/schema.sql` from this repo, and
   click **Run**. This creates the `orders` and `admin_messages` tables
   and turns on Row Level Security with no policies (see the comment at
   the bottom of that file for why that's the correct, secure setup here
   — the server never uses the public/anon key, only the service role
   key below, which bypasses RLS by design).
3. **Get your credentials.** Go to **Project Settings → API**:
   - **Project URL** → this is your `SUPABASE_URL`.
   - **`service_role` key** (under "Project API keys" — **not** the
     `anon`/`public` one) → this is your `SUPABASE_SERVICE_ROLE_KEY`.

   The service role key bypasses every access restriction on your
   database, so treat it like a password: only put it in `.env` (which
   is git-ignored) and in Render's environment variables — never in
   client-side code, never committed, never shared.
4. **Set the two variables** in `.env` locally, and in Render's
   **Environment** tab when you deploy (see below). That's the entire
   integration — the app does the rest.

If you ever need to double check the data directly, Supabase's own
**Table Editor** (left sidebar → Table Editor → `orders`) lets you browse
and edit rows without going through the app at all.

## Setting up Resend (for emails)

1. Create a free account at resend.com.
2. Add and verify a domain you control (Domains → Add Domain → follow the
   DNS records they give you). You can't send from a random `@gmail.com`
   address — it has to be a domain you've proven you own.
3. Create an API key (API Keys → Create), put it in `RESEND_API_KEY`.
4. Set `RESEND_FROM_EMAIL` to something on that domain, e.g.
   `orders@91dab.com`.

While testing before your domain is verified, Resend gives you a sandbox
sender you can use to send to your own inbox only. This same setup powers
both the automatic order-confirmation email and the dashboard's Messages
view.

## Deploying live — Render + your own domain

**1. Push this project to a GitHub repo** (Render deploys from git).

**2. Create the service on Render:**
   - New → Web Service → connect the repo.
   - Render will read `render.yaml` automatically and set the build/start
     commands (`npm install` / `npm start`) for you. If you'd rather not
     use the blueprint, enter those manually.
   - In the service's **Environment** tab, add all eight variables from
     `.env.example` with your real values — `render.yaml` lists them but
     Render still wants the values entered in the dashboard for security.
   - Deploy. Render gives you a working `https://91dab-store.onrender.com`
     URL immediately.

**3. Point your own domain at it:**
   - In the Render service → Settings → Custom Domains → Add.
   - For a subdomain (e.g. `shop.91dab.com`): add a `CNAME` record at your
     DNS provider pointing to the `.onrender.com` address Render gives
     you.
   - For an apex/root domain (e.g. `91dab.com` itself): Render will show
     you the specific `A`/`ANAME` records to add — this varies by DNS
     provider, so use exactly what's shown in your dashboard at the time.
   - DNS changes can take anywhere from a few minutes to a few hours to
     propagate. Render auto-provisions the SSL certificate once it
     verifies the domain — no separate step needed.

**A note on the free plan:** Render's free tier spins the service down
after periods of inactivity and spins it back up on the next request
(with a ~30–60s cold-start delay). That no longer risks losing orders —
they live in Supabase now, not memory — but the cold start itself is
still there. For anything beyond testing, a paid instance avoids that
delay.

## Going further

- **Confirmation is manual.** If checking `/admin` becomes a chore, the
  natural upgrade is a payment aggregator's QR product (Cashfree, PayU,
  Razorpay, PhonePe for Business all offer one) — same "scan a QR" buyer
  experience, but they notify your server by webhook the instant it's
  paid, so `markPaid()` fires automatically instead of by hand. That's a
  swap inside `lib/upi.js` and one new webhook route in `server.js`; the
  rest of the app (frontend, email, dashboard) barely changes.
- **Multiple products.** Right now `PRICE_PER_PACK` in `server.js` and
  the product details in `shop.html` assume one SKU. Growing past that
  means a small `products` table alongside `orders`, plus a picker on the
  storefront and in the dashboard's Product view.
- **Partial refunds.** The Returns view always refunds the full order
  amount (`lib/store.js` → `setReturnStatus`). If you need partial
  refunds, that's the one function to extend.

## Product image & content

The product photo and company background are used from
[91dab.com](https://91dab.com), the site of 91 Danta Research and Product
Development Pvt Ltd. Swap `PRODUCT_IMG` in `public/shop.html` for your
own hosted image whenever you have official product photography ready.

## A pricing mismatch to be aware of

`public/index.html` (landing page, in the "Preventing Dental Aerosols"
article) advertises DAB at an introductory **Rs 150**. The storefront and
server (`public/shop.html`, `server.js` `PRICE_PER_PACK`) both charge
**₹500/pack**. Whichever number is current, worth making the two match so
buyers aren't quoted one price and charged another.
