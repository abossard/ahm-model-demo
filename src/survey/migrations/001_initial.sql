BEGIN;
SELECT pg_advisory_xact_lock(743915082164001);
CREATE SCHEMA IF NOT EXISTS survey;
CREATE TABLE IF NOT EXISTS survey.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SELECT NOT EXISTS (SELECT 1 FROM survey.schema_migrations WHERE version=1) AS apply \gset
\if :apply
CREATE TABLE survey.surveys (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{6}$'),
  author_verifier text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  voting_started_at timestamptz
);
CREATE TABLE survey.questions (
  survey_id uuid NOT NULL REFERENCES survey.surveys(id),
  id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 1 AND 2000),
  PRIMARY KEY (survey_id,id)
);
CREATE TABLE survey.ballots (
  survey_id uuid NOT NULL REFERENCES survey.surveys(id),
  id uuid NOT NULL,
  response_verifier text NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (survey_id,id),
  UNIQUE (survey_id,response_verifier)
);
CREATE TABLE survey.answers (
  survey_id uuid NOT NULL,
  ballot_id uuid NOT NULL,
  question_id uuid NOT NULL,
  value integer NOT NULL CHECK (value BETWEEN 0 AND 100),
  PRIMARY KEY (survey_id,ballot_id,question_id),
  FOREIGN KEY (survey_id,ballot_id) REFERENCES survey.ballots(survey_id,id),
  FOREIGN KEY (survey_id,question_id) REFERENCES survey.questions(survey_id,id)
);
INSERT INTO survey.schema_migrations(version) VALUES (1);
\endif
GRANT USAGE ON SCHEMA survey TO :"uami_name";
GRANT SELECT ON survey.schema_migrations TO :"uami_name";
GRANT SELECT,INSERT,UPDATE,DELETE ON
  survey.surveys,survey.questions,survey.ballots,survey.answers TO :"uami_name";
COMMIT;
