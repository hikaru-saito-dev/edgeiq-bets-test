import SportsGameOdds from 'sports-odds-api';

let sportsGameOddsClient: SportsGameOdds | null = null;

function createClient(): SportsGameOdds {
  if (sportsGameOddsClient) {
    return sportsGameOddsClient;
  }

  const apiKey = process.env.SPORTS_GAME_ODDS_API_KEY_HEADER;

  if (!apiKey) {
    throw new Error(
      'SPORTS_GAME_ODDS_API_KEY_HEADER is not set. Please add it to your environment or .env.local file.',
    );
  }

  const options: ConstructorParameters<typeof SportsGameOdds>[0] = {
    apiKeyHeader: apiKey,
    timeout: 20 * 1000,
    maxRetries: 2,
  };

  sportsGameOddsClient = new SportsGameOdds(options);
  return sportsGameOddsClient;
}

export function getSportsGameOddsClient(): SportsGameOdds {
  return createClient();
}

