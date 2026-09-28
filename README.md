# Carrybee Escalation Backend

Small Express API in front of Turso for the Issue Escalation form. It creates
its own tables on first boot — nothing to run manually in Turso beforehand.

## Tables (auto-created on boot)

- **users** — `email` (primary key), `password` (stored as plain text, per
  your instruction — see note below), `created_at`
- **issues** — `id`, `ts`, `consignment`, `channel`, `zone`, `hub`, `status`,
  `category`, `subcategory`, `details`, `logged_by`

> **Note on passwords:** this stores raw passwords, as requested. If anyone
> other than you ever gets read access to the `users` table or a DB export,
> they get live, usable credentials. If that changes, swap the plain
> comparison in `/api/auth/login` for `bcrypt.compare` — it's a small change,
> ask me any time.

## Deploy on Render

1. Push this folder to a GitHub repo (or a new folder in an existing one).
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Environment → add these variables (from Turso's dashboard):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `SETUP_KEY` (make up your own value — used once to create logins)
5. Deploy. Once it's live, note the service URL — the frontend form needs it.

## Create a login

One-time, per person who should be able to log in:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -H "x-setup-key: YOUR_SETUP_KEY" \
  -d '{"email":"nahid@carrybee.com","password":"choose-a-password"}'
```

## Endpoints the form uses

- `POST /api/auth/login` — `{ email, password }` → `{ token, email }`
- `POST /api/issues` — `Authorization: Bearer <token>` + the issue fields → saves a row
- `GET /api/issues` — `Authorization: Bearer <token>` → all issues (for the dashboard, later)

## Parcel Journey tab

After sign-in the form page has two tabs: **Log an Issue** and **Parcel Journey**.
The Parcel Journey is the hub-wise SLA engine from TQM V4, running on Turso:

- **Two journeys**, switched at the top of the tab, each with its own file,
  SLA matrix, stage boxes and CID Journey:
  - **FID** (forward): the Parcel End-to-End Flat Audit export. Reverse rows
    in that file are ignored. Stages include **CW to Sub Sort** and **Sub Sort to CW**.
  - **RID** (reverse): its own export (sheet "RID Journey") with Created,
    Sorted, CW / Sub Sort reached, LMH, Return to Merchant, Terminal and
    Invoice times. Stages: Created→Sorted, Sorted→CW, Sorted→Sub Sort,
    Sub Sort→CW, CW→LMH, Sub Sort→LMH, LMH→Return to Merchant,
    Terminal→Invoice. Tables `pj_rid_parcels` and `rid_sla_hub_matrix`.
  - Templates in `templates/`: `FID_SLA_upload_template.csv`,
    `RID_SLA_upload_template.csv` (also as .xlsx), and the demo datasets `carrybee_fid_demo_dataset.xlsx` / `carrybee_rid_demo_dataset.xlsx`.
- **SLA targets:** upload a new file at any time, or use **Edit targets** to
  change hours per hub in the app; either replaces that journey's matrix.
- **Data:** an admin uploads the parcel export (.xlsx / .csv) from the tab. The
  browser keeps only the columns the engine needs and sends them in chunks to
  `pj_parcels`; the new file replaces the old one only once every chunk has
  arrived. The SLA Hub Matrix upload is stored in `sla_hub_matrix`.
  `pickup_cutoff` (optional, `*` row = default, otherwise 18:00) is read if filled.
- **Who can upload:** emails in `PARCEL_ADMINS`. If it is empty, any signed-in
  user can.
- **Issues:** every breached parcel, a ticked set, or a whole stage box at once
  opens the Log an Issue fields (channel, status, category, subcategory,
  details, attachments). One issue is created per parcel in the `issues`
  table, with `hub` = the hub the parcel is in now and `zone` from
  `hub-info.json` (the Hub Info list), so it appears on the Escalation
  Dashboard, in that hub's Ops Console queue and on the escalation ladder
  (L3). A parcel with an open issue for the same stage is skipped.
  `issues.sla_stage` and `issues.source = 'parcel_journey'` mark these rows.
- **Hubs nobody is assigned to** in `hub_assignments` (sort points, 3PL, …)
  still get the issue, but no Ops Console shows it; the form warns before sending.

Endpoints (all need `Authorization: Bearer <token>`): `POST /api/parcel/view`,
`POST /api/parcel/journey`, `GET /api/parcel/trace/:cid`, `POST /api/parcel/download`,
`GET|POST /api/parcel/sla-matrix`, `POST /api/parcel/upload/start|chunk|finish`,
`POST /api/parcel/issues/preview`, `POST /api/parcel/issues`.

To try it locally without touching the live database, point the server at a
local file: `TURSO_DATABASE_URL=file:local.db TURSO_AUTH_TOKEN=x DAILY_REPORT_ENABLED=false npm start`,
then open `http://localhost:3000` (the page talks to the local server when
opened from localhost).
