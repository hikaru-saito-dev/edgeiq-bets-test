import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import { Bet, IBet } from '@/models/Bet';
import { User } from '@/models/User';
import { Log } from '@/models/Log';
import { PipelineStage } from 'mongoose';
import { 
  createBetSchema, 
  createBetSchemaLegacy,
  type GameSelectionInput,
  type MarketSelectionInput,
} from '@/utils/validateBet';
import { z } from 'zod';
import { 
  notifyBetCreated, 
  notifyBetDeleted,
} from '@/lib/betNotifications';
import {
  validateMoneylineBet,
  validateSpreadBet,
  validateTotalBet,
  validatePlayerPropBet,
  validatePlayerPropLineOnly,
  checkGameStarted,
  validateSpreadLineOnly,
  validateTotalLineOnly,
} from '@/lib/betValidation';
import { americanToDecimal, decimalToAmerican } from '@/utils/oddsConverter';
import type { OddsInput } from '@/utils/validateBet';

export const runtime = 'nodejs';

interface ParlayLine {
  marketType: 'ML' | 'Spread' | 'Total';
  selection?: string;
  line?: number;
  overUnder?: 'Over' | 'Under';
}

/**
 * Parse parlay summary into individual bet lines
 * Supports formats like:
 * - "Lakers -3.5" or "Lakers +3.5" (Spread)
 * - "Lakers ML" (Moneyline)
 * - "Lakers O 115.5" or "Lakers Over 115.5" (Total Over)
 * - "Lakers U 115.5" or "Lakers Under 115.5" (Total Under)
 * - "Over 115.5" or "Under 115.5" (Total without team name)
 */
