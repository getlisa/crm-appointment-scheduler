import express from 'express';
import cors from 'cors';
import { serviceTitanRouter } from './routes/servicetitan.js';
import buildopsRouter from './routes/buildops.js';

const app = express();
app.use(
  cors({
    origin: '*',
    credentials: true,
    preflightContinue: false,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'crm-appointment-scheduler' });
});

app.use('/api/servicetitan', serviceTitanRouter);
app.use('/api/buildops', buildopsRouter);

export default app;
