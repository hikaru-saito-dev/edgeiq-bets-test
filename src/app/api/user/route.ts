import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User, MembershipPlan, Webhook } from '@/models/User';
import { Bet } from '@/models/Bet';
import { calculateStatsFromAggregation } from '@/lib/stats';
import { aggregationStreakFunction } from '@/lib/aggregation/streaks';
import { getPersonalStatsCache, setPersonalStatsCache, getCompanyStatsCache, setCompanyStatsCache } from '@/lib/cache/statsCache';
import { PipelineStage } from 'mongoose';
import { recordApiMetric, recordCacheMetric } from '@/lib/metrics';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

export const runtime = 'nodejs';

// Validate Whop product page URL (not checkout links)
const whopProductUrlSchema = z.string().url().refine(
  (url) => {
    try {
      const urlObj = new URL(url);
      // Must be whop.com domain
      if (!urlObj.hostname.includes('whop.com')) return false;
      // Must not be a checkout link (checkout, pay, purchase, etc.)
      const path = urlObj.pathname.toLowerCase();
      const forbiddenPaths = ['/checkout', '/pay', '/purchase', '/buy', '/payment'];
      if (forbiddenPaths.some(forbidden => path.includes(forbidden))) return false;
      // Must not have query params that indicate checkout
      const queryParams = urlObj.searchParams.toString().toLowerCase();
      if (queryParams.includes('checkout') || queryParams.includes('payment')) return false;
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid Whop product page URL (not a checkout link)' }
);

const webhookSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  type: z.enum(['whop', 'discord']),
});

const updateUserSchema = z.object({
  alias: z.string().min(1).max(50).optional(),
  // companyId is auto-set from Whop headers, cannot be manually updated
  companyName: z.string().max(100).optional(), // Only companyOwners can set
  companyDescription: z.string().max(500).optional(), // Only companyOwners can set
  optIn: z.boolean().optional(), // Only owners and companyOwners can opt-in
  hideLeaderboardFromMembers: z.boolean().optional(), // Only companyOwners can set
  webhooks: z.array(webhookSchema).optional(), // Array of webhooks with names
  notifyOnSettlement: z.boolean().optional(),
  onlyNotifyWinningSettlements: z.boolean().optional(), // Only send settlement webhooks for winning bets
  membershipPlans: z.array(z.object({
    id: z.string(),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    price: z.string().max(50),
    url: whopProductUrlSchema,
    isPremium: z.boolean().optional(),
  })).optional(), // Only owners and companyOwners can manage membership plans
});

/**
 * Calculate stats using aggregation pipeline for personal bets
 */
