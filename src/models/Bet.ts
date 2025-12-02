import mongoose, { Schema, Document, Types } from 'mongoose';

export type BetResult = 'pending' | 'win' | 'loss' | 'push' | 'void';
export type MarketType = 'ML' | 'Spread' | 'Parlay' | 'Total' | 'Player Prop';

export interface IBet extends Document {
  userId: Types.ObjectId;
  
  // Legacy field (kept for backward compatibility)
  eventName?: string;
  
  // Game/Event Information
  sport?: string; // e.g., "NBA", "NFL", "MLB"
  league?: string; // e.g., "NBA", "NFL", "MLB"
  homeTeam?: string;
  awayTeam?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  startTime: Date;
  
  // Provider Information (for auto-settlement)
  provider?: string; // e.g., "Sportradar", "SportsDataIO", "TheOddsAPI"
  providerEventId?: string; // Provider's unique event ID
  sportKey?: string; // The Odds API sport_key (e.g., "americanfootball_nfl", "basketball_nba")
  
  // Market & Selection
  marketType: MarketType;
  selection?: string; // Team name for ML, Team + Line for Spread, etc.
  line?: number; // For Spread, Total, Player Prop
  overUnder?: 'Over' | 'Under'; // For Total and Player Prop
  playerName?: string; // For Player Prop
  playerId?: string; // SportsGameOdds Player ID for Player Prop
  playerKey?: string; // Alias for provider-specific player identifier
  statType?: string; // For Player Prop (e.g., "Points", "Rebounds")
  parlaySummary?: string; // For Parlay bets
  
  // Odds & Stake
  odds: number; // Stored as decimal format
  oddsFormat: 'american' | 'decimal'; // Original format entered
  oddsAmerican?: number; // Original American odds if entered
  units: number;
  
  // Optional Fields
  book?: string; // e.g., "Fanduel", "DraftKings"
  notes?: string;
  slipImageUrl?: string; // URL to uploaded slip image
  selectedWebhookIds?: string[]; // IDs of all selected webhooks for notifications
  
  // System Fields
  parlayId?: Types.ObjectId; // Reference to main parlay bet (for parlay line bets)
  
  // Status
  result: BetResult;
  locked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BetSchema = new Schema<IBet>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  
  // Legacy field (for backward compatibility, auto-generated if not provided)
  eventName: { type: String, trim: true },
  
  // Game/Event Information
  sport: { type: String, trim: true },
  league: { type: String, trim: true },
  homeTeam: { type: String, trim: true },
  awayTeam: { type: String, trim: true },
  homeTeamId: { type: String, trim: true },
  awayTeamId: { type: String, trim: true },
  startTime: { type: Date, required: true, index: true },
  
  // Provider Information
  provider: { type: String, trim: true },
  providerEventId: { type: String, trim: true, index: true },
  sportKey: { type: String, trim: true }, // The Odds API sport_key
  
  // Market & Selection
  marketType: { 
    type: String, 
    enum: ['ML', 'Spread', 'Parlay', 'Total', 'Player Prop'],
    required: true,
    default: 'ML'
  },
  selection: { type: String, trim: true },
  line: { type: Number },
  overUnder: { type: String, enum: ['Over', 'Under'] },
  playerName: { type: String, trim: true },
  playerId: { type: String, trim: true },
  playerKey: { type: String, trim: true },
  statType: { type: String, trim: true },
  parlaySummary: { type: String, trim: true },
  
  // Odds & Stake
  odds: { type: Number, required: true, min: 1.01 }, // Always stored as decimal
  oddsFormat: { type: String, enum: ['american', 'decimal'], required: true, default: 'decimal' },
  oddsAmerican: { type: Number },
  units: { type: Number, required: true, min: 0.01 },
  
  // Optional Fields
  book: { type: String, trim: true },
  notes: { type: String, trim: true, maxlength: 1000 },
  slipImageUrl: { type: String, trim: true },
  selectedWebhookIds: {
    type: [String],
    default: undefined,
  },
  
  // System Fields
  parlayId: { type: Schema.Types.ObjectId, ref: 'Bet', index: true }, // Reference to main parlay bet
  
  // Status
  result: { 
    type: String, 
    enum: ['pending', 'win', 'loss', 'push', 'void'], 
    default: 'pending',
    index: true
  },
  locked: { type: Boolean, default: false, index: true },
}, {
  timestamps: true,
});

// Compound indexes for efficient queries
BetSchema.index({ userId: 1, createdAt: -1 });
BetSchema.index({ userId: 1, result: 1 });
BetSchema.index({ userId: 1, result: 1, createdAt: -1 }); // For stats aggregation
BetSchema.index({ userId: 1, parlayId: 1, result: 1 }); // For personal stats aggregation
BetSchema.index({ result: 1, createdAt: -1 }); // For leaderboard filtering
BetSchema.index({ startTime: 1, locked: 1 });

// Pre-save hook to auto-lock bets after startTime
// This ensures bets are automatically locked when startTime passes
BetSchema.pre('save', function(next) {
  if (this.startTime) {
    const now = new Date();
    const startTime = new Date(this.startTime);
    // Auto-lock if current time has passed start time
    if (now >= startTime) {
      this.locked = true;
    }
    // Prevent unlocking a bet that should be locked
    if (this.locked && now < startTime) {
      // Only allow unlocking if manually set and time hasn't passed
      // This prevents tampering
    }
  }
  next();
});


export const Bet = (mongoose.models && mongoose.models.Bet) || mongoose.model<IBet>('Bet', BetSchema);

