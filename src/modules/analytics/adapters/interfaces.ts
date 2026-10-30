export interface TrafficMetricRow {
  date: string;
  visitors: number;
  leads: number;
  pageviews: number;
}

export interface CampaignYieldRow {
  campaign: string;
  source: string;
  impressions: number;
  clicks: number;
  leads: number;
  convRate: string;
}

export interface GscQueryRow {
  query: string;
  impressions: number;
  clicks: number;
  ctr: string;
  position: number;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: string;
  ctrValue: number;
  position: number;
}

export interface GscKeywordsResponse {
  totals: GscTotals;
  queries: GscQueryRow[];
  range: string;
  domain: string;
  startDate: string;
  endDate: string;
  totalQueries: number;
}

export interface ClarityUxMetrics {
  activeTelemetryStreams: number;
  avgDwellSeconds: number;
  dwellTimeFormatted: string;
  rageClickRate: number;
  deadClickRate: number;
  ingestionLatencyMs: number;
  sessionPlaybackBaseUrl: string;
}

export interface ChannelPerformanceRow {
  id: string;
  name: string;
  connected: boolean;
  followers: number | null;
  postsInRange: number | null;
  engagementRate: number | null;
  websiteVisitors: number | null;
  leads: number | null;
  pipelineValueEur: number | null;
  trend: string | null;
  startDate: string;
  endDate: string;
  color?: string;
}

export interface OverviewMetrics {
  totalAudience: number;
  audienceGrowth: number | null;
  highIntentLeads: number;
  leadsGrowth: number | null;
  avgConversionRate: number;
  conversionGrowth: number | null;
  pipelineValueEur: number;
  pipelineGrowth: number | null;
  realtimeActiveVisitors: number;
  ingestionLatencyMs: number;
}

export interface IntegrationHealthStatus {
  id: string;
  name: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  latencyMs: number;
  lastSync: string;
  message?: string;
}

export interface IIntegrationHealth {
  pingEndpoint(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number; lastSync: Date }>;
}

export interface PageScreenRow {
  pageTitle: string;
  views: number;
  activeUsers: number;
  eventCount: number;
  bounceRate: string;
}

export interface DimensionMetricRow {
  name: string;
  value: number;
}

export interface CityMetricRow {
  city: string;
  activeUsers: number;
}

export interface CountryHierarchyRow {
  country: string;
  activeUsers: number;
  cities: CityMetricRow[];
}

export interface ReportsSnapshotData {
  summary: {
    activeUsers: number;
    newUsers: number;
    averageEngagementTimeSeconds: number;
    averageEngagementTimeFormatted: string;
    eventCount: number;
  };
  topPages: PageScreenRow[];
  usersBySourceMedium: DimensionMetricRow[];
  sessionsBySourceMedium: DimensionMetricRow[];
  usersByCountry: DimensionMetricRow[];
  usersByCity: DimensionMetricRow[];
  geographicHierarchy: CountryHierarchyRow[];
  reportingPeriod: {
    startDate: string;
    endDate: string;
  };
}

