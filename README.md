# Trip Wallet

A small personal app for tracking money during a work trip.

- **Per diem deposits:** record each deposit the company makes, in any currency. A new deposit is prefilled with your previous amount.
- **Expenses:** record what, when, how much, which currency, how you paid, the category and sub-category, and whether it counts on **you** or the **company**.
- **Tax on every expense:** enter the **subtotal** and the **tax**, and the form shows the **total** (subtotal + tax) as you type. The total is what comes out of your wallet. Lists show "incl. tax", Reports show **Tax paid**, the claim sheet has a tax column, and the CSV has `subtotal`, `tax` and `total` columns. Expenses entered before tax existed have tax 0.
- **Net wallet balance on every page:** a bar at the top always shows your wallet, what the company still owes you, and how the wallet is worked out: *received − spent + reimbursed*.
- **Reimbursements:** when the company pays back a company expense, use **Deposit to wallet** and the money returns to your wallet. **Undo** reverses it.
- **Edit anything:** deposits, expenses and categories can all be edited.
- **Two currencies:** every total is shown in your wallet currency, with an approximate value in a second currency (for example SAR with USD).
- **Home:** opens on *how much*: today, the last 7 days, this month, or the whole trip, plus the daily average. Below that is *what is the most*: your top categories and biggest expenses, then recent entries and your wallet balance.
- **Quick add:** the green **+** (bottom bar on phones, top bar on computers) opens the expense form from any screen. The amount field comes first, and **Save & add another** lets you log several receipts in a row.
- **Reports:** step through months or view the whole trip.
  - Totals, the daily average, and the change compared with the previous period.
  - A bar for every day with your busiest day marked.
  - Top categories with drill-down into sub-categories, and your biggest expenses.
  - Spending by day of the week, by payment method, by month and by currency, plus me vs company and what's waiting for reimbursement.
  - Reports use the same filters as the expense list.
- **Light and dark themes:** the sun/moon switch remembers your choice. Without a saved choice, the app follows your device setting.
- **Works on any screen:** designed for 375px phones up to wide desktops, without sideways scrolling.
- **Lists:** pages of 25, with filters for date range, category, me/company, reimbursement status, payment method, currency and a text search.
- **CSV export:** downloads the filtered expenses and opens correctly in Excel, Arabic text included.
- **English and Arabic (العربية):** the whole interface is translated, including error messages, with a right-to-left layout and Arabic dates. Switch with the **ع / EN** button. Numbers keep Western digits, and the default category names are translated too.
- **Daily budget:** Home shows how much you can safely spend per day until the end of the month, based on what's in your wallet, compared with your actual pace.
- **To claim:** a list of company expenses not yet paid back. Tick several and mark them reimbursed in one go, or **Print claim** for a clean claim sheet (in the current language).
- **Receipt photos:** attach one photo per expense from your camera or gallery. It's shrunk on the device before upload (longest side 1600px, JPEG), and it's deleted with its expense.
- **Faster entry:** past descriptions are suggested as you type, and picking one fills in its category, payment method and currency. There's also **Duplicate** on any expense, and **n** opens a new expense on a computer.
- **Undo instead of "Are you sure?":** deleting shows a 5-second **Undo**, and saves and other actions show a short notice.
- **Backup and restore:** download all your data as JSON from Settings, and restore it later. Receipt photos stay on the server; a restore keeps them for expenses that still exist.

## Using it from your phone

By default the app only listens on this computer (`127.0.0.1`). To open it from your phone on the same Wi-Fi, start it with a password:

```bash
HOST=0.0.0.0 APP_PASSWORD=choose-a-strong-password npm start
```

Then open `http://<this-computer's-IP>:3000` on the phone and log in. On Android or iPhone, **Add to Home Screen** installs it like an app.

- **Login session:** logging in sets an HttpOnly cookie signed with HMAC-SHA256, valid for 30 days. Wrong passwords are limited to 5 per minute.
- **Staying logged in across restarts:** automatic. The cookie-signing key is derived from your password (or set `SESSION_SECRET` yourself), and changing the password logs everyone out.
- **No HTTPS on your own Wi-Fi:** fine at home, but to reach the app from anywhere, host it with HTTPS as described next.

## Hosting it online (GitHub + Render + Neon)

GitHub stores the code, but it **can't run** this app: GitHub Pages only serves static pages, and Trip Wallet needs a Node server and a PostgreSQL database. So you use three free services:

