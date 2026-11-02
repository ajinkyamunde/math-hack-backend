/**
 * Copies the old MongoDB data into the Postgres schema. IDs are kept (24-hex ObjectId strings), so links,
 * sessions and exports keep pointing at the same records, and password hashes are copied as-is (the Worker
 * verifies the same Argon2id format). Safe to re-run: existing rows are left untouched.
 */

export interface SourceDb {
  collection(name: string): { find(filter?: object): { toArray(): Promise<Record<string, any>[]> } };
}

export interface TargetDb {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const id = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const date = (value: unknown): Date | null => (value instanceof Date ? value : value ? new Date(String(value)) : null);

export async function importFromMongo(source: SourceDb, target: TargetDb, log: (line: string) => void = console.log) {
  const counts: Record<string, number> = {};
  const all = (name: string) => source.collection(name).find({}).toArray();
  const insert = async (table: string, sql: string, params: unknown[]) => {
    const result = await target.query(`${sql} ON CONFLICT DO NOTHING RETURNING 1`, params);
    counts[table] = (counts[table] ?? 0) + result.rows.length;
  };

  const hostIds = new Set<string>();
  for (const h of await all('hosts')) {
    hostIds.add(id(h._id)!);
    await insert(
      'hosts',
      `INSERT INTO hosts (id, name, email, password_hash, role, account_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, now()), coalesce($8, now()))`,
      [id(h._id), h.name, String(h.email).toLowerCase(), h.passwordHash, h.role ?? 'ADMIN', h.accountStatus ?? 'ACTIVE', date(h.createdAt), date(h.updatedAt)],
    );
  }

  const studentIds = new Set<string>();
  for (const s of await all('students')) {
    studentIds.add(id(s._id)!);
    await insert(
      'students',
      `INSERT INTO students (id, name, prn, email, department, academic_year, password_hash, roster_verified,
         failed_login_attempts, login_locked_until, password_changed_at, account_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, now()), coalesce($14, now()))`,
      [
        id(s._id), s.name, s.prn, String(s.email).toLowerCase(), s.department, s.academicYear, s.passwordHash,
        Boolean(s.rosterVerified), s.failedLoginAttempts ?? 0, date(s.loginLockedUntil), date(s.passwordChangedAt),
        s.accountStatus ?? 'ACTIVE', date(s.createdAt), date(s.updatedAt),
      ],
    );
  }

  for (const q of await all('questions')) {
    await insert(
      'questions',
      `INSERT INTO questions (id, question_text, options, correct_option, difficulty, time_limit_seconds, points, topic,
         explanation, tags, status, fingerprint, created_by, import_batch_id, imported_by, imported_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, coalesce($17, now()), coalesce($18, now()))`,
      [
        id(q._id), q.questionText, q.options, q.correctOption, q.difficulty, q.timeLimitSeconds, q.points, q.topic ?? '',
        q.explanation ?? '', q.tags ?? [], q.status ?? 'DRAFT', q.fingerprint, id(q.createdBy), id(q.importBatchId),
        id(q.importedBy), date(q.importedAt), date(q.createdAt), date(q.updatedAt),
      ],
    );
  }

  const competitionIds = new Set<string>();
  for (const c of await all('competitions')) {
    const cid = id(c._id)!;
    competitionIds.add(cid);
    await insert(
      'competitions',
      `INSERT INTO competitions (id, name, description, created_by, duration_seconds, status, question_progression_mode,
         settings, started_at, ends_at, completed_at, completion_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, coalesce($13, now()), coalesce($14, now()))`,
      [
        cid, c.name, c.description ?? '', id(c.createdBy), c.durationSeconds, c.status, c.questionProgressionMode ?? 'AUTOMATIC',
        JSON.stringify(c.settings ?? {}), date(c.startedAt), date(c.endsAt), date(c.completedAt), c.completionReason ?? null,
        date(c.createdAt), date(c.updatedAt),
      ],
    );
    for (const item of (c.queue ?? []) as Record<string, any>[]) {
      const snapshot = item.snapshot
        ? {
            questionText: item.snapshot.questionText,
            options: item.snapshot.options,
            correctOption: item.snapshot.correctOption,
            difficulty: item.snapshot.difficulty,
            timeLimitSeconds: item.snapshot.timeLimitSeconds,
            points: item.snapshot.points,
            topic: item.snapshot.topic ?? '',
            explanation: item.snapshot.explanation ?? '',
          }
        : null;
      await insert(
        'competition_questions',
        `INSERT INTO competition_questions (competition_id, question_id, position, snapshot) VALUES ($1, $2, $3, $4::jsonb)`,
        [cid, id(item.questionId), item.order ?? 0, snapshot ? JSON.stringify(snapshot) : null],
      );
    }
  }

  const known = (competitionId: unknown, studentId: unknown) => competitionIds.has(id(competitionId)!) && studentIds.has(id(studentId)!);

  for (const p of await all('participants')) {
    if (!known(p.competitionId, p.studentId)) continue;
    const removed = p.registrationStatus === 'REMOVED';
    await insert(
      'participants',
      `INSERT INTO participants (competition_id, student_id, joined_at, last_seen_at, removed_at) VALUES ($1, $2, coalesce($3, now()), $4, $5)`,
      [id(p.competitionId), id(p.studentId), date(p.joinedAt), date(p.lastSeenAt), removed ? (date(p.updatedAt) ?? new Date()) : null],
    );
  }
  // Removals made through the host dashboard: the participant row was deleted and a backup kept.
  for (const r of await all('removedparticipants')) {
    if (!known(r.competitionId, r.studentId)) continue;
    const removedAt = date(r.removedAt) ?? new Date();
    const result = await target.query(
      `UPDATE participants SET removed_at = $3, removed_by = $4 WHERE competition_id = $1 AND student_id = $2 AND removed_at IS NULL RETURNING 1`,
      [id(r.competitionId), id(r.studentId), removedAt, id(r.removedBy)],
    );
    if (!result.rows.length) {
      await insert(
        'participants',
        `INSERT INTO participants (competition_id, student_id, joined_at, removed_at, removed_by) VALUES ($1, $2, coalesce($3, $4), $4, $5)`,
        [id(r.competitionId), id(r.studentId), date(r.backupData?.participant?.joinedAt), removedAt, id(r.removedBy)],
      );
    }
  }

  for (const s of await all('examsessions')) {
    if (!known(s.competitionId, s.studentId)) continue;
    const status = s.status === 'SUBMITTED' ? 'COMPLETED' : s.status;
    await insert(
      'exam_sessions',
      `INSERT INTO exam_sessions (competition_id, student_id, started_at, expires_at, status, finished_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id(s.competitionId), id(s.studentId), date(s.startedAt), date(s.expiresAt), status, date(s.submittedAt)],
    );
  }

  // Old "timed out" attempts were placeholders for unanswered questions; in the new schema unanswered = no row.
  for (const a of await all('attempts')) {
    if (a.timedOut || !a.submittedAt || !known(a.competitionId, a.studentId)) continue;
    await insert(
      'answers',
      `INSERT INTO answers (competition_id, student_id, question_id, difficulty, selected_option, is_correct, points_awarded, response_time_ms, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id(a.competitionId), id(a.studentId), id(a.questionId), a.difficulty, a.selectedOption ?? null, Boolean(a.isCorrect),
        a.pointsAwarded ?? 0, a.responseTimeMs === null || a.responseTimeMs === undefined ? null : Math.round(a.responseTimeMs), date(a.submittedAt),
      ],
    );
  }

  for (const r of await all('rosterentries')) {
    await insert('roster_entries', `INSERT INTO roster_entries (prn, email, name, uploaded_by) VALUES ($1, $2, $3, $4)`, [
      r.prn, String(r.email).toLowerCase(), r.name ?? '', id(r.uploadedBy),
    ]);
  }

  for (const [table, n] of Object.entries(counts)) log(`${table.padEnd(22)} ${n} new row(s)`);
  return counts;
}
