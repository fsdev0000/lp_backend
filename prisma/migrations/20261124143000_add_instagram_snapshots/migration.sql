-- CreateTable
CREATE TABLE "instagram_analytics_snapshots" (
    "id" TEXT NOT NULL,
    "followers_count" INTEGER NOT NULL,
    "follows_count" INTEGER NOT NULL,
    "media_count" INTEGER NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "profile_views" INTEGER,
    "engagement_rate" DOUBLE PRECISION,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_range" TEXT NOT NULL DEFAULT '7d',
    "raw_metrics" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instagram_media_snapshots" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "caption" TEXT,
    "permalink" TEXT,
    "media_url" TEXT,
    "thumbnail_url" TEXT,
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER,
    "impressions" INTEGER,
    "saved" INTEGER,
    "shares" INTEGER,
    "published_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_media_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_analytics_snapshots_recorded_at_idx" ON "instagram_analytics_snapshots"("recorded_at");

-- CreateIndex
CREATE INDEX "instagram_analytics_snapshots_date_range_idx" ON "instagram_analytics_snapshots"("date_range");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_media_snapshots_media_id_key" ON "instagram_media_snapshots"("media_id");

-- CreateIndex
CREATE INDEX "instagram_media_snapshots_published_at_idx" ON "instagram_media_snapshots"("published_at");

-- CreateIndex
CREATE INDEX "instagram_media_snapshots_media_type_idx" ON "instagram_media_snapshots"("media_type");
