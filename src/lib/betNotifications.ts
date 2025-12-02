import { Bet } from '@/models/Bet';
import type { IBet } from '@/models/Bet';
import type { IUser } from '@/models/User';
import connectDB from '@/lib/db';

/**
 * Check if a webhook URL supports embeds (Discord and Whop both support embeds)
 */
function supportsEmbeds(url: string): boolean {
  try {
    const urlObj = new URL(url);
    // Both Discord and Whop webhooks support embeds
    return urlObj.hostname.includes('discord.com') || 
           urlObj.hostname.includes('discordapp.com') ||
           urlObj.hostname.includes('whop.com');
  } catch {
    return false;
  }
}

/**
 * Parse message text into Discord embed structure
 */
function parseMessageToEmbed(message: string): {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number;
  footer?: { text: string };
} | null {
  const lines = message.split('\n').filter(line => line.trim());
  if (lines.length === 0) return null;

  // Extract title (first line with emoji and bold)
  const titleLine = lines[0];
  const titleMatch = titleLine.match(/^([🆕✏️🗑️✅❌➖⚪⏳])\s*\*\*(.+?)\*\*/);
  const title = titleMatch ? titleMatch[2] : titleLine.replace(/\*\*/g, '').trim();
  
  // Determine color based on emoji/type
  let color: number | undefined;
  if (titleLine.includes('🆕')) color = 0x6366f1; // Indigo for new
  else if (titleLine.includes('✏️')) color = 0xf59e0b; // Amber for update
  else if (titleLine.includes('🗑️')) color = 0xef4444; // Red for delete
  else if (titleLine.includes('✅')) color = 0x10b981; // Green for win
  else if (titleLine.includes('❌')) color = 0xef4444; // Red for loss
  else if (titleLine.includes('➖')) color = 0x6b7280; // Gray for push
  else if (titleLine.includes('⚪')) color = 0x9ca3af; // Light gray for void
  else color = 0x6366f1; // Default indigo

  // Parse fields from remaining lines
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  let currentSection: string | null = null;
  let currentSectionLines: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this is a section header (ends with colon, no value after it, and next line is likely a bullet)
    // Section headers like "Parlay Legs:" or "Changes:" are followed by bullet points
    const isSectionHeader = line.endsWith(':') && 
      (line.split(':').length === 2) && 
      (i + 1 < lines.length && lines[i + 1]?.trim().startsWith('•'));
    
    if (isSectionHeader) {
      // Save previous section if exists
      if (currentSection && currentSectionLines.length > 0) {
        fields.push({
          name: currentSection,
          value: currentSectionLines.join('\n'),
          inline: false,
        });
      }
      currentSection = line.slice(0, -1).trim(); // Remove colon
      currentSectionLines = [];
      continue;
    }

    // Check if this is a key-value pair (contains ": " but not a bullet)
    const kvMatch = line.match(/^([^:•]+?):\s*(.+)$/);
    if (kvMatch && !line.startsWith('•')) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      
      // Special handling for certain fields
      if (key === 'User' || key === 'Event' || key === 'Market') {
        fields.push({
          name: key,
          value: value.replace(/\*\*/g, ''),
          inline: key !== 'Event' && key !== 'Market',
        });
      } else if (key === 'Stake' || key === 'Odds' || key === 'Start' || key === 'Book') {
        fields.push({
          name: key,
          value: value.replace(/\*\*/g, ''),
          inline: true,
        });
      } else if (key.startsWith('Units') || key.startsWith('Total Units')) {
        fields.push({
          name: key,
          value: value.replace(/\*\*/g, ''),
          inline: true,
        });
      } else if (key === 'Notes') {
        fields.push({
          name: key,
          value: value.replace(/\*\*/g, ''),
          inline: false,
        });
      } else if (key === 'Slip') {
        // Skip slip URL as field, will be in description if needed
        continue;
      } else {
        fields.push({
          name: key,
          value: value.replace(/\*\*/g, ''),
          inline: false,
        });
      }
    } else if (line.startsWith('•')) {
      // Bullet point - add to current section or create new field
      const cleanLine = line.replace(/^•\s*/, '').replace(/\*\*/g, '');
      if (currentSection) {
        currentSectionLines.push(cleanLine);
      } else {
        // Create a field for this bullet
        fields.push({
          name: '\u200b', // Zero-width space
          value: cleanLine,
          inline: false,
        });
      }
    } else {
      // Regular text line
      if (currentSection) {
        currentSectionLines.push(line.replace(/\*\*/g, ''));
      } else {
        fields.push({
          name: '\u200b',
          value: line.replace(/\*\*/g, ''),
          inline: false,
        });
      }
    }
  }

  // Save last section if exists
  if (currentSection && currentSectionLines.length > 0) {
    fields.push({
      name: currentSection,
      value: currentSectionLines.join('\n'),
      inline: false,
    });
  }

  // Extract timestamp from "Start:" field if exists
  let footer: { text: string } | undefined;
  const startField = fields.find(f => f.name === 'Start');
  if (startField) {
    footer = { text: `Start: ${startField.value}` };
  }

  const result: {
    title: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    color?: number;
    footer?: { text: string };
  } = {
    title,
    color,
  };

  if (fields.length === 0) {
    result.description = message.replace(/\*\*/g, '');
  } else {
    result.fields = fields;
  }

  if (footer) {
    result.footer = footer;
  }

  return result;
}

