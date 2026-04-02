# crm-appointment-scheduler

Node backend for ServiceTitan integration and technician scheduling.

## Endpoints

- `POST /api/servicetitan/connect`
- `POST /api/servicetitan/sync?tenantId=<id>&date=YYYY-MM-DD`
- `GET /api/servicetitan/schedule?tenantId=<id>&date=YYYY-MM-DD`
- `GET /api/servicetitan/availability?tenantId=<id>&date=YYYY-MM-DD&duration=120`

## Env

- `PORT=8080`
- `SERVICETITAN_ENV=integration`
- `SERVICETITAN_CAMPAIGN_ID=...` (JPM job booking campaign)
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`

## Run

```bash
npm install
npm run dev
```

## Expected Supabase tables

- `st_tenants`
- `st_technicians`
- `st_appointments`
- `st_appointment_assignments`
# crm-appointment-scheduler
