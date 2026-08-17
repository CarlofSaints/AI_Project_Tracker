# AI Project CRM

One view of every AI project across GitHub and Vercel — what it is, who it's
for, what it's plugged into, and how far along it is.

## How it works

Vercel is the spine of the inventory: it knows the project, its env vars, its
domains, its storage, *and* which GitHub repo it's linked to. GitHub fills the
two gaps Vercel can't — repos that were never deployed, and `pushed_at` as a
real signal of whether a project is still alive.

Both are swept into our own Postgres by a sync job. The dashboard only ever
reads from Postgres. Nothing calls the Vercel or GitHub API on page load — a
single project needs three Vercel calls, so a 45-project grid would be well over
a hundred round trips deep before it rendered anything.

### Detection, not data entry

Vercel returns env var **keys** (never values). Combined with `package.json`
from GitHub, that's enough to infer most of the grid automatically:

| Signal | Infers |
| --- | --- |
| `RESEND_API_KEY`, `nodemailer`, `SMTP_HOST` | sends email |
| `SHAREPOINT_*`, `@microsoft/microsoft-graph-client` | reads/writes SharePoint |
| `MSSQL_*`, `SAP_*`, `PERIGEE_*`, `mssql` | connects to external data |
| `BLOB_READ_WRITE_TOKEN`, `DATABASE_URL`, `KV_*` | which databases it uses |

Rules live in `src/lib/detect.ts` and are deliberately conservative — a false
negative is one click to fix, a false positive makes you stop trusting the grid.

Every match stores the string that triggered it, so expanding a row shows you
*why* a flag is ticked.

### Auto vs manual

Each capability cell cycles through three states: **inheriting detection** →
**forced on** → **forced off** → back to inheriting. An overridden cell gets a
ring around it, so it's always obvious which values came from the sync and which
came from you.

The sync engine writes only the columns listed in `syncOwned` (`src/lib/sync.ts`).
Client, customer, stage, notes, display name and every override are human-owned
and survive every sweep.

## Clients and customers

There is **one** `Organization` table. Client and customer are *roles held on a
project*, not types of organisation:

```
Project.clientId       → who you invoice / own the relationship with
Project.endCustomerId  → who it was actually built for (nullable)
```

So Snomaster is a single record. On the Atomic Marketing project it's the end
customer; on the direct project it's the client. No duplicate rows, no drift.

`Organization.parentId` exists purely to pre-fill the project form with a
default agency. It never constrains what roles an organisation can hold.

## Setup

```bash
npm install
cp .env.example .env      # fill in the values below
npm run db:push           # create the schema
npm run dev
```

### Environment

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Neon Postgres. Add via Vercel → Storage, then `vercel env pull`. |
| `VERCEL_TOKEN` | https://vercel.com/account/tokens — needs access to both scopes. |
| `GITHUB_TOKEN` | Classic token with `repo` + `read:org`. |
| `GITHUB_OWNERS` | `CarlofSaints:user,OuterJoinZA:org` — the `:org` suffix matters, org repos live on a different endpoint. |
| `ANTHROPIC_ADMIN_KEY` | Billing only. An **Admin** key (`sk-ant-admin01-…`), not a normal API key. See Billing below. |
| `RESEND_API_KEY` | Billing only. Needs permission to list emails. |
| `CRON_SECRET` | Guards `/api/sync` and `/api/billing/ingest`. |

> Vercel env vars marked **Sensitive** read back empty from `vercel env pull`.
> An empty value there is not proof the variable is unset.

> `.env.example` is matched by the `.env*` rule in `.gitignore`, so it is not in
> the repo — this table is the authoritative list.

### Syncing

- **Manually** — the "Sync now" button on the dashboard.
- **On a schedule** — `vercel.json` registers a daily 05:00 UTC cron against
  `/api/sync`, which requires `Authorization: Bearer $CRON_SECRET`.

## Billing

Tracks what each project costs at each third party, and rolls that up into what
to charge each client. `/billing`, one calendar month at a time.

### How much each vendor can actually tell you

This is the part worth being honest about, because the answer differs per vendor
and a billing screen that hides the difference is worse than no billing screen.

| Vendor | Attribution | How |
| --- | --- | --- |
| **Vercel** | Exact | `GET /v1/billing/charges` returns FOCUS v1.3 rows whose `Tags` carry the Vercel **project id** — a direct join onto `Project.vercelProjectId`. Nothing to maintain. |
| **GitHub** | Exact | `GET /{users\|organizations}/{owner}/settings/billing/usage` returns line items carrying `repositoryName` — joined onto `gitOwner`/`gitRepo`. |
| **Anthropic** | Only if you set it up | The cost report's finest grain is the **workspace**. One workspace per project (or per client), each mapped on the billing page, or all Claude spend is one undifferentiated number. |
| **Resend** | Derived | No usage endpoint. Sends are counted from `GET /emails` and attributed by **sending domain**. |
| **Google / anything else** | Manual | Entered by hand. Never touched by a collector. |

Two prerequisites are on you, not the code:

- **Anthropic** — the Admin API is unavailable to individual accounts. The
  account must be an Organization (Console → Settings → Organization), and the
  key must be an Admin key. Attribution then needs one workspace per project.
- **GitHub** — the token needs billing read on top of repo read. Without it the
  endpoint answers **404**, not 403.

### Metered vs base fee

- **Metered** cost is caused by a project and is attributed to it.
- **Base fees** — a Pro seat, a plan minimum — are caused by the business. There
  is no honest formula that divides them, so they are **split across clients by
  hand** on the billing page. Anything you don't allocate is shown as absorbed
  rather than quietly billed to someone.

On a plan with an included allowance, metered usage shows a cost of zero against
a real quantity, and the money sits in the plan's base fee. That is correct, not
missing data: the quantities tell you who is consuming the plan, and the base fee
is what you split.

### Money

Every cost is stored in **USD**, because that is what the vendors bill. Each
period carries **one** USD→ZAR rate (auto-fetched from frankfurter.app, or typed
in), so re-opening March's invoice in July still shows March's rand.

Markup is per client in basis points, falling back to a house default. Closing a
month freezes the rate and each client's markup into `ClientPeriodTerms` — the
figures themselves are never persisted, so correcting an allocation or a mapping
is reflected everywhere at once, while a sent invoice cannot move underneath you.

`src/lib/billing/rollup.ts` is the single source of truth for every figure: the
page, the client bills and the Excel export all read from it, exactly as the grid
and its export both read from `grid-view.ts`.

### Collecting

- **Manually** — "Collect costs" on `/billing`.
- **On a schedule** — a daily 06:00 UTC cron against `/api/billing/ingest`. It
  collects the current month every run, plus the previous month for the first
  ten days of a new one, because vendors restate figures as a month settles.

Each vendor's slice of a month is **replaced** on every run, never appended, so
re-running is safe. Hand-entered lines (`source: manual`) are never touched.
Every attempt writes a `CostIngestRun` — including the ones that find nothing,
because "collected zero" and "never ran" look identical on a dashboard.

## Multi-user (schema ready, not wired up)

The `User` model and the nullable `ownerId` FKs already exist. Adding GitHub
OAuth later means adding Auth.js and reading those columns — no migration of
existing data.

Note that GitHub OAuth alone won't show a teammate their Vercel projects; each
member also needs to connect a Vercel token, which is what `User.vercelTokenEnc`
is reserved for.
