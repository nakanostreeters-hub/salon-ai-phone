-- ============================================================
-- Phase 2 — line_sessions テーブル追加
-- LINE 会話セッション状態のDB永続化用。
--
-- 実行方法（人手承認後）:
--   psql "$SUPABASE_DB_URL" -f scripts/migrate-line-sessions.sql
--   または Supabase Studio の SQL Editor に貼り付け実行。
--
-- 安全性:
--   - 既存データを破壊しない idempotent なDDLのみ。
--   - すべて IF NOT EXISTS 付き + BEGIN/COMMIT でトランザクション化。
--   - このSQLを実行しても、コード側のフラグ (SESSION_PERSIST_ENABLED) が
--     OFF の間、誰もこのテーブルを読み書きしないので本番影響ゼロ。
--
-- ロールバック:
--   BEGIN;
--     DROP POLICY IF EXISTS service_role_only ON public.line_sessions;
--     DROP INDEX IF EXISTS public.idx_line_sessions_salon_state;
--     DROP TABLE IF EXISTS public.line_sessions;
--   COMMIT;
-- ============================================================

BEGIN;

-- 1. line_sessions 新規テーブル -------------------------------------
CREATE TABLE IF NOT EXISTS public.line_sessions (
  line_user_id              text         PRIMARY KEY,
  salon_id                  text         NOT NULL,
  conversation_state        text         NOT NULL DEFAULT 'bot_active',
  status                    text         NOT NULL DEFAULT 'counseling',
  assigned_staff_id         text,
  handoff_started_at        timestamptz,
  staff_last_response_at    timestamptz,
  holding_message_sent      boolean      NOT NULL DEFAULT false,
  has_chosen_wait_for_staff boolean      NOT NULL DEFAULT false,
  display_name              text,
  slack_all_thread_ts       text,
  slack_stylist_thread_ts   text,
  slack_stylist_channel_id  text,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  updated_at                timestamptz  NOT NULL DEFAULT now()
);

-- 2. インデックス（salon × state での集計・絞込用） ----------------
CREATE INDEX IF NOT EXISTS idx_line_sessions_salon_state
  ON public.line_sessions (salon_id, conversation_state);

-- 3. RLS（service_role からのみアクセス可）-------------------------
ALTER TABLE public.line_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'line_sessions'
      AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY service_role_only ON public.line_sessions
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

COMMIT;
