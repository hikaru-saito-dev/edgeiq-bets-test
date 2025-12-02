import type { Event } from 'sports-odds-api/resources/events';

import { mapStatTypeToStatId, resolvePropBetType } from '@/lib/betValidation';
import { getSportsGameOddsClient } from '@/lib/sportsGameOdds';
import { Bet, type BetResult, type IBet } from '@/models/Bet';

type MoneylineSide = 'home' | 'away';

const EVENT_CACHE_TTL_MS = 15_000;

const client = getSportsGameOddsClient();
const eventCache = new Map<string, { event: Event; fetchedAt: number }>();

function normalize(value?: string | null): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTeamNames(team?: Event.Teams.Home | Event.Teams.Away): string[] {
  if (!team) return [];
  const names = [
    team.names?.long,
    team.names?.medium,
    team.names?.short,
  ].filter(Boolean) as string[];

  return names.map((name) => normalize(name));
}

function resolveTeamSide(event: Event, selection?: string | null): MoneylineSide | null {
  const normalizedSelection = normalize(selection);
  if (!normalizedSelection) return null;

  const homeNames = getTeamNames(event.teams?.home);
  const awayNames = getTeamNames(event.teams?.away);

  const matches = (names: string[]) =>
    names.some((name) => name === normalizedSelection || name.includes(normalizedSelection) || normalizedSelection.includes(name));

  if (matches(homeNames)) return 'home';
  if (matches(awayNames)) return 'away';
  return null;
}

