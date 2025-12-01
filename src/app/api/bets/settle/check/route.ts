import { NextRequest, NextResponse } from 'next/server';

import { notifyBetSettled } from '@/lib/betNotifications';
import connectDB from '@/lib/db';
import { settleBet, getEvent, isGameEnded, computePlayerStatValue, findPlayerKeyByName } from '@/lib/settleBet';
import { mapStatTypeToStatId } from '@/lib/betValidation';
import { updateUserStats } from '@/lib/stats';
import { Log } from '@/models/Log';
import { Bet, type IBet } from '@/models/Bet';
import { User } from '@/models/User';

export const runtime = 'nodejs';

/**
 * GET /api/bets/settle/check?betId=...
 * Check if a bet can be automatically settled or if it should be voided due to missing provider data
 * If game has ended but provider data is missing, automatically void the bet
 * Returns:
 * - canAutoSettle: boolean - whether automatic settlement is possible
 * - gameEnded: boolean - whether the game has ended
 * - result: string - the settlement result (if settled)
 * - reason: string - explanation of the status
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const betId = searchParams.get('betId');

    if (!betId) {
      return NextResponse.json({ error: 'betId is required' }, { status: 400 });
    }

    const bet = await Bet.findById(betId);
    if (!bet) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }

    if (bet.result !== 'pending') {
      return NextResponse.json({
        canAutoSettle: false,
        gameEnded: true,
        reason: 'Bet is already settled',
        result: bet.result,
      });
    }

    const currentTime = new Date();
    const startTime = new Date(bet.startTime);

    // Check 1: Game must have started
    if (currentTime < startTime) {
      return NextResponse.json({
        canAutoSettle: false,
        gameEnded: false,
        reason: 'Game has not started yet',
      });
    }

    // Check 2: Try automatic settlement first
    const autoSettlementResult = await settleBet(bet as unknown as IBet);

    // If automatic settlement succeeded, return the result
    if (autoSettlementResult !== 'pending') {
      // Update bet if not already updated
      if (bet.result === 'pending') {
        bet.result = autoSettlementResult;
        await bet.save();

        await Log.create({
          userId: bet.userId,
          betId: bet._id,
          action: 'bet_auto_settled',
          metadata: { result: autoSettlementResult, triggeredBy: 'check_endpoint' },
        });

        // Handle parlay legs
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

                if (parlayUser) {
                  const allParlayBets = await Bet.find({ userId: parlayBet.userId }).lean();
                  await updateUserStats(parlayBet.userId.toString(), allParlayBets as unknown as IBet[]);
                }
              }
            }
          } catch {
            // Error settling parent parlay - continue silently
          }
        }

        // Update user stats and send notification
        const user = await User.findById(bet.userId);
        if (user) {
          const allBets = await Bet.find({ userId: bet.userId }).lean();
          await updateUserStats(bet.userId.toString(), allBets as unknown as IBet[]);
        }

        if (!bet.parlayId) {
          const userForNotification = user ?? (await User.findById(bet.userId));
          await notifyBetSettled(bet as unknown as IBet, autoSettlementResult, userForNotification ?? undefined);
        }
      }

      return NextResponse.json({
        canAutoSettle: true,
        gameEnded: true,
        reason: 'Automatic settlement successful',
        result: autoSettlementResult,
      });
    }

    // Automatic settlement returned 'pending' - check if game has ended and data is missing
    const event = await getEvent(bet.providerEventId || '', {
      homeTeam: bet.homeTeam,
      awayTeam: bet.awayTeam,
      league: bet.league,
      startTime: startTime,
    });

    // If event not found, cannot determine if game has ended - keep pending
    if (!event) {
      return NextResponse.json({
        canAutoSettle: false,
        gameEnded: false,
        reason: 'Event not found in API. Cannot determine if game has ended.',
      });
    }

    // Check if game has ended
    const betStartTime = new Date(bet.startTime);
    const gameHasEnded = isGameEnded(event, betStartTime);

    // If game hasn't ended, keep pending
    if (!gameHasEnded) {
      return NextResponse.json({
        canAutoSettle: false,
        gameEnded: false,
        reason: 'Game has not ended yet. It may still be in progress or waiting for final scores.',
      });
    }

    // Game has ended but automatic settlement failed - check if it's due to missing provider data
    let shouldVoid = false;
    let voidReason = 'Game has ended but provider data is missing. ';

    if (bet.marketType === 'Player Prop') {
      // Check if player stats are missing
      const legacyPlayerId = (bet as unknown as { playerId?: string | number }).playerId;
      const playerKey =
        bet.playerKey ||
        (typeof legacyPlayerId === 'number' || typeof legacyPlayerId === 'string'
          ? String(legacyPlayerId)
          : null) ||
        findPlayerKeyByName(event, bet.playerName);

      if (!playerKey) {
        shouldVoid = true;
        voidReason += `Player key not found for ${bet.playerName || 'this player'}. `;
      } else {
        const statsEntry = event.results?.game?.[playerKey];
        if (!statsEntry || typeof statsEntry !== 'object') {
          shouldVoid = true;
          voidReason += `Player stats not available in API for ${bet.playerName || 'this player'}. `;
        } else {
          // Check if the specific stat is missing
          const statId = mapStatTypeToStatId(bet.statType || '');
          if (!statId) {
            shouldVoid = true;
            voidReason += `Stat type "${bet.statType}" is invalid. `;
          } else {
            // Try to compute the stat value
            const statValue = computePlayerStatValue(statId, statsEntry as Record<string, number | undefined>);
            if (statValue === null) {
              shouldVoid = true;
              voidReason += `Stat type "${bet.statType}" not found in player stats. `;
            }
          }
        }
      }
    } else if (bet.marketType === 'ML' || bet.marketType === 'Spread' || bet.marketType === 'Total') {
      // For these bet types, if game ended but settlement failed, it's likely missing scores
      // But we already checked isGameEnded which requires scores, so this shouldn't happen
      // However, if it does, void the bet
      const homeScore = event.teams?.home?.score ?? event.results?.game?.home?.points ?? null;
      const awayScore = event.teams?.away?.score ?? event.results?.game?.away?.points ?? null;
      if (homeScore === null || awayScore === null) {
        shouldVoid = true;
        voidReason += 'Final scores not available in API despite game being finalized. ';
      }
    }

    // If provider data is missing and game has ended, void the bet
    if (shouldVoid) {
      bet.result = 'void';
      await bet.save();

      await Log.create({
        userId: bet.userId,
        betId: bet._id,
        action: 'bet_auto_voided',
        metadata: { 
          result: 'void', 
          reason: voidReason,
          triggeredBy: 'check_endpoint_missing_data',
        },
      });

      // Handle parlay legs
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
                metadata: { result: parlayResult, triggeredBy: 'leg_void' },
              });

              const parlayUser = await User.findById(parlayBet.userId);
              await notifyBetSettled(parlayBet as unknown as IBet, parlayResult, parlayUser ?? undefined);

              if (parlayUser) {
                const allParlayBets = await Bet.find({ userId: parlayBet.userId }).lean();
                await updateUserStats(parlayBet.userId.toString(), allParlayBets as unknown as IBet[]);
              }
            }
          }
        } catch {
          // Error settling parent parlay - continue silently
        }
      }

      // Update user stats and send notification
      const user = await User.findById(bet.userId);
      if (user) {
        const allBets = await Bet.find({ userId: bet.userId }).lean();
        await updateUserStats(bet.userId.toString(), allBets as unknown as IBet[]);
      }

      if (!bet.parlayId) {
        const userForNotification = user ?? (await User.findById(bet.userId));
        await notifyBetSettled(bet as unknown as IBet, 'void', userForNotification ?? undefined);
      }

      return NextResponse.json({
        canAutoSettle: false,
        gameEnded: true,
        reason: voidReason + 'Bet automatically voided.',
        result: 'void',
        autoVoided: true,
      });
    }

    // Game has ended but we can't determine why settlement failed - keep pending
    return NextResponse.json({
      canAutoSettle: false,
      gameEnded: true,
      reason: 'Game has ended but settlement status is unclear. Bet remains pending.',
    });
  } catch {
    return NextResponse.json(
      { 
        canAutoSettle: false,
        gameEnded: false,
        reason: 'Error checking settlement status',
        error: 'Internal server error' 
      },
      { status: 500 }
    );
  }
}

