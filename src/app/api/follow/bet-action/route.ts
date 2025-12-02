import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { User } from '@/models/User';
import { Bet, IBet } from '@/models/Bet';
import { FollowedBetAction } from '@/models/FollowedBetAction';
import mongoose from 'mongoose';

export const runtime = 'nodejs';

/**
 * POST /api/follow/bet-action
 * Handle Follow or Fade action on a bet from the following feed
 * 
 * Body: {
 *   betId: string, // Original bet ID from the following feed
 *   action: 'follow' | 'fade'
 * }
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    
    const headers = await import('next/headers').then(m => m.headers());
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find current user - try with companyId first, fallback to whopUserId only
    let followerUser = companyId 
      ? await User.findOne({ whopUserId: userId, companyId: companyId })
      : null;
    
    if (!followerUser) {
      // Fallback: find any user record with this whopUserId
      followerUser = await User.findOne({ whopUserId: userId });
    }
    
    if (!followerUser || !followerUser.whopUserId) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const body = await request.json();
    const { betId, action } = body;

    if (!betId || !action) {
      return NextResponse.json(
        { error: 'betId and action are required' },
        { status: 400 }
      );
    }

    if (action !== 'follow' && action !== 'fade') {
      return NextResponse.json(
        { error: 'action must be "follow" or "fade"' },
        { status: 400 }
      );
    }

    // Check if user already took an action on this bet
    const existingAction = await FollowedBetAction.findOne({
      followerWhopUserId: followerUser.whopUserId,
      originalBetId: new mongoose.Types.ObjectId(betId),
    });

    if (existingAction) {
      // User already took an action, return the existing action
      return NextResponse.json({
        success: true,
        action: existingAction.action,
        message: `Bet already ${existingAction.action === 'follow' ? 'followed' : 'faded'}`,
      });
    }

    // Find the original bet
    const originalBet = await Bet.findById(betId);
    if (!originalBet) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }

    let followedBetId: mongoose.Types.ObjectId | undefined;

    if (action === 'follow') {
      // Create a duplicate bet for the follower
      // Exclude system fields that should be new for the follower's bet
      const betData: Partial<IBet> = {
        userId: followerUser._id,
        whopUserId: followerUser.whopUserId,
        startTime: originalBet.startTime,
        units: originalBet.units,
        result: 'pending' as const,
        locked: originalBet.locked,
        eventName: originalBet.eventName,
        sport: originalBet.sport,
        league: originalBet.league,
        homeTeam: originalBet.homeTeam,
        awayTeam: originalBet.awayTeam,
        homeTeamId: originalBet.homeTeamId,
        awayTeamId: originalBet.awayTeamId,
        provider: originalBet.provider,
        providerEventId: originalBet.providerEventId,
        sportKey: originalBet.sportKey,
        marketType: originalBet.marketType,
        selection: originalBet.selection,
        line: originalBet.line,
        overUnder: originalBet.overUnder,
        playerName: originalBet.playerName,
        playerId: originalBet.playerId,
        playerKey: originalBet.playerKey,
        statType: originalBet.statType,
        parlaySummary: originalBet.parlaySummary,
        odds: originalBet.odds,
        oddsFormat: originalBet.oddsFormat,
        oddsAmerican: originalBet.oddsAmerican,
        book: originalBet.book,
        notes: originalBet.notes,
        slipImageUrl: originalBet.slipImageUrl,
        // Don't copy selectedWebhookIds - let the follower set their own
        // Don't copy parlayId - parlays should be independent
      };

      // Create the new bet
      const newBet = new Bet(betData);
      await newBet.save();
      
      followedBetId = newBet._id;

      // If it's a parlay, duplicate the legs too
      if (originalBet.marketType === 'Parlay') {
        const parlayLegs = await Bet.find({ parlayId: originalBet._id });
        
        const newLegs = await Promise.all(
          parlayLegs.map(async (leg) => {
            const legData: Partial<IBet> = {
              userId: followerUser._id,
              whopUserId: followerUser.whopUserId,
              startTime: leg.startTime,
              units: leg.units,
              result: 'pending' as const,
              locked: leg.locked,
              eventName: leg.eventName,
              sport: leg.sport,
              league: leg.league,
              homeTeam: leg.homeTeam,
              awayTeam: leg.awayTeam,
              homeTeamId: leg.homeTeamId,
              awayTeamId: leg.awayTeamId,
              provider: leg.provider,
              providerEventId: leg.providerEventId,
              sportKey: leg.sportKey,
              marketType: leg.marketType,
              selection: leg.selection,
              line: leg.line,
              overUnder: leg.overUnder,
              playerName: leg.playerName,
              playerId: leg.playerId,
              playerKey: leg.playerKey,
              statType: leg.statType,
              odds: leg.odds,
              oddsFormat: leg.oddsFormat,
              oddsAmerican: leg.oddsAmerican,
              book: leg.book,
              parlayId: newBet._id, // Link to the new main parlay bet
            };
            
            const newLeg = new Bet(legData);
            await newLeg.save();
            return newLeg;
          })
        );
      }
    }

    // Create the action record
    const followedBetAction = new FollowedBetAction({
      followerUserId: followerUser._id,
      followerWhopUserId: followerUser.whopUserId,
      originalBetId: new mongoose.Types.ObjectId(betId),
      action,
      followedBetId,
    });
    
    await followedBetAction.save();

    return NextResponse.json({
      success: true,
      action,
      followedBetId: followedBetId?.toString(),
      message: action === 'follow' 
        ? 'Bet added to your account successfully' 
        : 'Bet marked as faded',
    });
  } catch (error) {
    console.error('Error handling bet action:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/follow/bet-action
 * Get action status for a bet (if user has followed/faded it)
 * 
 * Query: { betId: string }
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    const headers = await import('next/headers').then(m => m.headers());
    const userId = headers.get('x-user-id');

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const betId = searchParams.get('betId');

    if (!betId) {
      return NextResponse.json(
        { error: 'betId is required' },
        { status: 400 }
      );
    }

    // Find current user by whopUserId only (cross-company)
    const followerUser = await User.findOne({ whopUserId: userId });
    
    if (!followerUser || !followerUser.whopUserId) {
      return NextResponse.json({ action: null });
    }

    const action = await FollowedBetAction.findOne({
      followerWhopUserId: followerUser.whopUserId,
      originalBetId: new mongoose.Types.ObjectId(betId),
    });

    return NextResponse.json({
      action: action ? action.action : null,
      followedBetId: action?.followedBetId?.toString(),
    });
  } catch (error) {
    console.error('Error fetching bet action:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

