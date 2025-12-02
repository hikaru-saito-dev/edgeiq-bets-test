import { IBet, Bet } from '@/models/Bet';
import { User } from '@/models/User';
import { PipelineStage } from 'mongoose';
import { aggregationStreakFunction } from '@/lib/aggregation/streaks';
import mongoose from 'mongoose';

export interface BetSummary {
  totalBets: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number;
  roi: number;
  unitsPL: number;
  currentStreak: number;
  longestStreak: number;
}

/**
 * Calculate comprehensive betting statistics from a list of bets
 */
export function calculateStats(bets: IBet[]): BetSummary {
  const settledBets = bets.filter(bet =>
    bet.result !== 'pending'
  );

  const totalBets = settledBets.length;
  const wins = settledBets.filter(b => b.result === 'win').length;
  const losses = settledBets.filter(b => b.result === 'loss').length;
  const pushes = settledBets.filter(b => b.result === 'push').length;
  const voids = settledBets.filter(b => b.result === 'void').length;

  // Calculate win rate (excluding pushes and voids)
  const actionableBets = wins + losses;
  const winRate = actionableBets > 0 ? (wins / actionableBets) * 100 : 0;

  // Calculate units P/L
  // Win: profit based on odds (odds stored as decimal)
  // Loss: -units
  // Push/Void: 0
  // Note: odds are always stored as decimal format in DB
  let unitsPL = 0;
  settledBets.forEach(bet => {
    if (bet.result === 'win') {
      // Decimal odds: profit = units * (odds - 1)
      unitsPL += bet.units * (bet.odds - 1);
    } else if (bet.result === 'loss') {
      unitsPL -= bet.units;
    }
    // push and void don't affect P/L
  });

  // Calculate ROI (Return on Investment)
  const totalUnitsWagered = settledBets.reduce((sum, bet) => {
    if (bet.result === 'void') return sum;
    return sum + bet.units;
  }, 0);
  const roi = totalUnitsWagered > 0 ? (unitsPL / totalUnitsWagered) * 100 : 0;

  // Calculate streaks
  // Sort by creation date (oldest first) to calculate streaks chronologically
  const sortedBets = [...settledBets].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime()
  );

  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;

  for (const bet of sortedBets) {
    if (bet.result === 'win') {
      tempStreak++;
      currentStreak = tempStreak;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else if (bet.result === 'loss') {
      tempStreak = 0;
      currentStreak = 0;
    }
    // Push and void don't break or extend streaks
  }

  return {
    totalBets,
    wins,
    losses,
    pushes,
    voids,
    winRate: Math.round(winRate * 100) / 100, // Round to 2 decimal places
    roi: Math.round(roi * 100) / 100,
    unitsPL: Math.round(unitsPL * 100) / 100,
    currentStreak,
    longestStreak,
  };
}

/**
 * Update user stats based on their bets (legacy - uses array of bets)
 * @deprecated Use updateUserStatsFromAggregation instead for better performance
 */
export async function updateUserStats(userId: string, bets: IBet[]): Promise<void> {
  const stats = calculateStats(bets);

  await User.findByIdAndUpdate(userId, {
    $set: {
      'stats.winRate': stats.winRate,
      'stats.roi': stats.roi,
      'stats.unitsPL': stats.unitsPL,
      'stats.currentStreak': stats.currentStreak,
      'stats.longestStreak': stats.longestStreak,
    },
  });
}

/**
 * Update user stats using MongoDB aggregation (optimized version)
 * This avoids fetching all bets into memory
 */
