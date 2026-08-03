# Zephyr Heating and Air — Service Catalog & Intent Capture

The canonical service taxonomy the Office-Hours agent uses to classify a caller's request and
write the HCP job notes. This is the source of truth for the `# SERVICES & INTENT CAPTURE`
section embedded in [`retell/Zephyr Heating and Air LLC - Office Hours (1).json`](../../retell/Zephyr%20Heating%20and%20Air%20LLC%20-%20Office%20Hours%20(1).json).

## What the agent must capture (both, every service request)

1. **`service_type` — the classification.** One of the 9 canonical services (below), or
   `Other/General - <intent>` for anything without a dedicated booking service.
2. **`issue` — the caller's complete account, in their own words.** Every symptom, when it
   started, affected rooms/areas, noises/smells, prior work, and any second issue. Never
   reduced to a category, never dropped.

Both are sent to `book_job` and rendered into the HCP job `notes`:
```
Service :- AC Repair
Issue Description :- <the caller's full account>
Job scheduled for August 7, 2026, between 1:00 PM and 5:00 PM
```

## The 9 bookable (canonical) services

| System | Repair | Tune-up | Installation |
|---|---|---|---|
| **Air Conditioning (AC)** | AC Repair | AC Tune-up | AC Installation |
| **Furnace** | Furnace Repair | Furnace Tune-up | Furnace Installation |
| **Heat Pump** | Heat Pump Repair | Heat Pump Tune-up | Heat Pump Installation |

Use these exact labels (normalize e.g. "AC Installations" → "AC Installation").

## Disambiguation rules

- **Symptoms do NOT reveal the system.** The repair symptom lists are nearly identical across
  AC / Furnace / Heat Pump — *not starting*, *weak or no airflow / heat / cooling*, *strange
  noises*, *high energy bills*, *poor indoor air quality*. So if the caller only gives a
  symptom, the agent **must ask which system** (AC, Furnace, or Heat Pump).
- **Ask the service type:** Repair (something's wrong) vs Tune-up / Maintenance vs
  Installation / Replacement.

## Intents with no dedicated booking page → still book (as `Other/General - <intent>`)

- **Air handler** — install / repair / tune-up
- **Ductless / mini-split** — install / repair / tune-up
- **Smart thermostat** — install / repair / maintenance
- **Indoor Air Quality (IAQ)** — no concrete product offerings are published (only benefits);
  capture the request and book.
- **Commercial HVAC** — installation, repair, preventative tune-ups, system upgrades/replacement,
  ventilation, **building automation systems**, **commercial refrigeration**.
  > ⚠️ Commercial refrigeration and building automation are **distinct non-residential trades** —
  > the agent notes this in the `issue` so the office routes them to the right team.
- **HVAC Maintenance** line items — system inspections, filter replacement, coil cleaning,
  tune-ups, safety checks, priority service agreements, system reports.

## Parked for a future knowledge base (not embedded in the prompt yet)

Kept here so the details aren't lost; add as a Retell knowledge base if the agent needs to
answer general questions (its `knowledge_base_ids` is currently empty):

- **Contact / hours:** phone (818) 651-9640; office 8821 Shirley Ave, Northridge, CA 91324;
  Mon–Fri 8AM–5PM, Sat 8AM–2PM, closed Sun.
- **Financing:** Wisetack, up to $25,000, 3–60 months, 0–35.9% APR, prequalification without
  credit impact.
- **Promotions (all expire 2026-08-31):** $50 off any HVAC repair; $100 off any new
  installation; 1-year labor warranty on new installations.
- **Credentials:** in business since 1981, family-owned, licensed & insured, American Standard
  Customer Care Dealer.
- **Service area:** Los Angeles + surrounding (Northridge, Chatsworth, Granada Hills, Santa
  Clarita, Sherman Oaks, Canoga Park, Van Nuys, Beverly Hills, Calabasas, Simi Valley; out to
  Oxnard, Port Hueneme, Lancaster, Huntington Beach).

**Gaps to resolve with the client:** IAQ page names no concrete products (air purifiers /
dehumidifiers / ventilation / filtration are mentioned only in benefit copy); the site
documents **no emergency / after-hours** service despite reviews citing same-day/next-day
heatwave response; reviews reference work not in any menu (wall-AC replacement, full-system
replacement).
