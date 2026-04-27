-- ============================================================
-- Maikon Quest Phase 0 — スキーマ追加
-- 既存データを破壊しない idempotent なDDLのみ。
-- すべて IF NOT EXISTS 付き + BEGIN/COMMIT でトランザクション化。
-- ============================================================

BEGIN;

-- 1. customers 拡張 -------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS mq_level             integer      DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mq_experience        integer      DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mq_animal            text,
  ADD COLUMN IF NOT EXISTS mq_personality       text,
  ADD COLUMN IF NOT EXISTS mq_state             text,
  ADD COLUMN IF NOT EXISTS mq_titles            jsonb        DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mq_catchphrase       text,
  ADD COLUMN IF NOT EXISTS mq_last_level_up_at  timestamptz;

-- 参考用インデックス（ダッシュボード集計を想定）
CREATE INDEX IF NOT EXISTS idx_customers_mq_level  ON public.customers (mq_level);
CREATE INDEX IF NOT EXISTS idx_customers_mq_animal ON public.customers (mq_animal);
CREATE INDEX IF NOT EXISTS idx_customers_mq_state  ON public.customers (mq_state);

-- 2. stylists 新規テーブル -------------------------------------------
CREATE TABLE IF NOT EXISTS public.stylists (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  mq_level       integer     DEFAULT 1,
  mq_experience  integer     DEFAULT 0,
  mq_class       text,
  mq_titles      jsonb       DEFAULT '[]'::jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

-- 3. mq_events 新規テーブル ------------------------------------------
CREATE TABLE IF NOT EXISTS public.mq_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   text        NOT NULL CHECK (actor_type IN ('customer','stylist')),
  actor_id     uuid        NOT NULL,
  event_type   text        NOT NULL,
  exp_gained   integer     DEFAULT 0,
  occurred_at  timestamptz DEFAULT now(),
  metadata     jsonb       DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mq_events_actor       ON public.mq_events (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_mq_events_occurred_at ON public.mq_events (occurred_at DESC);

COMMIT;
