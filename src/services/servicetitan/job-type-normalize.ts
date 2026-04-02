/** Normalize ServiceTitan JPM job-type payloads (camelCase / occasional PascalCase). */

export type NormalizedJobType = {
  id: number;
  name: string | null;
  code: string | null;
  summary: string | null;
  durationSeconds: number | null;
  skills: string[];
  /** e.g. "Normal", "High" from JPM job-types. */
  priority: string | null;
  /** First entry of `businessUnitIds` from API. */
  businessUnitId: number | null;
};

function pickStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function firstBusinessUnitId(raw: Record<string, unknown>): number | null {
  const arr = raw.businessUnitIds ?? raw.BusinessUnitIds;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  const n = typeof first === 'number' ? first : Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * JPM job-types return `skills: string[]`. Older/alternate shapes may use `{ id, name }[]`.
 */
function extractSkillsArray(skillsRaw: unknown): { id: number; name: string }[] {
  if (!Array.isArray(skillsRaw)) return [];
  const out: { id: number; name: string }[] = [];
  let syntheticId = 0;
  for (const item of skillsRaw) {
    if (typeof item === 'string') {
      const name = pickStr(item);
      if (name) {
        syntheticId += 1;
        out.push({ id: syntheticId, name });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = Number(o.id ?? o.Id);
    const name = pickStr(o.name ?? o.Name);
    if (Number.isFinite(id) && name) {
      out.push({ id, name });
      continue;
    }
    if (name) {
      syntheticId += 1;
      out.push({ id: syntheticId, name });
    }
  }
  return out;
}

export function normalizeJobTypeRecord(raw: Record<string, unknown>): NormalizedJobType {
  const id = Number(raw.id ?? raw.Id);
  if (!Number.isFinite(id)) {
    throw new Error('Job type missing numeric id');
  }

  const name = pickStr(raw.name ?? raw.Name);
  const code = pickStr(raw.code ?? raw.Code ?? raw.class ?? raw.Class);
  const summary = pickStr(
    raw.summary ?? raw.Summary ?? raw.description ?? raw.Description ?? raw.notes ?? raw.Notes
  );

  let durationSeconds: number | null = null;
  /** Official JPM shape: `duration` in seconds. */
  const durationKeys = [
    'duration',
    'durationSeconds',
    'DurationSeconds',
    'estimatedDurationInSeconds',
    'EstimatedDurationInSeconds',
  ] as const;
  for (const key of durationKeys) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      durationSeconds = Math.round(v);
      break;
    }
  }

  if (durationSeconds == null) {
    const dm = raw.durationMinutes ?? raw.DurationMinutes;
    if (typeof dm === 'number' && dm > 0) {
      durationSeconds = Math.round(dm * 60);
    }
  }

  if (durationSeconds == null) {
    const sold = raw.soldHours ?? raw.SoldHours;
    if (typeof sold === 'number' && sold > 0) {
      durationSeconds = Math.round(sold * 3600);
    }
  }

  const skills = extractSkillsArray(
    raw.skills ?? raw.Skills ?? raw.tradeSkills ?? raw.TradeSkills ?? raw.requiredSkills
  );

  const priority = pickStr(raw.priority ?? raw.Priority);
  const businessUnitId = firstBusinessUnitId(raw);

  return {
    id,
    name,
    code,
    summary,
    durationSeconds,
    skills: skills.map((s) => s.name ?? '').filter(Boolean),
    priority,
    businessUnitId,
  };
}

export function normalizeJobTypeUnknown(raw: unknown): NormalizedJobType {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid job type payload');
  }
  return normalizeJobTypeRecord(raw as Record<string, unknown>);
}
