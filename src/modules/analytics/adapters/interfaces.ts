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
  followers: number;
  engagementRate: number;
  postsMonth: number;
  leadsGenerated: number;
  pipelineValueEur: number;
  color: string;
  trend: string;
}

export interface OverviewMetrics {
  totalAudience: number;
  audienceGrowth: number;
  highIntentLeads: number;
  leadsGrowth: number;
  avgConversionRate: number;
  conversionGrowth: number;
  pipelineValueEur: number;
  pipelineGrowth: number;
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

export interface IGa4Adapter {
  getRealtimeActiveUsers(): Promise<{ activeUsers: number; byCountry: Record<string, number> }>;
  getTrafficReport(startDate: string, endDate: string): Promise<TrafficMetricRow[]>;
  getCampaignYield(dateRange: string): Promise<CampaignYieldRow[]>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface IGscAdapter {
  getTopSearchQueries(days?: number, limit?: number): Promise<GscQueryRow[]>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface IClarityAdapter {
  getUxTelemetryMetrics(): Promise<ClarityUxMetrics>;
  ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
}

export interface ISovereignAdapter {
  getAttributedLeadsCount(dateRange: string): Promise<number>;
  getAttributedPipelineValue(dateRange: string): Promise<number>;
  getRecentFounderInbound(limit?: number): Promise<any[]>;
}