function combineTouchdowns(stats: Record<string, number | undefined>): number {
  const pieces = [
    stats.touchdowns,
    stats.rushing_touchdowns,
    stats.receiving_touchdowns,
    stats.kickoffReturn_touchdowns,
    stats.puntReturn_touchdowns,
    stats.fumbleReturn_touchdowns,
    stats.defense_touchdowns,
  ];
  return pieces.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

export function computePlayerStatValue(statId: string, stats: Record<string, number | undefined>): number | null {
  switch (statId) {
    case 'points+rebounds+assists':
      return (
        (stats.points ?? 0) +
        (stats.rebounds ?? 0) +
        (stats.assists ?? 0)
      );
    case 'points+rebounds':
      return (stats.points ?? 0) + (stats.rebounds ?? 0);
    case 'points+assists':
      return (stats.points ?? 0) + (stats.assists ?? 0);
    case 'rebounds+assists':
      return (stats.rebounds ?? 0) + (stats.assists ?? 0);
    case 'touchdowns':
      return combineTouchdowns(stats);
    case 'pitcher_strikeouts':
      return stats.pitcher_strikeouts ?? stats.pitching_strikeouts ?? null;
    case 'pitcher_outsRecorded':
      return stats.pitcher_outsRecorded ?? stats.pitching_outsRecorded ?? null;
    default:
      return typeof stats[statId] === 'number' ? (stats[statId] as number) : null;
  }
}

/**
 * Helper function to normalize team names for matching
 */
function namesForTeam(team?: Event.Teams.Home | Event.Teams.Away): string[] {
  if (!team) return [];
  const names = new Set<string>();
  const variants = [
    team.names?.long,
    team.names?.medium,
    team.names?.short,
  ];

  for (const value of variants) {
    const normalized = normalize(value);
    if (normalized) {
      names.add(normalized);
    }
  }

  return Array.from(names);
}

function teamMatches(team: Event.Teams.Home | Event.Teams.Away | undefined, target: string): boolean {
  if (!target) return true;
  const normalizedTarget = normalize(target);
  if (!normalizedTarget) return true;
  const candidates = namesForTeam(team);

  return candidates.some(
    (candidate) =>
      candidate === normalizedTarget ||
      candidate.includes(normalizedTarget) ||
      normalizedTarget.includes(candidate),
  );
}

/**
 * Fallback: Search for event by team names and date range
 */
export async function findEventByTeams(
  leagueID: string,
  homeTeam: string,
  awayTeam: string,
  startTime: Date,
): Promise<Event | null> {
  try {
    const windowBefore = new Date(startTime.getTime() - 12 * 60 * 60 * 1000).toISOString(); // 12 hours before
    const windowAfter = new Date(startTime.getTime() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours after

    const page = await client.events.get({
      leagueID,
      startsAfter: windowBefore,
      startsBefore: windowAfter,
      oddsPresent: true,
      limit: 200,
    });

    // Find matching event by team names
    for (const candidateEvent of page.data) {
      const homeMatch = teamMatches(candidateEvent.teams?.home, homeTeam);
      const awayMatch = teamMatches(candidateEvent.teams?.away, awayTeam);
      const swappedHomeMatch = teamMatches(candidateEvent.teams?.home, awayTeam);
      const swappedAwayMatch = teamMatches(candidateEvent.teams?.away, homeTeam);

      if ((homeMatch && awayMatch) || (swappedHomeMatch && swappedAwayMatch)) {
        return candidateEvent;
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to search event by teams (${awayTeam} @ ${homeTeam}):`, error);
    return null;
  }
}

/**
 * Map league name to SportsGameOdds league ID
 */
export function getLeagueID(league?: string): string {
  if (!league) return 'NBA'; // Default fallback
  const upperLeague = league.toUpperCase();
  // Common league mappings
  if (upperLeague === 'NBA') return 'NBA';
  if (upperLeague === 'NFL') return 'NFL';
  if (upperLeague === 'MLB') return 'MLB';
  if (upperLeague === 'NHL') return 'NHL';
  if (upperLeague === 'NCAAF' || upperLeague === 'COLLEGE FOOTBALL') return 'NCAAF';
  if (upperLeague === 'NCAAB' || upperLeague === 'COLLEGE BASKETBALL') return 'NCAAB';
  return upperLeague; // Return as-is if it's already a valid league ID
}

export async function getEvent(
  eventId: string,
  fallbackOptions?: {
    homeTeam?: string;
    awayTeam?: string;
    league?: string;
    startTime?: Date;
  },
): Promise<Event | null> {
  if (!eventId) {
    // If no eventId but we have fallback options, try searching by teams
    if (fallbackOptions?.homeTeam && fallbackOptions?.awayTeam && fallbackOptions?.startTime) {
      const leagueID = getLeagueID(fallbackOptions.league);
      return findEventByTeams(
        leagueID,
        fallbackOptions.homeTeam,
        fallbackOptions.awayTeam,
        fallbackOptions.startTime,
      );
    }
    return null;
  }

  const cached = eventCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < EVENT_CACHE_TTL_MS) {
    return cached.event;
  }

  // Method 1: Try direct event ID lookup
  try {
    const page = await client.events.get({
      eventID: eventId,
      limit: 1,
      includeOpposingOdds: true,
      includeAltLines: true,
      oddsPresent: true,
    });

    const event = page.data[0] ?? null;
    if (event) {
      eventCache.set(eventId, { event, fetchedAt: Date.now() });
      return event;
    }
  } catch (error) {
    console.warn(`Event ID lookup failed for ${eventId}, trying fallback search...`, error);
  }

  // Method 2: Try with eventIDs (plural) as fallback
  try {
    const page = await client.events.get({
      eventIDs: eventId,
      limit: 1,
      includeOpposingOdds: true,
      includeAltLines: true,
      oddsPresent: true,
    });

    const event = page.data[0] ?? null;
    if (event) {
      eventCache.set(eventId, { event, fetchedAt: Date.now() });
      return event;
    }
  } catch (error) {
    console.warn(`Event IDs lookup failed for ${eventId}, trying team search...`, error);
  }

  // Method 3: Fallback to team name and date range search
  if (fallbackOptions?.homeTeam && fallbackOptions?.awayTeam && fallbackOptions?.startTime) {
    const leagueID = getLeagueID(fallbackOptions.league);
    const event = await findEventByTeams(
      leagueID,
      fallbackOptions.homeTeam,
      fallbackOptions.awayTeam,
      fallbackOptions.startTime,
    );
    if (event && event.eventID) {
      // Cache the found event with both the original eventId and the found eventID
      // This helps with future lookups regardless of which ID is used
      eventCache.set(eventId, { event, fetchedAt: Date.now() });
      if (event.eventID !== eventId) {
        eventCache.set(event.eventID, { event, fetchedAt: Date.now() });
      }
      return event;
    }
  }

  return null;
}

function getScores(event: Event): { homeScore: number | null; awayScore: number | null } {
  const homeScore =
    (typeof event.teams?.home?.score === 'number' ? event.teams.home.score : null) ??
    (typeof event.results?.game?.home?.points === 'number' ? event.results!.game.home.points : null);

  const awayScore =
    (typeof event.teams?.away?.score === 'number' ? event.teams.away.score : null) ??
    (typeof event.results?.game?.away?.points === 'number' ? event.results!.game.away.points : null);

  return {
    homeScore: homeScore ?? null,
    awayScore: awayScore ?? null,
  };
}

function gradeSpread(side: MoneylineSide | null, line: number, homeScore: number, awayScore: number): BetResult {
  if (!side || Number.isNaN(line)) {
    return 'void';
  }

  const adjusted =
    side === 'home' ? homeScore + line - awayScore : awayScore + line - homeScore;

  if (Math.abs(adjusted) < 1e-9) {
    return 'push';
  }

  return adjusted > 0 ? 'win' : 'loss';
}

function gradeMoneyline(side: MoneylineSide | null, homeScore: number, awayScore: number): BetResult {
  if (!side) {
    return 'void';
  }

  if (homeScore === awayScore) {
    return 'push';
  }

  const winner = homeScore > awayScore ? 'home' : 'away';
  return winner === side ? 'win' : 'loss';
}

function gradeTotal(overUnder: 'Over' | 'Under' | undefined, line: number, totalScore: number): BetResult {
  if (!overUnder || Number.isNaN(line)) {
    return 'void';
  }

  if (Math.abs(totalScore - line) < 1e-9) {
    return 'push';
  }

  if (overUnder === 'Over') {
    return totalScore > line ? 'win' : 'loss';
  }

  return totalScore < line ? 'win' : 'loss';
}

export function findPlayerKeyByName(event: Event, targetName?: string | null): string | null {
  if (!targetName) return null;
  const normalizedTarget = normalize(targetName);
  if (!normalizedTarget || !event.players) return null;

  for (const [playerID, player] of Object.entries(event.players)) {
    const variants = [
      player.name,
      player.firstName && `${player.firstName} ${player.lastName ?? ''}`.trim(),
      player.alias,
    ]
      .filter(Boolean)
      .map((value) => normalize(value));

    if (variants.some((value) => value === normalizedTarget)) {
      return playerID;
    }
  }

  return null;
}

function gradePlayerProp(bet: IBet, event: Event): BetResult {
  const statType = bet.statType;
  if (!statType || bet.line === undefined || !bet.overUnder) {
    return 'void';
  }

  const legacyPlayerId = (bet as unknown as { playerId?: string | number }).playerId;
  const playerKey =
    bet.playerKey ||
    (typeof legacyPlayerId === 'number' || typeof legacyPlayerId === 'string'
      ? String(legacyPlayerId)
      : null) ||
    findPlayerKeyByName(event, bet.playerName);

  if (!playerKey) {
    return 'pending';
  }

  const statsEntry = event.results?.game?.[playerKey];
  if (!statsEntry || typeof statsEntry !== 'object') {
    return 'pending';
  }

  const statId = mapStatTypeToStatId(statType);
  if (!statId) {
    return 'void';
  }

  const statValue = computePlayerStatValue(statId, statsEntry as Record<string, number | undefined>);
  if (statValue === null) {
    return 'pending';
  }

  const propType = resolvePropBetType(statType);
  const direction = bet.overUnder;
  const line = bet.line;

  if (propType === 'yn') {
    if (Math.abs(statValue - line) < 1e-9) {
      return 'push';
    }
    if (direction === 'Over') {
      return statValue > line ? 'win' : 'loss';
    }
    return statValue < line ? 'win' : 'loss';
  }

  if (Math.abs(statValue - line) < 1e-9) {
    return 'push';
  }
  if (direction === 'Over') {
    return statValue > line ? 'win' : 'loss';
  }
  return statValue < line ? 'win' : 'loss';
}

/**
 * Checks if a game has ended and is ready for settlement
 * Returns true only if:
 * 1. Game start time has passed
 * 2. Game is finalized (not in progress)
 * 3. Game is not cancelled
 * 4. Final scores are available
 */
export function isGameEnded(event: Event, betStartTime: Date): boolean {
  // Check 1: Game start time must have passed
  const now = new Date();
  if (now < betStartTime) {
    return false; // Game hasn't started yet
  }

  // Check 2: Game must be finalized (ended)
  if (!event.status?.finalized) {
    return false; // Game is still in progress or not started
  }

  // Check 3: Game must not be cancelled
  if (event.status.cancelled) {
    return false; // Game was cancelled
  }

  // Check 4: Final scores must be available
  const { homeScore, awayScore } = getScores(event);
  if (homeScore === null || awayScore === null) {
    return false; // Scores not available yet
  }

  // All checks passed - game has ended
  return true;
}

async function gradeSingleBet(bet: IBet): Promise<BetResult> {
  // Try to get event with fallback options for team search
  const event = await getEvent(bet.providerEventId || '', {
    homeTeam: bet.homeTeam,
    awayTeam: bet.awayTeam,
    league: bet.league,
    startTime: new Date(bet.startTime),
  });

  if (!event) {
    return 'pending';
  }

  // Ensure game has ended before settling
  const betStartTime = new Date(bet.startTime);
  if (!isGameEnded(event, betStartTime)) {
    return 'pending';
  }

  const { homeScore, awayScore } = getScores(event);
  if (homeScore === null || awayScore === null) {
    return 'pending';
  }

  switch (bet.marketType) {
    case 'ML': {
      const side = resolveTeamSide(event, bet.selection);
      return gradeMoneyline(side, homeScore, awayScore);
    }
    case 'Spread': {
      if (typeof bet.line !== 'number') return 'void';
      const side = resolveTeamSide(event, bet.selection);
      return gradeSpread(side, bet.line, homeScore, awayScore);
    }
    case 'Total': {
      if (typeof bet.line !== 'number') return 'void';
      return gradeTotal(bet.overUnder, bet.line, homeScore + awayScore);
    }
    case 'Player Prop': {
      return gradePlayerProp(bet, event);
    }
    case 'Parlay':
      return 'pending';
    default:
      return 'void';
  }
}

export async function settleBet(bet: IBet): Promise<BetResult> {
  if (bet.marketType === 'Parlay') {
    const parlayId = typeof bet._id === 'string' ? bet._id : bet._id?.toString?.();
    if (!parlayId) {
      return 'void';
    }

    const legs = await Bet.find({ parlayId }).lean();
    if (legs.length === 0) {
      return 'void';
    }

    const allLegsSettled = legs.every((leg) => leg.result !== 'pending');
    if (!allLegsSettled) {
      return 'pending';
    }

    const hasLoss = legs.some((leg) => leg.result === 'loss');
    const hasVoid = legs.some((leg) => leg.result === 'void');
    const hasPush = legs.some((leg) => leg.result === 'push');
    const allWins = legs.every((leg) => leg.result === 'win');

    if (hasLoss) return 'loss';
    if (hasVoid || hasPush) return 'void';
    if (allWins) return 'win';
    return 'void';
  }

  return gradeSingleBet(bet);
}

