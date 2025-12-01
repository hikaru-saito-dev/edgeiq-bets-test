import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User, IUser } from '@/models/User';
import { Bet } from '@/models/Bet';
import { aggregationStreakFunction } from '@/lib/aggregation/streaks';
import { PipelineStage } from 'mongoose';
import { getLeaderboardCache, setLeaderboardCache } from '@/lib/cache/statsCache';
import { recordApiMetric, recordCacheMetric } from '@/lib/metrics';
import { performance } from 'node:perf_hooks';

export const runtime = 'nodejs';

const rangeToCutoff = (range: 'all' | '30d' | '7d'): Date | null => {
  if (range === 'all') return null;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  if (range === '30d') {
    cutoff.setDate(cutoff.getDate() - 30);
  } else if (range === '7d') {
    cutoff.setDate(cutoff.getDate() - 7);
  }
  return cutoff;
};

const buildSortSpec = (sortField: string | null, sortDirection: 'asc' | 'desc') => {
  const direction: 1 | -1 = sortDirection === 'asc' ? 1 : -1;
  const inverseDirection: 1 | -1 = direction === 1 ? -1 : 1;
  const spec: Record<string, 1 | -1> = {};
  switch (sortField) {
    case 'Whop':
      spec.aliasLower = direction;
      spec.unitsPL = inverseDirection;
      spec.winRate = inverseDirection;
      break;
    case 'winRate':
      spec.winRate = direction;
      spec.unitsPL = inverseDirection;
      break;
    case 'roi':
      spec.roi = direction;
      spec.unitsPL = inverseDirection;
      break;
    case 'netPnl':
    case 'unitsPL':
      spec.unitsPL = direction;
      spec.winRate = inverseDirection;
      break;
    case 'winsLosses':
      spec.plays = direction;
      spec.unitsPL = inverseDirection;
      break;
    case 'currentStreak':
      spec.currentStreak = direction;
      spec.unitsPL = inverseDirection;
      break;
    case 'longestStreak':
      spec.longestStreak = direction;
      spec.unitsPL = inverseDirection;
      break;
    case 'rank':
    default:
      spec.unitsPL = direction;
      spec.winRate = direction;
      break;
  }
  spec.aliasLower = spec.aliasLower ?? 1;
  spec._id = spec._id ?? 1;
  return spec;
};

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const range = (searchParams.get('range') || 'all') as 'all' | '30d' | '7d';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10)));
    const search = (searchParams.get('search') || '').trim();
    const sortField = searchParams.get('sortField') || null;
    const sortDirection = (searchParams.get('sortDirection') || 'desc') as 'asc' | 'desc';

    // Only show companyOwners who opted in and have companyId set
    const baseQuery: Record<string, unknown> = {
      optIn: true,
      role: 'companyOwner',
    };

    const cutoffDate = rangeToCutoff(range);

    const searchRegex = search
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;

    const startTime = performance.now();
    const sortSpec = buildSortSpec(sortField, sortDirection);
    const cacheKey = JSON.stringify({
      range,
      page,
      pageSize,
      search,
      sortField,
      sortDirection,
    });

    const cachedResponse = getLeaderboardCache(cacheKey);
    if (cachedResponse) {
      recordCacheMetric('leaderboard', true);
      recordApiMetric('leaderboard#get', {
        durationMs: Math.round(performance.now() - startTime),
        cacheHit: true,
        meta: { total: cachedResponse.total },
      });
      return NextResponse.json(cachedResponse);
    }

    const pipeline: PipelineStage[] = [
      { $match: { ...baseQuery, companyId: { $exists: true, $ne: null } } },
      {
        $lookup: {
          from: User.collection.name,
          let: { companyId: '$companyId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$companyId', '$$companyId'] },
                    { $in: ['$role', ['companyOwner', 'owner', 'admin']] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'companyUsers',
        },
      },
      {
        $addFields: {
          companyUserIds: {
            $map: { input: '$companyUsers', as: 'u', in: '$$u._id' },
          },
        },
      },
      {
        $lookup: {
          from: Bet.collection.name,
          let: { companyId: '$companyId', userIds: '$companyUserIds' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$companyId', '$$companyId'] },
                    {
                      $cond: [
                        { $gt: [{ $size: '$$userIds' }, 0] },
                        { $in: ['$userId', '$$userIds'] },
                        false,
                      ],
                    },
                  ],
                },
                parlayId: { $exists: false }, // Exclude parlay legs
                result: { $ne: 'pending' }, // Only settled bets
              },
            },
            ...(cutoffDate ? [{ $match: { createdAt: { $gte: cutoffDate } } }] : []),
            {
              $project: {
                result: 1,
                units: 1,
                odds: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          as: 'settledBets',
        },
      },
      {
        $addFields: {
          winCount: {
            $size: {
              $filter: {
                input: '$settledBets',
                cond: { $eq: ['$$this.result', 'win'] },
              },
            },
          },
          lossCount: {
            $size: {
              $filter: {
                input: '$settledBets',
                cond: { $eq: ['$$this.result', 'loss'] },
              },
            },
          },
          pushCount: {
            $size: {
              $filter: {
                input: '$settledBets',
                cond: { $eq: ['$$this.result', 'push'] },
              },
            },
          },
          voidCount: {
            $size: {
              $filter: {
                input: '$settledBets',
                cond: { $eq: ['$$this.result', 'void'] },
              },
            },
          },
          plays: { $size: '$settledBets' },
          unitsPL: {
            $round: [
              {
                $sum: {
                  $map: {
                    input: '$settledBets',
                    as: 'bet',
                    in: {
                      $cond: [
                        { $eq: ['$$bet.result', 'win'] },
                        { $multiply: ['$$bet.units', { $subtract: ['$$bet.odds', 1] }] },
                        {
                          $cond: [
                            { $eq: ['$$bet.result', 'loss'] },
                            { $multiply: ['$$bet.units', -1] },
                            0,
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              2,
            ],
          },
          totalUnitsWagered: {
            $sum: {
              $map: {
                input: '$settledBets',
                as: 'bet',
                in: {
                  $cond: [
                    { $eq: ['$$bet.result', 'void'] },
                    0,
                    '$$bet.units',
                  ],
                },
              },
            },
          },
          betOutcomes: {
            $map: {
              input: '$settledBets',
              as: 'bet',
              in: {
                result: '$$bet.result',
                createdAt: '$$bet.createdAt',
                updatedAt: '$$bet.updatedAt',
              },
            },
          },
        },
      },
      {
        $addFields: {
          winRate: {
            $round: [
              {
                $cond: [
                  { $gt: [{ $add: ['$winCount', '$lossCount'] }, 0] },
                  {
                    $multiply: [
                      {
                        $divide: ['$winCount', { $add: ['$winCount', '$lossCount'] }],
                      },
                      100,
                    ],
                  },
                  0,
                ],
              },
              2,
            ],
          },
          roi: {
            $round: [
              {
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
              2,
            ],
          },
          aliasLower: {
            $toLower: {
              $ifNull: [
                '$alias',
                { $ifNull: ['$whopDisplayName', '$whopUsername'] },
              ],
            },
          },
        },
      },
    ];

    // Add search filter before sorting if provided
    if (searchRegex) {
      pipeline.push({
        $match: {
          $or: [
            { alias: searchRegex },
            { whopDisplayName: searchRegex },
            { whopUsername: searchRegex },
          ],
        },
      });
    }

    // Add sorting, then project to remove internal fields, then facet for pagination
    pipeline.push(
      { $sort: sortSpec },
      {
        $project: {
          companyUsers: 0,
          companyUserIds: 0,
          settledBets: 0,
          aliasLower: 0,
        },
      },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
          ],
          totalCount: [{ $count: 'count' }],
        },
      }
    );

    const aggregated = await User.aggregate(pipeline).allowDiskUse(true);
    const facetResult = aggregated[0] || { data: [], totalCount: [] };
    const total = facetResult.totalCount[0]?.count || 0;

    const leaderboard = (facetResult.data as Array<IUser & Record<string, unknown>>).map((entry, index) => {
      const membershipPlans = (entry.membershipPlans || []).map((plan) => {
        const typedPlan = plan as {
          id: string;
          name: string;
          description?: string;
          price: string;
          url: string;
          isPremium?: boolean;
        };
        let affiliateLink: string | null = null;
        if (typedPlan.url) {
          try {
            const url = new URL(typedPlan.url);
            url.searchParams.set('a', 'woodiee');
            affiliateLink = url.toString();
          } catch {
            affiliateLink = `${typedPlan.url}${typedPlan.url.includes('?') ? '&' : '?'}a=woodiee`;
          }
        }
        return {
          ...typedPlan,
          affiliateLink,
          isPremium: typedPlan.isPremium ?? false,
        };
      });

      const streaks = aggregationStreakFunction(
        (entry.betOutcomes as Array<{ result?: string; createdAt?: Date; updatedAt?: Date }> | undefined) || []
      );

      return {
        userId: String(entry._id),
        alias: entry.alias,
        whopDisplayName: entry.whopDisplayName,
        whopUsername: entry.whopUsername,
        whopAvatarUrl: entry.whopAvatarUrl,
        companyId: entry.companyId,
        membershipPlans,
        followOffer: entry.followOfferEnabled
          ? {
            enabled: entry.followOfferEnabled,
            priceCents: entry.followOfferPriceCents || 0,
            numPlays: entry.followOfferNumPlays || 0,
            checkoutUrl: entry.followOfferCheckoutUrl || null,
          }
          : null,
        winRate: Number(entry.winRate ?? 0),
        roi: Number(entry.roi ?? 0),
        unitsPL: Number(entry.unitsPL ?? 0),
        plays: Number(entry.plays ?? 0),
        wins: Number(entry.winCount ?? 0),
        losses: Number(entry.lossCount ?? 0),
        currentStreak: streaks.current,
        longestStreak: streaks.longest,
        rank: index + 1 + (page - 1) * pageSize,
      };
    });

    const payload = {
      leaderboard,
      range,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };

    setLeaderboardCache(cacheKey, payload);
    recordCacheMetric('leaderboard', false);
    recordApiMetric('leaderboard#get', {
      durationMs: Math.round(performance.now() - startTime),
      cacheHit: false,
      meta: { total },
    });

    return NextResponse.json(payload);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
