import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { Bet } from '@/models/Bet';
import { FollowPurchase } from '@/models/FollowPurchase';

export const runtime = 'nodejs';

/**
 * GET /api/follow/feed
 * Returns bets from creators the user is following
 * Filters bets based on active FollowPurchase records and remaining plays
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

    // Find current user
    const user = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get pagination params
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10)));

    // Find all active follow purchases for this user
    const activeFollows = await FollowPurchase.find({
      followerUserId: user._id,
      status: 'active',
    }).populate('capperUserId', 'alias whopUsername whopDisplayName whopAvatarUrl');

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

    // Collect all bets from followed creators
    // For each follow, get bets created after the follow purchase date
    // Limited to remaining plays for that follow
    const allBets: Array<{
      bet: unknown;
      followPurchaseId: string;
      capperId: string;
      createdAt: Date;
    }> = [];

    for (const follow of activeFollows) {
      const capperId = typeof follow.capperUserId === 'object' && follow.capperUserId && '_id' in follow.capperUserId
        ? follow.capperUserId._id
        : follow.capperUserId;
      
      const remainingPlays = follow.numPlaysPurchased - follow.numPlaysConsumed;
      
      if (remainingPlays <= 0) {
        continue; // No remaining plays for this follow
      }

      // Get bets from this capper created after the follow purchase
      // Ordered by creation date, limited to remaining plays
      const bets = await Bet.find({
        userId: capperId,
        companyId: companyId,
        parlayId: { $exists: false }, // Exclude parlay legs
        createdAt: { $gte: follow.createdAt }, // Created after follow purchase
      })
        .sort({ createdAt: 1 }) // Oldest first (to get the "next X plays" in order)
        .limit(remainingPlays)
        .lean();

      // Add bets to collection with follow info
      bets.forEach((bet) => {
        allBets.push({
          bet,
          followPurchaseId: String(follow._id),
          capperId: String(capperId),
          createdAt: bet.createdAt as Date,
        });
      });
    }

    // Sort all bets by creation date (newest first for feed)
    allBets.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Paginate
    const total = allBets.length;
    const paginatedBets = allBets.slice((page - 1) * pageSize, page * pageSize);

    // Format bets with follow info
    const bets = paginatedBets.map((item) => {
      // Get the follow purchase for this bet
      const follow = activeFollows.find(
        (f) => String(f._id) === item.followPurchaseId
      );
      
      return {
        ...(item.bet as Record<string, unknown>),
        followInfo: {
          followPurchaseId: item.followPurchaseId,
          remainingPlays: follow
            ? follow.numPlaysPurchased - follow.numPlaysConsumed
            : 0,
        },
      };
    });

    // Get follow info for each active follow
    const follows = activeFollows.map((follow) => {
      const capper = follow.capperUserId as unknown as {
        alias?: string;
        whopUsername?: string;
        whopDisplayName?: string;
        whopAvatarUrl?: string;
      };
      return {
        followPurchaseId: String(follow._id),
        capper: {
          userId: String(follow.capperUserId),
          alias: capper.alias || capper.whopDisplayName || capper.whopUsername || 'Unknown',
          avatarUrl: capper.whopAvatarUrl,
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

