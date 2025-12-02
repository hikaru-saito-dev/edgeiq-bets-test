import { NextRequest, NextResponse } from 'next/server';

import { notifyBetSettled } from '@/lib/betNotifications';
import connectDB from '@/lib/db';
import { settleBet } from '@/lib/settleBet';
import { Log } from '@/models/Log';
import { Bet, type IBet } from '@/models/Bet';
import { User } from '@/models/User';
import { updateUserStatsFromAggregation } from '@/lib/stats';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { betId } = body;

    if (!betId) {
      return NextResponse.json({ error: 'betId is required' }, { status: 400 });
    }

    const bet = await Bet.findById(betId);
    if (!bet) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }

    if (bet.result !== 'pending') {
      return NextResponse.json({
        bet,
        message: 'Bet already settled',
      });
    }

    const now = new Date();
    const startTime = new Date(bet.startTime);

    // Check 1: Event must have started
    if (now < startTime) {
      return NextResponse.json({
        bet,
        message: 'Event has not started yet',
      });
    }

    // Attempt settlement - this will check if game has ended
    const result = await settleBet(bet as unknown as IBet);
    if (result === 'pending') {
      return NextResponse.json({
        bet,
        message: 'Game has not ended yet. Settlement only occurs after the game is finalized and scores are available.',
      });
    }

    bet.result = result;
    await bet.save();

    if (bet.parlayId) {
      try {
        const parlayBet = await Bet.findById(bet.parlayId);
        if (parlayBet && parlayBet.result === 'pending') {
          const parlayResult = await settleBet(parlayBet as unknown as IBet);
          if (parlayResult !== 'pending') {
            parlayBet.result = parlayResult;
            await parlayBet.save();

            await Log.create({
              userId: parlayBet.userId,
              betId: parlayBet._id,
              action: 'bet_auto_settled',
              metadata: { result: parlayResult, triggeredBy: 'leg_settlement' },
            });

            const parlayUser = await User.findById(parlayBet.userId);
            await notifyBetSettled(parlayBet as unknown as IBet, parlayResult, parlayUser ?? undefined);

            if (parlayUser && parlayUser.whopUserId) {
              await updateUserStatsFromAggregation(parlayUser.whopUserId, '');
            }
          }
        }
      } catch {
        // Error settling parent parlay - continue silently
      }
    }

    const user = await User.findById(bet.userId);
    if (user && user.whopUserId) {
      await updateUserStatsFromAggregation(user.whopUserId, '');
    }

    await Log.create({
      userId: bet.userId,
      betId: bet._id,
      action: 'bet_auto_settled',
      metadata: { result },
    });

    const userForNotification = user ?? (await User.findById(bet.userId));
    if (!bet.parlayId) {
      await notifyBetSettled(bet as unknown as IBet, result, userForNotification ?? undefined);
    }

    return NextResponse.json({
      bet,
      message: 'Bet auto-settled successfully',
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PUT() {
  try {
    await connectDB();

    const now = new Date();
    // First, settle non-parlay bets tied directly to games
    const pendingBets = await Bet.find({
      result: 'pending',
      startTime: { $lte: now },
      providerEventId: { $exists: true, $ne: null },
      marketType: { $ne: 'Parlay' },
    });

    const results = {
      settled: 0,
      pending: 0,
      errors: 0,
    };

    for (const bet of pendingBets) {
      try {
        const result = await settleBet(bet as unknown as IBet);

        if (result !== 'pending') {
          bet.result = result;
          await bet.save();

          await Log.create({
            userId: bet.userId,
            betId: bet._id,
            action: 'bet_auto_settled',
            metadata: { result },
          });

          if (!bet.parlayId) {
            const user = await User.findById(bet.userId);
            await notifyBetSettled(bet as unknown as IBet, result, user ?? undefined);
          }

          results.settled++;
        } else {
          results.pending++;
        }
      } catch {
        results.errors++;
      }
    }

    // Then, attempt to settle any parent parlays whose legs may now all be graded
    const pendingParlays = await Bet.find({
      result: 'pending',
      marketType: 'Parlay',
    });

    for (const parlay of pendingParlays) {
      try {
        const parlayResult = await settleBet(parlay as unknown as IBet);

        if (parlayResult !== 'pending') {
          parlay.result = parlayResult;
          await parlay.save();

          await Log.create({
            userId: parlay.userId,
            betId: parlay._id,
            action: 'bet_auto_settled',
            metadata: { result: parlayResult, triggeredBy: 'settle_parlays_batch' },
          });

          const user = await User.findById(parlay.userId);
          await notifyBetSettled(parlay as unknown as IBet, parlayResult, user ?? undefined);

          results.settled++;
        } else {
          results.pending++;
        }
      } catch {
        results.errors++;
      }
    }

    // Collect unique whopUserIds from affected bets
    const affectedWhopUserIds = new Set<string>();
    for (const bet of [...pendingBets, ...pendingParlays]) {
      try {
        const user = await User.findById(bet.userId);
        if (user && user.whopUserId) {
          affectedWhopUserIds.add(user.whopUserId);
        }
      } catch {
        // Skip if user lookup fails
      }
    }
    
    // Update stats for each unique whopUserId (aggregates across all companies)
    for (const whopUserId of affectedWhopUserIds) {
      try {
        await updateUserStatsFromAggregation(whopUserId, '');
      } catch {
        // Error updating stats - continue silently
      }
    }

    return NextResponse.json({
      message: 'Auto-settlement completed',
      results,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

