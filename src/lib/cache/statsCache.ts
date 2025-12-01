import { TTLCache } from './ttlCache';
import type { BetSummary } from '@/lib/stats';

type LeaderboardPayload = {
  leaderboard: unknown;
  range: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const leaderboardCache = new TTLCache<LeaderboardPayload>(30_000);
const companyStatsCache = new TTLCache<BetSummary>(15_000);
const personalStatsCache = new TTLCache<BetSummary>(10_000);

export const getLeaderboardCache = (key: string) => leaderboardCache.get(key);
export const setLeaderboardCache = (key: string, value: LeaderboardPayload) =>
  leaderboardCache.set(key, value);
export const invalidateLeaderboardCache = () => leaderboardCache.clear();

export const getCompanyStatsCache = (companyId: string) =>
  companyStatsCache.get(companyId);
export const setCompanyStatsCache = (companyId: string, stats: BetSummary) =>
  companyStatsCache.set(companyId, stats);
export const invalidateCompanyStatsCache = (companyId?: string) => {
  if (!companyId) {
    companyStatsCache.clear();
    return;
  }
  companyStatsCache.delete(companyId);
};

export const getPersonalStatsCache = (key: string) =>
  personalStatsCache.get(key);
export const setPersonalStatsCache = (key: string, stats: BetSummary) =>
  personalStatsCache.set(key, stats);
export const invalidatePersonalStatsCache = (userId?: string) => {
  if (!userId) {
    personalStatsCache.clear();
    return;
  }
  personalStatsCache.deleteByPrefix(`personal:${userId}:`);
};

