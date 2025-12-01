import { NextRequest, NextResponse } from 'next/server';
import type { Event } from 'sports-odds-api/resources/events';

import { getSportsGameOddsClient } from '@/lib/sportsGameOdds';

export const runtime = 'nodejs';

const DEFAULT_LEAGUES = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAF', 'NCAAB'] as const;

const LEAGUE_METADATA: Record<
  string,
  {
    sport: string;
    league: string;
    sportKey: string;
  }
> = {
  NFL: { sport: 'American Football', league: 'NFL', sportKey: 'americanfootball_nfl' },
  NCAAF: { sport: 'College Football', league: 'NCAAF', sportKey: 'americanfootball_ncaaf' },
  NBA: { sport: 'Basketball', league: 'NBA', sportKey: 'basketball_nba' },
  NCAAB: { sport: 'College Basketball', league: 'NCAAB', sportKey: 'basketball_ncaab' },
  MLB: { sport: 'Baseball', league: 'MLB', sportKey: 'baseball_mlb' },
  NHL: { sport: 'Ice Hockey', league: 'NHL', sportKey: 'icehockey_nhl' },
};

const SPORT_KEY_TO_LEAGUE: Record<string, string> = Object.fromEntries(
  Object.entries(LEAGUE_METADATA).map(([leagueID, meta]) => [meta.sportKey, leagueID]),
);

const QUERY_KEYWORDS: Record<string, string> = {
  nfl: 'NFL',
  football: 'NFL',
  'college football': 'NCAAF',
  ncaaf: 'NCAAF',
  cfb: 'NCAAF',
  nba: 'NBA',
  basketball: 'NBA',
  ncaab: 'NCAAB',
  cbb: 'NCAAB',
  mlb: 'MLB',
  baseball: 'MLB',
  nhl: 'NHL',
  hockey: 'NHL',
};

type GameResult = {
  provider: 'SportsGameOdds';
  providerEventId: string;
  sport: string;
  league: string;
  sportKey?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  startTime: string;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function mapSportParamToLeagues(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const normalized = trimmed.toLowerCase();
  const explicitLeague = trimmed.toUpperCase();
  if (LEAGUE_METADATA[explicitLeague]) {
    return [explicitLeague];
  }

  if (SPORT_KEY_TO_LEAGUE[normalized]) {
    return [SPORT_KEY_TO_LEAGUE[normalized]];
  }

  const withoutUnderscore = normalized.replace(/_/g, ' ');
  for (const [keyword, leagueID] of Object.entries(QUERY_KEYWORDS)) {
    if (withoutUnderscore.includes(keyword)) {
      return [leagueID];
    }
  }

  return [];
}

function detectLeaguesFromQuery(query: string): string[] {
  if (!query.trim()) return [];
  const normalized = query.toLowerCase();

  const matches = new Set<string>();
  for (const [keyword, leagueID] of Object.entries(QUERY_KEYWORDS)) {
    if (normalized.includes(keyword)) {
      matches.add(leagueID);
    }
  }

  return Array.from(matches);
}

function mapEventToGame(event: Event): GameResult | null {
  if (!event.eventID) {
    return null;
  }

  const leagueID = event.leagueID || '';
  const meta =
    LEAGUE_METADATA[leagueID] || {
      sport: event.sportID || 'SportsGameOdds',
      league: leagueID || event.sportID || 'Unknown League',
      sportKey: undefined,
    };

  const startTime = event.status?.startsAt;
  if (!startTime) {
    return null;
  }

  const homeTeamName =
    event.teams?.home?.names?.long ||
    event.teams?.home?.names?.medium ||
    event.teams?.home?.names?.short;
  const awayTeamName =
    event.teams?.away?.names?.long ||
    event.teams?.away?.names?.medium ||
    event.teams?.away?.names?.short;

  return {
    provider: 'SportsGameOdds',
    providerEventId: event.eventID,
    sport: meta.sport,
    league: meta.league,
    sportKey: meta.sportKey,
    homeTeam: homeTeamName || undefined,
    awayTeam: awayTeamName || undefined,
    homeTeamId: event.teams?.home?.teamID,
    awayTeamId: event.teams?.away?.teamID,
    startTime,
  };
}

function matchesQuery(game: GameResult, query: string): boolean {
  if (!query.trim()) return true;
  const normalized = normalize(query);
  return (
    (game.homeTeam && game.homeTeam.toLowerCase().includes(normalized)) ||
    (game.awayTeam && game.awayTeam.toLowerCase().includes(normalized)) ||
    game.league.toLowerCase().includes(normalized) ||
    game.sport.toLowerCase().includes(normalized)
  );
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q')?.trim() ?? '';
    const sportParam = searchParams.get('sport')?.trim() ?? '';
    const leagueParam = searchParams.get('league')?.trim() ?? '';
    const limitParam = Number(searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;

    const client = getSportsGameOddsClient();

    let leaguesToQuery: string[] = [];
    if (leagueParam) {
      leaguesToQuery = leagueParam
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0);
    } else if (sportParam) {
      leaguesToQuery = mapSportParamToLeagues(sportParam);
    } else if (query) {
      leaguesToQuery = detectLeaguesFromQuery(query);
    }

    if (leaguesToQuery.length === 0) {
      leaguesToQuery = [...DEFAULT_LEAGUES];
    }

    const now = new Date();
    const startsAfter = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(); // include games that started recently
    const startsBefore = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(); // two weeks ahead

    const eventsMap = new Map<string, Event>();

    for (const leagueID of leaguesToQuery) {
      try {
        const page = await client.events.get({
          leagueID,
          limit,
          oddsPresent: true,
          startsAfter,
          startsBefore,
        });

        for (const event of page.data) {
          if (event.eventID) {
            eventsMap.set(event.eventID, event);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch events for league ${leagueID}:`, error);
      }
    }

    let games = Array.from(eventsMap.values())
      .map((event) => mapEventToGame(event))
      .filter((game): game is GameResult => Boolean(game));

    if (query) {
      games = games.filter((game) => matchesQuery(game, query));
    }

    if (leagueParam) {
      const allowedLeagues = new Set(
        leagueParam
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0),
      );
      games = games.filter((game) => allowedLeagues.has(game.league.toLowerCase()));
    }

    games.sort((a, b) => {
      const timeA = new Date(a.startTime).getTime();
      const timeB = new Date(b.startTime).getTime();
      return timeA - timeB;
    });

    return NextResponse.json({
      games,
      total: games.length,
    });
  } catch (error) {
    console.error('Error searching games with SportsGameOdds:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

