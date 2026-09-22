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
