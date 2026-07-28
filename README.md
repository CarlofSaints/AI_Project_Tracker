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
| `CRON_SECRET` | Guards `/api/sync`. |

> Vercel env vars marked **Sensitive** read back empty from `vercel env pull`.
> An empty value there is not proof the variable is unset.

### Syncing

- **Manually** — the "Sync now" button on the dashboard.
- **On a schedule** — `vercel.json` registers a daily 05:00 UTC cron against
  `/api/sync`, which requires `Authorization: Bearer $CRON_SECRET`.

## Multi-user (schema ready, not wired up)

The `User` model and the nullable `ownerId` FKs already exist. Adding GitHub
OAuth later means adding Auth.js and reading those columns — no migration of
existing data.

Note that GitHub OAuth alone won't show a teammate their Vercel projects; each
member also needs to connect a Vercel token, which is what `User.vercelTokenEnc`
is reserved for.
