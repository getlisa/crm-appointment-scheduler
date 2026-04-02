export type RetellJobTypeKbRow = {
  jobTypeId: number;
  name: string | null;
  code: string | null;
  summary: string | null;
  durationSeconds: number | null;
  durationMinutes: number | null;
  skills: string[];
  skillNames: string[];
  intentHints: string[];
  priority: string | null;
  /** First ServiceTitan `businessUnitIds` entry; exposed as `businessId` on resolve-job-type. */
  businessUnitId: number | null;
};

export type RetellJobTypesKnowledgeBase = {
  tenantId: number;
  syncedAt: string;
  jobTypes: RetellJobTypeKbRow[];
};

export function buildKnowledgeBaseDocument(params: {
  tenantId: number;
  rows: {
    job_type_id: number;
    name: string | null;
    code: string | null;
    summary: string | null;
    duration_seconds: number | null;
    skills: string[];
    intent_hints: string[] | null;
    priority: string | null;
    business_unit_id: number | null;
  }[];
}): RetellJobTypesKnowledgeBase {
  const jobTypes: RetellJobTypeKbRow[] = params.rows.map((r) => {
    const skills = Array.isArray(r.skills) ? (r.skills as string[]) : [];
    const ds = r.duration_seconds;
    const durationMinutes =
      ds != null && Number.isFinite(ds) ? Math.max(1, Math.ceil(ds / 60)) : null;
    return {
      jobTypeId: Number(r.job_type_id),
      name: r.name,
      code: r.code,
      summary: r.summary,
      durationSeconds: ds,
      durationMinutes,
      skills,
      skillNames: skills.filter(Boolean),
      intentHints: r.intent_hints ?? [],
      priority: r.priority ?? null,
      businessUnitId:
        r.business_unit_id != null && Number.isFinite(Number(r.business_unit_id))
          ? Number(r.business_unit_id)
          : null,
    };
  });

  return {
    tenantId: params.tenantId,
    syncedAt: new Date().toISOString(),
    jobTypes,
  };
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((t) => t.trim())
      .filter((t) => t.length > 1)
  );
}

export function scoreJobTypeMatch(reason: string, row: RetellJobTypeKbRow): number {
  const tokens = tokenize(reason);
  if (tokens.size === 0) return 0;
  let score = 0;
  const fields = [
    row.name,
    row.code,
    row.summary,
    ...row.intentHints,
    ...row.skillNames,
  ].filter(Boolean) as string[];

  for (const field of fields) {
    const ft = tokenize(field);
    for (const t of tokens) {
      if (ft.has(t)) score += 3;
      if (field.toLowerCase().includes(t)) score += 2;
    }
  }

  for (const hint of row.intentHints) {
    if (reason.toLowerCase().includes(hint.toLowerCase())) score += 5;
  }

  return score;
}

export function resolveJobTypeFromReason(
  reason: string,
  kb: RetellJobTypesKnowledgeBase,
  topN = 3
): { matches: { jobTypeId: number; score: number; row: RetellJobTypeKbRow }[] } {
  const scored = kb.jobTypes.map((row) => ({
    jobTypeId: row.jobTypeId,
    score: scoreJobTypeMatch(reason, row),
    row,
  }));

  scored.sort((a, b) => b.score - a.score);
  const matches = scored.filter((m) => m.score > 0).slice(0, topN);
  return { matches };
}