async function calculatePersonalStatsAggregation(userId: string, companyId: string): Promise<ReturnType<typeof calculateStatsFromAggregation>> {
  const cacheKey = `personal:${userId}:${companyId}`;
  const cached = getPersonalStatsCache(cacheKey);
  if (cached) {
    recordCacheMetric('personalStats', true);
    return cached;
  }

  const startTime = performance.now();

  // Import mongoose to convert string to ObjectId
  const mongoose = await import('mongoose');
  const userIdObj = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  const pipeline: PipelineStage[] = [
    {
      $match: {
        userId: userIdObj,
        companyId: companyId,
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
        pushes: {
          $sum: { $cond: [{ $eq: ['$result', 'push'] }, 1, 0] },
        },
        voids: {
          $sum: { $cond: [{ $eq: ['$result', 'void'] }, 1, 0] },
        },
        totalBets: { $sum: 1 },
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
            $cond: [
              { $eq: ['$result', 'void'] },
              0,
              '$units',
            ],
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
    pushes: 0,
    voids: 0,
    totalBets: 0,
    unitsPL: 0,
    roi: 0,
    winRate: 0,
    betOutcomes: [],
  };

  const stats = calculateStatsFromAggregation(aggResult, aggregationStreakFunction);

  recordCacheMetric('personalStats', false);
  recordApiMetric('user#getPersonalStats', {
    durationMs: Math.round(performance.now() - startTime),
    cacheHit: false,
  });

  setPersonalStatsCache(cacheKey, stats);
  return stats;
}

/**
 * Calculate stats using aggregation pipeline for company bets
 */
async function calculateCompanyStatsAggregation(companyUserIds: string[], companyId: string): Promise<ReturnType<typeof calculateStatsFromAggregation>> {
  const cacheKey = `company:${companyId}:${companyUserIds.join(',')}`;
  const cached = getCompanyStatsCache(cacheKey);
  if (cached) {
    recordCacheMetric('companyStats', true);
    return cached;
  }

  const startTime = performance.now();

  // Convert string IDs to ObjectIds
  const mongoose = await import('mongoose');
  const companyUserIdsObj = companyUserIds.map(id => new mongoose.Types.ObjectId(id));

  const pipeline: PipelineStage[] = [
    {
      $match: {
        userId: { $in: companyUserIdsObj },
        companyId: companyId,
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
        pushes: {
          $sum: { $cond: [{ $eq: ['$result', 'push'] }, 1, 0] },
        },
        voids: {
          $sum: { $cond: [{ $eq: ['$result', 'void'] }, 1, 0] },
        },
        totalBets: { $sum: 1 },
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
            $cond: [
              { $eq: ['$result', 'void'] },
              0,
              '$units',
            ],
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
    pushes: 0,
    voids: 0,
    totalBets: 0,
    unitsPL: 0,
    roi: 0,
    winRate: 0,
    betOutcomes: [],
  };

  const stats = calculateStatsFromAggregation(aggResult, aggregationStreakFunction);

  recordCacheMetric('companyStats', false);
  recordApiMetric('user#getCompanyStats', {
    durationMs: Math.round(performance.now() - startTime),
    cacheHit: false,
  });

  setCompanyStatsCache(cacheKey, stats);
  return stats;
}

/**
 * GET /api/user
 * Get current user profile and stats
 * For owners: returns both personal stats and company stats (aggregated from all company bets)
 */
export async function GET() {
  try {
    await connectDB();
    const headers = await import('next/headers').then(m => m.headers());
    
    // Read userId and companyId from headers (set by client from context)
    const verifiedUserId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');
    if (!verifiedUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find user by whopUserId only (companyId is manually entered)
    const user = await User.findOne({ whopUserId: verifiedUserId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Calculate personal stats using aggregation
    const personalStats = await calculatePersonalStatsAggregation(String(user._id), companyId || '');

    // Auto-fetch company name from Whop if not set
    if (user.companyId && !user.companyName) {
      try {
        const { getWhopCompany } = await import('@/lib/whop');
        const companyData = await getWhopCompany(user.companyId);
        if (companyData?.name) {
          user.companyName = companyData.name;
          await user.save();
        }
      } catch {
        // Ignore errors
      }
    }

    // For owners and companyOwners: also get company stats (aggregated from all company bets)
    let companyStats = null;
    if ((user.role === 'owner' || user.role === 'companyOwner') && user.companyId) {
      // Get all users in the same company with roles that contribute to company stats
      // Exclude members - only include owner/admin/companyOwner roles
      const companyUsers = await User.find({ 
        companyId: user.companyId,
        role: { $in: ['companyOwner', 'owner', 'admin'] }
      }).select('_id');
      const companyUserIds = companyUsers.map(u => String(u._id));
      
      // Calculate company stats using aggregation
      companyStats = await calculateCompanyStatsAggregation(companyUserIds, companyId || '');
    }

    return NextResponse.json({
      user: {
        alias: user.alias,
        role: user.role,
        companyId: user.companyId,
        companyName: user.companyName,
        companyDescription: user.companyDescription,
        optIn: user.optIn,
        whopUsername: user.whopUsername,
        whopDisplayName: user.whopDisplayName,
        whopAvatarUrl: user.whopAvatarUrl,
        webhooks: user.webhooks || [],
        notifyOnSettlement: user.notifyOnSettlement ?? false,
        onlyNotifyWinningSettlements: user.onlyNotifyWinningSettlements ?? false,
        membershipPlans: user.membershipPlans || [],
        hideLeaderboardFromMembers: user.hideLeaderboardFromMembers ?? false,
      },
      personalStats,
      companyStats, // Only for owners with companyId
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/user
 * Update user profile
 * - Only owners can opt-in to leaderboard
 * - Only owners can manage membership plans
 * - Only owners can set companyName and companyDescription
 * - Enforce only 1 owner per companyId
 */
export async function PATCH(request: NextRequest) {
  try {
    await connectDB();
    const headers = await import('next/headers').then(m => m.headers());
    
    // Read userId and companyId from headers (set by client from context)
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validated = updateUserSchema.parse(body);

    // Find user
    const user = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Update alias (all roles can update)
    if (validated.alias !== undefined) {
      user.alias = validated.alias;
    }

    // companyId is auto-set from Whop headers, cannot be manually updated
    
    // Update companyName and companyDescription (only companyOwners can manually update)
    // These are auto-fetched from Whop, but companyOwner can override them
    if (user.role === 'companyOwner') {
      if (validated.companyName !== undefined) {
        user.companyName = validated.companyName || undefined;
      }
      if (validated.companyDescription !== undefined) {
        user.companyDescription = validated.companyDescription || undefined;
      }
      
      // Only owners and companyOwners can opt-in to leaderboard
      if (validated.optIn !== undefined) {
        user.optIn = validated.optIn;
      }
      
      // Only owners can manage membership plans
      if (validated.membershipPlans !== undefined) {
        user.membershipPlans = validated.membershipPlans as MembershipPlan[];
      }
      
      // Only companyOwners can set hideLeaderboardFromMembers
      if (validated.hideLeaderboardFromMembers !== undefined) {
        user.hideLeaderboardFromMembers = validated.hideLeaderboardFromMembers;
      }
    } else {
      // Admins cannot opt-in or manage membership plans
      if (validated.optIn !== undefined || validated.membershipPlans !== undefined) {
        return NextResponse.json(
          { error: 'Only owners and company owners can opt-in to leaderboard and manage membership plans' },
          { status: 403 }
        );
      }
    }

    // Update webhooks array
    if (validated.webhooks !== undefined) {
      user.webhooks = validated.webhooks as Webhook[];
    }
    
    if (validated.notifyOnSettlement !== undefined) {
      user.notifyOnSettlement = validated.notifyOnSettlement;
    }
    
    if (validated.onlyNotifyWinningSettlements !== undefined) {
      user.onlyNotifyWinningSettlements = validated.onlyNotifyWinningSettlements;
    }

    await user.save();

    return NextResponse.json({ 
      message: 'User updated successfully',
      user: {
        alias: user.alias,
        role: user.role,
        companyId: user.companyId,
        companyName: user.companyName,
        companyDescription: user.companyDescription,
        optIn: user.optIn,
        membershipPlans: user.membershipPlans,
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Error updating user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
