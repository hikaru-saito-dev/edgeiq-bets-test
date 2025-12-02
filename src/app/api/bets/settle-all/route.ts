import { NextResponse } from 'next/server';

import { notifyBetSettled } from '@/lib/betNotifications';
import connectDB from '@/lib/db';
import { settleBet } from '@/lib/settleBet';
import { Log } from '@/models/Log';
import { Bet, type IBet } from '@/models/Bet';
import { User } from '@/models/User';
import { updateUserStatsFromAggregation } from '@/lib/stats';

export const runtime = 'nodejs';

export async function POST() {
  try {
    await connectDB();

    const now = new Date();
    // Find pending non-parlay bets where the event start time has passed
    // Note: settleBet() will only settle bets where the game has actually ended (finalized with scores)
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
        // settleBet() checks if game has ended (finalized, not cancelled, scores available)
        // Returns 'pending' if game hasn't ended yet
        const result = await settleBet(bet as unknown as IBet);

        if (result !== 'pending') {
          bet.result = result;
          await bet.save();

          await Log.create({
            userId: bet.userId,
            betId: bet._id,
            action: 'bet_auto_settled',
            metadata: { result, triggeredBy: 'settle_all' },
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

    // Second pass: settle parent parlays whose legs may now all be graded
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
            metadata: { result: parlayResult, triggeredBy: 'settle_all_parlay' },
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