export interface IGa4Adapter {
  getRealtimeActiveUsers(): Promise<{ activeUsers: number; byCountry: Record<string, number> }>;
  getTrafficReport(startDate: string, endDate: string, domain?: string): Promise<TrafficMetricRow[]>;
  getCampaignYield(dateRange: string, domain?: string): Promise<CampaignYieldRow[]>;
  getReportsSnapshot(startDate?: string, endDate?: string, limit?: number, domain?: string, range?: string): Promise<ReportsSnapshotData>;
  getYouTubeWebsiteVisitors(range?: string): Promise<YouTubeWebsiteVisitors>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface IGscAdapter {
  getTopSearchQueries(
    days?: number,
    limit?: number,
    domain?: string,
    startDate?: string,
    endDate?: string
  ): Promise<GscKeywordsResponse>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface ClaritySessionRow {
  sessionId: string;
  playbackUrl: string;
  dwellSeconds: number;
  dwellTimeFormatted: string;
  rageClicks: number;
  rageClickRate: number;
  deadClicks: number;
  quickBack: boolean;
  device?: string;
  country?: string;
  city?: string;
  landingPage?: string;
  lead?: {
    name?: string;
    email?: string;
    form?: string;
  };
  timestamp: string;
}

export interface ClarityIngestResult {
  ingested: boolean;
  anomalyDetected: boolean;
  snapshotId?: string;
  sessionId?: string;
  playbackUrl?: string;
}

export interface ClarityNormalizedMetrics {
  websiteKey: string;
  websiteName: string;
  websiteUrl: string;
  projectId: string;
  totalSessions: number;
  distinctUsers: number;
  pagesPerSession: number;
  executiveDwellSeconds: number;
  executiveDwellFormatted: string;
  dwellBenchmarkMet: boolean;
  rageClickRatio: number;
  rageClickRatioFormatted: string;
  rageClickCount: number;
  deadClickRatio: number;
  deadClickCount: number;
  quickBackRatio: number;
  excessiveScrollRatio: number;
  averageScrollDepth: number | null;
  scriptErrorCount: number;
  popularPages: Array<{ url: string; visits: number }>;
  browsers: Array<{ name: string; sessions: number }>;
  devices: Array<{ name: string; sessions: number }>;
  operatingSystems: Array<{ name: string; sessions: number }>;
  countries: Array<{ name: string; sessions: number }>;
  cities: Array<{ name: string; sessions: number }>;
  anomalyDetected: boolean;
  anomalyMessage?: string;
  ingestionLatencyMs: number;
  cachedAt: string;
  isStale: boolean;
  quotaStatus: {
    limitPerDay: number;
    remaining: number;
    status: string;
  };
}

export interface ClarityWebsiteStatus {
  websiteKey: string;
  websiteName: string;
  websiteUrl: string;
  projectId: string;
  hasToken: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  latencyMs: number;
  lastSync: string | null;
  quotaStatus: string;
}

export interface IClarityAdapter {
  getUxTelemetryMetrics(websiteKey?: string): Promise<ClarityUxMetrics>;
  getLiveAnalytics(websiteKey?: string, forceRefresh?: boolean, numOfDays?: number): Promise<ClarityNormalizedMetrics>;
  getRecordings(websiteKey?: string, limit?: number): Promise<ClaritySessionRow[]>;
  getSessions(limit?: number, websiteKey?: string): Promise<ClaritySessionRow[]>;
  getWebsiteStatus(websiteKey?: string): Promise<ClarityWebsiteStatus>;
  getAllWebsitesStatus(): Promise<ClarityWebsiteStatus[]>;
  getSessionPlaybackUrl(sessionId: string, websiteKey?: string): string;
  ingestWebhookPayload(payload: any, websiteKey?: string): Promise<ClarityIngestResult>;
  ping(websiteKey?: string): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface ISovereignAdapter {
  getAttributedLeadsCount(startDateOrRange: string, endDate?: string, domain?: string): Promise<number>;
  getAttributedPipelineValue(startDateOrRange: string, endDate?: string, domain?: string): Promise<number>;
  getRecentFounderInbound(limit?: number, startDate?: string, endDate?: string, domain?: string): Promise<any[]>;
  getChannelAttribution(
    startDate: string,
    endDate: string,
    prevStartDate?: string | null,
    prevEndDate?: string | null,
    domain?: string
  ): Promise<
    Record<
      string,
      {
        leads: number;
        pipelineValueEur: number;
        prevLeads: number;
        prevPipelineValueEur: number;
      }
    >
  >;
}

export interface YouTubeVideoRow {
  videoId: string;
  title: string;
  description: string;
  thumbnail: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  watchUrl: string;
}

export interface YouTubeVideoDetailRow {
  videoId: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  watchTimeMinutes: number | null;
  watchUrl: string;
}

export interface YouTubePlaylistRow {
  playlistId: string;
  title: string;
  thumbnail: string;
  itemCount: number;
  lastUpdated: string | null;
  viewCount: number | null;
}

export interface YouTubeWebsiteVisitors {
  range: string;
  startDate: string;
  endDate: string;
  total: number | null;
  bySite: Array<{
    domain: string;
    users: number | null;
  }>;
}

export interface YouTubeAnalyticsData {
  channelId: string;
  title: string;
  customUrl: string;
  description: string;
  thumbnail: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
  longVideoCount: number | null;
  shortsCount: number | null;
  engagementRate: number | null;
  engagementRateFormatted: string | null;
  recentVideos: YouTubeVideoRow[];
  websiteVisitors?: YouTubeWebsiteVisitors;
  cachedAt: string;
  isCached: boolean;
  isFallback: boolean;
}

export interface IYouTubeAdapter {
  getChannelAnalytics(forceRefresh?: boolean): Promise<YouTubeAnalyticsData>;
  getVideos(type?: 'videos' | 'shorts', forceRefresh?: boolean): Promise<YouTubeVideoDetailRow[]>;
  getPlaylists(forceRefresh?: boolean): Promise<YouTubePlaylistRow[]>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}