function parseParlaySummary(summary: string): ParlayLine[] {
  const lines: ParlayLine[] = [];
  // Split by newlines, also handle "+" separator (e.g., "Lakers ML + Celtics -5.5")
  const summaryLines = summary
    .split(/[\n+]/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
  
  for (const line of summaryLines) {
    // Match patterns like "Over 115.5" or "Under 115.5" (Total without team name)
    const totalOnlyOverMatch = line.match(/^(?:O|Over)\s+(\d+\.?\d*)$/i);
    if (totalOnlyOverMatch) {
      const lineNum = parseFloat(totalOnlyOverMatch[1]);
      if (!isNaN(lineNum)) {
        lines.push({
          marketType: 'Total',
          line: lineNum,
          overUnder: 'Over',
        });
        continue;
      }
    }
    
    const totalOnlyUnderMatch = line.match(/^(?:U|Under)\s+(\d+\.?\d*)$/i);
    if (totalOnlyUnderMatch) {
      const lineNum = parseFloat(totalOnlyUnderMatch[1]);
      if (!isNaN(lineNum)) {
        lines.push({
          marketType: 'Total',
          line: lineNum,
          overUnder: 'Under',
        });
        continue;
      }
    }
    
    // Match patterns like "Team -3.5", "Team +3.5" (Spread)
    const spreadMatch = line.match(/^(.+?)\s+([+-]?\d+\.?\d*)$/);
    if (spreadMatch) {
      const [, team, lineStr] = spreadMatch;
      const lineNum = parseFloat(lineStr);
      if (!isNaN(lineNum)) {
        lines.push({
          marketType: 'Spread',
          selection: team.trim(),
          line: lineNum,
        });
        continue;
      }
    }
    
    // Match patterns like "Team ML" (Moneyline)
    if (line.match(/\bML\b$/i)) {
      const team = line.replace(/\s+ML\s*$/i, '').trim();
      if (team) {
        lines.push({
          marketType: 'ML',
          selection: team,
        });
        continue;
      }
    }
    
    // Match patterns like "Team O 115.5" or "Team Over 115.5" (Total Over)
    const overMatch = line.match(/^(.+?)\s+(?:O|Over)\s+(\d+\.?\d*)$/i);
    if (overMatch) {
      const [, team, lineStr] = overMatch;
      const lineNum = parseFloat(lineStr);
      if (!isNaN(lineNum)) {
        lines.push({
          marketType: 'Total',
          selection: team.trim(),
          line: lineNum,
          overUnder: 'Over',
        });
        continue;
      }
    }
    
    // Match patterns like "Team U 115.5" or "Team Under 115.5" (Total Under)
    const underMatch = line.match(/^(.+?)\s+(?:U|Under)\s+(\d+\.?\d*)$/i);
    if (underMatch) {
      const [, team, lineStr] = underMatch;
      const lineNum = parseFloat(lineStr);
      if (!isNaN(lineNum)) {
        lines.push({
          marketType: 'Total',
          selection: team.trim(),
          line: lineNum,
          overUnder: 'Under',
        });
        continue;
      }
    }
  }
  
  return lines;
}

/**
 * GET /api/bets
 * Get bets for the authenticated user with pagination and text search
 * Optimized to use MongoDB aggregation with $lookup for parlay legs
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const headers = await import('next/headers').then(m => m.headers());
    
    // Read userId and companyId from headers (set by client from context)
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find user by whopUserId (companyId is manually entered, not from Whop auth)
    const user = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // All roles (companyOwner, owner, admin, member) can only view their OWN bets
    // The "My Bets" page shows personal bets only, not all company bets

    // Parse query params
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10)));
    const search = (searchParams.get('search') || '').trim();
    const marketType = searchParams.get('marketType')?.trim();

    // Build match query - ALL users see only their own bets
    const matchQuery: Record<string, unknown> = {
      userId: user._id,
      parlayId: { $exists: false }, // Exclude parlay legs from top-level listing
    };

    // Filter by marketType if provided
    if (marketType && ['ML', 'Spread', 'Total', 'Player Prop', 'Parlay'].includes(marketType)) {
      matchQuery.marketType = marketType;
    }

    // Build search conditions
    const searchConditions: Record<string, unknown>[] = [];
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      searchConditions.push(
          { eventName: regex },
          { sport: regex },
          { league: regex },
          { homeTeam: regex },
          { awayTeam: regex },
          { selection: regex },
          { marketType: regex },
          { book: regex },
        { notes: regex }
      );
    }

    if (searchConditions.length > 0) {
      matchQuery.$or = searchConditions;
    }

    // Use aggregation pipeline to fetch bets with parlay legs in a single query
    const pipeline: PipelineStage[] = [
      { $match: matchQuery },
      {
        $lookup: {
          from: Bet.collection.name,
          let: { parlayBetId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$parlayId', '$$parlayBetId'] },
                    { $eq: ['$userId', user._id] },
                  ],
                },
              },
            },
            { $sort: { startTime: 1 } },
            {
              $project: {
                _id: 1,
                userId: 1,
                eventName: 1,
                sport: 1,
                league: 1,
                homeTeam: 1,
                awayTeam: 1,
                startTime: 1,
                marketType: 1,
                selection: 1,
                line: 1,
                overUnder: 1,
                playerName: 1,
                statType: 1,
                odds: 1,
                units: 1,
                result: 1,
                locked: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          as: 'parlayLegs',
        },
      },
      {
        $addFields: {
          parlayLegs: {
            $cond: [
              { $eq: ['$marketType', 'Parlay'] },
              '$parlayLegs',
              [],
            ],
          },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
          ],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];

    const aggregated = await Bet.aggregate(pipeline).allowDiskUse(true);
    const facetResult = aggregated[0] || { data: [], totalCount: [] };
    const total = facetResult.totalCount[0]?.count || 0;
    const bets = facetResult.data || [];

    return NextResponse.json({
      bets,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Error fetching bets:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/bets
 * Create a new bet
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const headers = await import('next/headers').then(m => m.headers());
    
    // Read userId and companyId from headers (set by client from context)
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find user by whopUserId (companyId is manually entered, not from Whop auth)
    const user = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found. Please set up your profile first.' }, { status: 404 });
    }

    // Allow all roles (companyOwner, owner, admin, member) to create bets

    // Use companyId from headers (from context) or fall back to user's companyId
    const finalCompanyId = companyId || user.companyId;
    
    if (!finalCompanyId) {
      return NextResponse.json({ 
        error: 'Company ID is required. Please ensure you are accessing the app through a Whop company.' 
      }, { status: 400 });
    }

    const body = await request.json();
    
    // Try new schema first, fall back to legacy if it fails
    let validatedNew: z.infer<typeof createBetSchema> | null = null;
    let validatedLegacy: z.infer<typeof createBetSchemaLegacy> | null = null;
    let isLegacy = false;
    
    try {
      validatedNew = createBetSchema.parse(body);
    } catch (newError) {
      // Fall back to legacy schema for backward compatibility
      try {
        validatedLegacy = createBetSchemaLegacy.parse(body);
        isLegacy = true;
      } catch (legacyError) {
        // Return detailed validation error
        const zodError = newError instanceof z.ZodError ? newError : legacyError instanceof z.ZodError ? legacyError : null;
        if (zodError) {
          const errorMessages = zodError.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          }));
          return NextResponse.json(
            { 
              error: 'Validation error',
              details: errorMessages,
              // Include first error message for easier debugging
              message: errorMessages[0]?.message || 'Invalid request data'
            },
            { status: 400 }
          );
        }
        return NextResponse.json(
          { error: 'Validation error', message: 'Invalid request data' },
          { status: 400 }
        );
      }
    }

    // Validate units limit (additional server-side check)
    const unitsToValidate = validatedNew?.units ?? validatedLegacy?.units;
    if (unitsToValidate && unitsToValidate > 2) {
      return NextResponse.json(
        { error: 'Maximum bet is 2 units' },
        { status: 400 }
      );
    }

    // User already found and validated above - use it for bet creation
    // Determine startTime and create bet data
    let startTime: Date;
    let betData: Record<string, unknown>;
    
    if (isLegacy && validatedLegacy) {
      // Legacy format
      startTime = validatedLegacy.startTime;
      const locked = new Date() >= startTime;
      
      // For legacy bets, at least check if game has started
      if (locked) {
        return NextResponse.json(
          { error: 'Cannot create bet after game has started' },
          { status: 400 }
        );
      }
      
      betData = {
        userId: user._id,
        whopUserId: user.whopUserId,
        startTime,
        units: validatedLegacy.units,
        result: 'pending' as const,
        locked,
        eventName: validatedLegacy.eventName,
        odds: validatedLegacy.odds,
        oddsFormat: 'decimal' as const,
        marketType: 'ML' as const,
      };
    } else if (validatedNew) {
      // New format
      startTime = validatedNew.game.startTime;
      const locked = new Date() >= startTime;
      
      // Validate bet against API before creating
      if (validatedNew.game.providerEventId && validatedNew.game.sportKey) {
        let validationResult: { valid: boolean; error?: string } | null = null;

        if (validatedNew.market.marketType === 'ML') {
          validationResult = await validateMoneylineBet(
            validatedNew.game.sportKey,
            validatedNew.game.providerEventId,
            validatedNew.market.selection,
            validatedNew.oddsDecimal,
            startTime
          );
        } else if (validatedNew.market.marketType === 'Spread') {
          validationResult = await validateSpreadBet(
            validatedNew.game.sportKey,
            validatedNew.game.providerEventId,
            validatedNew.market.selection,
            validatedNew.market.line,
            validatedNew.oddsDecimal,
            startTime
          );
        } else if (validatedNew.market.marketType === 'Total') {
          validationResult = await validateTotalBet(
            validatedNew.game.sportKey,
            validatedNew.game.providerEventId,
            validatedNew.market.overUnder,
            validatedNew.market.line,
            validatedNew.oddsDecimal,
            startTime
          );
        } else if (validatedNew.market.marketType === 'Player Prop') {
          const playerKey =
            (validatedNew.market as { playerKey?: string }).playerKey ??
            (validatedNew.market as { playerId?: string }).playerId;
          if (playerKey && validatedNew.game.providerEventId) {
            validationResult = await validatePlayerPropBet(
              playerKey,
              validatedNew.market.statType,
              validatedNew.market.line,
              validatedNew.market.overUnder,
              validatedNew.oddsDecimal, // Pass odds for validation
              startTime,
              validatedNew.game.providerEventId,
            );
          } else {
            validationResult = {
              valid: false,
              error: 'Player information is required for player prop validation',
            };
          }
        }
        // Note: Parlay validation would validate each leg individually

        if (validationResult && !validationResult.valid) {
          return NextResponse.json(
            { error: validationResult.error || 'Bet validation failed' },
            { status: 400 }
          );
        }
      }
      
      // Always use array format - can contain 0, 1, or multiple webhook IDs
      const normalizedSelectedWebhookIds =
        validatedNew.selectedWebhookIds && validatedNew.selectedWebhookIds.length > 0
          ? validatedNew.selectedWebhookIds
          : undefined;
      
      betData = {
        userId: user._id,
        whopUserId: user.whopUserId,
        startTime,
        units: validatedNew.units,
        result: 'pending' as const,
        locked,
        eventName: validatedNew.eventName,
        sport: validatedNew.game.sport,
        sportKey: validatedNew.game.sportKey, // Store sportKey for auto-settlement
        league: validatedNew.game.league,
        homeTeam: validatedNew.game.homeTeam,
        awayTeam: validatedNew.game.awayTeam,
        homeTeamId: validatedNew.game.homeTeamId,
        awayTeamId: validatedNew.game.awayTeamId,
        provider: validatedNew.game.provider,
        providerEventId: validatedNew.game.providerEventId,
        marketType: validatedNew.market.marketType,
        ...(validatedNew.market.marketType === 'ML' && { selection: validatedNew.market.selection }),
        ...(validatedNew.market.marketType === 'Spread' && { 
          selection: validatedNew.market.selection,
          line: validatedNew.market.line,
        }),
        ...(validatedNew.market.marketType === 'Total' && { 
          line: validatedNew.market.line,
          overUnder: validatedNew.market.overUnder,
        }),
        ...(validatedNew.market.marketType === 'Player Prop' && { 
          playerName: validatedNew.market.playerName,
          playerId: (validatedNew.market as { playerId?: string }).playerId,
          playerKey: (validatedNew.market as { playerKey?: string }).playerKey,
          statType: validatedNew.market.statType,
          line: validatedNew.market.line,
          overUnder: validatedNew.market.overUnder,
        }),
        ...(validatedNew.market.marketType === 'Parlay' && { 
          parlaySummary: validatedNew.market.parlaySummary,
        }),
                 odds: validatedNew.oddsDecimal,
                 oddsFormat: validatedNew.odds.oddsFormat,
                 oddsAmerican: validatedNew.oddsAmerican,
                 book: validatedNew.book,
                 notes: validatedNew.notes,
                 slipImageUrl: validatedNew.slipImageUrl,
        ...(normalizedSelectedWebhookIds && { selectedWebhookIds: normalizedSelectedWebhookIds }),
               };
    } else {
      return NextResponse.json(
        { error: 'Invalid request data' },
        { status: 400 }
      );
    }

    // If this is a parlay, validate ALL legs BEFORE creating the bet
    // This ensures we don't create a bet if any leg fails validation
    if (validatedNew && validatedNew.market.marketType === 'Parlay') {
      type NonParlayMarket = Extract<MarketSelectionInput, { marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop' }>;
      type ParlayLegInput = {
        game: GameSelectionInput;
        market: NonParlayMarket;
        label?: string;
        odds?: OddsInput; // Leg odds for parlay calculation
      };
      const structuredLegs = validatedNew.parlay?.legs as ParlayLegInput[] | undefined;
      
      if (structuredLegs && Array.isArray(structuredLegs) && structuredLegs.length > 0) {
        // Validate that final parlay odds match calculated value from legs
        const legsWithOdds = structuredLegs.filter(leg => leg.odds);
        if (legsWithOdds.length === structuredLegs.length) {
          // All legs have odds - calculate expected parlay odds
          const legDecimalOdds = legsWithOdds.map(leg => {
            if (!leg.odds) return null;
            return leg.odds.oddsFormat === 'decimal'
              ? leg.odds.oddsValue
              : americanToDecimal(leg.odds.oddsValue);
          });
          
          if (legDecimalOdds.every(odds => odds !== null)) {
            const calculatedParlayDecimal = (legDecimalOdds as number[]).reduce((acc, odds) => acc * odds, 1);
            const submittedDecimal = validatedNew.oddsDecimal;
            
            // Check if submitted odds match calculated odds (within 5% tolerance)
            const tolerance = Math.abs(submittedDecimal - calculatedParlayDecimal) / calculatedParlayDecimal;
            if (tolerance > 0.05) {
              const calculatedAmerican = validatedNew.odds.oddsFormat === 'decimal'
                ? decimalToAmerican(calculatedParlayDecimal)
                : calculatedParlayDecimal;
              const submittedFormatted = validatedNew.odds.oddsFormat === 'american'
                ? validatedNew.oddsAmerican || decimalToAmerican(submittedDecimal)
                : submittedDecimal;
              
              return NextResponse.json(
                { 
                  error: `Parlay odds mismatch. Calculated from legs: ${validatedNew.odds.oddsFormat === 'american' ? (calculatedAmerican > 0 ? '+' : '') + Math.round(calculatedAmerican) : calculatedParlayDecimal.toFixed(2)}, Submitted: ${validatedNew.odds.oddsFormat === 'american' ? (submittedFormatted > 0 ? '+' : '') + Math.round(submittedFormatted) : submittedDecimal.toFixed(2)}. Please use the calculated parlay odds.` 
                },
                { status: 400 }
              );
            }
          }
        }
        
        // Validate ALL legs BEFORE creating the bet
        for (const leg of structuredLegs) {
          const legGame = leg.game;
          const m = leg.market;
          const legStart = legGame.startTime ? new Date(legGame.startTime) : validatedNew.game.startTime;
          const eventName =
            legGame.awayTeam && legGame.homeTeam
              ? `${legGame.awayTeam} @ ${legGame.homeTeam}`
              : legGame.homeTeam ?? legGame.awayTeam ?? validatedNew.eventName;

          // Validate parlay leg before creating
          if (legGame.providerEventId && legGame.sportKey) {
            let legValidationResult: { valid: boolean; error?: string } | null = null;

            // First validate the line/selection
            if (m.marketType === 'ML') {
              // Validate game hasn't started
              const gameCheck = await checkGameStarted(legGame.sportKey, legGame.providerEventId, legStart);
              if (gameCheck.started) {
                legValidationResult = {
                  valid: false,
                  error: `Cannot create parlay: Game "${eventName}" has already started`,
                };
              } else {
                // Game hasn't started - set to valid so odds validation can proceed
                legValidationResult = { valid: true };
              }
            } else if (m.marketType === 'Spread') {
              legValidationResult = await validateSpreadLineOnly(
                legGame.sportKey,
                legGame.providerEventId,
                m.selection,
                m.line,
                legStart
              );
            } else if (m.marketType === 'Total') {
              legValidationResult = await validateTotalLineOnly(
                legGame.sportKey,
                legGame.providerEventId,
                m.overUnder,
                m.line,
                legStart
              );
            } else if (m.marketType === 'Player Prop') {
              const playerKey = m.playerKey ?? m.playerId;
              if (playerKey && legGame.providerEventId) {
                legValidationResult = await validatePlayerPropLineOnly(
                  playerKey,
                  m.statType,
                  m.line,
                  m.overUnder,
                  legStart,
                  legGame.providerEventId,
                );
              } else {
                legValidationResult = {
                  valid: false,
                  error: `Player information is required for player prop in parlay leg "${eventName}"`,
                };
              }
            }

            // If line validation passed and leg has odds, validate the odds too
            // This prevents manipulation of parlay odds calculation
            if (legValidationResult?.valid && leg.odds) {
              const legOddsDecimal = leg.odds.oddsFormat === 'decimal' 
                ? leg.odds.oddsValue 
                : americanToDecimal(leg.odds.oddsValue);

              if (m.marketType === 'ML') {
                const oddsValidation = await validateMoneylineBet(
                  legGame.sportKey || '',
                  legGame.providerEventId,
                  m.selection || '',
                  legOddsDecimal,
                  legStart
                );
                if (!oddsValidation.valid) {
                  legValidationResult = oddsValidation;
                }
              } else if (m.marketType === 'Spread') {
                const oddsValidation = await validateSpreadBet(
                  legGame.sportKey || '',
                  legGame.providerEventId,
                  m.selection || '',
                  m.line || 0,
                  legOddsDecimal,
                  legStart
                );
                if (!oddsValidation.valid) {
                  legValidationResult = oddsValidation;
                }
              } else if (m.marketType === 'Total') {
                const oddsValidation = await validateTotalBet(
                  legGame.sportKey || '',
                  legGame.providerEventId,
                  m.overUnder || 'Over',
                  m.line || 0,
                  legOddsDecimal,
                  legStart
                );
                if (!oddsValidation.valid) {
                  legValidationResult = oddsValidation;
                }
              } else if (m.marketType === 'Player Prop') {
                const playerKey = m.playerKey ?? m.playerId;
                if (playerKey) {
                  const oddsValidation = await validatePlayerPropBet(
                    playerKey,
                    m.statType || '',
                    m.line || 0,
                    m.overUnder || 'Over',
                    legOddsDecimal,
                    legStart,
                    legGame.providerEventId,
                  );
                  if (!oddsValidation.valid) {
                    legValidationResult = oddsValidation;
                  }
                }
              }
            }

            if (legValidationResult && !legValidationResult.valid) {
              // Validation failed - return error BEFORE creating any bets
              return NextResponse.json(
                { error: `Parlay leg validation failed for "${eventName}" (${m.marketType}): ${legValidationResult.error || 'Validation failed'}` },
                { status: 400 }
              );
            }
          }
        }
      } else if (validatedNew.market.parlaySummary) {
        // For parlay summary (legacy format), validate game hasn't started
        // Note: We can't validate lines/odds from summary text, but we can check game time
        const gameCheck = await checkGameStarted(
          validatedNew.game.sportKey || '',
          validatedNew.game.providerEventId || '',
          validatedNew.game.startTime
        );
        if (gameCheck.started) {
          return NextResponse.json(
            { error: 'Cannot create parlay: Game has already started' },
            { status: 400 }
          );
        }
      }
    }

    // All validations passed - now create the bet
    const bet = await Bet.create(betData);

    // Track consumed plays for follow purchases (only for main bets, not parlay legs)
    try {
      const { FollowPurchase } = await import('@/models/FollowPurchase');
      
      // Find all active follow purchases for this capper (by whopUserId - person level)
      // This tracks plays across all companies where this person is followed
      if (user.whopUserId) {
        const activeFollows = await FollowPurchase.find({
          capperWhopUserId: user.whopUserId,
          status: 'active',
        });

        // For each active follow, increment consumed plays if there are remaining plays
        for (const follow of activeFollows) {
          if (follow.numPlaysConsumed < follow.numPlaysPurchased) {
            follow.numPlaysConsumed += 1;
            
            // If all plays consumed, mark as completed
            if (follow.numPlaysConsumed >= follow.numPlaysPurchased) {
              follow.status = 'completed';
            }
            
            await follow.save();
          }
        }
      }
    } catch (followError) {
      // Don't fail bet creation if follow tracking fails
      console.error('Error tracking follow purchases:', followError);
    }

    // If this is a parlay, create individual bet entries for each line
    const parlayLines: IBet[] = [];
    if (validatedNew && validatedNew.market.marketType === 'Parlay') {
      type NonParlayMarket = Extract<MarketSelectionInput, { marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop' }>;
      type ParlayLegInput = {
        game: GameSelectionInput;
        market: NonParlayMarket;
        label?: string;
        odds?: OddsInput; // Leg odds for parlay calculation
      };
      const structuredLegs = validatedNew.parlay?.legs as ParlayLegInput[] | undefined;
      
      if (structuredLegs && Array.isArray(structuredLegs) && structuredLegs.length > 0) {
        // All legs already validated above - now create them
        for (const leg of structuredLegs) {
          const legGame = leg.game;
          const m = leg.market;
          const legStart = legGame.startTime ? new Date(legGame.startTime) : validatedNew.game.startTime;
          const lockedLeg = new Date() >= legStart;
          const eventName =
            legGame.awayTeam && legGame.homeTeam
              ? `${legGame.awayTeam} @ ${legGame.homeTeam}`
              : legGame.homeTeam ?? legGame.awayTeam ?? validatedNew.eventName;

          const lineBetData: Record<string, unknown> = {
            userId: user._id,
            whopUserId: user.whopUserId,
            startTime: legStart,
            units: 0.01,
            odds: 1.01,
            oddsFormat: 'decimal' as const,
            result: 'pending' as const,
            locked: lockedLeg,
            eventName,
            sport: legGame.sport,
            sportKey: legGame.sportKey,
            league: legGame.league,
            homeTeam: legGame.homeTeam,
            awayTeam: legGame.awayTeam,
            homeTeamId: legGame.homeTeamId,
            awayTeamId: legGame.awayTeamId,
            provider: legGame.provider,
            providerEventId: legGame.providerEventId,
            marketType: m.marketType,
            parlayId: bet._id,
          };

          switch (m.marketType) {
            case 'ML':
              lineBetData.selection = m.selection;
              break;
            case 'Spread':
              lineBetData.selection = m.selection;
              lineBetData.line = m.line;
              break;
            case 'Total':
              lineBetData.line = m.line;
              lineBetData.overUnder = m.overUnder;
              break;
            case 'Player Prop':
              lineBetData.playerName = m.playerName;
              if (m.playerId !== undefined) {
                lineBetData.playerId = m.playerId;
              }
              if (m.playerKey !== undefined) {
                lineBetData.playerKey = m.playerKey;
              }
              lineBetData.statType = m.statType;
              lineBetData.line = m.line;
              lineBetData.overUnder = m.overUnder;
              break;
            default:
              break;
          }

          const lineBet = await Bet.create(lineBetData);
          parlayLines.push(lineBet);
        }
      } else if (validatedNew.market.parlaySummary) {
        // Legacy parlaySummary format - already validated before bet creation (lines 669-683)
        // Now just create the legs
        const parsedLines = parseParlaySummary(validatedNew.market.parlaySummary);
        for (const line of parsedLines) {
          const lineBetData: Record<string, unknown> = {
            userId: user._id,
            whopUserId: user.whopUserId,
            startTime: validatedNew.game.startTime,
            units: 0.01,
            odds: 1.01,
            oddsFormat: 'decimal' as const,
            result: 'pending' as const,
            locked: new Date() >= validatedNew.game.startTime,
            eventName: validatedNew.eventName,
            sport: validatedNew.game.sport,
            sportKey: validatedNew.game.sportKey,
            league: validatedNew.game.league,
            homeTeam: validatedNew.game.homeTeam,
            awayTeam: validatedNew.game.awayTeam,
            homeTeamId: validatedNew.game.homeTeamId,
            awayTeamId: validatedNew.game.awayTeamId,
            provider: validatedNew.game.provider,
            providerEventId: validatedNew.game.providerEventId,
            marketType: line.marketType,
            parlayId: bet._id,
            ...(line.selection && { selection: line.selection }),
            ...(line.line !== undefined && { line: line.line }),
            ...(line.overUnder && { overUnder: line.overUnder }),
          };
          const lineBet = await Bet.create(lineBetData);
          parlayLines.push(lineBet);
        }
      }
    }

    // Log the action
    await Log.create({
      userId: user._id,
      betId: bet._id,
      action: 'bet_created',
      metadata: isLegacy && validatedLegacy
        ? { eventName: validatedLegacy.eventName, odds: validatedLegacy.odds, units: validatedLegacy.units }
        : validatedNew
        ? { marketType: validatedNew.market.marketType, odds: validatedNew.oddsDecimal, units: validatedNew.units }
        : {},
    });

    await notifyBetCreated(bet, user, finalCompanyId);

    return NextResponse.json({ 
      bet, 
      ...(parlayLines.length > 0 && { parlayLines }) 
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Validation error', details: error },
        { status: 400 }
      );
    }
    console.error('Error creating bet:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/bets?action=settle
 * Manual settlement is disabled - bets are auto-settled based on game results
 */
export async function PUT() {
  return NextResponse.json(
    { error: 'Manual settlement is disabled. Bets are automatically settled based on game results.' },
    { status: 403 }
  );
}

/**
 * DELETE /api/bets
 * Delete a bet for the authenticated user (only before event starts)
 */
export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const headers = await import('next/headers').then(m => m.headers());
    
    // Read userId and companyId from headers (set by client from context)
    const userId = headers.get('x-user-id');
    const companyId = headers.get('x-company-id');
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find user by whopUserId (companyId is manually entered, not from Whop auth)
    const user = await User.findOne({ whopUserId: userId, companyId: companyId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    if (user.role !== 'companyOwner' && user.role !== 'owner' && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden. Only owners and admins can delete bets.' }, { status: 403 });
    }

    const body = await request.json();
    const { betId } = body;

    if (!betId) {
      return NextResponse.json({ error: 'betId is required' }, { status: 400 });
    }

    const bet = await Bet.findOne({ _id: betId, userId: user._id });
    if (!bet) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }

    if (bet.locked || new Date() >= new Date(bet.startTime)) {
      return NextResponse.json(
        { error: 'Cannot delete bet after event start time.' },
        { status: 403 }
      );
    }

    // Save bet data before deletion for notification
    const betData = bet.toObject();
    
    // If parlay, delete all legs linked to it
    if (bet.marketType === 'Parlay') {
      await Bet.deleteMany({ parlayId: bet._id, userId: user._id,});
    }

    await bet.deleteOne();
    await Log.create({
      userId: user._id,
      betId: bet._id,
      action: 'bet_deleted',
      metadata: {},
    });

    // Send notification with saved bet data
    await notifyBetDeleted(betData as unknown as IBet, user);

    // Recalculate stats using aggregation (optimized)
    const { updateUserStatsFromAggregation } = await import('@/lib/stats');
    await updateUserStatsFromAggregation(user.whopUserId, companyId || '');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting bet:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

