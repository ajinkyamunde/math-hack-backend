-- MathHack schema for Neon PostgreSQL.
-- IDs are 24-character hex strings (the same shape as MongoDB ObjectIds), so records imported from the old
-- database keep their IDs and every existing link and URL keeps working.

CREATE TABLE IF NOT EXISTS hosts (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  email           text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  role            text NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('HOST', 'ADMIN')),
  account_status  text NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'SUSPENDED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  prn                    text NOT NULL UNIQUE,
  email                  text NOT NULL UNIQUE,
  department             text NOT NULL,
  academic_year          text NOT NULL CHECK (academic_year IN ('FE', 'SE', 'TE', 'BE', 'PG1', 'PG2')),
  password_hash          text NOT NULL,
  roster_verified        boolean NOT NULL DEFAULT false,
  failed_login_attempts  integer NOT NULL DEFAULT 0,
  login_locked_until     timestamptz,
  password_changed_at    timestamptz,
  account_status         text NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'SUSPENDED')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_department_year_idx ON students (department, academic_year);

CREATE TABLE IF NOT EXISTS import_batches (
  id                 text PRIMARY KEY,
  created_by         text NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  original_filename  text,
  file_type          text NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
  status             text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW', 'COMMITTING', 'COMMITTED')),
  total_rows         integer NOT NULL,
  valid_rows         jsonb NOT NULL DEFAULT '[]',
  invalid_rows       jsonb NOT NULL DEFAULT '[]',
  duplicate_rows     jsonb NOT NULL DEFAULT '[]',
  inserted_count     integer NOT NULL DEFAULT 0,
  committed_at       timestamptz,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id                  text PRIMARY KEY,
  question_text       text NOT NULL,
  options             text[] NOT NULL CHECK (cardinality(options) = 4),
  correct_option      text NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  difficulty          text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  time_limit_seconds  integer NOT NULL,
  points              integer NOT NULL CHECK (points >= 0),
  topic               text NOT NULL DEFAULT '',
  explanation         text NOT NULL DEFAULT '',
  tags                text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE')),
  fingerprint         text NOT NULL,
  created_by          text,
  import_batch_id     text,
  imported_by         text,
  imported_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_status_difficulty_idx ON questions (status, difficulty, created_at DESC);
CREATE INDEX IF NOT EXISTS questions_fingerprint_idx ON questions (fingerprint);
CREATE INDEX IF NOT EXISTS questions_topic_idx ON questions (lower(topic));

-- Lifecycle: DRAFT -> WAITING (registration open) -> RUNNING (Start Test unlocked) -> COMPLETED, or CANCELLED.
-- PAUSED is kept in the check so imported history loads; the new game never pauses.
CREATE TABLE IF NOT EXISTS competitions (
  id                         text PRIMARY KEY,
  name                       text NOT NULL,
  description                text NOT NULL DEFAULT '',
  created_by                 text NOT NULL,
  duration_seconds           integer NOT NULL CHECK (duration_seconds > 0),
  status                     text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'WAITING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  question_progression_mode  text NOT NULL DEFAULT 'AUTOMATIC',
  settings                   jsonb NOT NULL DEFAULT '{}',
  started_at                 timestamptz,
  ends_at                    timestamptz,
  completed_at               timestamptz,
  completion_reason          text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS competitions_status_idx ON competitions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS competitions_created_by_idx ON competitions (created_by, created_at DESC);

-- The questions of a competition, in order. When the host starts the competition each row gets a frozen
-- snapshot, so later edits in the question bank never change a running test or recorded scores.
CREATE TABLE IF NOT EXISTS competition_questions (
  competition_id  text NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
  question_id     text NOT NULL,
  position        integer NOT NULL,
  snapshot        jsonb,
  PRIMARY KEY (competition_id, question_id)
);
CREATE INDEX IF NOT EXISTS competition_questions_question_idx ON competition_questions (question_id);

-- A student registered for a competition. removed_at marks a host removal (soft delete with an undo window).
CREATE TABLE IF NOT EXISTS participants (
  competition_id  text NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
  student_id      text NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  removed_at      timestamptz,
  removed_by      text,
  PRIMARY KEY (competition_id, student_id)
);
CREATE INDEX IF NOT EXISTS participants_student_idx ON participants (student_id, joined_at DESC);

-- Exactly one exam session per student per competition (rule 7: each student's own timer).
CREATE TABLE IF NOT EXISTS exam_sessions (
  competition_id  text NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
  student_id      text NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'COMPLETED')),
  finished_at     timestamptz,
  PRIMARY KEY (competition_id, student_id)
);
CREATE INDEX IF NOT EXISTS exam_sessions_active_idx ON exam_sessions (competition_id, expires_at) WHERE status = 'ACTIVE';

-- One row per answered question. The primary key is what makes an answer final (rule 6): a second
-- submission for the same question cannot be inserted.
CREATE TABLE IF NOT EXISTS answers (
  competition_id    text NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
  student_id        text NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  question_id       text NOT NULL,
  difficulty        text NOT NULL,
  selected_option   text CHECK (selected_option IN ('A', 'B', 'C', 'D')),
  is_correct        boolean NOT NULL,
  points_awarded    integer NOT NULL,
  response_time_ms  integer,
  submitted_at      timestamptz NOT NULL,
  PRIMARY KEY (competition_id, student_id, question_id)
);
CREATE INDEX IF NOT EXISTS answers_question_idx ON answers (competition_id, question_id);

CREATE TABLE IF NOT EXISTS roster_entries (
  prn          text PRIMARY KEY,
  email        text NOT NULL,
  name         text NOT NULL DEFAULT '',
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              bigserial PRIMARY KEY,
  actor_id        text,
  actor_role      text NOT NULL,
  action          text NOT NULL,
  competition_id  text,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_competition_idx ON audit_logs (competition_id, created_at);
