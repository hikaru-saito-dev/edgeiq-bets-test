import mongoose, { Schema, Document, Types } from 'mongoose';

export type FollowedBetActionType = 'follow' | 'fade';

export interface IFollowedBetAction extends Document {
  followerUserId: Types.ObjectId; // User who took the action (MongoDB ID, for reference)
  followerWhopUserId: string; // Whop user ID of the follower (person-level tracking)
  originalBetId: Types.ObjectId; // The bet from the following feed that was acted upon
  action: FollowedBetActionType; // 'follow' = bet was created, 'fade' = just marked as faded
  followedBetId?: Types.ObjectId; // If action is 'follow', the new bet that was created for the follower
  createdAt: Date;
  updatedAt: Date;
}

const FollowedBetActionSchema = new Schema<IFollowedBetAction>({
  followerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  followerWhopUserId: { type: String, required: true, index: true },
  originalBetId: { type: Schema.Types.ObjectId, ref: 'Bet', required: true, index: true },
  action: { type: String, enum: ['follow', 'fade'], required: true },
  followedBetId: { type: Schema.Types.ObjectId, ref: 'Bet' }, // Only set if action is 'follow' - removed index: true to avoid duplicate
}, {
  timestamps: true,
});

// Compound indexes for efficient queries
FollowedBetActionSchema.index({ followerWhopUserId: 1, originalBetId: 1 }, { unique: true }); // One action per user per bet
FollowedBetActionSchema.index({ originalBetId: 1, action: 1 }); // For querying all actions on a bet
FollowedBetActionSchema.index({ followedBetId: 1 }); // For finding original bet from followed bet

export const FollowedBetAction =
  (mongoose.models && mongoose.models.FollowedBetAction) ||
  mongoose.model<IFollowedBetAction>('FollowedBetAction', FollowedBetActionSchema);