/**
 * Send message via webhook (works for both Discord and Whop webhooks)
 * Both Discord and Whop webhooks support embeds
 * 
 * @param message - The message content to send
 * @param webhookUrl - The webhook URL (Discord or Whop)
 * @param imageUrl - Optional image URL to include in the embed
 * @returns Promise that resolves when message is sent (or fails silently)
 */
async function sendWebhookMessage(message: string, webhookUrl: string, imageUrl?: string): Promise<void> {
  if (!webhookUrl || !message.trim()) {
    return;
  }

  try {
    const useEmbeds = supportsEmbeds(webhookUrl);
    
    let payload: { content?: string; embeds?: Array<unknown> };
    
    if (useEmbeds) {
      // Parse message into embed format (works for both Discord and Whop)
      const embed = parseMessageToEmbed(message);
      
      if (embed) {
        const embedPayload: {
          title: string;
          description?: string;
          fields?: Array<{ name: string; value: string; inline?: boolean }>;
          color?: number;
          footer?: { text: string };
          image?: { url: string };
          timestamp: string;
        } = {
          title: embed.title,
          timestamp: new Date().toISOString(),
        };

        if (embed.description) {
          embedPayload.description = embed.description;
        }
        if (embed.fields && embed.fields.length > 0) {
          embedPayload.fields = embed.fields;
        }
        if (embed.color) {
          embedPayload.color = embed.color;
        }
        if (embed.footer) {
          embedPayload.footer = embed.footer;
        }
        if (imageUrl) {
          embedPayload.image = { url: imageUrl };
        }

        payload = {
          embeds: [embedPayload],
        };
      } else {
        // Fallback to plain text if parsing fails
        payload = { content: message };
      }
    } else {
      // Unknown webhook type - use plain text
      payload = { content: message };
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Discord returns 200/204, Whop returns 200/204 for success
    // 204 No Content is also a success response
    if (response.ok || response.status === 204) {
      // Success - message sent
      return;
    }
    
    // Non-2xx response - log but don't throw (don't interrupt bet operations)
    // Silently fail to prevent breaking bet creation/updates
  } catch {
    // Network error or exception - silently fail
    // Don't log to avoid cluttering logs with webhook failures
  }
}


/**
 * Send message to a specific user's webhooks
 * 
 * @param message - The formatted message to send
 * @param user - The user to send the message to (must be owner or admin)
 * @param imageUrl - Optional image URL to include in the embed
 */
async function sendMessageToUser(
  message: string, 
  user: IUser | null | undefined, 
  imageUrl?: string,
  selectedWebhookIds?: string[]
): Promise<void> {
  if (!user || (user.role !== 'companyOwner' && user.role !== 'owner' && user.role !== 'admin')) {
    return;
  }

  try {
    // Only send messages if webhooks are explicitly selected
    // If selectedWebhookIds is undefined or empty, don't send any messages
    if (!selectedWebhookIds || selectedWebhookIds.length === 0) {
      return;
    }

    const webhookPromises: Promise<void>[] = [];
    const availableWebhooks = user.webhooks || [];
    
    // Filter to only include webhook IDs that exist in the user's webhooks
    const normalizedExplicitIds = selectedWebhookIds.filter((id: string) =>
      availableWebhooks.some((webhook) => webhook.id === id)
    );

    // Send to only the selected webhooks
    normalizedExplicitIds.forEach((id) => {
      const hook = availableWebhooks.find((webhook) => webhook.id === id);
      if (hook) {
        webhookPromises.push(sendWebhookMessage(message, hook.url, imageUrl));
      }
    });

    // Send to all configured webhooks in parallel
    // Use Promise.allSettled so if one fails, the others still work
    if (webhookPromises.length > 0) {
      await Promise.allSettled(webhookPromises);
    }
  } catch {
    // Silently fail to prevent breaking bet operations
  }
}


function formatDate(date: Date): string {
  try {
    // Show in America/New_York timezone (EST/EDT)
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function getEventLabel(bet: IBet): string {
  if (bet.eventName) return bet.eventName;
  if (bet.homeTeam || bet.awayTeam) {
    const away = bet.awayTeam || 'TBD';
    const home = bet.homeTeam || 'TBD';
    return `${away} @ ${home}`;
  }
  return 'Event';
}

function getMarketLabel(bet: IBet): string {
  switch (bet.marketType) {
    case 'ML':
      return bet.selection ? `Moneyline – ${bet.selection}` : 'Moneyline';
    case 'Spread':
      return bet.selection && bet.line !== undefined
        ? `Spread – ${bet.selection} ${bet.line > 0 ? '+' : ''}${bet.line}`
        : 'Spread';
    case 'Total':
      return bet.line !== undefined && bet.overUnder
        ? `Total – ${bet.overUnder} ${bet.line}`
        : 'Total';
    case 'Player Prop':
      return bet.playerName && bet.statType
        ? `Player Prop – ${bet.playerName} ${bet.statType}${bet.line !== undefined ? ` ${bet.overUnder ?? ''} ${bet.line}` : ''}`
        : 'Player Prop';
    case 'Parlay': {
      const summaryUnknown = bet.parlaySummary as unknown;
      if (typeof summaryUnknown === 'string' && summaryUnknown.trim()) {
        return `Parlay – ${summaryUnknown}`;
      }
      if (Array.isArray(summaryUnknown)) {
        const joined = summaryUnknown
          .map((item) => (typeof item === 'string' ? item : typeof item === 'object' && item ? Object.values(item).join(' ') : String(item)))
          .filter((item) => Boolean(item))
          .join(' + ');
        if (joined) return `Parlay – ${joined}`;
      }
      if (summaryUnknown && typeof summaryUnknown === 'object') {
        const joined = Object.values(summaryUnknown as Record<string, unknown>)
          .map((item) => (typeof item === 'string' ? item : String(item)))
          .filter((item) => Boolean(item))
          .join(' + ');
        if (joined) return `Parlay – ${joined}`;
      }
      return 'Parlay';
    }
    default:
      return bet.marketType;
  }
}

function formatOdds(bet: IBet): string {
  if (typeof bet.oddsAmerican === 'number' && !Number.isNaN(bet.oddsAmerican)) {
    const prefix = bet.oddsAmerican > 0 ? '+' : '';
    return `${prefix}${bet.oddsAmerican}`;
  }
  if (typeof bet.odds === 'number' && !Number.isNaN(bet.odds)) {
    return bet.odds.toFixed(2);
  }
  return 'N/A';
}

function formatUnits(units: number): string {
  if (Number.isNaN(units)) return 'N/A units';
  return `${units % 1 === 0 ? units.toFixed(0) : units.toFixed(2)} units`;
}

function formatUser(user?: IUser | null): string {
  if (!user) return 'Unknown bettor';
  return user.alias || user.whopDisplayName || user.whopUsername || user.whopUserId || 'Unknown bettor';
}

function formatParlayLegMarket(leg: IBet): string {
  switch (leg.marketType) {
    case 'ML':
      return leg.selection ? `Moneyline – ${leg.selection}` : 'Moneyline';
    case 'Spread':
      return leg.selection && leg.line !== undefined
        ? `Spread – ${leg.selection} ${leg.line > 0 ? '+' : ''}${leg.line}`
        : 'Spread';
    case 'Total':
      return leg.line !== undefined && leg.overUnder
        ? `Total – ${leg.overUnder} ${leg.line}`
        : 'Total';
    case 'Player Prop':
      return leg.playerName && leg.statType
        ? `Player Prop – ${leg.playerName} ${leg.statType}${leg.line !== undefined ? ` ${leg.overUnder ?? ''} ${leg.line}` : ''}`
        : 'Player Prop';
    default:
      return leg.marketType;
  }
}

async function getParlayLegDetails(bet: IBet): Promise<string[]> {
  const id = typeof bet._id === 'string' ? bet._id : bet._id?.toString?.();
  if (!id) return [];

  try {
    const legDocs = await Bet.find({ parlayId: id })
      .sort({ startTime: 1 })
      .lean();

    return (legDocs as unknown as IBet[]).map((leg, index) => {
      const event = getEventLabel(leg);
      const market = formatParlayLegMarket(leg);
      const start = leg.startTime ? ` – ${formatDate(new Date(leg.startTime))}` : '';
      return `Leg ${index + 1}: ${event}${start}\n    ${market}`;
    });
  } catch (error) {
    console.error('Error fetching parlay leg details:', error);
    return [];
  }
}

export async function notifyBetCreated(bet: IBet, user?: IUser | null, _companyId?: string | undefined): Promise<void> {
  // Send notification only to the specific user who created the bet
  if (!user || (user.role !== 'companyOwner' && user.role !== 'owner' && user.role !== 'admin')) {
    return;
  }

  const messageLines = [
    '🆕 **Bet Created**',
    `User: ${formatUser(user)}`,
    `Event: ${getEventLabel(bet)}`,
    `Market: ${getMarketLabel(bet)}`,
    `Stake: ${formatUnits(bet.units)}`,
    `Odds: ${formatOdds(bet)}`,
    `Start: ${formatDate(new Date(bet.startTime))}`,
  ];

  if (bet.book) {
    messageLines.push(`Book: ${bet.book}`);
  }
  if (bet.notes) {
    messageLines.push(`Notes: ${bet.notes}`);
  }
  // Note: slipImageUrl is not added to messageLines - it will be sent as embed image

  if (bet.marketType === 'Parlay') {
    const legDetails = await getParlayLegDetails(bet);
    if (legDetails.length > 0) {
      messageLines.push('Parlay Legs:', ...legDetails.map((line) => `• ${line}`));
    }
  }

  await sendMessageToUser(
    messageLines.join('\n'),
    user,
    bet.slipImageUrl,
    bet.selectedWebhookIds
  );
}

export async function notifyBetUpdated(bet: IBet, user?: IUser | null, updatedFields?: Record<string, unknown>): Promise<void> {
  // Send notification only to the specific user who updated the bet
  if (!user || (user.role !== 'companyOwner' && user.role !== 'owner' && user.role !== 'admin')) {
    return;
  }

  const lines = [
    '✏️ **Bet Updated**',
    `User: ${formatUser(user)}`,
    `Event: ${getEventLabel(bet)}`,
    `Market: ${getMarketLabel(bet)}`,
  ];

  if (updatedFields) {
    const changes = Object.entries(updatedFields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}: ${value}`);
    if (changes.length > 0) {
      lines.push('Changes:', ...changes.map((line) => `• ${line}`));
    }
  }

  lines.push(`Stake: ${formatUnits(bet.units)}`);
  lines.push(`Odds: ${formatOdds(bet)}`);

  if (bet.marketType === 'Parlay') {
    const legDetails = await getParlayLegDetails(bet);
    if (legDetails.length > 0) {
      lines.push('Legs:', ...legDetails.map((line) => `• ${line}`));
    }
  }

  await sendMessageToUser(lines.join('\n'), user);
}

export async function notifyBetDeleted(bet: IBet, user?: IUser | null): Promise<void> {
  // Send notification only to the specific user who deleted the bet
  if (!user || (user.role !== 'companyOwner' && user.role !== 'owner' && user.role !== 'admin')) {
    return;
  }

  const message = [
    '🗑️ **Bet Deleted**',
    `User: ${formatUser(user)}`,
    `Event: ${getEventLabel(bet)}`,
    `Market: ${getMarketLabel(bet)}`,
    `Stake: ${formatUnits(bet.units)}`,
    `Odds: ${formatOdds(bet)}`,
  ].join('\n');

  await sendMessageToUser(message, user, undefined, bet.selectedWebhookIds);
}

export async function notifyBetSettled(bet: IBet, result: IBet['result'], user?: IUser | null): Promise<void> {
  // Find the user who owns this bet (for settlement notifications)
  let userForNotification = user;
  if (!userForNotification && bet.userId) {
    try {
      await connectDB();
      const { User } = await import('@/models/User');
      userForNotification = await User.findById(bet.userId).lean() as unknown as IUser | null;
    } catch {
      // If we can't fetch user, return early
      return;
    }
  }

  // Only send if user exists and is owner/admin
  if (!userForNotification || (userForNotification.role !== 'owner' && userForNotification.role !== 'admin' && userForNotification.role !== 'companyOwner')) {
    return;
  }
  
  // Only send if notifyOnSettlement is enabled
  if (!userForNotification.notifyOnSettlement) {
    return;
  }
  
  // If onlyNotifyWinningSettlements is enabled, only send for winning bets
  if (userForNotification.onlyNotifyWinningSettlements && result !== 'win') {
    return;
  }
  
  // Determine which webhook IDs to use for settlement notification
  // Priority: Use webhook IDs from bet creation (bet.selectedWebhookIds)
  // This ensures settlement notifications go to the same webhooks used at bet creation
  const webhookIdsToUse = bet.selectedWebhookIds && bet.selectedWebhookIds.length > 0
    ? bet.selectedWebhookIds
    : undefined; // If no webhooks were selected at creation, don't send settlement notification

  // Must have webhook IDs from bet creation to send settlement notification
  if (!webhookIdsToUse || webhookIdsToUse.length === 0) {
    return;
  }

  const outcomeEmoji: Record<IBet['result'], string> = {
    win: '✅',
    loss: '❌',
    push: '➖',
    void: '⚪',
    pending: '⏳',
  };

  // Calculate units won/lost for this bet
  let unitsWonLost = 0;
  if (result === 'win') {
    unitsWonLost = bet.units * (bet.odds - 1);
  } else if (result === 'loss') {
    unitsWonLost = -bet.units;
  } else if (result === 'push' || result === 'void') {
    unitsWonLost = 0;
  }

  // Calculate total units from all settled bets
  let totalUnits = 0;
  try {
    await connectDB();
    const { Bet } = await import('@/models/Bet');
    const allBets = await Bet.find({ 
      userId: bet.userId,
      result: { $in: ['win', 'loss', 'push', 'void'] },
    }).lean() as unknown as IBet[];

    allBets.forEach((b) => {
      if (b.result === 'void' || b.result === 'push') return;
      if (b.result === 'win') {
        totalUnits += b.units * (b.odds - 1);
      } else if (b.result === 'loss') {
        totalUnits -= b.units;
      }
    });
  } catch {
    // If calculation fails, continue without total units
  }

  const messageLines = [
    `${outcomeEmoji[result]} **Bet Settled – ${result.toUpperCase()}**`,
    `User: ${formatUser(userForNotification)}`,
    `Event: ${getEventLabel(bet)}`,
    `Market: ${getMarketLabel(bet)}`,
    `Stake: ${formatUnits(bet.units)}`,
    `Odds: ${formatOdds(bet)}`,
    `Units ${result === 'win' ? 'Won' : result === 'loss' ? 'Lost' : 'Result'}: ${unitsWonLost >= 0 ? '+' : ''}${formatUnits(unitsWonLost)}`,
    `Total Units (All Time): ${totalUnits >= 0 ? '+' : ''}${formatUnits(totalUnits)}`,
  ];

  if (bet.marketType === 'Parlay') {
    const legDetails = await getParlayLegDetails(bet);
    if (legDetails.length > 0) {
      messageLines.push('Legs:', ...legDetails.map((line) => `• ${line}`));
    }
  }

  const message = messageLines.join('\n');

  // Send to the same webhooks that were used when the bet was created
  await sendMessageToUser(
    message,
    userForNotification,
    undefined,
    webhookIdsToUse
  );
}



