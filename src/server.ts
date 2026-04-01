import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { serviceTitanRouter } from './routes/servicetitan.js';

const app = express();
app.use(
  cors({
    origin: '*',
    credentials: true,
    // allowedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Dev-Bypass, X-User-Id, X-User-Email, X-User-Role, X-Company-Id, X-Device-Timezone",
    preflightContinue: false,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'crm-appointment-scheduler' });
});

app.use('/api/servicetitan', serviceTitanRouter);

app.listen(env.port, () => {
  console.log(`[crm-appointment-scheduler] listening on ${env.port}`);
});
