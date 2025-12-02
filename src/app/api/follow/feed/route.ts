import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { Bet } from '@/models/Bet';
import { FollowPurchase } from '@/models/FollowPurchase';
import { FollowedBetAction } from '@/models/FollowedBetAction';
import mongoose, { PipelineStage } from 'mongoose';

export const runtime = 'nodejs';

/**
 * GET /api/follow/feed
 * Returns bets from creators the user is following
 * Shows bets from ALL companies where followed creators exist (person-level tracking)
 * Optimized using MongoDB aggregation for heavy follow counts
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    const headers = await import('next/headers').then(m => m.headers());
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find current user - try with companyId first, fallback to whopUserId only
    let user = companyId 
      ? await User.findOne({ whopUserId: userId, companyId: companyId })
      : null;
    
    if (!user) {
      // Fallback: find any user record with this whopUserId
      user = await User.findOne({ whopUserId: userId });
    }
    
    if (!user || !user.whopUserId) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get pagination params
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10)));

    // Step 1: Get all active follow purchases for this user (single query)
    const activeFollows = await FollowPurchase.find({
      followerWhopUserId: user.whopUserId,
      status: 'active',
    }).lean();

    if (activeFollows.length === 0) {
      return NextResponse.json({
        bets: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        follows: [],
      });
    }

    // Step 2: Collect all unique capper whopUserIds and build follow metadata map
    const capperWhopUserIds = new Set<string>();
    const followMetadata = new Map<string, {
      followPurchaseId: string;
      remainingPlays: number;
      createdAt: Date;
      capperWhopUserId: string;
    }>();

    for (const follow of activeFollows) {
      if (!follow.capperWhopUserId) continue;
      
      const remainingPlays = follow.numPlaysPurchased - follow.numPlaysConsumed;
      if (remainingPlays <= 0) continue;

      capperWhopUserIds.add(follow.capperWhopUserId);
      followMetadata.set(follow.capperWhopUserId, {
        followPurchaseId: String(follow._id),
        remainingPlays,
        createdAt: follow.createdAt,
        capperWhopUserId: follow.capperWhopUserId,
      });
    }

    if (capperWhopUserIds.size === 0) {
      return NextResponse.json({
        bets: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        follows: [],
      });
    }

    // Step 3: Get ALL user records for all cappers across ALL companies (single batch query)
    const allCapperUsers = await User.find({
      whopUserId: { $in: Array.from(capperWhopUserIds) },
    }).select('_id companyId whopUserId alias whopUsername whopDisplayName whopAvatarUrl').lean();

    // Step 4: Group capper users by whopUserId and build user ID to company mappings
    const capperUserMap = new Map<string, Array<{
      _id: mongoose.Types.ObjectId;
      companyId: string;
      whopUserId: string;
    }>>();

    const capperInfoMap = new Map<string, {
      alias?: string;
      whopUsername?: string;
      whopDisplayName?: string;
      whopAvatarUrl?: string;
    }>();

    for (const capperUser of allCapperUsers) {
      const whopUserId = capperUser.whopUserId;
      if (!whopUserId || !capperUser.companyId) continue;

      const userId = typeof capperUser._id === 'string' 
        ? new mongoose.Types.ObjectId(capperUser._id)
        : capperUser._id as mongoose.Types.ObjectId;

      if (!capperUserMap.has(whopUserId)) {
        capperUserMap.set(whopUserId, []);
      }
      capperUserMap.get(whopUserId)!.push({
        _id: userId,
        companyId: capperUser.companyId,
        whopUserId: whopUserId,
      });

      // Store capper info (use first user record's info)
      if (!capperInfoMap.has(whopUserId)) {
        capperInfoMap.set(whopUserId, {
          alias: capperUser.alias,
          whopUsername: capperUser.whopUsername,
          whopDisplayName: capperUser.whopDisplayName,
          whopAvatarUrl: capperUser.whopAvatarUrl,
        });
      }
    }

    // Step 5: Build bet query conditions for ALL cappers across ALL companies (single query using $or)
    const betOrConditions: Array<{
      userId: mongoose.Types.ObjectId;
      companyId: string;
      createdAt: { $gte: Date };
    }> = [];

    for (const [capperWhopUserId, metadata] of followMetadata.entries()) {
      const capperUsers = capperUserMap.get(capperWhopUserId);
      if (!capperUsers) continue;

      for (const capperUser of capperUsers) {
        betOrConditions.push({
          userId: capperUser._id,
          companyId: capperUser.companyId,
          createdAt: { $gte: metadata.createdAt },
        });
      }
    }

    if (betOrConditions.length === 0) {
      return NextResponse.json({
        bets: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        follows: [],
      });
    }

    // Step 6: Get all bets in a single optimized query using aggregation
    // This replaces N*M queries with a single aggregated query
    const betPipeline: PipelineStage[] = [
      {
        $match: {
          $or: betOrConditions.map(condition => ({
            userId: new mongoose.Types.ObjectId(condition.userId),
            companyId: condition.companyId,
            createdAt: condition.createdAt,
          })),
          parlayId: { $exists: false },
        },
      },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'userId',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      {
        $unwind: {
          path: '$userInfo',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $addFields: {
          capperWhopUserId: '$userInfo.whopUserId',
        },
      },
      {
        $match: {
          capperWhopUserId: { $in: Array.from(capperWhopUserIds) },
        },
      },
      {
        $sort: { createdAt: 1 },
      },
    ];

    const allBetsRaw = await Bet.aggregate(betPipeline).allowDiskUse(true);

    // Step 7: Group bets by follow and limit to remaining plays per follow
    const betsByFollow = new Map<string, Array<typeof allBetsRaw[0]>>();

    for (const bet of allBetsRaw) {
      const capperWhopUserId = bet.capperWhopUserId;
      const metadata = followMetadata.get(capperWhopUserId);
      if (!metadata) continue;

      const followId = metadata.followPurchaseId;
      if (!betsByFollow.has(followId)) {
        betsByFollow.set(followId, []);
      }

      const followBets = betsByFollow.get(followId)!;
      if (followBets.length < metadata.remainingPlays) {
        followBets.push(bet);
      }
    }

    // Step 8: Flatten all bets and sort by creation date (newest first for feed)
    const allBets = Array.from(betsByFollow.values()).flat();
    allBets.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Step 9: Paginate
    const total = allBets.length;
    const paginatedBets = allBets.slice((page - 1) * pageSize, page * pageSize);

    // Step 9.5: Get action status for all bets (batch query)
    const betIds = paginatedBets.map(bet => {
      const id = bet._id;
      return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
    });
    const actions = await FollowedBetAction.find({
      followerWhopUserId: user.whopUserId,
      originalBetId: { $in: betIds },
    }).lean();
    
    const actionMap = new Map<string, { action: 'follow' | 'fade'; followedBetId?: string }>();
    for (const action of actions) {
      const originalBetIdStr = action.originalBetId instanceof mongoose.Types.ObjectId 
        ? action.originalBetId.toString() 
        : String(action.originalBetId);
      actionMap.set(originalBetIdStr, {
        action: action.action,
        followedBetId: action.followedBetId ? String(action.followedBetId) : undefined,
      });
    }

    // Step 10: Format bets with follow info and action status
    const bets = paginatedBets.map((bet) => {
      const capperWhopUserId = bet.capperWhopUserId;
      const metadata = followMetadata.get(capperWhopUserId);
      const betId = bet._id instanceof mongoose.Types.ObjectId 
        ? bet._id.toString() 
        : String(bet._id);
      const actionData = actionMap.get(betId);
      
      // Remove internal fields and add follow info
      const { userInfo, capperWhopUserId: _, ...betData } = bet;
      
      return {
        ...betData,
        followInfo: {
          followPurchaseId: metadata?.followPurchaseId || '',
          remainingPlays: metadata?.remainingPlays || 0,
        },
        actionStatus: actionData ? {
          action: actionData.action,
          followedBetId: actionData.followedBetId,
        } : null,
      };
    });

    // Step 11: Format follow info
    const follows = activeFollows.map((follow) => {
      const capperInfo = capperInfoMap.get(follow.capperWhopUserId || '') || {};
      return {
        followPurchaseId: String(follow._id),
        capper: {
          userId: String(follow.capperUserId),
          alias: capperInfo.alias || capperInfo.whopDisplayName || capperInfo.whopUsername || 'Unknown',
          avatarUrl: capperInfo.whopAvatarUrl,
        },
        numPlaysPurchased: follow.numPlaysPurchased,
        numPlaysConsumed: follow.numPlaysConsumed,
        remainingPlays: follow.numPlaysPurchased - follow.numPlaysConsumed,
        status: follow.status,
        createdAt: follow.createdAt,
      };
    });

    return NextResponse.json({
      bets,
      follows,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Error fetching follow feed:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