| Service | Does what |
|---|---|
| **GitHub** | Holds the code. Render deploys from it automatically on every push. |
| **Neon** ([neon.tech](https://neon.tech)) | Hosts the PostgreSQL database, so your data survives restarts. |
| **Render** ([render.com](https://render.com)) | Runs the Node app on an `https://…onrender.com` address, with the HTTPS certificate included. |

**1. Put the code on GitHub.** Create an empty repository on github.com (public or private; the code contains no secrets and no data), then in this folder:

```bash
git remote add origin https://github.com/YOUR-NAME/trip-wallet.git
git push -u origin main
```

**2. Create the database.** On Neon, create a project and copy its **connection string** (it starts with `postgresql://` and ends with `?sslmode=require`).

**3. Create the web service.** On Render choose **New → Blueprint**, connect your GitHub account, pick the `trip-wallet` repo, and Render reads `render.yaml`. It asks you for two values:
- `DATABASE_URL`: paste the Neon connection string.
- `APP_PASSWORD`: choose a strong password of at least 10 characters. This is the login for your app.

After the first deploy (a few minutes) open your `https://trip-wallet-….onrender.com` address, log in, and it's ready. Add it to your phone's home screen from the browser menu.

**4. Move your existing data.** On your computer's copy open **Settings → Download backup**, then on the online copy open **Settings → Restore from file…**. Receipt photos aren't in the backup, so re-attach those you need.

Good to know:
- **The app refuses to start online without a password**, because it holds your finances and the address is public. Use a long one.
- **Free tiers sleep.** Render's free web service stops after about 15 minutes without visits, so the first page load afterwards takes up to a minute. Free-tier limits change, so check each service's current terms.
- **Back up regularly** with **Settings → Download backup**. The backup is a plain JSON file with your amounts and descriptions: keep it private.
- **Updates:** `git push` and Render redeploys. Database upgrades run automatically at start.
- **Using something else?** Any host that runs Node 22+ works: set `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_SSL=true` and `APP_PASSWORD`, and run `npm start`.

## How the money works

```
wallet          = deposits + reimbursements received − all expenses
company owes me = company expenses not yet reimbursed
spent on me     = expenses counted on me
```

- **Exact math:** all totals are calculated in PostgreSQL with exact decimals, never floating point.
- **Each entry keeps its own currency and amount:** 2 decimals for most currencies, 3 for KWD, BHD and OMR, 0 for JPY.
- **Each entry stores its rate:** the rate is how many units of the wallet currency one unit of the entry's currency is worth. The wallet amount is `round(amount × rate)`, and is saved with the entry, so past totals never change when rates move. Editing an entry keeps its original rate unless you change its currency or type a new rate.
- **Second-currency figures (≈)** use today's stored rate.
- **Reimbursements** credit the expense's wallet-currency amount.
- **Fixed wallet currency:** you can only change the wallet currency before you add the first deposit or expense.

### Exchange rates

- **Online:** rates are fetched from [open.er-api.com](https://www.exchangerate-api.com), which is free, needs no key, and includes SAR, AED, QAR, KWD, BHD and OMR. This happens when the server starts and whenever you click **Update rates online** in Settings.
- **By hand:** you can set any rate in Settings. Your own rates are never overwritten by online updates.
- **Offline:** the app works without internet using the stored rates. When a currency has no rate, type one in the entry form.

## Requirements

- Node.js 22.9 or newer
- Docker, for PostgreSQL

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up     # PostgreSQL 17 on localhost:5433, restarts with Docker
npm start         # http://localhost:3000
```

Database changes are applied automatically at start-up from `migrations/`, so upgrading keeps your data.

**Upgrading from v1:** existing entries are labelled with `BASE_CURRENCY` (default `SAR`). If your v1 amounts were in a different currency, start once with that variable set, for example `BASE_CURRENCY=USD npm start`.

## Tests

```bash
npm run db:up
npm test
```

- 87 integration tests run against the real PostgreSQL container, in separate `*_test` databases.
- They never touch the network: exchange-rate fetching is replaced by a stub.
- As a safety guard, they refuse to run unless `TEST_DATABASE_URL` names a database ending in `_test`.
- GitHub Actions runs them on every push.

## API

Requests and responses are JSON. Amounts are decimal strings, dates are `YYYY-MM-DD`, and currencies are ISO 4217 codes.

| Method | Path | Body or query | Result |
|---|---|---|---|
| GET | `/api/summary` | | wallet, owed, spent on me, plus `*Display` values in the second currency |
| GET | `/api/deposits` | `page, pageSize, from, to, currency` | `{items, total, page, pageSize}` |
| POST, PUT | `/api/deposits`, `/api/deposits/:id` | `{date, amount, currency?, rate?}` | the deposit |
| DELETE | `/api/deposits/:id` | | 204 |
| GET | `/api/expenses` | `page, pageSize` and the filters below | `{items, total, page, pageSize}` |
| GET | `/api/expenses.csv` | filters | CSV download |
| POST, PUT | `/api/expenses`, `/api/expenses/:id` | `{description, date, amount, tax?, currency?, rate?, paidWith, chargedTo, categoryId?}` (`amount` is the **total** paid; `tax` is the part of it that is tax, default 0, and must be less than the total) | the expense, with `tax` and `taxBase` |
| DELETE | `/api/expenses/:id` | | 204 |
| POST, DELETE | `/api/expenses/:id/reimbursement` | `{date}` for POST | the expense |
| GET, POST | `/api/categories` | `{name, parentId?}` for POST | tree, or the new category |
| PATCH, DELETE | `/api/categories/:id` | `{name}` for PATCH | the category, or 204 |
| GET, PUT | `/api/settings` | `{baseCurrency, displayCurrency}` | settings including `baseLocked` |
| GET | `/api/rates` | | stored rates |
| PUT, DELETE | `/api/rates/:code` | `{rate}` for PUT | sets a manual rate, or removes a rate |
| POST | `/api/rates/refresh` | | `{updated}`, or 502 if the rate service is unreachable |
| PUT, GET, DELETE | `/api/expenses/:id/receipt` | JPEG/PNG/WebP body (max 2 MB) for PUT | 204, the image, or 204 |
| POST | `/api/reimbursements` | `{ids, date}` | `{updated}`; 409 if any id isn't an unreimbursed company expense, and then nothing changes |
| GET | `/api/suggestions` | | recent descriptions with their last category, payment and currency |
| GET, POST | `/api/backup`, `/api/restore?confirm=replace` | backup JSON for POST | the backup file, or counts |
| GET, POST | `/api/session`, `/api/login`, `/api/logout` | `{password}` for login | only active with `APP_PASSWORD` |
| GET | `/api/reports` | filters, `top` (1–50, default 10) | totals, `byCategory`, `byMonth`, `byCurrency`, `byDay`, `byWeekday` (0 = Sunday), `byPaidWith`, `topExpenses`, `days`, `dailyAverage`, `busiestDay` |

- **Filters:** `from`, `to`, `categoryId` (includes its sub-categories; `none` means uncategorized), `chargedTo` (me or company), `paidWith` (cash, card or other), `status` (pending or reimbursed), `currency`, `q` (text search).
- **`pageSize`:** 1–100, default 25.
- **Error codes:** every 4xx response also has a stable `code`, such as `no_rate` or `invalid_amount`, which the interface translates.
- **Errors:** 400 for invalid input, 404 for not found, 409 for conflicts (duplicate name, category in use, missing rate, wallet currency locked), 502 when the rate service fails, and 500 without details.

## Project layout

```
server.js            starts the app: migrations, server, background rate refresh
app.js               Express wiring and error handling
lib/validate.js      input parsing for every endpoint
lib/money.js         settings, rate selection and conversion SQL
lib/filters.js       expense filters shared by the list, CSV and reports
lib/migrate.js       applies migrations/*.sql once each, in a transaction
lib/rates.js         online exchange-rate source
routes/*.js          deposits, expenses, categories, settings and rates, reports
migrations/*.sql     database schema, versioned
public/              index.html, styles.css, js/*.js (home, expenses, deposits, reports, settings, charts, theme; plain ES modules, no build step)
test/*.test.js       integration tests (node:test and real PostgreSQL)
```

## Design notes

- **No login:** it is a single-user app. The server listens only on `127.0.0.1` unless `HOST` is set, so don't expose it to the internet as-is.
- **Categories:** two levels only (category and sub-category). A category that is used by expenses can't be deleted.
- **Reimbursements:** full reimbursements only, with no currency gain or loss.

## License

MIT