export async function updateUserStatsFromAggregation(whopUserId: string, companyId: string): Promise<void> {
  // Note: companyId parameter is kept for backward compatibility but no longer used in bet queries
  // since bets are no longer company-scoped

  const pipeline: PipelineStage[] = [
    {
      $match: {
        whopUserId: whopUserId,
        parlayId: { $exists: false },
        result: { $ne: 'pending' },
      },
    },
    {
      $group: {
        _id: null,
        wins: {
          $sum: { $cond: [{ $eq: ['$result', 'win'] }, 1, 0] },
        },
        losses: {
          $sum: { $cond: [{ $eq: ['$result', 'loss'] }, 1, 0] },
        },
        unitsPL: {
          $sum: {
            $cond: [
              { $eq: ['$result', 'win'] },
              { $multiply: ['$units', { $subtract: ['$odds', 1] }] },
              {
                $cond: [
                  { $eq: ['$result', 'loss'] },
                  { $multiply: ['$units', -1] },
                  0,
                ],
              },
            ],
          },
        },
        totalUnitsWagered: {
          $sum: {
            $cond: [{ $ne: ['$result', 'void'] }, '$units', 0],
          },
        },
        betOutcomes: {
          $push: {
            result: '$result',
            createdAt: '$createdAt',
            updatedAt: '$updatedAt',
          },
        },
      },
    },
    {
      $addFields: {
        winRate: {
          $cond: [
            { $gt: [{ $add: ['$wins', '$losses'] }, 0] },
            {
              $multiply: [
                { $divide: ['$wins', { $add: ['$wins', '$losses'] }] },
                100,
              ],
            },
            0,
          ],
        },
        roi: {
          $cond: [
            { $gt: ['$totalUnitsWagered', 0] },
            {
              $multiply: [
                { $divide: ['$unitsPL', '$totalUnitsWagered'] },
                100,
              ],
            },
            0,
          ],
        },
      },
    },
  ];

  const result = await Bet.aggregate(pipeline).allowDiskUse(true);
  const aggResult = result[0] || {
    wins: 0,
    losses: 0,
    unitsPL: 0,
    totalUnitsWagered: 0,
    winRate: 0,
    roi: 0,
    betOutcomes: [],
  };

  const streaks = aggregationStreakFunction(aggResult.betOutcomes || []);

  // Update all user records with this whopUserId (across all companies)
  await User.updateMany(
    { whopUserId: whopUserId },
    {
      $set: {
        'stats.winRate': Math.round(aggResult.winRate * 100) / 100,
        'stats.roi': Math.round(aggResult.roi * 100) / 100,
        'stats.unitsPL': Math.round(aggResult.unitsPL * 100) / 100,
        'stats.currentStreak': streaks.current,
        'stats.longestStreak': streaks.longest,
      },
    }
  );
}

/**
 * Filter bets by date range
 */
export function filterBetsByDateRange(
  bets: IBet[],
  range: 'all' | '30d' | '7d'
): IBet[] {
  if (range === 'all') return bets;

  const now = new Date();
  const cutoffDate = new Date();

  if (range === '30d') {
    cutoffDate.setDate(now.getDate() - 30);
  } else if (range === '7d') {
    cutoffDate.setDate(now.getDate() - 7);
  }

  return bets.filter(bet => bet.createdAt >= cutoffDate);
}

/**
 * Calculate stats from MongoDB aggregation result
 * Takes aggregated stats from pipeline and adds streak calculation
 */
export function calculateStatsFromAggregation(
  aggResult: {
    wins?: number;
    losses?: number;
    pushes?: number;
    voids?: number;
    totalBets?: number;
    plays?: number;
    unitsPL?: number;
    roi?: number;
    winRate?: number;
    betOutcomes?: Array<{ result?: string; createdAt?: Date; updatedAt?: Date }>;
  },
  streakFunction: (bets: Array<{ result?: string; createdAt?: Date; updatedAt?: Date }>) => { current: number; longest: number }
): BetSummary {
  const wins = aggResult.wins ?? aggResult.totalBets ?? 0;
  const losses = aggResult.losses ?? 0;
  const pushes = aggResult.pushes ?? 0;
  const voids = aggResult.voids ?? 0;
  const totalBets = aggResult.totalBets ?? aggResult.plays ?? 0;
  const unitsPL = aggResult.unitsPL ?? 0;
  const roi = aggResult.roi ?? 0;
  const winRate = aggResult.winRate ?? 0;

  // Calculate streaks from betOutcomes array
  const betOutcomes = aggResult.betOutcomes || [];
  const streaks = streakFunction(betOutcomes);

  return {
    totalBets,
    wins,
    losses,
    pushes,
    voids,
    winRate: Math.round(winRate * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    unitsPL: Math.round(unitsPL * 100) / 100,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
  };
}

